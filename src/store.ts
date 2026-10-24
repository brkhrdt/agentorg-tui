import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
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
const STREAMED_MESSAGE_KINDS = new Set(['agent_message_chunk', 'agent_thought_chunk', 'user_message_chunk']);
function isStreamedMessage(event: ServerEvent): boolean {
  const data = object(event.data);
  return event.type === 'agent.message' && STREAMED_MESSAGE_KINDS.has(data.sessionUpdate) && typeof data.content?.text === 'string';
}
function messageIdentity(event: ServerEvent): string | undefined {
  const messageId = object(event.data).messageId;
  return typeof messageId === 'string' ? createHash('sha256').update(messageId).digest('hex') : undefined;
}
type LivePreviewBoundary = { event: ServerEvent; streamKind?: string; messageIdentity?: string; startSeq?: number };
type HistoricalLivePreviewBoundary = LivePreviewBoundary & { boundarySeq?: number };
const TREE_PREVIEW_MAX_BYTES = 1024;
const TREE_PREVIEW_MESSAGE_BYTES = 384;
const TREE_PREVIEW_TYPES_PER_AGENT = 32;
function boundedUtf8(value: string, maxBytes: number): string {
  let bytes = Buffer.from(value).subarray(0, maxBytes);
  while (bytes.length) {
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { bytes = bytes.subarray(0, bytes.length - 1); }
  }
  return '';
}
function boundedGraphemePrefix(value: string, maxBytes: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(value) <= maxBytes) return { text: value, truncated: false };
  const budget = maxBytes - Buffer.byteLength('…');
  let text = '', bytes = 0;
  for (const { segment } of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(value)) {
    const size = Buffer.byteLength(segment);
    if (bytes + size > budget) break;
    text += segment; bytes += size;
  }
  return { text, truncated: true };
}
function compactPreview(event: ServerEvent): ServerEvent {
  const data = object(event.data);
  const streamKind = data.sessionUpdate;
  if (event.type === 'agent.message' && STREAMED_MESSAGE_KINDS.has(streamKind) && typeof data.content?.text === 'string') {
    // Keep a bounded source prefix rather than JSON-truncating an accumulated
    // message. Subsequent chunks can then extend it without replacing its start.
    const prefix = boundedGraphemePrefix(data.content.text, TREE_PREVIEW_MESSAGE_BYTES);
    return {
      ...event,
      type: boundedUtf8(event.type, 128), time: boundedUtf8(event.time, 64),
      ...(event.agentId && { agentId: boundedUtf8(event.agentId, 128) }),
      ...(event.generation && { generation: boundedUtf8(event.generation, 128) }),
      data: {
        sessionUpdate: streamKind,
        ...(typeof data.messageId === 'string' && { messageId: boundedUtf8(data.messageId, 96) }),
        content: {
          type: 'text', text: prefix.text,
          ...((prefix.truncated || data.content.previewTruncated) && { previewTruncated: true }),
        },
      },
    };
  }
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
  let truncatedData = { truncated: true, originalBytes: Buffer.byteLength(serialized), preview };
  while (Buffer.byteLength(JSON.stringify(truncatedData)) > TREE_PREVIEW_MAX_BYTES && preview.length) {
    preview = boundedUtf8(preview, Math.floor(Buffer.byteLength(preview) * 0.75));
    truncatedData = { truncated: true, originalBytes: Buffer.byteLength(serialized), preview };
  }
  return { ...envelope, data: truncatedData };
}
export interface TreeRow { agent: Agent; depth: number }

type HistoryCacheEntry = { bytes: number; recent: boolean; loadedAt?: number; pending?: boolean; older?: boolean };

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
  private livePreviewBoundaries = new Map<string, LivePreviewBoundary>();
  private livePreviewWatermarks = new Map<string, number>();
  private livePreviewNeedsHistory = new Set<string>();
  private previewGeneration = new Map<string, string | null | undefined>();
  private previewFloors = new Map<string, number>();
  private previewRenderings = new Map<number, EventRendering>();
  private latestIndexedSeq = -1;
  private latestDirty = false;
  private policy: HistorySettings = { ...DEFAULT_HISTORY };
  private cache = new Map<number, HistoryCacheEntry>();
  // Keep sequence IDs even when pinned history displaces live payloads, so old
  // chat records cannot remain "recent" forever merely by staying protected.
  private recentSequences = new Set<number>();
  private activeChat?: string;
  private browsingOlder = false;
  private activeAnchorSeq?: number;
  cachedBytes = 0; // Serialized payloads, not a claim about total process RSS.

  configureHistory(settings: HistorySettings): void {
    this.policy = historySettings(settings);
    this.pruneHistory();
  }
  setActiveChat(agentId?: string, older = false, anchorSeq?: number): void {
    const now = Date.now();
    for (const [seq, entry] of this.cache) if (entry.loadedAt !== undefined &&
      [this.activeChat, agentId].includes(this.events.get(seq)?.agentId)) entry.loadedAt = now;
    if (this.activeChat !== agentId) this.activeAnchorSeq = undefined;
    this.activeChat = agentId; this.browsingOlder = older;
    if (older && anchorSeq !== undefined) this.activeAnchorSeq = anchorSeq;
    else if (!older) this.activeAnchorSeq = undefined;
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
    this.livePreviewBoundaries.delete(agentId);
    this.livePreviewNeedsHistory.delete(agentId);
    this.previewGeneration.delete(agentId);
  }
  private pruneLivePreviews(): void {
    for (const [agentId] of this.livePreviews) {
      const agent = this.agents.get(agentId);
      if (!agent || agent.removedAt !== null) { this.clearLivePreview(agentId); this.livePreviewWatermarks.delete(agentId); this.previewFloors.delete(agentId); continue; }
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
  private historyMessagePrefix(event: ServerEvent): HistoricalLivePreviewBoundary | undefined {
    let previous: ServerEvent | undefined;
    let startSeq: number | undefined, boundarySeq: number | undefined;
    for (const candidate of this.orderedEvents()) {
      if (candidate.agentId !== event.agentId || candidate.seq >= event.seq) continue;
      const joined = previous && !this.renderings.has(previous.seq) && !this.renderings.has(candidate.seq)
        ? appendMessageChunk(previous, candidate) : undefined;
      if (joined) previous = joined;
      else {
        if (previous) boundarySeq = !isStreamedMessage(candidate) || this.renderings.has(candidate.seq)
          ? candidate.seq
          : !isStreamedMessage(previous) || this.renderings.has(previous.seq) ? previous.seq : candidate.seq;
        previous = candidate; startSeq = candidate.seq;
      }
    }
    if (!previous || this.renderings.has(previous.seq) || this.renderings.has(event.seq)) return;
    const joined = appendMessageChunk(previous, event);
    return joined ? { event: joined, streamKind: object(event.data).sessionUpdate, messageIdentity: messageIdentity(event), startSeq, boundarySeq } : undefined;
  }
  private historyMessageThrough(agentId: string, throughSeq: number): HistoricalLivePreviewBoundary | undefined {
    let previous: ServerEvent | undefined;
    let startSeq: number | undefined, boundarySeq: number | undefined;
    for (const candidate of this.orderedEvents()) {
      if (candidate.agentId !== agentId || candidate.seq > throughSeq) continue;
      const joined = previous && !this.renderings.has(previous.seq) && !this.renderings.has(candidate.seq)
        ? appendMessageChunk(previous, candidate) : undefined;
      if (joined) previous = joined;
      else {
        if (previous) boundarySeq = !isStreamedMessage(candidate) || this.renderings.has(candidate.seq)
          ? candidate.seq
          : !isStreamedMessage(previous) || this.renderings.has(previous.seq) ? previous.seq : candidate.seq;
        previous = candidate; startSeq = candidate.seq;
      }
    }
    if (!previous || !isStreamedMessage(previous) || this.renderings.has(previous.seq)) return;
    return { event: previous, streamKind: object(previous.data).sessionUpdate, messageIdentity: messageIdentity(previous), startSeq, boundarySeq };
  }
  private reconcileLivePreviewFromHistory(agentId: string, type: string): void {
    const current = this.livePreviews.get(agentId)?.get(type);
    const boundary = this.livePreviewBoundaries.get(agentId);
    if (!current || !boundary?.streamKind) return;
    const historical = this.historyMessageThrough(agentId, current.seq);
    if (!historical || historical.event.seq !== current.seq ||
        (boundary.startSeq !== undefined && (historical.startSeq ?? current.seq) > boundary.startSeq &&
          (historical.boundarySeq === undefined || historical.boundarySeq < boundary.startSeq))) return;
    const candidate = compactPreview(historical.event);
    this.livePreviews.get(agentId)!.set(type, candidate);
    this.livePreviewBoundaries.set(agentId, {
      event: candidate, streamKind: historical.streamKind, messageIdentity: historical.messageIdentity, startSeq: historical.startSeq,
    });
    if (!this.orderedEvents().some(event => event.agentId === agentId && event.seq > current.seq)) this.livePreviewNeedsHistory.delete(agentId);
  }
  private joinLiveMessage(previous: ServerEvent, event: ServerEvent): ServerEvent {
    const data = object(event.data), previousData = object(previous.data);
    const alreadyTruncated = previousData.content.previewTruncated === true;
    const content = { ...data.content, text: alreadyTruncated ? previousData.content.text : previousData.content.text + data.content.text };
    if (alreadyTruncated || data.content.previewTruncated) content.previewTruncated = true;
    return { ...event, data: { ...data, content } };
  }
  private compatibleLiveStream(previous: LivePreviewBoundary | undefined, event: ServerEvent): boolean {
    const data = object(event.data);
    return !!previous && previous.streamKind === data.sessionUpdate && STREAMED_MESSAGE_KINDS.has(data.sessionUpdate) &&
      previous.event.type === event.type && previous.event.agentId === event.agentId && previous.event.generation === event.generation &&
      previous.messageIdentity === messageIdentity(event) && typeof data.content?.text === 'string';
  }
  private hasHistoricalBoundaryAfter(agentId: string, afterSeq: number, beforeSeq: number): boolean {
    return this.orderedEvents().some(event => event.agentId === agentId && event.seq > afterSeq && event.seq < beforeSeq);
  }
  private rememberLivePreview(event: ServerEvent, replay = false): void {
    if (!event.agentId || event.type === 'agent.session_replaced') {
      if (event.agentId && event.type === 'agent.session_replaced') {
        this.clearLivePreview(event.agentId); this.livePreviewWatermarks.delete(event.agentId); this.previewFloors.set(event.agentId, Math.max(this.previewFloors.get(event.agentId) ?? -1, event.seq));
      }
      return;
    }
    const agent = this.agents.get(event.agentId);
    if (!agent || agent.removedAt !== null || Buffer.byteLength(event.type) > 256) return;
    if (replay && event.seq <= (this.livePreviewWatermarks.get(event.agentId) ?? -1)) return;
    const generation = event.generation ?? agent.generation;
    if (event.generation && agent.generation && event.generation !== agent.generation) {
      this.clearLivePreview(event.agentId); this.livePreviewWatermarks.delete(event.agentId); this.previewFloors.set(event.agentId, Math.max(this.previewFloors.get(event.agentId) ?? -1, event.seq));
      return;
    }
    if (generation !== null && generation !== undefined && this.previewGeneration.has(event.agentId) && this.previewGeneration.get(event.agentId) !== generation) {
      this.clearLivePreview(event.agentId); this.livePreviewWatermarks.delete(event.agentId); this.previewFloors.set(event.agentId, Math.max(this.previewFloors.get(event.agentId) ?? -1, event.seq - 1));
    }
    if (generation !== null && generation !== undefined) this.previewGeneration.set(event.agentId, generation);
    const previousBoundary = this.livePreviewBoundaries.get(event.agentId);
    if (!replay && previousBoundary && event.seq <= previousBoundary.event.seq) {
      this.livePreviewNeedsHistory.add(event.agentId);
      if (isStreamedMessage(event)) this.reconcileLivePreviewFromHistory(event.agentId, event.type);
      return; // Raw cache rebuild handles late/out-of-order records.
    }
    const candidates = this.livePreviews.get(event.agentId) ?? new Map<string, ServerEvent>();
    const previous = candidates.get(event.type);
    const streamKind = isStreamedMessage(event) && !this.renderings.has(event.seq) ? object(event.data).sessionUpdate : undefined;
    let joined: ServerEvent | undefined;
    let startSeq = event.seq;
    if (streamKind) {
      if (this.compatibleLiveStream(previousBoundary, event) && previous && !this.previewRenderings.has(previous.seq)) {
        joined = this.joinLiveMessage(previous, event);
        startSeq = previousBoundary!.startSeq ?? previousBoundary!.event.seq;
      }
      const needsHistory = this.livePreviewNeedsHistory.has(event.agentId);
      const shouldReconcileHistory = !previousBoundary || needsHistory || (this.compatibleLiveStream(previousBoundary, event) && !previous);
      const historical = shouldReconcileHistory ? this.historyMessagePrefix(event) : undefined;
      let resolvedHistoryBoundary = false;
      if (historical && (joined === undefined || (historical.startSeq ?? event.seq) <= startSeq ||
          (needsHistory && historical.boundarySeq !== undefined && historical.boundarySeq >= startSeq))) {
        joined = historical.event;
        startSeq = historical.startSeq ?? event.seq;
      } else if (needsHistory && previousBoundary &&
          this.hasHistoricalBoundaryAfter(event.agentId, previousBoundary.event.seq, event.seq)) {
        joined = undefined; startSeq = event.seq; resolvedHistoryBoundary = true;
      }
      if (shouldReconcileHistory && (historical || !needsHistory || resolvedHistoryBoundary)) this.livePreviewNeedsHistory.delete(event.agentId);
    }
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
    this.livePreviewBoundaries.set(event.agentId, {
      event: candidate, streamKind, messageIdentity: streamKind ? messageIdentity(event) : undefined,
      ...(streamKind && { startSeq }),
    });
    this.livePreviewWatermarks.set(event.agentId, Math.max(this.livePreviewWatermarks.get(event.agentId) ?? -1, event.seq));
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
    const activeTail = [...this.cache.keys()].filter(active).sort((a, b) => b - a)
      .slice(0, Math.max(1, Math.min(this.policy.chatPageSize, Math.floor(this.policy.recentEvents / 3))));
    const newestActiveSeq = activeTail[0];
    const oldestOlderSeq = this.browsingOlder
      ? [...this.cache].filter(([seq, entry]) => active(seq) && entry.loadedAt !== undefined && entry.older).reduce<number | undefined>((oldest, [seq]) => oldest === undefined || seq < oldest ? seq : oldest, undefined)
      : undefined;
    const priority = (seq: number, entry: HistoryCacheEntry) =>
      active(seq) && entry.loadedAt !== undefined
        ? seq === newestActiveSeq ? 7
          : seq === oldestOlderSeq ? 8 // Keep the paging cursor moving if the newest tail cannot coexist.
            : seq === this.activeAnchorSeq ? 5
              : activeTail.includes(seq) ? 4
                : this.browsingOlder && entry.older ? 3 : 2
        : entry.recent || entry.pending ? 1 : 0;
    const candidates = [...this.cache].sort(([a, x], [b, y]) => {
      const rank = priority(a, x) - priority(b, y);
      if (rank) return rank;
      // During older paging, discard the high end of a historical band first:
      // the newly fetched lower page can then advance the next before cursor.
      if (this.browsingOlder && (priority(a, x) === 2 || priority(a, x) === 3)) return b - a;
      return a - b;
    });
    for (const [seq] of candidates) {
      if (this.cache.size <= this.policy.recentEvents && this.cachedBytes <= this.policy.cacheBytes) break;
      this.forget(seq); changed = true;
    }
    if (changed) this.emit('change');
  }

  reset(): void {
    this.agents.clear(); this.operations.clear(); this.events.clear(); this.renderings.clear();
    this.sortedCache = undefined; this.latestByType.clear(); this.lastByAgent.clear();
    this.livePreviews.clear(); this.livePreviewBoundaries.clear(); this.livePreviewWatermarks.clear(); this.livePreviewNeedsHistory.clear(); this.previewGeneration.clear(); this.previewFloors.clear(); this.previewRenderings.clear();
    this.latestIndexedSeq = -1; this.latestDirty = false;
    this.watermark = -1; this.historyCursor = 0; this.historyGap = false;
    this.cache.clear(); this.recentSequences.clear(); this.cachedBytes = 0; this.activeChat = undefined; this.activeAnchorSeq = undefined; this.browsingOlder = false;
  }
  install(snapshot: Snapshot): void {
    this.agents = new Map(snapshot.agents.map(agent => [agent.id, agent]));
    this.operations = new Map(snapshot.operations.map(operation => [operation.id, operation]));
    this.watermark = snapshot.seq;
    this.pruneLivePreviews();
    // The snapshot is for state only; older buffered events still belong in chat.
    for (const event of this.orderedEvents()) if (event.seq > snapshot.seq) this.reduce(event);
    for (const event of this.orderedEvents()) if (this.recentSequences.has(event.seq)) this.rememberLivePreview(event, true);
    this.pruneLivePreviews();
    this.emit('change');
  }
  present(seq: number, rendering: EventRendering): void {
    const rawBytes = this.events.has(seq) ? Buffer.byteLength(JSON.stringify(this.events.get(seq))) : 0;
    if (rawBytes + Buffer.byteLength(JSON.stringify(rendering)) > this.policy.cacheBytes) return;
    this.renderings.set(seq, rendering);
    if (!this.cache.has(seq)) this.cache.set(seq, { bytes: 0, recent: false, loadedAt: Date.now(), pending: true });
    this.measure(seq);
    const event = this.events.get(seq);
    if (event && rendering.subtype) this.discovered.add(`${event.type}:${rendering.subtype}`);
    if (event?.agentId) {
      const candidates = this.livePreviews.get(event.agentId);
      if (candidates) for (const [type, candidate] of candidates) if (candidate.seq > seq) {
        this.livePreviewNeedsHistory.add(event.agentId);
        this.reconcileLivePreviewFromHistory(event.agentId, type);
      }
    }
    for (const candidates of this.livePreviews.values()) {
      if ([...candidates.values()].some(candidate => candidate.seq === seq)) {
        this.previewRenderings.set(seq, this.compactRendering(rendering));
        break;
      }
    }
    this.pruneHistory();
    this.latestDirty = true;
    this.emit('change');
  }
  ingest(event: ServerEvent, source: 'live' | 'history' | 'chat-history' | 'chat-live' = 'live'): void {
    const stateEvent = event;
    if (Buffer.byteLength(JSON.stringify(event)) > this.policy.cacheBytes) {
      const data = JSON.stringify(event.data ?? null);
      event = { ...event, data: { truncated: true, originalBytes: Buffer.byteLength(data), preview: Buffer.from(data).subarray(0, Math.floor(this.policy.cacheBytes / 12)).toString('utf8') } };
    }
    const entry = this.cache.get(event.seq) ?? { bytes: 0, recent: false };
    entry.pending = false;
    if (source === 'chat-history') entry.older = true;
    if (source !== 'history' && source !== 'chat-history') this.recentSequences.add(event.seq);
    entry.recent ||= this.recentSequences.has(event.seq);
    if (source !== 'live') entry.loadedAt = Date.now();
    if ((source === 'history' || source === 'chat-history') && event.agentId && this.livePreviewBoundaries.has(event.agentId)) this.livePreviewNeedsHistory.add(event.agentId);
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
    if (source !== 'history' && source !== 'chat-history') this.rememberLivePreview(stateEvent);
    else if (event.agentId && this.livePreviews.has(event.agentId)) {
      this.livePreviewNeedsHistory.add(event.agentId);
      for (const [type] of this.livePreviews.get(event.agentId)!) this.reconcileLivePreviewFromHistory(event.agentId, type);
    }
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
    // Only a preserved streamed-message candidate may win an equal-sequence tie;
    // other compact candidates can be truncated while the raw record is complete.
    for (const [agentId, types] of this.livePreviews) {
      const agent = this.agents.get(agentId);
      if (!agent || agent.removedAt !== null) continue;
      for (const event of types.values()) {
        const current = latest.get(agentId);
        if (settings.tracked(event.type) && event.seq > (this.previewFloors.get(agentId) ?? -1) &&
            (event.seq > (current?.seq ?? -1) || (event.seq === current?.seq && isStreamedMessage(event)))) latest.set(agentId, event);
      }
    }
    return latest;
  }
  transcript(agentId: string, settings: Settings): ServerEvent[] {
    return this.orderedEvents().filter(event => event.agentId === agentId && settings.tracked(event.type));
  }
}
