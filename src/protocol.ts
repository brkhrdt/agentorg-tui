import { EventEmitter } from 'node:events';
import { createConnection, type Socket } from 'node:net';

export interface Agent {
  id: string;
  parentId: string | null;
  name: string;
  state: string;
  settings: { model?: string; harness: string; extensions?: Record<string, unknown>; [key: string]: unknown };
  revision: number;
  generation: string | null;
  removedAt: string | null;
  [key: string]: unknown;
}
export interface Operation {
  id: string;
  agentId: string | null;
  type: string;
  status: string;
  input: unknown;
  result?: unknown;
  error?: { code: string; message: string };
  [key: string]: unknown;
}
export interface ServerEvent {
  kind: 'event';
  seq: number;
  time: string;
  type: string;
  agentId?: string;
  generation?: string;
  data: unknown;
}
export interface ExtendedDiff { prefix: string; before: string; after: string }
export interface EventRendering { rendererId: string; subtype?: string; canonicalTool?: string; updateMode?: 'semantic' | 'streaming'; extendedLayout?: 'header-detail'; summary: string; extended: string; full: string; extendedDiff?: ExtendedDiff }
export interface RendererMetadata {
  id: string; name: string; harness?: string; eventTypes: string[]; tool?: string; aliases?: string[]; aliasExamples?: Record<string, Array<{ type: string; summary: string; extended: string; full: string; raw: string; subtype?: string; extendedDiff?: ExtendedDiff }>>; updateMode?: 'semantic' | 'streaming'; extendedLayout?: 'header-detail';
  examples: Array<{ type: string; summary: string; extended: string; full: string; raw: string; subtype?: string; extendedDiff?: ExtendedDiff }>;
}
export interface RenderingCapability { version: number; catalog: string }
const object = (value: unknown): value is Record<string, any> => value !== null && typeof value === 'object' && !Array.isArray(value);
export function validEventRendering(value: unknown): value is EventRendering {
  if (!object(value) || typeof value.rendererId !== 'string' || value.rendererId.length > 256 || !['summary','extended','full'].every(key => typeof value[key] === 'string')) return false;
  if (value.summary.length > 8192 || value.extended.length > 16384 || value.full.length > 2 * 1024 * 1024) return false;
  if (value.subtype !== undefined && typeof value.subtype !== 'string' || value.canonicalTool !== undefined && typeof value.canonicalTool !== 'string') return false;
  if (value.updateMode !== undefined && !['semantic','streaming'].includes(value.updateMode)) return false;
  if (value.extendedLayout !== undefined && value.extendedLayout !== 'header-detail') return false;
  if (value.extendedDiff !== undefined && (!object(value.extendedDiff) || !['prefix','before','after'].every(key => typeof value.extendedDiff[key] === 'string'))) return false;
  return true;
}
export function validRendererMetadata(value: unknown): value is RendererMetadata {
  if (!object(value) || typeof value.id !== 'string' || value.id.length > 256 || typeof value.name !== 'string' || value.name.length > 128 || !Array.isArray(value.eventTypes) || value.eventTypes.length < 1 || value.eventTypes.length > 64 || !value.eventTypes.every((x: unknown) => typeof x === 'string' && x.length <= 128) || !Array.isArray(value.examples) || value.examples.length < 1 || value.examples.length > 8) return false;
  if (value.tool !== undefined && typeof value.tool !== 'string' || value.harness !== undefined && typeof value.harness !== 'string') return false;
  if (value.aliases !== undefined && (!Array.isArray(value.aliases) || !value.aliases.every((x: unknown) => typeof x === 'string' && x.length <= 128))) return false;
  if (value.aliasExamples !== undefined) {
    if (!object(value.aliasExamples) || Object.keys(value.aliasExamples).some(identity => !value.aliases?.includes(identity))) return false;
    for (const [identity, examples] of Object.entries(value.aliasExamples)) if (!Array.isArray(examples) || examples.length < 1 || examples.length > 8 || !examples.every(example => object(example) && example.subtype === identity && typeof example.type === 'string' && typeof example.raw === 'string' && example.raw.length <= 2 * 1024 * 1024 && validEventRendering({ ...example, rendererId: value.id }))) return false;
  }
  if (value.updateMode !== undefined && !['semantic','streaming'].includes(value.updateMode) || value.extendedLayout !== undefined && value.extendedLayout !== 'header-detail') return false;
  return value.examples.every((example: unknown) => object(example) && typeof example.type === 'string' && typeof example.raw === 'string' && example.raw.length <= 2 * 1024 * 1024 && validEventRendering({ ...example, rendererId: value.id }));
}
export type SkillState = 'unavailable' | 'available' | 'installed';
export type SkillStates = Record<string, SkillState>;
export interface Skill { name: string; description: string; gitUrl?: string; [key: string]: unknown }
export interface SkillRetained { name: string; gitUrl?: string; description?: string; status?: string; error?: string; [key: string]: unknown }
export interface SkillReconciliation { generation?: number; desiredRevision?: number; state: 'pending' | 'running' | 'ready' | 'error'; lastSuccessfulRevision?: number; entries?: Array<{ name: string; gitUrl?: string; status: string; error?: string; attempts?: number }> }
export interface ServerSettingsField {
  key: string; label: string; description?: string; deprecated?: boolean; optional?: boolean;
  editor: 'text' | 'number' | 'boolean' | 'select' | 'list' | 'string-map' | 'object-map';
  effect: 'immediate' | 'future-launch' | 'restart'; choices?: string[]; min?: number; max?: number;
  choicesEndpoint?: string; itemFields?: ServerSettingsField[]; itemDefaults?: Record<string, unknown>; itemDefaultsFrom?: Record<string, string>; itemIdKey?: string; itemLabelKey?: string;
}
export interface SettingsChoice {
  value: string; label: string;
  /** Public form defaults for a newly selected record-map key. */
  defaults?: Record<string, unknown>;
  /** Explicit client-only setup needed before this resource can be selected. */
  setup?: { endpoint: string; params: Record<string, unknown>; inputKey: string; label: string };
}
export interface AgentProfile {
  id: string; name: string; harness: string; revision?: number; provider?: string; model?: string; options: Record<string, unknown>;
}
export interface ContainerGrantDefaults { readOnlyDirs: string[]; readWriteDirs: string[]; readOnlyVolumes: string[]; readWriteVolumes: string[] }
export interface ContainerProfile {
  id: string; name: string; image: string; network: 'pasta' | 'slirp4netns' | 'none'; containerUid: number; containerGid: number; env: string[];
  cwd: string;
  readOnlyDirs: string[]; readWriteDirs: string[]; readOnlyVolumes: string[]; readWriteVolumes: string[];
}
export interface ServerSettingsDescriptor { namespace: string; title: string; plugin?: string; description?: string; version: number; fields: ServerSettingsField[] }
export interface ServerSettingsGroup extends ServerSettingsDescriptor {
  revision: number; defaults: Record<string, unknown>; values: Record<string, unknown>; effective: Record<string, unknown>; overridden: string[]; restartRequired: string[];
  reconciliation?: SkillReconciliation;
}
export interface ServerSettingsCatalog { groups: ServerSettingsGroup[]; facts: { cwd: string; dataDir: string; socketPath: string; harnesses: string[]; plugins: string[] } }
export interface ServerSettingsCapability { version: number; groups: ServerSettingsDescriptor[]; endpoints: { list: string; get: string; update: string } }
export interface Snapshot { seq: number; agents: Agent[]; operations: Operation[]; capabilities?: { rendering?: RenderingCapability; cwd?: string; pathCompletion?: boolean; harnesses?: string[]; modelDiscovery?: string[]; settingsEditors?: Record<string, unknown>; plugins?: Record<string, unknown>; serverSettings?: ServerSettingsCapability; loadedPlugins?: string[] } }
export interface HistoryPage {
  events: ServerEvent[];
  renderings?: Record<string, EventRendering>;
  oldestSeq: number;
  latestSeq: number;
  expired: boolean;
  hasMore?: boolean;
}
export class ApiError extends Error {
  constructor(public code: string, message: string) { super(`${code}: ${message}`); }
}

interface Pending {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Independent JSONL response/event dispatch. No server imports or mutation retries. */
export class RpcClient extends EventEmitter {
  private socket?: Socket;
  private pending = new Map<string, Pending>();
  private nextId = 0;
  private buffer = '';
  private writes: Promise<void> = Promise.resolve();
  private ended = false;
  constructor(public readonly path: string, private readonly maxReceiveBytes = 16 * 1024 * 1024) {
    super();
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = this.socket = createConnection(this.path);
      socket.setEncoding('utf8'); // Node's decoder preserves split multibyte characters.
      socket.once('connect', resolve);
      socket.once('error', reject);
      socket.on('error', error => this.emit('diagnostic', error.message));
      socket.on('data', data => this.receive(String(data)));
      socket.on('close', () => {
        this.ended = true;
        for (const pending of this.pending.values()) {
          clearTimeout(pending.timer);
          pending.reject(new Error('Connection lost; request outcome unknown. Not retried.'));
        }
        this.pending.clear();
        this.emit('disconnect');
      });
    });
  }

  request<T>(method: string, params: unknown = {}, timeoutMs = 15_000): Promise<T> {
    if (!this.socket || this.ended || this.socket.destroyed) return Promise.reject(new Error('Not connected'));
    if (this.pending.size >= 128) return Promise.reject(new Error('Too many in-flight requests'));
    const id = String(++this.nextId);
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method}: response timeout; outcome unknown. Not retried.`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      const line = JSON.stringify({ id, method, params }) + '\n';
      const write = this.writes.then(() => {
        // A timed-out request still in the write queue must not be sent later.
        if (!this.pending.has(id)) return;
        return new Promise<void>((done, fail) => {
          if (!this.socket || this.socket.destroyed) return fail(new Error('Connection closed'));
          this.socket.write(line, error => error ? fail(error) : done());
        });
      });
      this.writes = write.catch(() => {});
      void write.catch(error => {
        const pending = this.pending.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(id);
        pending.reject(error);
      });
    });
  }

  private receive(chunk: string): void {
    this.buffer += chunk;
    let newline: number;
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline).replace(/\r$/, '');
      this.buffer = this.buffer.slice(newline + 1);
      if (Buffer.byteLength(line) > this.maxReceiveBytes) return this.protocolFailure('Receive frame too large');
      if (!line) continue;
      try {
        const frame = JSON.parse(line);
        if (frame.kind === 'event' && Number.isSafeInteger(frame.seq) && typeof frame.type === 'string') {
          this.emit('event', frame as ServerEvent);
        } else if (frame.kind === 'presentation') {
          if (Number.isSafeInteger(frame.seq) && validEventRendering(frame.rendering)) this.emit('presentation', frame.seq, frame.rendering as EventRendering);
          else this.emit('diagnostic', 'Ignored malformed presentation sidecar');
        } else if (frame.kind === 'response') {
          if (frame.id === null) {
            this.emit('diagnostic', `${frame.error?.code ?? 'PROTOCOL'}: ${frame.error?.message ?? 'Uncorrelated response'}`);
            continue;
          }
          const pending = this.pending.get(frame.id);
          if (!pending) continue;
          this.pending.delete(frame.id);
          clearTimeout(pending.timer);
          if (frame.ok) pending.resolve(frame.result);
          else pending.reject(new ApiError(frame.error?.code ?? 'UNKNOWN', frame.error?.message ?? 'Request failed'));
        } else {
          return this.protocolFailure('Invalid wire envelope');
        }
      } catch { return this.protocolFailure('Invalid JSON frame'); }
    }
    if (Buffer.byteLength(this.buffer) > this.maxReceiveBytes) this.protocolFailure('Receive frame too large');
  }
  private protocolFailure(message: string): void {
    this.emit('diagnostic', message);
    this.close();
  }
  close(): void { this.socket?.destroy(); }
}
