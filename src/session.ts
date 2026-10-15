import { EventEmitter } from 'node:events';
import { ApiError, RpcClient, type HistoryPage, type Operation, type ServerEvent, type Snapshot, type Skill, type SkillStates, type ServerSettingsCapability, type ServerSettingsCatalog, type ServerSettingsGroup, type ContainerProfile, type SettingsChoice, type ContainerGrantDefaults } from './protocol.js';
import { Store } from './store.js';
import type { ImageScope } from './agent-editor.js';
import { pluginFields, type PluginField } from './structured-editor.js';
import type { PathCompletion } from './path-input.js';
import type { VolumeChoice } from './volume-input.js';

export type LifecycleMethod = 'agent.create' | 'agent.modify' | 'agent.stop' | 'agent.restart' | 'agent.restart_subtree' | 'agent.replace_session' | 'agent.remove';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const done = (operation: Operation) => ['completed', 'failed', 'stopped'].includes(operation.status);

export class Session extends EventEmitter {
  readonly store = new Store();
  status = 'connecting';
  skillsEnabled = false;
  skills: Skill[] = [];
  harnesses: string[] = [];
  modelDiscovery: string[] = [];
  serverCwd = '';
  pathCompletion = false;
  podmanEnabled = false;
  settingsFields: PluginField[] = [];
  serverSettingsCapability?: ServerSettingsCapability;
  serverSettingsCatalog?: ServerSettingsCatalog;
  private installServerSettings(catalog: ServerSettingsCatalog): void {
    const previous = this.serverSettingsCatalog;
    this.serverSettingsCatalog = { ...catalog, groups: catalog.groups.map(group => {
      const current = previous?.groups.find(g => g.namespace === group.namespace);
      return current && current.revision > group.revision ? current : group;
    }) };
  }
  async loadServerSettings(): Promise<ServerSettingsCatalog> {
    const client = this.client, capability = this.serverSettingsCapability;
    if (!client || !this.status.startsWith('connected') || !capability) throw new Error('Server settings are not available');
    const catalog = await client.request<ServerSettingsCatalog>(capability.endpoints.list, {});
    if (client !== this.client || this.stopped) throw new Error('Server disconnected');
    this.installServerSettings(catalog);
    this.store.emit('change');
    return this.serverSettingsCatalog!;
  }
  async updateServerSettings(params: { namespace: string; expectedRevision: number; patch: Record<string, unknown>; reset: string[] }): Promise<ServerSettingsGroup> {
    const client = this.client, capability = this.serverSettingsCapability;
    if (!client || !this.status.startsWith('connected') || !capability) throw new Error('Server settings are not available');
    const group = await client.request<ServerSettingsGroup>(capability.endpoints.update, params, 60_000);
    if (client !== this.client || this.stopped) throw new Error('Server disconnected after saving; refresh before retrying');
    if (this.serverSettingsCatalog) this.serverSettingsCatalog.groups = this.serverSettingsCatalog.groups.map(g => g.namespace === group.namespace && g.revision <= group.revision ? group : g);
    this.store.emit('change');
    return group;
  }
  private podmanProfiles = '';
  private podmanImages = '';
  private podmanDefaults = '';
  get podmanDefaultsEnabled(): boolean { return !!this.podmanDefaults; }
  async containerGrantDefaults(): Promise<ContainerGrantDefaults> {
    const client = this.client;
    if (!client || !this.status.startsWith('connected') || !this.podmanDefaults) throw new Error('Container defaults are not available');
    const result = await client.request<ContainerGrantDefaults>(this.podmanDefaults, {});
    if (client !== this.client || this.stopped) throw new Error('Server disconnected; reopen the agent draft');
    for (const key of ['readOnlyDirs', 'readWriteDirs', 'readOnlyVolumes', 'readWriteVolumes'] as const)
      if (!Array.isArray(result[key]) || result[key].some(value => typeof value !== 'string')) throw new Error('Invalid container grant defaults');
    return result;
  }
  get podmanProfilesEnabled(): boolean { return !!this.podmanProfiles; }
  get podmanImagesEnabled(): boolean { return !!this.podmanImages; }
  async listProfiles(): Promise<{ revision: number; profiles: ContainerProfile[] }> {
    if (!this.client || !this.status.startsWith('connected') || !this.podmanProfiles) throw new Error('Container configurations are not available');
    const client = this.client;
    const result = await client.request<{ revision: number; profiles: ContainerProfile[] }>(this.podmanProfiles, {});
    if (client !== this.client || this.stopped) throw new Error('Server disconnected; reload configurations');
    return result;
  }
  async settingsChoices(endpoint: string): Promise<SettingsChoice[]> {
    if (!this.client || !this.status.startsWith('connected')) throw new Error('Server is not connected');
    const client = this.client;
    const result = await client.request<{ choices: SettingsChoice[] }>(endpoint, {}, 30_000);
    if (client !== this.client || this.stopped) throw new Error('Server disconnected; reload options');
    if (!Array.isArray(result.choices) || result.choices.some(c => typeof c.value !== 'string' || typeof c.label !== 'string' ||
      (c.defaults !== undefined && (!c.defaults || typeof c.defaults !== 'object' || Array.isArray(c.defaults))) ||
      (c.setup && (!/^[a-z][a-z0-9.-]*$/.test(c.setup.endpoint) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(c.setup.inputKey) || ['__proto__', 'constructor', 'prototype'].includes(c.setup.inputKey) || typeof c.setup.label !== 'string' || !c.setup.params || typeof c.setup.params !== 'object' || Array.isArray(c.setup.params))))) throw new Error('Invalid option catalog');
    return result.choices;
  }
  async setupChoice(setup: NonNullable<SettingsChoice['setup']>, value: string): Promise<void> {
    if (!this.client || !this.status.startsWith('connected')) throw new Error('Server is not connected');
    await this.client.request(setup.endpoint, { ...setup.params, [setup.inputKey]: value }, 30_000);
  }
  async listImages() { return this.settingsChoices(this.podmanImages); }
  private podmanModify = '';
  private podmanVolumes = '';
  private podmanConfigureVolume = '';
  async configureVolume(name: string, destination: string): Promise<VolumeChoice> {
    if (!this.client || !this.status.startsWith('connected') || !this.podmanConfigureVolume) throw new Error('Server volume destination configuration is not available');
    return this.client.request<VolumeChoice>(this.podmanConfigureVolume, { name, destination });
  }
  get podmanVolumesEnabled(): boolean { return !!this.podmanVolumes; }
  async listVolumes(): Promise<VolumeChoice[]> {
    if (!this.client || !this.status.startsWith('connected') || !this.podmanVolumes) throw new Error('Server volume discovery is not available');
    const result = await this.client.request<{ volumes: VolumeChoice[] }>(this.podmanVolumes, {});
    return result.volumes;
  }
  async completePath(input: string, base: string, kind: 'directory' | 'any' = 'directory', create = false): Promise<PathCompletion> {
    if (!this.client || !this.status.startsWith('connected')) throw new Error('Server is not connected');
    return this.client.request<PathCompletion>('organization.paths', { input, base, kind, limit: 5, ...(create && { create: true }) });
  }
  async agentChoices(field: 'provider' | 'model', values: Record<string, string>): Promise<{ value: string; label: string }[]> {
    const client = this.client;
    if (!client || !this.status.startsWith('connected')) throw new Error('Server is not connected');
    if (field === 'model' && !values.provider?.trim()) throw new Error('Select a provider before choosing a model.');
    const params = {
      harness: values.harness,
      ...(field === 'model' && { provider: values.provider }),
      ...(values.cwd?.trim() && { cwd: values.cwd.trim() }),
      env: JSON.parse(values.env || '{}'), options: JSON.parse(values.options || '{}'),
    };
    if (field === 'provider') {
      const result = await client.request<{ providers: string[] }>('organization.providers', params);
      return result.providers.map(value => ({ value, label: value }));
    }
    const result = await client.request<{ models: { id: string; name?: string }[] }>('organization.models', params);
    return result.models.map(model => ({ value: model.id, label: model.name && model.name !== model.id ? `${model.id} · ${model.name}` : model.id }));
  }
  private skillsNamespace = 'skills';
  private skillsList = '';
  private skillsAdd = '';
  skillStates(agentId: string): SkillStates {
    return (this.store.agents.get(agentId)?.settings.extensions?.[this.skillsNamespace] ?? {}) as SkillStates;
  }
  private async loadSkills(client: RpcClient, snapshot: Snapshot): Promise<void> {
    this.settingsFields = pluginFields(snapshot.capabilities?.settingsEditors);
    const serverSettings = snapshot.capabilities?.serverSettings;
    this.serverSettingsCapability = serverSettings?.version === 1 && ['list', 'get', 'update'].every(key => typeof serverSettings.endpoints?.[key as keyof typeof serverSettings.endpoints] === 'string') ? serverSettings : undefined;
    if (!this.serverSettingsCapability) this.serverSettingsCatalog = undefined;
    else if (this.serverSettingsCatalog) {
      const catalog = await client.request<ServerSettingsCatalog>(this.serverSettingsCapability.endpoints.list, {});
      if (client === this.client && !this.stopped) this.installServerSettings(catalog);
    }
    this.serverCwd = snapshot.capabilities?.cwd ?? '';
    this.pathCompletion = snapshot.capabilities?.pathCompletion === true;
    this.harnesses = [...new Set((snapshot.capabilities?.harnesses ?? []).filter((name): name is string => typeof name === 'string' && name.length > 0))].sort();
    this.modelDiscovery = snapshot.capabilities?.modelDiscovery ?? [];
    const podman = snapshot.capabilities?.plugins?.podman as { endpoints?: { modify?: string; volumes?: string; configureVolume?: string; profiles?: string; images?: string; defaults?: string }; modelDiscovery?: boolean } | undefined;
    this.podmanEnabled = typeof podman?.endpoints?.modify === 'string';
    this.podmanModify = podman?.endpoints?.modify ?? '';
    this.podmanVolumes = podman?.endpoints?.volumes ?? '';
    this.podmanConfigureVolume = podman?.endpoints?.configureVolume ?? '';
    this.podmanProfiles = podman?.endpoints?.profiles ?? '';
    this.podmanImages = podman?.endpoints?.images ?? '';
    this.podmanDefaults = podman?.endpoints?.defaults ?? '';
    if (this.podmanEnabled && podman?.modelDiscovery !== true) this.modelDiscovery = [];
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
          if (event.type === 'skills.catalog_added' || event.type === 'organization.settings.changed') this.scheduleRefresh();
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
          this.serverSettingsCatalog = undefined;
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
  async modifyPodman(params: Record<string, unknown>, imageScope: ImageScope): Promise<void> {
    const client = this.client;
    if (!client || !this.status.startsWith('connected') || !this.podmanEnabled) throw new Error('Podman plugin is not connected');
    try {
      const result = await client.request<{ operations: Operation[]; errors: { agentId: string; message: string }[] }>(this.podmanModify, { ...params, imageScope }, 120_000);
      for (const operation of result.operations) this.store.putOperation(operation);
      if (result.errors.length) throw new Error(`Image change partially applied: ${result.errors.map(e => `${e.agentId}: ${e.message}`).join('; ')}`);
      await this.refresh();
    } finally { this.scheduleRefresh(); }
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
