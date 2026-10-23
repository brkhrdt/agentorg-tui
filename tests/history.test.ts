import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { Session } from '../src/session.js';
import { Settings } from '../src/settings.js';
import { Store } from '../src/store.js';
import { agent, event, mockServer, respond, send, waitFor } from './helpers.js';

const policy = { recentEvents: 6, chatPageSize: 2, cacheBytes: 32 * 1024, idleMinutes: 10 };
const presentation = { rendererId: 'test', summary: 'summary', extended: 'extended', full: 'full' };

test('cache count, bytes, renderings and derived summaries are bounded; historical reads expire while idle', () => {
  const store = new Store();
  store.configureHistory(policy);
  store.install({ seq: 0, agents: [agent('root')], operations: [] });
  for (let i = 1; i <= 20; i++) { store.present(i, presentation); store.ingest(event(i)); }
  expect(store.orderedEvents().map(e => e.seq)).toEqual([15, 16, 17, 18, 19, 20]);
  expect([...store.renderings.keys()]).toEqual([15, 16, 17, 18, 19, 20]);
  store.setActiveChat('worker');
  store.ingest(event(2, 'agent.message', { content: { text: 'old text' } }, { agentId: 'worker' }), 'history');
  store.present(2, presentation);
  expect(store.events.has(2)).toBe(true);
  store.setActiveChat();
  store.pruneHistory(Date.now() + 11 * 60_000);
  expect(store.events.has(2)).toBe(false);
  expect(store.renderings.has(2)).toBe(false);
  expect(store.latest(new Settings()).has('worker')).toBe(false);
  store.configureHistory({ ...policy, cacheBytes: 2048 });
  for (let i = 21; i < 30; i++) {
    store.present(i, { ...presentation, full: 'x'.repeat(600) });
    store.ingest(event(i, 'tool.result', { output: 'x'.repeat(600) }));
  }
  expect(store.cachedBytes).toBeLessThanOrEqual(2048);
  expect(store.events.size).toBeLessThanOrEqual(6);
  expect([...store.renderings.keys()].every(seq => store.events.has(seq))).toBe(true);
  // Even unmatched presentation frames cannot escape the byte/count budget.
  for (let i = 100; i < 200; i++) store.present(i, presentation);
  expect(store.cachedBytes).toBeLessThanOrEqual(2048);
  expect(store.renderings.size).toBeLessThanOrEqual(6);
  store.ingest(event(300, 'tool.result', { output: 'z'.repeat(20_000) }));
  expect(store.events.get(300)?.data).toMatchObject({ truncated: true });
  expect(store.cachedBytes).toBeLessThanOrEqual(2048);
});

test('recent events promoted into a historical viewport also expire after falling outside the live tail', () => {
  const store = new Store();
  store.configureHistory(policy);
  for (let seq = 11; seq <= 16; seq++) store.ingest(event(seq));
  store.setActiveChat('root', true, 11);
  store.ingest(event(11), 'history'); store.ingest(event(12), 'history');
  store.ingest(event(1), 'history');
  for (let seq = 17; seq <= 40; seq++) store.ingest(event(seq));
  expect(store.events.has(11)).toBe(true);
  store.setActiveChat();
  store.pruneHistory(Date.now() + 11 * 60_000);
  expect(store.events.has(1)).toBe(false);
  expect(store.events.has(11)).toBe(false);
  expect(store.events.has(12)).toBe(false);
});

test('history settings round-trip, inherit defaults from older configs, and reject invalid values', async () => {
  const mock = await mockServer(() => {});
  const path = join(mock.directory, 'settings.json');
  try {
    const settings = new Settings();
    expect(settings.history).toEqual({ recentEvents: 2000, chatPageSize: 200, cacheBytes: 32 * 1024 * 1024, idleMinutes: 10 });
    settings.history = policy;
    await settings.save(path);
    expect((await Settings.load(path)).history).toEqual(policy);
    expect(JSON.parse(await readFile(path, 'utf8')).history).toEqual(policy);
    for (const history of [{ recentEvents: 0 }, { cacheBytes: -1 }, { cacheBytes: 100 }, { chatPageSize: 1.5 }, { idleMinutes: null }, []]) {
      await writeFile(path, JSON.stringify({ excluded: [], levels: {}, history }));
      await expect(Settings.load(path)).rejects.toThrow('Invalid history');
    }
    await writeFile(path, JSON.stringify({ excluded: [], levels: {} }));
    expect((await Settings.load(path)).history.recentEvents).toBe(2000);
  } finally { await mock.close(); }
});

test('startup fetches only a recent tail; chat loads its own tail and older pages, then retires idle data', async () => {
  const history = Array.from({ length: 100 }, (_, i) => event(i + 1, 'agent.message', { content: { text: `message ${i + 1}` } }, { agentId: i < 50 ? 'worker' : 'root' }));
  const requests: any[] = [];
  const mock = await mockServer((socket, request) => {
    requests.push(request);
    if (request.method === 'organization.snapshot') respond(socket, request.id, { seq: 100, agents: [agent('root'), agent('worker')], operations: [] });
    else if (request.method === 'events.history') {
      const { after = 0, before = Infinity, limit, agentId } = request.params;
      const matches = history.filter(e => e.seq > after && e.seq < before && (!agentId || e.agentId === agentId));
      const events = matches.slice(-limit);
      respond(socket, request.id, { events, hasMore: matches.length > events.length, oldestSeq: 1, latestSeq: 100, expired: false });
    }
  });
  const session = new Session(mock.path, { history: policy });
  const running = session.run();
  try {
    await waitFor(() => session.status === 'connected');
    expect(session.store.orderedEvents().map(e => e.seq)).toEqual([95, 96, 97, 98, 99, 100]);
    expect(requests.filter(r => r.method === 'events.history')).toHaveLength(1);
    expect(session.store.historyCursor).toBe(100);
    await session.openChat('worker');
    expect(session.chatEvents('worker').map(e => e.seq)).toEqual([49, 50]);
    await session.olderChat('worker');
    expect(session.chatEvents('worker').map(e => e.seq)).toEqual([47, 48, 49, 50]);
    await session.olderChat('worker');
    await session.olderChat('worker');
    expect(session.store.events.size).toBeLessThanOrEqual(policy.recentEvents);
    const retained = session.chatEvents('worker').map(e => e.seq);
    expect(retained).toEqual([43, 44, 45, 46, 49, 50]);
    expect(retained).toEqual([...retained].sort((a, b) => a - b));
    expect(session.chatCoverageIncomplete('worker')).toBe(true);
    session.leaveChat();
    session.store.pruneHistory(Date.now() + 11 * 60_000);
    expect(session.store.orderedEvents().some(e => e.agentId === 'worker')).toBe(false);
    await session.openChat('worker');
    expect(session.chatEvents('worker').map(e => e.seq)).toEqual([49, 50]);
    const tails = requests.filter(r => r.method === 'events.history' && r.params.agentId === 'worker' && r.params.before === 101);
    expect(tails).toHaveLength(2);
    // Reconnects rebase on a bounded tail rather than replaying all missed history.
    for (const socket of mock.sockets) socket.destroy();
    await waitFor(() => requests.filter(r => r.method === 'organization.snapshot').length >= 2 && session.status === 'connected');
    expect(requests.filter(r => r.method === 'events.history' && !r.params.agentId).every(r => r.params.before === 101)).toBe(true);
  } finally { session.close(); await running; await mock.close(); }
});

test('older-page traversal advances past cache capacity while preserving the bounded live tail', async () => {
  const history = Array.from({ length: 30 }, (_, i) => event(i + 1, 'agent.message', { content: { text: `message ${i + 1}` } }, { agentId: 'root' }));
  const requests: any[] = [];
  const mock = await mockServer((socket, request) => {
    requests.push(request);
    if (request.method === 'organization.snapshot') respond(socket, request.id, { seq: 30, agents: [agent('root')], operations: [] });
    else if (request.method === 'events.history') {
      const { after = 0, before = Infinity, limit, agentId } = request.params;
      const matches = history.filter(item => item.seq > after && item.seq < before && (!agentId || item.agentId === agentId));
      respond(socket, request.id, { events: matches.slice(-limit), hasMore: matches.length > limit, oldestSeq: 1, latestSeq: 30, expired: false });
    }
  });
  const session = new Session(mock.path, { history: policy });
  const running = session.run();
  try {
    await waitFor(() => session.status === 'connected');
    await session.openChat('root');
    const cursors: number[] = [];
    for (let page = 0; page < 20 && session.chatHasMore('root'); page++) {
      const before = session.chatEvents('root')[0]?.seq;
      expect(before).toBeDefined();
      cursors.push(before!);
      await session.olderChat('root');
      expect(session.store.events.size).toBeLessThanOrEqual(policy.recentEvents);
    }
    expect(cursors.length).toBeGreaterThan(6);
    expect(cursors.every((cursor, index) => index === 0 || cursor < cursors[index - 1]!)).toBe(true);
    expect(session.chatEvents('root').some(item => item.seq === 1)).toBe(true);
    expect(session.chatEvents('root').slice(-2).map(item => item.seq)).toEqual([29, 30]);
    expect(session.store.events.has(30)).toBe(true);
    expect(session.store.events.size).toBeLessThanOrEqual(policy.recentEvents);
    expect(requests.filter(request => request.method === 'events.history' && request.params.agentId === 'root').length).toBeGreaterThan(6);
  } finally { session.close(); await running; await mock.close(); }
});

test('active historical chat appends live membership within cache bounds and follow reloads the latest tail', async () => {
  const history = Array.from({ length: 20 }, (_, i) => event(i + 1));
  const mock = await mockServer((socket, request) => {
    if (request.method === 'organization.snapshot') respond(socket, request.id, { seq: history.length, agents: [agent('root')], operations: [] });
    else if (request.method === 'events.history') {
      const matches = history.filter(e => e.seq < request.params.before);
      respond(socket, request.id, { events: matches.slice(-request.params.limit), hasMore: matches.length > request.params.limit, oldestSeq: 1, latestSeq: history.length, expired: false });
    }
  });
  const session = new Session(mock.path, { history: policy });
  const running = session.run();
  try {
    await waitFor(() => session.status === 'connected');
    await session.openChat('root');
    await session.olderChat('root');
    const old = session.chatEvents('root').map(e => e.seq);
    for (let i = 21; i <= 40; i++) { const next = event(i); history.push(next); for (const socket of mock.sockets) send(socket, next); }
    await waitFor(() => session.store.watermark === 40);
    expect(session.chatEvents('root').map(e => e.seq).at(-1)).toBe(40);
    expect(session.chatEvents('root').length).toBeGreaterThan(old.length);
    expect(session.store.events.has(40)).toBe(true);
    expect(session.store.events.size).toBeLessThanOrEqual(6);
    await session.followChat('root');
    expect(session.chatEvents('root').map(e => e.seq)).toEqual([39, 40]);
    expect(session.store.events.size).toBeLessThanOrEqual(6);
  } finally { session.close(); await running; await mock.close(); }
});
