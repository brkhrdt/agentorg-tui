import { expect, test } from 'bun:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { agent, event, mockServer, operation, respond, send, waitFor } from './helpers.js';
import { terminalClient } from './terminal.js';

const message = (seq: number, text: string) => event(seq, 'agent.message', {
  sessionUpdate: 'agent_message_chunk', messageId: `message-${seq}`, content: { type: 'text', text },
}, { agentId: 'root', generation: 'g1' });

test('chat appends while scrolled, preserves the viewport and outgoing prompt, then reveals the live tail by scrolling down', async () => {
  const records = Array.from({ length: 24 }, (_, index) => message(index + 1, index + 1 === 14 ? 'ANCHOR_14' : `HISTORY_${index + 1}`));
  let latest = 24;
  let root = agent('root');
  const requests: any[] = [];
  const prompts: any[] = [];
  const mock = await mockServer((socket, request) => {
    requests.push(request);
    if (request.method === 'organization.snapshot') respond(socket, request.id, { seq: latest, agents: [root], operations: [] });
    else if (request.method === 'events.history') {
      const matches = records.filter(item => item.seq > request.params.after && item.seq < request.params.before &&
        (!request.params.agentId || item.agentId === request.params.agentId));
      respond(socket, request.id, { events: matches.slice(-request.params.limit), hasMore: matches.length > request.params.limit, oldestSeq: 1, latestSeq: latest, expired: false });
    } else if (request.method === 'agent.prompt') {
      prompts.push(request.params);
      const first = prompts.length === 1;
      const queuedSeq = first ? 30 : 35;
      latest = queuedSeq + 1;
      const queued = event(queuedSeq, 'prompt.queued', { text: request.params.text, operationId: `op-${prompts.length}` }, { agentId: 'root', generation: 'g1' });
      const reply = message(queuedSeq + 1, first ? 'PROMPT_REPLY_MARKER' : 'PROMPT_REPLY_AFTER_COMPOSER_SHRINK');
      records.push(queued, reply);
      send(socket, queued); send(socket, reply);
      respond(socket, request.id, { ...operation('completed'), id: `op-${prompts.length}`, agentId: 'root' });
    }
  });
  await writeFile(join(mock.directory, 'config.json'), JSON.stringify({
    levels: { 'agent.modified': 0, 'operation.changed': 0, 'prompt.queued': 0, 'agent.message': 3 }, compactToolCalls: false,
    history: { recentEvents: 100, chatPageSize: 30, cacheBytes: 1_048_576, idleMinutes: 10 },
  }));
  const tui = terminalClient(mock.path, mock.directory, { cols: 120, rows: 30 });
  try {
    await tui.visible('LATEST TRACKED EVENT');
    tui.keys('?'); await tui.visible('Keys · tree');
    tui.keys('\x1b'); await tui.visible('LATEST TRACKED EVENT');
    tui.keys('c'); await tui.visible('Chat · root');
    await tui.visible('HISTORY_24');
    const agentHistoryRequests = () => requests.filter(request => request.method === 'events.history' && request.params.agentId === 'root').length;
    const initialAgentHistoryRequests = agentHistoryRequests();

    tui.keys('\x1b[5~'); // Scroll up, but remain below the loaded top.
    await tui.visible('ANCHOR_14');
    await tui.flush();
    const anchorRow = () => tui.screen().split('\n').findIndex(line => line.includes('ANCHOR_14'));
    const initialAnchorRow = anchorRow();
    expect(initialAnchorRow).toBeGreaterThanOrEqual(0);
    expect(tui.screen()).not.toContain('HISTORY_24');

    for (const [seq, text] of [[25, 'LIVE_25'], [26, 'LIVE_26']] as const) {
      latest = seq;
      const incoming = message(seq, text); records.push(incoming);
      for (const socket of mock.sockets) send(socket, incoming);
    }
    latest = 27;
    root = agent('root', null, { name: 'ROOT_DELIVERY_BARRIER' });
    const barrier = event(27, 'agent.modified', root, { agentId: 'root', generation: 'g1' }); records.push(barrier);
    for (const socket of mock.sockets) send(socket, barrier);
    await tui.visible('Chat · ROOT_DELIVERY_BARRIER');
    await tui.flush();
    expect(anchorRow()).toBe(initialAnchorRow);
    expect(tui.screen()).not.toContain('LIVE_25');
    expect(tui.screen()).not.toContain('LIVE_26');

    const viewportMarker = () => {
      const lines = tui.screen().split('\n');
      const row = lines.findIndex(line => /HISTORY_\d+/.test(line));
      const marker = row >= 0 ? lines[row]!.match(/HISTORY_\d+/)?.[0] : undefined;
      return { row, marker };
    };
    const moveAndWait = async (key: string) => {
      const before = viewportMarker();
      tui.keys(key);
      await waitFor(() => viewportMarker().marker !== before.marker || viewportMarker().row !== before.row);
    };
    await moveAndWait('\x1b[5~'); await moveAndWait('\x1b[5~');
    await moveAndWait('\x1b[6~'); // Return down one page while still above the live bottom.
    const afterPageDown = viewportMarker();
    expect(afterPageDown.marker).toBeDefined();
    const wheelDown = '\x1b[M' + String.fromCharCode(97, 82, 42); // X10 wheel-down at (50, 10).
    await moveAndWait(wheelDown);
    const afterWheelDown = viewportMarker();
    expect(afterWheelDown.marker).not.toBe(afterPageDown.marker);
    expect(tui.screen()).not.toContain('PROMPT_REPLY_MARKER');
    latest = 28;
    const afterPageDownEvent = message(28, 'LIVE_AFTER_PAGEDOWN'); records.push(afterPageDownEvent);
    for (const socket of mock.sockets) send(socket, afterPageDownEvent);
    root = agent('root', null, { name: 'ROOT_DELIVERY_BARRIER_2' });
    const barrierAfterPageDown = event(29, 'agent.modified', root, { agentId: 'root', generation: 'g1' }); records.push(barrierAfterPageDown);
    for (const socket of mock.sockets) send(socket, barrierAfterPageDown);
    await tui.visible('Chat · ROOT_DELIVERY_BARRIER_2'); await tui.flush();
    expect(viewportMarker()).toEqual(afterWheelDown);
    expect(tui.screen()).not.toContain('LIVE_AFTER_PAGEDOWN');

    const promptText = 'outgoing while scrolled '.repeat(4);
    tui.keys(promptText); tui.keys('\r');
    await tui.visible('Prompt completed');
    await waitFor(() => prompts.length === 1);
    await tui.flush();
    expect(prompts).toEqual([{ agentId: 'root', text: promptText, queue: false }]);
    expect(viewportMarker()).toEqual(afterWheelDown);
    expect(tui.screen()).not.toContain('PROMPT_REPLY_MARKER');

    for (let page = 0; page < 6; page++) { tui.keys('\x1b[6~'); await tui.flush(); }
    expect(tui.screen()).toContain('LIVE_25');
    expect(tui.screen()).toContain('LIVE_26');
    expect(tui.screen()).toContain('PROMPT_REPLY_MARKER');
    expect(agentHistoryRequests()).toBe(initialAgentHistoryRequests);

    latest = 32;
    const afterBottom = message(32, 'FOLLOWING_AT_BOTTOM'); records.push(afterBottom);
    for (const socket of mock.sockets) send(socket, afterBottom);
    await tui.visible('FOLLOWING_AT_BOTTOM');

    const multilineDraft = 'COMPOSER_SHRINK_X'.repeat(18);
    tui.keys(multilineDraft);
    await tui.visible('COMPOSER_SHRINK_X');
    await waitFor(() => tui.screen().split('\n').filter(line => line.includes('COMPOSER_SHRINK_X')).length >= 3);
    tui.keys('\r');
    await tui.visible('Prompt completed');
    await waitFor(() => prompts.length === 2);
    await waitFor(() => !tui.screen().includes('COMPOSER_SHRINK_X'));
    expect(prompts[1]).toEqual({ agentId: 'root', text: multilineDraft, queue: false });
    await tui.visible('PROMPT_REPLY_AFTER_COMPOSER_SHRINK');
  } finally { await tui.close(); await mock.close(); }
}, 20_000);

test('appending preserves the exact screen row when the viewport begins on a blank separator', async () => {
  const records = Array.from({ length: 24 }, (_, index) => message(index + 1, `MESSAGE_${index + 1}`));
  let latest = 24;
  let root = agent('root');
  const mock = await mockServer((socket, request) => {
    if (request.method === 'organization.snapshot') respond(socket, request.id, { seq: latest, agents: [root], operations: [] });
    else if (request.method === 'events.history') {
      const matches = records.filter(item => item.seq > request.params.after && item.seq < request.params.before);
      respond(socket, request.id, { events: matches.slice(-request.params.limit), hasMore: matches.length > request.params.limit, oldestSeq: 1, latestSeq: latest, expired: false });
    }
  });
  await writeFile(join(mock.directory, 'config.json'), JSON.stringify({ levels: { 'agent.modified': 0, 'agent.message': 1 }, history: { recentEvents: 100, chatPageSize: 30, cacheBytes: 1_048_576, idleMinutes: 10 } }));
  const tui = terminalClient(mock.path, mock.directory, { cols: 120, rows: 30 });
  const targetRow = () => tui.screen().split('\n').findIndex(line => line.trimStart().startsWith('MESSAGE_2 '));
  const onSeparator = () => {
    const lines = tui.screen().split('\n');
    const row = targetRow();
    return row > 0 && lines[row - 1]!.replace(/[│\s]/g, '') === '';
  };
  try {
    await tui.visible('LATEST TRACKED EVENT'); tui.keys('?'); await tui.visible('Keys · tree'); tui.keys('\x1b'); await tui.visible('LATEST TRACKED EVENT');
    tui.keys('c'); await tui.visible('Chat · root'); await tui.visible('MESSAGE_24');
    for (let page = 0; page < 8 && targetRow() !== 2; page++) {
      tui.keys('\x1b[5~'); await tui.flush(); await new Promise(resolve => setTimeout(resolve, 60));
    }
    expect(targetRow()).toBe(2);
    expect(onSeparator()).toBe(true);
    const before = targetRow();

    latest = 26;
    const incoming = message(25, 'APPENDED_MESSAGE'); records.push(incoming);
    root = agent('root', null, { name: 'APPEND_DELIVERY_BARRIER' });
    const barrier = event(26, 'agent.modified', root, { agentId: 'root', generation: 'g1' }); records.push(barrier);
    for (const socket of mock.sockets) { send(socket, incoming); send(socket, barrier); }
    await tui.visible('Chat · APPEND_DELIVERY_BARRIER');
    await tui.flush();

    expect(targetRow()).toBe(before);
    expect(onSeparator()).toBe(true);
    expect(tui.screen()).toContain('MESSAGE_2');
  } finally { await tui.close(); await mock.close(); }
}, 20_000);

test('prepend plus a newly wrapped gap notice preserves the visible logical anchor', async () => {
  const records = Array.from({ length: 24 }, (_, index) => message(index + 1,
    index + 1 === 19 ? 'PAGE_ANCHOR_19' : `PAGE_HISTORY_${index + 1} ${'body '.repeat(35)}`));
  let held: { socket: any; request: any } | undefined;
  const mock = await mockServer((socket, request) => {
    if (request.method === 'organization.snapshot') respond(socket, request.id, { seq: 24, agents: [agent('root')], operations: [] });
    else if (request.method === 'events.history') {
      const matches = records.filter(item => item.seq < request.params.before &&
        (!request.params.agentId || item.agentId === request.params.agentId));
      if (request.params.agentId === 'root' && request.params.before === 19) { held = { socket, request }; return; }
      respond(socket, request.id, { events: matches.slice(-request.params.limit), hasMore: matches.length > request.params.limit,
        oldestSeq: 1, latestSeq: 24, expired: request.params.agentId === 'root' });
    }
  });
  await writeFile(join(mock.directory, 'config.json'), JSON.stringify({
    levels: { 'agent.modified': 0, 'operation.changed': 0, 'agent.message': 3 },
    history: { recentEvents: 100, chatPageSize: 6, cacheBytes: 32_768, idleMinutes: 10 },
  }));
  const tui = terminalClient(mock.path, mock.directory, { cols: 40, rows: 30 });
  try {
    await tui.visible('LATEST TRACKE');
    tui.keys('?'); await tui.visible('Keys · tree');
    tui.keys('\x1b'); await tui.visible('LATEST TRACKE');
    tui.keys('c'); await tui.visible('Chat · root');
    for (let page = 0; page < 3; page++) { tui.keys('\x1b[5~'); await tui.flush(); }
    await waitFor(() => held !== undefined);
    await tui.visible('PAGE_HISTORY_22'); await tui.flush();
    const anchorRow = () => tui.screen().split('\n').findIndex(line => line.includes('PAGE_HISTORY_22'));
    const initialAnchorRow = anchorRow();
    expect(initialAnchorRow).toBeGreaterThanOrEqual(0);
    respond(held!.socket, held!.request.id, { events: records.filter(item => item.seq < 19).slice(-6), hasMore: true,
      oldestSeq: 1, latestSeq: 24, expired: true });
    await tui.visible('History retention gap:');
    await waitFor(() => !tui.screen().includes('[Loading history…]')); await tui.flush();
    await waitFor(() => anchorRow() === initialAnchorRow);
    expect(anchorRow()).toBe(initialAnchorRow);
  } finally { await tui.close(); await mock.close(); }
}, 20_000);
