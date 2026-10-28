import { expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Settings } from '../src/settings.js';
import { agent, event, mockServer, respond, waitFor } from './helpers.js';
import { terminalClient } from './terminal.js';

test('terminal table field visibility, ordering, help, reset and persisted preferences', async () => {
  const mock = await mockServer((socket, request) => {
    if (request.method === 'organization.snapshot') respond(socket, request.id, {
      seq: 1, agents: [agent('root'), agent('worker', 'root')], operations: [], capabilities: {},
    });
    else if (request.method === 'events.history') respond(socket, request.id, {
      events: [event(1)], oldestSeq: 1, latestSeq: 1, expired: false,
    });
  });
  const config = join(mock.directory, 'config.json');
  const saved = async (expected: string[]) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const data = JSON.parse(await readFile(config, 'utf8').catch(() => '{}'));
      if (JSON.stringify(data.tableFields) === JSON.stringify(expected)) return;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error(`Table preferences not saved: ${expected.join(', ')}`);
  };
  let client = terminalClient(mock.path, mock.directory);
  try {
    await client.visible('LATEST TRACKED EVENT');
    client.keys('v\x1b[B\r'); // Table fields follow Colors in the settings menu.
    await client.visible('Table fields / order · client preferences');
    client.keys('\x1b[B'.repeat(11) + ' '); // Enable Harness.
    await client.visible('[x]  5  harness');
    client.keys('\x1b[D'); // Earlier than Event.
    await client.visible('[x]  4  harness');
    client.keys('1');
    await client.visible('[x]  1  harness · tree indent');
    await saved(['harness', 'name', 'status', 'model', 'event']);
    client.keys('?'); await client.visible('Keys · table-fields');
    await client.visible('Reset table fields to defaults');
    client.keys('\x1b'); await client.visible('Table fields / order · client preferences');
    client.keys('\x1b'); await client.visible('LATEST TRACKED EVENT');
    expect(client.screen().split('\n')[1]).toStartWith('HARNESS');
    expect(client.screen().split('\n')[3]).toStartWith('  pi');
    await client.close();
    client = terminalClient(mock.path, mock.directory);
    await client.visible('LATEST TRACKED EVENT');
    expect(client.screen().split('\n')[1]).toStartWith('HARNESS');
    client.keys('vt'); await client.visible('TUI colors · client preferences');
    client.keys('\x1b[C'); await client.visible('Selection background: magenta');
    for (let attempt = 0; attempt < 100; attempt++) {
      const data = JSON.parse(await readFile(config, 'utf8').catch(() => '{}'));
      if (data.colors?.selectionBg === 'magenta') break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    expect(JSON.parse(await readFile(config, 'utf8')).colors.selectionBg).toBe('magenta');
    client.keys('z'); await client.visible('Selection background: blue');
    client.keys('\x1b'); await client.visible('LATEST TRACKED EVENT');
    client.keys('vb'); await client.visible('Table fields / order · client preferences');
    client.keys('z'); await client.visible('[ ]     harness');
    await saved(['name', 'status', 'model', 'event']);
    client.keys('\x1b'); await client.visible('LATEST TRACKED EVENT');
    expect(client.screen().split('\n')[1]).toStartWith('AGENT');
  } finally { await client.close(); await mock.close(); }
}, 15_000);

test('registered extra usage metrics are selectable and rendered with catalog units', async () => {
  const metric = { id: 'custom.requests', title: 'Requests', unit: 'requests', description: 'Harness-reported request count.' };
  const mock = await mockServer((socket, request) => {
    if (request.method === 'organization.snapshot') respond(socket, request.id, {
      seq: 1, agents: [agent('root', null, { usage: { self: { 'custom.requests': 21 }, subtree: { 'custom.requests': 21 } } })], operations: [],
      capabilities: { usage: { version: 1, notification: '_agentorg/usage', query: 'usage.get', scopes: ['self', 'subtree'], metrics: [metric] } },
    });
    else if (request.method === 'events.history') respond(socket, request.id, { events: [event(1)], oldestSeq: 1, latestSeq: 1, expired: false });
  });
  const client = terminalClient(mock.path, mock.directory);
  try {
    await client.visible('AGENT');
    client.keys('vb');
    await client.visible('Table fields / order · client preferences');
    client.keys('\x1b[B'.repeat(16));
    await client.visible('Requests (requests)');
    client.keys(' ');
    await client.visible('[x]  5  Requests (requests)');
    client.keys('\x1b'); await new Promise(resolve => setTimeout(resolve, 100));
    client.keys('\x1b');
    await client.visible('AGENT');
    await client.visible('21');
    expect(client.screen().split('\n')[2]).toContain('21');
    const saved = JSON.parse(await readFile(join(mock.directory, 'config.json'), 'utf8'));
    expect(saved.tableFields).toContain('metric:custom.requests');
  } finally { await client.close(); await mock.close(); }
}, 15_000);

test('selection stays visible with Event first or alone without recoloring event previews', async () => {
  const mock = await mockServer((socket, request) => {
    if (request.method === 'organization.snapshot') respond(socket, request.id, {
      seq: 2, agents: [agent('root'), agent('worker', 'root')], operations: [],
    });
    else if (request.method === 'events.history') respond(socket, request.id, {
      events: ['root', 'worker'].map((id, index) => event(index + 1, 'agent.message', {
        sessionUpdate: 'agent_message_chunk', content: { text: `${id} output` },
      }, { agentId: id })), oldestSeq: 1, latestSeq: 2, expired: false,
    });
  });
  try {
    for (const tableFields of [['event', 'name'], ['name', 'event', 'status'], ['event']] as const) {
      const settings = new Settings(); settings.tableFields = [...tableFields];
      await settings.save(join(mock.directory, 'config.json'));
      const tui = terminalClient(mock.path, mock.directory);
      const selected = (row: number) => {
        const lines = tui.screen().split('\n');
        const column = tableFields.length === 1 ? 0 : lines[1]!.indexOf('AGENT');
        return tui.cell(row, column)?.getBgColor() === 4;
      };
      try {
        await tui.visible('worker output');
        expect(selected(2)).toBe(true); expect(selected(3)).toBe(false);
        tui.keys('\x1b[B'); await waitFor(() => selected(3));
        expect(selected(2)).toBe(false);
        for (const [row, text] of [[2, 'root output'], [3, 'worker output']] as const) {
          const column = tui.screen().split('\n')[row]!.indexOf(text);
          expect(tui.cell(row, column)?.isBgDefault()).toBeTruthy();
          expect(tui.cell(row, column)?.isBold()).toBeFalsy();
        }
        if (tableFields.length === 1) expect(tui.screen().split('\n')[3]).toStartWith('▸ ');
      } finally { await tui.close(); }
    }
  } finally { await mock.close(); }
});
