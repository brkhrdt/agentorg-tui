import { EventEmitter } from 'node:events';
import { ApiError, RpcClient, type HistoryPage, type Operation, type ServerEvent, type Snapshot, type AgentProfile, type Skill, type ServerSettingsCapability, type ServerSettingsCatalog, type ServerSettingsGroup, type ContainerProfile, type SettingsChoice, type SkillReconciliation, type SkillRetained, type ContainerGrantDefaults, type EventRendering, type RendererMetadata, type RenderingCapability } from './protocol.js';
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
  skillCatalog: Skill[] = [];
  retainedSkills: SkillRetained[] = [];
  skillReconciliation?: SkillReconciliation;
  private skillsReconcileEndpoint?: string;
  private skillsListEndpoint?: string;
  get skillsReconcileEndpointAvailable(): boolean { return !!this.skillsReconcileEndpoint; }
  harnesses: string[] = [];
  modelDiscovery: string[] = [];
  private agentProfileEndpoints = new Map<string, string>();
  get agentProfilesEnabled(): boolean { return this.agentProfileEndpoints.size > 0; }
  async listAgentProfiles(harness?: string): Promise<AgentProfile[]> {
    const client = this.client;
    if (!client || !this.status.startsWith('connected')) throw new Error('Server is not connected');
    const catalogs = await Promise.all((harness ? [harness] : this.harnesses).map(async name => {
      const endpoint = this.agentProfileEndpoints.get(name);
      if (!endpoint) return [{ id: 'default', name: 'Default', harness: name, options: {} }];
      const result = await client.request<{ profiles: AgentProfile[] }>(endpoint, {});
      if (!Array.isArray(result.profiles) || result.profiles.some(p => p.harness !== name || typeof p.id !== 'string' || typeof p.name !== 'string' || !p.options || typeof p.options !== 'object' || Array.isArray(p.options))) throw new Error('Invalid agent profiles');
      return result.profiles;
    }));
    if (client !== this.client || this.stopped) throw new Error('Server disconnected; reload agent profiles');
    return catalogs.flat();
  }
  serverCwd = '';
  pathCompletion = false;
  podmanEnabled = false;
  settingsFields: PluginField[] = [];
  serverSettingsCapability?: ServerSettingsCapability;
  renderingCapability?: RenderingCapability;
  renderers: RendererMetadata[] = [];
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
  skillsNamespace = 'skills';
  private skillsRequest = 0;
  private async loadSkills(client: RpcClient, snapshot: Snapshot): Promise<void> {
    const skillsRequest = ++this.skillsRequest;
    this.settingsFields = pluginFields(snapshot.capabilities?.settingsEditors);
    const rendering = snapshot.capabilities?.rendering;
    this.renderingCapability = rendering?.version === 1 && typeof rendering.catalog === 'string' ? rendering : undefined;
    this.renderers = [];
    if (this.renderingCapability) {
      const catalog = await client.request<{ version: number; renderers: RendererMetadata[] }>(this.renderingCapability.catalog, {});
      if (client === this.client && !this.stopped && skillsRequest === this.skillsRequest && catalog.version === 1) this.renderers = catalog.renderers;
    }
    const serverSettings = snapshot.capabilities?.serverSettings;
    this.serverSettingsCapability = serverSettings?.version === 1 && ['list', 'get', 'update'].every(key => typeof serverSettings.endpoints?.[key as keyof typeof serverSettings.endpoints] === 'string') ? serverSettings : undefined;
    if (!this.serverSettingsCapability) this.serverSettingsCatalog = undefined;
    else if (this.serverSettingsCatalog) {
      const catalog = await client.request<ServerSettingsCatalog>(this.serverSettingsCapability.endpoints.list, {});
      if (client === this.client && !this.stopped && skillsRequest === this.skillsRequest) this.installServerSettings(catalog);
    }
    this.serverCwd = snapshot.capabilities?.cwd ?? '';
    this.pathCompletion = snapshot.capabilities?.pathCompletion === true;
    this.harnesses = [...new Set((snapshot.capabilities?.harnesses ?? []).filter((name): name is string => typeof name === 'string' && name.length > 0))].sort();
    this.modelDiscovery = snapshot.capabilities?.modelDiscovery ?? [];
    this.agentProfileEndpoints.clear();
    for (const name of this.harnesses) {
      const plugin = snapshot.capabilities?.plugins?.[name] as { endpoints?: { profiles?: unknown } } | undefined;
      if (typeof plugin?.endpoints?.profiles === 'string') this.agentProfileEndpoints.set(name, plugin.endpoints.profiles);
    }
    const podman = snapshot.capabilities?.plugins?.podman as { endpoints?: { modify?: string; volumes?: string; configureVolume?: string; profiles?: string; images?: string; defaults?: string }; modelDiscovery?: boolean } | undefined;
    this.podmanEnabled = typeof podman?.endpoints?.modify === 'string';
    this.podmanModify = podman?.endpoints?.modify ?? '';
    this.podmanVolumes = podman?.endpoints?.volumes ?? '';
    this.podmanConfigureVolume = podman?.endpoints?.configureVolume ?? '';
    this.podmanProfiles = podman?.endpoints?.profiles ?? '';
    this.podmanImages = podman?.endpoints?.images ?? '';
    this.podmanDefaults = podman?.endpoints?.defaults ?? '';
    if (this.podmanEnabled && podman?.modelDiscovery !== true) this.modelDiscovery = [];
    const capability = snapshot.capabilities?.plugins?.skills as { version?: unknown; settingsNamespace?: unknown; endpoints?: { list?: unknown; reconcile?: unknown } } | undefined;
    const namespace = capability?.settingsNamespace;
    const list = capability?.endpoints?.list;
    const supported = (capability?.version === undefined || capability.version === 1) && typeof namespace === 'string' && /^[a-z][a-z0-9.-]*$/.test(namespace) && typeof list === 'string' && /^[a-z][a-z0-9.-]*$/.test(list);
    if (!supported) {
      if (client === this.client && !this.stopped && skillsRequest === this.skillsRequest) {
        this.skillsEnabled = false; this.skillsNamespace = 'skills'; this.skillCatalog = []; this.retainedSkills = []; this.skillReconciliation = undefined; this.skillsReconcileEndpoint = undefined; this.skillsListEndpoint = undefined;
      }
      return;
    }
    if (client !== this.client || this.stopped || skillsRequest !== this.skillsRequest) return;
    const endpoint = list as string;
    const reconcileEndpoint = typeof capability?.endpoints?.reconcile === 'string' && /^[a-z][a-z0-9.-]*$/.test(capability.endpoints.reconcile) ? capability.endpoints.reconcile : undefined;
    this.skillsListEndpoint = endpoint;
    this.skillsReconcileEndpoint = reconcileEndpoint;
    await this.refreshSkillCatalog(client, endpoint, namespace as string, skillsRequest);
  }
  private async refreshSkillCatalog(client: RpcClient, endpoint: string, namespace = this.skillsNamespace, request = ++this.skillsRequest): Promise<void> {
    let catalog: { skills?: unknown; retained?: unknown; reconciliation?: unknown };
    try { catalog = await client.request<{ skills?: unknown; retained?: unknown; reconciliation?: unknown }>(endpoint, {}); }
    catch (error) {
      if (client === this.client && !this.stopped && request === this.skillsRequest) {
        this.skillsEnabled = true; this.skillsNamespace = namespace; this.skillCatalog = [];
        this.emit('notice', `Skills catalog unavailable: ${(error as Error).message}`);
      }
      return;
    }
    if (client !== this.client || this.stopped || request !== this.skillsRequest) return;
    const catalogSkills = catalog && typeof catalog === 'object' && Array.isArray(catalog.skills) ? catalog.skills as unknown[] : undefined;
    const validSkills = catalogSkills?.filter((skill): skill is Skill => !!skill && typeof skill === 'object' &&
      typeof (skill as Skill).name === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test((skill as Skill).name) &&
      typeof (skill as Skill).description === 'string') ?? [];
    const entries = validSkills.filter(skill => skill.status === undefined || skill.status === 'ready');
    this.skillsEnabled = true; this.skillsNamespace = namespace;
    this.skillCatalog = entries;
    this.retainedSkills = Array.isArray(catalog?.retained) ? catalog.retained.filter((item): item is SkillRetained => !!item && typeof item === 'object' && typeof (item as SkillRetained).name === 'string') : [];
    const reconciliation = catalog?.reconciliation;
    this.skillReconciliation = reconciliation && typeof reconciliation === 'object' && ['pending', 'running', 'ready', 'error'].includes((reconciliation as SkillReconciliation).state)
      ? reconciliation as SkillReconciliation : undefined;
    if (catalogSkills === undefined || validSkills.length !== catalogSkills.length)
      this.emit('notice', 'Skills catalog response was invalid; malformed entries were ignored.');
    this.store.emit('change');
  }
  async refreshSkills(): Promise<void> {
    const client = this.client, list = this.skillsListEndpoint;
    if (!client || !this.skillsEnabled || !this.status.startsWith('connected') || !list) throw new Error('Skills catalog is not available');
    await this.refreshSkillCatalog(client, list, this.skillsNamespace);
  }
  async reconcileSkills(): Promise<void> {
    const client = this.client, endpoint = this.skillsReconcileEndpoint;
    if (!client || !endpoint || !this.status.startsWith('connected')) throw new Error('Skills reconciliation is not available');
    await client.request(endpoint, {});
    if (client !== this.client || this.stopped) throw new Error('Server disconnected after retry request');
    await this.refreshSkills();
  }
  private client?: RpcClient;
  private stopped = false;
  private refreshTimer?: ReturnType<typeof setTimeout>;
  private refreshing = false;
  private refreshAgain = false;
  private refreshSkillsOnRefresh = true;
  constructor(readonly socketPath: string, private readonly options: { replayHistory?: boolean } = {}) {
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
      const presentations = new Map<number, EventRendering>();
      client.on('event', (event: ServerEvent) => {
        this.emit('event', event);
        if (buffering) buffered.push(event);
        else {
          this.store.ingest(event);
          if (event.type === 'skills.catalog_added' || event.type === 'organization.settings.changed') {
            this.scheduleRefresh();
          }
          if (event.type === 'skills.catalog_changed' || event.type === 'skills.reconciliation_changed') {
            void this.refreshSkills().catch(error => this.emit('notice', `Skills refresh failed: ${(error as Error).message}`));
          }
        }
      });
      client.on('presentation', (seq: number, rendering: EventRendering) => {
        if (buffering) presentations.set(seq, rendering);
        else this.store.present(seq, rendering);
      });
      client.on('diagnostic', (message: string) => this.emit('notice', message));
      const closed = new Promise<void>(resolve => client.once('disconnect', resolve));
      let poll: ReturnType<typeof setInterval> | undefined;
      try {
        this.setStatus('connecting');
        await client.connect();
        let snapshot: Snapshot | undefined;
        for (let attempt = 0; !snapshot && attempt < 12 && !this.stopped; attempt++) {
          try { snapshot = await client.request<Snapshot>('organization.snapshot', { includeTerminalOperations: false }); }
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
        if (this.renderingCapability) await client.request('subscribe', { renderings: true });
        this.store.install(snapshot);
        for (const [seq, rendering] of presentations) this.store.present(seq, rendering);
        buffered.sort((a, b) => a.seq - b.seq).forEach(event => this.store.ingest(event));
        buffering = false;
        if (buffered.some(event => event.type === 'skills.catalog_changed' || event.type === 'skills.reconciliation_changed'))
          void this.refreshSkills().catch(error => this.emit('notice', `Skills refresh failed: ${(error as Error).message}`));
        delay = 250;
        if (this.options.replayHistory !== false) {
          this.setStatus('connected · loading history');
          // Keep the UI live during history download, with a fixed replay target.
          await this.replay(client, snapshot.seq);
        } else this.store.historyCursor = snapshot.seq;
        this.setStatus('connected');
        poll = setInterval(() => {
          const pending = this.skillReconciliation?.state === 'pending' || this.skillReconciliation?.state === 'running';
          if (pending) void this.refreshSkills().catch(error => this.emit('notice', `Skills refresh failed: ${(error as Error).message}`));
          this.scheduleRefresh(!pending);
        }, 10_000);
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
      const page = await client.request<HistoryPage>('events.history', { after: this.store.historyCursor, limit: 100, ...(this.renderingCapability && { renderings: true }) });
      if (page.expired && !this.store.historyGap) {
        this.store.historyGap = true;
        this.emit('notice', 'History retention gap: earlier chat is unavailable.');
        this.scheduleRefresh();
      }
      for (const [seq, rendering] of Object.entries(page.renderings ?? {})) this.store.present(Number(seq), rendering);
      for (const event of page.events) this.store.ingest(event);
      if (!page.events.length) { this.store.historyCursor = target; break; }
      this.store.historyCursor = page.events[page.events.length - 1]!.seq;
    }
    this.store.emit('change');
  }
  private scheduleRefresh(refreshSkills = true): void {
    if (this.stopped) return;
    this.refreshSkillsOnRefresh ||= refreshSkills;
    if (this.refreshTimer) return;
    if (this.refreshing) { this.refreshAgain = true; return; }
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      const includeSkills = this.refreshSkillsOnRefresh;
      this.refreshSkillsOnRefresh = false;
      void this.refresh(includeSkills);
    }, 150);
  }
  private async refresh(includeSkills = true): Promise<void> {
    const client = this.client;
    if (!client || this.stopped) return;
    this.refreshing = true;
    try {
      const snapshot = await client.request<Snapshot>('organization.snapshot', { includeTerminalOperations: false });
      if (client !== this.client || this.stopped) return;
      if (includeSkills) await this.loadSkills(client, snapshot);
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
