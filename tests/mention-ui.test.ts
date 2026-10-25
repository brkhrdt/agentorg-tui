import { expect, test } from 'bun:test';
import { agent, event, mockServer, operation, respond, send, waitFor } from './helpers.js';
import { terminalClient } from './terminal.js';

function mentionServer(names: string[]) {
  const agents = [agent('root', null, { name: 'Root' }), ...names.map((name, index) => agent(`child-${index}`, 'root', { name }))];
  return mockServer((socket, request) => {
    if (request.method === 'organization.snapshot') respond(socket, request.id, { seq: 0, agents, operations: [] });
    else if (request.method === 'events.history') respond(socket, request.id, { events: [], oldestSeq: 0, latestSeq: 0, expired: false });
    else if (request.method === 'agent.prompt') respond(socket, request.id, operation('completed'));
  });
}

test('Tab accepts once; deferred completion does not reopen or replace the accepted mention with Space', async () => {
  const mock = await mentionServer(['Beta', 'BetaExtra']);
  const tui = terminalClient(mock.path, mock.directory, { cols: 80, rows: 24 });
  try {
    await tui.visible('Root'); tui.keys('c'); await tui.visible('Chat · Root');
    tui.keys('@be'); await tui.visible('@BetaExtra');
    tui.keys('\t');
    await waitFor(() => tui.screen().split('@Beta').length >= 2);
    await new Promise(resolve => setTimeout(resolve, 30));
    const afterTab = tui.screen();
    expect(afterTab.split('@Beta').length - 1).toBe(1); // draft only, no reopened menu row
    tui.keys(' x');
    await new Promise(resolve => setTimeout(resolve, 30));
    const afterSpace = tui.screen();
    expect(afterSpace).toContain('@Beta x');
    expect(afterSpace).not.toContain('@BetaExtra x');
  } finally { await tui.close(); await mock.close(); }
});

test('acceptance recomputes the active query when typed characters and Tab are buffered together', async () => {
  const mock = await mentionServer(['Beta']);
  const tui = terminalClient(mock.path, mock.directory, { cols: 80, rows: 24 });
  try {
    await tui.visible('Root'); tui.keys('\r'); await tui.visible('Interrupting');
    tui.keys('@b'); await tui.visible('@Beta');
    tui.keys('e\t'); await new Promise(resolve => setTimeout(resolve, 30));
    expect(tui.screen()).toContain('@Beta');
    expect(tui.screen()).not.toContain('@@Beta');
  } finally { await tui.close(); await mock.close(); }
});

test('successful chat submission clears completion state before the next draft', async () => {
  const mock = await mentionServer(['Beta']);
  const tui = terminalClient(mock.path, mock.directory, { cols: 80, rows: 24 });
  try {
    await tui.visible('Root'); tui.keys('c'); await tui.visible('Chat · Root');
    tui.keys('@b'); await tui.visible('@Beta');
    tui.keys('\r'); await waitFor(() => !tui.screen().includes('@Beta'));
    tui.keys(' x'); await new Promise(resolve => setTimeout(resolve, 30));
    expect(tui.screen()).not.toContain('@Beta');
    expect(tui.screen()).toContain('x');
  } finally { await tui.close(); await mock.close(); }
});

test('live removal refreshes open suggestions and acceptance rechecks current recipients', async () => {
  const mock = await mentionServer(['Beta', 'Bravo']);
  const tui = terminalClient(mock.path, mock.directory, { cols: 80, rows: 24 });
  try {
    await tui.visible('Root'); tui.keys('\r'); await tui.visible('Interrupting');
    tui.keys('@b'); await tui.visible('@Bravo');
    const socket = [...mock.sockets][0]!;
    send(socket, event(1, 'agent.removed', { removedAt: '2026-01-01T00:00:00.000Z' }, { agentId: 'child-1' }));
    await waitFor(() => !tui.screen().includes('@Bravo'));
    tui.keys('\t'); await new Promise(resolve => setTimeout(resolve, 30));
    expect(tui.screen()).toContain('@Beta');
    expect(tui.screen()).not.toContain('@Bravo');
  } finally { await tui.close(); await mock.close(); }
});

test('the scrollable suggestion window lets later matches be selected and accepted', async () => {
  const names = Array.from({ length: 9 }, (_, index) => `Alpha${index}`);
  const mock = await mentionServer(names);
  const tui = terminalClient(mock.path, mock.directory, { cols: 80, rows: 24 });
  try {
    await tui.visible('Root'); tui.keys('\r'); await tui.visible('Interrupting');
    tui.keys('@a'); await tui.visible('@Alpha3');
    tui.keys('\x1b[B'.repeat(6)); await tui.visible('@Alpha7');
    tui.keys('\t'); await new Promise(resolve => setTimeout(resolve, 30));
    expect(tui.screen()).toContain('@Alpha6');
  } finally { await tui.close(); await mock.close(); }
});

test('opening completion preserves the following chat tail when composer row count is unchanged', async () => {
  const records = Array.from({ length: 40 }, (_, index) => event(index + 1, 'agent.message', {
    sessionUpdate: 'agent_message_chunk', messageId: `m${index}`, content: { type: 'text', text: index === 39 ? 'TAIL_MARKER' : `HISTORY_${index}` },
  }, { agentId: 'root', generation: 'g1' }));
  const agents = [agent('root', null, { name: 'Root' }), agent('child', 'root', { name: 'Child' })];
  const mock = await mockServer((socket, request) => {
    if (request.method === 'organization.snapshot') respond(socket, request.id, { seq: records.length, agents, operations: [] });
    else if (request.method === 'events.history') {
      const matches = records.filter(item => item.seq > request.params.after && item.seq < request.params.before && (!request.params.agentId || item.agentId === request.params.agentId));
      respond(socket, request.id, { events: matches.slice(-request.params.limit), hasMore: matches.length > request.params.limit, oldestSeq: 1, latestSeq: records.length, expired: false });
    }
  });
  const tui = terminalClient(mock.path, mock.directory, { cols: 80, rows: 24 });
  try {
    await tui.visible('Root'); tui.keys('c'); await tui.visible('Chat · Root'); await tui.visible('TAIL_MARKER');
    tui.keys('@'); await tui.visible('@Child');
    expect(tui.screen()).toContain('TAIL_MARKER');
  } finally { await tui.close(); await mock.close(); }
});
