import { expect, test } from 'bun:test';
import { Session } from '../src/session.js';
import { agent, event, mockServer, respond, send, waitFor } from './helpers.js';

const historyPolicy = { recentEvents: 100, chatPageSize: 30, cacheBytes: 1_048_576, idleMinutes: 10 };
const message = (seq: number, agentId: string, text: string) => event(seq, 'agent.message', {
  sessionUpdate: 'agent_message_chunk', messageId: `message-${seq}`, content: { type: 'text', text },
}, { agentId, generation: 'g1' });

test('live events join a deliberately paused chat window exactly once and stay agent-scoped', async () => {
  const records = Array.from({ length: 24 }, (_, index) => message(index + 1, 'root', `HISTORY_${index + 1}`));
  const requests: any[] = [];
  const mock = await mockServer((socket, request) => {
    requests.push(request);
    if (request.method === 'organization.snapshot') respond(socket, request.id, { seq: 24, agents: [agent('root'), agent('other')], operations: [] });
    else if (request.method === 'events.history') {
      const matches = records.filter(item => item.seq < request.params.before &&
        (!request.params.agentId || item.agentId === request.params.agentId));
      respond(socket, request.id, { events: matches.slice(-request.params.limit), hasMore: matches.length > request.params.limit, oldestSeq: 1, latestSeq: 24, expired: false });
    }
  });
  const session = new Session(mock.path, { replayHistory: false, history: historyPolicy });
  const running = session.run();
  try {
    await waitFor(() => session.status === 'connected');
    await session.openChat('root');
    expect(session.chatEvents('root').map(item => item.seq)).toHaveLength(24);
    session.pauseChat('root'); // Viewport browsing must not pause live membership.
    const sidecarEvent = message(25, 'root', 'LIVE_25');
    for (const socket of mock.sockets) send(socket, { kind: 'presentation', seq: 25, rendering: { rendererId: 'fixture', summary: 'LIVE_25', extended: 'LIVE_25', full: 'LIVE_25' } });
    records.push(sidecarEvent);
    for (const socket of mock.sockets) send(socket, sidecarEvent);
    const next = message(26, 'root', 'LIVE_26'); records.push(next);
    for (const socket of mock.sockets) send(socket, next);
    const other = message(27, 'other', 'OTHER_AGENT_ONLY'); records.push(other);
    for (const socket of mock.sockets) send(socket, other);
    const global = event(28, 'server.ready', { status: 'ready' }, { agentId: undefined }); records.push(global);
    for (const socket of mock.sockets) send(socket, global);
    await waitFor(() => session.store.events.has(26) && session.store.events.has(28));
    expect(session.chatEvents('root').map(item => item.seq)).toEqual([...Array.from({ length: 24 }, (_, index) => index + 1), 25, 26]);
    expect(session.chatEvents('root').filter(item => item.seq === 25)).toHaveLength(1);
    expect(session.chatEvents('root').some(item => item.seq === 27 || item.seq === 28)).toBe(false);
    expect(session.store.renderings.has(25)).toBe(true);
    expect(requests.filter(request => request.method === 'events.history' && request.params.agentId === 'root')).toHaveLength(1);
  } finally { session.close(); await running; await mock.close(); }
});

test('live membership survives an older-page response held in flight', async () => {
  const records = Array.from({ length: 12 }, (_, index) => message(index + 1, 'root', `HISTORY_${index + 1}`));
  const requests: any[] = [];
  let held: { socket: any; request: any } | undefined;
  const mock = await mockServer((socket, request) => {
    requests.push(request);
    if (request.method === 'organization.snapshot') respond(socket, request.id, { seq: 12, agents: [agent('root')], operations: [] });
    else if (request.method === 'events.history') {
      if (request.params.agentId === 'root' && request.params.before === 7 && !held) { held = { socket, request }; return; }
      const matches = records.filter(item => item.seq < request.params.before &&
        (!request.params.agentId || item.agentId === request.params.agentId));
      respond(socket, request.id, { events: matches.slice(-request.params.limit), hasMore: matches.length > request.params.limit, oldestSeq: 1, latestSeq: 12, expired: false });
    }
  });
  const session = new Session(mock.path, { history: { ...historyPolicy, chatPageSize: 6 } });
  const running = session.run();
  try {
    await waitFor(() => session.status === 'connected');
    await session.openChat('root');
    const older = session.olderChat('root');
    await waitFor(() => held !== undefined);
    const live = message(13, 'root', 'LIVE_WHILE_OLDER_PAGE_PENDING'); records.push(live);
    for (const socket of mock.sockets) send(socket, live);
    await waitFor(() => session.store.events.has(13));
    expect(session.chatEvents('root').at(-1)?.seq).toBe(13);
    respond(held!.socket, held!.request.id, { events: records.filter(item => item.seq < 7), hasMore: false, oldestSeq: 1, latestSeq: 12, expired: false });
    await older;
    expect(session.chatEvents('root').map(item => item.seq)).toEqual([...Array.from({ length: 12 }, (_, index) => index + 1), 13]);
    expect(session.chatEvents('root').filter(item => item.seq === 13)).toHaveLength(1);
    expect(requests.filter(request => request.method === 'events.history' && request.params.agentId === 'root')).toHaveLength(1);
  } finally { session.close(); await running; await mock.close(); }
});
