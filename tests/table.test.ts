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
  sessionUpdate: 'agent_message_chunk', content: { text: '**Reading files** and reviewing the changes in the working tree' },
})]));

test('metadata follows content and Event gets remaining space', () => {
  const fields = ['name', 'status', 'harness', 'model', 'event'] as const;
  const table = renderTable(rows, latest, fields, 119);
  expect(table.widths.slice(0, 4)).toEqual([11, 6, 7, 10]);
  expect(table.widths[4]).toBe(77);
  expect(table.widths[4]).toBeGreaterThan(table.widths[2]! * 5);
  expect(table.items[1]).toContain('  └ worker');
  expect(stripAnsi(table.items[0]!)).toContain('Reading files and reviewing the changes');
  expect(table.items[0]).toContain('\x1b[1mReading files');
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

test('reordered Event preserves styles, alignment and first-column tree indentation', () => {
  const table = renderTable(rows, latest, ['event', 'harness', 'name'], 80);
  const [eventWidth, harnessWidth] = table.widths;
  const text = stripAnsi(table.items[1]!);
  expect(text).toStartWith('  └ Reading files');
  expect(text.slice(eventWidth! + 2, eventWidth! + 2 + harnessWidth!)).toBe('pi     ');
  expect(text).not.toContain('└ worker');
  expect(table.items[1]).toContain('\x1b[0m');
  expect(table.header.indexOf('HARNESS')).toBe(eventWidth! + 2);
  expect(renderTable(rows, new Map(), ['event', 'name'], 80).items[1]).toContain('  └ —');
});

test('headers and Unicode rows fit even very narrow terminals, with no control injection', () => {
  const unicodeRows = [{ agent: agent('👩‍💻界e\u0301\x1b[2J\x07\nname'), depth: 5 }];
  for (const fields of [TABLE_FIELDS, [...TABLE_FIELDS].reverse(), ['event'] as const, DEFAULT_TABLE_FIELDS]) {
    for (let width = 0; width <= 160; width++) {
      const table = renderTable(unicodeRows, latest, fields, width);
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
