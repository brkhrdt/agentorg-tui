import { expect, test } from 'bun:test';
import { clip } from '../src/render.js';
import { agent, event, mockServer, operation, respond, send, waitFor } from './helpers.js';
import { terminalClient } from './terminal.js';

test('prompt composer reserves tree rows, keeps the selected agent visible and restores bordered editors', async () => {
  const agents = [agent('root'), ...Array.from({ length: 30 }, (_, i) => agent(`worker${String(i).padStart(2, '0')}`, 'root'))];
  const mock = await mockServer((socket, request) => {
    if (request.method === 'organization.snapshot') respond(socket, request.id, { seq: 0, agents, operations: [] });
    else if (request.method === 'events.history') respond(socket, request.id, { events: [], oldestSeq: 0, latestSeq: 0, expired: false });
  });
  const tui = terminalClient(mock.path, mock.directory);
  try {
    await tui.visible('worker00');
    tui.keys('\x1b[B'.repeat(30));
    await tui.visible('worker29');
    tui.keys('\r'); await tui.visible('Interrupting prompt · worker29');
    tui.keys('draft at column zero'); await tui.visible('draft at column zero');
    const lines = tui.screen().split('\n');
    const selectedRow = lines.findIndex(line => line.includes('worker29') && !line.includes('Interrupting'));
    expect(selectedRow).toBeGreaterThanOrEqual(2);
    expect(selectedRow).toBeLessThan(25);
    expect(tui.cell(selectedRow, 0)?.getBgColor()).toBe(4);
    expect(lines[25]).toStartWith('─ > ─');
    expect(lines[26]).toBe('draft at column zero');
    expect(lines[27]).toBe('─'.repeat(120));
    tui.keys('\x1b'); await tui.visible('↑↓ select');
    expect(tui.screen()).not.toContain('draft at column zero');
    expect(tui.screen()).not.toContain('─ > ─');
    tui.keys('e'); await tui.visible('Modify agent');
    tui.keys('\r'); await tui.visible('Edit name');
    await tui.visible('worker29');
    const editor = tui.screen().split('\n');
    expect(editor[25]).toStartWith('┌');
    expect(editor[26]).toStartWith('│worker29');
    expect(editor[27]).toStartWith('└');
  } finally { await tui.close(); await mock.close(); }
});

test('long prompt expands the composer and keeps its full wrapped draft visible', async () => {
  const agents = [agent('root'), agent('worker', 'root')];
  const mock = await mockServer((socket, request) => {
    if (request.method === 'organization.snapshot') respond(socket, request.id, { seq: 0, agents, operations: [] });
    else if (request.method === 'events.history') respond(socket, request.id, { events: [], oldestSeq: 0, latestSeq: 0, expired: false });
  });
  const tui = terminalClient(mock.path, mock.directory);
  try {
    await tui.visible('worker');
    tui.keys('\x1b[B\r'); await tui.visible('Interrupting prompt · worker');
    const draft = 'This prompt should wrap and remain visible. '.repeat(5);
    for (const char of draft) tui.keys(char);
    await waitFor(() => tui.screen().split('\n').filter(line => line.includes('This prompt')).length >= 2);
    const lines = tui.screen().split('\n');
    expect(lines[24]).toStartWith('─ >');
    expect(lines[27]).toBe('─'.repeat(120));
    expect(lines.join('\n')).toContain('remain visible.');
    expect(lines.slice(2, 24).some(line => line.includes('worker'))).toBe(true);
  } finally { await tui.close(); await mock.close(); }
});

test('live removal while composing cannot redirect an interrupting prompt to another agent', async () => {
  const prompts: any[] = [];
  const agents = [agent('root'), agent('worker', 'root')];
  const mock = await mockServer((socket, request) => {
    if (request.method === 'organization.snapshot') respond(socket, request.id, { seq: 0, agents, operations: [] });
    else if (request.method === 'events.history') respond(socket, request.id, { events: [], oldestSeq: 0, latestSeq: 0, expired: false });
    else if (request.method === 'agent.prompt') { prompts.push(request.params); respond(socket, request.id, operation('completed')); }
  });
  const tui = terminalClient(mock.path, mock.directory);
  try {
    await tui.visible('  worker');
    tui.keys('\x1b[B\r'); await tui.visible('Interrupting prompt · worker');
    tui.keys('for worker only'); await tui.visible('for worker only');
    for (const socket of mock.sockets) send(socket, event(1, 'agent.removed', { removedAt: 'archived' }, { agentId: 'worker' }));
    await waitFor(() => !tui.screen().split('\n').slice(2, 25).some(line => line.includes('worker')));
    expect(tui.screen()).toContain('Interrupting prompt · worker');
    tui.keys('\r'); await waitFor(() => prompts.length === 1);
    expect(prompts[0]).toEqual({ agentId: 'worker', text: 'for worker only', queue: false });
  } finally { await tui.close(); await mock.close(); }
});

test('compact header right-aligns status even when the terminal is narrower than the status', async () => {
  const mock = await mockServer((socket, request) => {
    if (request.method === 'organization.snapshot') respond(socket, request.id, { seq: 0, agents: [], operations: [] });
    else if (request.method === 'events.history') respond(socket, request.id, { events: [], oldestSeq: 0, latestSeq: 0, expired: false });
  });
  try {
    for (const cols of [5, 9, 10, 20, 120]) {
      const tui = terminalClient(mock.path, mock.directory, { cols });
      try {
        const status = clip('connected', cols);
        await waitFor(() => tui.screen().split('\n')[0]?.endsWith(status) === true);
        expect(tui.screen().split('\n')[0]!.length).toBe(cols);
      } finally { await tui.close(); }
    }
  } finally { await mock.close(); }
});

test('chat ancestry handles missing parents and cycles without repeating names', async () => {
  for (const [agents, heading] of [
    [[agent('orphan', 'missing')], 'Chat · orphan'],
    [[agent('root', 'child'), agent('child', 'root')], 'Chat · child / root'],
  ] as const) {
    const mock = await mockServer((socket, request) => {
      if (request.method === 'organization.snapshot') respond(socket, request.id, { seq: 0, agents, operations: [] });
      else if (request.method === 'events.history') respond(socket, request.id, { events: [], oldestSeq: 0, latestSeq: 0, expired: false });
    });
    const tui = terminalClient(mock.path, mock.directory);
    try {
      await tui.visible('gpt-6-luna');
      tui.keys('c'); await tui.visible(heading);
      expect(tui.screen().split('\n')[0]).not.toContain('root / child / root');
    } finally { await tui.close(); await mock.close(); }
  }
});
