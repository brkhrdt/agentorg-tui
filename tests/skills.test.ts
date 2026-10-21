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

test('local skill import requires exact advertised capability, sends only path once, and refreshes catalog', async () => {
  const requests: any[] = [];
  let added = false;
  const mock = await mockServer((socket, request) => {
    requests.push(request);
    if (request.method === 'organization.snapshot') respond(socket, request.id, { seq: 0, agents: [agent('root')], operations: [], capabilities: { cwd: '/srv' , plugins: { skills: { version: 1, settingsNamespace: 'managed', localImport: true, endpoints: { list: 'skills.list', addFromPath: 'skills.addFromPath' } } } } });
    else if (request.method === 'skills.list') respond(socket, request.id, { skills: added ? [{ name: 'local-tool', description: 'Local' }] : [] });
    else if (request.method === 'skills.addFromPath') { added = true; respond(socket, request.id, { name: 'local-tool' }); }
    else send(socket, { kind: 'response', id: request.id, ok: false, error: { code: 'METHOD_NOT_FOUND', message: request.method } });
  });
  const session = new Session(mock.path);
  const running = session.run();
  try {
    await waitFor(() => session.status === 'connected' && session.skillsEnabled);
    expect(session.localSkillImportAvailable).toBe(true);
    await session.importLocalSkill('/srv/my local skill/SKILL.md');
    expect(requests.filter(r => r.method === 'skills.addFromPath').map(r => r.params)).toEqual([{ path: '/srv/my local skill/SKILL.md' }]);
    expect(session.skillCatalog.map(skill => skill.name)).toEqual(['local-tool']);
    expect(requests.filter(r => r.method === 'skills.addFromPath')).toHaveLength(1);
  } finally { session.close(); await running; await mock.close(); }
});

test('malformed successful addFromPath responses are unknown outcomes and never retried', async () => {
  const requests: any[] = [];
  const mock = await mockServer((socket, request) => {
    requests.push(request);
    if (request.method === 'organization.snapshot') respond(socket, request.id, { seq: 0, agents: [agent('root')], operations: [], capabilities: { plugins: { skills: { version: 1, settingsNamespace: 'managed', localImport: true, endpoints: { list: 'skills.list', addFromPath: 'skills.addFromPath' } } } } });
    else if (request.method === 'skills.list') respond(socket, request.id, { skills: [] });
    else if (request.method === 'skills.addFromPath') respond(socket, request.id, null);
  });
  const session = new Session(mock.path);
  const running = session.run();
  try {
    await waitFor(() => session.status === 'connected' && session.skillsEnabled);
    await expect(session.importLocalSkill('/skill')).rejects.toThrow(/outcome is unknown.*Do not retry/i);
    expect(requests.filter(r => r.method === 'skills.addFromPath')).toHaveLength(1);
    expect(requests.filter(r => r.method === 'skills.list')).toHaveLength(1);
  } finally { session.close(); await running; await mock.close(); }
});

test('invalid explicit post-registration catalog refresh rejects as registered-but-refresh-failed', async () => {
  const requests: any[] = [];
  let added = false;
  const mock = await mockServer((socket, request) => {
    requests.push(request);
    if (request.method === 'organization.snapshot') respond(socket, request.id, { seq: 0, agents: [agent('root')], operations: [], capabilities: { plugins: { skills: { version: 1, settingsNamespace: 'managed', localImport: true, endpoints: { list: 'skills.list', addFromPath: 'skills.addFromPath' } } } } });
    else if (request.method === 'skills.list') respond(socket, request.id, added ? { skills: null } : { skills: [] });
    else if (request.method === 'skills.addFromPath') { added = true; respond(socket, request.id, { name: 'local-skill' }); }
  });
  const session = new Session(mock.path);
  const running = session.run();
  try {
    await waitFor(() => session.status === 'connected' && session.skillsEnabled);
    await expect(session.importLocalSkill('/skill')).rejects.toThrow(/Skill registered, but catalog refresh failed: Invalid skills catalog response/i);
    expect(requests.filter(r => r.method === 'skills.addFromPath')).toHaveLength(1);
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
    if (request.method === 'organization.snapshot') respond(socket, request.id, { seq: 0, agents: [agent('root')], operations: [], capabilities: { plugins: { skills: { version: 1, settingsNamespace: 'managed', localImport: true, endpoints: { list: 'skills.list', addFromPath: 'skills.addFromPath' } } } } });
    else if (request.method === 'skills.list') {
      catalogReads++;
      if (catalogReads === 2) staleRead = { socket, id: request.id };
      else respond(socket, request.id, { skills: [{ name: 'fresh-skill', description: 'Fresh catalog' }] });
    }
    else if (request.method === 'skills.addFromPath') respond(socket, request.id, { name: 'fresh-skill' });
  });
  const session = new Session(mock.path);
  const running = session.run();
  try {
    await waitFor(() => session.status === 'connected' && session.skillsEnabled);
    const importing = session.importLocalSkill('/skill');
    await waitFor(() => !!staleRead);
    await session.refreshSkills();
    respond(staleRead!.socket, staleRead!.id, { skills: [{ name: 'stale-skill', description: 'Stale response' }] });
    await expect(importing).rejects.toThrow(/registered, but catalog refresh failed: Skills catalog refresh was superseded/i);
    expect(session.skillCatalog.map(skill => skill.name)).toEqual(['fresh-skill']);
    expect(requests.filter(r => r.method === 'skills.addFromPath')).toHaveLength(1);
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
