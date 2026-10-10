import { expect, test } from 'bun:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Session } from '../src/session.js';
import { Settings } from '../src/settings.js';
import { agent, event, mockServer, operation, respond, send, waitFor } from './helpers.js';

test('settings round-trip defaults, exclusions, plugin levels and invalid config', async () => {
  const mock = await mockServer(() => {});
  try {
    const path = join(mock.directory, 'config', 'settings.json');
    const settings = await Settings.load(path);
    expect(settings.level('agent.message')).toBe(3);
    expect(settings.level('tool.call')).toBe(1);
    expect(['agent.message', 'prompt.queued', 'tool.call', 'tool.result'].filter(type => settings.tracked(type))).toEqual(['agent.message', 'prompt.queued', 'tool.call', 'tool.result']);
    expect(['agent.created', 'agent.error', 'agent.modified', 'agent.plan', 'agent.removed', 'agent.session_replaced', 'agent.state', 'agent.update', 'operation.changed', 'permission.requested', 'permission.resolved', 'plugin.error', 'prompt.cancelling', 'prompt.finished', 'prompt.started', 'server.ready', 'server.stopped', 'tool.update'].filter(type => settings.tracked(type))).toEqual([]);
    settings.toggle('agent.message');
    settings.levels['plugin.custom'] = 4;
    await settings.save(path);
    const loaded = await Settings.load(path);
    expect(loaded.tracked('agent.message')).toBe(false);
    expect(loaded.level('plugin.custom')).toBe(4);
    expect(JSON.parse(await readFile(path, 'utf8')).levels['plugin.custom']).toBe(4);
    await writeFile(path, '{"excluded":[],"levels":{"agent.message":5}}');
    await expect(Settings.load(path)).rejects.toThrow('Invalid rendering level');
  } finally { await mock.close(); }
});

test('session readiness, fixed-target paginated replay, expiry, live dedup and interrupting prompt', async () => {
  const history = [event(1), event(2), event(3)];
  const requests: any[] = [];
  let snapshots = 0;
  const mock = await mockServer((socket, request) => {
    requests.push(request);
    if (request.method === 'organization.snapshot') {
      if (!snapshots++) {
        send(socket, { kind: 'response', id: request.id, ok: false, error: { code: 'NOT_READY', message: 'starting' } });
      } else {
        send(socket, event(3)); // Before the response; must be kept for chat.
        respond(socket, request.id, { seq: 3, agents: [agent('root')], operations: [], capabilities: { harnesses: ['fixture', 'alpha'] } });
      }
    } else if (request.method === 'events.history') {
      const page = history.filter(event => event.seq > request.params.after).slice(0, 2);
      respond(socket, request.id, { events: page, oldestSeq: 2, latestSeq: 3, expired: request.params.after === 0 });
    } else if (request.method === 'agent.prompt') {
      send(socket, event(4, 'operation.changed', operation('completed')));
      respond(socket, request.id, operation('queued'));
    } else if (request.method === 'operation.wait') {
      respond(socket, request.id, operation('completed'));
    }
  });
  const session = new Session(mock.path);
  const notices: string[] = [];
  session.on('notice', message => notices.push(message));
  const running = session.run();
  try {
    await waitFor(() => session.status === 'connected');
    expect(session.harnesses).toEqual(['alpha', 'fixture']);
    expect(session.store.orderedEvents().map(event => event.seq)).toEqual([1, 2, 3]);
    expect(session.store.historyCursor).toBe(3);
    expect(session.store.historyGap).toBe(true);
    expect(requests.filter(request => request.method === 'events.history').map(request => request.params.after)).toEqual([0, 2]);
    await session.prompt('root', 'interrupt now');
    expect(requests.find(request => request.method === 'agent.prompt').params).toEqual({ agentId: 'root', text: 'interrupt now', queue: false });
    expect(session.store.operations.get('op')!.status).toBe('completed');
    expect(notices.some(message => message.includes('Prompt completed'))).toBe(true);
  } finally { session.close(); await running; await mock.close(); }
});

test('reconnect resnapshots, replays missing events and resets when database sequence goes backwards', async () => {
  let connections = 0;
  let database = 1;
  const histories = { 1: [event(1), event(2)], 2: [event(1, 'plugin.newdb', { newDatabase: true })] };
  const mock = await mockServer((socket, request) => {
    if (request.method === 'organization.snapshot') {
      respond(socket, request.id, { seq: database === 1 ? 2 : 1, agents: [agent(database === 1 ? 'old' : 'new')], operations: [] });
    } else if (request.method === 'events.history') {
      respond(socket, request.id, { events: histories[database as 1 | 2].filter(event => event.seq > request.params.after), oldestSeq: 1, latestSeq: database === 1 ? 2 : 1, expired: false });
    }
  }, () => { connections++; });
  const session = new Session(mock.path);
  const running = session.run();
  try {
    await waitFor(() => session.status === 'connected');
    expect(session.store.events.size).toBe(2);
    database = 2;
    for (const socket of mock.sockets) socket.destroy();
    await waitFor(() => connections >= 2 && session.status === 'connected' && session.store.agents.has('new'));
    expect(session.store.events.size).toBe(1);
    expect(session.store.orderedEvents()[0]!.type).toBe('plugin.newdb');
    expect(session.store.historyCursor).toBe(1);
    expect(session.store.agents.has('old')).toBe(false);
  } finally { session.close(); await running; await mock.close(); }
});
