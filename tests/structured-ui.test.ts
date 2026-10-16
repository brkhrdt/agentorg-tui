import { expect, test } from 'bun:test';
import { agent, mockServer, operation, respond, waitFor } from './helpers.js';
import { terminalClient } from './terminal.js';

test('terminal structured settings: filter, separate name/value entry, draft staging, typed values and raw errors', async () => {
  const root = agent('root', null, { settings: { harness: 'fixture', env: { TOKEN: 'secret-value', PATH: '/bin' }, options: { count: 1 } } });
  const changes: any[] = [];
  const mock = await mockServer((socket, request) => {
    if (request.method === 'organization.snapshot') respond(socket, request.id, { seq: 0, agents: [root], operations: [], capabilities: { harnesses: ['fixture'] } });
    else if (request.method === 'events.history') respond(socket, request.id, { events: [], latestSeq: 0 });
    else if (request.method === 'agent.modify') { changes.push(request.params); respond(socket, request.id, operation('completed')); }
  });
  const ui = terminalClient(mock.path, mock.directory);
  const { keys, visible, screen } = ui;
  try {
    await waitFor(() => /root +idle/.test(screen()));
    keys('e'); await visible('Modify agent');
    expect(screen()).not.toContain('secret-value');
    keys('\x1b[B'.repeat(6) + '\r'); await visible('Edit env · list / map');
    expect(screen()).toContain('TOKEN=••••'); expect(screen()).not.toContain('secret-value');
    keys('TO'); await visible('filter: TO'); // Typing starts filtering, action keys are now text.
    expect(screen()).not.toContain('PATH=');
    keys('\x1b[B\r'); await visible('Edit env · name');
    keys('\x15TOKEN_NEW\r'); await visible('Edit env · value (string)');
    keys('\x15q?aed new secret\r'); await visible('Edit env · filter: TO');
    expect(screen()).toContain('TOKEN_NEW=••••'); expect(changes).toHaveLength(0);
    keys('/'); await visible('Filter: type freely'); keys('\x15\x1b'); await visible('Edit env · list / map');
    keys('a'); await visible('Edit env · name'); keys('ADDED\r'); await visible('Edit env · value (string)');
    keys('first\r'); await visible('ADDED=••••');
    keys('J'); await visible('advanced JSON'); keys('\x15{"BAD":2}\r'); await visible('env: Values must be strings');
    expect(screen()).toContain('{"BAD":2}'); // Invalid draft remains editable.
    keys('\x1b'); await visible('ADDED=••••');
    keys('/'); await visible('Filter: type freely'); keys('\x15ADDED\x1b'); await visible('filter: ADDED');
    keys('d'); await visible('No matching entries');
    keys('?'); await visible('Keys · structured'); keys('S'); await visible('Modify agent');
    expect(changes).toHaveLength(0); // Collection stage isn't a server save.
    keys('S'); await waitFor(() => changes.length === 1); await visible('LATEST TRACKED EVENT');
    expect(changes[0]).toEqual({ agentId: 'root', expectedRevision: 1, settings: { env: { PATH: '/bin', TOKEN_NEW: 'q?aed new secret' } } });
    keys('e'); await visible('Modify agent'); keys('\x1b[B'.repeat(7) + '\r'); await visible('Edit options · list / map');
    keys('e'); await visible('Edit options · name'); keys('\r'); await visible('value type');
    keys('n'); await visible('value (number)'); keys('\x15oops\r'); await visible('valid number');
    keys('\x1512\r'); await visible('count=12');
    keys('\x1b'); await visible('Modify agent'); keys('S'); await visible('No changes to save');
    expect(changes).toHaveLength(1); // Escape discarded collection edits.
  } finally { await ui.close(); await mock.close(); }
}, 30_000);
