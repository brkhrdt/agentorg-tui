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
type RepositorySourceKind = 'https' | 'server-path';
interface SkillRepositoryRegistrationCapability { namespace: string; listEndpoint: string; endpoint: 'skills.registerRepository'; sourceKinds: RepositorySourceKind[] }
interface SkillCatalogManagementSupport { namespace: string; listEndpoint: string; retireEndpoint: 'skills.retireRepository'; restoreEndpoint: 'skills.restoreRepository'; deleteEndpoint?: 'skills.deleteRepository' }
function skillCatalogManagementSupport(value: unknown): SkillCatalogManagementSupport | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const capability = value as any, management = capability.catalogManagement, endpoints = capability.endpoints;
  if (capability.version !== 1 || typeof capability.settingsNamespace !== 'string' || !/^[a-z][a-z0-9.-]*$/.test(capability.settingsNamespace) ||
      endpoints?.list !== 'skills.list' || endpoints?.retireRepository !== 'skills.retireRepository' || endpoints?.restoreRepository !== 'skills.restoreRepository' ||
      management?.version !== 1 || management.semantics !== 'reversible-retirement-v1' || management.sourceIdentity !== 'name+source-v1') return undefined;
  return { namespace: capability.settingsNamespace, listEndpoint: endpoints.list, retireEndpoint: endpoints.retireRepository, restoreEndpoint: endpoints.restoreRepository,
    ...(endpoints.deleteRepository === 'skills.deleteRepository' ? { deleteEndpoint: endpoints.deleteRepository } : {}) };
}
function skillRepositoryRegistrationCapability(value: unknown): SkillRepositoryRegistrationCapability | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const capability = value as any, registration = capability.repositoryRegistration, endpoints = capability.endpoints;
  if (capability.version !== 1 || typeof capability.settingsNamespace !== 'string' || !/^[a-z][a-z0-9.-]*$/.test(capability.settingsNamespace) ||
      endpoints?.list !== 'skills.list' || endpoints?.registerRepository !== 'skills.registerRepository' ||
      registration?.version !== 1 || registration.history !== 'preserve-v1' || !Array.isArray(registration.sourceKinds) ||
      registration.sourceKinds.length < 1 || registration.sourceKinds.some((kind: unknown) => kind !== 'https' && kind !== 'server-path') ||
      new Set(registration.sourceKinds).size !== registration.sourceKinds.length || !registration.sourceKinds.includes('https')) return undefined;
  return { namespace: capability.settingsNamespace, listEndpoint: endpoints.list, endpoint: endpoints.registerRepository,
    sourceKinds: registration.sourceKinds as RepositorySourceKind[] };
}

interface ChatWindow {
  seqs: Set<number>; hasMore: boolean; following: boolean; valid: boolean; loading?: Promise<void>;
}

export class Session extends EventEmitter {
  readonly store = new Store();
  status = 'connecting';
  skillsEnabled = false;
  skillCatalog: Skill[] = [];
  managedSkillCatalog: Skill[] = [];
  retainedSkills: SkillRetained[] = [];
  skillReconciliation?: SkillReconciliation;
  private skillsReconcileEndpoint?: string;
  private skillsListEndpoint?: string;
  private skillsRegisterRepositoryEndpoint?: string;
  private skillRepositoryRegistration?: SkillRepositoryRegistrationCapability;
  private skillCatalogManagement?: SkillCatalogManagementSupport;
  get skillRepositoryRegistrationAvailable(): boolean { return !!this.skillsRegisterRepositoryEndpoint && this.skillsEnabled; }
  get skillCatalogManagementAvailable(): boolean { return !!this.skillCatalogManagement && this.skillsEnabled; }
  get skillCatalogDeletionAvailable(): boolean { return !!this.skillCatalogManagement?.deleteEndpoint && this.skillsEnabled; }
  get skillRepositorySourceKinds(): string[] { return this.skillRepositoryRegistration?.sourceKinds ?? []; }
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
    const client = this.client;
    if (!client || !this.status.startsWith('connected')) throw new Error('Server is not connected');
    const result = await client.request<unknown>('organization.paths', { input, base, kind, limit: 5, ...(create && { create: true }) });
    if (client !== this.client || this.stopped || !this.status.startsWith('connected')) throw new Error('Server connection changed; retry path completion');
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('Invalid path completion response');
    const value = result as PathCompletion;
    const safe = (text: unknown) => typeof text === 'string' && text.length > 0 && !/[\u0000-\u001f\u007f]/u.test(text);
    if (typeof value.path !== 'string' || /[\u0000-\u001f\u007f]/u.test(value.path) || typeof value.isDirectory !== 'boolean' || !Array.isArray(value.entries) || value.entries.length > 5 || value.entries.some(entry =>
      !entry || !safe(entry.name) || !safe(entry.path) || (entry.kind !== 'directory' && entry.kind !== 'file'))) throw new Error('Invalid path completion response');
    return value;
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
    const capability = snapshot.capabilities?.plugins?.skills as { version?: unknown; settingsNamespace?: unknown; endpoints?: { list?: unknown; reconcile?: unknown; addFromPath?: unknown; registerRepository?: unknown }; repositoryRegistration?: { version?: unknown; sourceKinds?: unknown; history?: unknown } } | undefined;
    const namespace = capability?.settingsNamespace;
    const list = capability?.endpoints?.list;
    const supported = (capability?.version === undefined || capability.version === 1) && typeof namespace === 'string' && /^[a-z][a-z0-9.-]*$/.test(namespace) && typeof list === 'string' && /^[a-z][a-z0-9.-]*$/.test(list);
    if (!supported) {
      if (client === this.client && !this.stopped && skillsRequest === this.skillsRequest) {
        this.skillsEnabled = false; this.skillsNamespace = 'skills'; this.skillCatalog = []; this.managedSkillCatalog = []; this.retainedSkills = []; this.skillReconciliation = undefined; this.skillsReconcileEndpoint = undefined; this.skillsListEndpoint = undefined; this.skillsRegisterRepositoryEndpoint = undefined; this.skillRepositoryRegistration = undefined; this.skillCatalogManagement = undefined;
      }
      return;
    }
    if (client !== this.client || this.stopped || skillsRequest !== this.skillsRequest) return;
    const endpoint = list as string;
    const reconcileEndpoint = typeof capability?.endpoints?.reconcile === 'string' && /^[a-z][a-z0-9.-]*$/.test(capability.endpoints.reconcile) ? capability.endpoints.reconcile : undefined;
    this.skillsListEndpoint = endpoint;
    this.skillsReconcileEndpoint = reconcileEndpoint;
    const registration = skillRepositoryRegistrationCapability(capability);
    this.skillRepositoryRegistration = registration;
    this.skillsRegisterRepositoryEndpoint = registration?.endpoint;
    this.skillCatalogManagement = skillCatalogManagementSupport(capability);
    await this.refreshSkillCatalog(client, endpoint, namespace as string, skillsRequest);
  }
  private async refreshSkillCatalog(client: RpcClient, endpoint: string, namespace = this.skillsNamespace, request = ++this.skillsRequest, throwOnFailure = false, requireCurrent = false): Promise<void> {
    let catalog: { skills?: unknown; managed?: unknown; retained?: unknown; reconciliation?: unknown };
    try { catalog = await client.request<{ skills?: unknown; managed?: unknown; retained?: unknown; reconciliation?: unknown }>(endpoint, {}); }
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
    const managedSkills = catalog && typeof catalog === 'object' && Array.isArray(catalog.managed) ? catalog.managed as unknown[] : undefined;
    const validManagedSkills = managedSkills?.filter((skill): skill is Skill => !!skill && typeof skill === 'object' &&
      typeof (skill as Skill).name === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test((skill as Skill).name) &&
      typeof (skill as Skill).description === 'string' && ['ready', 'retired'].includes((skill as Skill).status ?? '')) ?? [];
    const invalidManaged = this.skillCatalogManagement ? managedSkills === undefined || validManagedSkills.length !== managedSkills.length :
      managedSkills !== undefined && validManagedSkills.length !== managedSkills.length;
    if (requireCurrent && (invalidCatalog || invalidManaged)) throw new Error('Invalid skills catalog response');
    const entries = validSkills.filter(skill => skill.status === undefined || skill.status === 'ready');
    this.skillsEnabled = true; this.skillsNamespace = namespace;
    this.skillCatalog = entries;
    this.managedSkillCatalog = validManagedSkills;
    this.retainedSkills = Array.isArray(catalog?.retained) ? catalog.retained.filter((item): item is SkillRetained => !!item && typeof item === 'object' && typeof (item as SkillRetained).name === 'string') : [];
    const reconciliation = catalog?.reconciliation;
    this.skillReconciliation = reconciliation && typeof reconciliation === 'object' && ['pending', 'running', 'ready', 'error'].includes((reconciliation as SkillReconciliation).state)
      ? reconciliation as SkillReconciliation : undefined;
    if (invalidCatalog) this.emit('notice', 'Skills catalog response was invalid; malformed entries were ignored.');
    this.store.emit('change');
  }
  async registerSkillRepository(source: string): Promise<{ record: Skill; refreshed: boolean; refreshError?: string }> {
    const client = this.client, endpoint = this.skillsRegisterRepositoryEndpoint;
    if (!client || !this.skillsEnabled || !endpoint || endpoint !== 'skills.registerRepository' || !this.status.startsWith('connected')) throw new Error('Unified skill repository registration is not available');
    const isUrlLike = /^[a-z][a-z0-9+.-]*:/i.test(source) || source.startsWith('//') || /^[^/\s]+@[^:\s]+:/.test(source);
    const sourceKind = isUrlLike ? 'https' : 'server-path';
    if (!this.skillRepositorySourceKinds.includes(sourceKind)) throw new Error('This server does not advertise support for that repository source kind');
    const snapshot = await client.request<Snapshot>('organization.snapshot', {});
    const capability = snapshot.capabilities?.plugins?.skills as { version?: unknown; settingsNamespace?: unknown; endpoints?: { list?: unknown; registerRepository?: unknown }; repositoryRegistration?: { version?: unknown; sourceKinds?: unknown; history?: unknown } } | undefined;
    if (client !== this.client || this.stopped || !this.status.startsWith('connected')) throw new Error('Server disconnected before registering repository');
    const currentRegistration = skillRepositoryRegistrationCapability(capability);
    if (!currentRegistration || currentRegistration.namespace !== this.skillsNamespace || currentRegistration.listEndpoint !== this.skillsListEndpoint ||
        currentRegistration.endpoint !== endpoint || !currentRegistration.sourceKinds.includes(sourceKind) ||
        this.skillsRegisterRepositoryEndpoint !== endpoint || this.skillRepositoryRegistration?.namespace !== currentRegistration.namespace ||
        this.skillRepositoryRegistration?.listEndpoint !== currentRegistration.listEndpoint || this.skillRepositoryRegistration?.sourceKinds.join(',') !== currentRegistration.sourceKinds.join(','))
      throw new Error('Unified skill repository registration is no longer supported by this server');
    let result: unknown;
    try { result = await client.request<unknown>(endpoint, { source }, 120_000); }
    catch (error) {
      if (error instanceof ApiError) throw new Error(`Skill repository registration failed: ${error.message}`);
      throw new Error(`Registration outcome is unknown (${(error as Error).message}). Do not retry; refresh the catalog to check.`);
    }
    const candidate = result && typeof result === 'object' && !Array.isArray(result) ? result as Skill : undefined;
    const sourceInfo = candidate?.source, history = candidate?.history;
    const sourceValid = sourceKind === 'https' ? sourceInfo?.kind === 'git' && typeof sourceInfo.gitUrl === 'string' && history?.mode === 'git-preserved' :
      sourceInfo?.kind === 'local' && typeof sourceInfo.path === 'string' && ['git-preserved', 'directory-initialized'].includes(history?.mode ?? '');
    const valid = !!candidate && typeof candidate.name === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(candidate.name) &&
      typeof candidate.description === 'string' && typeof candidate.path === 'string' && typeof candidate.createdAt === 'string' && candidate.origin === 'manual' &&
      !!sourceValid && (history?.mode !== 'git-preserved' || history.scope === 'branches-tags-head-v1' && typeof history.selectedCommit === 'string');
    if (!valid) throw new Error('Registration returned a malformed result; outcome is unknown. Do not retry; refresh the catalog to check.');
    const record = candidate!;
    if (client !== this.client || this.stopped) return { record, refreshed: false, refreshError: 'Server disconnected after registration.' };
    try { await this.refreshSkills(true); return { record, refreshed: true }; }
    catch (error) { return { record, refreshed: false, refreshError: (error as Error).message }; }
  }
  async updateSkillCatalogRetirement(skill: Skill, retired: boolean): Promise<{ record: Skill; refreshed: boolean; refreshError?: string }> {
    const client = this.client, support = this.skillCatalogManagement;
    if (!client || !this.skillsEnabled || !support || !this.status.startsWith('connected') || !skill.source)
      throw new Error('Registered catalog management is not available');
    const expectedStatus = retired ? 'ready' : 'retired';
    if (skill.status !== expectedStatus) throw new Error(`Catalog entry is no longer ${expectedStatus}; refresh before managing it`);
    const snapshot = await client.request<Snapshot>('organization.snapshot', {});
    if (client !== this.client || this.stopped || !this.status.startsWith('connected')) throw new Error('Server disconnected before changing catalog status');
    const capability = snapshot.capabilities?.plugins?.skills;
    const current = skillCatalogManagementSupport(capability);
    const sameManagement = (a?: SkillCatalogManagementSupport, b?: SkillCatalogManagementSupport) => !!a && !!b &&
      a.namespace === b.namespace && a.listEndpoint === b.listEndpoint && a.retireEndpoint === b.retireEndpoint && a.restoreEndpoint === b.restoreEndpoint && a.deleteEndpoint === b.deleteEndpoint;
    if (!this.skillsEnabled || !sameManagement(this.skillCatalogManagement, support) || !sameManagement(current, support) ||
        current!.namespace !== this.skillsNamespace || current!.listEndpoint !== this.skillsListEndpoint)
      throw new Error('Catalog management capability is no longer supported by this server');
    const endpoint = retired ? current!.retireEndpoint : current!.restoreEndpoint;
    let response: unknown;
    try {
      response = await client.request<unknown>(endpoint, { name: skill.name, source: skill.source, expectedStatus });
    } catch (error) {
      if (error instanceof ApiError) throw new Error(`Catalog status change failed: ${error.message}`);
      throw new Error(`Catalog status outcome is unknown (${(error as Error).message}); refresh catalog before retrying.`);
    }
    const result = response && typeof response === 'object' && !Array.isArray(response) ? response as { skill?: Skill; status?: unknown } : undefined;
    const sameSource = (a: Skill['source'], b: Skill['source']) => !!a && !!b && a.kind === b.kind &&
      (a.kind === 'git' ? b.kind === 'git' && a.gitUrl === b.gitUrl : b.kind === 'local' && a.path === b.path);
    if (!result?.skill || result.skill.name !== skill.name || !sameSource(result.skill.source, skill.source) || result.status !== (retired ? 'retired' : 'ready'))
      throw new Error('Catalog status response was malformed; refresh catalog to verify before retrying.');
    const record = { ...result.skill, status: result.status } as Skill;
    if (client !== this.client || this.stopped) return { record, refreshed: false, refreshError: 'Server disconnected after catalog status change.' };
    try { await this.refreshSkills(true); return { record, refreshed: true }; }
    catch (error) { return { record, refreshed: false, refreshError: (error as Error).message }; }
  }
  async deleteSkillRepository(skill: Skill): Promise<{ removedAssignments: number; removedInstallations: number; refreshed: boolean; refreshError?: string }> {
    const client = this.client, support = this.skillCatalogManagement, endpoint = support?.deleteEndpoint;
    if (!client || !this.skillsEnabled || !support || !endpoint || !this.status.startsWith('connected') || !skill.source)
      throw new Error('Permanent registered-catalog deletion is not available');
    const expectedStatus = skill.status;
    if (expectedStatus !== 'ready' && expectedStatus !== 'retired') throw new Error('Catalog entry has no valid status; refresh before deleting it');
    const snapshot = await client.request<Snapshot>('organization.snapshot', {});
    if (client !== this.client || this.stopped || !this.status.startsWith('connected')) throw new Error('Server disconnected before deleting catalog skill');
    const current = skillCatalogManagementSupport(snapshot.capabilities?.plugins?.skills);
    const sameManagement = (a?: SkillCatalogManagementSupport, b?: SkillCatalogManagementSupport) => !!a && !!b &&
      a.namespace === b.namespace && a.listEndpoint === b.listEndpoint && a.retireEndpoint === b.retireEndpoint &&
      a.restoreEndpoint === b.restoreEndpoint && a.deleteEndpoint === b.deleteEndpoint;
    if (!this.skillsEnabled || !sameManagement(this.skillCatalogManagement, support) || !sameManagement(current, support) ||
        current!.namespace !== this.skillsNamespace || current!.listEndpoint !== this.skillsListEndpoint || current!.deleteEndpoint !== endpoint)
      throw new Error('Permanent catalog deletion capability is no longer supported by this server');
    let response: unknown;
    try { response = await client.request<unknown>(endpoint, { name: skill.name, source: skill.source, expectedStatus }, 120_000); }
    catch (error) {
      if (error instanceof ApiError) throw new Error(`Permanent skill deletion failed: ${error.message}`);
      throw new Error(`Permanent skill deletion outcome is unknown (${(error as Error).message}); refresh the catalog before retrying.`);
    }
    const result = response && typeof response === 'object' && !Array.isArray(response) ? response as { name?: unknown; source?: Skill['source']; status?: unknown; removedAssignments?: unknown; removedInstallations?: unknown } : undefined;
    const sameSource = (a: Skill['source'], b: Skill['source']) => !!a && !!b && a.kind === b.kind &&
      (a.kind === 'git' ? b.kind === 'git' && a.gitUrl === b.gitUrl : b.kind === 'local' && a.path === b.path);
    if (result?.name !== skill.name || !sameSource(result.source, skill.source) || result.status !== 'deleted' ||
        !Number.isInteger(result.removedAssignments) || (result.removedAssignments as number) < 0 ||
        !Number.isInteger(result.removedInstallations) || (result.removedInstallations as number) < 0)
      throw new Error('Deletion returned a malformed result; refresh the catalog to verify before retrying.');
    if (client !== this.client || this.stopped) return { removedAssignments: result.removedAssignments as number, removedInstallations: result.removedInstallations as number, refreshed: false, refreshError: 'Server disconnected after deletion.' };
    try { await this.refreshSkills(true); return { removedAssignments: result.removedAssignments as number, removedInstallations: result.removedInstallations as number, refreshed: true }; }
    catch (error) { return { removedAssignments: result.removedAssignments as number, removedInstallations: result.removedInstallations as number, refreshed: false, refreshError: (error as Error).message }; }
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
  chatCoverageIncomplete(agentId: string): boolean { return this.chats.get(agentId)?.valid === false; }
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
    this.store.setActiveChat(this.activeChat, true, before);
    return this.loadChat(agentId, window, before, true);
  }
  pauseChat(agentId: string, anchorSeq?: number): void {
    const window = this.chats.get(agentId);
    if (window) window.following = false;
    this.store.setActiveChat(this.activeChat, true, anchorSeq);
  }
  resumeChat(agentId: string): void {
    const window = this.chats.get(agentId);
    if (!window || this.activeChat !== agentId) return;
    const reload = !window.valid;
    window.following = true;
    this.store.setActiveChat(this.activeChat, false);
    if (reload) void this.followChat(agentId).catch(error => this.emit('notice', `Chat history: ${error.message}`));
  }
  async followChat(agentId: string): Promise<void> {
    this.chats.delete(agentId);
    return this.openChat(agentId);
  }
  private loadChat(agentId: string, window: ChatWindow, before: number, olderPage = false): Promise<void> {
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
          this.store.ingest(event, olderPage ? 'chat-history' : 'history');
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
    const active = !!window && event.agentId === this.activeChat;
    if (active) window.seqs.add(event.seq);
    else if (window) window.valid = false;
    this.store.ingest(event, active ? 'chat-live' : 'live');
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
