import { expect, test } from 'bun:test';
import type { Socket } from 'node:net';
import { Session } from '../src/session.js';
import { agent, event, mockServer, respond, send, waitFor } from './helpers.js';

const policy = { recentEvents: 6, chatPageSize: 2, cacheBytes: 32 * 1024, idleMinutes: 10 };

test('late older-page responses cannot replace a newer follow window; repeated chat entry uses cached coverage', async () => {
  const history = Array.from({ length: 20 }, (_, i) => event(i + 1));
  let held: { socket: Socket; id: string } | undefined;
  const requests: any[] = [];
  const mock = await mockServer((socket, request) => {
    requests.push(request);
    if (request.method === 'organization.snapshot') respond(socket, request.id, { seq: 20, agents: [agent('root')], operations: [] });
    else if (request.method === 'events.history' && request.params.agentId && request.params.before === 19) held = { socket, id: request.id };
    else if (request.method === 'events.history') {
      const matches = history.filter(e => e.seq < request.params.before);
      respond(socket, request.id, { events: matches.slice(-request.params.limit), hasMore: true, oldestSeq: 1, latestSeq: 20, expired: false });
    }
  });
  const session = new Session(mock.path, { history: policy });
  const running = session.run();
  try {
    await waitFor(() => session.status === 'connected');
    await session.openChat('root');
    const count = requests.length;
    session.leaveChat();
    await session.openChat('root');
    expect(requests).toHaveLength(count);
    session.configureHistory({ ...policy, chatPageSize: 1 });
    await session.openChat('root');
    expect(session.chatEvents('root').map(e => e.seq)).toEqual([20]);
    session.configureHistory(policy);
    await session.openChat('root');
    const pending = session.olderChat('root');
    await waitFor(() => !!held);
    await session.followChat('root');
    respond(held!.socket, held!.id, { events: [event(17), event(18)], hasMore: true, oldestSeq: 1, latestSeq: 20, expired: false });
    await pending;
    expect(session.chatEvents('root').map(e => e.seq)).toEqual([19, 20]);
  } finally { session.close(); await running; await mock.close(); }
});

test('byte-limited tail and chat pages fill to the requested count without replaying earlier history', async () => {
  const history = Array.from({ length: 30 }, (_, i) => event(i + 1));
  const requests: any[] = [];
  const mock = await mockServer((socket, request) => {
    requests.push(request);
    if (request.method === 'organization.snapshot') respond(socket, request.id, { seq: 30, agents: [agent('root')], operations: [] });
    else if (request.method === 'events.history') {
      const matches = history.filter(e => e.seq < request.params.before);
      respond(socket, request.id, { events: matches.slice(-1), hasMore: matches.length > 1, oldestSeq: 1, latestSeq: 30, expired: false });
    }
  });
  const session = new Session(mock.path, { history: policy });
  const running = session.run();
  try {
    await waitFor(() => session.status === 'connected');
    expect(requests.filter(r => r.method === 'events.history').map(r => r.params.before)).toEqual([31, 30, 29, 28, 27, 26]);
    expect(session.store.orderedEvents().map(e => e.seq)).toEqual([25, 26, 27, 28, 29, 30]);
    await session.openChat('root');
    await session.olderChat('root');
    expect(session.chatEvents('root').map(e => e.seq)).toEqual([27, 28, 29, 30]);
  } finally { session.close(); await running; await mock.close(); }
});

test('--no-history skips startup requests but explicit chat browsing remains available', async () => {
  const requests: any[] = [];
  const mock = await mockServer((socket, request) => {
    requests.push(request);
    if (request.method === 'organization.snapshot') respond(socket, request.id, { seq: 10, agents: [agent('root')], operations: [] });
    else if (request.method === 'events.history') respond(socket, request.id, { events: [event(9), event(10)], hasMore: true, oldestSeq: 1, latestSeq: 10, expired: false });
  });
  const session = new Session(mock.path, { replayHistory: false, history: policy });
  const running = session.run();
  try {
    await waitFor(() => session.status === 'connected');
    expect(requests.some(r => r.method === 'events.history')).toBe(false);
    await session.openChat('root');
    expect(session.chatEvents('root').map(e => e.seq)).toEqual([9, 10]);
  } finally { session.close(); await running; await mock.close(); }
});

test('failed explicit chat loads are retryable without reconnecting or caching a false empty transcript', async () => {
  let failures = 0;
  const mock = await mockServer((socket, request) => {
    if (request.method === 'organization.snapshot') respond(socket, request.id, { seq: 10, agents: [agent('root')], operations: [] });
    else if (request.method === 'events.history' && !failures++) send(socket, { kind: 'response', id: request.id, ok: false, error: { code: 'LIMIT', message: 'temporary' } });
    else if (request.method === 'events.history') respond(socket, request.id, { events: [event(9), event(10)], hasMore: true, oldestSeq: 1, latestSeq: 10, expired: false });
  });
  const session = new Session(mock.path, { replayHistory: false, history: policy });
  const running = session.run();
  try {
    await waitFor(() => session.status === 'connected');
    await expect(session.openChat('root')).rejects.toThrow('temporary');
    await session.openChat('root');
    expect(session.chatEvents('root').map(e => e.seq)).toEqual([9, 10]);
  } finally { session.close(); await running; await mock.close(); }
});

test('startup live buffering stays bounded and dropped state is reconciled from a fresh snapshot', async () => {
  let snapshots = 0;
  const mock = await mockServer((socket, request) => {
    if (request.method === 'organization.snapshot') {
      snapshots++;
      if (snapshots === 1) {
        send(socket, event(1, 'agent.state', { state: 'running' }));
        for (let i = 2; i < 40; i++) send(socket, event(i));
        respond(socket, request.id, { seq: 0, agents: [agent('root')], operations: [] });
      } else respond(socket, request.id, { seq: 39, agents: [agent('root', null, { state: 'running' })], operations: [] });
    }
  });
  const session = new Session(mock.path, { replayHistory: false, history: policy });
  const running = session.run();
  try {
    await waitFor(() => session.status === 'connected');
    expect(session.store.events.size).toBeLessThanOrEqual(6);
    await waitFor(() => snapshots >= 2 && session.store.agents.get('root')?.state === 'running');
    expect(session.store.cachedBytes).toBeLessThanOrEqual(policy.cacheBytes);
  } finally { session.close(); await running; await mock.close(); }
});
