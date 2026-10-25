import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

export type Level = 0 | 1 | 2 | 3 | 4;
export const LEVEL_NAMES = ['hidden', 'summary', 'extended', 'full', 'raw'] as const;
export const TABLE_FIELDS = ['name', 'status', 'model', 'event', 'error', 'harness', 'provider', 'cwd', 'session', 'revision'] as const;
export type TableField = typeof TABLE_FIELDS[number];
export const DEFAULT_TABLE_FIELDS: readonly TableField[] = ['name', 'status', 'model', 'event'];
export const DEFAULT_LEVELS: Record<string, Level> = {
  'agent.created': 0, 'agent.error': 0, 'agent.modified': 0, 'agent.plan': 0, 'agent.removed': 0,
  'agent.session_replaced': 0, 'agent.state': 0, 'agent.update': 0, 'operation.changed': 0,
  'permission.requested': 0, 'permission.resolved': 0, 'plugin.error': 0, 'prompt.cancelling': 0,
  'prompt.finished': 0, 'prompt.started': 0, 'server.ready': 0, 'server.stopped': 0,
  'agent.message': 3,
  'prompt.queued': 3,
  'tool.update': 3,
  'tool.result': 2,
  'tool.call:mcp__agentorg__prompt_subagent': 3,
  'tool.call:mcp__agentorg__prompt_parent': 3,
  'tool.call:cancel_operation': 2,
  'tool.result:bash': 2,
  'tool.result:mcp__agentorg__modify_subagent': 2,
  'tool.result:mcp__agentorg__get_completion': 2,
  'tool.result:cancel_operation': 2,
  'tool.result:create_subagent': 2,
  'tool.result:get_completion': 2,
  'tool.result:get_operation': 2,
  'tool.result:get_subagent': 2,
  'tool.result:mcp__agentorg__cancel_operation': 2,
  'tool.result:mcp__agentorg__create_subagent': 2,
  'tool.result:mcp__agentorg__get_operation': 2,
  'tool.result:mcp__agentorg__get_subagent': 2,
  'tool.result:mcp__agentorg__prompt_subagent': 2,
  'tool.result:mcp__agentorg__prompt_parent': 2,
  'tool.result:mcp__agentorg__remove_subagent': 2,
};
export const COLOR_OPTIONS = ['default', 'black', 'red', 'green', 'yellow', 'orange', 'blue', 'magenta', 'cyan', 'white', 'gray'] as const;
export const COLOR_SETTINGS = {
  selectionBg: 'Selection background', selectionFg: 'Selection text', title: 'Title', headings: 'Table headings',
  notice: 'Notices', footerBg: 'Footer background', footerFg: 'Footer text', border: 'Borders',
  eventHeading: 'Event headings', eventCode: 'Event code', eventLink: 'Event links', toolCall: 'Tool call',
  toolUpdate: 'Tool update', toolSuccess: 'Tool success', toolFailure: 'Tool failure', agentTarget: 'Agent target', diffAdd: 'Diff additions', diffRemove: 'Diff deletions', hiddenRows: 'Hidden event rows',
} as const;
export type ColorSetting = keyof typeof COLOR_SETTINGS;
export const DEFAULT_COLORS: Record<ColorSetting, string> = {
  selectionBg: 'blue', selectionFg: 'white', title: 'cyan', headings: 'gray', notice: 'yellow',
  footerBg: 'white', footerFg: 'black', border: 'cyan', eventHeading: 'cyan', eventCode: 'yellow',
  eventLink: 'blue', toolCall: 'yellow', toolUpdate: 'orange', toolSuccess: 'green', toolFailure: 'red', agentTarget: 'cyan',
  diffAdd: 'green', diffRemove: 'red', hiddenRows: 'gray',
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
  levels: Record<string, Level> = { ...DEFAULT_LEVELS };
  /** Subtype defaults explicitly set to inherit their parent level. */
  inheritedLevels = new Set<string>();
  tableFields: TableField[] = [...DEFAULT_TABLE_FIELDS];
  compactToolCalls = false;
  colors: Record<ColorSetting, string> = { ...DEFAULT_COLORS };
  color(key: ColorSetting): string { return resolveColor(this.colors, key); }
  visible(type: string, subtype?: string): boolean { return this.level(type, subtype) !== 0; }
  level(type: string, subtype?: string): Level {
    const key = subtype ? `${type}:${subtype}` : type;
    const parent = type.split(':')[0]!;
    if (this.inheritedLevels.has(key)) return this.levels[parent] ?? 1;
    return this.levels[key] ?? this.levels[parent] ?? 1;
  }
  types(discovered: Iterable<string>): string[] {
    return [...new Set([...EVENT_TYPES, ...discovered, ...Object.keys(this.levels), ...this.inheritedLevels])].sort();
  }
  static async load(path: string): Promise<Settings> {
    const settings = new Settings();
    try {
      const data = JSON.parse(await readFile(path, 'utf8'));
      if (!data.levels || typeof data.levels !== 'object' || Array.isArray(data.levels) ||
          (data.inheritedLevels !== undefined && (!Array.isArray(data.inheritedLevels) || !data.inheritedLevels.every((v: unknown) => typeof v === 'string' && v.length > 0 && v.length <= 256)))) throw new Error('Invalid settings format');
      if (data.history !== undefined) settings.history = historySettings(data.history);
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
      settings.levels = { ...DEFAULT_LEVELS };
      for (const [type, level] of Object.entries(data.levels)) {
        if (![0, 1, 2, 3, 4].includes(level as number)) throw new Error(`Invalid rendering level for ${type}`);
        settings.levels[type] = level as Level;
      }
      if (data.inheritedLevels !== undefined) settings.inheritedLevels = new Set(data.inheritedLevels);
      else {
        // Legacy configs had no tombstones. A missing per-tool override meant
        // inherit from its event type, so retain that behavior for old files.
        settings.inheritedLevels = new Set(Object.keys(DEFAULT_LEVELS).filter(type => type.includes(':') && !Object.hasOwn(data.levels, type)));
      }
      for (const type of settings.inheritedLevels) delete settings.levels[type];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    return settings;
  }
  async save(path: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify({ levels: this.levels, inheritedLevels: [...this.inheritedLevels].sort(), tableFields: this.tableFields, compactToolCalls: this.compactToolCalls, colors: this.colors, history: this.history }, null, 2) + '\n', { mode: 0o600 });
    await rename(temporary, path);
  }
}
