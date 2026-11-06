import { expect, test } from 'vitest';
import { agent, event, mockServer, respond, send, waitFor } from './helpers.js';
import { terminalClient } from './terminal.js';

test('agent info: direct/contextual access, JSON, scrolling, live identity and back navigation', async () => {
  let seq = 0;
  let root = agent('root', null, {
    name: 'coordinator', sessionId: 'root-session', sessionNumber: 3,
    settings: { harness: 'fixture', env: Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`VAR_${i}`, `value-${i}`])) },
    metadata: { longValue: 'x'.repeat(250) + 'WRAPPED_END' },
    futureField: 'TAIL_ORIGINAL',
  });
  const worker = agent('worker', 'root', { sessionId: 'worker-session', sessionNumber: 1 });
  let agents = [root, worker];
  const requests: string[] = [];
  const mock = await mockServer((socket, request) => {
    requests.push(request.method);
    if (request.method === 'organization.snapshot') respond(socket, request.id, { seq, agents, operations: [] });
    else if (request.method === 'events.history') respond(socket, request.id, { events: [], oldestSeq: 0, latestSeq: seq, expired: false });
  });
  const client = terminalClient(mock.path, mock.directory);
  const update = (patch: Partial<typeof root>) => {
    root = { ...root, ...patch }; agents = [root, worker];
    for (const socket of mock.sockets) send(socket, event(++seq, 'agent.modified', root));
  };
  try {
    await client.visible('  worker');
    client.keys('\x1b[B'); await waitFor(() => client.cell(3, 0)?.getBgColor() === 4);
    client.keys('i'); await client.visible('Agent info · worker');
    await client.visible('Session ID: worker-session');
    expect(client.screen()).not.toContain('root-session');
    client.keys('\x1b'); await client.visible('LATEST TRACKED EVENT');
    client.keys('\x1b[A'); await waitFor(() => client.cell(2, 0)?.getBgColor() === 4);
    client.keys('a'); await client.visible('Agent actions · coordinator');
    await client.visible('i  View all agent info');
    client.keys('i'); await client.visible('Agent info · coordinator');
    await client.visible('Session ID: root-session');
    await client.visible('PgUp/PgDn page');
    expect(client.screen()).not.toContain('Enter open');
    client.keys('j'); await client.visible('"parentId": null');
    client.keys('\x1b[F'); await client.visible('"sessionId": "root-session"');
    client.keys('j'); await client.visible('Name: coordinator');
    client.keys('\x1b[6~'); await client.visible('VAR_20: value-20');
    expect(client.screen()).not.toContain('Name: coordinator');
    client.keys('\x1b[F'); await client.visible('TAIL_ORIGINAL');
    await client.visible('WRAPPED_END');
    update({ name: 'renamed-live', revision: 2, sessionId: 'new-session', futureField: 'TAIL_UPDATED' });
    await client.visible('Agent info · renamed-live');
    await client.visible('TAIL_UPDATED'); // A refresh must not jump back to the top.
    expect(client.screen()).not.toContain('Name: renamed-live');
    client.keys('?'); await client.visible('Keys · agent-info');
    client.keys('\x1b'); await client.visible('TAIL_UPDATED');
    client.keys('\x1b[H'); await client.visible('Name: renamed-live');
    await client.visible('Revision: 2'); await client.visible('Session ID: new-session');
    client.keys('\x1b'); await client.visible('Agent actions · renamed-live');
    client.keys('\r'); await client.visible('Agent info · renamed-live'); // Restore the info menu selection.
    update({ removedAt: 'archive-time', state: 'stopped' });
    await client.visible('Removed: archive-time'); // Keep the inspected ID even when it leaves the tree.
    agents = [worker];
    const snapshots = requests.filter(method => method === 'organization.snapshot').length;
    for (const socket of mock.sockets) send(socket, event(++seq, 'agent.session_replaced', {}));
    await waitFor(() => requests.filter(method => method === 'organization.snapshot').length > snapshots);
    await client.visible('Agent root is no longer in the current snapshot.');
    expect(client.screen()).not.toContain('worker-session');
    expect(requests.every(method => ['organization.snapshot', 'events.history'].includes(method))).toBe(true);
  } finally { await client.close(); await mock.close(); }
}, 20_000);

test('empty organization actions advertise only available shortcuts', async () => {
  const mock = await mockServer((socket, request) => {
    if (request.method === 'organization.snapshot') respond(socket, request.id, { seq: 0, agents: [], operations: [] });
    else if (request.method === 'events.history') respond(socket, request.id, { events: [], oldestSeq: 0, latestSeq: 0, expired: false });
  });
  const client = terminalClient(mock.path, mock.directory);
  try {
    await client.visible('No active agents.');
    client.keys('a'); await client.visible('Create root');
    expect(client.screen()).not.toContain('i agent info');
    client.keys('?'); await client.visible('Keys · actions');
    expect(client.screen()).not.toContain('View all agent info');
  } finally { await client.close(); await mock.close(); }
});
