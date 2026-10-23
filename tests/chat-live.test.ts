import { expect, test } from 'bun:test';
import type { Socket } from 'node:net';
import { Session } from '../src/session.js';
import { agent, event, mockServer, respond, send, waitFor } from './helpers.js';

const history = { recentEvents: 40, chatPageSize: 10, cacheBytes: 131_072, idleMinutes: 10 };
const chatEvent = (seq: number, agentId: string, text: string, generation = 'g1') => event(seq, 'agent.message', {
  sessionUpdate: 'agent_message_chunk', messageId: `message-${seq}`, content: { type: 'text', text },
}, { agentId, generation });
const page = (records: ReturnType<typeof event>[], request: any) => {
  const matches = records.filter(item => item.seq > request.params.after && item.seq < request.params.before &&
    (!request.params.agentId || item.agentId === request.params.agentId));
  const selected = matches.slice(-request.params.limit);
  return { events: selected, hasMore: matches.length > selected.length, oldestSeq: records[0]?.seq ?? 0, latestSeq: records.at(-1)?.seq ?? 0, expired: false };
};

test('following chat appends incoming events once and isolates other agents', async () => {
  const initial = [chatEvent(1, 'root', 'INITIAL')];
  let latest = 1;
  const requests: any[] = [];
  const mock = await mockServer((socket, request) => {
    requests.push(request);
    if (request.method === 'organization.snapshot') respond(socket, request.id, { seq: latest, agents: [agent('root'), agent('other')], operations: [] });
    else if (request.method === 'events.history') respond(socket, request.id, page(initial, request));
  });
  const session = new Session(mock.path, { history });
  const running = session.run();
  try {
    await waitFor(() => session.status === 'connected');
    await session.openChat('root');
    for (const [seq, text] of [[2, 'LIVE_OPEN_2'], [3, 'LIVE_OPEN_3']] as const) {
      latest = seq;
      if (seq === 2) for (const socket of mock.sockets) send(socket, { kind: 'presentation', seq, rendering: { rendererId: 'fixture', summary: text, extended: text, full: text } });
      for (const socket of mock.sockets) send(socket, chatEvent(seq, 'root', text));
      await waitFor(() => session.store.events.has(seq));
      expect(session.chatEvents('root').map(item => item.seq)).toContain(seq);
    }
    expect(session.store.renderings.has(2)).toBe(true);
    latest = 4;
    for (const socket of mock.sockets) send(socket, chatEvent(4, 'other', 'OTHER_AGENT_ONLY'));
    await waitFor(() => session.store.events.has(4));
    latest = 5;
    for (const socket of mock.sockets) send(socket, event(5, 'server.ready', { status: 'ready' }, { agentId: undefined }));
    await waitFor(() => session.store.events.has(5));
    expect(session.chatEvents('root').map(item => item.seq)).toEqual([1, 2, 3]);
    expect(session.chatEvents('root').map(item => item.data)).not.toContain('OTHER_AGENT_ONLY');
    expect(requests.filter(item => item.method === 'events.history' && item.params.agentId === 'root')).toHaveLength(0);
  } finally { session.close(); await running; await mock.close(); }
});

test('events received while the initial agent-tail request is held remain in the following window', async () => {
  let held: { socket: Socket; id: string; request: any } | undefined;
  let latest = 10;
  const records = [chatEvent(9, 'root', 'OLDER'), chatEvent(10, 'root', 'TAIL')];
  const mock = await mockServer((socket, request) => {
    if (request.method === 'organization.snapshot') respond(socket, request.id, { seq: 10, agents: [agent('root')], operations: [] });
    else if (request.method === 'events.history' && request.params.agentId === 'root' && !held) held = { socket, id: request.id, request };
    else if (request.method === 'events.history') respond(socket, request.id, page(records, request));
  });
  const session = new Session(mock.path, { replayHistory: false, history });
  const running = session.run();
  try {
    await waitFor(() => session.status === 'connected');
    const opening = session.openChat('root');
    await waitFor(() => !!held);
    latest = 11;
    const incoming = chatEvent(11, 'root', 'ARRIVED_DURING_LOAD');
    for (const socket of mock.sockets) send(socket, incoming);
    await waitFor(() => session.store.events.has(11));
    expect(session.chatEvents('root').map(item => item.seq)).toContain(11);
    respond(held!.socket, held!.id, page(records, held!.request));
    await opening;
    expect(session.chatEvents('root').map(item => item.seq)).toEqual([9, 10, 11]);
    expect(session.chatEvents('root').filter(item => item.seq === 11)).toHaveLength(1);
  } finally { session.close(); await running; await mock.close(); }
});

test('--no-history skips startup replay but explicit chat fetches its agent tail and resumes live append', async () => {
  const records = [chatEvent(9, 'root', 'HISTORY_9'), chatEvent(10, 'root', 'HISTORY_10')];
  const requests: any[] = [];
  const mock = await mockServer((socket, request) => {
    requests.push(request);
    if (request.method === 'organization.snapshot') respond(socket, request.id, { seq: 10, agents: [agent('root')], operations: [] });
    else if (request.method === 'events.history') respond(socket, request.id, page(records, request));
  });
  const session = new Session(mock.path, { replayHistory: false, history });
  const running = session.run();
  try {
    await waitFor(() => session.status === 'connected');
    expect(requests.some(request => request.method === 'events.history')).toBe(false);
    await session.openChat('root');
    expect(session.chatEvents('root').map(item => item.seq)).toEqual([9, 10]);
    expect(requests.some(request => request.method === 'events.history' && request.params.agentId === 'root' && request.params.after === 0 && request.params.before === 11)).toBe(true);
    for (const socket of mock.sockets) send(socket, chatEvent(11, 'root', 'AFTER_EXPLICIT_HISTORY'));
    await waitFor(() => session.chatEvents('root').some(item => item.seq === 11));
  } finally { session.close(); await running; await mock.close(); }
});

test('reconnect restores the active chat window and subsequent live events append without navigation', async () => {
  const records = [chatEvent(1, 'root', 'BEFORE_RECONNECT')];
  const sockets: Socket[] = [];
  const requests: any[] = [];
  let latest = 1;
  const mock = await mockServer((socket, request) => {
    requests.push(request);
    if (request.method === 'organization.snapshot') respond(socket, request.id, { seq: latest, agents: [agent('root')], operations: [] });
    else if (request.method === 'events.history') respond(socket, request.id, page(records, request));
  }, socket => sockets.push(socket));
  const session = new Session(mock.path, { replayHistory: false, history });
  const running = session.run();
  try {
    await waitFor(() => session.status === 'connected');
    await session.openChat('root');
    expect(session.chatEvents('root').map(item => item.seq)).toEqual([1]);
    sockets[0]!.destroy();
    await waitFor(() => sockets.length === 2);
    await waitFor(() => requests.filter(request => request.method === 'events.history' && request.params.agentId === 'root').length === 2);
    latest = 2;
    records.push(chatEvent(2, 'root', 'AFTER_RECONNECT'));
    for (const socket of mock.sockets) if (!socket.destroyed) send(socket, records.at(-1));
    await waitFor(() => session.chatEvents('root').some(item => item.seq === 2));
    expect(session.chatEvents('root').map(item => item.seq)).toEqual([1, 2]);
  } finally { session.close(); await running; await mock.close(); }
});

test('same-agent generation replacement preserves agent routing without merging old-session chunks', async () => {
  const first = chatEvent(1, 'root', 'OLD_GENERATION ', 'g1');
  const mock = await mockServer((socket, request) => {
    if (request.method === 'organization.snapshot') respond(socket, request.id, { seq: 1, agents: [agent('root')], operations: [] });
    else if (request.method === 'events.history') respond(socket, request.id, page([first], request));
  });
  const session = new Session(mock.path, { replayHistory: false, history });
  const running = session.run();
  try {
    await waitFor(() => session.status === 'connected');
    await session.openChat('root');
    for (const socket of mock.sockets) send(socket, event(2, 'agent.state', { state: 'running' }, { agentId: 'root', generation: 'g2' }));
    await waitFor(() => session.store.agents.get('root')?.generation === 'g2');
    const replacement = chatEvent(3, 'root', 'NEW_GENERATION', 'g2');
    for (const socket of mock.sockets) send(socket, replacement);
    await waitFor(() => session.chatEvents('root').some(item => item.seq === 3));
    expect(session.chatEvents('root').map(item => item.generation)).toEqual(['g1', 'g2', 'g2']);
    expect(session.chatEvents('root').map(item => item.seq)).toEqual([1, 2, 3]);
  } finally { session.close(); await running; await mock.close(); }
});

test('late older page for agent A cannot pause or replace active agent B chat', async () => {
  let held: { socket: Socket; id: string; request: any } | undefined;
  const records = [
    chatEvent(1, 'root', 'A_1'), chatEvent(2, 'root', 'A_2'), chatEvent(3, 'root', 'A_3'),
    chatEvent(4, 'other', 'B_4'), chatEvent(5, 'other', 'B_5'),
  ];
  let latest = 5;
  const mock = await mockServer((socket, request) => {
    if (request.method === 'organization.snapshot') respond(socket, request.id, { seq: latest, agents: [agent('root'), agent('other')], operations: [] });
    else if (request.method === 'events.history' && request.params.agentId === 'root' && request.params.before === 2) held = { socket, id: request.id, request };
    else if (request.method === 'events.history') respond(socket, request.id, page(records, request));
  });
  const session = new Session(mock.path, { replayHistory: false, history: { ...history, chatPageSize: 2 } });
  const running = session.run();
  try {
    await waitFor(() => session.status === 'connected');
    await session.openChat('root');
    const oldPage = session.olderChat('root');
    await waitFor(() => !!held);
    await session.openChat('other');
    const bBefore = session.chatEvents('other').map(item => item.seq);
    respond(held!.socket, held!.id, page(records, held!.request));
    await oldPage;
    expect(session.chatEvents('other').map(item => item.seq)).toEqual(bBefore);
    latest = 6;
    for (const socket of mock.sockets) send(socket, chatEvent(6, 'other', 'B_LIVE_AFTER_LATE_A'));
    await waitFor(() => session.chatEvents('other').some(item => item.seq === 6));
    expect(session.chatEvents('other').map(item => item.seq)).toContain(6);
  } finally { session.close(); await running; await mock.close(); }
});

test('paused viewport continues live membership and followChat resumes bottom auto-scroll', async () => {
  const records = Array.from({ length: 12 }, (_, index) => chatEvent(index + 1, 'root', `HISTORY_${index + 1}`));
  let latest = 12;
  const mock = await mockServer((socket, request) => {
    if (request.method === 'organization.snapshot') respond(socket, request.id, { seq: latest, agents: [agent('root')], operations: [] });
    else if (request.method === 'events.history') respond(socket, request.id, page(records, request));
  });
  const session = new Session(mock.path, { replayHistory: false, history });
  const running = session.run();
  try {
    await waitFor(() => session.status === 'connected');
    await session.openChat('root');
    await session.olderChat('root');
    session.pauseChat('root');
    const older = session.chatEvents('root').map(item => item.seq);
    latest = 13;
    for (const socket of mock.sockets) send(socket, chatEvent(13, 'root', 'PAUSED_LIVE'));
    await waitFor(() => session.store.events.has(13));
    expect(session.chatEvents('root').map(item => item.seq)).toEqual([...older, 13]);
    await session.followChat('root');
    expect(session.chatEvents('root').filter(item => item.seq === 13)).toHaveLength(1);
    latest = 14;
    for (const socket of mock.sockets) send(socket, chatEvent(14, 'root', 'FOLLOWING_LIVE'));
    await waitFor(() => session.chatEvents('root').some(item => item.seq === 14));
  } finally { session.close(); await running; await mock.close(); }
});
