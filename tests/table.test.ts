import { expect, test } from 'bun:test';
import stringWidth from 'string-width';
import stripAnsi from 'strip-ansi';
import { renderTable } from '../src/table.js';
import { TABLE_FIELDS, DEFAULT_TABLE_FIELDS, Settings } from '../src/settings.js';
import { UI } from '../src/ui.js';
import { agent, event } from './helpers.js';

const rows = [
  { agent: agent('coordinator'), depth: 0 },
  { agent: agent('worker', 'coordinator'), depth: 1 },
];
const latest = new Map(rows.map(row => [row.agent.id, event(1, 'agent.message', {
  sessionUpdate: 'agent_message_chunk', content: { text: 'Reading files and reviewing the changes in the working tree' },
})]));

test('tree event summaries keep their beginning fixed as streamed Markdown completes', () => {
  const row = [{ agent: agent('root'), depth: 0 }];
  const summary = (text: string) => stripAnsi(renderTable(row, new Map([['root', event(1, 'agent.message', {
    sessionUpdate: 'agent_message_chunk', content: { text },
  }, { agentId: 'root' })]]), ['event'], 40).items[0]!).slice(2).trimEnd();
  const first = summary('[TREE_ANCHOR');
  const completed = summary('[TREE_ANCHOR](https://example.test) and more text');

  expect(first).toBe('[TREE_ANCHOR');
  expect(completed).toStartWith(first);
});

test('metadata follows content and Event gets remaining space', () => {
  const fields = ['name', 'status', 'harness', 'model', 'event'] as const;
  const table = renderTable(rows, latest, fields, 119);
  expect(table.widths.slice(0, 4)).toEqual([11, 6, 7, 10]);
  expect(table.widths[4]).toBe(77);
  expect(table.widths[4]).toBeGreaterThan(table.widths[2]! * 5);
  expect(table.items[1]).toStartWith('  worker');
  expect(stripAnsi(table.items[0]!)).toContain('Reading files and reviewing the changes');
});

test('collapsed branch marker follows the agent name and survives name clipping', () => {
  const collapsed = new Set(['coordinator']);
  const normal = renderTable(rows, latest, ['name', 'event'], 30);
  const marked = renderTable(rows, latest, ['name', 'event'], 30, new Map(), {}, 0, collapsed);
  const name = stripAnsi(marked.items[0]!).slice(0, marked.widths[0]);
  expect(name.trimEnd()).toBe('coordinator ▸');
  expect(marked.items[0]).not.toStartWith('▸');
  expect(marked.widths[1]).toBe(normal.widths[1]! - 2);
  const longRows = [{ agent: agent('a very long agent name'), depth: 0 }];
  const clipped = stripAnsi(renderTable(longRows, new Map(), ['name'], 10, new Map(), {}, -1, new Set([longRows[0]!.agent.id])).items[0]!);
  expect(clipped).toEndWith(' ▸');
  const tiny = renderTable([{ agent: agent('narrow'), depth: 5 }], new Map(), ['name'], 1, new Map(), {}, -1, new Set(['narrow']));
  expect(stripAnsi(tiny.items[0]!)).toBe('▸');
  for (let width = 0; width <= 30; width++) {
    const table = renderTable(rows, latest, ['name', 'event'], width, new Map(), {}, 0, collapsed);
    for (const line of [table.header, ...table.items]) expect(stringWidth(line)).toBeLessThanOrEqual(width);
  }
});

test('six independent usage columns show subtree totals and dash for missing metrics', () => {
  const row = [{ agent: agent('worker', null, { usage: {
    self: { 'tokens.input': 2 }, subtree: { 'tokens.input': 1200, 'tokens.output': 4, 'tokens.cache_read': 3, 'tokens.cache_write': 5, 'tokens.total': 1_200_000, 'cost.total': 999, 'cost.usd': 0.00000123 },
  } }), depth: 0 }];
  const fields = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'totalTokens', 'cost'] as const;
  const table = renderTable(row, new Map(), fields, 140);
  expect(fields.every(field => TABLE_FIELDS.includes(field))).toBe(true);
  expect(table.header).toContain('IN TOKENS');
  expect(table.header).toContain('OUT TOKENS');
  expect(table.header).toContain('CACHE READ');
  expect(table.header).toContain('CACHE WRITE');
  expect(table.header).toContain('TOTAL TOKENS');
  expect(table.header).toContain('COST');
  for (const value of ['1.2k', '4', '3', '5', '1.2M', '$0.00000123']) expect(table.items[0]).toContain(value);
  expect(table.items[0]).not.toContain('$999');
  expect(renderTable([{ agent: agent('empty'), depth: 0 }], new Map(), fields, 140).items[0]).toContain('-');
});

test('usage numbers retain reported cost precision, add currency, and compact large counts', () => {
  const usage = { subtree: { 'tokens.input': 1_234, 'cost.usd': 0.00000001, 'cost.total': 999 } };
  const table = renderTable([{ agent: agent('worker', null, { usage }), depth: 0 }], new Map(), ['inputTokens', 'cost'], 50);
  expect(table.items[0]).toContain('1.23k');
  expect(table.items[0]).toContain('$0.00000001');
  const reportedCost = renderTable([{ agent: agent('worker', null, { usage: { subtree: { 'cost.usd': 0.0246 } } }), depth: 0 }], new Map(), ['cost'], 20);
  expect(reportedCost.items[0]).toContain('$0.0246');
  expect(renderTable([{ agent: agent('worker', null, { usage: { subtree: { 'cost.total': 0, 'cost.eur': 12.5 } } }), depth: 0 }], new Map(), ['cost'], 20).items[0]).toContain('-');
  const custom = renderTable([{ agent: agent('worker', null, { usage: { subtree: { 'cost.eur': 12.5 } } }), depth: 0 }], new Map(), ['metric:cost.eur'], 30, new Map(), {}, -1, undefined, [{ id: 'cost.eur', title: 'Euro cost', unit: 'EUR' }]);
  expect(custom.header).toContain('Euro cost (EUR)');
  expect(custom.items[0]).toContain('12.5');
  expect(custom.items[0]).not.toContain('$');
});

test('tree hierarchy uses whitespace indentation', () => {
  const nested = [
    { agent: agent('root'), depth: 0 },
    { agent: agent('worker', 'root'), depth: 1 },
    { agent: agent('task', 'worker'), depth: 2 },
  ];
  const table = renderTable(nested, new Map(), ['name', 'event'], 60);
  expect(table.items[0]).toStartWith('root');
  expect(table.items[1]).toStartWith('  worker');
  expect(table.items[2]).toStartWith('    task');
  expect(table.widths).toEqual([8, 50]);
});

test('Event keeps priority with long metadata; metadata caps leave room on wide screens', () => {
  const long = [{ agent: agent('a'.repeat(100), null, { state: 'running', settings: { harness: 'pi', model: 'm'.repeat(100) } }), depth: 0 }];
  const narrow = renderTable(long, latest, DEFAULT_TABLE_FIELDS, 79);
  expect(narrow.widths[3]).toBeGreaterThanOrEqual(Math.floor((79 - 6) * 0.45));
  const wide = renderTable(long, latest, DEFAULT_TABLE_FIELDS, 199);
  expect(wide.widths).toEqual([28, 7, 30, 128]);
  const noEvent = renderTable(rows, latest, ['harness', 'revision'], 199);
  expect(noEvent.widths).toEqual([7, 8]); // Do not stretch short metadata just to fill a screen.
});

test('selected tree row styling ends before the event summary', () => {
  const table = renderTable(rows, latest, ['name', 'status', 'event'], 100, new Map(), { selectionFg: 'white', selectionBg: 'blue' }, 0);
  const selected = table.items[0]!;
  const eventStart = selected.indexOf('Reading files');
  expect(selected).toContain('\x1b[37;44m');
  const selectionEnd = selected.indexOf('\x1b[0m');
  expect(eventStart).toBeGreaterThan(selectionEnd);
  expect(selected.slice(selectionEnd + '\x1b[0m'.length, eventStart)).toMatch(/^\s+/);
  expect(selected.slice(eventStart)).not.toContain('\x1b[37;44m');
  expect(table.items[1]).not.toContain('\x1b[37;44m');
});

test('selection highlights metadata on either side of Event and marks Event-only rows', () => {
  for (const fields of [['event', 'name'], ['name', 'event', 'status'], ['name', 'status'], ['event']] as const) {
    const plain = renderTable(rows, latest, fields, 80);
    const selected = renderTable(rows, latest, fields, 80, new Map(), {}, 0);
    expect(stripAnsi(selected.items[0]!)).toBe(fields.length === 1
      ? '▸' + stripAnsi(plain.items[0]!).slice(1) : stripAnsi(plain.items[0]!));
    expect(selected.items[0]).toContain('\x1b[37;44m');
    expect(selected.items[1]).not.toContain('\x1b[37;44m');
    expect(selected.items[0]).not.toContain('\x1b[37;44mReading');
    expect(stringWidth(selected.items[0]!)).toBeLessThanOrEqual(80);
  }
});

test('reordered Event preserves styles, alignment and first-column tree indentation', () => {
  const table = renderTable(rows, latest, ['event', 'harness', 'name'], 80);
  const [eventWidth, harnessWidth] = table.widths;
  const text = stripAnsi(table.items[1]!);
  expect(text).toStartWith('  Reading files');
  expect(text.slice(eventWidth! + 2, eventWidth! + 2 + harnessWidth!)).toBe('pi     ');
  expect(text.slice(0, eventWidth!)).not.toContain('worker');
  expect(table.items[1]).toContain('\x1b[0m');
  expect(table.header.indexOf('HARNESS')).toBe(eventWidth! + 2);
  expect(renderTable(rows, new Map(), ['event', 'name'], 80).items[1]).toStartWith('  —');
});

test('headers and Unicode rows fit even very narrow terminals, with no control injection', () => {
  const unicodeRows = [{ agent: agent('👩‍💻界e\u0301\x1b[2J\x07\nname'), depth: 5 }];
  for (const fields of [TABLE_FIELDS, [...TABLE_FIELDS].reverse(), ['event'] as const, DEFAULT_TABLE_FIELDS]) {
    for (let width = 0; width <= 160; width++) {
      const table = renderTable(unicodeRows, latest, fields, width, new Map(), {}, 0);
      for (const line of [table.header, ...table.items]) {
        expect(stringWidth(line)).toBeLessThanOrEqual(width);
        expect(line).not.toContain('\n');
        expect(line).not.toContain('\x1b[2J');
        expect(line).not.toContain('\x07');
      }
    }
  }
  expect(renderTable([], new Map(), DEFAULT_TABLE_FIELDS, 80).items).toEqual([]);
});

test('table controls toggle, reorder, reset and protect the last visible field', () => {
  const settings = new Settings();
  let saves = 0;
  const notices: string[] = [];
  const ui = Object.create(UI.prototype) as any;
  Object.assign(ui, { settings, view: 'table-fields', menuIndex: 0,
    saveSettings: () => { saves++; }, draw: () => {}, showNotice: (text: string) => notices.push(text),
  });
  const key = (binding: string) => ui.contextActions().find((action: any) => action.key === binding).run();
  key('right'); expect(settings.tableFields).toEqual(['status', 'name', 'model', 'event']);
  key('0'); expect(settings.tableFields).toEqual(['status', 'model', 'event', 'name']);
  key('1'); expect(settings.tableFields).toEqual([...DEFAULT_TABLE_FIELDS]);
  key('space'); expect(settings.tableFields).toEqual(['status', 'model', 'event']);
  key('left'); expect(notices.at(-1)).toContain('Enable this field');
  key('space'); expect(settings.tableFields).toEqual(['status', 'model', 'event', 'name']);
  settings.tableFields = ['name'];
  const before = saves;
  key('space'); expect(settings.tableFields).toEqual(['name']);
  expect(notices.at(-1)).toContain('at least one'); expect(saves).toBe(before);
  key('z'); expect(settings.tableFields).toEqual([...DEFAULT_TABLE_FIELDS]);
});
