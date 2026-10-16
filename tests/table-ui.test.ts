import { expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { agent, event, mockServer, respond } from './helpers.js';
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
    client.keys('v\r'); // Table fields are also reachable via menu selection.
    await client.visible('Table fields / order · client preferences');
    client.keys('\x1b[B'.repeat(5) + ' '); // Enable Harness.
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
    expect(client.screen().split('\n')[2]).toStartWith('HARNESS');
    expect(client.screen()).toContain('  └ pi');
    await client.close();
    client = terminalClient(mock.path, mock.directory);
    await client.visible('LATEST TRACKED EVENT');
    expect(client.screen().split('\n')[2]).toStartWith('HARNESS');
    client.keys('vt'); await client.visible('Table fields / order · client preferences');
    client.keys('z'); await client.visible('[ ]     harness');
    await saved(['name', 'status', 'model', 'event']);
    client.keys('\x1b'); await client.visible('LATEST TRACKED EVENT');
    expect(client.screen().split('\n')[2]).toStartWith('AGENT');
  } finally { await client.close(); await mock.close(); }
}, 15_000);
