import stringWidth from 'string-width';
import type { ServerEvent, EventRendering } from './protocol.js';
import { cell, clean, clip, renderTreeEvent, styledCell } from './render.js';
import { ansiColor, resolveColor, type ColorSetting, type TableField } from './settings.js';
import type { TreeRow } from './store.js';

const TABLE_LABELS: Record<TableField, string> = {
  name: 'AGENT', status: 'STATUS', model: 'MODEL', event: 'LATEST TRACKED EVENT',
  inputTokens: 'IN TOKENS', outputTokens: 'OUT TOKENS', cacheReadTokens: 'CACHE READ', cacheWriteTokens: 'CACHE WRITE', totalTokens: 'TOTAL TOKENS', cost: 'COST',
  error: 'ERROR', harness: 'HARNESS', provider: 'PROVIDER', cwd: 'CWD', session: 'SESSION', revision: 'REVISION',
};
// Metadata follows its content up to a cap; Event receives all remaining space.
const LIMITS: Record<TableField, { min: number; max: number }> = {
  name: { min: 8, max: 28 }, status: { min: 6, max: 12 }, model: { min: 8, max: 30 },
  event: { min: 12, max: Infinity }, inputTokens: { min: 6, max: 12 }, outputTokens: { min: 6, max: 12 }, cacheReadTokens: { min: 6, max: 12 }, cacheWriteTokens: { min: 6, max: 12 }, totalTokens: { min: 6, max: 12 }, cost: { min: 6, max: 12 }, error: { min: 8, max: 32 }, harness: { min: 7, max: 16 },
  provider: { min: 8, max: 20 }, cwd: { min: 8, max: 32 }, session: { min: 7, max: 10 }, revision: { min: 8, max: 10 },
};
const indent = (depth: number) => '  '.repeat(depth);
type UsageColumn = 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens' | 'totalTokens' | 'cost';
const normalizeMetricPath = (path: string): string => path.toLowerCase().replace(/[^a-z0-9]/g, '');
function formatUsageNumber(value: number, currency: boolean): string {
  const amount = Math.abs(value);
  const sign = value < 0 ? '-' : '';
  const prefix = currency ? '$' : '';
  if (amount === 0) return `${prefix}0${currency ? '.00' : ''}`;
  const unit = amount >= 1_000_000 ? 1_000_000 : amount >= 1_000 ? 1_000 : 1;
  const suffix = unit === 1_000_000 ? 'M' : unit === 1_000 ? 'k' : '';
  // Significant digits keep tiny costs visible instead of rounding them to 0.00.
  const formatted = unit > 1
    ? new Intl.NumberFormat(undefined, { maximumSignificantDigits: 3 }).format(amount / unit)
    : currency
      ? amount.toLocaleString(undefined, { maximumSignificantDigits: 3, maximumFractionDigits: 12, useGrouping: false })
      : new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(amount);
  return `${sign}${prefix}${formatted}${suffix}`;
}
const USAGE_ALIASES: Record<UsageColumn, string[]> = {
  inputTokens: ['tokens.input', 'input', 'inputTokens', 'input_tokens', 'inputTokenCount'],
  outputTokens: ['tokens.output', 'output', 'outputTokens', 'output_tokens', 'outputTokenCount'],
  cacheReadTokens: ['tokens.cacheRead', 'tokens.cache_read', 'cacheRead', 'cacheReadTokens', 'cache_read', 'cache_read_tokens', 'cachedInputTokens'],
  cacheWriteTokens: ['tokens.cacheWrite', 'tokens.cache_write', 'cacheWrite', 'cacheWriteTokens', 'cache_write', 'cache_write_tokens'],
  totalTokens: ['tokens.total', 'total', 'totalTokens', 'total_tokens', 'tokens'],
  cost: ['cost.usd', 'cost.total', 'cost', 'totalCost', 'total_cost', 'usd'],
};
function usageValue(usage: unknown, column: UsageColumn): string {
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return '-';
  const subtree = (usage as Record<string, unknown>).subtree;
  if (!subtree || typeof subtree !== 'object' || Array.isArray(subtree)) return '-';
  const aliases = new Set(USAGE_ALIASES[column].map(normalizeMetricPath));
  let value: number | undefined;
  const visit = (node: unknown, path = ''): void => {
    if (value !== undefined || !node || typeof node !== 'object' || Array.isArray(node)) return;
    for (const [name, child] of Object.entries(node as Record<string, unknown>)) {
      const metricPath = path ? `${path}.${name}` : name;
      if (typeof child === 'number' && Number.isFinite(child) &&
          (aliases.has(normalizeMetricPath(metricPath)) || aliases.has(normalizeMetricPath(name)))) { value = child; return; }
      visit(child, metricPath);
    }
  };
  visit(subtree);
  return value === undefined ? '-' : formatUsageNumber(value, column === 'cost');
}
function value({ agent }: TreeRow, field: TableField): string {
  switch (field) {
    case 'name': return agent.name;
    case 'status': return agent.state;
    case 'model': return agent.settings.model ?? '—';
    case 'error': return String(agent.error ?? '—');
    case 'harness': return agent.settings.harness ?? '—';
    case 'provider': return String(agent.settings.provider ?? '—');
    case 'cwd': return String(agent.settings.cwd ?? '—');
    case 'session': return String(agent.sessionNumber ?? '—');
    case 'revision': return String(agent.revision ?? '—');
    case 'inputTokens': case 'outputTokens': case 'cacheReadTokens': case 'cacheWriteTokens': case 'totalTokens': case 'cost':
      return usageValue(agent.usage, field);
    case 'event': return '—'; // Styled previews are rendered only after allocating widths.
  }
}

/** Width includes only usable list cells (the caller reserves the scrollbar). */
export function renderTable(rows: TreeRow[], latest: Map<string, ServerEvent>, fields: readonly TableField[], width: number, renderings: Map<number, EventRendering> = new Map(), colors: Partial<Record<ColorSetting, string>> = {}, selectedIndex = -1, collapsedIds?: ReadonlySet<string>) {
  width = Math.max(0, Math.floor(width));
  if (!fields.length) return { header: '', items: rows.map(() => ''), widths: [] as number[] };
  const gap = fields.length < 2 ? 0 : Math.max(0, Math.min(2, Math.floor((width - fields.length) / (fields.length - 1))));
  // With no metadata to highlight, reserve a small selection marker instead
  // of recoloring the event preview or making selection invisible.
  const markerWidth = fields.length === 1 && fields[0] === 'event' ? Math.min(2, width) : 0;
  const budget = width - markerWidth - gap * (fields.length - 1);
  const values = rows.map(row => fields.map(field => field === 'name' && collapsedIds?.has(row.agent.id) ? `${value(row, field)} ▸` : value(row, field)));
  const eventIndex = fields.indexOf('event');
  const widths = fields.map((field, index) => {
    if (field === 'event') return Math.max(LIMITS.event.min, Math.floor(budget * 0.45));
    let needed = stringWidth(TABLE_LABELS[field]);
    for (let r = 0; r < rows.length; r++) {
      const text = (index === 0 ? indent(rows[r]!.depth) : '') + values[r]![index]!;
      needed = Math.max(needed, stringWidth(clean(text).replace(/\n/g, ' ')));
    }
    return Math.min(LIMITS[field].max, needed);
  });
  let used = widths.reduce((sum, size) => sum + size, 0);
  // Compress metadata first, preserving ~45% for Event where possible. At tiny
  // widths even the minima must yield, rather than wrapping rows or headers.
  const shrink = (floor: (index: number) => number) => {
    while (used > budget) {
      let selected = -1, slack = 0;
      widths.forEach((size, index) => {
        const available = size - floor(index);
        if (available > slack) { selected = index; slack = available; }
      });
      if (selected < 0) break;
      widths[selected] = widths[selected]! - 1;
      used--;
    }
  };
  shrink(index => index === eventIndex ? widths[index]! : LIMITS[fields[index]!].min);
  shrink(() => 1);
  shrink(() => 0);
  if (eventIndex >= 0) widths[eventIndex] = widths[eventIndex]! + budget - used;
  const separator = ' '.repeat(gap);
  const codes = `${ansiColor(resolveColor(colors, 'selectionFg'))};${ansiColor(resolveColor(colors, 'selectionBg'), true)}`;
  const highlight = (text: string) => {
    const visible = text.trimEnd();
    return visible ? `\x1b[${codes}m${visible}\x1b[0m${text.slice(visible.length)}` : text;
  };
  return {
    widths,
    header: ' '.repeat(markerWidth) + fields.map((field, index) => cell(TABLE_LABELS[field], widths[index]!)).join(separator),
    items: rows.map((row, r) => {
      const cells = fields.map((field, index) => {
        const size = widths[index]!;
        const prefix = index === 0 ? indent(row.depth) : '';
        if (field === 'name' && collapsedIds?.has(row.agent.id)) {
          const suffix = size >= 2 ? ' ▸' : '▸';
          const visiblePrefix = clip(prefix, Math.max(0, size - stringWidth(suffix)));
          const name = clip(row.agent.name, Math.max(0, size - stringWidth(visiblePrefix) - stringWidth(suffix)));
          return cell(visiblePrefix + name + suffix, size);
        }
        if (field !== 'event') return cell(prefix + values[r]![index]!, size);
        const event = latest.get(row.agent.id);
        const preview = event ? renderTreeEvent(event, Math.max(0, size - stringWidth(prefix)), renderings.get(event.seq), colors) : '—';
        return styledCell(prefix + preview, size);
      });
      const rowText = cells.join(separator);
      if (markerWidth) {
        const marker = r === selectedIndex ? `\x1b[${codes}m${cell('▸', markerWidth)}\x1b[0m` : ' '.repeat(markerWidth);
        return marker + rowText;
      }
      if (r !== selectedIndex) return rowText;
      if (eventIndex < 0) return highlight(rowText);
      const parts: string[] = [];
      if (eventIndex > 0) parts.push(highlight(cells.slice(0, eventIndex).join(separator)));
      parts.push(cells[eventIndex]!);
      if (eventIndex < cells.length - 1) parts.push(highlight(cells.slice(eventIndex + 1).join(separator)));
      return parts.join(separator);
    }),
  };
}
