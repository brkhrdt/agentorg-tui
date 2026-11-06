import { expect, test } from 'vitest';
import { agent, mockServer, operation, respond, send, waitFor } from './helpers.js';
import { terminalClient } from './terminal.js';

const composerBounds = (tui: ReturnType<typeof terminalClient>) => {
  const lines = tui.screen().split('\n');
  const top = lines.findIndex(line => line.startsWith('─ >'));
  const bottom = lines.findIndex((line, index) => index > top && /^─+$/.test(line));
  return { lines, top, bottom };
};
const hasComposer = (tui: ReturnType<typeof terminalClient>) => {
  const { top, bottom } = composerBounds(tui);
  return top >= 0 && bottom > top;
};
const rows = (tui: ReturnType<typeof terminalClient>) => {
  const { lines, top, bottom } = composerBounds(tui);
  return top >= 0 && bottom > top ? lines.slice(top + 1, bottom).map(line => line.trimEnd()).join('') : '';
};

test('chat drafts stay isolated by agent across A/B/A navigation', async () => {
  const mock = await mockServer((socket, request) => {
    if (request.method === 'organization.snapshot') respond(socket, request.id, { seq: 0, agents: [agent('root'), agent('worker')], operations: [] });
    else if (request.method === 'events.history') respond(socket, request.id, { events: [], oldestSeq: 0, latestSeq: 0, expired: false });
    else if (request.method === 'agent.prompt') respond(socket, request.id, operation('completed'));
  });
  const tui = terminalClient(mock.path, mock.directory);
  try {
    await tui.visible('root'); await new Promise(resolve => setTimeout(resolve, 50));
    tui.keys('c'); await tui.visible('Chat'); await new Promise(resolve => setTimeout(resolve, 50));
    tui.keys('draft for A'); await waitFor(() => rows(tui) === 'draft for A');
    tui.keys('\x1b'); await new Promise(resolve => setTimeout(resolve, 50)); await tui.visible('root');
    tui.keys('\x1b[B'); await tui.visible('worker');
    tui.keys('c'); await tui.visible('Chat'); await new Promise(resolve => setTimeout(resolve, 50));
    for (const ch of 'draft for B') tui.keys(ch);
    await waitFor(() => rows(tui) === 'draft for B');
    tui.keys('\x1b'); await new Promise(resolve => setTimeout(resolve, 50)); await tui.visible('worker');
    tui.keys('\x1b[A'); await tui.visible('root'); tui.keys('c'); await tui.visible('Chat');
    await waitFor(() => tui.screen().includes('draft for A'));
  } finally { await tui.close(); await mock.close(); }
}, 20_000);

test('tree prompt draft is shared across recipients, accepted once, and cleared on success', async () => {
  const prompts: unknown[] = [];
  const mock = await mockServer((socket, request) => {
    if (request.method === 'organization.snapshot') respond(socket, request.id, { seq: 0, agents: [agent('root'), agent('worker', 'root')], operations: [] });
    else if (request.method === 'events.history') respond(socket, request.id, { events: [], oldestSeq: 0, latestSeq: 0, expired: false });
    else if (request.method === 'agent.prompt') { prompts.push(request.params); respond(socket, request.id, operation('completed')); }
  });
  const tui = terminalClient(mock.path, mock.directory);
  try {
    await tui.visible('root'); await new Promise(resolve => setTimeout(resolve, 50));
    tui.keys('\r'); await tui.visible('Prompt · root'); await new Promise(resolve => setTimeout(resolve, 50));
    tui.keys('shared prompt draft'); await waitFor(() => tui.screen().includes('shared prompt draft'));
    tui.keys('\x1b'); await new Promise(resolve => setTimeout(resolve, 50));
    tui.keys('\x1b[B'); await tui.visible('worker'); tui.keys('\r'); await tui.visible('Prompt · worker');
    await waitFor(() => tui.screen().includes('shared prompt draft'));
    tui.keys('\r'); await waitFor(() => prompts.length === 1);
    expect(prompts[0]).toEqual({ agentId: 'worker', text: 'shared prompt draft', queue: false });
    await waitFor(() => !tui.screen().includes('Prompt · worker') && tui.screen().includes('Enter prompt  c chat'));
    tui.keys('\r'); await tui.visible('Prompt · worker');
    await waitFor(() => hasComposer(tui));
    expect(rows(tui)).toBe(''); expect(prompts).toHaveLength(1);
  } finally { await tui.close(); await mock.close(); }
}, 20_000);

test.each(['chat', 'prompt'] as const)('%s replacement text survives late acceptance after Ctrl-C', async view => {
  let pending: { socket: import('node:net').Socket; id: string; params: any } | undefined;
  const mock = await mockServer((socket, request) => {
    if (request.method === 'organization.snapshot') respond(socket, request.id, { seq: 0, agents: [agent('root')], operations: [] });
    else if (request.method === 'events.history') respond(socket, request.id, { events: [], oldestSeq: 0, latestSeq: 0, expired: false });
    else if (request.method === 'agent.prompt') pending = { socket, id: request.id, params: request.params };
  });
  const tui = terminalClient(mock.path, mock.directory);
  const header = view === 'chat' ? 'Chat · root' : 'Prompt · root';
  try {
    await tui.visible('root'); await new Promise(resolve => setTimeout(resolve, 50));
    tui.keys(view === 'chat' ? 'c' : '\r'); await tui.visible(view === 'chat' ? 'Chat' : header);
    await new Promise(resolve => setTimeout(resolve, 50));
    tui.keys('same draft'); tui.keys('\r'); await waitFor(() => !!pending);
    expect(pending?.params).toEqual({ agentId: 'root', text: 'same draft', queue: false });
    await waitFor(() => rows(tui) === 'same draft');
    tui.keys('\x03'); await new Promise(resolve => setTimeout(resolve, 80));
    await waitFor(() => rows(tui) === '');
    await new Promise(resolve => setTimeout(resolve, 50)); tui.keys('same draft');
    await waitFor(() => rows(tui) === 'same draft'); await new Promise(resolve => setTimeout(resolve, 100));
    expect(tui.screen()).toContain(header);
    respond(pending!.socket, pending!.id, operation('running'));
    await waitFor(() => !tui.screen().includes('Working · do not retry unknown outcomes'));
    expect(tui.screen()).toContain(header); expect(rows(tui)).toBe('same draft');
  } finally { await tui.close(); await mock.close(); }
}, 20_000);

test.each(['chat', 'prompt'] as const)('%s late acceptance after Escape clears the saved buffer without navigating from tree', async view => {
  let pending: { socket: import('node:net').Socket; id: string } | undefined;
  const mock = await mockServer((socket, request) => {
    if (request.method === 'organization.snapshot') respond(socket, request.id, { seq: 0, agents: [agent('root')], operations: [] });
    else if (request.method === 'events.history') respond(socket, request.id, { events: [], oldestSeq: 0, latestSeq: 0, expired: false });
    else if (request.method === 'agent.prompt') pending = { socket, id: request.id };
  });
  const tui = terminalClient(mock.path, mock.directory);
  const header = view === 'chat' ? 'Chat · root' : 'Prompt · root';
  const open = () => tui.keys(view === 'chat' ? 'c' : '\r');
  try {
    await tui.visible('root'); await new Promise(resolve => setTimeout(resolve, 50));
    open(); await tui.visible(header); await new Promise(resolve => setTimeout(resolve, 50));
    tui.keys('held draft'); tui.keys('\r'); await waitFor(() => !!pending);
    await waitFor(() => rows(tui) === 'held draft');
    tui.keys('\x1b'); await waitFor(() => !tui.screen().includes(header) && tui.screen().includes('root   idle'));
    respond(pending!.socket, pending!.id, operation('running'));
    await waitFor(() => !tui.screen().includes('Working ·'));
    expect(tui.screen()).not.toContain(header); expect(tui.screen()).toContain('Enter prompt  c chat');
    open(); await tui.visible(header); await waitFor(() => rows(tui) === '');
  } finally { await tui.close(); await mock.close(); }
}, 20_000);

test('rejected chat send retains exact Unicode/whitespace through Escape and explicit retry; a fresh client starts empty', async () => {
  const params: any[] = [];
  const mock = await mockServer((socket, request) => {
    if (request.method === 'organization.snapshot') respond(socket, request.id, { seq: 0, agents: [agent('root')], operations: [] });
    else if (request.method === 'events.history') respond(socket, request.id, { events: [], oldestSeq: 0, latestSeq: 0, expired: false });
    else if (request.method === 'agent.prompt') {
      params.push(request.params);
      if (params.length === 1) send(socket, { kind: 'response', id: request.id, ok: false, error: { code: 'REJECTED', message: 'deliberately rejected' } });
      else respond(socket, request.id, operation('running'));
    }
  });
  const exact = '  café ☃️  ';
  let tui = terminalClient(mock.path, mock.directory);
  try {
    await tui.visible('root'); await new Promise(resolve => setTimeout(resolve, 50));
    tui.keys('c'); await tui.visible('Chat'); await new Promise(resolve => setTimeout(resolve, 50));
    tui.keys(exact); tui.keys('\r'); await waitFor(() => params.length === 1);
    expect(params[0]).toEqual({ agentId: 'root', text: exact, queue: false });
    await tui.visible('deliberately rejected');
    tui.keys('\x1b'); await waitFor(() => !tui.screen().includes('Chat · root'));
    tui.keys('c'); await tui.visible('Chat · root'); await waitFor(() => tui.screen().includes('café ☃️'));
    tui.keys('\r'); await waitFor(() => params.length === 2);
    expect(params[1]).toEqual({ agentId: 'root', text: exact, queue: false });
    await tui.close();
    tui = terminalClient(mock.path, mock.directory);
    await tui.visible('root'); await new Promise(resolve => setTimeout(resolve, 50));
    tui.keys('c'); await tui.visible('Chat · root');
    await waitFor(() => rows(tui) === '');
  } finally { await tui.close(); await mock.close(); }
}, 20_000);

test('unsent compose drafts are memory-only and empty in a fresh client', async () => {
  const mock = await mockServer((socket, request) => {
    if (request.method === 'organization.snapshot') respond(socket, request.id, { seq: 0, agents: [agent('root')], operations: [] });
    else if (request.method === 'events.history') respond(socket, request.id, { events: [], oldestSeq: 0, latestSeq: 0, expired: false });
  });
  let tui = terminalClient(mock.path, mock.directory);
  try {
    await tui.visible('root'); await new Promise(resolve => setTimeout(resolve, 50));
    tui.keys('c'); await tui.visible('Chat'); await new Promise(resolve => setTimeout(resolve, 50));
    tui.keys('UNSENT-MEMORY-ONLY-marker');
    await waitFor(() => rows(tui).includes('UNSENT-MEMORY-ONLY-marker'));
    await tui.close();
    tui = terminalClient(mock.path, mock.directory);
    await tui.visible('root'); await new Promise(resolve => setTimeout(resolve, 50));
    tui.keys('c'); await tui.visible('Chat · root');
    await waitFor(() => rows(tui) === '');
    expect(tui.screen()).not.toContain('UNSENT-MEMORY-ONLY-marker');
  } finally { await tui.close(); await mock.close(); }
}, 20_000);

test.each(['accepted', 'rejected'] as const)('duplicate Enter during a pending %s send keeps the composer interactive', async outcome => {
  const requests: any[] = [];
  let pending: { socket: import('node:net').Socket; id: string } | undefined;
  const mock = await mockServer((socket, request) => {
    if (request.method === 'organization.snapshot') respond(socket, request.id, { seq: 0, agents: [agent('root')], operations: [] });
    else if (request.method === 'events.history') respond(socket, request.id, { events: [], oldestSeq: 0, latestSeq: 0, expired: false });
    else if (request.method === 'agent.prompt') { requests.push(request.params); pending = { socket, id: request.id }; }
  });
  const tui = terminalClient(mock.path, mock.directory);
  try {
    await tui.visible('root'); await new Promise(resolve => setTimeout(resolve, 50));
    tui.keys('c'); await tui.visible('Chat · root'); await new Promise(resolve => setTimeout(resolve, 50));
    tui.keys('first request'); tui.keys('\r'); await waitFor(() => !!pending);
    expect(requests).toHaveLength(1);
    tui.keys('\r'); await new Promise(resolve => setTimeout(resolve, 50));
    tui.keys('x'); await waitFor(() => rows(tui) === 'first requestx');
    if (outcome === 'accepted') respond(pending!.socket, pending!.id, operation('running'));
    else send(pending!.socket, { kind: 'response', id: pending!.id, ok: false, error: { code: 'REJECTED', message: 'deliberately rejected' } });
    await waitFor(() => !tui.screen().includes('Working ·'));
    expect(requests).toHaveLength(1); expect(rows(tui)).toBe('first requestx');
    tui.keys('y'); await waitFor(() => rows(tui) === 'first requestxy');
    tui.keys('\x1b'); await waitFor(() => !tui.screen().includes('Chat · root'));
    tui.keys('c'); await tui.visible('Chat · root'); await waitFor(() => rows(tui) === 'first requestxy');
  } finally { await tui.close(); await mock.close(); }
}, 20_000);
