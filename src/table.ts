import stringWidth from 'string-width';
import type { ServerEvent, EventRendering } from './protocol.js';
import { cell, clean, renderTreeEvent, styledCell } from './render.js';
import { ansiColor, type ColorSetting, type TableField } from './settings.js';
import type { TreeRow } from './store.js';

const TABLE_LABELS: Record<TableField, string> = {
  name: 'AGENT', status: 'STATUS', model: 'MODEL', event: 'LATEST TRACKED EVENT',
  error: 'ERROR', harness: 'HARNESS', provider: 'PROVIDER', cwd: 'CWD', session: 'SESSION', revision: 'REVISION',
};
// Metadata follows its content up to a cap; Event receives all remaining space.
const LIMITS: Record<TableField, { min: number; max: number }> = {
  name: { min: 8, max: 28 }, status: { min: 6, max: 12 }, model: { min: 8, max: 30 },
  event: { min: 12, max: Infinity }, error: { min: 8, max: 32 }, harness: { min: 7, max: 16 },
  provider: { min: 8, max: 20 }, cwd: { min: 8, max: 32 }, session: { min: 7, max: 10 }, revision: { min: 8, max: 10 },
};
const indent = (depth: number) => '  '.repeat(depth);
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
    case 'event': return '—'; // Styled previews are rendered only after allocating widths.
  }
}

/** Width includes only usable list cells (the caller reserves the scrollbar). */
export function renderTable(rows: TreeRow[], latest: Map<string, ServerEvent>, fields: readonly TableField[], width: number, renderings: Map<number, EventRendering> = new Map(), colors: Partial<Record<ColorSetting, string>> = {}, selectedIndex = -1) {
  width = Math.max(0, Math.floor(width));
  if (!fields.length) return { header: '', items: rows.map(() => ''), widths: [] as number[] };
  const gap = fields.length < 2 ? 0 : Math.max(0, Math.min(2, Math.floor((width - fields.length) / (fields.length - 1))));
  const budget = width - gap * (fields.length - 1);
  const values = rows.map(row => fields.map(field => value(row, field)));
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
  return {
    widths,
    header: fields.map((field, index) => cell(TABLE_LABELS[field], widths[index]!)).join(separator),
    items: rows.map((row, r) => {
      const cells = fields.map((field, index) => {
        const size = widths[index]!;
        const prefix = index === 0 ? indent(row.depth) : '';
        if (field !== 'event') return cell(prefix + values[r]![index]!, size);
        const event = latest.get(row.agent.id);
        const preview = event ? renderTreeEvent(event, Math.max(0, size - stringWidth(prefix)), renderings.get(event.seq), colors) : '—';
        return styledCell(prefix + preview, size);
      });
      const eventIndex = fields.indexOf('event');
      const end = eventIndex < 0 ? cells.length : eventIndex;
      const rowText = cells.join(separator);
      if (r !== selectedIndex || end === 0) return rowText;
      const prefixText = cells.slice(0, end).join(separator).trimEnd();
      const codes = `${ansiColor(colors.selectionFg ?? 'white')};${ansiColor(colors.selectionBg ?? 'blue', true)}`;
      return `\x1b[${codes}m${prefixText}\x1b[0m${rowText.slice(prefixText.length)}`;
    }),
  };
}
