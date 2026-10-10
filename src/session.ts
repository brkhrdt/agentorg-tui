import { EventEmitter } from 'node:events';
import { ApiError, RpcClient, type HistoryPage, type Operation, type ServerEvent, type Snapshot, type Skill, type SkillStates } from './protocol.js';
import { Store } from './store.js';

export type LifecycleMethod = 'agent.create' | 'agent.modify' | 'agent.stop' | 'agent.restart' | 'agent.restart_subtree' | 'agent.replace_session' | 'agent.remove';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const done = (operation: Operation) => ['completed', 'failed', 'stopped'].includes(operation.status);

export class Session extends EventEmitter {
  readonly store = new Store();
  status = 'connecting';
  skillsEnabled = false;
  skills: Skill[] = [];
  private skillsNamespace = 'skills';
  private skillsList = '';
  private skillsAdd = '';
  skillStates(agentId: string): SkillStates {
    return (this.store.agents.get(agentId)?.settings.extensions?.[this.skillsNamespace] ?? {}) as SkillStates;
  }
  private async loadSkills(client: RpcClient, snapshot: Snapshot): Promise<void> {
    const capability = snapshot.capabilities?.plugins?.skills as { settingsNamespace?: unknown; endpoints?: { list?: unknown; add?: unknown } } | undefined;
    this.skillsEnabled = typeof capability?.settingsNamespace === 'string' && typeof capability?.endpoints?.list === 'string' && typeof capability?.endpoints?.add === 'string';
    if (!this.skillsEnabled) { this.skills = []; return; }
    this.skillsNamespace = capability!.settingsNamespace as string;
    this.skillsList = capability!.endpoints!.list as string;
    this.skillsAdd = capability!.endpoints!.add as string;
    const catalog = await client.request<{ skills: Skill[] }>(this.skillsList);
    if (client === this.client && !this.stopped) this.skills = catalog.skills;
  }
  private client?: RpcClient;
  private stopped = false;
  private refreshTimer?: ReturnType<typeof setTimeout>;
  private refreshing = false;
  private refreshAgain = false;
  constructor(readonly socketPath: string) {
    super();
    this.store.on('refresh', () => this.scheduleRefresh());
  }
  private setStatus(status: string): void { this.status = status; this.emit('status'); }
  async run(): Promise<void> {
    let delay = 250;
    while (!this.stopped) {
      const client = this.client = new RpcClient(this.socketPath);
      let buffering = true;
      const buffered: ServerEvent[] = [];
      client.on('event', (event: ServerEvent) => {
        if (buffering) buffered.push(event);
        else {
          this.store.ingest(event);
          if (event.type === 'skills.catalog_added') this.scheduleRefresh();
        }
      });
      client.on('diagnostic', (message: string) => this.emit('notice', message));
      const closed = new Promise<void>(resolve => client.once('disconnect', resolve));
      let poll: ReturnType<typeof setInterval> | undefined;
      try {
        this.setStatus('connecting');
        await client.connect();
        let snapshot: Snapshot | undefined;
        for (let attempt = 0; !snapshot && attempt < 12 && !this.stopped; attempt++) {
          try { snapshot = await client.request<Snapshot>('organization.snapshot'); }
          catch (error) {
            if (!(error instanceof ApiError) || error.code !== 'NOT_READY') throw error;
            this.setStatus('server starting');
            await sleep(Math.min(250 * 2 ** attempt, 2000));
          }
        }
        if (!snapshot || this.stopped) { client.close(); continue; }
        if (snapshot.seq < this.store.watermark) {
          this.store.reset();
          this.emit('notice', 'Server history changed; loaded a new organization.');
        }
        await this.loadSkills(client, snapshot);
        this.store.install(snapshot);
        buffered.sort((a, b) => a.seq - b.seq).forEach(event => this.store.ingest(event));
        buffering = false;
        this.setStatus('connected · loading history');
        delay = 250;
        // Keep the UI live during history download, with a fixed replay target.
        await this.replay(client, snapshot.seq);
        this.setStatus('connected');
        poll = setInterval(() => this.scheduleRefresh(), 10_000);
        await closed;
      } catch (error) {
        if (!this.stopped) this.emit('notice', (error as Error).message);
      } finally {
        if (poll) clearInterval(poll);
        client.close();
        if (this.client === client) this.client = undefined;
      }
      if (!this.stopped) {
        this.setStatus('disconnected · reconnecting');
        await sleep(delay + Math.random() * delay / 4);
        delay = Math.min(delay * 2, 5000);
      }
    }
  }
  private async replay(client: RpcClient, target: number): Promise<void> {
    while (!this.stopped && this.store.historyCursor < target) {
      const page = await client.request<HistoryPage>('events.history', { after: this.store.historyCursor, limit: 100 });
      if (page.expired && !this.store.historyGap) {
        this.store.historyGap = true;
        this.emit('notice', 'History retention gap: earlier chat is unavailable.');
        this.scheduleRefresh();
      }
      for (const event of page.events) this.store.ingest(event);
      if (!page.events.length) { this.store.historyCursor = target; break; }
      this.store.historyCursor = page.events[page.events.length - 1]!.seq;
    }
    this.store.emit('change');
  }
  private scheduleRefresh(): void {
    if (this.refreshTimer || this.stopped) return;
    if (this.refreshing) { this.refreshAgain = true; return; }
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      void this.refresh();
    }, 150);
  }
  private async refresh(): Promise<void> {
    const client = this.client;
    if (!client || this.stopped) return;
    this.refreshing = true;
    try {
      const snapshot = await client.request<Snapshot>('organization.snapshot');
      if (client !== this.client || this.stopped) return;
      await this.loadSkills(client, snapshot);
      if (client !== this.client || this.stopped) return;
      // A refresh can be older than already received events, which install() replays.
      this.store.install(snapshot);
    } catch (error) { this.emit('notice', (error as Error).message); }
    finally {
      this.refreshing = false;
      if (this.refreshAgain) { this.refreshAgain = false; this.scheduleRefresh(); }
    }
  }
  async prompt(agentId: string, text: string): Promise<void> {
    if (!text.trim()) return;
    const client = this.client;
    if (!client || !this.status.startsWith('connected')) throw new Error('Server is not connected');
    const operation = await client.request<Operation>('agent.prompt', { agentId, text, queue: false });
    this.store.putOperation(operation);
    this.emit('notice', `Prompt accepted · ${operation.id}`);
    void this.watch(client, operation).catch(error => this.emit('notice', error.message));
  }
  async addSkill(name: string, gitUrl: string): Promise<void> {
    const client = this.client;
    if (!client || !this.status.startsWith('connected') || !this.skillsEnabled) throw new Error('Skills plugin is not connected');
    await client.request(this.skillsAdd, { name, gitUrl }, 75_000);
    this.scheduleRefresh();
    this.emit('notice', `Added skill ${name}`);
  }
  async setSkills(agentId: string, expectedRevision: number, skills: SkillStates): Promise<void> {
    const client = this.client;
    if (!client || !this.status.startsWith('connected') || !this.skillsEnabled) throw new Error('Skills plugin is not connected');
    const accepted = await client.request<Operation>('agent.modify', { agentId, expectedRevision, settings: { extensions: { [this.skillsNamespace]: skills } } });
    this.store.putOperation(accepted);
    const operation = await this.watch(client, accepted);
    this.scheduleRefresh();
    if (!done(operation)) throw new Error('Connection lost; skill mutation outcome unknown. Not retried.');
    if (operation.status !== 'completed') throw new Error(operation.error?.message ?? `Skill mutation ${operation.status}`);
  }
  /** Mutations are submitted once; acceptance is not completion. */
  async mutate(method: LifecycleMethod, params: Record<string, unknown>): Promise<Operation> {
    const client = this.client;
    if (!client || !this.status.startsWith('connected')) throw new Error('Server is not connected');
    try {
      const accepted = await client.request<Operation>(method, params);
      this.store.putOperation(accepted);
      this.emit('notice', `${method} accepted · ${accepted.id}`);
      const operation = await this.watch(client, accepted);
      if (!done(operation)) throw new Error('Connection lost; mutation outcome unknown. Not retried.');
      if (operation.status !== 'completed') throw new Error(`${operation.error?.code ?? operation.status}: ${operation.error?.message ?? method}`);
      await this.refresh();
      return operation;
    } finally { this.scheduleRefresh(); }
  }
  private async watch(client: RpcClient, accepted: Operation): Promise<Operation> {
    let operation = this.store.operations.get(accepted.id) ?? accepted;
    while (!done(operation) && !this.stopped && client === this.client) {
      operation = await client.request<Operation>('operation.wait', { operationId: operation.id, waitMs: 1000 });
      this.store.putOperation(operation);
      operation = this.store.operations.get(operation.id)!;
    }
    if (done(operation)) {
      this.emit('notice', `${operation.type === 'agent.prompt' ? 'Prompt' : operation.type} ${operation.status}${operation.error ? ` · ${operation.error.code}: ${operation.error.message}` : ''}`);
    }
    return operation;
  }
  close(): void {
    this.stopped = true;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.client?.close();
  }
}
