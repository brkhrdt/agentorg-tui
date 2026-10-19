import { isDeepStrictEqual } from 'node:util';
import type { Agent, AgentProfile, ContainerProfile, Skill, SkillStates } from './protocol.js';
import { SkillSelectionDraft } from './skill-selection.js';
import { StructuredEditor, collection, parseTyped, valueText, type PluginField, type FieldSpec } from './structured-editor.js';

export const AGENT_FIELDS = ['name', 'harness', 'provider', 'model', 'cwd', 'metadata', 'env', 'options', 'extensions'] as const;
export const PODMAN_FIELDS = ['readOnlyDirs', 'readWriteDirs', 'readOnlyVolumes', 'readWriteVolumes'] as const;
export type AgentField = 'thinking' | 'container' | 'skills' | typeof AGENT_FIELDS[number] | typeof PODMAN_FIELDS[number] | `plugin:${string}:${string}`;
export type ImageScope = 'node' | 'inherited' | 'all';
const maps = new Set<AgentField>(['metadata', 'env', 'options', 'extensions']);

/** Keeps the revision and target captured at open; live updates never overwrite a draft. */
export class AgentEditor {
  readonly values: Record<AgentField, string>;
  private readonly original: Record<AgentField, string>;
  readonly agentId?: string;
  readonly revision?: number;
  private readonly baseFields: readonly AgentField[];
  get fields(): readonly AgentField[] {
    const pi = this.agentProfilesEnabled && this.values.harness === 'pi';
    return this.baseFields.filter(field => field === 'thinking' ? pi : field !== 'options' || !pi || !!this.agentId);
  }
  private selectedProfile?: { profile: ContainerProfile; revision: number };
  private selectedAgentProfile?: AgentProfile;
  private agentBase?: { provider?: string; model?: string; options: Record<string, unknown> };
  private agentLabel = '';
  private skillNamespace?: string;
  private skillDraft?: SkillSelectionDraft;
  private skillsExplicit = false;
  private readonly podmanEnabled: boolean;
  private readonly volumesEnabled: boolean;
  private readonly pluginSpecs = new Map<AgentField, PluginField>();
  private readonly explicit = new Set<AgentField>();
  constructor(readonly parentId: string | null, agent?: Agent, podmanEnabled = false, pluginFields: PluginField[] = [], volumesEnabled = false, profilesEnabled = false, private readonly agentProfilesEnabled = false, options?: { skills?: { namespace: string; catalog: Skill[] } }) {
    this.podmanEnabled = podmanEnabled || !!agent?.settings.extensions?.podman;
    const grants = agent?.settings.extensions?.podman as Record<string, unknown> | undefined;
    this.volumesEnabled = volumesEnabled || !!grants?.readOnlyVolumes || !!grants?.readWriteVolumes;
    for (const spec of pluginFields) {
      if (this.podmanEnabled && spec.namespace === 'podman' && ['image', 'readOnlyDirs', 'readWriteDirs', 'readOnlyVolumes', 'readWriteVolumes'].includes(spec.key)) continue;
      this.pluginSpecs.set(`plugin:${spec.namespace}:${spec.key}`, { ...spec });
    }
    this.skillNamespace = options?.skills?.namespace;
    if (options?.skills) {
      const extensions = agent?.settings.extensions;
      const extension = extensions && Object.hasOwn(extensions, options.skills.namespace) ? extensions[options.skills.namespace] : undefined;
      const existing = extension && typeof extension === 'object' && !Array.isArray(extension) ? extension as SkillStates : {};
      this.skillDraft = new SkillSelectionDraft(options.skills.catalog, existing);
    }
    this.baseFields = [...AGENT_FIELDS.flatMap(field => field === 'model' && agentProfilesEnabled ? [field, 'thinking' as const] : [field]), ...(this.skillDraft ? ['skills' as const] : []), ...(this.podmanEnabled && profilesEnabled ? ['container' as const] : []), ...(this.podmanEnabled ? PODMAN_FIELDS.filter(field => this.volumesEnabled || !field.endsWith('Volumes')) : []), ...this.pluginSpecs.keys()];
    this.agentId = agent?.id;
    this.revision = agent?.revision;
    this.values = Object.fromEntries(AGENT_FIELDS.map(field => {
      const value = field === 'name' ? agent?.name ?? 'agent' : field === 'metadata' ? agent?.metadata : agent?.settings[field];
      return [field, maps.has(field) ? JSON.stringify(value ?? {}) : String(value ?? '')];
    })) as Record<AgentField, string>;
    if (this.skillDraft) this.values.skills = this.display('skills');
    const podman = agent?.settings.extensions?.podman as { image?: string | null; profile?: { id?: string; name?: string }; readOnlyDirs?: string[]; readWriteDirs?: string[]; readOnlyVolumes?: string[]; readWriteVolumes?: string[] } | undefined;
    this.values.thinking = String((agent?.settings.options as Record<string, unknown> | undefined)?.thinking ?? '');
    const piProfile = (agent?.settings.extensions?.pi as { profile?: { name?: string } } | undefined)?.profile;
    if (piProfile) this.agentLabel = `${agent?.settings.harness} — ${piProfile.name ?? 'Default'}`;
    this.values.container = podman?.profile?.name ?? (podman?.image ? 'Custom / legacy' : this.parentId ? 'Inherited' : 'Default');
    this.values.readOnlyDirs = JSON.stringify(podman?.readOnlyDirs ?? []);
    this.values.readWriteDirs = JSON.stringify(podman?.readWriteDirs ?? []);
    this.values.readOnlyVolumes = JSON.stringify(podman?.readOnlyVolumes ?? []);
    this.values.readWriteVolumes = JSON.stringify(podman?.readWriteVolumes ?? []);
    for (const [field, spec] of this.pluginSpecs) {
      const extensions = agent?.settings.extensions;
      const namespace = extensions && Object.hasOwn(extensions, spec.namespace) ? extensions[spec.namespace] : undefined;
      const value = namespace && typeof namespace === 'object' && !Array.isArray(namespace) && Object.hasOwn(namespace, spec.key) ? (namespace as Record<string, unknown>)[spec.key] : undefined;
      this.values[field] = value === undefined ? this.empty(spec) : collection(spec.editor) ? JSON.stringify(value) : valueText(value);
    }
    this.original = { ...this.values };
  }
  selectAgentProfile(profile: AgentProfile): void {
    this.selectedAgentProfile = structuredClone(profile);
    this.agentBase = structuredClone(profile);
    this.agentLabel = `${profile.harness} — ${profile.name}`;
    this.values.harness = profile.harness;
    this.values.provider = profile.provider ?? '';
    this.values.model = profile.model ?? '';
    this.values.options = JSON.stringify(profile.options);
    this.values.thinking = String(profile.options.thinking ?? '');
  }
  inheritAgent(parent: Agent): void {
    const options = structuredClone((parent.settings.options ?? {}) as Record<string, unknown>);
    this.agentBase = { provider: parent.settings.provider as string | undefined, model: parent.settings.model, options };
    this.values.harness = parent.settings.harness;
    this.values.provider = String(parent.settings.provider ?? '');
    this.values.model = parent.settings.model ?? '';
    this.values.options = JSON.stringify(options);
    this.values.thinking = String(options.thinking ?? '');
    const pi = parent.settings.extensions?.pi as { profile?: { name?: string } } | undefined;
    this.agentLabel = `${parent.settings.harness} — ${pi?.profile?.name ?? 'Default'} (inherited)`;
  }
  display(field: AgentField): string {
    if (field === 'harness') return this.agentLabel || this.values.harness;
    if (field === 'skills') {
      const count = Object.values(this.skillDraft?.states ?? {}).filter(state => state !== 'unavailable').length;
      return count ? `${count} selected` : 'None selected';
    }
    return this.values[field];
  }
  skillChoices(catalog?: readonly Skill[], states?: SkillStates) { return this.skillDraft?.choices(catalog, states) ?? []; }
  staleSkills(catalog: readonly Skill[]): string[] { return this.skillDraft?.staleSelections(catalog) ?? []; }
  skillStates(): SkillStates { return this.skillDraft?.states ?? {}; }
  stageSkillStates(states: SkillStates): void {
    if (!this.skillDraft) throw new Error('Skills plugin is not available');
    if (!isDeepStrictEqual(this.skillDraft.states, states)) this.skillsExplicit = true;
    this.skillDraft.replace(states);
  }
  setSkillState(name: string, state: 'available' | 'installed'): void {
    if (!this.skillDraft) throw new Error('Skills plugin is not available');
    const states = this.skillDraft.states;
    if (!Object.hasOwn(states, name) || states[name] !== state) this.skillsExplicit = true;
    this.skillDraft.setState(name, state);
  }
  removeSkill(name: string): void {
    if (!this.skillDraft) throw new Error('Skills plugin is not available');
    if (Object.hasOwn(this.skillDraft.states, name)) this.skillsExplicit = true;
    this.skillDraft.remove(name);
  }
  selectProfile(profile: ContainerProfile, revision: number): void {
    this.selectedProfile = { profile: structuredClone(profile), revision };
    this.values.container = profile.name;
    if (profile.cwd) this.values.cwd = profile.cwd;
    for (const key of PODMAN_FIELDS) this.values[key] = JSON.stringify(profile[key]);
  }
  private empty(spec: FieldSpec): string {
    return spec.editor.endsWith('-map') ? '{}' : collection(spec.editor) ? '[]' : spec.editor === 'number' ? '0' : spec.editor === 'boolean' ? 'false' : '';
  }
  label(field: AgentField): string {
    if (field === 'skills') return 'Skills:';
    const spec = this.pluginSpecs.get(field);
    return spec ? `${spec.namespace}.${spec.label ?? spec.key}` : field === 'harness' ? 'Agent' : field === 'thinking' ? 'Thinking' : field === 'container' ? 'Container' : field;
  }
  stage(field: AgentField, text: string): void {
    const spec = this.pluginSpecs.get(field);
    if (field === 'thinking') {
      if (text && !['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(text)) throw new Error('Invalid thinking level');
      const options = JSON.parse(this.values.options);
      if (text) options.thinking = text;
      else if (this.agentBase?.options.thinking !== undefined) options.thinking = this.agentBase.options.thinking;
      else delete options.thinking;
      this.values.options = JSON.stringify(options);
      text = String(options.thinking ?? '');
    }
    if (field === 'options') this.values.thinking = String(JSON.parse(text).thinking ?? '');
    if (spec && ['number', 'boolean'].includes(spec.editor)) parseTyped(text, spec.editor as 'number' | 'boolean');
    this.values[field] = text;
    if (spec) this.explicit.add(field);
  }
  spec(field: AgentField): FieldSpec {
    if (field === 'skills') return { editor: 'text' };
    if (this.pluginSpecs.has(field)) return this.pluginSpecs.get(field)!;
    if (field === 'env') return { editor: 'string-map', sensitive: true };
    if (maps.has(field)) return { editor: 'object-map' };
    if (['readOnlyDirs', 'readWriteDirs'].includes(field)) return { editor: 'directories' };
    if (['readOnlyVolumes', 'readWriteVolumes'].includes(field)) return { editor: 'list' };
    return { editor: 'text' };
  }
  select(field: 'harness' | 'provider' | 'model', value: string): void {
    if (this.values[field] === value) return;
    this.values[field] = value;
    if (field === 'harness') {
      this.values.provider = ''; this.agentLabel = ''; this.selectedAgentProfile = undefined; this.agentBase = undefined;
      this.values.thinking = ''; this.values.options = '{}';
    }
    if (field !== 'model') this.values.model = '';
  }
  get imageChanged(): boolean {
    try {
      const old = JSON.parse(this.original.extensions).podman?.image ?? null;
      const next = this.selectedProfile?.profile.image ?? JSON.parse(this.values.extensions).podman?.image ?? null;
      return next !== old;
    } catch { return false; }
  }
  params(): Record<string, unknown> {
    const params: Record<string, unknown> = this.agentId ? { agentId: this.agentId, expectedRevision: this.revision } : { parentId: this.parentId };
    const settings: Record<string, unknown> = {};
    for (const field of AGENT_FIELDS) {
      if (this.agentId && this.values[field] === this.original[field] && !(this.selectedAgentProfile && ['harness', 'provider', 'model', 'options'].includes(field))) continue;
      if (this.agentBase && (field === 'provider' || field === 'model') && this.values[field] === (this.agentBase[field] ?? '')) continue;
      const text = this.values[field].trim();
      if (!maps.has(field) && !text) {
        if (field === 'name' || field === 'harness' || this.agentId) throw new Error(`${field} cannot be blank (the API cannot unset scalar settings)`);
        continue;
      }
      let value: unknown = text;
      if (maps.has(field)) {
        try { value = JSON.parse(text); } catch { throw new Error(`${field} must be a JSON object`); }
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${field} must be a JSON object`);
        if (field === 'env' && Object.values(value).some(v => typeof v !== 'string')) throw new Error('env values must be strings');
      }
      if (field === 'options' && this.agentBase) {
        value = Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([key, entry]) =>
          JSON.stringify(entry) !== JSON.stringify(this.agentBase!.options[key])));
      }
      if (field === 'name' || field === 'metadata') params[field] = value;
      else settings[field] = value;
    }
    if (this.podmanEnabled && (!this.agentId || this.selectedProfile !== undefined || PODMAN_FIELDS.some(field => this.values[field] !== this.original[field]))) {
      const grants = (field: typeof PODMAN_FIELDS[number]): string[] => {
        let value: unknown;
        const message = `${field} must be a JSON array of ${field.endsWith('Volumes') ? 'volume names' : 'paths'}`;
        try { value = JSON.parse(this.values[field]); } catch { throw new Error(message); }
        if (!Array.isArray(value) || value.some(p => typeof p !== 'string' || !p.trim())) throw new Error(message);
        return value;
      };
      const extensions = (settings.extensions ?? JSON.parse(this.values.extensions)) as Record<string, unknown>;
      if (this.agentId && this.values.extensions !== this.original.extensions && Object.hasOwn(extensions, 'podman')) throw new Error('Edit Podman fields or extensions.podman, not both');
      const prior = !this.agentId ? {} : (JSON.parse(this.original.extensions).podman ?? {}) as Record<string, unknown>;
      const selected = this.selectedProfile;
      settings.extensions = { ...extensions, podman: { ...prior,
        ...(selected && { profile: { id: selected.profile.id, name: selected.profile.name, revision: selected.revision },
          runtime: { network: selected.profile.network, containerUid: selected.profile.containerUid, containerGid: selected.profile.containerGid, env: [...selected.profile.env] },
          image: selected.profile.image,
          configGrants: { readOnlyDirs: [...selected.profile.readOnlyDirs], readWriteDirs: [...selected.profile.readWriteDirs],
            readOnlyVolumes: [...selected.profile.readOnlyVolumes], readWriteVolumes: [...selected.profile.readWriteVolumes] } }),
        readOnlyDirs: grants('readOnlyDirs'), readWriteDirs: grants('readWriteDirs'),
        ...(this.volumesEnabled && { readOnlyVolumes: grants('readOnlyVolumes'), readWriteVolumes: grants('readWriteVolumes') }) } };
    }
    const originalExtensions = JSON.parse(this.original.extensions) as Record<string, unknown>;
    const rawExtensions = JSON.parse(this.values.extensions) as Record<string, unknown>;
    if (this.skillDraft && (this.skillDraft.dirty || (!this.agentId && this.skillsExplicit))) {
      if (this.values.extensions !== this.original.extensions && Object.hasOwn(rawExtensions, this.skillNamespace!) &&
          !isDeepStrictEqual(rawExtensions[this.skillNamespace!], originalExtensions[this.skillNamespace!]))
        throw new Error(`Edit Skills or extensions.${this.skillNamespace}, not both`);
      const extensions = (settings.extensions ?? rawExtensions) as Record<string, unknown>;
      settings.extensions = { ...extensions, [this.skillNamespace!]: this.skillDraft.states };
    }
    for (const [field, spec] of this.pluginSpecs) {
      const prior = Object.hasOwn(originalExtensions, spec.namespace) ? originalExtensions[spec.namespace] : undefined;
      const present = prior && typeof prior === 'object' && !Array.isArray(prior) && Object.hasOwn(prior, spec.key);
      if (this.values[field] === this.original[field] && (present || !this.explicit.has(field))) continue;
      if (this.values.extensions !== this.original.extensions && Object.hasOwn(rawExtensions, spec.namespace)) throw new Error(`Edit ${spec.namespace} fields or extensions.${spec.namespace}, not both`);
      if (prior !== undefined && (!prior || typeof prior !== 'object' || Array.isArray(prior))) throw new Error(`${spec.namespace} is not an object; use extensions raw editing`);
      const text = this.values[field];
      let value: unknown;
      try {
        value = collection(spec.editor) ? JSON.parse(text) : parseTyped(text, ['number', 'boolean'].includes(spec.editor) ? spec.editor as 'number' | 'boolean' : 'string');
        if (collection(spec.editor)) new StructuredEditor(spec, text);
      } catch (error) { throw new Error(`${this.label(field)}: ${(error as Error).message}`); }
      const extensions = (settings.extensions ?? {}) as Record<string, unknown>;
      const namespace = { ...(Object.hasOwn(extensions, spec.namespace) ? extensions[spec.namespace] : prior ?? {}) as Record<string, unknown> };
      Object.defineProperty(namespace, spec.key, { value, enumerable: true, configurable: true, writable: true });
      settings.extensions = { ...extensions, [spec.namespace]: namespace };
    }
    if (this.selectedAgentProfile) {
      const extensions = (settings.extensions ?? JSON.parse(this.values.extensions)) as Record<string, unknown>;
      if (this.selectedAgentProfile.harness === 'pi' && this.values.extensions !== this.original.extensions && Object.hasOwn(JSON.parse(this.values.extensions), 'pi')) throw new Error('Select an Agent profile or edit extensions.pi, not both');
      if (this.selectedAgentProfile.harness === 'pi') settings.extensions = { ...extensions,
        pi: { profile: { id: this.selectedAgentProfile.id, ...(this.selectedAgentProfile.revision !== undefined && { revision: this.selectedAgentProfile.revision }) }, snapshot: false } };
    }
    if (!this.agentId || Object.keys(settings).length) params.settings = settings;
    if (this.agentId && Object.keys(params).length === 2) throw new Error('No changes to save');
    return params;
  }
}
