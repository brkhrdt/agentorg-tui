import { expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import stripAnsi from 'strip-ansi';
import stringWidth from 'string-width';
import { renderEvent, renderTreeEvent, chatGroups } from '../src/render.js';
import { renderTable } from '../src/table.js';
import { rendererPreview } from '../src/renderer-preview.js';
import { Settings } from '../src/settings.js';
import { Store } from '../src/store.js';
import { Session } from '../src/session.js';
import type { EventRendering, RendererMetadata } from '../src/protocol.js';
import { terminalClient } from './terminal.js';
import { agent, event, mockServer, respond, send, waitFor } from './helpers.js';

const raw = event(1, 'tool.result', { title: 'read', status: 'completed', rawInput: { path: 'src/main.ts' }, rawOutput: 'ORIGINAL OUTPUT' });
const rendering: EventRendering = { rendererId: 'pi/read', subtype: 'read', summary: '**read src/main.ts** · completed', extended: 'read src/main.ts · completed\n2 lines', full: '**Custom read complete**\n\n```ts\nconst answer = 42;\n```' };
const metadata: RendererMetadata = { id: 'pi/read', name: 'Pi read', harness: 'pi', eventTypes: ['tool.result'], tool: 'read', examples: [{ type: 'tool.result', ...rendering, raw: JSON.stringify(raw, null, 2) }] };

test('server Markdown controls content, client controls styles/cell limits and raw ignores presentations', () => {
  const summary = renderTreeEvent(raw, 32, rendering);
  expect(stripAnsi(summary)).toContain('read src/main.ts');
  expect(summary).toContain('\x1b[1m');
  expect(summary.split('\n')).toHaveLength(1);
  expect(stringWidth(summary)).toBeLessThanOrEqual(32);
  expect(renderEvent(raw, 1, 32, rendering)).toBe(summary);
  const extended = stripAnsi(renderEvent(raw, 2, 80, rendering));
  expect(extended.split('\n')).toHaveLength(2);
  expect(extended).toContain('2 lines');
  expect(renderEvent(raw, 2, 10, rendering).split('\n').length).toBeGreaterThan(2); // Logical lines may wrap.
  const full = stripAnsi(renderEvent(raw, 3, 80, rendering));
  expect(full).toContain('Custom read complete'); expect(full).toContain('const answer = 42;');
  expect(JSON.parse(renderEvent(raw, 4, 10000, rendering))).toEqual(raw);
  const hostile = { ...rendering, summary: '\x1b[2J**safe**\x07\nunsafe second line', extended: 'one\ntwo\nthird', full: '\x1b]0;remote title\x07**safe**\x1b[2J' };
  expect(stripAnsi(renderTreeEvent(raw, 80, hostile))).toContain('safe');
  expect(renderTreeEvent(raw, 80, hostile)).not.toContain('unsafe second line');
  expect(renderEvent(raw, 2, 80, hostile)).not.toContain('third');
  expect(renderEvent(raw, 3, 80, hostile)).not.toContain('\x1b[2J');
  expect(renderEvent(raw, 3, 80, hostile)).not.toContain('\x1b]0;');
});

test('presentation sidecars select tree summaries independently of chat subtype levels and do not merge custom messages', () => {
  const store = new Store(), settings = new Settings();
  store.install({ seq: 0, agents: [agent('root')], operations: [] });
  store.present(raw.seq, rendering); store.ingest(raw);
  settings.levels['tool.result:read'] = 4;
  expect(settings.level('tool.result', 'read')).toBe(4);
  expect(settings.level('tool.result', 'edit')).toBe(2);
  expect(settings.level('tool.result:write')).toBe(2);
  const table = renderTable(store.tree(), store.latest(settings), ['event'], 80, store.renderings);
  expect(stripAnsi(table.items[0]!)).toContain('read src/main.ts');
  expect(stripAnsi(table.items[0]!)).not.toContain('ORIGINAL OUTPUT');
  expect(store.discovered.has('tool.result:read')).toBe(true);
  const messages = [event(2), event(3)];
  store.present(2, { ...rendering, rendererId: 'pi/message' });
  expect(chatGroups(messages, settings, store.renderings)).toHaveLength(2);
  store.ingest(messages[0]!); store.ingest(messages[1]!);
  expect(store.latest(settings).get('root')!.data).toEqual(messages[1]!.data);
  store.reset(); expect(store.renderings.size).toBe(0);
});

test('examples show all four levels when space allows, only the selected level on small terminals', () => {
  const large = rendererPreview(metadata, 'tool.result', 3, 55, 24);
  for (const text of ['1 summary', '2 extended', '3 full', '4 raw', 'Pi read', 'Custom read complete']) expect(large).toContain(text);
  const small = rendererPreview(metadata, 'tool.result', 2, 25, 7);
  expect(small).toContain('2 extended'); expect(small).not.toContain('4 raw');
  for (const line of small.split('\n')) expect(stringWidth(line)).toBeLessThanOrEqual(25);
});

async function renderingServer() {
  return mockServer((socket, request) => {
    if (request.method === 'organization.snapshot') respond(socket, request.id, { seq: 1, agents: [agent('root')], operations: [], capabilities: { rendering: { version: 1, catalog: 'events.renderers' } } });
    else if (request.method === 'events.renderers') respond(socket, request.id, { version: 1, renderers: [metadata, { ...metadata, id: 'core.tools', name: 'Core styles', harness: undefined, tool: undefined }] });
    else if (request.method === 'subscribe') respond(socket, request.id, { seq: 1, liveOnly: true });
    else if (request.method === 'events.history') respond(socket, request.id, { events: request.params.after < 1 ? [raw] : [], renderings: { 1: rendering }, oldestSeq: 1, latestSeq: 1, expired: false });
  });
}

test('Session negotiates server rendering, installs history sidecars and dispatches live presentations separately', async () => {
  const mock = await renderingServer(), session = new Session(mock.path);
  const running = session.run();
  try {
    await waitFor(() => session.status === 'connected');
    expect(session.renderers[0]!.id).toBe('pi/read');
    expect(session.store.events.get(1)).toEqual(raw);
    expect(session.store.renderings.get(1)).toEqual(rendering);
    for (const socket of mock.sockets) {
      send(socket, { kind: 'presentation', seq: 2, rendering });
      send(socket, { ...raw, seq: 2 });
    }
    await waitFor(() => session.store.events.has(2));
    expect(session.store.renderings.get(2)).toEqual(rendering);
    expect(session.store.events.get(2)).not.toHaveProperty('rendering');
  } finally { session.close(); await running; await mock.close(); }
});

test('terminal level selector previews renderer examples, saves subtype overrides, and tree/raw chat stay independent', async () => {
  const mock = await renderingServer(), tui = terminalClient(mock.path, mock.directory);
  try {
    await tui.visible('read src/main.ts');
    tui.keys('vl'); await tui.visible('Event rendering levels');
    const settings = new Settings();
    const index = settings.types(['tool.result:read']).indexOf('tool.result:read');
    tui.keys('\x1b[B'.repeat(index));
    await tui.visible('Pi read');
    await tui.visible('1 summary'); await tui.visible('4 raw');
    tui.keys('r'); await tui.visible('Core styles');
    tui.keys('3'); await tui.visible('Custom read complete');
    const path = join(mock.directory, 'config.json');
    await waitFor(() => tui.screen().includes('Saved '));
    expect(JSON.parse(await readFile(path, 'utf8')).levels['tool.result:read']).toBe(3);
    tui.keys('z'); await waitFor(asyncReadGuard(path, 'tool.result:read', undefined));
    expect((await Settings.load(path)).level('tool.result', 'read')).toBe(2);
    tui.keys('4'); await tui.visible('4 raw');
    await waitFor(asyncReadGuard(path, 'tool.result:read', 4));
    tui.keys('\x1b'); await tui.visible('LATEST TRACKED EVENT');
    expect(tui.screen()).toContain('read src/main.ts');
    tui.keys('c'); await tui.visible('Chat · root');
    await tui.visible('ORIGINAL OUTPUT');
    expect(tui.screen()).not.toContain('Custom read complete');
  } finally { await tui.close(); await mock.close(); }
}, 15000);

test('terminal level names use the available pane width before truncating long MCP tools', async () => {
  const type = 'tool.call:mcp__organization__child_create';
  const tooLong = `${type}_${'extra'.repeat(12)}`;
  const mock = await mockServer((socket, request) => {
    if (request.method === 'organization.snapshot') respond(socket, request.id, { seq: 2, agents: [agent('root')], operations: [] });
    else if (request.method === 'events.history') respond(socket, request.id, {
      events: request.params.after < 2 ? [event(1, type), event(2, tooLong)] : [], oldestSeq: 1, latestSeq: 2, expired: false,
    });
  });
  const tui = terminalClient(mock.path, mock.directory);
  try {
    await tui.visible('connected');
    tui.keys('vl'); await tui.visible('Event rendering levels');
    const index = new Settings().types([type, tooLong]).indexOf(type);
    tui.keys('\x1b[B'.repeat(index));
    await tui.visible(type);
    const row = tui.screen().split('\n').find(line => line.startsWith(type))!;
    expect(row.slice(0, 60)).toContain('1 summary');
    expect(row.slice(0, 60)).not.toContain('…');
    const clipped = tui.screen().split('\n').find(line => line.startsWith(`${type}_`))!;
    expect(clipped.slice(0, 60)).toContain('…');
    expect(clipped.slice(0, 60)).toContain('1 summary');
    expect(tui.screen()).toContain('Renderer examples');
    tui.keys('2'); await waitFor(asyncReadGuard(join(mock.directory, 'config.json'), type, 2));
    await tui.visible('2 extended');
    expect(tui.screen().split('\n').find(line => line.startsWith(type))!.slice(0, 60)).toContain('2 extended');
  } finally { await tui.close(); await mock.close(); }
}, 15000);

// waitFor's predicate is synchronous; poll a detached read to avoid racing the atomic save.
function asyncReadGuard(path: string, key: string, value: number | undefined): () => boolean {
  let matched = false;
  return () => { void readFile(path, 'utf8').then(text => { matched = JSON.parse(text).levels[key] === value; }).catch(() => {}); return matched; };
}
