import { expect, test } from 'vitest';
import { AgentEditor } from '../src/agent-editor.js';
import { Session, type LifecycleMethod } from '../src/session.js';
import { agent, event, mockServer, respond, send, waitFor } from './helpers.js';

test('agent editor creates root/child, validates maps, and fences minimal patches against its captured revision', () => {
  const root = new AgentEditor(null);
  expect(() => root.params()).toThrow('harness cannot be blank');
  root.values.harness = 'fixture';
  expect(root.params()).toEqual({ parentId: null, name: 'agent', metadata: {}, settings: { harness: 'fixture', env: {}, options: {}, extensions: {} } });
  const child = new AgentEditor('root');
  child.values.harness = 'fixture';
  child.values.model = 'exact-model';
  child.values.cwd = 'child-dir';
  expect(child.params().parentId).toBe('root');
  expect(child.params().settings).toMatchObject({ model: 'exact-model', cwd: 'child-dir' });
  child.values.env = '{invalid';
  expect(() => child.params()).toThrow('env must be a JSON object');
  child.values.env = '[]';
  expect(() => child.params()).toThrow('env must be a JSON object');
  child.values.env = '{"key":2}';
  expect(() => child.params()).toThrow('env values must be strings');
  const record = agent('root', null, { revision: 7, metadata: { kept: true }, settings: { harness: 'fixture', model: 'm', env: { SECRET: 'value' }, extensions: { plugin: { kept: true } } } });
  const edit = new AgentEditor(null, record);
  expect(() => edit.params()).toThrow('No changes');
  record.revision = 8;
  edit.values.name = 'renamed';
  expect(edit.params()).toEqual({ agentId: 'root', expectedRevision: 7, name: 'renamed' });
  edit.values.env = '{}';
  expect(edit.params().settings).toEqual({ env: {} });
  edit.values.model = '';
  expect(() => edit.params()).toThrow('cannot be blank');
});

test('all lifecycle mutations wait for completion, preserve targets, and refresh even after conflicts/partial failure', async () => {
  const requests: any[] = [];
  let seq = 0;
  let status = 'completed';
  let errorCode = 'CONFLICT';
  let mode = 'wait';
  let current: any;
  const mock = await mockServer((socket, request) => {
    requests.push(request);
    if (request.method === 'organization.snapshot') respond(socket, request.id, { seq, agents: [agent('root')], operations: [] });
    else if (request.method === 'events.history') respond(socket, request.id, { events: [], oldestSeq: 1, latestSeq: seq, expired: false });
    else if (request.method === 'operation.wait') respond(socket, request.id, { ...current, status, ...(status === 'failed' ? { error: { code: errorCode, message: 'Mutation failed' } } : {}) });
    else {
      current = { id: `op-${seq + 1}`, type: request.method, agentId: 'root', status: 'queued', input: request.params };
      if (mode === 'race') send(socket, event(++seq, 'operation.changed', { ...current, status: 'completed' }));
      respond(socket, request.id, current);
    }
  });
  const session = new Session(mock.path);
  const notices: string[] = [];
  session.on('notice', message => notices.push(message));
  const running = session.run();
  try {
    await waitFor(() => session.status === 'connected');
    expect(requests.find(r => r.method === 'organization.snapshot').params).toEqual({ includeTerminalOperations: false });
    const methods: LifecycleMethod[] = ['agent.create', 'agent.modify', 'agent.restart', 'agent.stop', 'agent.restart_subtree', 'agent.replace_session', 'agent.remove'];
    for (const method of methods) {
      const params = method === 'agent.create' ? { parentId: null, settings: { harness: 'fixture' } } : method === 'agent.modify' ? { agentId: 'root', expectedRevision: 7, name: 'new' } : { agentId: 'root' };
      expect((await session.mutate(method, params)).status).toBe('completed');
      expect(requests.filter(r => r.method === method)).toHaveLength(1);
      expect(requests.find(r => r.method === method).params).toEqual(params);
      seq++; // Give each subsequent operation a unique ID.
    }
    expect(requests.filter(r => r.method === 'operation.wait')).toHaveLength(7);
    mode = 'race';
    await session.mutate('agent.restart', { agentId: 'root' });
    expect(requests.filter(r => r.method === 'operation.wait')).toHaveLength(7);
    mode = 'wait'; status = 'failed'; seq++;
    const snapshots = requests.filter(r => r.method === 'organization.snapshot').length;
    await expect(session.mutate('agent.modify', { agentId: 'root', expectedRevision: 7, name: 'stale' })).rejects.toThrow('CONFLICT');
    expect(notices.some(n => n.includes('agent.modify failed'))).toBe(true);
    await waitFor(() => requests.filter(r => r.method === 'organization.snapshot').length > snapshots);
    expect(requests.filter(r => r.method === 'agent.modify')).toHaveLength(2); // No conflict retry.
    expect(requests.filter(r => r.method === 'organization.snapshot').every(r => r.params.includeTerminalOperations === false)).toBe(true);
    seq++; errorCode = 'START_FAILED';
    const beforePartial = requests.filter(r => r.method === 'organization.snapshot').length;
    await expect(session.mutate('agent.restart_subtree', { agentId: 'root' })).rejects.toThrow('START_FAILED');
    await waitFor(() => requests.filter(r => r.method === 'organization.snapshot').length > beforePartial);
    seq++; status = 'stopped';
    await expect(session.mutate('agent.stop', { agentId: 'root' })).rejects.toThrow('stopped');
  } finally { session.close(); await running; await mock.close(); }
});

test('disconnect during accepted lifecycle work reports unknown outcome and never resubmits after reconnect', async () => {
  let mutations = 0;
  let connections = 0;
  const mock = await mockServer((socket, request) => {
    if (request.method === 'organization.snapshot') respond(socket, request.id, { seq: 0, agents: [agent('root')], operations: [] });
    else if (request.method === 'agent.remove') { mutations++; respond(socket, request.id, { id: 'remove', type: request.method, agentId: 'root', status: 'queued', input: request.params }); }
    else if (request.method === 'operation.wait') socket.destroy();
  }, () => { connections++; });
  const session = new Session(mock.path);
  await expect(session.mutate('agent.restart', { agentId: 'root' })).rejects.toThrow('not connected');
  const running = session.run();
  try {
    await waitFor(() => session.status === 'connected');
    await expect(session.mutate('agent.remove', { agentId: 'root' })).rejects.toThrow('outcome unknown');
    await waitFor(() => connections > 1 && session.status === 'connected');
    expect(mutations).toBe(1);
  } finally { session.close(); await running; await mock.close(); }
});
