import { Marked, type MarkedExtension } from 'marked';
import { markedTerminal } from 'marked-terminal';
import stringWidth from 'string-width';
import stripAnsi from 'strip-ansi';
import wrapAnsi from 'wrap-ansi';
import type { ServerEvent, EventRendering } from './protocol.js';
import { DEFAULT_COLORS, ansiColor, resolveColor, type ColorSetting, type Level, type Settings } from './settings.js';
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
const chatGroupIdentities = new WeakMap<ServerEvent, string>();
export function chatGroupIdentity(event: ServerEvent): string {
  return chatGroupIdentities.get(event) ?? `${event.agentId ?? ''}\0${event.generation ?? ''}\0${event.type}\0${event.seq}`;
}
export type RenderColors = Partial<Record<ColorSetting, string>>;
const paint = (text: string, color: ColorSetting | 'gray' | '38;5;250', colors: RenderColors = {}) => {
  const code = color === '38;5;250' ? color
    : ansiColor(color in DEFAULT_COLORS ? resolveColor(colors, color as ColorSetting) : color);
  return `\x1b[${code}m${text.replace(/\x1b\[0m/g, `\x1b[0m\x1b[${code}m`)}\x1b[0m`;
};
function toolColor(event: ServerEvent, tool?: string, invocationError?: boolean): ColorSetting | 'gray' {
  if (event.type === 'tool.call') return 'toolCall';
  if (event.type === 'tool.update') return 'toolUpdate';
  const data = object(event.data), result = object(data.rawOutput);
  const exit = result.structuredContent?.exit_code ?? result.details?.exitCode ?? result.exitCode ??
    ((tool ?? data.toolName ?? data.title) === 'bash' ? textContent(data.rawOutput ?? data.content ?? '').match(/\bexit(?:ed)?(?: with)? (?:code|status):?\s*(-?\d+)/i)?.[1] : undefined);
  const failedOutput = invocationError ?? (result.isError === true || (exit !== undefined && Number(exit) !== 0));
  if (failedOutput || ['failed', 'cancelled', 'canceled'].includes(data.status)) return 'toolFailure';
  return data.status === 'completed' ? 'toolSuccess' : 'gray';
}
/** Only the symbol carries lifecycle color; edit's signed counts have independent diff colors. */
function toolHeader(text: string, event: ServerEvent, tool?: string, colors: RenderColors = {}, rendering?: Pick<EventRendering, 'toolSymbol' | 'toolTarget' | 'invocationError'>): string {
  const plain = clean(text);
  if (rendering?.toolSymbol) {
    const symbol = clean(rendering.toolSymbol).replace(/\s/g, '');
    const target = rendering.toolTarget && clean(rendering.toolTarget);
    const body = target && plain.startsWith(target) ? paint(target, 'agentTarget', colors) + plain.slice(target.length) : plain;
    return paint(symbol, toolColor(event, tool, rendering.invocationError), colors) + (body ? ` ${body}` : '');
  }
  const match = /^([\s]*)([$<>Δ•])(?=\s|$)(.*)$/u.exec(plain);
  if (!match) return plain;
  let rest = match[3]!;
  if (match[2] === 'Δ') rest = rest.replace(/( · )(\+\d+)( \/ )(-\d+)$/,
    (_all, gap: string, added: string, separator: string, removed: string) => `${gap}${paint(added, 'diffAdd', colors)}${separator}${paint(removed, 'diffRemove', colors)}`);
  return match[1] + paint(match[2]!, toolColor(event, tool), colors) + rest;
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
function terminalOutputTail(lines: string[], width: number, maxRows: number, colors: RenderColors): { text: string; hidden: boolean } {
  const gutter = width >= 6 ? '  │ ' : width >= 3 ? '│ ' : '';
  const available = width - stringWidth(gutter);
  const rows = lines.slice(-maxRows).flatMap(line => wrapAnsi(line, available, { hard: true, trim: false }).split('\n'));
  return {
    text: rows.slice(-maxRows).map(line => paint(gutter, '38;5;250', colors) + clip(line, available)).join('\n'),
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

const markdownCache = new Map<string, Marked>();
function markdown(text: string, width: number, summary = false, colors: RenderColors = {}): string {
  // Cached renderers must not close over mutable client preferences.
  const palette = Object.fromEntries((['eventHeading', 'eventCode', 'eventLink', 'diffAdd', 'diffRemove'] as const)
    .map(key => [key, resolveColor(colors, key)]));
  const key = JSON.stringify([width, summary, palette]);
  let parser = markdownCache.get(key);
  if (!parser) {
    const style = (codes: string) => (value: string) => `\x1b[${codes}m${value}\x1b[0m`;
    parser = new Marked(markedTerminal({
      width, reflowText: !summary, emoji: false,
      heading: style(`1;${ansiColor(palette.eventHeading!)}`), firstHeading: style(`1;${ansiColor(palette.eventHeading!)}`), strong: style('1'),
      em: style('3'), codespan: style(ansiColor(palette.eventCode!)), blockquote: style('90'),
      link: style(ansiColor(palette.eventLink!)), href: style(`4;${ansiColor(palette.eventLink!)}`),
    }) as unknown as MarkedExtension);
    // Semantic diff colors are local and deterministic, even without FORCE_COLOR/TTY.
    parser.use({ renderer: { code({ text, lang }) {
      if (lang?.split(/\s/)[0] !== 'diff') return false;
      let inHunk = false;
      return '\n' + text.split('\n').map(line => {
        if (line.startsWith('@@')) { inHunk = true; return paint(line, 'eventHeading', palette); }
        if (!inHunk && /^(--- |\+\+\+ |diff --git)/.test(line)) return paint(line, 'gray');
        return line.startsWith('-') ? paint(line, 'diffRemove', palette) : line.startsWith('+') ? paint(line, 'diffAdd', palette) : line;
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
function ellipsisStyled(value: string, width: number): string {
  if (width <= 0) return '';
  let remaining = width - 1, result = '';
  for (const part of value.split(/(\x1b\[[\d;]*m)/)) {
    if (part.startsWith('\x1b[')) { result += part; continue; }
    for (const { segment } of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(part)) {
      const cells = stringWidth(segment);
      if (cells > remaining) return `${result}\x1b[0m…`;
      result += segment;
      remaining -= cells;
    }
  }
  return `${result}\x1b[0m…`;
}
function extendedRows(lines: string[], width: number, maxRows = 2): string {
  const rows = lines.flatMap(line => wrapAnsi(line, width, { hard: true, trim: false }).split('\n'));
  if (rows.length <= maxRows) return rows.join('\n');
  const visible = rows.slice(0, maxRows);
  visible[maxRows - 1] = ellipsisStyled(visible[maxRows - 1]!, width);
  return visible.join('\n');
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
/** Render AgentOrg delegated prompt text with a bounded summary/detail and complete Markdown view. */
function renderAgentPrompt(event: ServerEvent, level: Exclude<Level, 4>, width: number, rendering: EventRendering, colors: RenderColors): string {
  const symbol = paint(clean(rendering.toolSymbol ?? '∴').replace(/\s/g, ''), toolColor(event, rendering.subtype, rendering.invocationError), colors);
  const targetText = rendering.toolTarget ? clean(rendering.toolTarget) : '';
  const target = targetText ? paint(targetText, 'agentTarget', colors) : '';
  // Keep a very long recipient from taking the entire prompt column. The target
  // may be abbreviated, but prompt text always gets the remaining width.
  const prefixBudget = Math.min(Math.max(0, width - 1), Math.floor(width * 0.4));
  const targetBudget = Math.max(0, prefixBudget - stringWidth(stripAnsi(symbol)) - 2);
  const visibleTarget = target && targetBudget > 0 ? clipStyled(target, targetBudget) : '';
  const prompt = rendering.toolPrompt ?? (targetText && rendering.summary.startsWith(targetText) ? rendering.summary.slice(targetText.length).trimStart() : rendering.summary);
  let prefix = `${symbol}${visibleTarget ? ` ${visibleTarget}` : ''} `;
  let prefixWidth = stringWidth(stripAnsi(prefix));
  let bodyWidth = Math.max(1, width - prefixWidth);
  // At tiny widths the decoration can leave less room than a wide glyph needs;
  // full mode must never clip away prompt characters to preserve a marker.
  if (level === 3 && bodyWidth < 2) {
    prefix = '';
    prefixWidth = 0;
    bodyWidth = width;
  }
  if (level === 1) return clipStyled(prefix + markdown(prompt.replace(/\s+/g, ' ').trim(), bodyWidth, true, colors), width);
  const formatted = markdown(prompt, bodyWidth, false, colors);
  const bodyRows = logicalLines(formatted).flatMap(line => wrapAnsi(line, bodyWidth, { hard: true, trim: false }).split('\n'));
  const indent = ' '.repeat(Math.min(prefixWidth, Math.max(0, width - 1)));
  const rows = bodyRows.map((line, index) => clipStyled((index === 0 ? prefix : indent) + line, width));
  if (level === 3) return rows.join('\n');
  if (rows.length <= 2) return rows.join('\n');
  const tailWidth = Math.max(1, width - stringWidth(' …'));
  const tail = wrapAnsi(rows[1]!, tailWidth, { hard: true, trim: false }).split('\n')[0]!;
  return [rows[0]!, clipStyled(`${tail} …`, width)].join('\n');
}

/** Render a one-line event preview, optionally keeping streamed text literal for the tree. */
function renderTreeEventPreview(event: ServerEvent, width: number, rendering: EventRendering | undefined, colors: RenderColors, staticStreamPrefix: boolean): string {
  if (width <= 0) return '';
  const data = object(event.data);
  const streamKind = event.type === 'agent.message' && ['agent_message_chunk', 'agent_thought_chunk', 'user_message_chunk'].includes(data.sessionUpdate);
  const assistant = event.type === 'agent.message' && data.sessionUpdate === 'agent_message_chunk';
  const prefix = assistant || isTool(event) ? '' : `${clean(label(event).split(' · ').at(-1)!).replace(/\s+/g, ' ')}: `;
  const text = rendering ? logicalLines(rendering.summary)[0] || '—' : isTool(event) ? logicalLines(eventText(event))[0]! : eventText(event);
  // Incremental Markdown can change already-visible leading characters as tokens
  // complete. Tree stream previews preserve their source prefix and clip right.
  const prefixText = clean(text).replace(/\s+/g, ' ').trim();
  const messageTruncated = !rendering && object(data.content).previewTruncated === true;
  const summary = staticStreamPrefix && streamKind
    ? prefixText + (messageTruncated ? '…' : '')
    : markdown(text, Math.max(1, width), true, colors);
  const preview = prefix + summary;
  return clipStyled(isTool(event) ? toolHeader(preview, event, rendering?.subtype, colors, rendering) : preview, width);
}
/** Tree previews keep streamed message beginnings static and right-clip the rest. */
export function renderTreeEvent(event: ServerEvent, width: number, rendering?: EventRendering, colors: RenderColors = {}): string {
  return renderTreeEventPreview(event, width, rendering, colors, true);
}
export function renderEvent(event: ServerEvent, level: Level, width: number, rendering?: EventRendering, colors: RenderColors = {}): string {
  width = Math.max(1, width);
  if (level === 0) return '';
  if (level === 4) return wrapAnsi(pretty(event), width, { hard: true, trim: false });
  if (rendering?.toolPrompt !== undefined && isTool(event)) return renderAgentPrompt(event, level, width, rendering, colors);
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
    if (event.type === 'tool.update' && output !== undefined && rendering.updateMode !== 'semantic' && (level === 2 || level === 3)) {
      const text = textContent(output);
      const lines = text === '' ? [] : logicalLines(text).map(clean);
      if (lines.length > 1 && lines.at(-1) === '') lines.pop();
      const lineCount = lines.length;
      const maxRows = level === 2 ? 1 : 5;
      const tail = terminalOutputTail(lines, width, maxRows, colors);
      const heading = clipStyled(toolHeader(markdown(rendering.summary, width, true, colors), event, rendering.subtype, colors, rendering), width);
      const count = `${lineCount} ${lineCount === 1 ? 'line' : 'lines'} received${tail.hidden ? ` · showing last ${maxRows} ${maxRows === 1 ? 'row' : 'rows'}` : ''}`;
      const countLine = paint(clip(count, width), '38;5;250', colors);
      if (level === 2) {
        const combined = `${countLine}${tail.text ? ` ${tail.text}` : ''}`;
        const details = tail.text && stringWidth(stripAnsi(combined)) > width ? tail.text : combined;
        return extendedRows([heading, details], width);
      }
      return heading + '\n' + countLine + (tail.text ? '\n' + tail.text : '');
    }
    if (level === 1) return renderTreeEventPreview(event, width, rendering, colors, false);
    if (level === 2) {
      if (rendering.extendedLayout === 'header-detail') {
        const [detail] = logicalLines(rendering.extended).slice(1);
        const heading = clipStyled(toolHeader(markdown(rendering.summary, width, true, colors), event, rendering.subtype, colors, rendering), width);
        const priority = clipStyled(markdown(detail ?? 'Status unavailable', width, true, colors), width);
        return `${heading}\n${priority}`;
      }
      const diff = rendering.extendedDiff;
      if (isTool(event) && diff && [diff.prefix, diff.before, diff.after].every(text => typeof text === 'string')) {
        const prefix = clean(diff.prefix).replace(/\s+/g, ' ').trim();
        const before = clean(diff.before).replace(/\s+/g, ' '), after = clean(diff.after).replace(/\s+/g, ' ');
        const first = toolHeader(prefix, event, rendering.subtype, colors, rendering) + ' ' + paint(before, 'diffRemove', colors);
        const second = ' '.repeat((stringWidth(prefix) + 1) % width) + paint(after, 'diffAdd', colors);
        return extendedRows([first, second], width);
      }
      const lines = logicalLines(rendering.extended).map((line, index) => {
        const text = markdown(line, width, true, colors);
        return isTool(event) && index === 0 ? toolHeader(text, event, rendering.subtype, colors, rendering) : text;
      });
      return extendedRows(lines, width);
    }
    if (isTool(event)) {
      const [heading, ...body] = logicalLines(rendering.full);
      const header = toolHeader(markdown(heading ?? '', width, true, colors), event, rendering.subtype, colors, rendering);
      // Semantic status follows immediately, even with an unusually long target/prompt.
      return (rendering.extendedLayout === 'header-detail' ? clipStyled(header, width) : wrapAnsi(header, width, { hard: true, trim: false })) +
        (body.join('\n').trim() ? '\n' + markdown(body.join('\n'), width, false, colors) : '');
    }
    return `${paint(clip(`${event.time} · ${label(event)}`, width), 'gray', colors)}\n${markdown(rendering.full, width, false, colors)}`;
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
  return `${paint(header, 'gray', colors)}\n${markdown(text, width, false, colors)}`;
}

/** Coalesce compatible text chunks and, optionally, replace tool lifecycle phases in chat. */
export function chatGroups(events: ServerEvent[], settings: Settings, renderings: Map<number, EventRendering> = new Map()): ServerEvent[] {
  const groups: ServerEvent[] = [];
  const identities = new Map<number, string>();
  const add = (event: ServerEvent, identity = `${event.agentId ?? ''}\0${event.generation ?? ''}\0${event.type}\0${event.seq}`) => {
    const index = groups.push(event) - 1;
    identities.set(index, identity); chatGroupIdentities.set(event, identity);
    return index;
  };
  const replace = (index: number, event: ServerEvent) => {
    const identity = identities.get(index) ?? `${event.agentId ?? ''}\0${event.generation ?? ''}\0${event.type}\0${event.seq}`;
    groups[index] = event; identities.set(index, identity); chatGroupIdentities.set(event, identity);
  };
  const toolCalls = new Map<string, number>();
  let adjacent = false;
  for (const event of events) {
    const data = object(event.data);
    const rendering = renderings.get(event.seq);
    const callId = settings.compactToolCalls && isTool(event) && typeof data.toolCallId === 'string' && event.agentId
      ? `${event.agentId}\0${event.generation ?? ''}\0${data.toolCallId}` : undefined;
    const raw = settings.level(event.type, rendering?.subtype) === 4;
    // Raw phases remain separate and end any prior replacement chain.
    if (callId && raw) toolCalls.delete(callId);
    else if (callId) {
      const priorIndex = toolCalls.get(callId);
      if (settings.visible(event.type, rendering?.subtype)) {
        if (priorIndex !== undefined) replace(priorIndex, event);
        else {
          const identity = `${event.agentId}\0${event.generation ?? ''}\0tool\0${data.toolCallId}\0${event.seq}`;
          toolCalls.set(callId, add(event, identity));
        }
      }
      if (event.type === 'tool.result') toolCalls.delete(callId);
      adjacent = false;
      continue;
    }
    if (!settings.visible(event.type, rendering?.subtype)) { adjacent = false; continue; }
    const previous = adjacent ? groups[groups.length - 1] : undefined;
    const merged = !raw && !rendering && !(previous && renderings.has(previous.seq)) ? appendMessageChunk(previous, event) : undefined;
    if (merged && previous) replace(groups.length - 1, { ...previous, data: merged.data });
    else add(event);
    adjacent = true;
  }
  return groups;
}
