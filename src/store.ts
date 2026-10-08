import { EventEmitter } from 'node:events';
import type { Agent, Operation, ServerEvent, Snapshot } from './protocol.js';
import type { Settings } from './settings.js';

export const object = (value: unknown): Record<string, any> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
export const truncated = (value: unknown): boolean => {
  const data = object(value);
  return data.truncated === true && typeof data.originalBytes === 'number' && typeof data.preview === 'string';
};
const terminal = (status: string) => ['completed', 'failed', 'stopped'].includes(status);
export interface TreeRow { agent: Agent; depth: number }

export class Store extends EventEmitter {
  agents = new Map<string, Agent>();
  operations = new Map<string, Operation>();
  events = new Map<number, ServerEvent>();
  discovered = new Set<string>();
  watermark = -1;
  historyCursor = 0; // Global history coverage, not the most recent live event.
  historyGap = false;
  private sortedCache?: ServerEvent[];
  private latestByType = new Map<string, Map<string, ServerEvent>>();

  reset(): void {
    this.agents.clear(); this.operations.clear(); this.events.clear();
    this.sortedCache = undefined; this.latestByType.clear();
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
  ingest(event: ServerEvent): void {
    if (this.events.has(event.seq)) return;
    this.events.set(event.seq, event);
    if (this.sortedCache && (!this.sortedCache.length || this.sortedCache.at(-1)!.seq < event.seq)) this.sortedCache.push(event);
    else this.sortedCache = undefined;
    if (event.agentId) {
      const types = this.latestByType.get(event.agentId) ?? new Map<string, ServerEvent>();
      if ((types.get(event.type)?.seq ?? -1) < event.seq) types.set(event.type, event);
      this.latestByType.set(event.agentId, types);
    }
    this.discovered.add(event.type);
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
  latest(settings: Settings): Map<string, ServerEvent> {
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
