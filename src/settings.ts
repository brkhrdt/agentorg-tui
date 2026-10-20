import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

export type Level = 1 | 2 | 3 | 4;
export const LEVEL_NAMES = ['summary', 'extended', 'full', 'raw'] as const;
export const TABLE_FIELDS = ['name', 'status', 'model', 'event', 'error', 'harness', 'provider', 'cwd', 'session', 'revision'] as const;
export type TableField = typeof TABLE_FIELDS[number];
export const DEFAULT_TABLE_FIELDS: readonly TableField[] = ['name', 'status', 'model', 'event'];
export const COLOR_OPTIONS = ['default', 'black', 'red', 'green', 'yellow', 'orange', 'blue', 'magenta', 'cyan', 'white', 'gray'] as const;
export const COLOR_SETTINGS = {
  selectionBg: 'Selection background', selectionFg: 'Selection text', title: 'Title', headings: 'Table headings',
  notice: 'Notices', footerBg: 'Footer background', footerFg: 'Footer text', border: 'Borders',
  eventHeading: 'Event headings', eventCode: 'Event code', eventLink: 'Event links', toolCall: 'Tool call',
  toolUpdate: 'Tool update', toolSuccess: 'Tool success', toolFailure: 'Tool failure', diffAdd: 'Diff additions', diffRemove: 'Diff deletions',
} as const;
export type ColorSetting = keyof typeof COLOR_SETTINGS;
export const DEFAULT_COLORS: Record<ColorSetting, string> = {
  selectionBg: 'blue', selectionFg: 'white', title: 'cyan', headings: 'gray', notice: 'yellow',
  footerBg: 'white', footerFg: 'black', border: 'cyan', eventHeading: 'cyan', eventCode: 'yellow',
  eventLink: 'blue', toolCall: 'yellow', toolUpdate: 'orange', toolSuccess: 'green', toolFailure: 'red',
  diffAdd: 'green', diffRemove: 'red',
};
export const ANSI_COLORS: Record<string, string> = { default: '39', black: '30', red: '31', green: '32', yellow: '33', orange: '38;5;208', blue: '34', magenta: '35', cyan: '36', white: '37', gray: '90' };
export function ansiColor(color: string, background = false): string {
  const code = ANSI_COLORS[color] ?? '39';
  if (!background) return code;
  if (code === '39') return '49';
  if (code.startsWith('38;')) return code.replace(/^38;/, '48;');
  return String(Number(code) + 10);
}
/** Use the same validated palette for widget styles and ANSI-rendered content. */
export function resolveColor(colors: Partial<Record<ColorSetting, string>>, key: ColorSetting): string {
  const color = colors[key];
  return COLOR_OPTIONS.includes(color as typeof COLOR_OPTIONS[number]) ? color! : DEFAULT_COLORS[key];
}
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

export const HISTORY_FIELDS = {
  recentEvents: 'Cached events (maximum)', chatPageSize: 'Chat page size (events)',
  cacheBytes: 'Cache payload budget (bytes)', idleMinutes: 'Inactive chat expiry (minutes)',
} as const;
export interface HistorySettings { recentEvents: number; chatPageSize: number; cacheBytes: number; idleMinutes: number }
export const DEFAULT_HISTORY: Readonly<HistorySettings> = { recentEvents: 2000, chatPageSize: 200, cacheBytes: 32 * 1024 * 1024, idleMinutes: 10 };
export function historySettings(value: unknown): HistorySettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid history settings');
  const settings = { ...DEFAULT_HISTORY, ...value };
  for (const key of Object.keys(settings)) {
    const v = settings[key as keyof HistorySettings];
    if (!Object.hasOwn(HISTORY_FIELDS, key) || !Number.isSafeInteger(v) || v < (key === 'cacheBytes' ? 1024 : 1)) throw new Error(`Invalid history setting: ${key}`);
  }
  return settings;
}

export class Settings {
  history: HistorySettings = { ...DEFAULT_HISTORY };
  excluded = new Set([
    'agent.created', 'agent.error', 'agent.modified', 'agent.plan', 'agent.removed',
    'agent.session_replaced', 'agent.state', 'agent.update', 'operation.changed',
    'permission.requested', 'permission.resolved', 'plugin.error', 'prompt.cancelling',
    'prompt.finished', 'prompt.started', 'server.ready', 'server.stopped',
  ]);
  levels: Record<string, Level> = { 'agent.message': 3, 'prompt.queued': 3, 'tool.update': 3, 'tool.result': 2, 'agent.plan': 3 };
  tableFields: TableField[] = [...DEFAULT_TABLE_FIELDS];
  compactToolCalls = false;
  colors: Record<ColorSetting, string> = { ...DEFAULT_COLORS };
  color(key: ColorSetting): string { return resolveColor(this.colors, key); }
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
      if (data.history !== undefined) settings.history = historySettings(data.history);
      settings.excluded = new Set(data.excluded);
      settings.tableFields = normalizeTableFields(data.tableFields);
      if (data.compactToolCalls !== undefined && typeof data.compactToolCalls !== 'boolean') throw new Error('Invalid compactToolCalls setting');
      settings.compactToolCalls = data.compactToolCalls ?? false;
      if (data.colors !== undefined) {
        if (!data.colors || typeof data.colors !== 'object' || Array.isArray(data.colors)) throw new Error('Invalid colors setting');
        for (const key of Object.keys(DEFAULT_COLORS) as ColorSetting[]) {
          const color = data.colors[key];
          if (color !== undefined) {
            if (!COLOR_OPTIONS.includes(color)) throw new Error(`Invalid color for ${key}`);
            settings.colors[key] = color;
          }
        }
      }
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
    await writeFile(temporary, JSON.stringify({ excluded: [...this.excluded].sort(), levels: this.levels, tableFields: this.tableFields, compactToolCalls: this.compactToolCalls, colors: this.colors, history: this.history }, null, 2) + '\n', { mode: 0o600 });
    await rename(temporary, path);
  }
}
