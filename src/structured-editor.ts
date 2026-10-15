export type EditorKind = 'text' | 'number' | 'boolean' | 'string-map' | 'object-map' | 'list' | 'directory' | 'path' | 'directories' | 'paths';
export interface FieldSpec { editor: EditorKind; label?: string; sensitive?: boolean; genericList?: boolean }
export interface PluginField extends FieldSpec { namespace: string; key: string }
const kinds: EditorKind[] = ['text', 'number', 'boolean', 'string-map', 'object-map', 'list', 'directory', 'path', 'directories', 'paths'];
/** Ignore unsupported/malformed hints from newer servers; never run plugin code. */
export function pluginFields(value: unknown): PluginField[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const result: PluginField[] = [];
  for (const [namespace, descriptor] of Object.entries(value).slice(0, 128)) {
    if (!/^[a-z][a-z0-9.-]*$/.test(namespace) || !descriptor || typeof descriptor !== 'object') continue;
    const fields = (descriptor as { fields?: unknown }).fields;
    if (!Array.isArray(fields)) continue;
    const seen = new Set<string>();
    for (const field of fields.slice(0, 128)) {
      if (!field || typeof field !== 'object' || typeof field.key !== 'string' || field.key.length > 128 || !/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(field.key) || seen.has(field.key) || !kinds.includes(field.editor)) continue;
      seen.add(field.key);
      result.push({ namespace, key: field.key, editor: field.editor, ...(typeof field.label === 'string' && field.label.length > 0 && field.label.length <= 128 && { label: field.label }), ...(field.sensitive === true && { sensitive: true }) });
    }
  }
  return result;
}
export type ValueType = 'string' | 'number' | 'boolean' | 'null' | 'json';
export const collection = (kind: EditorKind): boolean => !['text', 'number', 'boolean', 'directory', 'path'].includes(kind);
export function parseTyped(text: string, type: ValueType): unknown {
  if (type === 'string') return text;
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error(`Enter a valid ${type} value`); }
  if (type !== 'json' && (type === 'null' ? value !== null : typeof value !== type)) throw new Error(`Enter a valid ${type} value`);
  if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('Number must be finite');
  return value;
}
export function valueType(value: unknown): ValueType {
  return value === null ? 'null' : ['string', 'number', 'boolean'].includes(typeof value) ? typeof value as ValueType : 'json';
}
export function previewValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.length} entries; edit to inspect]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).length} fields; edit to inspect}`;
  return valueText(value);
}
export function valueText(value: unknown): string { return typeof value === 'string' ? value : JSON.stringify(value); }

/** Independent, reusable map/list transaction; no network or widget dependencies. */
export class StructuredEditor {
  private draft: Record<string, unknown> | unknown[];
  filter = '';
  constructor(readonly spec: FieldSpec, text: string) {
    this.draft = this.parse(text);
  }
  get isMap(): boolean { return ['string-map', 'object-map'].includes(this.spec.editor); }
  private parse(text: string): Record<string, unknown> | unknown[] {
    let value: unknown;
    try { value = JSON.parse(text); } catch { throw new Error('Invalid JSON; draft retained'); }
    if (this.isMap) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected an object');
      if (this.spec.editor === 'string-map' && Object.values(value).some(v => typeof v !== 'string')) throw new Error('Values must be strings');
    } else if (!Array.isArray(value) || (!this.spec.genericList && value.some(v => typeof v !== 'string' || !v.trim()))) throw new Error('Expected a list of nonempty strings');
    return structuredClone(value) as Record<string, unknown> | unknown[];
  }
  entries(): { id: string; key: string; value: unknown }[] {
    const entries = this.isMap ? Object.entries(this.draft).map(([key, value]) => ({ id: key, key, value })) :
      (this.draft as unknown[]).map((value, index) => ({ id: String(index), key: '', value }));
    // Never filter secrets by value: hidden values must not leak through matches.
    return entries.filter(entry => (this.isMap ? entry.key : String(entry.value)).toLowerCase().includes(this.filter.toLowerCase()));
  }
  put(id: string | undefined, key: string, value: unknown): void {
    if (this.isMap) {
      if (!key.trim()) throw new Error('Name cannot be blank');
      if (key !== id && Object.hasOwn(this.draft, key)) throw new Error(`Name ${key} already exists`);
      if (this.spec.editor === 'string-map' && typeof value !== 'string') throw new Error('Value must be a string');
      // Define, rather than assign, to safely support names such as __proto__.
      const next = { ...this.draft } as Record<string, unknown>;
      if (id !== undefined && id !== key) delete next[id];
      Object.defineProperty(next, key, { value, enumerable: true, configurable: true, writable: true });
      this.draft = next;
    } else {
      if (!this.spec.genericList && (typeof value !== 'string' || !value.trim())) throw new Error('Entry cannot be blank');
      const next = [...this.draft as unknown[]];
      if (id === undefined) next.push(value); else next[Number(id)] = value;
      this.draft = next;
    }
  }
  remove(id: string): void {
    if (this.isMap) delete (this.draft as Record<string, unknown>)[id];
    else (this.draft as unknown[]).splice(Number(id), 1);
  }
  raw(text: string): void { this.draft = this.parse(text); }
  serialize(): string { return JSON.stringify(this.draft); }
}
