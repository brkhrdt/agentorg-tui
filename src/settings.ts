import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

export type Level = 1 | 2 | 3 | 4;
export const LEVEL_NAMES = ['summary', 'extended', 'full', 'raw'] as const;
export const TABLE_FIELDS = ['name', 'status', 'model', 'event', 'error', 'harness', 'provider', 'cwd', 'session', 'revision'] as const;
export type TableField = typeof TABLE_FIELDS[number];
export const DEFAULT_TABLE_FIELDS: readonly TableField[] = ['name', 'status', 'model', 'event'];
export function normalizeTableFields(value: unknown): TableField[] {
  const fields = Array.isArray(value)
    ? [...new Set(value.filter((field): field is TableField => TABLE_FIELDS.includes(field)))]
    : [];
  return fields.length ? fields : [...DEFAULT_TABLE_FIELDS];
}
export const EVENT_TYPES = [
  'server.ready', 'server.stopped', 'agent.created', 'agent.state', 'agent.modified',
  'agent.removed', 'agent.session_replaced', 'agent.error', 'prompt.queued',
  'prompt.started', 'prompt.cancelling', 'prompt.finished', 'operation.changed',
  'agent.message', 'tool.call', 'tool.update', 'tool.result', 'agent.plan',
  'agent.update', 'permission.requested', 'permission.resolved', 'plugin.error',
];
export const defaultConfigPath = () => join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'org-tui', 'settings.json');

export class Settings {
  excluded = new Set([
    'agent.created', 'agent.error', 'agent.modified', 'agent.plan', 'agent.removed',
    'agent.session_replaced', 'agent.state', 'agent.update', 'operation.changed',
    'permission.requested', 'permission.resolved', 'plugin.error', 'prompt.cancelling',
    'prompt.finished', 'prompt.started', 'server.ready', 'server.stopped',
  ]);
  levels: Record<string, Level> = { 'agent.message': 3, 'prompt.queued': 3, 'tool.update': 3, 'tool.result': 2, 'agent.plan': 3 };
  tableFields: TableField[] = [...DEFAULT_TABLE_FIELDS];
  compactToolCalls = false;
  tracked(type: string): boolean { return !this.excluded.has(type); }
  level(type: string, subtype?: string): Level {
    const key = subtype ? `${type}:${subtype}` : type;
    return this.levels[key] ?? this.levels[type.split(':')[0]!] ?? 1;
  }
  toggle(type: string): void {
    if (!this.excluded.delete(type)) this.excluded.add(type);
  }
  types(discovered: Iterable<string>): string[] {
    return [...new Set([...EVENT_TYPES, ...discovered, ...this.excluded, ...Object.keys(this.levels)])].sort();
  }
  static async load(path: string): Promise<Settings> {
    const settings = new Settings();
    try {
      const data = JSON.parse(await readFile(path, 'utf8'));
      if (!Array.isArray(data.excluded) || !data.excluded.every((v: unknown) => typeof v === 'string') ||
          !data.levels || typeof data.levels !== 'object' || Array.isArray(data.levels)) throw new Error('Invalid settings format');
      settings.excluded = new Set(data.excluded);
      settings.tableFields = normalizeTableFields(data.tableFields);
      if (data.compactToolCalls !== undefined && typeof data.compactToolCalls !== 'boolean') throw new Error('Invalid compactToolCalls setting');
      settings.compactToolCalls = data.compactToolCalls ?? false;
      settings.levels = {};
      for (const [type, level] of Object.entries(data.levels)) {
        if (![1, 2, 3, 4].includes(level as number)) throw new Error(`Invalid rendering level for ${type}`);
        settings.levels[type] = level as Level;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    return settings;
  }
  async save(path: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify({ excluded: [...this.excluded].sort(), levels: this.levels, tableFields: this.tableFields, compactToolCalls: this.compactToolCalls }, null, 2) + '\n', { mode: 0o600 });
    await rename(temporary, path);
  }
}
