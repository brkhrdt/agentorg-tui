import { expect, test } from 'bun:test';
import { Session } from '../src/session.js';
import { agent, mockServer, respond, send, waitFor } from './helpers.js';

test('skills catalog discovery is capability-gated, refreshable and independent of selection mutations', async () => {
  let enabled = true;
  const requests: any[] = [];
  const skills = [{ name: 'alpha', description: 'Alpha skill', gitUrl: 'https://github.com/org/alpha' }];
  const root = agent('root', null, { settings: { harness: 'fixture', model: 'test', extensions: { managed: { alpha: 'available' }, other: { retained: true } } } });
  const mock = await mockServer((socket, request) => {
    requests.push(request);
    if (request.method === 'organization.snapshot') respond(socket, request.id, { seq: 0, agents: [root], operations: [], capabilities: { plugins: enabled ? { skills: { settingsNamespace: 'managed', endpoints: { list: 'feature.catalog', add: 'feature.add' } } } : {} } });
    else if (request.method === 'feature.catalog') respond(socket, request.id, { skills });
  });
  const session = new Session(mock.path);
  const running = session.run();
  try {
    await waitFor(() => session.status === 'connected');
    expect(session.skillsEnabled).toBe(true);
    expect(session.skillCatalog[0]?.name).toBe('alpha');
    expect(session.store.agents.get('root')?.settings.extensions?.managed).toEqual({ alpha: 'available' });
    expect(requests.some(r => r.method === 'feature.add' || r.method === 'agent.modify')).toBe(false);
    enabled = false;
    for (const socket of mock.sockets) socket.destroy();
    await waitFor(() => session.status === 'connected' && !session.skillsEnabled);
    expect(session.skillCatalog).toEqual([]);
    expect(requests.some(r => r.method === 'feature.add' || r.method === 'agent.modify')).toBe(false);
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
    else send(socket, { kind: 'response', id: request.id, ok: false, error: { code: 'METHOD_NOT_FOUND', message: 'unexpected request' } });
  });
  const session = new Session(mock.path);
  const running = session.run();
  try {
    await waitFor(() => session.status === 'connected' && session.skillCatalog.length === 1 && !!session.serverSettingsCapability);
    await session.loadServerSettings();
    expect(session.serverSettingsCatalog?.groups.map(group => group.namespace)).toEqual(['skills']);
    expect(session.store.agents.get('root')?.settings.extensions?.managed).toEqual({ alpha: 'available' });
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
