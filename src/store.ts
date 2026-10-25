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
const terminal = (status: string) => ['completed', 'failed', 'stopped', 'interrupted'].includes(status);
const STREAMED_MESSAGE_KINDS = new Set(['agent_message_chunk', 'agent_thought_chunk', 'user_message_chunk']);
function isStreamedMessage(event: ServerEvent): boolean {
  const data = object(event.data);
  return event.type === 'agent.message' && STREAMED_MESSAGE_KINDS.has(data.sessionUpdate) && typeof data.content?.text === 'string';
}
function messageIdentity(event: ServerEvent): string | undefined {
  const messageId = object(event.data).messageId;
  return typeof messageId === 'string' ? createHash('sha256').update(messageId).digest('hex') : undefined;
}
type HistoryCutoff = { seq: number; inclusive: boolean };
type LivePreviewBoundary = { event: ServerEvent; streamKind?: string; messageIdentity?: string; startSeq?: number; historyCutoff?: number; historyCutoffInclusive?: boolean };
type HistoricalLivePreviewBoundary = LivePreviewBoundary & { boundarySeq?: number; boundaryInclusive?: boolean };
function latestHistoryCutoff(...cutoffs: (HistoryCutoff | undefined)[]): HistoryCutoff | undefined {
  return cutoffs.reduce<HistoryCutoff | undefined>((latest, current) => {
    if (!current || (latest && current.seq < latest.seq)) return latest;
    if (!latest || current.seq > latest.seq) return current;
    return { seq: current.seq, inclusive: current.inclusive || latest.inclusive };
  }, undefined);
}
function historyBoundary(previous: ServerEvent, candidate: ServerEvent, renderings: ReadonlyMap<number, unknown>): HistoryCutoff {
  const boundary = !isStreamedMessage(candidate) || renderings.has(candidate.seq)
    ? candidate
    : !isStreamedMessage(previous) || renderings.has(previous.seq) ? previous : candidate;
  return { seq: boundary.seq, inclusive: renderings.has(boundary.seq) };
}
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
  if (event.type === 'prompt.queued' && typeof data.text === 'string' && object(data.promptCue).version === 1) {
    const prefix = boundedGraphemePrefix(data.text, TREE_PREVIEW_MESSAGE_BYTES);
    const cue = object(data.promptCue);
    return { ...event, type: boundedUtf8(event.type, 128), time: boundedUtf8(event.time, 64), ...(event.agentId && { agentId: boundedUtf8(event.agentId, 128) }), ...(event.generation && { generation: boundedUtf8(event.generation, 128) }), data: { operationId: boundedUtf8(String(data.operationId ?? ''), 96), text: prefix.text, promptCue: cue, ...(prefix.truncated && { previewTruncated: true }) } };
  }
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
type LivePreviewFallback = { event: ServerEvent; subtype?: string; rendering?: EventRendering; lineage?: ServerEvent[] };

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
  private livePreviewFallbacks = new Map<string, Map<string, LivePreviewFallback>>();
  private previewSources = new Map<number, ServerEvent>();
  private previewMessageIdentities = new Map<number, string>();
  private livePreviewBoundaries = new Map<string, LivePreviewBoundary>();
  private livePreviewStreams = new Map<string, Map<string, LivePreviewBoundary>>();
  private livePreviewWatermarks = new Map<string, number>();
  private livePreviewNeedsHistory = new Set<string>();
  private previewGeneration = new Map<string, string | null | undefined>();
  private previewFloors = new Map<string, number>();
  private previewRenderings = new Map<number, EventRendering>();
  private previewSubtypeIds = new Map<number, string>();
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
    const fallbacks = this.livePreviewFallbacks.get(agentId);
    this.livePreviews.delete(agentId);
    this.livePreviewFallbacks.delete(agentId);
    const ownedSeqs = new Set<number>();
    if (candidates) for (const event of candidates.values()) ownedSeqs.add(event.seq);
    if (fallbacks) for (const fallback of fallbacks.values()) {
      ownedSeqs.add(fallback.event.seq);
      for (const event of fallback.lineage ?? []) ownedSeqs.add(event.seq);
    }
    for (const seq of ownedSeqs) this.forgetPreviewRendering(seq, true);
    this.prunePreviewSources(agentId);
    this.livePreviewBoundaries.delete(agentId);
    this.livePreviewStreams.delete(agentId);
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
    let startSeq: number | undefined, boundary: HistoryCutoff | undefined;
    for (const candidate of this.orderedEvents()) {
      if (candidate.agentId !== event.agentId || candidate.seq >= event.seq) continue;
      const joined = previous && !this.renderings.has(previous.seq) && !this.renderings.has(candidate.seq)
        ? appendMessageChunk(previous, candidate) : undefined;
      if (joined) previous = joined;
      else {
        if (previous) boundary = historyBoundary(previous, candidate, this.renderings);
        previous = candidate; startSeq = candidate.seq;
      }
    }
    if (!previous || this.renderings.has(previous.seq) || this.renderings.has(event.seq)) return;
    const joined = appendMessageChunk(previous, event);
    return joined ? {
      event: joined, streamKind: object(event.data).sessionUpdate, messageIdentity: messageIdentity(event), startSeq,
      boundarySeq: boundary?.seq, boundaryInclusive: boundary?.inclusive,
    } : undefined;
  }
  private historyMessageThrough(agentId: string, throughSeq: number): HistoricalLivePreviewBoundary | undefined {
    let previous: ServerEvent | undefined;
    let startSeq: number | undefined, boundary: HistoryCutoff | undefined;
    for (const candidate of this.orderedEvents()) {
      if (candidate.agentId !== agentId || candidate.seq > throughSeq) continue;
      const joined = previous && !this.renderings.has(previous.seq) && !this.renderings.has(candidate.seq)
        ? appendMessageChunk(previous, candidate) : undefined;
      if (joined) previous = joined;
      else {
        if (previous) boundary = historyBoundary(previous, candidate, this.renderings);
        previous = candidate; startSeq = candidate.seq;
      }
    }
    if (!previous || !isStreamedMessage(previous) || this.renderings.has(previous.seq)) return;
    return {
      event: previous, streamKind: object(previous.data).sessionUpdate, messageIdentity: messageIdentity(previous), startSeq,
      boundarySeq: boundary?.seq, boundaryInclusive: boundary?.inclusive,
    };
  }
  private retainedPreviewMessageThrough(agentId: string, throughSeq: number): HistoricalLivePreviewBoundary | undefined {
    const events = new Map<number, ServerEvent>();
    for (const event of this.orderedEvents()) if (event.agentId === agentId && event.seq <= throughSeq) events.set(event.seq, event);
    for (const event of this.previewSources.values()) if (event.agentId === agentId && event.seq <= throughSeq && !events.has(event.seq)) events.set(event.seq, event);
    for (const fallback of this.livePreviewFallbacks.get(agentId)?.values() ?? [])
      for (const event of fallback.lineage ?? []) if (event.seq <= throughSeq && !events.has(event.seq)) events.set(event.seq, event);
    let previous: ServerEvent | undefined;
    let startSeq: number | undefined, boundary: HistoryCutoff | undefined;
    for (const candidate of [...events.values()].sort((a, b) => a.seq - b.seq)) {
      const joined = previous && !this.hasPreviewRendering(previous.seq) && !this.hasPreviewRendering(candidate.seq)
        ? this.appendRetainedPreviewChunk(previous, candidate) : undefined;
      if (joined) previous = joined;
      else {
        if (previous) {
          const boundaryEvent = !isStreamedMessage(candidate) || this.hasPreviewRendering(candidate.seq)
            ? candidate
            : !isStreamedMessage(previous) || this.hasPreviewRendering(previous.seq) ? previous : candidate;
          boundary = { seq: boundaryEvent.seq, inclusive: this.hasPreviewRendering(boundaryEvent.seq) };
        }
        previous = candidate; startSeq = candidate.seq;
      }
    }
    if (!previous || !isStreamedMessage(previous) || this.hasPreviewRendering(previous.seq)) return;
    return {
      event: previous, streamKind: object(previous.data).sessionUpdate, messageIdentity: messageIdentity(previous), startSeq,
      boundarySeq: boundary?.seq, boundaryInclusive: boundary?.inclusive,
    };
  }
  private appendRetainedPreviewChunk(previous: ServerEvent, candidate: ServerEvent): ServerEvent | undefined {
    const previousData = object(previous.data), candidateData = object(candidate.data);
    const previousId = previousData.messageId, candidateId = candidateData.messageId;
    if (typeof previousId === 'string' && typeof candidateId === 'string') {
      const previousIdentity = this.previewMessageIdentities.get(previous.seq) ?? messageIdentity(previous);
      const candidateIdentity = this.previewMessageIdentities.get(candidate.seq) ?? messageIdentity(candidate);
      if (previousIdentity !== candidateIdentity) return undefined;
      // appendMessageChunk also compares messageId; normalize only that field after
      // the collision-resistant identity check, then restore the candidate's wire ID.
      const normalizedPrevious = { ...previous, data: { ...previousData, messageId: previousIdentity } };
      const normalizedCandidate = { ...candidate, data: { ...candidateData, messageId: candidateIdentity } };
      const joined = appendMessageChunk(normalizedPrevious, normalizedCandidate);
      return joined ? { ...joined, data: { ...object(joined.data), messageId: candidateId } } : undefined;
    }
    return appendMessageChunk(previous, candidate);
  }
  private reconcileRetainedStreamCandidates(agentId: string, type: string, changedSeq: number): void {
    const candidates = this.livePreviews.get(agentId);
    const reconcile = (candidate: ServerEvent): ServerEvent => {
      if (candidate.seq < changedSeq || candidate.type !== type || !isStreamedMessage(candidate)) return candidate;
      const historical = this.retainedPreviewMessageThrough(agentId, candidate.seq);
      return historical?.event.seq === candidate.seq ? compactPreview(historical.event) : candidate;
    };
    if (candidates) for (const [key, candidate] of candidates) {
      const corrected = reconcile(candidate);
      if (corrected === candidate) continue;
      candidates.set(key, corrected);
      const fallback = this.livePreviewFallbacks.get(agentId)?.get(type);
      if (fallback?.event.seq === candidate.seq) fallback.event = corrected;
      const stream = this.livePreviewStreams.get(agentId)?.get(type);
      if (stream?.event.seq === candidate.seq) stream.event = corrected;
      const latestBoundary = this.livePreviewBoundaries.get(agentId);
      if (latestBoundary?.event.seq === candidate.seq) latestBoundary.event = corrected;
    }
    const fallback = this.livePreviewFallbacks.get(agentId)?.get(type);
    if (fallback) {
      const corrected = reconcile(fallback.event);
      if (corrected !== fallback.event) {
        fallback.event = corrected;
        const stream = this.livePreviewStreams.get(agentId)?.get(type);
        if (stream?.event.seq === corrected.seq) stream.event = corrected;
        const latestBoundary = this.livePreviewBoundaries.get(agentId);
        if (latestBoundary?.event.seq === corrected.seq) latestBoundary.event = corrected;
      }
    }
  }
  private previewCandidateKey(event: ServerEvent, rendering?: EventRendering): string {
    if (rendering?.subtype) return `${event.type}\0${rendering.subtype}`;
    if (rendering) return event.type;
    // Sidecars may give any event a subtype override. Keep unresolved candidates
    // independent until that identity arrives, including streamed custom events.
    return `${event.type}\0seq:${event.seq}`;
  }
  private hasFallback(seq: number): boolean {
    for (const fallbacks of this.livePreviewFallbacks.values())
      if ([...fallbacks.values()].some(candidate => candidate.event.seq === seq || candidate.lineage?.some(event => event.seq === seq))) return true;
    return false;
  }
  private hasLiveCandidate(agentId: string, seq: number): boolean {
    return [...(this.livePreviews.get(agentId)?.values() ?? [])].some(candidate => candidate.seq === seq);
  }
  private releaseFallback(agentId: string, fallback: LivePreviewFallback): void {
    const sequences = new Set([fallback.event.seq, ...(fallback.lineage ?? []).map(event => event.seq)]);
    for (const seq of sequences) if (!this.hasFallback(seq) && !this.hasLiveCandidate(agentId, seq)) this.forgetPreviewRendering(seq);
  }
  private forgetPreviewRendering(seq: number, force = false): void {
    if (!force && this.hasFallback(seq)) return;
    this.previewRenderings.delete(seq);
    this.previewSubtypeIds.delete(seq);
  }
  private prunePreviewSources(agentId: string): void {
    const retained = new Set<number>();
    for (const event of this.livePreviews.get(agentId)?.values() ?? []) retained.add(event.seq);
    for (const fallback of this.livePreviewFallbacks.get(agentId)?.values() ?? []) {
      retained.add(fallback.event.seq);
      for (const event of fallback.lineage ?? []) retained.add(event.seq);
    }
    for (const [seq, event] of this.previewSources) if (event.agentId === agentId && !retained.has(seq)) {
      this.previewSources.delete(seq);
      this.previewMessageIdentities.delete(seq);
    }
  }
  private previewSubtype(seq: number): string | undefined {
    for (const fallbacks of this.livePreviewFallbacks.values()) {
      for (const candidate of fallbacks.values()) if (candidate.event.seq === seq) return candidate.subtype;
    }
    return this.previewSubtypeIds.get(seq) ?? this.previewRenderings.get(seq)?.subtype ?? this.renderings.get(seq)?.subtype;
  }
  private hasPreviewRendering(seq: number): boolean {
    if (this.renderings.has(seq) || this.previewRenderings.has(seq)) return true;
    for (const fallbacks of this.livePreviewFallbacks.values())
      for (const candidate of fallbacks.values()) if (candidate.event.seq === seq && candidate.rendering) return true;
    return false;
  }
  private reconcileLivePreviewFromHistory(agentId: string, type: string): void {
    const boundary = this.livePreviewStreams.get(agentId)?.get(type);
    const candidates = this.livePreviews.get(agentId);
    const currentEntry = boundary && candidates
      ? [...candidates].find(([, event]) => event.seq === boundary.event.seq)
      : undefined;
    const current = currentEntry?.[1];
    if (!current || !boundary?.streamKind) return;
    const historical = this.historyMessageThrough(agentId, current.seq);
    const provisionalStreamStart = historical?.boundarySeq !== undefined && historical.boundarySeq === historical.startSeq && !historical.boundaryInclusive;
    const retainedCutoff = boundary.historyCutoff === undefined || (provisionalStreamStart && !boundary.historyCutoffInclusive && boundary.historyCutoff === historical?.boundarySeq)
      ? undefined
      : { seq: boundary.historyCutoff, inclusive: boundary.historyCutoffInclusive === true };
    const cutoff = provisionalStreamStart ? retainedCutoff : latestHistoryCutoff(
      retainedCutoff,
      historical?.boundarySeq === undefined ? undefined : { seq: historical.boundarySeq, inclusive: historical.boundaryInclusive === true },
    );
    const historicalStart = historical?.startSeq ?? current.seq;
    if (!historical || historical.event.seq !== current.seq ||
        (cutoff && (historicalStart < cutoff.seq || (cutoff.inclusive && historicalStart === cutoff.seq))) ||
        (boundary.startSeq !== undefined && historicalStart > boundary.startSeq &&
          (historical.boundarySeq === undefined || historical.boundarySeq < boundary.startSeq))) return;
    const candidate = compactPreview(historical.event);
    const candidateRendering = this.previewRenderings.get(current.seq) ?? this.renderings.get(current.seq);
    const candidateKey = this.previewCandidateKey(candidate, candidateRendering);
    const candidateMap = this.livePreviews.get(agentId)!;
    if (currentEntry![0] !== candidateKey) candidateMap.delete(currentEntry![0]);
    const displaced = candidateMap.get(candidateKey);
    if (displaced && displaced.seq !== candidate.seq) this.forgetPreviewRendering(displaced.seq);
    candidateMap.set(candidateKey, candidate);
    const fallback = this.livePreviewFallbacks.get(agentId)?.get(type);
    if (fallback?.event.seq === candidate.seq) fallback.event = candidate;
    const reconciledBoundary = {
      event: candidate, streamKind: historical.streamKind, messageIdentity: historical.messageIdentity, startSeq: historical.startSeq,
      ...(cutoff && { historyCutoff: cutoff.seq, historyCutoffInclusive: cutoff.inclusive }),
    };
    this.livePreviewStreams.get(agentId)!.set(type, reconciledBoundary);
    const latestBoundary = this.livePreviewBoundaries.get(agentId);
    if (latestBoundary?.event.seq === current.seq && latestBoundary.streamKind) this.livePreviewBoundaries.set(agentId, reconciledBoundary);
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
  private hasInterveningAgentEvent(agentId: string, afterSeq: number, beforeSeq: number): boolean {
    return this.orderedEvents().some(event => event.agentId === agentId && event.seq > afterSeq && event.seq < beforeSeq);
  }
  private historicalBoundaryAfter(previous: LivePreviewBoundary, beforeSeq: number): HistoryCutoff | undefined {
    let boundary: HistoryCutoff | undefined;
    let preceding = previous;
    for (const event of this.orderedEvents()) {
      if (event.agentId !== previous.event.agentId || event.seq <= previous.event.seq || event.seq >= beforeSeq) continue;
      const rendered = this.renderings.has(event.seq);
      if (!isStreamedMessage(event) || rendered) {
        boundary = { seq: event.seq, inclusive: rendered };
        preceding = { event };
      } else {
        if (preceding.streamKind && !this.compatibleLiveStream(preceding, event)) boundary = { seq: event.seq, inclusive: false };
        preceding = {
          event, streamKind: object(event.data).sessionUpdate, messageIdentity: messageIdentity(event), startSeq: event.seq,
        };
      }
    }
    return boundary;
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
      else for (const candidate of this.livePreviews.get(event.agentId)?.values() ?? []) {
        if (candidate.seq > event.seq) this.reconcileLivePreviewFromHistory(event.agentId, candidate.type);
      }
      return; // Raw cache rebuild handles late/out-of-order records.
    }
    const candidates = this.livePreviews.get(event.agentId) ?? new Map<string, ServerEvent>();
    const candidateRendering = this.previewRenderings.get(event.seq) ?? this.renderings.get(event.seq);
    const candidateKey = this.previewCandidateKey(event, candidateRendering);
    const previousEntry = isStreamedMessage(event) && previousBoundary?.event.type === event.type
      ? [...candidates].find(([, candidate]) => candidate.seq === previousBoundary.event.seq)
      : [...candidates].find(([key]) => key === candidateKey);
    const previousKey = previousEntry?.[0];
    const previous = previousEntry?.[1];
    const streamKind = isStreamedMessage(event) && !this.renderings.has(event.seq) ? object(event.data).sessionUpdate : undefined;
    let joined: ServerEvent | undefined;
    let historical: HistoricalLivePreviewBoundary | undefined;
    let usedHistorical = false, historyCutoff: number | undefined, historyCutoffInclusive = false;
    let historicalBoundary: HistoryCutoff | undefined;
    let startSeq = event.seq;
    if (streamKind) {
      if (this.compatibleLiveStream(previousBoundary, event) && previous && !this.previewRenderings.has(previous.seq)) {
        joined = this.joinLiveMessage(previous, event);
        startSeq = previousBoundary!.startSeq ?? previousBoundary!.event.seq;
      }
      const needsHistory = this.livePreviewNeedsHistory.has(event.agentId) ||
        (!!previousBoundary && this.hasInterveningAgentEvent(event.agentId, previousBoundary.event.seq, event.seq));
      const shouldReconcileHistory = !previousBoundary || needsHistory || (this.compatibleLiveStream(previousBoundary, event) && !previous);
      historical = shouldReconcileHistory ? this.historyMessagePrefix(event) : undefined;
      const compatibleBoundary = this.compatibleLiveStream(previousBoundary, event);
      historyCutoff = compatibleBoundary ? previousBoundary?.historyCutoff : previousBoundary?.event.seq;
      historyCutoffInclusive = compatibleBoundary
        ? previousBoundary?.historyCutoffInclusive === true
        : !!previousBoundary && this.renderings.has(previousBoundary.event.seq);
      if (compatibleBoundary && previous && this.previewRenderings.has(previous.seq)) {
        const cutoff = latestHistoryCutoff(
          historyCutoff === undefined ? undefined : { seq: historyCutoff, inclusive: historyCutoffInclusive },
          { seq: previousBoundary!.event.seq, inclusive: true },
        );
        historyCutoff = cutoff?.seq;
        historyCutoffInclusive = cutoff?.inclusive === true;
      }
      historicalBoundary = needsHistory && previousBoundary
        ? this.historicalBoundaryAfter(previousBoundary, event.seq)
        : undefined;
      const cutoff = latestHistoryCutoff(
        historyCutoff === undefined ? undefined : { seq: historyCutoff, inclusive: historyCutoffInclusive },
        historicalBoundary,
      );
      const historicalStart = historical?.startSeq ?? event.seq;
      const crossesRetainedBoundary = !!historical && !!cutoff &&
        (historicalStart < cutoff.seq || (cutoff.inclusive && historicalStart === cutoff.seq));
      let resolvedHistoryBoundary = false;
      if (historical && !crossesRetainedBoundary &&
          (joined === undefined || (historical.startSeq ?? event.seq) <= startSeq ||
            (needsHistory && historical.boundarySeq !== undefined && historical.boundarySeq >= startSeq))) {
        joined = historical.event;
        startSeq = historical.startSeq ?? event.seq;
        usedHistorical = true;
      } else if (historicalBoundary !== undefined) {
        joined = undefined; startSeq = event.seq; resolvedHistoryBoundary = true;
      }
      if (shouldReconcileHistory && (historical || !needsHistory || resolvedHistoryBoundary)) this.livePreviewNeedsHistory.delete(event.agentId);
    }
    const candidate = compactPreview(joined ?? event);
    this.previewSources.set(event.seq, compactPreview(event));
    const sourceIdentity = messageIdentity(event);
    if (sourceIdentity) this.previewMessageIdentities.set(event.seq, sourceIdentity);
    else this.previewMessageIdentities.delete(event.seq);
    const provisionalStreamStart = historical?.boundarySeq !== undefined && historical.boundarySeq === historical.startSeq && !historical.boundaryInclusive;
    const acceptedCutoff = latestHistoryCutoff(
      historyCutoff === undefined ? undefined : { seq: historyCutoff, inclusive: historyCutoffInclusive },
      provisionalStreamStart ? undefined : historicalBoundary,
      usedHistorical && !provisionalStreamStart && historical?.boundarySeq !== undefined
        ? { seq: historical.boundarySeq, inclusive: historical.boundaryInclusive === true }
        : undefined,
    );
    if (previous && previousKey === candidateKey && previous.seq !== candidate.seq) this.forgetPreviewRendering(previous.seq);
    const displaced = candidates.get(candidateKey);
    if (displaced && displaced.seq !== candidate.seq) this.forgetPreviewRendering(displaced.seq);
    candidates.set(candidateKey, candidate);
    if (candidates.size > TREE_PREVIEW_TYPES_PER_AGENT) {
      const oldest = [...candidates.entries()].sort((a, b) => a[1].seq - b[1].seq)[0];
      if (oldest) {
        candidates.delete(oldest[0]); this.forgetPreviewRendering(oldest[1].seq);
        const streams = this.livePreviewStreams.get(event.agentId);
        if (streams?.get(oldest[1].type)?.event.seq === oldest[1].seq) streams.delete(oldest[1].type);
        if (!streams?.size) this.livePreviewStreams.delete(event.agentId);
      }
    }
    this.livePreviews.set(event.agentId, candidates);
    const rendering = this.renderings.get(event.seq);
    if (rendering) {
      this.previewRenderings.set(candidate.seq, this.compactRendering(rendering));
      if (rendering.subtype) this.previewSubtypeIds.set(candidate.seq, rendering.subtype);
    }
    const fallbacks = this.livePreviewFallbacks.get(event.agentId) ?? new Map<string, LivePreviewFallback>();
    const previousFallback = fallbacks.get(event.type);
    const sourceEvent = this.previewSources.get(event.seq)!;
    const lineage = streamKind
      ? this.compatibleLiveStream(previousBoundary, event) && !this.hasPreviewRendering(previousBoundary!.event.seq) && previousFallback?.lineage
        ? [...previousFallback.lineage, sourceEvent]
        : [sourceEvent]
      : undefined;
    if (lineage) {
      let remainingBytes = TREE_PREVIEW_MESSAGE_BYTES;
      const contributing: ServerEvent[] = [];
      for (const source of lineage) {
        if (remainingBytes <= 0) break;
        const data = object(source.data), content = object(data.content);
        if (typeof content.text !== 'string') continue;
        const contribution = boundedGraphemePrefix(content.text, remainingBytes).text;
        if (!contribution) continue;
        contributing.push({ ...source, data: { ...data, content: { ...content, text: contribution } } });
        remainingBytes -= Buffer.byteLength(contribution);
      }
      lineage.splice(0, lineage.length, ...contributing);
    }
    fallbacks.set(event.type, {
      event: candidate,
      ...(rendering?.subtype && { subtype: rendering.subtype }),
      ...(rendering && { rendering: this.compactRendering(rendering) }),
      ...(lineage && { lineage }),
    });
    if (fallbacks.size > TREE_PREVIEW_TYPES_PER_AGENT) {
      const oldest = [...fallbacks.entries()].sort((a, b) => a[1].event.seq - b[1].event.seq)[0];
      if (oldest) {
        fallbacks.delete(oldest[0]);
        this.releaseFallback(event.agentId, oldest[1]);
      }
    }
    if (previousFallback && previousFallback.event.seq !== candidate.seq) this.releaseFallback(event.agentId, previousFallback);
    this.livePreviewFallbacks.set(event.agentId, fallbacks);
    this.prunePreviewSources(event.agentId);
    const streams = this.livePreviewStreams.get(event.agentId) ?? new Map<string, LivePreviewBoundary>();
    if (streamKind) {
      streams.set(event.type, {
        event: candidate, streamKind, messageIdentity: messageIdentity(event), startSeq,
        ...(acceptedCutoff && { historyCutoff: acceptedCutoff.seq, historyCutoffInclusive: acceptedCutoff.inclusive }),
      });
    }
    else streams.delete(event.type);
    if (streams.size) this.livePreviewStreams.set(event.agentId, streams);
    else this.livePreviewStreams.delete(event.agentId);
    this.livePreviewBoundaries.set(event.agentId, {
      event: candidate, streamKind, messageIdentity: streamKind ? messageIdentity(event) : undefined,
      ...(streamKind && { startSeq }),
      ...(streamKind && acceptedCutoff && { historyCutoff: acceptedCutoff.seq, historyCutoffInclusive: acceptedCutoff.inclusive }),
    });
    this.livePreviewWatermarks.set(event.agentId, Math.max(this.livePreviewWatermarks.get(event.agentId) ?? -1, event.seq));
  }
  get treePreviewBytes(): number {
    let bytes = 0;
    const counted = new Set<number>();
    const count = (event: ServerEvent, subtype?: string, rendering?: EventRendering) => {
      if (counted.has(event.seq)) return;
      counted.add(event.seq);
      bytes += Buffer.byteLength(JSON.stringify(event)) + Buffer.byteLength(this.previewSources.get(event.seq)?.data ? JSON.stringify(this.previewSources.get(event.seq)) : '');
      if (subtype) bytes += Buffer.byteLength(subtype);
      const retainedRendering = rendering ?? this.previewRenderings.get(event.seq);
      if (retainedRendering) bytes += Buffer.byteLength(JSON.stringify(retainedRendering));
    };
    for (const candidates of this.livePreviews.values()) for (const event of candidates.values()) count(event, this.previewSubtypeIds.get(event.seq));
    for (const fallbacks of this.livePreviewFallbacks.values()) for (const candidate of fallbacks.values()) {
      count(candidate.event, candidate.subtype, candidate.rendering);
      for (const source of candidate.lineage ?? []) count(source, this.previewSubtypeIds.get(source.seq));
    }
    return bytes;
  }
  treeRenderings(): Map<number, EventRendering> {
    const renderings = new Map([...this.renderings, ...this.previewRenderings]);
    for (const fallbacks of this.livePreviewFallbacks.values()) for (const candidate of fallbacks.values())
      if (candidate.rendering) renderings.set(candidate.event.seq, candidate.rendering);
    return renderings;
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
    this.livePreviews.clear(); this.livePreviewFallbacks.clear(); this.previewSources.clear(); this.previewMessageIdentities.clear(); this.livePreviewBoundaries.clear(); this.livePreviewStreams.clear(); this.livePreviewWatermarks.clear(); this.livePreviewNeedsHistory.clear(); this.previewGeneration.clear(); this.previewFloors.clear(); this.previewRenderings.clear(); this.previewSubtypeIds.clear();
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
    const affected = new Map<string, Set<string>>();
    const affect = (agentId: string, type: string) => {
      const types = affected.get(agentId) ?? new Set<string>();
      types.add(type); affected.set(agentId, types);
    };
    if (event?.agentId) affect(event.agentId, event.type);
    for (const [agentId, fallbacks] of this.livePreviewFallbacks) for (const [type, fallback] of fallbacks) {
      const isFallback = fallback.event.seq === seq;
      const isLineage = fallback.lineage?.some(source => source.seq === seq) === true;
      if (!isFallback && !isLineage) continue;
      if (isFallback) {
        fallback.subtype = rendering.subtype;
        fallback.rendering = this.compactRendering(rendering);
      }
      if (isLineage) {
        this.previewRenderings.set(seq, this.compactRendering(rendering));
        if (rendering.subtype) this.previewSubtypeIds.set(seq, rendering.subtype);
        else this.previewSubtypeIds.delete(seq);
      }
      affect(agentId, type);
    }
    for (const [agentId, candidates] of this.livePreviews) {
      const retained = [...candidates].find(([, candidate]) => candidate.seq === seq);
      if (retained) {
        this.previewRenderings.set(seq, this.compactRendering(rendering));
        if (rendering.subtype) this.previewSubtypeIds.set(seq, rendering.subtype);
        else this.previewSubtypeIds.delete(seq);
        const [previousKey, candidate] = retained;
        const nextKey = this.previewCandidateKey(candidate, rendering);
        if (nextKey !== previousKey) {
          candidates.delete(previousKey);
          const existing = candidates.get(nextKey);
          if (!existing || existing.seq <= candidate.seq) {
            if (existing && existing.seq !== candidate.seq) this.forgetPreviewRendering(existing.seq);
            candidates.set(nextKey, candidate);
          } else this.forgetPreviewRendering(seq);
        }
        affect(agentId, candidate.type);
      }
      if (event?.agentId === agentId) for (const candidate of candidates.values()) if (candidate.seq > seq) {
        this.livePreviewNeedsHistory.add(agentId);
        this.reconcileLivePreviewFromHistory(agentId, candidate.type);
        affect(agentId, candidate.type);
      }
    }
    for (const [agentId, types] of affected) {
      for (const type of types) this.reconcileRetainedStreamCandidates(agentId, type, seq);
      this.prunePreviewSources(agentId);
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
    else if (event.agentId && (this.livePreviews.has(event.agentId) || this.livePreviewFallbacks.has(event.agentId))) {
      this.livePreviewNeedsHistory.add(event.agentId);
      const types = new Set([
        ...[...(this.livePreviews.get(event.agentId)?.values() ?? [])].map(candidate => candidate.type),
        ...[...(this.livePreviewFallbacks.get(event.agentId)?.keys() ?? [])],
      ]);
      for (const type of types) {
        this.reconcileLivePreviewFromHistory(event.agentId, type);
        this.reconcileRetainedStreamCandidates(event.agentId, type, event.seq);
      }
      this.prunePreviewSources(event.agentId);
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
    const subtype = this.renderings.get(event.seq)?.subtype;
    types.set(subtype ? `${event.type}\0${subtype}` : event.type, summary);
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
        if (settings.visible(event.type, this.renderings.get(event.seq)?.subtype) && event.seq > (this.previewFloors.get(agentId) ?? -1) && event.seq > (latest.get(agentId)?.seq ?? -1)) latest.set(agentId, event);
      }
    }
    // Only a preserved streamed-message candidate may win an equal-sequence tie;
    // other compact candidates can be truncated while the raw record is complete.
    for (const [agentId, types] of this.livePreviews) {
      const agent = this.agents.get(agentId);
      if (!agent || agent.removedAt !== null) continue;
      for (const event of types.values()) {
        const current = latest.get(agentId);
        const subtype = this.previewSubtype(event.seq);
        if (settings.visible(event.type, subtype) && event.seq > (this.previewFloors.get(agentId) ?? -1) &&
            (event.seq > (current?.seq ?? -1) || (event.seq === current?.seq && isStreamedMessage(event)))) latest.set(agentId, event);
      }
    }
    for (const [agentId, types] of this.livePreviewFallbacks) {
      const agent = this.agents.get(agentId);
      if (!agent || agent.removedAt !== null) continue;
      for (const candidate of types.values()) {
        const event = candidate.event, current = latest.get(agentId);
        if (settings.visible(event.type, candidate.subtype) && event.seq > (this.previewFloors.get(agentId) ?? -1) &&
            (event.seq > (current?.seq ?? -1) || (event.seq === current?.seq && isStreamedMessage(event)))) latest.set(agentId, event);
      }
    }
    return latest;
  }
  transcript(agentId: string, settings: Settings): ServerEvent[] {
    return this.orderedEvents().filter(event => event.agentId === agentId && settings.visible(event.type, this.renderings.get(event.seq)?.subtype));
  }
}
