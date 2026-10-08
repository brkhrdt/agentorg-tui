import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

export type Level = 1 | 2 | 3 | 4;
export const LEVEL_NAMES = ['summary', 'extended', 'full', 'raw'] as const;
export const EVENT_TYPES = [
  'server.ready', 'server.stopped', 'agent.created', 'agent.state', 'agent.modified',
  'agent.removed', 'agent.session_replaced', 'agent.error', 'prompt.queued',
  'prompt.started', 'prompt.cancelling', 'prompt.finished', 'operation.changed',
  'agent.message', 'tool.call', 'tool.update', 'tool.result', 'agent.plan',
  'agent.update', 'permission.requested', 'permission.resolved', 'plugin.error',
];
export const defaultConfigPath = () => join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'org-tui', 'settings.json');

export class Settings {
  excluded = new Set(['operation.changed', 'tool.update', 'agent.update']);
  levels: Record<string, Level> = { 'agent.message': 3, 'prompt.queued': 3, 'tool.result': 2, 'agent.plan': 3 };
  tracked(type: string): boolean { return !this.excluded.has(type); }
  level(type: string): Level { return this.levels[type] ?? 1; }
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
    await writeFile(temporary, JSON.stringify({ excluded: [...this.excluded].sort(), levels: this.levels }, null, 2) + '\n', { mode: 0o600 });
    await rename(temporary, path);
  }
}
