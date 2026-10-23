import { EventEmitter } from 'node:events';
import type { Agent, Operation, ServerEvent, Snapshot, EventRendering } from './protocol.js';
import { DEFAULT_HISTORY, historySettings, type HistorySettings, type Settings } from './settings.js';

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
const TREE_PREVIEW_MAX_BYTES = 1024;
const TREE_PREVIEW_TYPES_PER_AGENT = 32;
function boundedUtf8(value: string, maxBytes: number): string {
  let bytes = Buffer.from(value).subarray(0, maxBytes);
  while (bytes.length) {
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { bytes = bytes.subarray(0, bytes.length - 1); }
  }
  return '';
}
function compactPreview(event: ServerEvent): ServerEvent {
  const serialized = JSON.stringify(event.data ?? null);
  const envelope = {
    ...event,
    type: boundedUtf8(event.type, 256),
    time: boundedUtf8(event.time, 64),
    ...(event.agentId && { agentId: boundedUtf8(event.agentId, 256) }),
    ...(event.generation && { generation: boundedUtf8(event.generation, 256) }),
  };
  if (Buffer.byteLength(serialized) <= TREE_PREVIEW_MAX_BYTES) return { ...envelope, data: JSON.parse(serialized) };
  let preview = boundedUtf8(serialized, TREE_PREVIEW_MAX_BYTES - 128);
  let data = { truncated: true, originalBytes: Buffer.byteLength(serialized), preview };
  while (Buffer.byteLength(JSON.stringify(data)) > TREE_PREVIEW_MAX_BYTES && preview.length) {
    preview = boundedUtf8(preview, Math.floor(Buffer.byteLength(preview) * 0.75));
    data = { truncated: true, originalBytes: Buffer.byteLength(serialized), preview };
  }
  return { ...envelope, data };
}
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
  // Independent, compact candidates for the live tree; raw history remains governed by cache policy.
  private livePreviews = new Map<string, Map<string, ServerEvent>>();
  private previewGeneration = new Map<string, string | null | undefined>();
  private previewFloors = new Map<string, number>();
  private previewRenderings = new Map<number, EventRendering>();
  private latestIndexedSeq = -1;
  private latestDirty = false;
  private policy: HistorySettings = { ...DEFAULT_HISTORY };
  private cache = new Map<number, { bytes: number; recent: boolean; loadedAt?: number; pending?: boolean }>();
  // Keep sequence IDs even when pinned history displaces live payloads, so old
  // chat records cannot remain "recent" forever merely by staying protected.
  private recentSequences = new Set<number>();
  private activeChat?: string;
  private browsingOlder = false;
  cachedBytes = 0; // Serialized payloads, not a claim about total process RSS.

  configureHistory(settings: HistorySettings): void {
    this.policy = historySettings(settings);
    this.pruneHistory();
  }
  setActiveChat(agentId?: string, older = false): void {
    const now = Date.now();
    for (const [seq, entry] of this.cache) if (entry.loadedAt !== undefined &&
      [this.activeChat, agentId].includes(this.events.get(seq)?.agentId)) entry.loadedAt = now;
    this.activeChat = agentId; this.browsingOlder = older;
    this.pruneHistory();
  }
  private measure(seq: number): void {
    const entry = this.cache.get(seq)!;
    this.cachedBytes -= entry.bytes;
    entry.bytes = (this.events.has(seq) ? Buffer.byteLength(JSON.stringify(this.events.get(seq))) : 0) +
      (this.renderings.has(seq) ? Buffer.byteLength(JSON.stringify(this.renderings.get(seq))) : 0);
    this.cachedBytes += entry.bytes;
  }
  private clearLivePreview(agentId: string): void {
    const candidates = this.livePreviews.get(agentId);
    if (candidates) for (const event of candidates.values()) this.previewRenderings.delete(event.seq);
    this.livePreviews.delete(agentId);
    this.previewGeneration.delete(agentId);
  }
  private pruneLivePreviews(): void {
    for (const [agentId] of this.livePreviews) {
      const agent = this.agents.get(agentId);
      if (!agent || agent.removedAt !== null) { this.clearLivePreview(agentId); this.previewFloors.delete(agentId); continue; }
      const generation = agent.generation;
      if (generation !== null && generation !== undefined && this.previewGeneration.has(agentId) && this.previewGeneration.get(agentId) !== generation) {
        this.clearLivePreview(agentId); this.previewFloors.set(agentId, Math.max(this.previewFloors.get(agentId) ?? -1, this.watermark));
      }
      this.previewGeneration.set(agentId, generation);
    }
  }
  private compactRendering(rendering: EventRendering): EventRendering {
    return {
      rendererId: boundedUtf8(rendering.rendererId, 128),
      summary: boundedUtf8(rendering.summary, 128), extended: boundedUtf8(rendering.extended, 128), full: boundedUtf8(rendering.full, 128),
      ...(rendering.subtype && { subtype: boundedUtf8(rendering.subtype, 64) }),
      ...(rendering.canonicalTool && { canonicalTool: boundedUtf8(rendering.canonicalTool, 64) }),
      ...(rendering.toolSymbol && { toolSymbol: boundedUtf8(rendering.toolSymbol, 16) }),
      ...(rendering.toolTarget && { toolTarget: boundedUtf8(rendering.toolTarget, 128) }),
      ...(rendering.invocationError !== undefined && { invocationError: rendering.invocationError }),
    };
  }
  private rememberLivePreview(event: ServerEvent): void {
    if (!event.agentId || event.type === 'agent.session_replaced') {
      if (event.agentId && event.type === 'agent.session_replaced') {
        this.clearLivePreview(event.agentId); this.previewFloors.set(event.agentId, Math.max(this.previewFloors.get(event.agentId) ?? -1, event.seq));
      }
      return;
    }
    const agent = this.agents.get(event.agentId);
    if (!agent || agent.removedAt !== null || Buffer.byteLength(event.type) > 256) return;
    const generation = event.generation ?? agent.generation;
    if (event.generation && agent.generation && event.generation !== agent.generation) {
      this.clearLivePreview(event.agentId); this.previewFloors.set(event.agentId, Math.max(this.previewFloors.get(event.agentId) ?? -1, event.seq));
      return;
    }
    if (generation !== null && generation !== undefined && this.previewGeneration.has(event.agentId) && this.previewGeneration.get(event.agentId) !== generation) {
      this.clearLivePreview(event.agentId); this.previewFloors.set(event.agentId, Math.max(this.previewFloors.get(event.agentId) ?? -1, event.seq - 1));
    }
    if (generation !== null && generation !== undefined) this.previewGeneration.set(event.agentId, generation);
    const candidates = this.livePreviews.get(event.agentId) ?? new Map<string, ServerEvent>();
    const previous = candidates.get(event.type);
    const joined = previous && !this.previewRenderings.has(previous.seq) && !this.renderings.has(event.seq)
      ? appendMessageChunk(previous, event) : undefined;
    const candidate = compactPreview(joined ?? event);
    if (previous) this.previewRenderings.delete(previous.seq);
    candidates.set(event.type, candidate);
    if (candidates.size > TREE_PREVIEW_TYPES_PER_AGENT) {
      const oldest = [...candidates.entries()].sort((a, b) => a[1].seq - b[1].seq)[0];
      if (oldest) { candidates.delete(oldest[0]); this.previewRenderings.delete(oldest[1].seq); }
    }
    this.livePreviews.set(event.agentId, candidates);
    const rendering = this.renderings.get(event.seq);
    if (rendering) this.previewRenderings.set(candidate.seq, this.compactRendering(rendering));
  }
  get treePreviewBytes(): number {
    let bytes = 0;
    for (const candidates of this.livePreviews.values()) for (const event of candidates.values()) {
      bytes += Buffer.byteLength(JSON.stringify(event));
      const rendering = this.previewRenderings.get(event.seq);
      if (rendering) bytes += Buffer.byteLength(JSON.stringify(rendering));
    }
    return bytes;
  }
  treeRenderings(): Map<number, EventRendering> {
    return new Map([...this.renderings, ...this.previewRenderings]);
  }
  private forget(seq: number): void {
    const entry = this.cache.get(seq);
    if (!entry) return;
    this.cachedBytes -= entry.bytes;
    this.cache.delete(seq); this.events.delete(seq); this.renderings.delete(seq);
    this.sortedCache = undefined;
    // These maps can hold merged chunks referencing evicted payloads too.
    this.latestByType.clear(); this.lastByAgent.clear();
    this.latestIndexedSeq = -1; this.latestDirty = true;
    this.emit('evict', seq);
  }
  pruneHistory(now = Date.now()): void {
    if (this.recentSequences.size > this.policy.recentEvents) {
      const recent = [...this.recentSequences].sort((a, b) => b - a);
      for (const seq of recent.slice(this.policy.recentEvents)) {
        this.recentSequences.delete(seq);
        const entry = this.cache.get(seq);
        if (entry) entry.recent = false;
      }
    }
    let changed = false;
    const active = (seq: number) => !!this.activeChat && this.events.get(seq)?.agentId === this.activeChat;
    for (const [seq, entry] of this.cache) {
      if (entry.loadedAt !== undefined && !active(seq) && now - entry.loadedAt >= this.policy.idleMinutes * 60_000) entry.loadedAt = undefined;
      if ((!entry.recent && entry.loadedAt === undefined && !entry.pending) ||
          (entry.pending && now - (entry.loadedAt ?? 0) >= this.policy.idleMinutes * 60_000)) { this.forget(seq); changed = true; }
    }
    if (this.cache.size <= this.policy.recentEvents && this.cachedBytes <= this.policy.cacheBytes) {
      if (changed) this.emit('change');
      return;
    }
    const priority = (seq: number, entry: { recent: boolean; loadedAt?: number; pending?: boolean }) =>
      active(seq) && entry.loadedAt !== undefined ? 2 : entry.recent || entry.pending ? 1 : 0;
    const candidates = [...this.cache].sort(([a, x], [b, y]) => priority(a, x) - priority(b, y) ||
      (priority(a, x) === 2 && this.browsingOlder ? b - a : priority(a, x) === 0 ? (x.loadedAt ?? 0) - (y.loadedAt ?? 0) || a - b : a - b));
    for (const [seq] of candidates) {
      if (this.cache.size <= this.policy.recentEvents && this.cachedBytes <= this.policy.cacheBytes) break;
      this.forget(seq); changed = true;
    }
    if (changed) this.emit('change');
  }

  reset(): void {
    this.agents.clear(); this.operations.clear(); this.events.clear(); this.renderings.clear();
    this.sortedCache = undefined; this.latestByType.clear(); this.lastByAgent.clear();
    this.livePreviews.clear(); this.previewGeneration.clear(); this.previewFloors.clear(); this.previewRenderings.clear();
    this.latestIndexedSeq = -1; this.latestDirty = false;
    this.watermark = -1; this.historyCursor = 0; this.historyGap = false;
    this.cache.clear(); this.recentSequences.clear(); this.cachedBytes = 0; this.activeChat = undefined;
  }
  install(snapshot: Snapshot): void {
    this.agents = new Map(snapshot.agents.map(agent => [agent.id, agent]));
    this.operations = new Map(snapshot.operations.map(operation => [operation.id, operation]));
    this.watermark = snapshot.seq;
    this.pruneLivePreviews();
    // The snapshot is for state only; older buffered events still belong in chat.
    for (const event of this.orderedEvents()) if (event.seq > snapshot.seq) this.reduce(event);
    for (const event of this.orderedEvents()) if (this.recentSequences.has(event.seq)) this.rememberLivePreview(event);
    this.pruneLivePreviews();
    this.emit('change');
  }
  present(seq: number, rendering: EventRendering): void {
    const rawBytes = this.events.has(seq) ? Buffer.byteLength(JSON.stringify(this.events.get(seq))) : 0;
    if (rawBytes + Buffer.byteLength(JSON.stringify(rendering)) > this.policy.cacheBytes) return;
    this.renderings.set(seq, rendering);
    if (!this.cache.has(seq)) this.cache.set(seq, { bytes: 0, recent: false, loadedAt: Date.now(), pending: true });
    this.measure(seq);
    this.pruneHistory();
    const event = this.events.get(seq);
    if (event && rendering.subtype) this.discovered.add(`${event.type}:${rendering.subtype}`);
    for (const candidates of this.livePreviews.values()) {
      if ([...candidates.values()].some(candidate => candidate.seq === seq)) {
        this.previewRenderings.set(seq, this.compactRendering(rendering));
        break;
      }
    }
    this.latestDirty = true;
    this.emit('change');
  }
  ingest(event: ServerEvent, source: 'live' | 'history' | 'chat-live' = 'live'): void {
    const stateEvent = event;
    if (Buffer.byteLength(JSON.stringify(event)) > this.policy.cacheBytes) {
      const data = JSON.stringify(event.data ?? null);
      event = { ...event, data: { truncated: true, originalBytes: Buffer.byteLength(data), preview: Buffer.from(data).subarray(0, Math.floor(this.policy.cacheBytes / 12)).toString('utf8') } };
    }
    const entry = this.cache.get(event.seq) ?? { bytes: 0, recent: false };
    entry.pending = false;
    if (source !== 'history') this.recentSequences.add(event.seq);
    entry.recent ||= this.recentSequences.has(event.seq);
    if (source !== 'live') entry.loadedAt = Date.now();
    this.cache.set(event.seq, entry);
    if (this.events.has(event.seq)) { this.pruneHistory(); return; }
    this.events.set(event.seq, event);
    if (this.renderings.has(event.seq) && Buffer.byteLength(JSON.stringify(event)) + Buffer.byteLength(JSON.stringify(this.renderings.get(event.seq))) > this.policy.cacheBytes) this.renderings.delete(event.seq);
    this.measure(event.seq);
    if (this.sortedCache && (!this.sortedCache.length || this.sortedCache.at(-1)!.seq < event.seq)) this.sortedCache.push(event);
    else this.sortedCache = undefined;
    // History can arrive after live events; rebuild summaries in sequence order.
    if (!this.latestDirty && event.seq > this.latestIndexedSeq) this.indexLatest(event);
    else this.latestDirty = true;
    this.discovered.add(event.type);
    const subtype = this.renderings.get(event.seq)?.subtype;
    if (subtype) this.discovered.add(`${event.type}:${subtype}`);
    if (this.watermark >= 0 && stateEvent.seq > this.watermark) this.reduce(stateEvent);
    if (source !== 'history') this.rememberLivePreview(stateEvent);
    this.pruneLivePreviews();
    this.pruneHistory();
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
      const agent = this.agents.get(agentId);
      if (agent && agent.removedAt !== null) continue;
      for (const event of types.values()) {
        if (settings.tracked(event.type) && event.seq > (this.previewFloors.get(agentId) ?? -1) && event.seq > (latest.get(agentId)?.seq ?? -1)) latest.set(agentId, event);
      }
    }
    for (const [agentId, types] of this.livePreviews) {
      const agent = this.agents.get(agentId);
      if (!agent || agent.removedAt !== null) continue;
      for (const event of types.values()) {
        if (settings.tracked(event.type) && event.seq > (this.previewFloors.get(agentId) ?? -1) && event.seq > (latest.get(agentId)?.seq ?? -1)) latest.set(agentId, event);
      }
    }
    return latest;
  }
  transcript(agentId: string, settings: Settings): ServerEvent[] {
    return this.orderedEvents().filter(event => event.agentId === agentId && settings.tracked(event.type));
  }
}
