import { Marked, type MarkedExtension } from 'marked';
import { markedTerminal } from 'marked-terminal';
import stringWidth from 'string-width';
import stripAnsi from 'strip-ansi';
import wrapAnsi from 'wrap-ansi';
import type { ServerEvent } from './protocol.js';
import type { Level, Settings } from './settings.js';
import { appendMessageChunk, object, truncated } from './store.js';

/** Never let remote text send terminal commands or blessed markup. */
export function clean(value: string): string {
  return stripAnsi(value).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '').replace(/\t/g, '    ');
}
export function clip(value: string, width: number): string {
  const text = clean(value).replace(/\n/g, ' ');
  if (width <= 0) return '';
  if (stringWidth(text) <= width) return text;
  let result = '';
  // Preserve combining sequences and emoji when truncating by terminal cells.
  for (const { segment } of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)) {
    if (stringWidth(result + segment) > width - 1) break;
    result += segment;
  }
  return result + '…';
}
export function cell(value: string, width: number): string {
  const text = clip(value, width);
  return text + ' '.repeat(Math.max(0, width - stringWidth(text)));
}
const pretty = (value: unknown) => JSON.stringify(value, null, 2) ?? String(value);
const textContent = (value: unknown): string => {
  const content = object(value);
  if (typeof content.text === 'string') return content.text;
  if (content.type === 'content') return textContent(content.content);
  if (Array.isArray(value)) return value.map(textContent).join('\n');
  return pretty(value);
};

export function eventText(event: ServerEvent): string {
  const data = object(event.data);
  if (truncated(data)) return `[TRUNCATED · ${data.originalBytes} bytes]\n${data.preview}`;
  switch (event.type) {
    case 'agent.message': return textContent(data.content ?? event.data);
    case 'prompt.queued': return typeof data.text === 'string' ? data.text : pretty(event.data);
    case 'agent.created': case 'agent.modified': return `${data.name ?? data.id} · ${data.state ?? ''} · ${data.settings?.model ?? ''}`;
    case 'agent.state': return `${data.state ?? 'unknown'}${data.error ? ` · ${data.error}` : ''}`;
    case 'agent.removed': return `Removed ${data.removedAt ?? ''}`;
    case 'prompt.started': case 'prompt.cancelling': case 'prompt.finished':
      return `${data.status ?? event.type.split('.')[1]} · ${data.operationId ?? ''}`;
    case 'operation.changed':
      // Prompt result.text is not another assistant chunk.
      return `${data.type ?? 'operation'} · ${data.status ?? ''}${data.error ? ` · ${data.error.message}` : ''}`;
    case 'tool.call': case 'tool.update': case 'tool.result': {
      const title = `${data.title ?? data.toolCallId ?? 'Tool'} · ${data.status ?? 'pending'}`;
      const details: string[] = [];
      if (data.rawInput !== undefined) details.push(`Input:\n${typeof data.rawInput === 'string' ? data.rawInput : pretty(data.rawInput)}`);
      if (data.rawOutput !== undefined) details.push(`Output:\n${textContent(data.rawOutput)}`);
      else if (data.content !== undefined) details.push(textContent(data.content));
      return [title, ...details].join('\n\n');
    }
    case 'agent.plan':
      return Array.isArray(data.entries) ? data.entries.map((entry: any) => `- [${entry.status === 'completed' ? 'x' : ' '}] ${entry.content} (${entry.status})`).join('\n') : pretty(event.data);
    case 'permission.requested':
      return `${data.toolCall?.title ?? 'Permission required'}\n${Array.isArray(data.options) ? data.options.map((option: any) => option.name).join(' / ') : ''}`;
    case 'agent.error': case 'plugin.error': return `${data.code ? `${data.code}: ` : ''}${data.message ?? pretty(event.data)}`;
    default: return pretty(event.data);
  }
}

const markdownCache = new Map<number | 'summary', Marked>();
function markdown(text: string, width: number, summary = false): string {
  const key = summary ? 'summary' : width;
  let parser = markdownCache.get(key);
  if (!parser) {
    const style = (codes: string) => (value: string) => `\x1b[${codes}m${value}\x1b[0m`;
    parser = new Marked(markedTerminal({
      width, reflowText: !summary, emoji: false,
      heading: style('1;36'), firstHeading: style('1;36'), strong: style('1'),
      em: style('3'), codespan: style('33'), blockquote: style('90'),
      link: style('34'), href: style('4;34'),
    }) as unknown as MarkedExtension);
    if (markdownCache.size > 8) markdownCache.clear();
    markdownCache.set(key, parser);
  }
  try {
    const rendered = parser.parse(clean(text), { async: false }) as string;
    return summary ? rendered.replace(/\s+/g, ' ').trim() : wrapAnsi(rendered, width, { hard: true, trim: false }).trimEnd();
  } catch {
    return summary ? clean(text).replace(/\s+/g, ' ').trim() : wrapAnsi(clean(text), width, { hard: true, trim: false });
  }
}
/** Clip locally generated SGR styles using the same grapheme/cell limits as plain text. */
function clipStyled(value: string, width: number): string {
  if (width <= 0) return '';
  const plain = stripAnsi(value);
  if (stringWidth(plain) <= width) return value + '\x1b[0m';
  let remaining = clip(plain, width).length - 1; // Exclude the truncation marker.
  let result = '';
  for (const part of value.split(/(\x1b\[[\d;]*m)/)) {
    if (remaining === 0) break;
    if (part.startsWith('\x1b[')) result += part;
    else {
      result += part.slice(0, remaining);
      remaining -= Math.min(remaining, part.length);
    }
  }
  return result + '\x1b[0m…';
}
/** Pad locally generated styles without stripping them or leaking into the next cell. */
export function styledCell(value: string, width: number): string {
  const text = clipStyled(value, width);
  return text + ' '.repeat(Math.max(0, width - stringWidth(text)));
}
function label(event: ServerEvent): string {
  const data = object(event.data);
  if (event.type === 'agent.message') {
    if (data.sessionUpdate === 'agent_thought_chunk') return 'agent.message · thinking';
    if (data.sessionUpdate === 'user_message_chunk') return 'agent.message · user';
    if (data.sessionUpdate === 'agent_message_chunk') return 'agent.message · assistant';
  }
  if (event.type === 'prompt.queued') return 'prompt.queued · user';
  return event.type;
}
/** Tree previews render Markdown, but remain exactly one terminal-width-aware line. */
export function renderTreeEvent(event: ServerEvent, width: number): string {
  if (width <= 0) return '';
  const assistant = event.type === 'agent.message' && object(event.data).sessionUpdate === 'agent_message_chunk';
  const prefix = assistant ? '' : `${clean(label(event).split(' · ').at(-1)!).replace(/\s+/g, ' ')}: `;
  return clipStyled(prefix + markdown(eventText(event), Math.max(1, width), true), width);
}
export function renderEvent(event: ServerEvent, level: Level, width: number): string {
  width = Math.max(1, width);
  if (level === 4) return wrapAnsi(pretty(event), width, { hard: true, trim: false });
  const prefix = label(event);
  const text = clean(eventText(event));
  if (level === 1) {
    const assistant = event.type === 'agent.message' && object(event.data).sessionUpdate === 'agent_message_chunk';
    return clip(assistant ? text : `${prefix.split(' · ').at(-1)}: ${text}`, width);
  }
  if (level === 2) {
    const lines = wrapAnsi(`${clean(prefix)}: ${text}`, width, { hard: true, trim: false }).split('\n');
    if (lines.length > 2) lines[1] = clip(lines[1]! + ' …', width);
    return lines.slice(0, 2).join('\n');
  }
  const header = clip(`${event.time} · ${prefix}${event.generation ? ` · ${event.generation.slice(0, 8)}` : ''}`, width);
  return `\x1b[90m${header}\x1b[0m\n${markdown(text, width)}`;
}

/** Coalesce only contiguous compatible text chunks. Raw keeps every wire record. */
export function chatGroups(events: ServerEvent[], settings: Settings): ServerEvent[] {
  const groups: ServerEvent[] = [];
  let adjacent = false;
  for (const event of events) {
    if (!settings.tracked(event.type)) { adjacent = false; continue; }
    const previous = adjacent ? groups[groups.length - 1] : undefined;
    const merged = settings.level(event.type) !== 4 ? appendMessageChunk(previous, event) : undefined;
    if (merged && previous) {
      groups[groups.length - 1] = { ...previous, data: merged.data };
    } else groups.push(event);
    adjacent = true;
  }
  return groups;
}
