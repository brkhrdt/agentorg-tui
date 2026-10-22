import { EventEmitter } from 'node:events';
import { ApiError, RpcClient, type HistoryPage, type Operation, type ServerEvent, type Snapshot, type AgentProfile, type Skill, type ServerSettingsCapability, type ServerSettingsCatalog, type ServerSettingsGroup, type ContainerProfile, type SettingsChoice, type SkillReconciliation, type SkillRetained, type ContainerGrantDefaults, type EventRendering, type RendererMetadata, type RenderingCapability, validEventRendering, validRendererMetadata } from './protocol.js';
import { Store } from './store.js';
import { DEFAULT_HISTORY, historySettings, type HistorySettings } from './settings.js';
import type { ImageScope } from './agent-editor.js';
import { pluginFields, type PluginField } from './structured-editor.js';
import type { PathCompletion } from './path-input.js';
import type { VolumeChoice } from './volume-input.js';

export type LifecycleMethod = 'agent.create' | 'agent.modify' | 'agent.stop' | 'agent.restart' | 'agent.restart_subtree' | 'agent.replace_session' | 'agent.remove';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const done = (operation: Operation) => ['completed', 'failed', 'stopped'].includes(operation.status);

interface ChatWindow {
  seqs: Set<number>; hasMore: boolean; following: boolean; valid: boolean; loading?: Promise<void>;
}

export class Session extends EventEmitter {
  readonly store = new Store();
  status = 'connecting';
  skillsEnabled = false;
  skillCatalog: Skill[] = [];
  retainedSkills: SkillRetained[] = [];
  skillReconciliation?: SkillReconciliation;
  private skillsReconcileEndpoint?: string;
  private skillsListEndpoint?: string;
  private skillsAddFromPathEndpoint?: string;
  get localSkillImportAvailable(): boolean { return !!this.skillsAddFromPathEndpoint && this.skillsEnabled; }
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
      if (client === this.client && !this.stopped && skillsRequest === this.skillsRequest && catalog?.version === 1 && Array.isArray(catalog.renderers)) this.renderers = catalog.renderers.filter(validRendererMetadata);
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
    const capability = snapshot.capabilities?.plugins?.skills as { version?: unknown; settingsNamespace?: unknown; localImport?: unknown; endpoints?: { list?: unknown; reconcile?: unknown; addFromPath?: unknown } } | undefined;
    const namespace = capability?.settingsNamespace;
    const list = capability?.endpoints?.list;
    const supported = (capability?.version === undefined || capability.version === 1) && typeof namespace === 'string' && /^[a-z][a-z0-9.-]*$/.test(namespace) && typeof list === 'string' && /^[a-z][a-z0-9.-]*$/.test(list);
    if (!supported) {
      if (client === this.client && !this.stopped && skillsRequest === this.skillsRequest) {
        this.skillsEnabled = false; this.skillsNamespace = 'skills'; this.skillCatalog = []; this.retainedSkills = []; this.skillReconciliation = undefined; this.skillsReconcileEndpoint = undefined; this.skillsListEndpoint = undefined; this.skillsAddFromPathEndpoint = undefined;
      }
      return;
    }
    if (client !== this.client || this.stopped || skillsRequest !== this.skillsRequest) return;
    const endpoint = list as string;
    const reconcileEndpoint = typeof capability?.endpoints?.reconcile === 'string' && /^[a-z][a-z0-9.-]*$/.test(capability.endpoints.reconcile) ? capability.endpoints.reconcile : undefined;
    this.skillsListEndpoint = endpoint;
    this.skillsReconcileEndpoint = reconcileEndpoint;
    this.skillsAddFromPathEndpoint = capability?.localImport === true && capability?.endpoints?.addFromPath === 'skills.addFromPath' ? 'skills.addFromPath' : undefined;
    await this.refreshSkillCatalog(client, endpoint, namespace as string, skillsRequest);
  }
  private async refreshSkillCatalog(client: RpcClient, endpoint: string, namespace = this.skillsNamespace, request = ++this.skillsRequest, throwOnFailure = false, requireCurrent = false): Promise<void> {
    let catalog: { skills?: unknown; retained?: unknown; reconciliation?: unknown };
    try { catalog = await client.request<{ skills?: unknown; retained?: unknown; reconciliation?: unknown }>(endpoint, {}); }
    catch (error) {
      if (client === this.client && !this.stopped && request === this.skillsRequest) {
        this.skillsEnabled = true; this.skillsNamespace = namespace; this.skillCatalog = [];
        if (!requireCurrent) this.emit('notice', `Skills catalog unavailable: ${(error as Error).message}`);
      }
      if (throwOnFailure) throw error;
      return;
    }
    if (client !== this.client || this.stopped || request !== this.skillsRequest) {
      if (requireCurrent) throw new Error(client !== this.client || this.stopped ? 'Server disconnected during skills catalog refresh' : 'Skills catalog refresh was superseded by a newer request');
      return;
    }
    const catalogSkills = catalog && typeof catalog === 'object' && Array.isArray(catalog.skills) ? catalog.skills as unknown[] : undefined;
    const validSkills = catalogSkills?.filter((skill): skill is Skill => !!skill && typeof skill === 'object' &&
      typeof (skill as Skill).name === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test((skill as Skill).name) &&
      typeof (skill as Skill).description === 'string') ?? [];
    const invalidCatalog = catalogSkills === undefined || validSkills.length !== catalogSkills.length;
    if (requireCurrent && invalidCatalog) throw new Error('Invalid skills catalog response');
    const entries = validSkills.filter(skill => skill.status === undefined || skill.status === 'ready');
    this.skillsEnabled = true; this.skillsNamespace = namespace;
    this.skillCatalog = entries;
    this.retainedSkills = Array.isArray(catalog?.retained) ? catalog.retained.filter((item): item is SkillRetained => !!item && typeof item === 'object' && typeof (item as SkillRetained).name === 'string') : [];
    const reconciliation = catalog?.reconciliation;
    this.skillReconciliation = reconciliation && typeof reconciliation === 'object' && ['pending', 'running', 'ready', 'error'].includes((reconciliation as SkillReconciliation).state)
      ? reconciliation as SkillReconciliation : undefined;
    if (invalidCatalog) this.emit('notice', 'Skills catalog response was invalid; malformed entries were ignored.');
    this.store.emit('change');
  }
  async importLocalSkill(path: string): Promise<void> {
    const client = this.client, endpoint = this.skillsAddFromPathEndpoint;
    if (!client || !this.skillsEnabled || !endpoint || endpoint !== 'skills.addFromPath' || !this.status.startsWith('connected')) throw new Error('Local skill import is not available');
    // Recheck the currently installed snapshot-derived capability immediately before mutation.
    const snapshot = await client.request<Snapshot>('organization.snapshot', {});
    const capability = snapshot.capabilities?.plugins?.skills as { version?: unknown; settingsNamespace?: unknown; localImport?: unknown; endpoints?: { list?: unknown; addFromPath?: unknown } } | undefined;
    if (client !== this.client || this.stopped || !this.status.startsWith('connected')) throw new Error('Server disconnected before registering skill');
    if (!capability || (capability.version !== undefined && capability.version !== 1) || typeof capability.settingsNamespace !== 'string' || !/^[a-z][a-z0-9.-]*$/.test(capability.settingsNamespace) || typeof capability.endpoints?.list !== 'string' || !/^[a-z][a-z0-9.-]*$/.test(capability.endpoints.list) || capability.localImport !== true || capability.endpoints.addFromPath !== 'skills.addFromPath' || this.skillsAddFromPathEndpoint !== 'skills.addFromPath') throw new Error('Local skill import is no longer supported by this server');
    let result: unknown;
    try { result = await client.request<unknown>(endpoint, { path }, 120_000); }
    catch (error) {
      if (error instanceof ApiError) throw new Error(`Local skill registration failed: ${error.message}`);
      throw new Error(`Local skill registration outcome is unknown (${(error as Error).message}). Do not retry; refresh the catalog to check whether it registered.`);
    }
    const registeredSkill = result && typeof result === 'object' && !Array.isArray(result)
      ? ('skill' in result ? (result as { skill?: unknown }).skill : result) : undefined;
    if (!registeredSkill || typeof registeredSkill !== 'object' || Array.isArray(registeredSkill) ||
      typeof (registeredSkill as { name?: unknown }).name !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test((registeredSkill as { name: string }).name))
      throw new Error('Local skill registration returned an invalid response; outcome is unknown. Do not retry; refresh the catalog to check whether it registered.');
    if (client !== this.client || this.stopped) throw new Error('Skill may be registered, but the server disconnected before catalog refresh. Refresh the catalog; do not retry registration.');
    try { await this.refreshSkills(true); }
    catch (error) { throw new Error(`Skill registered, but catalog refresh failed: ${(error as Error).message}. Refresh the catalog; do not retry registration.`); }
  }
  async refreshSkills(requireCurrent = false): Promise<void> {
    const client = this.client, list = this.skillsListEndpoint;
    if (!client || !this.skillsEnabled || !this.status.startsWith('connected') || !list) throw new Error('Skills catalog is not available');
    await this.refreshSkillCatalog(client, list, this.skillsNamespace, ++this.skillsRequest, true, requireCurrent);
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
  private pruneTimer?: ReturnType<typeof setTimeout>;
  private refreshing = false;
  private refreshAgain = false;
  private refreshSkillsOnRefresh = true;
  private history: HistorySettings = { ...DEFAULT_HISTORY };
  private chats = new Map<string, ChatWindow>();
  private activeChat?: string;
  private recentFloor = 0;
  private evictedFloor = 0;
  private recentComplete = false;
  constructor(readonly socketPath: string, private readonly options: { replayHistory?: boolean; history?: HistorySettings } = {}) {
    super();
    this.configureHistory(options.history ?? DEFAULT_HISTORY);
    this.store.on('refresh', () => this.scheduleRefresh());
    this.store.on('evict', (seq: number) => {
      this.evictedFloor = Math.max(this.evictedFloor, seq + 1);
      this.recentFloor = Math.max(this.recentFloor, this.evictedFloor);
      this.recentComplete = false;
      for (const window of this.chats.values()) if (window.seqs.delete(seq)) { window.valid = false; window.hasMore = true; }
    });
  }
  configureHistory(settings: HistorySettings): void {
    this.history = historySettings(settings);
    for (const window of this.chats.values()) window.valid = false;
    this.store.configureHistory(this.history);
  }
  chatEvents(agentId: string): ServerEvent[] {
    const window = this.chats.get(agentId);
    return [...(window?.seqs ?? [])].sort((a, b) => a - b).flatMap(seq => {
      const event = this.store.events.get(seq);
      return event ? [event] : [];
    });
  }
  chatHasMore(agentId: string): boolean { return this.chats.get(agentId)?.hasMore ?? false; }
  chatLoading(agentId: string): boolean { return !!this.chats.get(agentId)?.loading; }
  leaveChat(): void { this.activeChat = undefined; this.store.setActiveChat(); }
  async openChat(agentId: string): Promise<void> {
    this.activeChat = agentId;
    this.store.setActiveChat(agentId);
    const previous = this.chats.get(agentId);
    if (previous?.valid && previous.following) return previous.loading;
    const window: ChatWindow = { seqs: new Set(), following: true, hasMore: true, valid: true };
    this.chats.set(agentId, window);
    const count = Math.min(this.history.chatPageSize, this.history.recentEvents);
    const cached = this.store.orderedEvents().filter(event => event.agentId === agentId && event.seq >= this.recentFloor);
    if (cached.length >= count || this.recentComplete) {
      const tail = cached.slice(-count);
      for (const event of tail) { window.seqs.add(event.seq); this.store.ingest(event, 'history'); }
      window.hasMore = cached.length > count || !this.recentComplete;
      this.store.emit('change');
      return;
    }
    return this.loadChat(agentId, window, this.store.watermark + 1);
  }
  async olderChat(agentId: string): Promise<void> {
    const window = this.chats.get(agentId);
    if (!window || window.loading || !window.hasMore) return window?.loading;
    const before = this.chatEvents(agentId)[0]?.seq;
    if (before === undefined) return this.followChat(agentId);
    window.following = false;
    this.store.setActiveChat(this.activeChat, true);
    return this.loadChat(agentId, window, before);
  }
  pauseChat(agentId: string): void {
    const window = this.chats.get(agentId);
    if (window) window.following = false;
    this.store.setActiveChat(this.activeChat, true);
  }
  async followChat(agentId: string): Promise<void> {
    this.chats.delete(agentId);
    return this.openChat(agentId);
  }
  private loadChat(agentId: string, window: ChatWindow, before: number): Promise<void> {
    const client = this.client;
    if (!client || this.stopped) { window.valid = false; return Promise.reject(new Error('Server is not connected')); }
    const work = async () => {
      const target = Math.min(this.history.chatPageSize, this.history.recentEvents);
      let received = 0, bytes = 0;
      while (received < target && bytes < this.history.cacheBytes) {
        const page = await client.request<HistoryPage>('events.history', { after: 0, before, agentId, limit: Math.min(1000, target - received), ...(this.renderingCapability && { renderings: true }) });
        if (client !== this.client || this.stopped || this.chats.get(agentId) !== window) return;
        if (page.expired && !this.store.historyGap) {
          this.store.historyGap = true;
          this.emit('notice', 'History retention gap: earlier chat is unavailable.');
        }
        const events = page.events.filter(e => e.agentId === agentId && e.seq < before).sort((a, b) => a.seq - b.seq);
        window.hasMore = page.hasMore ?? false;
        if (!events.length) { window.hasMore = false; break; }
        for (const event of events) {
          window.seqs.add(event.seq);
          this.store.ingest(event, 'history');
          const rendering = page.renderings?.[event.seq];
          if (validEventRendering(rendering) && this.store.events.has(event.seq)) this.store.present(event.seq, rendering);
        }
        received += events.length;
        bytes += Buffer.byteLength(JSON.stringify(page));
        before = events[0]!.seq;
        if (!window.hasMore) break;
      }
      this.store.emit('change');
    };
    const pending = work().catch(error => { window.valid = false; throw error; }).finally(() => {
      if (window.loading === pending) window.loading = undefined;
      this.store.emit('change');
    });
    window.loading = pending;
    this.store.emit('change');
    return pending;
  }
  private live(event: ServerEvent): void {
    const window = event.agentId ? this.chats.get(event.agentId) : undefined;
    const following = window?.following && event.agentId === this.activeChat;
    if (following) window.seqs.add(event.seq);
    else if (window) window.valid = false;
    this.store.ingest(event, following ? 'chat-live' : 'live');
  }
  private setStatus(status: string): void { this.status = status; this.emit('status'); }
  private schedulePrune(): void {
    if (this.stopped || this.pruneTimer) return;
    this.pruneTimer = setTimeout(() => {
      this.pruneTimer = undefined;
      this.store.pruneHistory();
      this.schedulePrune();
    }, 10_000);
  }
  async run(): Promise<void> {
    this.schedulePrune(); // Cache expiry also runs while the server is offline.
    let delay = 250;
    while (!this.stopped) {
      const client = this.client = new RpcClient(this.socketPath);
      let buffering = true;
      const buffered: ServerEvent[] = [];
      const presentations = new Map<number, EventRendering>();
      let bufferedBytes = 0, droppedBufferedState = false, droppedSeq = 0;
      const trimBuffers = () => {
        while (buffered.length + presentations.size > this.history.recentEvents || bufferedBytes > this.history.cacheBytes) {
          const presentationSeq = presentations.keys().next().value;
          if (presentationSeq !== undefined && (!buffered.length || presentationSeq <= buffered[0]!.seq)) {
            bufferedBytes -= Buffer.byteLength(JSON.stringify(presentations.get(presentationSeq)));
            presentations.delete(presentationSeq);
          } else if (buffered.length) {
            const dropped = buffered.shift()!;
            bufferedBytes -= Buffer.byteLength(JSON.stringify(dropped));
            droppedBufferedState = true; droppedSeq = Math.max(droppedSeq, dropped.seq);
          } else break;
        }
      };
      client.on('event', (event: ServerEvent) => {
        this.emit('event', event);
        if (buffering) { buffered.push(event); bufferedBytes += Buffer.byteLength(JSON.stringify(event)); trimBuffers(); }
        else {
          this.live(event);
          if (event.type === 'skills.catalog_added' || event.type === 'organization.settings.changed') {
            this.scheduleRefresh();
          }
          if (event.type === 'skills.catalog_changed' || event.type === 'skills.reconciliation_changed') {
            void this.refreshSkills().catch(error => this.emit('notice', `Skills refresh failed: ${(error as Error).message}`));
          }
        }
      });
      client.on('presentation', (seq: number, rendering: EventRendering) => {
        if (buffering) {
          if (presentations.has(seq)) bufferedBytes -= Buffer.byteLength(JSON.stringify(presentations.get(seq)));
          presentations.set(seq, rendering);
          bufferedBytes += Buffer.byteLength(JSON.stringify(rendering)); trimBuffers();
        } else this.store.present(seq, rendering);
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
        this.chats.clear(); // Reconnects cannot assert coverage across missed live traffic.
        this.recentComplete = false;
        this.store.reset();
        this.evictedFloor = droppedBufferedState ? droppedSeq + 1 : 0;
        this.recentFloor = this.evictedFloor;
        this.store.install(snapshot);
        for (const [seq, rendering] of presentations) this.store.present(seq, rendering);
        buffered.sort((a, b) => a.seq - b.seq).forEach(event => this.live(event));
        presentations.clear();
        buffering = false;
        if (buffered.some(event => event.type === 'skills.catalog_changed' || event.type === 'skills.reconciliation_changed'))
          void this.refreshSkills().catch(error => this.emit('notice', `Skills refresh failed: ${(error as Error).message}`));
        buffered.length = 0; bufferedBytes = 0;
        if (droppedBufferedState) this.scheduleRefresh(false);
        delay = 250;
        if (this.options.replayHistory !== false) {
          this.setStatus('connected · loading history');
          // Keep the UI live during history download, with a fixed replay target.
          try { await this.replay(client, snapshot.seq); }
          catch (error) {
            if (!(error instanceof ApiError)) throw error;
            this.emit('notice', `Recent history unavailable: ${error.message}. Chat can retry on demand.`);
          }
        } else this.store.historyCursor = snapshot.seq;
        snapshot = undefined; // Do not retain an obsolete startup snapshot while connected.
        this.setStatus('connected');
        if (this.activeChat && !this.chats.has(this.activeChat)) void this.openChat(this.activeChat).catch(error => this.emit('notice', error.message));
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
    let before = target + 1, received = 0, bytes = 0;
    this.recentFloor = Math.max(this.evictedFloor, before);
    this.recentComplete = target === 0 && this.evictedFloor === 0;
    while (!this.stopped && target > 0 && received < this.history.recentEvents && bytes < this.history.cacheBytes) {
      const page = await client.request<HistoryPage>('events.history', { after: 0, before, limit: Math.min(1000, this.history.recentEvents - received), ...(this.renderingCapability && { renderings: true }) });
      if (page.expired && !this.store.historyGap) {
        this.store.historyGap = true;
        this.emit('notice', 'History retention gap: earlier chat is unavailable.');
      }
      const events = page.events.filter(event => event.seq < before && event.seq <= target).sort((a, b) => a.seq - b.seq);
      if (!events.length) { this.recentComplete = this.evictedFloor === 0; break; }
      this.recentFloor = Math.max(this.evictedFloor, Math.min(this.recentFloor, events[0]!.seq));
      for (const event of events) {
        this.store.ingest(event);
        const rendering = page.renderings?.[event.seq];
        if (validEventRendering(rendering) && this.store.events.has(event.seq)) this.store.present(event.seq, rendering);
      }
      received += events.length;
      bytes += Buffer.byteLength(JSON.stringify(page));
      before = events[0]!.seq;
      if (!page.hasMore) { this.recentComplete = this.evictedFloor === 0; break; }
    }
    // This cursor tracks state synchronization, never evictable history coverage.
    this.store.historyCursor = target;
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
    if (this.pruneTimer) clearTimeout(this.pruneTimer);
    this.client?.close();
  }
}
