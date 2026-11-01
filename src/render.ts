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
const paint = (text: string, color: ColorSetting | 'gray' | '38;5;250', colors: RenderColors = {}, bold = false) => {
  const code = color === '38;5;250' ? color
    : ansiColor(color in DEFAULT_COLORS ? resolveColor(colors, color as ColorSetting) : color);
  const sgr = bold ? `1;${code}` : code;
  return `\x1b[${sgr}m${text.replace(/\x1b\[0m/g, `\x1b[0m\x1b[${sgr}m`)}\x1b[0m`;
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
function paintToolTargets(text: string, targets: string[], colors: RenderColors): string {
  const matches = [...new Set(targets.map(clean).filter(Boolean))]
    .map(target => ({ target, start: text.indexOf(target) }))
    .filter(match => match.start >= 0)
    .sort((a, b) => a.start - b.start || b.target.length - a.target.length);
  let output = '', cursor = 0;
  for (const match of matches) {
    if (match.start < cursor) continue;
    output += text.slice(cursor, match.start) + paint(match.target, 'agentTarget', colors);
    cursor = match.start + match.target.length;
  }
  return output + text.slice(cursor);
}
/** Only the symbol carries lifecycle color; edit's signed counts have independent diff colors. */
function toolHeader(text: string, event: ServerEvent, tool?: string, colors: RenderColors = {}, rendering?: Pick<EventRendering, 'toolSymbol' | 'toolTarget' | 'toolTargets' | 'invocationError'>): string {
  const plain = clean(text);
  if (rendering?.toolSymbol) {
    const symbol = clean(rendering.toolSymbol).replace(/\s/g, '');
    const target = rendering.toolTarget && clean(rendering.toolTarget);
    const body = rendering.toolTargets?.length ? paintToolTargets(plain, rendering.toolTargets, colors)
      : target && plain.startsWith(target) ? paint(target, 'agentTarget', colors) + plain.slice(target.length) : plain;
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
    case 'prompt.steering': case 'prompt.steered': return typeof data.text === 'string' ? data.text : pretty(event.data);
    case 'prompt.steer_failed': return `${typeof data.text === 'string' ? data.text : 'Steering guidance'}${data.error?.message ? ` · ${data.error.message}` : ''}`;
    case 'agent.created': case 'agent.modified': return `${data.name ?? data.id} · ${data.state ?? ''} · ${data.settings?.model ?? ''}`;
    case 'agent.state': return `${data.state ?? 'unknown'}${data.error ? ` · ${data.error}` : ''}`;
    case 'agent.removed': return `Removed ${data.removedAt ?? ''}`;
    case 'prompt.started': case 'prompt.cancelling': case 'prompt.finished':
      return `${data.status ?? event.type.split('.')[1]} · ${data.operationId ?? ''}`;
    case 'completion.ready': {
      const childCount = Number.isInteger(data.childCount) && data.childCount >= 0 ? data.childCount : 0;
      const operationCount = Number.isInteger(data.operationCount) && data.operationCount >= 0 ? data.operationCount : 0;
      const childNames = Array.isArray(data.childNames) ? data.childNames.map((name: unknown) => typeof name === 'string' ? clean(name).replace(/\s+/g, ' ').trim() : '').filter(Boolean).slice(0, 8) : [];
      const totalChildren = Math.max(childCount, childNames.length);
      if (!childNames.length) return operationCount > 1 ? 'Messages received.' : 'Message received.';
      if (totalChildren > 1 && childNames.length === totalChildren && childNames.every(name => name === childNames[0])) return `Messages received from ${totalChildren} child agents named ${literalMarkdown(childNames[0]!)}.`;
      const names = childNames.map(literalMarkdown);
      const more = Math.max(0, totalChildren - childNames.length);
      const listed = names.length === 1 ? names[0] : more ? names.join(', ') : `${names.slice(0, -1).join(', ')}${names.length > 2 ? ',' : ''} and ${names.at(-1)}`;
      const suffix = more ? ` and ${more} more` : '';
      return `${totalChildren === 1 ? 'Message' : 'Messages'} received from ${listed}${suffix}.`;
    }
    case 'completion.dispatch_started': return 'Reviewing messages...';
    case 'completion.dispatch_finished':
      return data.status && data.status !== 'completed' ? `Done reviewing messages (${clean(String(data.status))}).` : 'Done reviewing messages.';
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
function markdown(text: string, width: number, summary = false, colors: RenderColors = {}, preserveBreaks = false): string {
  // Cached renderers must not close over mutable client preferences.
  const palette = Object.fromEntries((['eventHeading', 'eventCode', 'eventLink', 'diffAdd', 'diffRemove'] as const)
    .map(key => [key, resolveColor(colors, key)]));
  const key = JSON.stringify([width, summary, palette, preserveBreaks]);
  let parser = markdownCache.get(key);
  if (!parser) {
    const style = (codes: string) => (value: string) => `\x1b[${codes}m${value}\x1b[0m`;
    parser = new Marked(markedTerminal({
      width, reflowText: !summary, emoji: false,
      heading: (value: string) => style(`1;${ansiColor(palette.eventHeading!)}`)(value.replace(/^#{1,6}\s+/, '')), firstHeading: (value: string) => style(`1;${ansiColor(palette.eventHeading!)}`)(value.replace(/^#{1,6}\s+/, '')), strong: style('1'),
      em: style('3'), codespan: (value: string) => style(ansiColor(palette.eventCode!))(value), blockquote: style('90'),
      link: style(ansiColor(palette.eventLink!)), href: style(`4;${ansiColor(palette.eventLink!)}`),
    }) as unknown as MarkedExtension);
    // Semantic diff colors are local and deterministic, even without FORCE_COLOR/TTY.
    parser.use({ renderer: {
      text(token) {
        // marked-terminal's tight-list renderer passes block text tokens through as source,
        // leaving nested strong/emphasis markers literal. Reparse their inline tokens.
        const tokens = object(token).tokens;
        if (Array.isArray(tokens)) return this.parser.parseInline(tokens);
        return false;
      },
      code({ text, lang }) {
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
    const parsed = parser.parse(clean(text), { async: false, breaks: preserveBreaks }) as string;
    return summary ? parsed.replace(/\s+/g, ' ').trim() : wrapAnsi(parsed, width, { hard: true, trim: false }).trimEnd();
  } catch {
    // Defensive plain-text fallback for genuinely unsupported parser input; the
    // normal Markdown fixture exercises the successful terminal renderer path.
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
    if (data.sessionUpdate === 'user_message_chunk') return 'agent.message';
    if (data.sessionUpdate === 'agent_message_chunk') return 'agent.message · assistant';
  }
  if (event.type === 'prompt.queued') return `prompt.queued · ${object(event.data).effect ?? 'normal'}`;
  return event.type;
}
/** Render AgentOrg delegated prompt text with a bounded summary/detail and complete Markdown view. */
function renderAgentPrompt(event: ServerEvent, level: Exclude<Level, 4>, width: number, rendering: EventRendering, colors: RenderColors): string {
  const targetText = rendering.toolTarget ? clean(rendering.toolTarget) : '';
  const prompt = rendering.toolPrompt ?? (targetText && rendering.summary.startsWith(targetText) ? rendering.summary.slice(targetText.length).trimStart() : rendering.summary);
  const sender = rendering.toolSender ? clean(rendering.toolSender) : '';
  if (!sender || !targetText) {
    const symbol = paint(clean(rendering.toolSymbol ?? '∴').replace(/\s/g, ''), toolColor(event, rendering.subtype, rendering.invocationError), colors);
    const budget = Math.max(0, Math.floor(width * 0.4) - stringWidth(stripAnsi(symbol)) - 2);
    const visibleTarget = targetText ? clipStyled(paint(targetText, 'agentTarget', colors), budget) : '';
    const prefix = `${symbol}${visibleTarget ? ` ${visibleTarget}` : ''} `;
    const prefixWidth = stringWidth(stripAnsi(prefix));
    const bodyWidth = level === 3 && width - prefixWidth < 2 ? width : Math.max(1, width - prefixWidth);
    const visiblePrefix = bodyWidth === width ? '' : prefix;
    if (level === 1) return clipStyled(visiblePrefix + markdown(prompt.replace(/\s+/g, ' ').trim(), bodyWidth, true, colors), width);
    const formatted = markdown(prompt, bodyWidth, false, colors);
    const bodyRows = logicalLines(formatted).flatMap(line => wrapAnsi(line, bodyWidth, { hard: true, trim: false }).split('\n'));
    const rows = bodyRows.map((line, i) => clipStyled((i === 0 ? visiblePrefix : '') + line, width));
    if (level === 3) return rows.join('\n');
    if (rows.length <= 2) return rows.join('\n');
    return [rows[0]!, clipStyled(`${clip(stripAnsi(rows[1]!), width - 2)} …`, width)].join('\n');
  }
  const prefix = `${paint(`${sender}: `, 'agentTarget', colors)}${paint(targetText, 'agentTarget', colors)} `;
  return formatAttributed(prefix, prompt, level, width, colors);
}
function formatAttributed(prefix: string, body: string, level: Exclude<Level, 4>, width: number, colors: RenderColors): string {
  const prefixWidth = stringWidth(stripAnsi(prefix));
  const separate = prefixWidth >= width - 1;
  const bodyWidth = separate ? width : Math.max(1, width - prefixWidth);
  const prefixRows = separate ? wrapAnsi(prefix, width, { hard: true, trim: false }).split('\n') : [prefix];
  const rendered = markdown(body, level === 1 ? bodyWidth : width, level === 1, colors, level !== 1);
  if (level === 1) return clipStyled((separate ? prefixRows.join('') : prefix) + rendered, width);
  const sourceRows = logicalLines(rendered);
  const firstContent = sourceRows.findIndex(row => stripAnsi(row).trim().length > 0);
  const output: string[] = separate ? [...prefixRows] : [];
  if (!separate && firstContent < 0) output.push(prefix);
  if (!separate && firstContent >= 0) {
    for (const row of sourceRows.slice(0, firstContent)) output.push(row);
    const first = sourceRows[firstContent]!;
    output.push(...wrapAnsi(first, bodyWidth, { hard: true, trim: false }).split('\n').map((row, index) => `${index === 0 ? prefix : ''}${row}`));
    output.push(...sourceRows.slice(firstContent + 1).flatMap(row => wrapAnsi(row, width, { hard: true, trim: false }).split('\n')));
  } else if (separate) output.push(...sourceRows.flatMap(row => wrapAnsi(row, width, { hard: true, trim: false }).split('\n')));
  if (level === 3) return output.map(row => clipStyled(row, width)).join('\n');
  const visible = output.filter(row => stripAnsi(row).trim()).slice(0, 2);
  if (output.filter(row => stripAnsi(row).trim()).length > 2 && visible.length) visible[visible.length - 1] = clipStyled(`${visible.at(-1)} …`, width);
  return visible.map(row => clipStyled(row, width)).join('\n');
}

/** Render a one-line event preview, optionally keeping streamed text literal for the tree. */
function promptCue(event: ServerEvent): { mention: string; body: string; sender?: string; recipient?: string } | undefined {
  if (event.type !== 'prompt.queued') return;
  const data = object(event.data), cue = object(data.promptCue), attr = object(data.promptAttribution), text = data.text;
  const attribution = attr.version === 1 && typeof attr.sender === 'string' && attr.sender.length > 0 && attr.sender.length <= 256 && typeof attr.recipient === 'string' && attr.recipient.length > 0 && attr.recipient.length <= 256 && !/[\x00-\x1f\x7f-\x9f]/u.test(attr.sender + attr.recipient)
    ? { sender: clean(attr.sender).replace(/\s+/g, ' ').trim(), recipient: clean(attr.recipient).replace(/\s+/g, ' ').trim() } : {};
  if (cue.version !== 1 || !Number.isInteger(cue.bodyStart) || typeof text !== 'string') return;
  const bodyStart = cue.bodyStart as number;
  if (bodyStart < 3 || bodyStart > text.length || text[bodyStart - 1] !== ' ') return;
  const mention = text.slice(0, bodyStart - 1);
  if (!mention.startsWith('@') || /[\x00-\x1f\x7f-\x9f]/u.test(mention)) return;
  return { mention, body: text.slice(bodyStart), ...attribution };
}
function renderPromptCue(event: ServerEvent, level: Exclude<Level, 4>, width: number, colors: RenderColors, rendering?: EventRendering): string {
  const data = object(event.data), cue = promptCue(event);
  const sidecar = level === 1 ? rendering?.summary : level === 2 ? rendering?.extended : rendering?.full;
  const text = typeof sidecar === 'string' ? sidecar : typeof data.text === 'string' ? data.text : pretty(event.data);
  const hasCue = !!cue && text.startsWith(`${cue.mention} `);
  const body = hasCue ? text.slice(cue!.mention.length + 1) : text;
  const effect = ['normal', 'interrupt', 'queue'].includes(data.effect) ? data.effect : undefined;
  if (!(cue && cue.sender && cue.recipient) && (effect || cue)) {
    const label = effect === 'queue' ? 'QUEUE' : effect === 'interrupt' ? 'INTERRUPT' : 'PROMPT';
    const attribution = hasCue && cue!.sender && cue!.recipient ? `${cue!.sender}: @${cue!.recipient}` : hasCue ? cue!.mention : '';
    const header = paint(`YOU · ${label}${attribution ? ` · ${attribution}` : ''}`, 'agentTarget', colors);
    const preserveBreaks = !!(hasCue && cue!.sender && cue!.recipient);
    const detail = clean(stripAnsi(markdown(body, width, false, colors, preserveBreaks))).replace(/\s+/g, ' ').trim();
    if (level === 1) return clipStyled(`${header} — ${markdown(body.replace(/\s+/g, ' ').trim(), width, true, colors)}`, width);
    if (level === 3) return `${wrapAnsi(header, width, { hard: true, trim: false })}\n${markdown(body, width, false, colors, preserveBreaks)}`;
    return `${clipStyled(header, width)}\n${literalEllipsis(detail, width)}`;
  }
  if (cue && cue.sender && cue.recipient) {
    const prefix = `${paint(`${cue.sender}: `, 'agentTarget', colors)}${paint(`@${cue.recipient}`, 'agentTarget', colors)} `;
    return formatAttributed(prefix, body, level, width, colors);
  }
  const mention = hasCue ? paint(clean(cue!.mention), 'agentTarget', colors) : '';
  const prefix = hasCue ? `${mention} ` : '';
  if (level === 1) return clipStyled(prefix + markdown(body.replace(/\s+/g, ' ').trim(), width, true, colors), width);
  const prefixWidth = stringWidth(stripAnsi(prefix));
  let rows: string[];
  if (prefix && prefixWidth < width && (level !== 3 || width - prefixWidth >= 2)) {
    const bodyWidth = Math.max(1, width - prefixWidth);
    const rendered = markdown(body, bodyWidth, false, colors);
    rows = logicalLines(rendered).flatMap(line => wrapAnsi(line, bodyWidth, { hard: true, trim: false }).split('\n'))
      .map((line, index) => `${index === 0 ? prefix : ' '.repeat(prefixWidth)}${line}`);
  } else {
    const cueRows = prefix ? wrapAnsi(prefix, width, { hard: true, trim: false }).split('\n') : [];
    const rendered = markdown(body, width, false, colors);
    const bodyRows = logicalLines(rendered).flatMap(line => wrapAnsi(line, width, { hard: true, trim: false }).split('\n'));
    rows = [...cueRows, ...bodyRows];
  }
  if (level === 3) return rows.map(line => clipStyled(line, width)).join('\n');
  if (rows.length > 2) rows[1] = clipStyled(`${rows[1]} …`, width);
  return rows.slice(0, 2).map(line => clipStyled(line, width)).join('\n');
}
function literalEllipsis(line: string, width: number): string {
  const text = clean(stripAnsi(line));
  if (width <= 0) return '';
  if (stringWidth(text) <= width) return text;
  const budget = Math.max(0, width - 3);
  let result = '';
  for (const { segment } of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)) {
    if (stringWidth(result + segment) > budget) break;
    result += segment;
  }
  return result + '.'.repeat(Math.min(3, width));
}
function renderCompletionNotice(event: ServerEvent, width: number, colors: RenderColors): string {
  const summary = markdown(eventText(event), width, true, colors);
  const symbol = paint('∴', 'agentTarget', colors, true);
  return clipStyled(`${symbol} ${summary}`, width);
}
function renderTreeEventPreview(event: ServerEvent, width: number, rendering: EventRendering | undefined, colors: RenderColors, staticStreamPrefix: boolean): string {
  if (event.type.startsWith('completion.')) return renderCompletionNotice(event, width, colors);
  if (isTool(event) && rendering?.toolPrompt !== undefined && rendering.toolSender && rendering.toolTarget) {
    const symbol = paint(clean(rendering.toolSymbol ?? '∴').replace(/\s/g, ''), toolColor(event, rendering.subtype, rendering.invocationError), colors);
    const prefix = `${symbol} ${paint(`${clean(rendering.toolSender)}: `, 'agentTarget', colors)}${paint(clean(rendering.toolTarget), 'agentTarget', colors)} `;
    return formatAttributed(prefix, rendering.toolPrompt, 1, width, colors);
  }
  if (['prompt.steer_submitted', 'prompt.steer_pending', 'prompt.steer_delivered', 'prompt.steer_failed', 'prompt.steering', 'prompt.steered'].includes(event.type)) return renderSteeringEvent(event, 1, width, colors);
  if (event.type === 'prompt.queued') {
    const data = object(event.data), cue = promptCue(event);
    const hasSidecar = typeof rendering?.summary === 'string';
    const text = hasSidecar ? rendering!.summary : typeof data.text === 'string' ? data.text : pretty(event.data);
    const hasCue = !!cue && text.startsWith(`${cue.mention} `);
    const body = hasCue ? text.slice(cue!.mention.length + 1) : text;
    const effect = ['normal', 'interrupt', 'queue'].includes(data.effect) ? data.effect : undefined;
    const showMode = !(cue && cue.sender && cue.recipient) && (!!effect || !!cue);
    const attributedSummary = !!cue && !!cue.sender && !!cue.recipient;
    const attribution = attributedSummary ? `${cue!.sender}: @${cue!.recipient}` : hasCue ? cue!.mention : '';
    const summary = hasSidecar || attributedSummary ? markdown(body.replace(/\s+/g, ' ').trim(), width, true, colors) : clean(body).replace(/\s+/g, ' ').trim();
    if (!showMode && (!hasCue || (cue!.sender && cue!.recipient))) {
      const prefix = cue && cue.sender && cue.recipient
        ? `${paint(`${cue.sender}: `, 'agentTarget', colors)}${paint(`@${cue.recipient}`, 'agentTarget', colors)} `
        : hasCue ? `${paint(clean(cue!.mention), 'agentTarget', colors)} ` : '';
      return clipStyled(prefix + summary, width);
    }
    const label = effect === 'queue' ? 'QUEUE' : effect === 'interrupt' ? 'INTERRUPT' : 'PROMPT';
    const header = `YOU · ${label}${attribution ? ` · ${attribution}` : ''}`;
    return clipStyled(`${paint(header, 'agentTarget', colors)} — ${summary}`, width);
 }
  if (width <= 0) return '';
  const data = object(event.data);
  const streamKind = event.type === 'agent.message' && ['agent_message_chunk', 'agent_thought_chunk', 'user_message_chunk'].includes(data.sessionUpdate);
  const assistant = event.type === 'agent.message' && data.sessionUpdate === 'agent_message_chunk';
  const userMessage = event.type === 'agent.message' && data.sessionUpdate === 'user_message_chunk';
  const prefix = assistant || userMessage || isTool(event) ? '' : `${clean(label(event).split(' · ').at(-1)!).replace(/\s+/g, ' ')}: `;
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
function renderSteeringEvent(event: ServerEvent, level: Exclude<Level, 4>, width: number, colors: RenderColors): string {
  const submitted = event.type === 'prompt.steer_submitted';
  const pending = event.type === 'prompt.steer_pending' || event.type === 'prompt.steering';
  const failed = event.type === 'prompt.steer_failed';
  const color: ColorSetting = submitted ? 'toolCall' : pending ? 'toolUpdate' : failed ? 'toolFailure' : 'toolSuccess';
  const title = 'YOU · STEER';
  const data = object(event.data);
  const prompt = clean(typeof data.text === 'string' ? data.text : 'Steering guidance');
  const compactPrompt = prompt.replace(/\s+/g, ' ').trim();
  const error = failed && typeof data.error?.message === 'string' ? clean(data.error.message).replace(/\s+/g, ' ').trim() : '';
  if (level === 1) return clipStyled(`${paint(title, color, colors)} — ${compactPrompt}${error ? ` · ${error}` : ''}`, width);
  if (level === 2) return `${clipStyled(paint(title, color, colors), width)}\n${literalEllipsis(`${compactPrompt}${error ? ` · ${error}` : ''}`, width)}`;
  const header = paint(title, color, colors);
  return `${header}\n${markdown(prompt, width, false, colors)}${error ? `\nFailure: ${markdown(error, width, false, colors)}` : ''}`;
}
export function renderEvent(event: ServerEvent, level: Level, width: number, rendering?: EventRendering, colors: RenderColors = {}): string {
  width = Math.max(1, width);
  if (level === 0) return '';
  if (level === 4) return wrapAnsi(pretty(event), width, { hard: true, trim: false });
  if (event.type === 'prompt.queued') return renderPromptCue(event, level, width, colors, rendering);
  if (['prompt.steer_submitted', 'prompt.steer_pending', 'prompt.steer_delivered', 'prompt.steer_failed', 'prompt.steering', 'prompt.steered'].includes(event.type)) return renderSteeringEvent(event, level, width, colors);
  if (event.type.startsWith('completion.')) {
    const notice = renderCompletionNotice(event, width, colors);
    return level === 3 ? `${paint(clip(event.time, width), 'gray', colors)}\n${notice}` : notice;
  }
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
    const data = object(event.data);
    const noSpeaker = event.type === 'agent.message' && ['agent_message_chunk', 'user_message_chunk'].includes(data.sessionUpdate);
    return clip(noSpeaker || event.type === 'prompt.queued' ? text : `${prefix.split(' · ').at(-1)}: ${text}`, width);
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
  const steeringRequests = new Map<string, number>();
  let adjacent = false;
  for (const event of events) {
    const data = object(event.data);
    const rendering = renderings.get(event.seq);
    const callId = settings.compactToolCalls && isTool(event) && typeof data.toolCallId === 'string' && event.agentId
      ? `${event.agentId}\0${event.generation ?? ''}\0${data.toolCallId}` : undefined;
    const steeringId = ['prompt.steer_submitted', 'prompt.steer_pending', 'prompt.steer_delivered', 'prompt.steer_failed', 'prompt.steering', 'prompt.steered'].includes(event.type) && typeof data.steeringId === 'string' && event.agentId
      ? `${event.agentId}\0${event.generation ?? ''}\0${data.steeringId}` : undefined;
    const raw = settings.level(event.type, rendering?.subtype) === 4;
    const steeringTerminal = ['prompt.steer_delivered', 'prompt.steer_failed', 'prompt.steered'].includes(event.type);
    const steeringPhase = ['prompt.steer_submitted', 'prompt.steer_pending', 'prompt.steering'].includes(event.type);
    if (steeringId && settings.compactToolCalls && !raw) {
      if (steeringPhase) {
        if (settings.visible(event.type)) {
          const priorIndex = steeringRequests.get(steeringId);
          if (priorIndex !== undefined) replace(priorIndex, event);
          else steeringRequests.set(steeringId, add(event, `${steeringId}\0steering`));
        }
      } else {
        const priorIndex = steeringRequests.get(steeringId);
        if (priorIndex !== undefined) {
          if (settings.visible(event.type, rendering?.subtype)) replace(priorIndex, event);
        } else if (settings.visible(event.type, rendering?.subtype)) add(event, `${steeringId}\0steering`);
        if (steeringTerminal) steeringRequests.delete(steeringId);
      }
      adjacent = false;
      continue;
    }
    if (steeringId && settings.compactToolCalls && raw) steeringRequests.delete(steeringId);
    // Raw tool phases remain separate and end any prior replacement chain.
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
