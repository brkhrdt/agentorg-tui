import { expect, test } from 'bun:test';
import { agent, mockServer, respond, waitFor } from './helpers.js';
import { terminalClient } from './terminal.js';

test('tree slash opens ancestry search; Enter jumps without sending a prompt', async () => {
  const requests: string[] = [];
  const agents = [agent('root', null, { name: 'Root' }), agent('middle', 'root', { name: 'Agent One' }), agent('child', 'middle', { name: 'Child' })];
  const mock = await mockServer((socket, request) => {
    requests.push(request.method);
    if (request.method === 'organization.snapshot') respond(socket, request.id, { seq: 0, agents, operations: [] });
    else if (request.method === 'events.history') respond(socket, request.id, { events: [], oldestSeq: 0, latestSeq: 0, expired: false });
  });
  const tui = terminalClient(mock.path, mock.directory, { cols: 80, rows: 24 });
  try {
    await tui.visible('Child'); tui.keys('/'); await tui.visible('Jump to agent');
    expect(tui.screen()).toContain('Root / Agent One / Child');
    tui.keys('1 chi'); await waitFor(() => tui.screen().includes('Root / Agent One / Child'));
    tui.keys('\r'); await tui.visible('AGENT');
    expect(tui.screen()).toContain('Child');
    expect(requests).not.toContain('agent.prompt');
  } finally { await tui.close(); await mock.close(); }
});

test('Escape cancels search in one press and leaves folds unchanged', async () => {
  const mock = await mockServer((socket, request) => {
    if (request.method === 'organization.snapshot') respond(socket, request.id, { seq: 0, agents: [agent('root', null, { name: 'Root' }), agent('child', 'root', { name: 'Child' })], operations: [] });
    else if (request.method === 'events.history') respond(socket, request.id, { events: [], oldestSeq: 0, latestSeq: 0, expired: false });
  });
  const tui = terminalClient(mock.path, mock.directory);
  try {
    await tui.visible('Child'); tui.keys('/'); await tui.visible('Jump to agent'); tui.keys('\x1b');
    await tui.visible('Enter prompt'); expect(tui.screen()).not.toContain('Jump to agent');
  } finally { await tui.close(); await mock.close(); }
});
