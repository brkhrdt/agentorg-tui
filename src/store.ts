import { EventEmitter } from 'node:events';
import type { Agent, Operation, ServerEvent, Snapshot, EventRendering } from './protocol.js';
import type { Settings } from './settings.js';

export const object = (value: unknown): Record<string, any> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
export const truncated = (value: unknown): boolean => {
  const data = object(value);
  return data.truncated === true && typeof data.originalBytes === 'number' && typeof data.preview === 'string';
};
/** Join compatible stream chunks without mutating the original wire records. */
export function appendMessageChunk(previous: ServerEvent | undefined, event: ServerEvent): ServerEvent | undefined {
  const data = object(event.data);
  const lastData = object(previous?.data);
  if (event.type !== 'agent.message' || previous?.type !== event.type ||
      previous.agentId !== event.agentId || previous.generation !== event.generation ||
      data.sessionUpdate !== lastData.sessionUpdate || data.messageId !== lastData.messageId ||
      typeof data.content?.text !== 'string' || typeof lastData.content?.text !== 'string') return;
  return { ...event, data: { ...data, content: { ...data.content, text: lastData.content.text + data.content.text } } };
}
const terminal = (status: string) => ['completed', 'failed', 'stopped'].includes(status);
export interface TreeRow { agent: Agent; depth: number }

export class Store extends EventEmitter {
  agents = new Map<string, Agent>();
  operations = new Map<string, Operation>();
  events = new Map<number, ServerEvent>();
  renderings = new Map<number, EventRendering>();
  discovered = new Set<string>();
  watermark = -1;
  historyCursor = 0; // Global history coverage, not the most recent live event.
  historyGap = false;
  private sortedCache?: ServerEvent[];
  private latestByType = new Map<string, Map<string, ServerEvent>>();
  private lastByAgent = new Map<string, ServerEvent>();
  private latestIndexedSeq = -1;
  private latestDirty = false;

  reset(): void {
    this.agents.clear(); this.operations.clear(); this.events.clear(); this.renderings.clear();
    this.sortedCache = undefined; this.latestByType.clear(); this.lastByAgent.clear();
    this.latestIndexedSeq = -1; this.latestDirty = false;
    this.watermark = -1; this.historyCursor = 0; this.historyGap = false;
  }
  install(snapshot: Snapshot): void {
    this.agents = new Map(snapshot.agents.map(agent => [agent.id, agent]));
    this.operations = new Map(snapshot.operations.map(operation => [operation.id, operation]));
    this.watermark = snapshot.seq;
    // The snapshot is for state only; older buffered events still belong in chat.
    for (const event of this.orderedEvents()) if (event.seq > snapshot.seq) this.reduce(event);
    this.emit('change');
  }
  present(seq: number, rendering: EventRendering): void {
    this.renderings.set(seq, rendering);
    const event = this.events.get(seq);
    if (event && rendering.subtype) this.discovered.add(`${event.type}:${rendering.subtype}`);
    this.latestDirty = true;
    this.emit('change');
  }
  ingest(event: ServerEvent): void {
    if (this.events.has(event.seq)) return;
    this.events.set(event.seq, event);
    if (this.sortedCache && (!this.sortedCache.length || this.sortedCache.at(-1)!.seq < event.seq)) this.sortedCache.push(event);
    else this.sortedCache = undefined;
    // History can arrive after live events; rebuild summaries in sequence order.
    if (!this.latestDirty && event.seq > this.latestIndexedSeq) this.indexLatest(event);
    else this.latestDirty = true;
    this.discovered.add(event.type);
    const subtype = this.renderings.get(event.seq)?.subtype;
    if (subtype) this.discovered.add(`${event.type}:${subtype}`);
    if (this.watermark >= 0 && event.seq > this.watermark) this.reduce(event);
    this.emit('change');
  }
  orderedEvents(): ServerEvent[] {
    return this.sortedCache ??= [...this.events.values()].sort((a, b) => a.seq - b.seq);
  }
  private reduce(event: ServerEvent): void {
    const data = object(event.data);
    this.watermark = Math.max(this.watermark, event.seq);
    if (truncated(data)) { this.emit('refresh'); return; }
    if (event.type === 'operation.changed' && typeof data.id === 'string') this.putOperation(data as Operation);
    if (!event.agentId) return;
    const previous = this.agents.get(event.agentId);
    if (['agent.created', 'agent.modified'].includes(event.type) && typeof data.id === 'string' && data.settings) {
      this.agents.set(data.id, data as Agent);
      // Generation/session can change after allocation/modification.
      this.emit('refresh');
    } else if (event.type === 'agent.state') {
      if (previous) this.agents.set(previous.id, { ...previous, ...data, generation: event.generation ?? null });
      this.emit('refresh');
    } else if (event.type === 'agent.removed' && previous) {
      this.agents.set(previous.id, { ...previous, removedAt: data.removedAt });
    } else if (event.type === 'agent.session_replaced' || !previous) {
      this.emit('refresh');
    }
  }
  putOperation(operation: Operation): void {
    const current = this.operations.get(operation.id);
    // Acceptance responses can arrive after the terminal event.
    if (current && terminal(current.status) && !terminal(operation.status)) return;
    this.operations.set(operation.id, operation);
    this.emit('change');
  }
  tree(): TreeRow[] {
    const active = [...this.agents.values()].filter(agent => agent.removedAt === null);
    const ids = new Set(active.map(agent => agent.id));
    const children = new Map<string | null, Agent[]>();
    for (const agent of active) {
      const parent = agent.parentId && ids.has(agent.parentId) ? agent.parentId : null;
      const siblings = children.get(parent) ?? [];
      siblings.push(agent); children.set(parent, siblings);
    }
    for (const siblings of children.values()) siblings.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    const rows: TreeRow[] = [];
    const seen = new Set<string>();
    const visit = (agent: Agent, depth: number) => {
      if (seen.has(agent.id)) return;
      seen.add(agent.id); rows.push({ agent, depth });
      for (const child of children.get(agent.id) ?? []) visit(child, depth + 1);
    };
    for (const root of children.get(null) ?? []) visit(root, 0);
    for (const agent of active) if (!seen.has(agent.id)) visit(agent, 0); // Tolerate malformed plugin hierarchy.
    return rows;
  }
  private indexLatest(event: ServerEvent): void {
    this.latestIndexedSeq = event.seq;
    if (!event.agentId) return;
    const previous = this.lastByAgent.get(event.agentId);
    const custom = this.renderings.has(event.seq) || (previous && this.renderings.has(previous.seq));
    const summary = (!custom && appendMessageChunk(previous, event)) || event;
    this.lastByAgent.set(event.agentId, summary);
    const types = this.latestByType.get(event.agentId) ?? new Map<string, ServerEvent>();
    types.set(event.type, summary);
    this.latestByType.set(event.agentId, types);
  }
  latest(settings: Settings): Map<string, ServerEvent> {
    if (this.latestDirty) {
      this.latestByType.clear(); this.lastByAgent.clear();
      for (const event of this.orderedEvents()) this.indexLatest(event);
      this.latestDirty = false;
    }
    const latest = new Map<string, ServerEvent>();
    for (const [agentId, types] of this.latestByType) {
      for (const event of types.values()) {
        if (settings.tracked(event.type) && event.seq > (latest.get(agentId)?.seq ?? -1)) latest.set(agentId, event);
      }
    }
    return latest;
  }
  transcript(agentId: string, settings: Settings): ServerEvent[] {
    return this.orderedEvents().filter(event => event.agentId === agentId && settings.tracked(event.type));
  }
}
