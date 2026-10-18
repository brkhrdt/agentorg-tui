import { expect, test } from 'bun:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { renderEvent, renderTreeEvent } from '../src/render.js';
import { rendererPreview } from '../src/renderer-preview.js';
import { ansiColor, DEFAULT_COLORS, Settings } from '../src/settings.js';
import { agent, event, mockServer, respond } from './helpers.js';
import { terminalClient } from './terminal.js';

test('color preferences validate partial palettes and retain defaults for older configurations', async () => {
  const mock = await mockServer(() => {});
  const path = join(mock.directory, 'config.json');
  const save = (colors?: unknown) => writeFile(path, JSON.stringify({ excluded: [], levels: {}, colors }));
  try {
    await save();
    expect((await Settings.load(path)).colors).toEqual(DEFAULT_COLORS);
    await save({ toolCall: 'default', title: 'orange', futurePreference: 'ignored' });
    expect((await Settings.load(path)).colors).toEqual({ ...DEFAULT_COLORS, toolCall: 'default', title: 'orange' });
    for (const colors of [null, [], 'blue', { title: 'not-a-color' }, { title: 208 }]) {
      await save(colors);
      await expect(Settings.load(path)).rejects.toThrow(/Invalid color/);
    }
    expect(ansiColor('default')).toBe('39');
    expect(ansiColor('default', true)).toBe('49');
    expect(ansiColor('orange', true)).toBe('48;5;208');
    expect(ansiColor('gray', true)).toBe('100');
  } finally { await mock.close(); }
});

test('event palettes affect symbols, Markdown, diffs and previews without stale cached colors', () => {
  const settings = new Settings();
  Object.assign(settings.colors, { toolCall: 'magenta', diffAdd: 'blue', diffRemove: 'yellow', eventHeading: 'red', eventCode: 'green', eventLink: 'cyan' });
  const raw = event(1, 'tool.call', { title: 'edit' });
  const rendering = { rendererId: 'test/colors', summary: 'Δ file · +1 / -1', extended: 'Δ file · +1 / -1', full: 'Δ file · +1 / -1\n\n```diff\n@@ -1 +1 @@\n-old\n+new\n```' };
  const render = (colors = settings.colors) => renderEvent(raw, 3, 80, rendering, colors);
  const first = render();
  expect(first).toStartWith('\x1b[35mΔ');
  expect(first).toContain('\x1b[34m+new');
  expect(first).toContain('\x1b[33m-old');
  expect(first).toContain('\x1b[31m@@');
  expect(renderTreeEvent(raw, 80, rendering, settings.colors)).toContain('\x1b[34m+1');
  const original = { ...settings.colors };
  settings.colors.diffAdd = 'cyan';
  expect(render()).toContain('\x1b[36m+new');
  expect(render(original)).toBe(first); // Reuse the original cache entry after mutating its source object.
  const message = event(2, 'agent.message', { content: { text: '# Heading\n\n`code` and [link](https://example.com)' } });
  const markdown = renderEvent(message, 3, 80, undefined, settings.colors);
  expect(markdown).toContain('\x1b[1;31m# Heading');
  expect(markdown).toContain('\x1b[32mcode');
  expect(markdown).toContain('\x1b[36mlink');
  const metadata = { id: rendering.rendererId, name: 'Colors', eventTypes: [raw.type], examples: [{ ...rendering, type: raw.type, raw: JSON.stringify(raw) }] };
  expect(rendererPreview(metadata, raw.type, 3, 80, 12, settings.colors)).toContain('\x1b[36m+new');
  expect(renderEvent(raw, 4, 10000, rendering, settings.colors)).toBe(renderEvent(raw, 4, 10000, rendering));
});

test('orange preferences render consistently in widgets, selection and event summaries', async () => {
  const raw = event(1, 'tool.call', { title: 'bash', rawInput: { command: 'echo colors' } });
  const mock = await mockServer((socket, request) => {
    if (request.method === 'organization.snapshot') respond(socket, request.id, { seq: 1, agents: [agent('root')], operations: [] });
    else if (request.method === 'events.history') respond(socket, request.id, { events: [raw], oldestSeq: 1, latestSeq: 1, expired: false });
  });
  const settings = new Settings();
  Object.assign(settings.colors, { title: 'orange', selectionBg: 'orange', toolCall: 'orange' });
  await settings.save(join(mock.directory, 'config.json'));
  const tui = terminalClient(mock.path, mock.directory);
  try {
    await tui.visible('$ echo colors');
    expect(tui.cell(0, 0)?.getFgColor()).toBe(208);
    expect(tui.cell(2, 0)?.getBgColor()).toBe(208);
    const column = tui.screen().split('\n')[2]!.indexOf('$ echo colors');
    expect(tui.cell(2, column)?.getFgColor()).toBe(208);
    expect(tui.cell(2, column)?.isBgDefault()).toBeTruthy();
    tui.keys('vt'); await tui.visible('Selection background: orange');
    expect(tui.cell(2, 0)?.getBgColor()).toBe(208);
  } finally { await tui.close(); await mock.close(); }
});
