import type { Agent } from './protocol.js';
import { clean } from './render.js';

const sections = [
  ['AGENT', [
    ['name', 'Name'], ['id', 'ID'], ['parentId', 'Parent ID'], ['state', 'State'],
    ['revision', 'Revision'], ['createdAt', 'Created'], ['updatedAt', 'Updated'],
    ['removedAt', 'Removed'], ['error', 'Error'],
  ]],
  ['SESSION', [['sessionId', 'Session ID'], ['sessionNumber', 'Session number'], ['generation', 'Generation']]],
  ['HARNESS SETTINGS', [['settings', 'Settings']]],
  ['METADATA / PLUGIN STATE', [['metadata', 'Metadata']]],
] as const;
const known = new Set<string>(sections.flatMap(([, fields]) => fields.map(([key]) => key)));

// Keep plugin/map keys intact, including keys that would otherwise look like
// several lines or an empty label. Values are never clipped or summarized.
const jsonText = (value: unknown, indent?: number): string => JSON.stringify(value, null, indent)
  .replace(/[\x7f-\x9f]/g, ch => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`);
const keyLabel = (key: string): string => /^[\w.:/-]+$/.test(key) ? key : jsonText(key);
function valueLines(value: unknown, indent: number, label: string): string[] {
  const prefix = ' '.repeat(indent) + label;
  if (value !== null && typeof value === 'object') {
    const entries = Array.isArray(value)
      ? value.map(item => ['•', item] as const)
      : Object.entries(value).map(([key, child]) => [`${keyLabel(key)}:`, child] as const);
    if (!entries.length) return [`${prefix} ${Array.isArray(value) ? '[]' : '{}'}`];
    return [prefix, ...entries.flatMap(([key, child]) => valueLines(child, indent + 2, key))];
  }
  const text = typeof value === 'string' ? clean(value) : String(value);
  if (!text) return [`${prefix} ""`];
  const lines = text.split('\n');
  return lines.length === 1 ? [`${prefix} ${text}`] : [prefix, ...lines.map(line => ' '.repeat(indent + 2) + line)];
}

/** Complete public agent record from the snapshot, including unknown fields. */
export function renderAgentInfo(agent: Agent, raw = false): string {
  if (raw) return jsonText(agent, 2);
  const lines: string[] = [];
  for (const [heading, fields] of sections) {
    const present = fields.filter(([key]) => Object.hasOwn(agent, key));
    if (!present.length) continue;
    if (lines.length) lines.push('');
    lines.push(heading, ...present.flatMap(([key, label]) => valueLines(agent[key], 2, `${label}:`)));
  }
  const extra = Object.entries(agent).filter(([key]) => !known.has(key));
  if (extra.length) lines.push('', 'ADDITIONAL AGENT STATE', ...extra.flatMap(([key, value]) => valueLines(value, 2, `${keyLabel(key)}:`)));
  return lines.join('\n');
}
