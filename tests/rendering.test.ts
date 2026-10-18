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
const rendering: EventRendering = { rendererId: 'pi/read', subtype: 'read', summary: '\\< src/main.ts', extended: '\\< src/main.ts\n2 lines', full: '\\< src/main.ts\n\n**Custom read complete**\n\n```ts\nconst answer = 42;\n```' };
const metadata: RendererMetadata = { id: 'pi/read', name: 'Pi read', harness: 'pi', eventTypes: ['tool.result'], tool: 'read', examples: [{ type: 'tool.result', ...rendering, raw: JSON.stringify(raw, null, 2) }] };

test('server Markdown controls content, client controls styles/cell limits and raw ignores presentations', () => {
  const summary = renderTreeEvent(raw, 32, rendering);
  expect(stripAnsi(summary)).toBe('< src/main.ts');
  expect(summary).toStartWith('\x1b[32m<\x1b[0m src/main.ts');
  expect(summary).not.toContain('\x1b[1m');
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

test('extended output truncates wrapped overflow with an ellipsis after two terminal rows', () => {
  const e = event(1, 'agent.message', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ignored' } });
  const longSecondRow = 'second '.repeat(10);
  const presentation: EventRendering = { rendererId: 'fixture', summary: 'short', extended: `short\n${longSecondRow}`, full: 'short' };
  const rendered = stripAnsi(renderEvent(e, 2, 20, presentation));
  expect(rendered.split('\n')).toHaveLength(2);
  expect(rendered).toEndWith('…');
  for (const row of rendered.split('\n')) expect(stringWidth(row)).toBeLessThanOrEqual(20);
});

test('tool updates show the latest output row in extended and five rows in full', () => {
  const update = event(1, 'tool.update', { title: 'bash', status: 'in_progress', rawInput: { command: 'long-running' }, rawOutput: { content: [{ type: 'text', text: 'one\ntwo\nthree\nfour\nfive\nsix' }], details: {} } });
  const presentation: EventRendering = { rendererId: 'core.tools', summary: '$ long-running', extended: '$ long-running\nsix', full: '$ long-running\n\n```\none\ntwo\nthree\nfour\nfive\nsix\n```' };
  const extended = stripAnsi(renderEvent(update, 2, 80, presentation));
  expect(extended).toContain('6 lines received');
  expect(extended).toContain('six');
  expect(extended).not.toContain('five');
  const renderedFull = renderEvent(update, 3, 80, presentation);
  const full = stripAnsi(renderedFull);
  expect(full).toContain('6 lines received');
  expect(full).toContain('two'); expect(full).toContain('three'); expect(full).toContain('four');
  expect(full).toContain('five'); expect(full).toContain('six');
  expect(full).not.toContain('one');
  expect(full).toContain('showing last 5 rows');
  expect(full).toContain('  │ two');
  expect(renderedFull.split('\n')[1]).toStartWith('\x1b[38;5;250m6 lines received');
  expect(renderedFull).toContain('\x1b[38;5;250m  │ \x1b[0m');
  expect(renderedFull).not.toContain('\x1b[47;30m');
});

test('rolling output is bounded after wrapping, stays literal and fits narrow Unicode terminals', () => {
  const update = event(1, 'tool.update', { title: 'bash', rawInput: { command: 'a long command that wraps' }, rawOutput: `OLD OUTPUT\n${'文件🦊 é '.repeat(80)}LATEST` });
  for (const width of [1, 2, 3, 5, 6, 12, 40, 80]) {
    for (const [level, maxRows] of [[2, 1], [3, 5]] as const) {
      const rendered = renderEvent(update, level, width);
      const lines = stripAnsi(rendered).split('\n');
      // Wrapped header, one clipped metadata row, then the bounded output viewport.
      const header = stripAnsi(renderEvent(update, 1, 1000));
      const expectedHeaderRows = Math.ceil(stringWidth(header) / width);
      expect(lines.length).toBeLessThanOrEqual(expectedHeaderRows + 1 + maxRows);
      for (const line of lines) expect(stringWidth(line)).toBeLessThanOrEqual(width);
      expect(rendered).not.toContain('OLD OUTPUT');
      if (width >= 12) expect(rendered).toContain('LATEST');
      expect(rendered).not.toContain('�');
    }
  }
  const literal = event(2, 'tool.update', { title: 'bash', rawOutput: '**not bold**\n  indented\n\n```ts\n{blessed}' });
  const rendered = renderEvent(literal, 3, 80);
  expect(stripAnsi(rendered).split('\n').slice(2)).toEqual(['  │ **not bold**', '  │   indented', '  │ ', '  │ ```ts', '  │ {blessed}']);
  expect(rendered).not.toContain('\x1b[1m');
});

test('updates without output retain renderer details instead of inventing received lines', () => {
  const update = event(1, 'tool.update', { title: 'custom', status: 'in_progress' });
  const presentation: EventRendering = { rendererId: 'custom', summary: '• custom', extended: '• custom\n**Waiting for approval**', full: '• custom\n\n**Custom progress**' };
  expect(stripAnsi(renderEvent(update, 2, 80, presentation))).toBe('• custom\nWaiting for approval');
  expect(stripAnsi(renderEvent(update, 3, 80, presentation))).toContain('Custom progress');
  for (const level of [2, 3] as const) {
    expect(stripAnsi(renderEvent(update, level, 80))).not.toContain('lines received');
    const empty = { ...update, data: { ...update.data as object, rawOutput: '' } };
    expect(stripAnsi(renderEvent(empty, level, 80))).toContain('0 lines received');
    expect(stripAnsi(renderEvent(empty, level, 80))).not.toContain('1 line received');
  }
});

test('update output normalizes line endings before removing unsafe terminal commands', () => {
  const update = event(1, 'tool.update', { title: 'bash', rawOutput: '\x1b]0;bad\x07one\r\ntwo\rthree\u2028four\u2029five\n' });
  const rendered = renderEvent(update, 3, 80);
  expect(stripAnsi(rendered)).toContain('5 lines received');
  for (const line of ['one', 'two', 'three', 'four', 'five']) expect(stripAnsi(rendered)).toContain(line);
  expect(rendered).not.toContain('\x1b]0;');
});

test('only tool symbols use lifecycle colors; commands, filenames and output stay plain', () => {
  const presentation: EventRendering = { rendererId: 'core.tools', summary: '$ echo hello', extended: '$ echo hello\nhello', full: '$ echo hello\n\n```\nhello\n```' };
  for (const [type, status, color] of [['tool.call', 'pending', '33'], ['tool.update', 'in_progress', '38;5;208'], ['tool.result', 'completed', '32'], ['tool.result', 'failed', '31'], ['tool.result', 'cancelled', '31'], ['tool.result', undefined, '90']]) {
    const e = event(1, type, { title: 'bash', status });
    for (const level of [1, 2, 3] as const) {
      const rendered = renderEvent(e, level, 80, presentation);
      expect(rendered).toStartWith(`\x1b[${color}m$\x1b[0m echo hello`);
      expect(stripAnsi(rendered)).not.toContain(type! + ':');
      expect(stripAnsi(rendered)).not.toContain('pending');
      if (level === 2 && type !== 'tool.update') expect(rendered.split('\n')[1]).toBe('hello');
    }
    expect(renderTreeEvent(e, 80, presentation)).toStartWith(`\x1b[${color}m$\x1b[0m echo hello`);
    expect(JSON.parse(renderEvent(e, 4, 10000, presentation))).toEqual(e);
  }
  for (const rawOutput of [{ isError: true }, { structuredContent: { exit_code: 7 } }, { content: [{ type: 'text', text: 'exit code: 2' }] }]) {
    expect(renderTreeEvent(event(1, 'tool.result', { title: 'bash', status: 'completed', rawOutput }), 80, presentation)).toStartWith('\x1b[31m');
  }
  for (const [tool, symbol] of [['bash', '$'], ['read', '<'], ['write', '>'], ['edit', 'Δ'], ['mcp__organization__child_create', '• mcp__organization__child_create']]) {
    const e = event(1, 'tool.call', { title: tool, status: 'pending', rawInput: { path: 'a.ts', command: 'echo hello' } });
    const rendered = renderEvent(e, 1, 100);
    expect(stripAnsi(rendered)).toStartWith(symbol!);
    expect(rendered).toStartWith(`\x1b[33m${symbol![0]}\x1b[0m `);
    expect(stripAnsi(renderEvent(e, 3, 100))).not.toContain('tool.call');
    expect(stripAnsi(renderEvent(e, 3, 100))).not.toContain('pending');
  }
});

test('edit filenames stay plain while only the symbol and signed line counts carry color', () => {
  const presentation: EventRendering = { rendererId: 'pi/edit', subtype: 'edit', summary: 'Δ file-2.ts · +3 / -2', extended: 'Δ file-2.ts · +3 / -2', full: 'Δ file-2.ts · +3 / -2' };
  for (const [type, status, color] of [['tool.call', 'pending', '33'], ['tool.update', 'in_progress', '38;5;208'], ['tool.result', 'completed', '32'], ['tool.result', 'failed', '31']]) {
    const e = event(1, type, { toolCallId: 'same', status });
    for (const level of [1, 2, 3] as const) {
      const text = renderEvent(e, level, 80, presentation);
      expect(text).toStartWith(`\x1b[${color}mΔ\x1b[0m file-2.ts · `);
      expect(text).toContain('\x1b[32m+3\x1b[0m / \x1b[31m-2\x1b[0m');
      expect(stripAnsi(text)).toBe('Δ file-2.ts · +3 / -2');
    }
  }
  const sparseBash = event(2, 'tool.result', { toolCallId: 'old-call', status: 'completed', rawOutput: { content: [{ type: 'text', text: 'Command exited with code 127' }] } });
  const bash: EventRendering = { rendererId: 'pi/bash', subtype: 'bash', summary: '$ python --version', extended: '$ python --version\nCommand exited with code 127', full: '$ python --version\nCommand exited with code 127' };
  expect(renderTreeEvent(sparseBash, 80, bash)).toStartWith('\x1b[31m$\x1b[0m python --version');
});

test('edit extended uses semantic old/new colors and aligns using terminal cells; full colors diff hunks', () => {
  const prefix = 'Δ src/文件🦊.ts';
  const e = event(1, 'tool.call', { title: 'edit', rawInput: { path: 'src/文件🦊.ts' } });
  const presentation: EventRendering = {
    rendererId: 'pi/edit', subtype: 'edit', summary: `${prefix} · +1 / -1`, extended: `${prefix} old\n  new`,
    extendedDiff: { prefix, before: 'old <code>*', after: 'new <code>*' },
    full: `${prefix} · +1 / -1\n\nProposed changes:\n\n\`\`\`diff\n@@ -1 +1 @@\n-old <code>*\n+new <code>*\n\`\`\``,
  };
  const extended = renderEvent(e, 2, 100, presentation);
  expect(extended).toContain('\x1b[31mold <code>*'); expect(extended).toContain('\x1b[32mnew <code>*');
  expect(stripAnsi(extended).split('\n')).toEqual([`${prefix} old <code>*`, `${' '.repeat(stringWidth(prefix) + 1)}new <code>*`]);
  const summary = renderTreeEvent(e, 100, presentation);
  expect(summary).toStartWith(`\x1b[33mΔ\x1b[0m src/文件🦊.ts · `);
  expect(summary).toContain('\x1b[32m+1\x1b[0m / \x1b[31m-1\x1b[0m');
  const full = renderEvent(e, 3, 100, presentation);
  expect(full).toStartWith('\x1b[33mΔ\x1b[0m src/文件🦊.ts');
  expect(full).toContain('\x1b[31m-old <code>*'); expect(full).toContain('\x1b[32m+new <code>*');
  expect(stripAnsi(full)).not.toContain('tool.call');
  expect(stripAnsi(full)).toContain('@@ -1 +1 @@');
  for (const width of [1, 8, 16, 40]) {
    const summary = renderTreeEvent(e, width, presentation);
    expect(summary.split('\n')).toHaveLength(1); expect(stringWidth(summary)).toBeLessThanOrEqual(width);
    const wrapped = renderEvent(e, 2, width, presentation);
    for (const line of wrapped.split('\n')) expect(stringWidth(line)).toBeLessThanOrEqual(Math.max(width, 2)); // Wide glyphs occupy two cells.
    expect(stripAnsi(wrapped)).not.toMatch(/\n {8,}\n/);
  }
  const hostile = { ...presentation, extendedDiff: { prefix: '\x1b[2JΔ file\x07', before: '\x1b]0;bad\x07old\ntext', after: '\x1b[2Jnew' } };
  const safe = renderEvent(e, 2, 80, hostile);
  expect(safe).not.toContain('\x1b[2J'); expect(safe).not.toContain('\x1b]0;');
  expect(stripAnsi(safe).split('\n')).toHaveLength(2);
  expect(JSON.parse(renderEvent(e, 4, 10000, presentation))).toEqual(e);
  const metadata: RendererMetadata = { id: 'pi/edit', name: 'Pi edit', tool: 'edit', eventTypes: ['tool.call'], examples: [{ type: e.type, ...presentation, raw: JSON.stringify(e) }] };
  expect(rendererPreview(metadata, e.type, 2, 100, 7)).toContain('\x1b[31mold <code>*');
});

test('chat can replace tool call/update phases in place while preserving raw and unrelated events', () => {
  const settings = new Settings(); settings.excluded.clear(); settings.compactToolCalls = true;
  const call = event(1, 'tool.call', { toolCallId: 'x', title: 'bash', rawInput: { command: 'echo hi' } });
  const update = event(3, 'tool.update', { toolCallId: 'x', title: 'bash', status: 'in_progress' });
  const result = event(4, 'tool.result', { toolCallId: 'x', title: 'bash', status: 'completed' });
  const other = event(2, 'agent.message', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'working' } });
  expect(chatGroups([call, other, update, result], settings).map(item => item.seq)).toEqual([4, 2]);
  settings.levels['tool.call'] = 4; settings.levels['tool.update'] = 4; settings.levels['tool.result'] = 4;
  expect(chatGroups([call, update, result], settings).map(item => item.seq)).toEqual([1, 3, 4]);
  settings.compactToolCalls = false;
  expect(chatGroups([call, update, result], settings).map(item => item.seq)).toEqual([1, 3, 4]);
});

test('compact tool groups scope IDs by agent/generation and leave unidentified phases separate', () => {
  const settings = new Settings(); settings.compactToolCalls = true;
  const events = [
    event(1, 'tool.call', { toolCallId: 'same' }),
    event(2, 'tool.call', { toolCallId: 'same' }, { agentId: 'worker' }),
    event(3, 'tool.call', { toolCallId: 'same' }, { generation: 'g2' }),
    event(4, 'tool.update', { toolCallId: 'same' }, { agentId: 'worker' }),
    event(5, 'tool.result', { toolCallId: 'same' }, { generation: 'g2' }),
    event(6, 'tool.result', { toolCallId: 'same' }),
    event(7, 'tool.call', {}), event(8, 'tool.update', {}),
    event(9, 'tool.call', { toolCallId: 'same' }, { agentId: undefined }),
    event(10, 'tool.result', { toolCallId: 'same' }, { agentId: undefined }),
  ];
  const original = structuredClone(events);
  expect(chatGroups(events, settings).map(item => item.seq)).toEqual([6, 4, 5, 7, 8, 9, 10]);
  expect(events).toEqual(original);
});

test('compact groups honor filtered phases, close hidden results and retain mixed raw phases', () => {
  const settings = new Settings(); settings.compactToolCalls = true;
  const call = event(1, 'tool.call', { toolCallId: 'x' });
  const update = event(2, 'tool.update', { toolCallId: 'x' });
  const result = event(3, 'tool.result', { toolCallId: 'x' });
  const events = [call, update, result];
  settings.excluded.add('tool.call');
  expect(chatGroups(events, settings).map(item => item.seq)).toEqual([3]);
  settings.excluded.delete('tool.call'); settings.excluded.add('tool.update');
  expect(chatGroups(events, settings).map(item => item.seq)).toEqual([3]);
  settings.excluded.delete('tool.update'); settings.excluded.add('tool.result');
  expect(chatGroups([...events, { ...call, seq: 4 }], settings).map(item => item.seq)).toEqual([2, 4]);
  settings.excluded.delete('tool.result');
  const sidecars = new Map([[2, { rendererId: 'pi/bash', subtype: 'bash', summary: '$ cmd', extended: '$ cmd', full: '$ cmd' }]]);
  settings.levels['tool.update:bash'] = 4;
  expect(chatGroups(events, settings, sidecars).map(item => item.seq)).toEqual([1, 2, 3]);
  delete settings.levels['tool.update:bash']; settings.levels['tool.result'] = 4;
  expect(chatGroups(events, settings, sidecars).map(item => item.seq)).toEqual([2, 3]);
  settings.levels['tool.call'] = 4; settings.levels['tool.result'] = 2;
  expect(chatGroups(events, settings, sidecars).map(item => item.seq)).toEqual([1, 3]);
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
  expect(stripAnsi(table.items[0]!)).toContain('< src/main.ts');
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
    await tui.visible('< src/main.ts');
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
    expect(tui.screen()).toContain('< src/main.ts');
    tui.keys('c'); await tui.visible('Chat · root');
    await tui.visible('ORIGINAL OUTPUT');
    expect(tui.screen()).not.toContain('Custom read complete');
  } finally { await tui.close(); await mock.close(); }
}, 15000);

test('terminal compact controls toggle via selection or shortcut with either settings menu layout', async () => {
  for (const serverSettings of [false, true]) {
    const mock = await mockServer((socket, request) => {
      if (request.method === 'organization.snapshot') respond(socket, request.id, { seq: 0, agents: [agent('root')], operations: [], capabilities: serverSettings ? { serverSettings: { version: 1, groups: [], endpoints: { list: 'settings.list', get: 'settings.get', update: 'settings.update' } } } : {} });
      else if (request.method === 'subscribe') respond(socket, request.id, { seq: 0, liveOnly: true });
      else if (request.method === 'events.history') respond(socket, request.id, { events: [], oldestSeq: 0, latestSeq: 0, expired: false });
    });
    const path = join(mock.directory, 'config.json');
    let tui = terminalClient(mock.path, mock.directory);
    const saved = (value: boolean) => {
      let matched = false;
      return () => { void Settings.load(path).then(settings => { matched = settings.compactToolCalls === value; }); return matched; };
    };
    try {
      await tui.visible('connected');
      tui.keys('v'); await tui.visible('Compact tool phases in chat: off');
      tui.keys('\x1b[B'.repeat(serverSettings ? 5 : 4) + '\r');
      await tui.visible('Compact tool phases in chat: on');
      await waitFor(saved(true));
      tui.keys('?'); await tui.visible('Toggle compact tool phases');
      tui.keys('\x1b'); await tui.visible('View settings');
      tui.keys('c'); await tui.visible('Compact tool phases in chat: off');
      await waitFor(saved(false));
      tui.keys('c'); await tui.visible('Compact tool phases in chat: on');
      await waitFor(saved(true));
      await tui.close();
      tui = terminalClient(mock.path, mock.directory);
      await tui.visible('connected');
      tui.keys('v'); await tui.visible('Compact tool phases in chat: on');
    } finally { await tui.close(); await mock.close(); }
  }
}, 15000);

test('terminal compact chat advances a bounded output tail with a visible gray gutter and count', async () => {
  const call = event(1, 'tool.call', { toolCallId: 'rolling', title: 'bash', rawInput: { command: 'watch-output' } });
  const mock = await mockServer((socket, request) => {
    if (request.method === 'organization.snapshot') respond(socket, request.id, { seq: 1, agents: [agent('root')], operations: [] });
    else if (request.method === 'subscribe') respond(socket, request.id, { seq: 1, liveOnly: true });
    else if (request.method === 'events.history') respond(socket, request.id, { events: request.params.after < 1 ? [call] : [], oldestSeq: 1, latestSeq: 1, expired: false });
  });
  const settings = new Settings(); settings.compactToolCalls = true;
  await settings.save(join(mock.directory, 'config.json'));
  const tui = terminalClient(mock.path, mock.directory);
  const live = (seq: number, type: string, rawOutput: string) => {
    for (const socket of mock.sockets) send(socket, { ...call, seq, type, data: { ...call.data as object, status: type === 'tool.result' ? 'completed' : 'in_progress', rawOutput } });
  };
  try {
    await tui.visible('$ watch-output');
    tui.keys('c'); await tui.visible('Chat · root');
    live(2, 'tool.update', 'FIRST_HIDDEN\ntwo\nthree\nfour\nfive\nsix');
    await tui.visible('6 lines received · showing last 5 rows');
    await tui.visible('│ six');
    expect(tui.screen()).not.toContain('FIRST_HIDDEN');
    expect(tui.screen().match(/\$ watch-output/g)).toHaveLength(1);
    const lines = tui.screen().split('\n');
    const row = lines.findIndex(line => line.includes('│ six'));
    const column = lines[row]!.indexOf('│ six');
    const countRow = lines.findIndex(line => line.includes('6 lines received'));
    for (const [y, x] of [[countRow, 0], [row, column]] as const) {
      expect(tui.cell(y, x)?.getFgColor()).toBe(250); // Explicit gray, not theme-dependent bright black.
      expect(tui.cell(y, x)?.isBgDefault()).toBeTruthy();
    }
    expect(tui.cell(row, column + 2)?.isBgDefault()).toBeTruthy();
    expect(tui.cell(row, column + 2)?.isFgDefault()).toBeTruthy();
    live(3, 'tool.update', `SECOND_HIDDEN\n${'long-output '.repeat(100)}LATEST_TAIL`);
    await tui.visible('2 lines received · showing last 5 rows');
    await tui.visible('LATEST_TAIL');
    expect(tui.screen()).not.toContain('SECOND_HIDDEN');
    expect(tui.screen()).not.toContain('│ six');
    const outputRows = tui.screen().split('\n').filter(line => /^  │ /.test(line));
    expect(outputRows).toHaveLength(5);
    live(4, 'tool.result', 'FINISHED_OUTPUT');
    await tui.visible('FINISHED_OUTPUT');
    expect(tui.screen()).not.toContain('lines received');
    expect(tui.screen()).not.toContain('LATEST_TAIL');
    expect(tui.screen().match(/\$ watch-output/g)).toHaveLength(1);
  } finally { await tui.close(); await mock.close(); }
}, 15000);

test('terminal changes only symbol colors across phases and independently colors edit counts/text', async () => {
  const call = event(1, 'tool.call', { title: 'bash', status: 'pending', rawInput: { command: 'echo ready' } });
  const bash: EventRendering = { rendererId: 'core.tools', subtype: 'bash', summary: '$ echo ready', extended: '$ echo ready\nready', full: '$ echo ready\n\n```\nready\n```' };
  const mock = await mockServer((socket, request) => {
    if (request.method === 'organization.snapshot') respond(socket, request.id, { seq: 1, agents: [agent('root')], operations: [], capabilities: { rendering: { version: 1, catalog: 'events.renderers' } } });
    else if (request.method === 'events.renderers') respond(socket, request.id, { version: 1, renderers: [] });
    else if (request.method === 'subscribe') respond(socket, request.id, { seq: 1, liveOnly: true });
    else if (request.method === 'events.history') respond(socket, request.id, { events: request.params.after < 1 ? [call] : [], renderings: { 1: bash }, oldestSeq: 1, latestSeq: 1, expired: false });
  });
  const settings = new Settings(); settings.excluded.clear(); settings.levels['tool.result'] = 3;
  await settings.save(join(mock.directory, 'config.json'));
  const tui = terminalClient(mock.path, mock.directory);
  const fg = (text: string) => {
    const lines = tui.screen().split('\n'), row = lines.findIndex(line => line.includes(text));
    return row < 0 ? undefined : tui.cell(row, lines[row]!.indexOf(text))?.getFgColor();
  };
  const live = (e: typeof call, rendering: EventRendering) => {
    for (const socket of mock.sockets) { send(socket, { kind: 'presentation', seq: e.seq, rendering }); send(socket, e); }
  };
  try {
    await tui.visible('$ echo ready');
    await waitFor(() => fg('$ echo ready') === 3).catch(() => { throw new Error(`Expected yellow header; fg=${fg('$ echo ready')}\n${tui.screen()}`); });
    expect(tui.screen()).not.toContain('tool.call:'); expect(tui.screen()).not.toContain('pending');
    expect(fg('echo ready')).toBe(-1); // Event text keeps the terminal default, not selection/lifecycle colors.
    live({ ...call, seq: 2, type: 'tool.update', data: { ...call.data as object, status: 'in_progress' } }, bash);
    await waitFor(() => fg('$ echo ready') === 208);
    expect(fg('echo ready')).toBe(-1);
    live({ ...call, seq: 3, type: 'tool.result', data: { ...call.data as object, status: 'completed' } }, bash);
    await waitFor(() => fg('$ echo ready') === 2);
    expect(fg('echo ready')).toBe(-1);
    live({ ...call, seq: 4, type: 'tool.result', data: { ...call.data as object, status: 'failed' } }, { ...bash, extended: '$ echo ready\nexit 2' });
    await waitFor(() => fg('$ echo ready') === 1);
    expect(fg('echo ready')).toBe(-1);
    const edit = event(5, 'tool.result', { title: 'edit', status: 'completed', rawInput: { path: 'file.ts' } });
    const delta: EventRendering = { rendererId: 'pi/edit', subtype: 'edit', summary: 'Δ file.ts · +1 / -1', extended: 'Δ file.ts old text\n  new text', extendedDiff: { prefix: 'Δ file.ts', before: 'old text', after: 'new text' }, full: 'Δ file.ts · +1 / -1\n\n```diff\n@@ -1 +1 @@\n-old text\n+new text\n```' };
    live(edit, delta); await tui.visible('Δ file.ts');
    expect(fg('file.ts')).toBe(-1); expect(fg('+1')).toBe(2); expect(fg('-1')).toBe(1);
    tui.keys('c'); await tui.visible('Chat · root');
    await tui.visible('-old text'); await tui.visible('+new text');
    expect(fg('Δ file.ts')).toBe(2); expect(fg('-old text')).toBe(1); expect(fg('+new text')).toBe(2);
    tui.keys('\x1b'); await tui.visible('LATEST TRACKED EVENT');
    tui.keys('vl'); await tui.visible('Event rendering levels');
    const index = settings.types(['tool.call:bash', 'tool.update:bash', 'tool.result:bash', 'tool.result:edit']).indexOf('tool.result:edit');
    tui.keys('\x1b[B'.repeat(index) + '2');
    await waitFor(asyncReadGuard(join(mock.directory, 'config.json'), 'tool.result:edit', 2));
    tui.keys('\x1b'); await tui.visible('LATEST TRACKED EVENT');
    tui.keys('c'); await tui.visible('Chat · root');
    await tui.visible('Δ file.ts old text');
    expect(fg('old text')).toBe(1); expect(fg('new text')).toBe(2);
    expect(tui.screen()).not.toContain('tool.result:');
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
