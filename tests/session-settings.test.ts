import { expect, test } from 'bun:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Session } from '../src/session.js';
import { availableTableFields, DEFAULT_LEVELS, DEFAULT_TABLE_FIELDS, Settings } from '../src/settings.js';
import { agent, event, mockServer, operation, respond, send, waitFor } from './helpers.js';

test('settings round-trip defaults, level-zero visibility, plugin levels and invalid config', async () => {
  const mock = await mockServer(() => {});
  try {
    const path = join(mock.directory, 'config', 'settings.json');
    const settings = await Settings.load(path);
    expect(settings.levels).toEqual(DEFAULT_LEVELS);
    expect(settings.inheritedLevels.size).toBe(0);
    expect(settings.level('agent.message')).toBe(3);
    expect(settings.level('tool.call')).toBe(1);
    expect(settings.level('tool.call', 'mcp__agentorg__prompt_subagent')).toBe(3);
    expect(settings.level('tool.call', 'mcp__agentorg__prompt_parent')).toBe(3); // historical event rendering only
    expect(settings.level('tool.result', 'mcp__agentorg__prompt_parent')).toBe(2); // historical event rendering only
    expect(settings.level('tool.call', 'cancel_operation')).toBe(2);
    expect(settings.level('tool.call', 'mcp__agentorg__create_subagent')).toBe(1);
    expect(settings.level('tool.result', 'mcp__agentorg__get_operation')).toBe(2);
    expect(settings.level('tool.result', 'read')).toBe(2);
    settings.levels['tool.result'] = 3;
    settings.levels['tool.result:read'] = 0;
    expect(settings.level('tool.result', 'read')).toBe(0);
    expect(settings.level('tool.result', 'write')).toBe(3);
    expect(settings.visible('tool.result', 'read')).toBe(false);
    expect(settings.visible('tool.result', 'write')).toBe(true);
    delete settings.levels['tool.result:read'];
    expect(['agent.message', 'prompt.queued', 'tool.call', 'tool.result'].filter(type => settings.visible(type))).toEqual(['agent.message', 'prompt.queued', 'tool.call', 'tool.result']);
    expect(['agent.created', 'agent.error', 'agent.modified', 'agent.plan', 'agent.removed', 'agent.session_replaced', 'agent.state', 'agent.update', 'operation.changed', 'permission.requested', 'permission.resolved', 'plugin.error', 'prompt.cancelling', 'prompt.finished', 'prompt.started', 'server.ready', 'server.stopped'].filter(type => settings.visible(type))).toEqual([]);
    expect(settings.visible('tool.update')).toBe(true);
    expect(settings.level('tool.update')).toBe(3);
    settings.levels['agent.message'] = 0;
    settings.tableFields = ['error', 'name', 'status'];
    settings.levels['plugin.custom'] = 4;
    settings.levels['tool.call:mcp__agentorg__prompt_parent'] = 1;
    settings.levels['tool.result:mcp__agentorg__prompt_parent'] = 4;
    settings.levels['tool.result'] = 4;
    delete settings.levels['tool.call:mcp__agentorg__prompt_subagent'];
    settings.inheritedLevels.add('tool.call:mcp__agentorg__prompt_subagent');
    settings.inheritedLevels.add('tool.result:mcp__agentorg__get_operation');
    delete settings.levels['tool.result:mcp__agentorg__get_operation'];
    expect(settings.compactToolCalls).toBe(false);
    settings.compactToolCalls = true;
    settings.colors.selectionBg = 'white';
    settings.colors.selectionFg = 'black';
    settings.colors.toolCall = 'magenta';
    await settings.save(path);
    const loaded = await Settings.load(path);
    expect(loaded.visible('agent.message')).toBe(false);
    expect(loaded.level('plugin.custom')).toBe(4);
    expect(loaded.level('tool.call', 'mcp__agentorg__prompt_parent')).toBe(1);
    expect(loaded.level('tool.result', 'mcp__agentorg__prompt_parent')).toBe(4);
    expect(loaded.inheritedLevels).toEqual(new Set(['tool.call:mcp__agentorg__prompt_subagent', 'tool.result:mcp__agentorg__get_operation']));
    expect(loaded.level('tool.result', 'mcp__agentorg__get_operation')).toBe(4);
    expect(loaded.level('tool.result', 'mcp__agentorg__get_completion')).toBe(2);
    expect(loaded.level('tool.call', 'mcp__agentorg__prompt_subagent')).toBe(1);
    expect(loaded.tableFields).toEqual(['error', 'name', 'status']);
    expect(loaded.compactToolCalls).toBe(true);
    expect(loaded.colors).toMatchObject({ selectionBg: 'white', selectionFg: 'black', toolCall: 'magenta' });
    const persisted = JSON.parse(await readFile(path, 'utf8'));
    expect(persisted.levels['plugin.custom']).toBe(4);
    for (const tableFields of [undefined, null, [], ['unknown', 3], ['harness', 'harness', null, 'event', 'unknown']]) {
      await writeFile(path, JSON.stringify({ levels: {}, tableFields }));
      const compatible = await Settings.load(path);
      expect(compatible.compactToolCalls).toBe(false);
      expect(compatible.tableFields).toEqual(Array.isArray(tableFields) && tableFields.includes('harness')
        ? ['harness', 'event'] : [...DEFAULT_TABLE_FIELDS]);
    }
    expect(DEFAULT_TABLE_FIELDS).toEqual(['name', 'status', 'model', 'event']);
    await writeFile(path, JSON.stringify({ levels: {}, tableFields: ['metric:custom.requests', 'cost', 'name', 'metric:bad', 'metric:custom.requests'] }));
    const custom = await Settings.load(path);
    expect(custom.tableFields).toEqual(['metric:custom.requests', 'cost', 'name']);
    const available = availableTableFields([{ id: 'custom.requests' }, { id: 'cost.usd' }], custom.tableFields);
    expect(available).toContain('metric:custom.requests');
    expect(available.filter(field => field === 'cost' || field === 'metric:cost.usd')).toEqual(['cost']);
    for (const compactToolCalls of [null, 1, 'true', [], {}]) {
      await writeFile(path, JSON.stringify({ levels: {}, compactToolCalls }));
      await expect(Settings.load(path)).rejects.toThrow('Invalid compactToolCalls setting');
    }
    await writeFile(path, JSON.stringify({ levels: { 'tool.result': 4, 'tool.call': 1, 'tool.result:create_subagent': 3 } }));
    const legacy = await Settings.load(path);
    expect(legacy.level('tool.result', 'mcp__agentorg__get_operation')).toBe(4);
    expect(legacy.level('tool.call', 'mcp__agentorg__prompt_subagent')).toBe(1);
    expect(legacy.level('tool.result', 'create_subagent')).toBe(3);
    expect(legacy.inheritedLevels).toContain('tool.result:mcp__agentorg__get_operation');
    await writeFile(path, '{"levels":{"agent.message":5}}');
    await expect(Settings.load(path)).rejects.toThrow('Invalid rendering level');
  } finally { await mock.close(); }
});

test('session readiness, fixed-target backwards tail pages, expiry, live dedup and interrupting prompt', async () => {
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
      const matches = history.filter(event => event.seq < request.params.before);
      const page = matches.slice(-2);
      respond(socket, request.id, { events: page, hasMore: matches.length > page.length, oldestSeq: 2, latestSeq: 3, expired: true });
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
    expect(requests.filter(request => request.method === 'events.history').map(request => request.params.before)).toEqual([4, 2]);
    await session.prompt('root', 'interrupt now');
    expect(requests.find(request => request.method === 'agent.prompt').params).toEqual({ agentId: 'root', text: 'interrupt now', queue: false });
    expect(session.store.operations.get('op')!.status).toBe('completed');
    expect(notices.some(message => message.includes('Prompt completed'))).toBe(true);
  } finally { session.close(); await running; await mock.close(); }
});

test('live skills reconciliation refreshes status and catalog, polls boundedly, and cancels polling on close', async () => {
  const requests: any[] = [];
  let catalog: any = { skills: [{ name: 'alpha', description: 'Ready' }], retained: [], reconciliation: { state: 'ready', entries: [] } };
  const mock = await mockServer((socket, request) => {
    requests.push(request);
    if (request.method === 'organization.snapshot') respond(socket, request.id, { seq: 0, agents: [agent('root')], operations: [], capabilities: {
      plugins: { skills: { version: 1, settingsNamespace: 'skills', endpoints: { list: 'skills.list', reconcile: 'skills.reconcile' } } },
    } });
    else if (request.method === 'skills.list') respond(socket, request.id, catalog);
    else if (request.method === 'events.history') respond(socket, request.id, { events: [], expired: false, latestSeq: 0, oldestSeq: 1 });
    else if (request.method === 'skills.reconcile') respond(socket, request.id, { accepted: true });
  });
  const intervals: Array<{ callback: () => void; delay: number }> = [];
  const cancelled: unknown[] = [];
  const originalSetInterval = globalThis.setInterval, originalClearInterval = globalThis.clearInterval;
  globalThis.setInterval = ((callback: TimerHandler, delay?: number) => {
    intervals.push({ callback: callback as () => void, delay: delay ?? 0 });
    return intervals.length as unknown as ReturnType<typeof setInterval>;
  }) as unknown as typeof setInterval;
  globalThis.clearInterval = ((timer: ReturnType<typeof setInterval>) => { cancelled.push(timer); }) as typeof clearInterval;
  const session = new Session(mock.path);
  const running = session.run();
  try {
    await waitFor(() => session.status === 'connected');
    expect(session.skillCatalog.map(skill => skill.name)).toEqual(['alpha']);
    expect(intervals.map(timer => timer.delay)).toEqual([10_000]);
    catalog = { skills: [], retained: [{ name: 'alpha', state: 'installed' }], reconciliation: { state: 'error', entries: [{ name: 'alpha', status: 'error', message: 'clone failed' }] } };
    const socket = [...mock.sockets][0]!;
    for (const [seq, state] of ['ready', 'removal', 'error', 'retry'].entries())
      send(socket, event(seq + 1, 'skills.reconciliation_changed', { state, desiredRevision: seq + 2 }));
    await waitFor(() => requests.filter(request => request.method === 'skills.list').length >= 5);
    expect(session.skillCatalog).toEqual([]);
    expect((session as any).skillReconciliation).toMatchObject({ state: 'error' });
    intervals[0]!.callback();
    await waitFor(() => requests.filter(request => request.method === 'organization.snapshot').length >= 2);
    expect((session as any).reconcileSkills).toBeFunction();
    await (session as any).reconcileSkills();
    expect(requests.filter(request => request.method === 'skills.reconcile')).toHaveLength(1);
    expect(requests.filter(request => request.method === 'organization.settings.update')).toHaveLength(0);
  } finally {
    session.close(); await running;
    globalThis.setInterval = originalSetInterval; globalThis.clearInterval = originalClearInterval;
    expect(cancelled).toContain(1);
    await mock.close();
  }
});

test('missed completion events keep skill polling alive beyond six intervals until reconciliation terminates', async () => {
  const requests: any[] = [];
  let state: 'pending' | 'ready' = 'pending';
  const mock = await mockServer((socket, request) => {
    requests.push(request);
    if (request.method === 'organization.snapshot') respond(socket, request.id, { seq: 0, agents: [agent('root')], operations: [], capabilities: {
      plugins: { skills: { version: 1, settingsNamespace: 'skills', endpoints: { list: 'skills.list' } } },
    } });
    else if (request.method === 'skills.list') respond(socket, request.id, { skills: state === 'ready' ? [{ name: 'beta', description: 'Prepared' }] : [], reconciliation: { state, entries: [] } });
    else if (request.method === 'events.history') respond(socket, request.id, { events: [], expired: false, latestSeq: 0, oldestSeq: 1 });
  });
  const originalSetInterval = globalThis.setInterval, originalClearInterval = globalThis.clearInterval;
  let tick: (() => void) | undefined;
  globalThis.setInterval = ((callback: TimerHandler) => { tick = callback as () => void; return 1 as unknown as ReturnType<typeof setInterval>; }) as unknown as typeof setInterval;
  globalThis.clearInterval = (() => {}) as typeof clearInterval;
  const session = new Session(mock.path);
  const running = session.run();
  try {
    await waitFor(() => session.status === 'connected' && !!tick);
    for (let i = 0; i < 6; i++) {
      const before = requests.filter(request => request.method === 'skills.list').length;
      tick!();
      await waitFor(() => requests.filter(request => request.method === 'skills.list').length > before);
      await new Promise(resolve => setTimeout(resolve, 180)); // Drain coalesced snapshot refresh before the next interval.
    }
    expect(session.skillReconciliation?.state).toBe('pending');
    const beforeTerminalPoll = requests.filter(request => request.method === 'skills.list').length;
    state = 'ready'; // The completion notification was missed; polling must still discover this.
    tick!();
    await waitFor(() => requests.filter(request => request.method === 'skills.list').length > beforeTerminalPoll && session.skillReconciliation?.state === 'ready');
    expect(session.skillCatalog.map(skill => skill.name)).toEqual(['beta']);
  } finally {
    session.close(); await running;
    globalThis.setInterval = originalSetInterval; globalThis.clearInterval = originalClearInterval;
    await mock.close();
  }
});

test('late skills catalog response cannot overwrite a newer discovery result', async () => {
  const requests: any[] = [];
  let held: { socket: import('node:net').Socket; id: string } | undefined;
  const mock = await mockServer((socket, request) => {
    requests.push(request);
    if (request.method === 'organization.snapshot') respond(socket, request.id, { seq: 0, agents: [agent('root')], operations: [], capabilities: {
      plugins: { skills: { version: 1, settingsNamespace: 'skills', endpoints: { list: 'skills.list' } } },
    } });
    else if (request.method === 'skills.list' && !held && requests.filter(item => item.method === 'skills.list').length === 1)
      respond(socket, request.id, { skills: [{ name: 'alpha', description: 'Initial' }] });
    else if (request.method === 'skills.list' && !held) held = { socket, id: request.id };
    else if (request.method === 'skills.list') respond(socket, request.id, { skills: [{ name: 'gamma', description: 'Newer discovery' }] });
    else if (request.method === 'events.history') respond(socket, request.id, { events: [], expired: false, latestSeq: 0, oldestSeq: 1 });
  });
  const session = new Session(mock.path);
  const running = session.run();
  try {
    await waitFor(() => session.status === 'connected');
    const stale = session.refreshSkills();
    await waitFor(() => !!held);
    const newer = session.refreshSkills();
    await newer;
    expect(session.skillCatalog.map(skill => skill.name)).toEqual(['gamma']);
    respond(held!.socket, held!.id, { skills: [{ name: 'beta', description: 'Stale response' }] });
    await stale;
    expect(session.skillCatalog.map(skill => skill.name)).toEqual(['gamma']);
  } finally { session.close(); await running; await mock.close(); }
});

test('delayed older discovery cannot replace newer skills endpoint aliases', async () => {
  const requests: any[] = [];
  let heldRenderer: { socket: import('node:net').Socket; id: string } | undefined;
  const mock = await mockServer((socket, request) => {
    requests.push(request);
    if (request.method === 'organization.snapshot') respond(socket, request.id, { seq: 0, agents: [agent('root')], operations: [], capabilities: {
      plugins: { skills: { version: 1, settingsNamespace: 'skills', endpoints: { list: 'skills.list.initial', reconcile: 'skills.reconcile.initial' } } },
    } });
    else if (request.method === 'skills.list.initial') respond(socket, request.id, { skills: [{ name: 'initial', description: 'Initial catalog' }] });
    else if (request.method === 'skills.list.new') respond(socket, request.id, { skills: [{ name: 'current', description: 'Current catalog' }] });
    else if (request.method === 'skills.list.old') respond(socket, request.id, { skills: [{ name: 'stale', description: 'Old catalog' }] });
    else if (request.method === 'renderers.slow') heldRenderer = { socket, id: request.id };
    else if (request.method === 'skills.reconcile.new' || request.method === 'skills.reconcile.old') respond(socket, request.id, { accepted: true });
    else if (request.method === 'events.history') respond(socket, request.id, { events: [], expired: false, latestSeq: 0, oldestSeq: 1 });
  });
  const session = new Session(mock.path);
  const running = session.run();
  try {
    await waitFor(() => session.status === 'connected');
    const client = (session as any).client;
    const older = (session as any).loadSkills(client, { capabilities: {
      rendering: { version: 1, catalog: 'renderers.slow' },
      plugins: { skills: { version: 1, settingsNamespace: 'skills', endpoints: { list: 'skills.list.old', reconcile: 'skills.reconcile.old' } } },
    } });
    await waitFor(() => !!heldRenderer);
    await (session as any).loadSkills(client, { capabilities: {
      plugins: { skills: { version: 1, settingsNamespace: 'skills', endpoints: { list: 'skills.list.new', reconcile: 'skills.reconcile.new' } } },
    } });
    expect(session.skillCatalog.map(skill => skill.name)).toEqual(['current']);
    const oldRenderer = heldRenderer!;
    respond(oldRenderer.socket, oldRenderer.id, { version: 1, renderers: [] });
    await older;
    expect(requests.some(request => request.method === 'skills.list.old')).toBe(false);
    expect(session.skillCatalog.map(skill => skill.name)).toEqual(['current']);

    const before = requests.length;
    await session.refreshSkills();
    await session.reconcileSkills();
    const after = requests.slice(before).map(request => request.method);
    expect(after).toContain('skills.list.new');
    expect(after).toContain('skills.reconcile.new');
    expect(after).not.toContain('skills.list.old');
    expect(after).not.toContain('skills.reconcile.old');
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
