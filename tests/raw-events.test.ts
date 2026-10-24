import { expect, test } from 'bun:test';
import { mockServer, respond, waitFor, agent } from './helpers.js';
import { terminalClient } from './terminal.js';

test('raw-event viewer opens safely for selected agent with no loaded chat events', async () => {
  const mock = await mockServer((_socket, request) => {
    if (request.method === 'organization.snapshot') respond(_socket, request.id, { seq: 0, agents: [agent('root')], operations: [] });
  });
  const tui = terminalClient(mock.path, mock.directory);
  try {
    await tui.visible('root');
    await new Promise(resolve => setTimeout(resolve, 100));
    tui.keys('z');
    await tui.visible('No events in this loaded history window.');
    tui.keys('a');
    tui.keys('\r');
    expect(tui.screen()).toContain('Raw events');
    tui.keys('\x1b');
    await tui.visible('AGENT');
  } finally { await tui.close(); await mock.close(); }
}, 15_000);
