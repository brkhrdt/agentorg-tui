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
export type SkillState = 'unavailable' | 'available' | 'installed';
export type SkillStates = Record<string, SkillState>;
export interface Skill { name: string; description: string; gitUrl: string; [key: string]: unknown }
export interface ServerSettingsField {
  key: string; label: string; description?: string; deprecated?: boolean;
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
export interface ContainerGrantDefaults { readOnlyDirs: string[]; readWriteDirs: string[]; readOnlyVolumes: string[]; readWriteVolumes: string[] }
export interface ContainerProfile {
  id: string; name: string; image: string; network: 'pasta' | 'slirp4netns' | 'none'; containerUid: number; containerGid: number; env: string[];
  cwd: string;
  readOnlyDirs: string[]; readWriteDirs: string[]; readOnlyVolumes: string[]; readWriteVolumes: string[];
}
export interface ServerSettingsDescriptor { namespace: string; title: string; plugin?: string; description?: string; version: number; fields: ServerSettingsField[] }
export interface ServerSettingsGroup extends ServerSettingsDescriptor {
  revision: number; defaults: Record<string, unknown>; values: Record<string, unknown>; effective: Record<string, unknown>; overridden: string[]; restartRequired: string[];
}
export interface ServerSettingsCatalog { groups: ServerSettingsGroup[]; facts: { cwd: string; dataDir: string; socketPath: string; harnesses: string[]; plugins: string[] } }
export interface ServerSettingsCapability { version: number; groups: ServerSettingsDescriptor[]; endpoints: { list: string; get: string; update: string } }
export interface Snapshot { seq: number; agents: Agent[]; operations: Operation[]; capabilities?: { cwd?: string; pathCompletion?: boolean; harnesses?: string[]; modelDiscovery?: string[]; settingsEditors?: Record<string, unknown>; plugins?: Record<string, unknown>; serverSettings?: ServerSettingsCapability; loadedPlugins?: string[] } }
export interface HistoryPage {
  events: ServerEvent[];
  oldestSeq: number;
  latestSeq: number;
  expired: boolean;
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
