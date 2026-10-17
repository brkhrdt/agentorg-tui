import { Session } from './session.js';
import { Settings } from './settings.js';
import { renderTable } from './table.js';
import type { ServerEvent } from './protocol.js';

class Samples {
  private values: number[] = [];
  count = 0;
  private total = 0;
  private max = 0;
  add(value: number) {
    this.values[this.count++ % 4096] = value;
    this.total += value;
    this.max = Math.max(this.max, value);
  }
  json() {
    const sorted = [...this.values].sort((a, b) => a - b);
    const p = (q: number) => sorted[Math.max(0, Math.ceil(sorted.length * q) - 1)] ?? 0;
    return { count: this.count, mean: this.count ? this.total / this.count : 0, max: this.max, p50: p(.5), p95: p(.95), p99: p(.99), percentileSamples: sorted.length };
  }
}

/** Real TUI session/store/tree renderer, without Blessed or terminal painting. */
export class TreeProbe {
  readonly session: Session;
  private settings = new Settings();
  private started = performance.now();
  private visible = new Set<string>();
  private pending = new Map<string, { type: string; received: number; serverTime: number }>();
  private timer?: ReturnType<typeof setTimeout>;
  private heartbeat?: ReturnType<typeof setInterval>;
  private running?: Promise<void>;
  private stopping = false;
  private readyMs?: number;
  private frames = 0;
  private added = 0;
  private removed = 0;
  private receivedAdds = 0;
  private receivedRemoves = 0;
  private coalesced = 0;
  private disconnects = 0;
  private everConnected = false;
  private renderMs = new Samples();
  private addLag = new Samples();
  private removeLag = new Samples();
  private deliveryToRender = new Samples();
  private eventLoopLag = new Samples();
  private lastError?: string;
  constructor(socketPath: string, private width = 120, private frameMs = 16) {
    this.session = new Session(socketPath, { replayHistory: false });
    this.session.on('event', (event: ServerEvent) => {
      if (!event.agentId || !['agent.created', 'agent.removed'].includes(event.type)) return;
      if (event.type === 'agent.created') this.receivedAdds++; else this.receivedRemoves++;
      if (this.pending.has(event.agentId)) this.coalesced++;
      this.pending.set(event.agentId, { type: event.type, received: performance.now(), serverTime: Date.parse(event.time) });
    });
    this.session.on('notice', (message: string) => { this.lastError = message; });
    this.session.on('status', () => {
      if (this.session.status === 'connected') this.everConnected = true;
      if (this.session.status.startsWith('disconnected') && this.everConnected && !this.stopping) this.disconnects++;
    });
    this.session.store.on('change', () => {
      if (!this.timer && !this.stopping) this.timer = setTimeout(() => { this.timer = undefined; this.render(); }, frameMs);
    });
  }
  private render() {
    const began = performance.now();
    const rows = this.session.store.tree();
    const table = renderTable(rows, this.session.store.latest(this.settings), this.settings.tableFields, this.width);
    if (table.items.length !== rows.length) throw new Error('TUI tree/table row mismatch');
    const next = new Set(rows.map(row => row.agent.id));
    const at = performance.now();
    if (this.readyMs === undefined && this.session.status.startsWith('connected')) this.readyMs = at - this.started;
    const lag = (id: string, kind: string, target: Samples) => {
      const event = this.pending.get(id);
      if (event?.type === kind) {
        target.add(Math.max(0, Date.now() - event.serverTime));
        this.deliveryToRender.add(at - event.received);
        this.pending.delete(id);
      }
    };
    for (const id of next) if (!this.visible.has(id)) { this.added++; lag(id, 'agent.created', this.addLag); }
    for (const id of this.visible) if (!next.has(id)) { this.removed++; lag(id, 'agent.removed', this.removeLag); }
    this.coalesced += this.pending.size;
    this.pending.clear();
    this.visible = next;
    this.frames++;
    this.renderMs.add(performance.now() - began);
  }
  start() {
    let expected = performance.now() + 25;
    this.heartbeat = setInterval(() => {
      const now = performance.now();
      this.eventLoopLag.add(Math.max(0, now - expected));
      expected = now + 25;
    }, 25);
    this.running = this.session.run().catch(error => { this.lastError = String(error); });
  }
  report() {
    return {
      time: new Date().toISOString(), elapsedMs: performance.now() - this.started,
      scope: 'headless Session + Store + renderTable; no terminal paint or history replay',
      runtime: { bun: Bun.version, width: this.width, frameMs: this.frameMs },
      status: this.session.status, readyMs: this.readyMs, frames: this.frames, visibleRows: this.visible.size,
      rowsAdded: this.added, rowsRemoved: this.removed, receivedCreates: this.receivedAdds, receivedRemoves: this.receivedRemoves,
      coalescedRowChanges: this.coalesced, disconnects: this.disconnects, lastNotice: this.lastError,
      distributionsMs: { render: this.renderMs.json(), addEventToRender: this.addLag.json(), removeEventToRender: this.removeLag.json(), receivedEventToRender: this.deliveryToRender.json(), eventLoopLag: this.eventLoopLag.json() },
    };
  }
  async close() {
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.render();
    this.session.close();
    await this.running;
  }
}
