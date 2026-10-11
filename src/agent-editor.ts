import type { Agent } from './protocol.js';
import { StructuredEditor, collection, parseTyped, valueText, type PluginField, type FieldSpec } from './structured-editor.js';

export const AGENT_FIELDS = ['name', 'harness', 'provider', 'model', 'cwd', 'metadata', 'env', 'options', 'extensions'] as const;
export const PODMAN_FIELDS = ['containerImage', 'readOnlyDirs', 'readWriteDirs', 'readOnlyVolumes', 'readWriteVolumes'] as const;
export type AgentField = typeof AGENT_FIELDS[number] | typeof PODMAN_FIELDS[number] | `plugin:${string}:${string}`;
export type ImageScope = 'node' | 'inherited' | 'all';
const maps = new Set<AgentField>(['metadata', 'env', 'options', 'extensions']);

/** Keeps the revision and target captured at open; live updates never overwrite a draft. */
export class AgentEditor {
  readonly values: Record<AgentField, string>;
  private readonly original: Record<AgentField, string>;
  readonly agentId?: string;
  readonly revision?: number;
  readonly fields: readonly AgentField[];
  private readonly podmanEnabled: boolean;
  private readonly volumesEnabled: boolean;
  private readonly pluginSpecs = new Map<AgentField, PluginField>();
  private readonly explicit = new Set<AgentField>();
  constructor(readonly parentId: string | null, agent?: Agent, podmanEnabled = false, pluginFields: PluginField[] = [], volumesEnabled = false) {
    this.podmanEnabled = podmanEnabled || !!agent?.settings.extensions?.podman;
    const grants = agent?.settings.extensions?.podman as Record<string, unknown> | undefined;
    this.volumesEnabled = volumesEnabled || !!grants?.readOnlyVolumes || !!grants?.readWriteVolumes;
    for (const spec of pluginFields) {
      if (this.podmanEnabled && spec.namespace === 'podman' && ['image', 'readOnlyDirs', 'readWriteDirs', 'readOnlyVolumes', 'readWriteVolumes'].includes(spec.key)) continue;
      this.pluginSpecs.set(`plugin:${spec.namespace}:${spec.key}`, { ...spec });
    }
    this.fields = [...AGENT_FIELDS, ...(this.podmanEnabled ? PODMAN_FIELDS.filter(field => this.volumesEnabled || !field.endsWith('Volumes')) : []), ...this.pluginSpecs.keys()];
    this.agentId = agent?.id;
    this.revision = agent?.revision;
    this.values = Object.fromEntries(AGENT_FIELDS.map(field => {
      const value = field === 'name' ? agent?.name ?? 'agent' : field === 'metadata' ? agent?.metadata : agent?.settings[field];
      return [field, maps.has(field) ? JSON.stringify(value ?? {}) : String(value ?? '')];
    })) as Record<AgentField, string>;
    const podman = agent?.settings.extensions?.podman as { image?: string | null; readOnlyDirs?: string[]; readWriteDirs?: string[]; readOnlyVolumes?: string[]; readWriteVolumes?: string[] } | undefined;
    this.values.containerImage = podman?.image ?? '';
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
  private empty(spec: FieldSpec): string {
    return spec.editor.endsWith('-map') ? '{}' : collection(spec.editor) ? '[]' : spec.editor === 'number' ? '0' : spec.editor === 'boolean' ? 'false' : '';
  }
  label(field: AgentField): string {
    const spec = this.pluginSpecs.get(field);
    return spec ? `${spec.namespace}.${spec.label ?? spec.key}` : field;
  }
  stage(field: AgentField, text: string): void {
    const spec = this.pluginSpecs.get(field);
    if (spec && ['number', 'boolean'].includes(spec.editor)) parseTyped(text, spec.editor as 'number' | 'boolean');
    this.values[field] = text;
    if (spec) this.explicit.add(field);
  }
  spec(field: AgentField): FieldSpec {
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
    if (field === 'harness') this.values.provider = '';
    if (field !== 'model') this.values.model = '';
  }
  get imageChanged(): boolean {
    if (this.values.containerImage !== this.original.containerImage) return true;
    if (this.values.extensions === this.original.extensions) return false;
    try {
      const image = (JSON.parse(this.values.extensions).podman?.image ?? '') as string;
      return image !== this.original.containerImage;
    } catch { return false; }
  }
  params(): Record<string, unknown> {
    const params: Record<string, unknown> = this.agentId ? { agentId: this.agentId, expectedRevision: this.revision } : { parentId: this.parentId };
    const settings: Record<string, unknown> = {};
    for (const field of AGENT_FIELDS) {
      if (this.agentId && this.values[field] === this.original[field]) continue;
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
      if (field === 'name' || field === 'metadata') params[field] = value;
      else settings[field] = value;
    }
    if (this.podmanEnabled && (!this.agentId || PODMAN_FIELDS.some(field => this.values[field] !== this.original[field]))) {
      const grants = (field: 'readOnlyDirs' | 'readWriteDirs' | 'readOnlyVolumes' | 'readWriteVolumes'): string[] => {
        let value: unknown;
        const message = `${field} must be a JSON array of ${field.endsWith('Volumes') ? 'volume names' : 'paths'}`;
        try { value = JSON.parse(this.values[field]); } catch { throw new Error(message); }
        if (!Array.isArray(value) || value.some(p => typeof p !== 'string' || !p.trim())) throw new Error(message);
        return value;
      };
      const extensions = (settings.extensions ?? JSON.parse(this.values.extensions)) as Record<string, unknown>;
      if (this.agentId && this.values.extensions !== this.original.extensions && Object.hasOwn(extensions, 'podman')) throw new Error('Edit Podman fields or extensions.podman, not both');
      settings.extensions = { ...extensions, podman: { image: this.values.containerImage.trim() || null, readOnlyDirs: grants('readOnlyDirs'), readWriteDirs: grants('readWriteDirs'), ...(this.volumesEnabled && { readOnlyVolumes: grants('readOnlyVolumes'), readWriteVolumes: grants('readWriteVolumes') }) } };
    }
    const originalExtensions = JSON.parse(this.original.extensions) as Record<string, unknown>;
    const rawExtensions = JSON.parse(this.values.extensions) as Record<string, unknown>;
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
    if (!this.agentId || Object.keys(settings).length) params.settings = settings;
    if (this.agentId && Object.keys(params).length === 2) throw new Error('No changes to save');
    return params;
  }
}
