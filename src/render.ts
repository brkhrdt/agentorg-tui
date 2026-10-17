import { Marked, type MarkedExtension } from 'marked';
import { markedTerminal } from 'marked-terminal';
import stringWidth from 'string-width';
import stripAnsi from 'strip-ansi';
import wrapAnsi from 'wrap-ansi';
import type { ServerEvent, EventRendering } from './protocol.js';
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
const isTool = (event: ServerEvent) => ['tool.call', 'tool.update', 'tool.result'].includes(event.type);
const paint = (text: string, color: string) => `\x1b[${color}m${text.replace(/\x1b\[0m/g, `\x1b[0m\x1b[${color}m`)}\x1b[0m`;
function toolColor(event: ServerEvent, tool?: string): string {
  if (event.type === 'tool.call') return '33';
  if (event.type === 'tool.update') return '38;5;208';
  const data = object(event.data), result = object(data.rawOutput);
  const exit = result.structuredContent?.exit_code ?? result.details?.exitCode ?? result.exitCode ??
    ((tool ?? data.toolName ?? data.title) === 'bash' ? textContent(data.rawOutput ?? data.content ?? '').match(/\bexit(?:ed)?(?: with)? (?:code|status):?\s*(-?\d+)/i)?.[1] : undefined);
  if (['failed', 'cancelled', 'canceled'].includes(data.status) || result.isError === true || (exit !== undefined && Number(exit) !== 0)) return '31';
  return data.status === 'completed' ? '32' : '90';
}
/** Only the symbol carries lifecycle color; edit's signed counts have independent diff colors. */
function toolHeader(text: string, event: ServerEvent, tool?: string): string {
  const plain = stripAnsi(text);
  const match = /^([\s]*)([$<>Δ•])(?=\s|$)(.*)$/u.exec(plain);
  if (!match) return plain;
  let rest = match[3]!;
  if (match[2] === 'Δ') rest = rest.replace(/( · )(\+\d+)( \/ )(-\d+)$/,
    (_all, gap: string, added: string, separator: string, removed: string) => `${gap}${paint(added, '32')}${separator}${paint(removed, '31')}`);
  return match[1] + paint(match[2]!, toolColor(event, tool)) + rest;
}
const logicalLines = (text: string) => text.split(/\r\n?|\n|\u2028|\u2029/);
const literalMarkdown = (text: string) => text.replace(/([\\`*_{}\[\]<>])/g, '\\$1');
function fenced(text: string): string {
  let longest = 2;
  for (const match of text.matchAll(/`+/g)) longest = Math.max(longest, match[0].length);
  const fence = '`'.repeat(longest + 1);
  return `${fence}\n${text}\n${fence}`;
}
/** Limit the viewport after wrapping so a long output line cannot flood chat. */
function terminalOutputTail(lines: string[], width: number, maxRows: number): { text: string; hidden: boolean } {
  const gutter = width >= 6 ? '  │ ' : width >= 3 ? '│ ' : '';
  const available = width - stringWidth(gutter);
  const rows = lines.slice(-maxRows).flatMap(line => wrapAnsi(line, available, { hard: true, trim: false }).split('\n'));
  return {
    text: rows.slice(-maxRows).map(line => paint(gutter, '90') + clip(line, available)).join('\n'),
    hidden: lines.length > maxRows || rows.length > maxRows,
  };
}
const textContent = (value: unknown): string => {
  if (typeof value === 'string') return value;
  const content = object(value);
  if (typeof content.text === 'string') return content.text;
  if (content.content !== undefined) return textContent(content.content);
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
      const tool = data.toolName ?? data.title ?? data.toolCallId ?? 'Tool', input = object(data.rawInput);
      const title = tool === 'bash' ? `$ ${input.command ?? '[command unavailable]'}` :
        ['read', 'write', 'edit'].includes(tool) ? `${tool === 'read' ? '<' : tool === 'write' ? '>' : 'Δ'} ${input.path ?? input.file_path ?? '[path unavailable]'}` : `• ${tool}`;
      const details: string[] = [];
      if (data.rawInput !== undefined) details.push(`Input:\n${fenced(typeof data.rawInput === 'string' ? data.rawInput : pretty(data.rawInput))}`);
      if (data.rawOutput !== undefined) details.push(fenced(textContent(data.rawOutput)));
      else if (data.content !== undefined) details.push(fenced(textContent(data.content)));
      if (data.status === 'failed' && details.length === 0) details.push('Tool failed');
      return [literalMarkdown(String(title).replace(/\s+/g, ' ').trim()), ...details].join('\n\n');
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
    // Semantic diff colors are local and deterministic, even without FORCE_COLOR/TTY.
    parser.use({ renderer: { code({ text, lang }) {
      if (lang?.split(/\s/)[0] !== 'diff') return false;
      let inHunk = false;
      return '\n' + text.split('\n').map(line => {
        if (line.startsWith('@@')) { inHunk = true; return paint(line, '36'); }
        if (!inHunk && /^(--- |\+\+\+ |diff --git)/.test(line)) return paint(line, '90');
        return line.startsWith('-') ? paint(line, '31') : line.startsWith('+') ? paint(line, '32') : line;
      }).join('\n') + '\n\n';
    } } });
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
export function renderTreeEvent(event: ServerEvent, width: number, rendering?: EventRendering): string {
  if (width <= 0) return '';
  const assistant = event.type === 'agent.message' && object(event.data).sessionUpdate === 'agent_message_chunk';
  const prefix = assistant || isTool(event) ? '' : `${clean(label(event).split(' · ').at(-1)!).replace(/\s+/g, ' ')}: `;
  const text = rendering ? logicalLines(rendering.summary)[0] || '—' : isTool(event) ? logicalLines(eventText(event))[0]! : eventText(event);
  const preview = prefix + markdown(text, Math.max(1, width), true);
  return clipStyled(isTool(event) ? toolHeader(preview, event, rendering?.subtype) : preview, width);
}
export function renderEvent(event: ServerEvent, level: Level, width: number, rendering?: EventRendering): string {
  width = Math.max(1, width);
  if (level === 4) return wrapAnsi(pretty(event), width, { hard: true, trim: false });
  if (!rendering && isTool(event)) {
    const full = eventText(event), data = object(event.data);
    const output = data.rawOutput ?? data.content;
    const summary = logicalLines(full)[0]!;
    rendering = { rendererId: 'client.generic-tool', summary, extended: summary + (output !== undefined ? `\n${literalMarkdown(textContent(output).replace(/\s+/g, ' ').slice(0, 240))}` : ''), full };
  }
  if (rendering) {
    const data = object(event.data);
    const output = data.rawOutput ?? data.content;
    // A renderer's extended text may be a diff or status, not streamed output.
    if (event.type === 'tool.update' && output !== undefined && (level === 2 || level === 3)) {
      const text = textContent(output);
      const lines = text === '' ? [] : logicalLines(text).map(clean);
      if (lines.length > 1 && lines.at(-1) === '') lines.pop();
      const lineCount = lines.length;
      const maxRows = level === 2 ? 1 : 5;
      const tail = terminalOutputTail(lines, width, maxRows);
      const heading = wrapAnsi(toolHeader(markdown(rendering.summary, width, true), event, rendering.subtype), width, { hard: true, trim: false });
      const count = `${lineCount} ${lineCount === 1 ? 'line' : 'lines'} received${tail.hidden ? ` · showing last ${maxRows} ${maxRows === 1 ? 'row' : 'rows'}` : ''}`;
      return heading + '\n' + paint(clip(count, width), '90') + (tail.text ? '\n' + tail.text : '');
    }
    if (level === 1) return renderTreeEvent(event, width, rendering);
    if (level === 2) {
      const diff = rendering.extendedDiff;
      if (isTool(event) && diff && [diff.prefix, diff.before, diff.after].every(text => typeof text === 'string')) {
        const prefix = clean(diff.prefix).replace(/\s+/g, ' ').trim();
        const before = clean(diff.before).replace(/\s+/g, ' '), after = clean(diff.after).replace(/\s+/g, ' ');
        const first = toolHeader(prefix, event, rendering.subtype) + ' ' + paint(before, '31');
        const second = ' '.repeat((stringWidth(prefix) + 1) % width) + paint(after, '32');
        return [first, second].map(line => wrapAnsi(line, width, { hard: true, trim: false })).join('\n');
      }
      return logicalLines(rendering.extended).slice(0, 2).map((line, index) => {
        const text = markdown(line, width, true);
        return wrapAnsi(isTool(event) && index === 0 ? toolHeader(text, event, rendering.subtype) : text, width, { hard: true, trim: false });
      }).join('\n');
    }
    if (isTool(event)) {
      const [heading, ...body] = logicalLines(rendering.full);
      return wrapAnsi(toolHeader(markdown(heading ?? '', width, true), event, rendering.subtype), width, { hard: true, trim: false }) +
        (body.join('\n').trim() ? '\n' + markdown(body.join('\n'), width) : '');
    }
    return `\x1b[90m${clip(`${event.time} · ${label(event)}`, width)}\x1b[0m\n${markdown(rendering.full, width)}`;
  }
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

/** Coalesce compatible text chunks and, optionally, replace tool lifecycle phases in chat. */
export function chatGroups(events: ServerEvent[], settings: Settings, renderings: Map<number, EventRendering> = new Map()): ServerEvent[] {
  const groups: ServerEvent[] = [];
  const toolCalls = new Map<string, number>();
  let adjacent = false;
  for (const event of events) {
    const data = object(event.data);
    const toolPhase = ['tool.call', 'tool.update', 'tool.result'].includes(event.type);
    const callId = settings.compactToolCalls && toolPhase && typeof data.toolCallId === 'string' && event.agentId
      ? `${event.agentId}\0${event.generation ?? ''}\0${data.toolCallId}` : undefined;
    const raw = settings.level(event.type, renderings.get(event.seq)?.subtype) === 4;
    if (callId && raw) toolCalls.delete(callId);
    else if (callId && !raw) {
      const priorIndex = toolCalls.get(callId);
      if (settings.tracked(event.type)) {
        if (priorIndex !== undefined) groups[priorIndex] = event;
        else {
          toolCalls.set(callId, groups.length);
          groups.push(event);
        }
      }
      if (event.type === 'tool.result') toolCalls.delete(callId);
      adjacent = false;
      continue;
    }
    if (!settings.tracked(event.type)) { adjacent = false; continue; }
    const previous = adjacent ? groups[groups.length - 1] : undefined;
    const rendering = renderings.get(event.seq);
    const merged = settings.level(event.type, rendering?.subtype) !== 4 && !rendering && !(previous && renderings.has(previous.seq)) ? appendMessageChunk(previous, event) : undefined;
    if (merged && previous) {
      groups[groups.length - 1] = { ...previous, data: merged.data };
    } else groups.push(event);
    adjacent = true;
  }
  return groups;
}
