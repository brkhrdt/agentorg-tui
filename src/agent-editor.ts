import type { Agent } from './protocol.js';

export const AGENT_FIELDS = ['name', 'harness', 'provider', 'model', 'cwd', 'metadata', 'env', 'options', 'extensions'] as const;
export const PODMAN_FIELDS = ['containerImage', 'readOnlyDirs', 'readWriteDirs'] as const;
export type AgentField = typeof AGENT_FIELDS[number] | typeof PODMAN_FIELDS[number];
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
  constructor(readonly parentId: string | null, agent?: Agent, podmanEnabled = false) {
    this.podmanEnabled = podmanEnabled || !!agent?.settings.extensions?.podman;
    this.fields = this.podmanEnabled ? [...AGENT_FIELDS, ...PODMAN_FIELDS] : AGENT_FIELDS;
    this.agentId = agent?.id;
    this.revision = agent?.revision;
    this.values = Object.fromEntries(AGENT_FIELDS.map(field => {
      const value = field === 'name' ? agent?.name ?? 'agent' : field === 'metadata' ? agent?.metadata : agent?.settings[field];
      return [field, maps.has(field) ? JSON.stringify(value ?? {}) : String(value ?? '')];
    })) as Record<AgentField, string>;
    const podman = agent?.settings.extensions?.podman as { image?: string | null; readOnlyDirs?: string[]; readWriteDirs?: string[] } | undefined;
    this.values.containerImage = podman?.image ?? '';
    this.values.readOnlyDirs = JSON.stringify(podman?.readOnlyDirs ?? []);
    this.values.readWriteDirs = JSON.stringify(podman?.readWriteDirs ?? []);
    this.original = { ...this.values };
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
      const grants = (field: 'readOnlyDirs' | 'readWriteDirs'): string[] => {
        let value: unknown;
        try { value = JSON.parse(this.values[field]); } catch { throw new Error(`${field} must be a JSON array of paths`); }
        if (!Array.isArray(value) || value.some(p => typeof p !== 'string' || !p.trim())) throw new Error(`${field} must be a JSON array of paths`);
        return value;
      };
      const extensions = (settings.extensions ?? JSON.parse(this.values.extensions)) as Record<string, unknown>;
      if (this.agentId && this.values.extensions !== this.original.extensions && Object.hasOwn(extensions, 'podman')) throw new Error('Edit Podman fields or extensions.podman, not both');
      settings.extensions = { ...extensions, podman: { image: this.values.containerImage.trim() || null, readOnlyDirs: grants('readOnlyDirs'), readWriteDirs: grants('readWriteDirs') } };
    }
    if (!this.agentId || Object.keys(settings).length) params.settings = settings;
    if (this.agentId && Object.keys(params).length === 2) throw new Error('No changes to save');
    return params;
  }
}
