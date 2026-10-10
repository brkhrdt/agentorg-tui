import type { Agent } from './protocol.js';

export const AGENT_FIELDS = ['name', 'harness', 'model', 'provider', 'cwd', 'metadata', 'env', 'options', 'extensions'] as const;
export type AgentField = typeof AGENT_FIELDS[number];
const maps = new Set<AgentField>(['metadata', 'env', 'options', 'extensions']);

/** Keeps the revision and target captured at open; live updates never overwrite a draft. */
export class AgentEditor {
  readonly values: Record<AgentField, string>;
  private readonly original: Record<AgentField, string>;
  readonly agentId?: string;
  readonly revision?: number;
  constructor(readonly parentId: string | null, agent?: Agent) {
    this.agentId = agent?.id;
    this.revision = agent?.revision;
    this.values = Object.fromEntries(AGENT_FIELDS.map(field => {
      const value = field === 'name' ? agent?.name ?? 'agent' : field === 'metadata' ? agent?.metadata : agent?.settings[field];
      return [field, maps.has(field) ? JSON.stringify(value ?? {}) : String(value ?? '')];
    })) as Record<AgentField, string>;
    this.original = { ...this.values };
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
    if (!this.agentId || Object.keys(settings).length) params.settings = settings;
    if (this.agentId && Object.keys(params).length === 2) throw new Error('No changes to save');
    return params;
  }
}
