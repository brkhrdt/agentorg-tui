export interface CommandChoice { name: string; description: string; input?: { hint: string } }
export interface CommandSpan { start: number; query: string }
const validName = (s: string) => !!s && new TextEncoder().encode(s).length <= 128 && !s.startsWith("/") && !/[\s\p{Cc}\p{Cf}\u2028\u2029]/u.test(s);
export function validCommandList(value: unknown): value is CommandChoice[] {
  if (!Array.isArray(value) || value.length > 128 || new TextEncoder().encode(JSON.stringify(value)).length > 16 * 1024) return false;
  return value.every((x: any) => x && typeof x === 'object' && !Array.isArray(x) && validName(x.name) && typeof x.description === 'string' && x.description.length <= 512 && (x.input === undefined || x.input && typeof x.input.hint === 'string' && x.input.hint.length <= 256));
}
export function commandSpan(value: string): CommandSpan | undefined {
  const match = /(^|\s)\/([^\s]*)$/u.exec(value);
  if (!match || match[2]!.startsWith('./')) return undefined;
  return { start: match.index + match[1]!.length, query: match[2]! };
}
export function commandsForSpan(commands: readonly CommandChoice[], span: CommandSpan): CommandChoice[] {
  return span.start === 0 ? [...commands] : commands.filter(command => command.name.startsWith('skill:'));
}
export function matchCommands(commands: readonly CommandChoice[], query: string): CommandChoice[] {
  const q = query.toLocaleLowerCase();
  return commands.map((command, index) => ({ command, index, name: command.name.toLocaleLowerCase() }))
    .filter(item => item.name.startsWith(q))
    .sort((a, b) => Number(a.name !== q) - Number(b.name !== q) || a.index - b.index)
    .map(item => item.command);
}
export function acceptCommand(value: string, span: CommandSpan, selected: CommandChoice, current: readonly CommandChoice[]): string | undefined {
  const active = commandSpan(value);
  if (!active || active.start !== span.start || active.query !== span.query || !current.some(item => item.name === selected.name)) return;
  return `${value.slice(0, span.start)}/${selected.name} `;
}
