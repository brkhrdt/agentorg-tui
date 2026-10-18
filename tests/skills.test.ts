import { expect, test } from 'bun:test';
import { Session } from '../src/session.js';
import { agent, mockServer, respond, send, waitFor } from './helpers.js';

test('skills capability, catalog, replacement mutation with revision and catalog add are optional and never retried', async () => {
  let enabled = true;
  const requests: any[] = [];
  const skills = [{ name: 'alpha', description: 'Alpha skill', gitUrl: 'https://github.com/org/alpha' }];
  const root = agent('root', null, { settings: { harness: 'fixture', model: 'test', extensions: { managed: { alpha: 'available' }, other: { retained: true } } } });
  const mock = await mockServer((socket, request) => {
    requests.push(request);
    if (request.method === 'organization.snapshot') respond(socket, request.id, { seq: 0, agents: [root], operations: [], capabilities: { plugins: enabled ? { skills: { settingsNamespace: 'managed', endpoints: { list: 'feature.catalog', add: 'feature.add' } } } : {} } });
    else if (request.method === 'feature.catalog') respond(socket, request.id, { skills });
    else if (request.method === 'feature.add') { skills.push({ ...request.params, description: 'new' }); respond(socket, request.id, skills.at(-1)); }
    else if (request.method === 'agent.modify') respond(socket, request.id, { id: 'change', type: 'agent.modify', agentId: 'root', input: request.params, status: 'queued' });
    else if (request.method === 'operation.wait') respond(socket, request.id, { id: 'change', type: 'agent.modify', agentId: 'root', input: {}, status: 'completed' });
  });
  const session = new Session(mock.path);
  const running = session.run();
  try {
    await waitFor(() => session.status === 'connected');
    expect(session.skillsEnabled).toBe(true);
    expect(session.skills[0]?.name).toBe('alpha');
    expect(session.skillStates('root')).toEqual({ alpha: 'available' });
    await session.setSkills('root', 7, { alpha: 'installed' });
    expect(requests.find(r => r.method === 'agent.modify').params).toEqual({ agentId: 'root', expectedRevision: 7, settings: { extensions: { managed: { alpha: 'installed' } } } });
    expect(requests.filter(r => r.method === 'agent.modify')).toHaveLength(1);
    await session.addSkill('beta', 'https://github.com/org/beta');
    await waitFor(() => session.skills.length === 2);
    enabled = false;
    for (const socket of mock.sockets) socket.destroy();
    await waitFor(() => session.status === 'connected' && !session.skillsEnabled);
    expect(session.skills).toEqual([]);
    await expect(session.setSkills('root', 8, {})).rejects.toThrow('not connected');
  } finally { session.close(); await running; await mock.close(); }
});

test('organization skills settings and per-agent skill selections remain separate namespaces', async () => {
  const requests: any[] = [];
  const mock = await mockServer((socket, request) => {
    requests.push(request);
    if (request.method === 'organization.snapshot') respond(socket, request.id, {
      seq: 0, agents: [agent('root', null, { settings: { harness: 'fixture', model: 'test', extensions: { managed: { alpha: 'available' }, sibling: { keep: true } } } })], operations: [],
      capabilities: {
        serverSettings: { version: 1, endpoints: { list: 'organization.settings.list', get: 'organization.settings.get', update: 'organization.settings.update' } },
        plugins: { skills: { settingsNamespace: 'managed', endpoints: { list: 'feature.catalog', add: 'feature.add' } } },
      },
    });
    else if (request.method === 'organization.settings.list') respond(socket, request.id, { facts: { cwd: '.', dataDir: '.', socketPath: '.', harnesses: [], plugins: [] }, groups: [{ namespace: 'skills', title: 'Skills', version: 1, fields: [], revision: 4, defaults: {}, values: { repositories: [] }, effective: { repositories: [] }, overridden: [], restartRequired: [] }] });
    else if (request.method === 'feature.catalog') respond(socket, request.id, { skills: [{ name: 'alpha', description: 'Alpha' }] });
    else if (request.method === 'agent.modify') respond(socket, request.id, { id: 'change', type: 'agent.modify', agentId: 'root', input: request.params, status: 'queued' });
    else if (request.method === 'operation.wait') respond(socket, request.id, { id: 'change', type: 'agent.modify', agentId: 'root', input: {}, status: 'completed' });
    else send(socket, { kind: 'response', id: request.id, ok: false, error: { code: 'METHOD_NOT_FOUND', message: 'unexpected request' } });
  });
  const session = new Session(mock.path);
  const running = session.run();
  try {
    await waitFor(() => session.status === 'connected' && session.skills.length === 1 && !!session.serverSettingsCapability);
    await session.loadServerSettings();
    expect(session.serverSettingsCatalog?.groups.map(group => group.namespace)).toEqual(['skills']);
    expect(session.skillStates('root')).toEqual({ alpha: 'available' });
    await session.setSkills('root', 9, { alpha: 'installed' });
    expect(requests.find(request => request.method === 'agent.modify').params).toEqual({
      agentId: 'root', expectedRevision: 9, settings: { extensions: { managed: { alpha: 'installed' } } },
    });
    expect(requests.some(request => request.method === 'organization.settings.update')).toBe(false);
  } finally { session.close(); await running; await mock.close(); }
});

test('old server snapshots do not call unavailable skills endpoints', async () => {
  const requests: string[] = [];
  const mock = await mockServer((socket, request) => {
    requests.push(request.method);
    if (request.method === 'organization.snapshot') respond(socket, request.id, { seq: 0, agents: [agent('root')], operations: [] });
    else send(socket, { kind: 'response', id: request.id, ok: false, error: { code: 'METHOD_NOT_FOUND', message: 'old server' } });
  });
  const session = new Session(mock.path);
  const running = session.run();
  try {
    await waitFor(() => session.status === 'connected');
    expect(session.skillsEnabled).toBe(false);
    expect(requests).toEqual(['organization.snapshot']);
  } finally { session.close(); await running; await mock.close(); }
});
