import type { ServerSettingsField, ServerSettingsGroup } from './protocol.js';
import { parseTyped, valueText } from './structured-editor.js';

/** A revision-fenced server draft, never stored in client preferences. */
export class ServerSettingsEditor {
  readonly group: ServerSettingsGroup;
  readonly values: Record<string, string>;
  private patch = new Set<string>();
  private resets = new Set<string>();
  private inherited = new Set<string>();
  constructor(group: ServerSettingsGroup) {
    this.group = structuredClone(group);
    this.values = Object.fromEntries(group.fields.map(field => {
      const value = group.values[field.key];
      if (value === undefined && field.optional) this.inherited.add(field.key);
      return [field.key, valueText(value ?? (field.editor === 'list' ? [] : field.editor.endsWith('-map') ? {} : field.editor === 'select' ? field.choices![0] : field.editor === 'number' ? 0 : field.editor === 'boolean' ? false : ''))];
    }));
  }
  get fields(): ServerSettingsField[] { return this.group.fields.filter(field => !field.deprecated && !(this.group.namespace === 'skills' && field.key === 'repositories')); }
  private parse(field: ServerSettingsField, text: string): unknown {
    const value = parseTyped(text, field.editor === 'text' || field.editor === 'select' ? 'string' : field.editor === 'number' ? 'number' : field.editor === 'boolean' ? 'boolean' : 'json');
    if (field.editor === 'number' && ((field.min !== undefined && (value as number) < field.min) || (field.max !== undefined && (value as number) > field.max))) throw new Error(`Value must be between ${field.min ?? '−∞'} and ${field.max ?? '∞'}`);
    if (field.editor === 'select' && !field.choices?.includes(value as string)) throw new Error(`Choose: ${field.choices?.join(', ')}`);
    if (field.editor === 'list' && !Array.isArray(value)) throw new Error('Expected a list');
    if (['string-map', 'object-map'].includes(field.editor) && (!value || typeof value !== 'object' || Array.isArray(value))) throw new Error('Expected an object');
    if (field.editor === 'string-map' && Object.values(value as object).some(v => typeof v !== 'string')) throw new Error('Values must be strings');
    return value;
  }
  stage(field: ServerSettingsField, text: string) {
    this.values[field.key] = valueText(this.parse(field, text));
    this.inherited.delete(field.key);
    this.patch.add(field.key); this.resets.delete(field.key);
  }
  reset(field: ServerSettingsField) {
    const value = this.group.defaults[field.key];
    if (value === undefined && field.optional) this.inherited.add(field.key);
    else { this.inherited.delete(field.key); this.values[field.key] = valueText(value); }
    this.patch.delete(field.key); this.resets.add(field.key);
  }
  valuesObject(): Record<string, unknown> { return Object.fromEntries(this.group.fields.filter(f => !this.inherited.has(f.key)).map(f => [f.key, this.parse(f, this.values[f.key]!)])); }
  inherits(key: string): boolean { return this.inherited.has(key); }
  get dirty() { return this.patch.size > 0 || this.resets.size > 0; }
  state(key: string) { return this.inherited.has(key) ? 'inherited (reset to omit)' : this.resets.has(key) ? 'reset draft' : this.patch.has(key) ? 'edited draft' : this.group.overridden.includes(key) ? 'saved override' : 'default'; }
  params() {
    return { namespace: this.group.namespace, expectedRevision: this.group.revision,
      patch: Object.fromEntries(this.group.fields.filter(f => this.patch.has(f.key)).map(f => [f.key, this.parse(f, this.values[f.key]!)])), reset: [...this.resets] };
  }
}
