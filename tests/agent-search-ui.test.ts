import { expect, test } from 'bun:test';
import { agent, mockServer, respond, waitFor } from './helpers.js';
import { terminalClient } from './terminal.js';

function serve(agents: ReturnType<typeof agent>[]) {
  return mockServer((socket, request) => {
    if (request.method === 'organization.snapshot') respond(socket, request.id, { seq: 0, agents, operations: [] });
    else if (request.method === 'events.history') respond(socket, request.id, { events: [], oldestSeq: 0, latestSeq: 0, expired: false, hasMore: false });
  });
}

test('tree slash opens ancestry search; Enter jumps without sending a prompt', async () => {
  const requests: string[] = [];
  const agents = [agent('root', null, { name: 'Root' }), agent('middle', 'root', { name: 'Agent One' }), agent('child', 'middle', { name: 'Child' })];
  const mock = await mockServer((socket, request) => {
    requests.push(request.method);
    if (request.method === 'organization.snapshot') respond(socket, request.id, { seq: 0, agents, operations: [] });
    else if (request.method === 'events.history') respond(socket, request.id, { events: [], oldestSeq: 0, latestSeq: 0, expired: false, hasMore: false });
  });
  const tui = terminalClient(mock.path, mock.directory, { cols: 80, rows: 24 });
  try {
    await tui.visible('Child'); tui.keys('/'); await tui.visible('Jump to agent');
    expect(tui.screen()).toContain('Root / Agent One / Child');
    tui.keys('one chi'); await waitFor(() => tui.screen().includes('› Root / Agent One / Child'));
    tui.keys('\r'); await tui.visible('Enter prompt');
    expect(tui.screen()).not.toContain('Jump to agent');
    tui.keys('\r'); await tui.visible('Prompt · Child');
    expect(requests).not.toContain('agent.prompt');
  } finally { await tui.close(); await mock.close(); }
});

test('Escape cancels search in one press while preserving a folded branch', async () => {
  const mock = await serve([agent('root', null, { name: 'Root' }), agent('child', 'root', { name: 'Child' })]);
  const tui = terminalClient(mock.path, mock.directory);
  try {
    await tui.visible('Child'); tui.keys('\t'); await waitFor(() => !tui.screen().includes('  Child'));
    tui.keys('/'); await tui.visible('Jump to agent');
    tui.keys('\x1b[B'); await waitFor(() => tui.screen().includes('› Root / Child'));
    tui.keys('\x1b'); await tui.visible('Enter prompt');
    expect(tui.screen()).not.toContain('Jump to agent'); expect(tui.screen()).not.toContain('  Child');
  } finally { await tui.close(); await mock.close(); }
});

test('buffered slash-query-Enter accepts once and later prompt typing is not duplicated', async () => {
  const agents = Array.from({ length: 60 }, (_, i) => agent(`id-${i}`, null, { name: `Agent${i}` }));
  const requests: string[] = [];
  const mock = await mockServer((socket, request) => {
    requests.push(request.method);
    if (request.method === 'organization.snapshot') respond(socket, request.id, { seq: 0, agents, operations: [] });
    else if (request.method === 'events.history') respond(socket, request.id, { events: [], oldestSeq: 0, latestSeq: 0, expired: false, hasMore: false });
  });
  const tui = terminalClient(mock.path, mock.directory);
  try {
    await tui.visible('Agent0'); tui.keys('/Agent45\r');
    await waitFor(() => !tui.screen().includes('Jump to agent') && tui.screen().includes('Agent45'));
    await new Promise(resolve => setTimeout(resolve, 40));
    expect(tui.screen()).not.toContain('Jump to agent');
    tui.keys('\r'); await tui.visible('Prompt · Agent45');
    tui.keys('hello'); await waitFor(() => tui.screen().includes('hello'));
    expect(tui.screen().split('hello').length - 1).toBe(1);
    expect(requests).not.toContain('agent.prompt');
  } finally { await tui.close(); await mock.close(); }
});

test('double buffered no-result Enter rearms, then accepts and leaves later prompt input intact', async () => {
  const mock = await serve([agent('target', null, { name: 'Target' })]);
  const tui = terminalClient(mock.path, mock.directory);
  try {
    await tui.visible('Target'); tui.keys('/Missing\r\r');
    await waitFor(() => tui.screen().includes('No matching agents'));
    expect(tui.screen()).toContain('Jump to agent');
    tui.keys('\x7f'.repeat('Missing'.length)); await new Promise(resolve => setTimeout(resolve, 50));
    tui.keys('Target'); await waitFor(() => tui.screen().includes('› Target'));
    tui.keys('\r');
    await waitFor(() => !tui.screen().includes('Jump to agent') && tui.screen().includes('Target'));
    await new Promise(resolve => setTimeout(resolve, 40));
    tui.keys('\r'); await tui.visible('Prompt · Target');
    tui.keys('hello'); await waitFor(() => tui.screen().includes('hello'));
    expect(tui.screen().split('hello').length - 1).toBe(1);
  } finally { await tui.close(); await mock.close(); }
});

test('acceptance centers an interior row and clamps first/last rows to viewport boundaries', async () => {
  const agents = Array.from({ length: 60 }, (_, i) => agent(`id-${i}`, null, { name: `Agent${i}` }));
  const mock = await serve(agents), tui = terminalClient(mock.path, mock.directory, { cols: 120, rows: 30 });
  const jump = async (query: string, expected: string) => {
    tui.keys('/'); await tui.visible('Jump to agent'); tui.keys(query);
    await waitFor(() => tui.screen().includes(`› ${expected}`)); tui.keys('\r'); await tui.visible('Enter prompt');
    const lines = tui.screen().split('\n');
    return lines.findIndex(line => line.includes(expected));
  };
  try {
    await tui.visible('Agent0');
    const middle = await jump('Agent30', 'Agent30');
    expect(middle).toBeGreaterThan(10); expect(middle).toBeLessThan(20);
    const first = await jump('Agent0', 'Agent0');
    expect(first).toBe(2);
    const last = await jump('Agent59', 'Agent59');
    expect(last).toBe(23);
  } finally { await tui.close(); await mock.close(); }
});
