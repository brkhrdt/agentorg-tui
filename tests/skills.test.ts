import { expect, test } from 'bun:test';
import { Session } from '../src/session.js';
import { agent, mockServer, respond, send, waitFor } from './helpers.js';

function registrationRecord(name: string) {
  return { name, description: 'Local repository', path: `/managed/${name}`, createdAt: '2025-01-01T00:00:00.000Z', origin: 'manual',
    source: { kind: 'local', path: '/srv/skill' }, history: { mode: 'git-preserved', scope: 'branches-tags-head-v1', selectedCommit: 'a'.repeat(40) } };
}

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

test('unified repository registration requires the exact capability, sends only source once, and refreshes catalog', async () => {
  const requests: any[] = [];
  let added = false;
  const mock = await mockServer((socket, request) => {
    requests.push(request);
    if (request.method === 'organization.snapshot') respond(socket, request.id, { seq: 0, agents: [agent('root')], operations: [], capabilities: { cwd: '/srv', plugins: { skills: { version: 1, settingsNamespace: 'managed', repositoryRegistration: { version: 1, sourceKinds: ['https', 'server-path'], history: 'preserve-v1' }, endpoints: { list: 'skills.list', registerRepository: 'skills.registerRepository' } } } } });
    else if (request.method === 'skills.list') respond(socket, request.id, { skills: added ? [{ name: 'local-tool', description: 'Local' }] : [] });
    else if (request.method === 'skills.registerRepository') { added = true; respond(socket, request.id, registrationRecord('local-tool')); }
    else send(socket, { kind: 'response', id: request.id, ok: false, error: { code: 'METHOD_NOT_FOUND', message: request.method } });
  });
  const session = new Session(mock.path);
  const running = session.run();
  try {
    await waitFor(() => session.status === 'connected' && session.skillsEnabled);
    expect(session.skillRepositoryRegistrationAvailable).toBe(true);
    await session.registerSkillRepository('/srv/my local skill/SKILL.md');
    expect(requests.filter(r => r.method === 'skills.registerRepository').map(r => r.params)).toEqual([{ source: '/srv/my local skill/SKILL.md' }]);
    expect(session.skillCatalog.map(skill => skill.name)).toEqual(['local-tool']);
    expect(requests.filter(r => r.method === 'skills.registerRepository')).toHaveLength(1);
  } finally { session.close(); await running; await mock.close(); }
});

test('malformed successful registrations are unknown outcomes and never retried', async () => {
  const requests: any[] = [];
  const mock = await mockServer((socket, request) => {
    requests.push(request);
    if (request.method === 'organization.snapshot') respond(socket, request.id, { seq: 0, agents: [agent('root')], operations: [], capabilities: { plugins: { skills: { version: 1, settingsNamespace: 'managed', repositoryRegistration: { version: 1, sourceKinds: ['https', 'server-path'], history: 'preserve-v1' }, endpoints: { list: 'skills.list', registerRepository: 'skills.registerRepository' } } } } });
    else if (request.method === 'skills.list') respond(socket, request.id, { skills: [] });
    else if (request.method === 'skills.registerRepository') respond(socket, request.id, null);
  });
  const session = new Session(mock.path);
  const running = session.run();
  try {
    await waitFor(() => session.status === 'connected' && session.skillsEnabled);
    await expect(session.registerSkillRepository('/skill')).rejects.toThrow(/outcome is unknown.*Do not retry/i);
    expect(requests.filter(r => r.method === 'skills.registerRepository')).toHaveLength(1);
    expect(requests.filter(r => r.method === 'skills.list')).toHaveLength(1);
  } finally { session.close(); await running; await mock.close(); }
});

test('invalid explicit post-registration catalog refresh rejects as registered-but-refresh-failed', async () => {
  const requests: any[] = [];
  let added = false;
  const mock = await mockServer((socket, request) => {
    requests.push(request);
    if (request.method === 'organization.snapshot') respond(socket, request.id, { seq: 0, agents: [agent('root')], operations: [], capabilities: { plugins: { skills: { version: 1, settingsNamespace: 'managed', repositoryRegistration: { version: 1, sourceKinds: ['https', 'server-path'], history: 'preserve-v1' }, endpoints: { list: 'skills.list', registerRepository: 'skills.registerRepository' } } } } });
    else if (request.method === 'skills.list') respond(socket, request.id, added ? { skills: null } : { skills: [] });
    else if (request.method === 'skills.registerRepository') { added = true; respond(socket, request.id, registrationRecord('local-skill')); }
  });
  const session = new Session(mock.path);
  const running = session.run();
  try {
    await waitFor(() => session.status === 'connected' && session.skillsEnabled);
    const result = await session.registerSkillRepository('/skill');
    expect(result.refreshed).toBe(false);
    expect(result.refreshError).toMatch(/Invalid skills catalog response/i);
    expect(requests.filter(r => r.method === 'skills.registerRepository')).toHaveLength(1);
    expect(requests.filter(r => r.method === 'skills.list')).toHaveLength(2);
  } finally { session.close(); await running; await mock.close(); }
});

test('strict explicit catalog refresh rejects malformed catalogs', async () => {
  let reads = 0;
  const mock = await mockServer((socket, request) => {
    if (request.method === 'organization.snapshot') respond(socket, request.id, { seq: 0, agents: [agent('root')], operations: [], capabilities: { plugins: { skills: { version: 1, settingsNamespace: 'managed', endpoints: { list: 'skills.list' } } } } });
    else if (request.method === 'skills.list') respond(socket, request.id, ++reads === 1 ? { skills: [] } : { skills: null });
  });
  const session = new Session(mock.path);
  const running = session.run();
  try {
    await waitFor(() => session.status === 'connected' && session.skillsEnabled);
    await expect(session.refreshSkills(true)).rejects.toThrow(/Invalid skills catalog response/);
  } finally { session.close(); await running; await mock.close(); }
});

test('superseded post-registration catalog refresh cannot report success', async () => {
  const requests: any[] = [];
  let catalogReads = 0;
  let staleRead: { socket: any; id: string } | undefined;
  const mock = await mockServer((socket, request) => {
    requests.push(request);
    if (request.method === 'organization.snapshot') respond(socket, request.id, { seq: 0, agents: [agent('root')], operations: [], capabilities: { plugins: { skills: { version: 1, settingsNamespace: 'managed', repositoryRegistration: { version: 1, sourceKinds: ['https', 'server-path'], history: 'preserve-v1' }, endpoints: { list: 'skills.list', registerRepository: 'skills.registerRepository' } } } } });
    else if (request.method === 'skills.list') {
      catalogReads++;
      if (catalogReads === 2) staleRead = { socket, id: request.id };
      else respond(socket, request.id, { skills: [{ name: 'fresh-skill', description: 'Fresh catalog' }] });
    }
    else if (request.method === 'skills.registerRepository') respond(socket, request.id, registrationRecord('fresh-skill'));
  });
  const session = new Session(mock.path);
  const running = session.run();
  try {
    await waitFor(() => session.status === 'connected' && session.skillsEnabled);
    const importing = session.registerSkillRepository('/skill');
    await waitFor(() => !!staleRead);
    await session.refreshSkills();
    respond(staleRead!.socket, staleRead!.id, { skills: [{ name: 'stale-skill', description: 'Stale response' }] });
    const result = await importing;
    expect(result.refreshed).toBe(false);
    expect(result.refreshError).toMatch(/Skills catalog refresh was superseded/i);
    expect(session.skillCatalog.map(skill => skill.name)).toEqual(['fresh-skill']);
    expect(requests.filter(r => r.method === 'skills.registerRepository')).toHaveLength(1);
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

test('repository registration fails closed when its advertised capability is revoked or malformed', async () => {
  const requests: any[] = [];
  let snapshots = 0;
  const mock = await mockServer((socket, request) => {
    requests.push(request);
    if (request.method === 'organization.snapshot') {
      snapshots++;
      const registration = { version: 1, sourceKinds: ['https', 'server-path'], history: snapshots === 1 ? 'preserve-v1' : 'history-dropped' };
      respond(socket, request.id, { seq: 0, agents: [agent('root')], operations: [], capabilities: { plugins: { skills: { version: 1, settingsNamespace: 'managed', repositoryRegistration: registration, endpoints: { list: 'skills.list', registerRepository: 'skills.registerRepository' } } } } });
    } else if (request.method === 'skills.list') respond(socket, request.id, { skills: [] });
    else if (request.method === 'skills.registerRepository') respond(socket, request.id, { name: 'should-not-register' });
  });
  const session = new Session(mock.path);
  const running = session.run();
  try {
    await waitFor(() => session.status === 'connected' && session.skillRepositoryRegistrationAvailable);
    await expect(session.registerSkillRepository('/srv/skill')).rejects.toThrow(/no longer supported/i);
    expect(requests.filter(r => r.method === 'skills.registerRepository')).toHaveLength(0);
  } finally { session.close(); await running; await mock.close(); }
});

test('catalog retirement does not dispatch after management capability is revoked during preflight', async () => {
  const requests: any[] = [];
  let snapshots = 0;
  let preflight: { socket: any; id: string } | undefined;
  const capability = { version: 1, settingsNamespace: 'managed', catalogManagement: { version: 1, semantics: 'reversible-retirement-v1', sourceIdentity: 'name+source-v1' },
    repositoryRegistration: { version: 1, sourceKinds: ['https'], history: 'preserve-v1' }, endpoints: { list: 'skills.list', retireRepository: 'skills.retireRepository', restoreRepository: 'skills.restoreRepository', registerRepository: 'skills.registerRepository' } };
  const skill = { name: 'alpha', description: 'Alpha', source: { kind: 'git', gitUrl: 'https://github.com/org/alpha' }, status: 'ready' };
  const mock = await mockServer((socket, request) => {
    requests.push(request);
    if (request.method === 'organization.snapshot') {
      snapshots++;
      if (snapshots === 2) preflight = { socket, id: request.id };
      else respond(socket, request.id, { seq: 0, agents: [agent('root')], operations: [], capabilities: { plugins: { skills: capability } } });
    } else if (request.method === 'skills.list') respond(socket, request.id, { skills: [skill], managed: [skill] });
    else if (request.method === 'skills.retireRepository' || request.method === 'skills.restoreRepository') respond(socket, request.id, { skill, status: 'retired' });
  });
  const session = new Session(mock.path);
  const running = session.run();
  try {
    await waitFor(() => session.status === 'connected' && session.skillCatalogManagementAvailable);
    const retiring = session.updateSkillCatalogRetirement(skill as any, true);
    await waitFor(() => !!preflight);
    (session as any).skillCatalogManagement = undefined;
    respond(preflight!.socket, preflight!.id, { seq: 0, agents: [agent('root')], operations: [], capabilities: { plugins: { skills: capability } } });
    await expect(retiring).rejects.toThrow(/capability is no longer supported/i);
    expect(requests.filter(request => request.method === 'skills.retireRepository' || request.method === 'skills.restoreRepository')).toHaveLength(0);
  } finally { session.close(); await running; await mock.close(); }
});

test('catalog retirement works with management capability and no repository-registration capability', async () => {
  const requests: any[] = [];
  let catalogStatus: 'ready' | 'retired' = 'ready';
  const capability = { version: 1, settingsNamespace: 'managed', catalogManagement: { version: 1, semantics: 'reversible-retirement-v1', sourceIdentity: 'name+source-v1' },
    endpoints: { list: 'skills.list', retireRepository: 'skills.retireRepository', restoreRepository: 'skills.restoreRepository' } };
  const skill = { name: 'alpha', description: 'Alpha', source: { kind: 'git', gitUrl: 'https://github.com/org/alpha' } };
  const mock = await mockServer((socket, request) => {
    requests.push(request);
    if (request.method === 'organization.snapshot') respond(socket, request.id, { seq: 0, agents: [agent('root')], operations: [], capabilities: { plugins: { skills: capability } } });
    else if (request.method === 'skills.list') respond(socket, request.id, {
      skills: catalogStatus === 'ready' ? [skill] : [], managed: [{ ...skill, status: catalogStatus }],
    });
    else if (request.method === 'skills.retireRepository' || request.method === 'skills.restoreRepository') {
      catalogStatus = request.method === 'skills.retireRepository' ? 'retired' : 'ready';
      respond(socket, request.id, { skill, status: catalogStatus });
    }
  });
  const session = new Session(mock.path);
  const running = session.run();
  try {
    await waitFor(() => session.status === 'connected' && session.skillCatalogManagementAvailable);
    expect(session.skillRepositoryRegistrationAvailable).toBe(false);
    await session.updateSkillCatalogRetirement(session.managedSkillCatalog[0]!, true);
    await session.updateSkillCatalogRetirement(session.managedSkillCatalog[0]!, false);
    expect(requests.filter(request => request.method === 'skills.retireRepository' || request.method === 'skills.restoreRepository').map(request => request.method))
      .toEqual(['skills.retireRepository', 'skills.restoreRepository']);
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
