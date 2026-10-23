import { expect, test } from 'bun:test';
import { agent, event, mockServer, operation, respond, send, waitFor } from './helpers.js';
import { terminalClient } from './terminal.js';
import { formatSkillDetails } from '../src/ui.js';
import type { ServerSettingsCatalog, ServerSettingsGroup, Skill } from '../src/protocol.js';

const skills = [
  { name: 'alpha', description: 'Alpha instructions', gitUrl: 'https://github.com/org/alpha', source: { kind: 'git' as const, gitUrl: 'https://github.com/org/alpha' }, path: '/managed/alpha', createdAt: 'now', history: { mode: 'git-preserved', scope: 'branches-tags-head-v1', selectedCommit: 'a'.repeat(40) } },
  { name: 'beta', description: 'Beta instructions', gitUrl: 'https://github.com/org/beta', source: { kind: 'git' as const, gitUrl: 'https://github.com/org/beta' }, path: '/managed/beta', createdAt: 'now', history: { mode: 'git-preserved', scope: 'branches-tags-head-v1', selectedCommit: 'b'.repeat(40) } },
];
const endpoints = { list: 'organization.settings.list', get: 'organization.settings.get', update: 'organization.settings.update' };
const repositoryGroup = (repositories: Array<{ name: string; gitUrl: string }> = []): ServerSettingsGroup => ({
  namespace: 'skills', plugin: 'skills', title: 'Skills', version: 1, revision: 3,
  fields: [{
    key: 'repositories', label: 'Repositories', editor: 'list', effect: 'immediate',
    itemIdKey: 'name', itemLabelKey: 'name', itemDefaults: { name: '', gitUrl: '' },
    itemFields: [
      { key: 'name', label: 'Skill name', editor: 'text', effect: 'immediate' },
      { key: 'gitUrl', label: 'HTTPS Git URL', editor: 'text', effect: 'immediate' },
    ],
  }, { key: 'gitTimeoutMs', label: 'Git timeout', editor: 'number', min: 1000, max: 60000, effect: 'immediate' }, { key: 'maxCatalogEntries', label: 'Maximum catalog entries', editor: 'number', min: 1, max: 256, effect: 'immediate' }],
  defaults: { repositories: [], gitTimeoutMs: 60000, maxCatalogEntries: 256 }, values: { repositories, gitTimeoutMs: 60000, maxCatalogEntries: 256 }, effective: { repositories, gitTimeoutMs: 60000, maxCatalogEntries: 256 }, overridden: [], restartRequired: [],
});

async function fixture({ withSettings = false, missingSettingsGroup = false, noAgents = false, localImport = false, wrongImportEndpoint = false, pathCompletion = false, holdLocalImport = false, holdCatalogRefresh = false, holdCatalogStatusChange = false, malformedLocalImport = false, malformedHeldCatalog = false, skillCatalog = skills as Skill[], repositories = [], skillReconciliation, modifyOutcome = 'ok', cols = 120 }: { withSettings?: boolean; missingSettingsGroup?: boolean; noAgents?: boolean; localImport?: boolean; wrongImportEndpoint?: boolean; pathCompletion?: boolean; holdLocalImport?: boolean; holdCatalogRefresh?: boolean; holdCatalogStatusChange?: boolean; malformedLocalImport?: boolean; malformedHeldCatalog?: boolean; skillCatalog?: Skill[]; repositories?: Array<{ name: string; gitUrl: string }>; skillReconciliation?: any; modifyOutcome?: 'ok' | 'conflict' | 'failed' | 'disconnect'; cols?: number } = {}) {
  const root = agent('root', null, { name: 'worker', revision: 8, settings: {
    harness: 'fixture', model: 'test', extensions: { managed: { alpha: 'installed' }, sibling: { retained: true } },
  } });
  const group = repositoryGroup(repositories);
  if (skillReconciliation) group.reconciliation = skillReconciliation;
  let currentSkillCatalog = skillCatalog;
  let currentManagedCatalog: Array<Skill & { status: 'ready' | 'retired' }> = skillCatalog.map(skill => ({ ...skill, status: 'ready' as const }));
  const serverSettings: ServerSettingsCatalog = { groups: missingSettingsGroup ? [] : [group], facts: { cwd: '/work', dataDir: '/data', socketPath: '/socket', harnesses: ['fixture'], plugins: ['skills'] } };
  const requests: any[] = [], changes: any[] = [];
  let connections = 0, skillsListCalls = 0;
  let heldLocalImport: { socket: any; id: string } | undefined;
  let heldCatalogRefresh: { socket: any; id: string } | undefined;
  let heldCatalogStatusChange: { socket: any; id: string; method: string; params: any } | undefined;
  const mock = await mockServer((socket, request) => {
    requests.push(request);
    if (request.method === 'organization.snapshot') respond(socket, request.id, { seq: 0, agents: noAgents ? [] : [root], operations: [], capabilities: {
      harnesses: ['fixture'],
      ...(pathCompletion && { cwd: '/server/cwd', pathCompletion: true }),
      plugins: { skills: { version: 1, settingsNamespace: 'managed', catalogManagement: { version: 1, semantics: 'reversible-retirement-v1', sourceIdentity: 'name+source-v1' }, ...(localImport && { localImport: true, localImportHistory: 'preserve-v1', repositoryRegistration: { version: 1, sourceKinds: ['https', 'server-path'], history: 'preserve-v1' } }), endpoints: { list: 'skills.list', add: 'skills.add', retireRepository: 'skills.retireRepository', restoreRepository: 'skills.restoreRepository', deleteRepository: 'skills.deleteRepository', ...(localImport && { addFromPath: 'skills.addFromPath', registerRepository: wrongImportEndpoint ? 'skills.register.alias' : 'skills.registerRepository' }), reconcile: 'skills.reconcile' } } },
      ...(withSettings && { serverSettings: { version: 1, groups: [group], endpoints } }),
    } });
    else if (request.method === 'organization.paths') respond(socket, request.id, { path: request.params.input, isDirectory: true, entries: [{ name: 'stale-path-suggestion', path: '/server/cwd/stale-path-suggestion', kind: 'directory' }] });
    else if (request.method === 'skills.list') {
      skillsListCalls++;
      if (holdCatalogRefresh && skillsListCalls > 1 && !heldCatalogRefresh) heldCatalogRefresh = { socket, id: request.id };
      else respond(socket, request.id, { skills: currentSkillCatalog, managed: currentManagedCatalog, ...(skillReconciliation && { reconciliation: skillReconciliation }) });
    }
    else if (request.method === 'skills.registerRepository') {
      if (holdLocalImport) heldLocalImport = { socket, id: request.id };
      else if (malformedLocalImport) respond(socket, request.id, null);
      else { currentSkillCatalog = skills; const record = { ...skills[0], source: { kind: 'local' as const, path: '/tmp/skill' }, path: '/managed/alpha', createdAt: 'now', origin: 'manual', history: { mode: 'directory-initialized', selectedCommit: 'a'.repeat(40) } }; currentManagedCatalog = [{ ...record, status: 'ready' }]; respond(socket, request.id, record); }
    }
    else if (request.method === 'skills.retireRepository' || request.method === 'skills.restoreRepository') {
      if (holdCatalogStatusChange && !heldCatalogStatusChange) heldCatalogStatusChange = { socket, id: request.id, method: request.method, params: request.params };
      else {
        const name = request.params.name, status = request.method === 'skills.retireRepository' ? 'retired' : 'ready';
        currentManagedCatalog = currentManagedCatalog.map(skill => skill.name === name ? { ...skill, status } : skill);
        currentSkillCatalog = currentSkillCatalog.filter(skill => skill.name !== name || status === 'ready');
        if (status === 'ready') { const restored = currentManagedCatalog.find(skill => skill.name === name); if (restored) currentSkillCatalog = [...currentSkillCatalog, restored]; }
        respond(socket, request.id, { skill: currentManagedCatalog.find(skill => skill.name === name), status });
      }
    }
    else if (request.method === 'skills.deleteRepository') {
      const name = request.params.name;
      currentManagedCatalog = currentManagedCatalog.filter(skill => skill.name !== name);
      currentSkillCatalog = currentSkillCatalog.filter(skill => skill.name !== name);
      respond(socket, request.id, { name, source: request.params.source, status: 'deleted', removedAssignments: 1, removedInstallations: 1 });
    }
    else if (request.method === 'skills.reconcile') respond(socket, request.id, { accepted: true });
    else if (request.method === endpoints.list) respond(socket, request.id, serverSettings);
    else if (request.method === endpoints.update) {
      changes.push(request.params);
      respond(socket, request.id, { ...group, values: { ...group.values, ...request.params.patch }, revision: group.revision + 1, restartRequired: [], reconciliation: { state: 'pending', desiredRevision: group.revision + 1 } });
    }
    else if (request.method === 'events.history') respond(socket, request.id, { events: [], expired: false, latestSeq: 0, oldestSeq: 1 });
    else if (request.method === 'agent.create') {
      changes.push(request.params);
      respond(socket, request.id, { ...operation('completed'), id: 'create', type: 'agent.create', agentId: 'created' });
    }
    else if (request.method === 'agent.modify') {
      changes.push(request.params);
      if (modifyOutcome === 'conflict') send(socket, { kind: 'response', id: request.id, ok: false, error: { code: 'CONFLICT', message: 'revision conflict in fixture' } });
      else if (modifyOutcome === 'failed') respond(socket, request.id, { ...operation('failed'), id: 'modify', type: 'agent.modify', agentId: 'root', error: { code: 'FAILED', message: 'fixture operation failed' } });
      else respond(socket, request.id, { ...operation(modifyOutcome === 'disconnect' ? 'running' : 'completed'), id: 'modify', type: 'agent.modify', agentId: 'root' });
    }
    else if (request.method === 'operation.wait') {
      if (modifyOutcome === 'disconnect') setTimeout(() => { for (const socket of mock.sockets) socket.destroy(); }, 0);
      else respond(socket, request.id, { ...operation('completed'), id: 'modify', type: 'agent.modify', agentId: 'root', result: root });
    }
    else respond(socket, request.id, { seq: 0, liveOnly: true });
  }, () => { connections++; });
  const ui = terminalClient(mock.path, mock.directory, { cols });
  return { mock, ui, root, requests, changes, group, connections: () => connections,
    releaseLocalImport() { currentSkillCatalog = skills; if (heldLocalImport) { const record = { ...skills[0], source: { kind: 'local' as const, path: '/tmp/local skill' }, path: '/managed/alpha', createdAt: 'now', origin: 'manual', history: { mode: 'directory-initialized', selectedCommit: 'a'.repeat(40) } }; currentManagedCatalog = [{ ...record, status: 'ready' }]; respond(heldLocalImport.socket, heldLocalImport.id, record); } },
    releaseCatalogRefresh() { if (heldCatalogRefresh) respond(heldCatalogRefresh.socket, heldCatalogRefresh.id, { skills: malformedHeldCatalog ? null : currentSkillCatalog }); },
    releaseCatalogStatusChange() {
      const pending = heldCatalogStatusChange;
      if (!pending) return;
      const name = pending.params.name, status = pending.method === 'skills.retireRepository' ? 'retired' : 'ready';
      currentManagedCatalog = currentManagedCatalog.map(skill => skill.name === name ? { ...skill, status } : skill);
      currentSkillCatalog = currentSkillCatalog.filter(skill => skill.name !== name || status === 'ready');
      if (status === 'ready') { const restored = currentManagedCatalog.find(skill => skill.name === name); if (restored) currentSkillCatalog = [...currentSkillCatalog, restored]; }
      respond(pending.socket, pending.id, { skill: currentManagedCatalog.find(skill => skill.name === name), status });
    },
    setSkillCatalog(catalog: Skill[]) { currentSkillCatalog = catalog; currentManagedCatalog = catalog.map(skill => ({ ...skill, status: 'ready' as const })); } };
}

test('tree shortcut, action menu, help and footer no longer expose the legacy global Skills screen', async () => {
  const f = await fixture();
  const { keys, visible, screen } = f.ui;
  try {
    await visible('worker');
    expect(screen()).not.toContain('s skills');
    keys('?'); await visible('Keys · tree');
    expect(screen()).not.toContain('Skills');
    keys('\x1b'); await visible('worker');
    const catalogs = f.requests.filter(request => request.method === 'skills.list').length;
    keys('s');
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(screen()).not.toContain('Skills · worker');
    expect(f.requests.filter(request => request.method === 'skills.list')).toHaveLength(catalogs);
    keys('a'); await visible('Agent actions');
    expect(screen()).not.toContain('Skills');
  } finally { await f.ui.close(); await f.mock.close(); }
});

test('v → s → Skills has one source-only Add flow and preserves a dirty runtime-settings draft', async () => {
  const f = await fixture({ withSettings: true, localImport: true, pathCompletion: true, repositories: [{ name: 'legacy-alpha', gitUrl: 'https://git.example/alpha' }] });
  const { keys, visible, screen } = f.ui;
  try {
    await visible('worker'); keys('v'); await visible('CLIENT ONLY'); keys('s'); await visible('Server settings');
    keys('\r'); await visible('Skills · server-wide · revision 3');
    expect(screen()).toContain('Add skill repository…');
    expect(screen()).toContain('Legacy configured seeds: 1');
    expect(screen()).not.toContain('Repositories:');
    expect(screen()).not.toContain('alpha · git-preserved');
    expect(screen()).not.toContain('beta · git-preserved');
    keys('\x1b[B'); await new Promise(resolve => setTimeout(resolve, 40)); keys('\x1b[B\r'); await visible('Git timeout · number'); keys('\x15'); keys('45000\r'); await visible('Git timeout: 45000');
    keys('a'); await visible('Add skill repository · one source locator');
    await waitFor(() => f.requests.some(r => r.method === 'organization.paths'));
    await waitFor(() => screen().includes('stale-path-suggestion/'));
    const pathRequests = f.requests.filter(r => r.method === 'organization.paths').length;
    keys('https://github.com/org/repo'); await new Promise(resolve => setTimeout(resolve, 200));
    expect(f.requests.filter(r => r.method === 'organization.paths')).toHaveLength(pathRequests);
    expect(screen()).not.toContain('stale-path-suggestion');
    keys('\x15'); keys('/srv/my local skill/SKILL.md');
    await waitFor(() => f.requests.filter(r => r.method === 'organization.paths').length > pathRequests);
    keys('\r'); await visible('Confirm skill repository registration');
    expect(screen()).toContain('/srv/my local skill/SKILL.md');
    keys('\x1b[B\r'); await visible('Registered alpha in this organization');
    await visible('Skills · server-wide · revision 3');
    expect(screen()).toContain('Git timeout: 45000');
    expect(screen()).not.toContain('alpha · git-preserved');
    expect(screen()).not.toContain('Last registration confirmed');
    keys('c'); await visible('Skills catalog refreshed; settings draft was not changed.');
    expect(f.requests.filter(r => r.method === 'skills.registerRepository').map(r => r.params)).toEqual([{ source: '/srv/my local skill/SKILL.md' }]);
    expect(f.changes).toHaveLength(0);
    expect(f.requests.filter(r => [endpoints.update, 'skills.reconcile', 'agent.create', 'agent.modify', 'skills.add', 'skills.addFromPath'].includes(r.method))).toHaveLength(0);
  } finally { await f.ui.close(); await f.mock.close(); }
}, 20_000);

test('confirmed registration with failed refresh is inspectable only inside Manage and stays read-only', async () => {
  const f = await fixture({ withSettings: true, localImport: true, skillCatalog: [], holdCatalogRefresh: true, malformedHeldCatalog: true });
  const { keys, visible, screen } = f.ui;
  try {
    await visible('worker'); keys('v'); await visible('CLIENT ONLY'); keys('s'); await visible('Server settings'); keys('\r'); await visible('Skills · server-wide');
    keys('a'); await visible('Add skill repository · one source locator'); keys('/tmp/skill\r'); await visible('Confirm skill repository registration'); keys('y');
    await waitFor(() => f.requests.filter(request => request.method === 'skills.list').length === 2);
    f.releaseCatalogRefresh(); await visible('Registered alpha, but catalog refresh failed');
    expect(screen()).not.toContain('CONFIRMED · alpha');
    keys('\x1b[B'); await new Promise(resolve => setTimeout(resolve, 40)); keys('\r'); await visible('CONFIRMED · alpha · catalog refresh required');
    keys('d'); keys('r'); keys('x'); keys('\r'); await visible('Registered skill repository · alpha');
    expect(screen()).toContain('Source: /tmp/skill');
    expect(screen()).toContain('Managed location: /managed/alpha');
    expect(f.requests.filter(request => ['skills.retireRepository', 'skills.restoreRepository', 'skills.deleteRepository', endpoints.update, 'agent.modify'].includes(request.method))).toHaveLength(0);
    expect(f.requests.filter(request => request.method === 'skills.registerRepository')).toHaveLength(1);
  } finally { await f.ui.close(); await f.mock.close(); }
}, 20_000);

test('catalog Enter opens narrow scrollable details with full source and managed path', async () => {
  const description = Array.from({ length: 45 }, (_, index) => `Detailed instruction paragraph ${index + 1} with enough text to span the narrow terminal display.`).join('\n');
  const skill = { ...skills[0]!, description } as Skill;
  const f = await fixture({ withSettings: true, skillCatalog: [skill], cols: 60 });
  const { keys, visible, screen } = f.ui;
  try {
    await visible('worker'); keys('v'); await visible('CLIENT ONLY'); keys('s'); await visible('Server settings'); keys('\r'); await visible('Skills · server-wide');
    expect(screen()).not.toContain('alpha · git-preserved');
    keys('\x1b[B'); await new Promise(resolve => setTimeout(resolve, 40)); keys('\r'); await visible('READY · alpha');
    keys('\r'); await visible('Registered skill repository · alpha');
    keys('\x1b[4~'); await waitFor(() => screen().includes('Source: https://github.com/org/alpha'));
    const normalizedBottom = screen().replace(/\s+/g, ' ');
    expect(normalizedBottom).toContain('Source: https://github.com/org/alpha');
    expect(normalizedBottom).toContain('Managed location: /managed/alpha');
    keys('\x1b'); await visible('Manage registered catalog skills');
  } finally { await f.ui.close(); await f.mock.close(); }
}, 20_000);

test('repository details strip terminal controls without concealing source or managed location', async () => {
  const esc = String.fromCharCode(27), bel = String.fromCharCode(7);
  const description = `Safe description.\nSecond ordinary line.\n${esc}]0;attacker-controlled title${bel}OSC text\n${esc}[8mCSI conceal remains active`;
  const skill = { ...skills[0]!, description,
    source: { kind: 'git' as const, gitUrl: `https://github.com/org/alpha${esc}[31m` }, path: `/managed/alpha${esc}[0m` } as Skill;
  const formatted = formatSkillDetails(skill);
  expect(formatted).not.toContain(esc);
  expect(formatted).not.toContain(bel);
  expect(formatted).toContain('Description: Safe description.\nSecond ordinary line.\nOSC text\nCSI conceal remains active');
  expect(formatted).toContain('Source: https://github.com/org/alpha\nManaged location: /managed/alpha');
  const f = await fixture({ withSettings: true, skillCatalog: [skill], cols: 60 });
  const { keys, visible, screen } = f.ui;
  try {
    await visible('worker'); keys('v'); await visible('CLIENT ONLY'); keys('s'); await visible('Server settings'); keys('\r'); await visible('Skills · server-wide');
    expect(screen()).not.toContain('alpha · git-preserved');
    keys('\x1b[B'); await new Promise(resolve => setTimeout(resolve, 40)); keys('\r'); await visible('Manage registered catalog skills');
    keys('\r'); await visible('Registered skill repository · alpha');
    const details = screen().replace(/\s+/g, ' ');
    expect(details).toContain('Second ordinary line.');
    expect(details).toContain('CSI conceal remains active');
    expect(details).toContain('Source: https://github.com/org/alpha');
    expect(details).toContain('Managed location: /managed/alpha');
    keys('\x1b'); await visible('Manage registered catalog skills');
  } finally { await f.ui.close(); await f.mock.close(); }
}, 20_000);

test('Skills settings manager retires, restores, and permanently deletes manual catalog skills', async () => {
  const f = await fixture({ withSettings: true, repositories: [{ name: 'legacy-seed', gitUrl: 'https://git.example/seed' }] });
  const { keys, visible, screen } = f.ui;
  try {
    await visible('worker'); keys('v'); await visible('CLIENT ONLY'); keys('s'); await visible('Server settings'); keys('\r'); await visible('Skills · server-wide');
    keys('\x1b[B'); await new Promise(resolve => setTimeout(resolve, 50)); keys('\r'); await visible('Manage registered catalog skills · reversible retirement');
    expect(screen()).toContain('READY · alpha'); expect(screen()).toContain('READY · beta'); expect(screen()).not.toContain('legacy-seed');
    keys('d'); await visible('Retired alpha from new grants');
    expect(screen()).toContain('RETIRED · alpha');
    const retire = f.requests.find(request => request.method === 'skills.retireRepository');
    expect(retire?.params).toEqual({ name: 'alpha', source: skills[0]!.source, expectedStatus: 'ready' });
    expect(f.changes).toHaveLength(0);
    keys('r'); await visible('Restored alpha to the active catalog');
    expect(screen()).toContain('READY · alpha');
    expect(f.requests.find(request => request.method === 'skills.restoreRepository')?.params).toEqual({ name: 'alpha', source: skills[0]!.source, expectedStatus: 'retired' });
    keys('x'); await visible('Confirm permanent deletion · alpha');
    expect(screen()).toContain('plugin-owned installed/recovery copies');
    expect(screen()).toContain('no agent is stopped');
    keys('y'); await visible('Permanently deleted alpha');
    expect(screen()).not.toContain('READY · alpha'); expect(screen()).toContain('READY · beta');
    expect(f.requests.find(request => request.method === 'skills.deleteRepository')?.params).toEqual({ name: 'alpha', source: skills[0]!.source, expectedStatus: 'ready' });
  } finally { await f.ui.close(); await f.mock.close(); }
}, 20_000);

test('stale retirement completion cannot replace notice or selection after manager navigation', async () => {
  const f = await fixture({ withSettings: true, localImport: true, holdCatalogStatusChange: true });
  const { keys, visible, screen } = f.ui;
  try {
    await visible('worker'); keys('v'); await visible('CLIENT ONLY'); keys('s'); await visible('Server settings'); keys('\r'); await visible('Skills · server-wide');
    keys('\x1b[B'); await new Promise(resolve => setTimeout(resolve, 40)); keys('\r'); await visible('Manage registered catalog skills · reversible retirement');
    keys('d'); await waitFor(() => f.requests.some(request => request.method === 'skills.retireRepository'));

    keys('\x1b'); await visible('Skills · server-wide');
    keys('\x1b'); await visible('Server settings');
    keys('\x1b[B'); await new Promise(resolve => setTimeout(resolve, 40)); keys('\r'); await visible('Skills · server-wide');
    keys('\x1b[B'); await new Promise(resolve => setTimeout(resolve, 40)); keys('\r'); await visible('Manage registered catalog skills · reversible retirement');
    keys('\x1b[B'); await new Promise(resolve => setTimeout(resolve, 40)); keys('\r'); await visible('Registered skill repository · beta');
    keys('\x1b'); await visible('Manage registered catalog skills · reversible retirement');
    f.releaseCatalogStatusChange();
    await waitFor(() => f.requests.filter(request => request.method === 'skills.list').length >= 2);
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(screen()).toContain('beta');
    expect(screen()).not.toContain('Retired alpha from new grants.');
    keys('\r'); await visible('Registered skill repository · beta');
  } finally { await f.ui.close(); await f.mock.close(); }
}, 20_000);

test('held retirement preserves a different row selected before completion', async () => {
  const f = await fixture({ withSettings: true, holdCatalogStatusChange: true });
  const { keys, visible } = f.ui;
  try {
    await visible('worker'); keys('v'); await visible('CLIENT ONLY'); keys('s'); await visible('Server settings'); keys('\r'); await visible('Skills · server-wide');
    keys('\x1b[B'); await new Promise(resolve => setTimeout(resolve, 40)); keys('\r'); await visible('Manage registered catalog skills · reversible retirement');
    keys('d'); await waitFor(() => f.requests.some(request => request.method === 'skills.retireRepository'));
    keys('\x1b[B'); await new Promise(resolve => setTimeout(resolve, 50));
    f.releaseCatalogStatusChange();
    await waitFor(() => f.requests.filter(request => request.method === 'skills.list').length >= 2);
    await new Promise(resolve => setTimeout(resolve, 100));
    keys('d');
    await waitFor(() => f.requests.filter(request => request.method === 'skills.retireRepository').length === 2);
    expect(f.requests.filter(request => request.method === 'skills.retireRepository')[1]?.params.name).toBe('beta');
  } finally { await f.ui.close(); await f.mock.close(); }
}, 20_000);

test('unified repository registration is available from Skills settings with no agents', async () => {
  const f = await fixture({ withSettings: true, localImport: true, noAgents: true });
  const { keys, visible, screen } = f.ui;
  try {
    await visible('No active agents'); keys('v'); await visible('CLIENT ONLY'); keys('s'); await visible('Server settings'); keys('\r'); await visible('Skills · server-wide');
    keys('a'); await visible('Add skill repository · one source locator');
    keys('/tmp/orphan skill'); keys('\r'); await visible('Confirm skill repository registration'); keys('\x1b[B\r');
    await visible('Registered alpha in this organization');
    expect(f.requests.filter(r => r.method === 'skills.registerRepository').map(r => r.params)).toEqual([{ source: '/tmp/orphan skill' }]);
    expect(f.requests.filter(r => ['agent.create', 'agent.modify'].includes(r.method))).toHaveLength(0);
    expect(screen()).toContain('Skills · server-wide');
  } finally { await f.ui.close(); await f.mock.close(); }
}, 20_000);

test('in-flight unified registration does not steal focus after Escape navigation', async () => {
  const f = await fixture({ withSettings: true, localImport: true, holdLocalImport: true });
  const { keys, visible, screen } = f.ui;
  try {
    await visible('worker'); keys('v'); await visible('CLIENT ONLY'); keys('s'); await visible('Server settings'); keys('\r'); await visible('Skills · server-wide');
    keys('a'); await visible('Add skill repository · one source locator'); keys('/tmp/local skill'); keys('\r'); await visible('Confirm skill repository registration'); keys('y');
    await waitFor(() => f.requests.some(r => r.method === 'skills.registerRepository'));
    keys('\x1b'); await visible('worker');
    f.releaseLocalImport(); await new Promise(resolve => setTimeout(resolve, 100));
    expect(screen()).toContain('worker');
    expect(screen()).not.toContain('Skills · server-wide');
    expect(screen()).not.toContain('Registered alpha in this organization');
  } finally { await f.ui.close(); await f.mock.close(); }
});

test('delayed catalog refresh cannot replace a newer view or notice', async () => {
  const f = await fixture({ withSettings: true, localImport: true, holdCatalogRefresh: true });
  const { keys, visible, screen } = f.ui;
  try {
    await visible('worker'); keys('v'); await visible('CLIENT ONLY'); keys('s'); await visible('Server settings'); keys('\r'); await visible('Skills · server-wide');
    keys('c'); await waitFor(() => f.requests.filter(r => r.method === 'skills.list').length === 2);
    keys('\x1b'); await visible('Server settings'); keys('\r'); await visible('Organization facts');
    f.releaseCatalogRefresh(); await new Promise(resolve => setTimeout(resolve, 100));
    expect(screen()).toContain('Organization facts');
    expect(screen()).not.toContain('Skills catalog refreshed; settings draft was not changed.');
  } finally { await f.ui.close(); await f.mock.close(); }
});

test('delayed strict catalog failure cannot replace unified registration uncertainty feedback', async () => {
  const f = await fixture({ withSettings: true, localImport: true, holdCatalogRefresh: true, malformedLocalImport: true, malformedHeldCatalog: true });
  const { keys, visible, screen } = f.ui;
  try {
    await visible('worker'); keys('v'); await visible('CLIENT ONLY'); keys('s'); await visible('Server settings'); keys('\r'); await visible('Skills · server-wide');
    keys('c'); await waitFor(() => f.requests.filter(r => r.method === 'skills.list').length === 2);
    keys('a'); await visible('Add skill repository · one source locator'); keys('/tmp/local'); keys('\r'); await visible('Confirm skill repository registration'); keys('y');
    await visible('malformed result; outcome is unknown');
    f.releaseCatalogRefresh(); await new Promise(resolve => setTimeout(resolve, 100));
    expect(screen()).toContain('malformed result; outcome is unknown');
    expect(screen()).not.toContain('Skills catalog response was invalid');
    expect(screen()).toContain('Skills · server-wide');
  } finally { await f.ui.close(); await f.mock.close(); }
});

test('agent Skills picker has no local registration shortcut; assignment remains a separate save', async () => {
  const f = await fixture({ withSettings: true, localImport: true });
  const { keys, visible, screen } = f.ui;
  try {
    await visible('worker'); keys('e'); keys('\x1b[B'.repeat(9)); await visible('Skills:'); keys('\r'); await visible('Alpha instructions');
    expect(screen()).not.toContain('register local');
    expect(screen()).not.toContain('Register local server skill');
    keys('a'); keys('S'); await visible('Modify agent · revision 8');
    expect(f.requests.filter(r => r.method === 'skills.addFromPath')).toHaveLength(0);
    keys('S'); await waitFor(() => f.changes.some(change => change.agentId === 'root'));
    expect(f.changes).toHaveLength(1);
    expect(f.changes[0]).toMatchObject({ agentId: 'root', expectedRevision: 8, settings: { extensions: { managed: { alpha: 'available' } } } });
  } finally { await f.ui.close(); await f.mock.close(); }
});

test('local registration and catalog refresh controls fail closed without Skills settings route or capability', async () => {
  const missingRoute = await fixture({ localImport: true, withSettings: false });
  try {
    const { keys, visible, screen } = missingRoute.ui;
    await visible('worker'); keys('v'); await visible('TUI colors');
    expect(screen()).not.toContain('Server settings');
    keys('\x1b'); await visible('worker'); keys('e'); keys('\x1b[B'.repeat(9)); await visible('Skills:'); keys('\r'); await visible('Alpha instructions');
    expect(screen()).not.toContain('Register local');
    expect(screen()).not.toContain('register local');
  } finally { await missingRoute.ui.close(); await missingRoute.mock.close(); }

  const missingGroup = await fixture({ withSettings: true, missingSettingsGroup: true, localImport: true });
  try {
    const { keys, visible, screen } = missingGroup.ui;
    await visible('worker'); keys('v'); await visible('CLIENT ONLY'); keys('s'); await visible('Server settings');
    expect(screen()).not.toContain('Skills · server-wide');
    expect(screen()).not.toContain('Register a local server skill');
    expect(missingGroup.requests.filter(r => r.method === 'skills.addFromPath')).toHaveLength(0);
  } finally { await missingGroup.ui.close(); await missingGroup.mock.close(); }

  const missingCapability = await fixture({ withSettings: true, localImport: false });
  try {
    const { keys, visible, screen } = missingCapability.ui;
    await visible('worker'); keys('v'); await visible('CLIENT ONLY'); keys('s'); await visible('Server settings'); keys('\r'); await visible('Skills · server-wide');
    expect(screen()).toContain('Add skill repository unavailable');
    expect(missingCapability.requests.filter(r => r.method === 'skills.registerRepository')).toHaveLength(0);
  } finally { await missingCapability.ui.close(); await missingCapability.mock.close(); }

  const wrongEndpoint = await fixture({ withSettings: true, localImport: true, wrongImportEndpoint: true });
  try {
    const { keys, visible, screen } = wrongEndpoint.ui;
    await visible('worker'); keys('v'); await visible('CLIENT ONLY'); keys('s'); await visible('Server settings'); keys('\r'); await visible('Skills · server-wide');
    expect(screen()).toContain('Add skill repository unavailable');
    expect(wrongEndpoint.requests.filter(r => r.method === 'skills.registerRepository')).toHaveLength(0);
  } finally { await wrongEndpoint.ui.close(); await wrongEndpoint.mock.close(); }
});

test('ordinary modify Skills picker is keyboard-only and saves exactly one complete revision-fenced map', async () => {
  const f = await fixture();
  const { keys, visible } = f.ui;
  try {
    await visible('worker');
    keys('e'); await visible('Modify agent · revision 8');
    keys('\x1b[B'.repeat(9)); await visible('Skills:');
    keys('\r');
    await visible('Alpha instructions'); await visible('Beta instructions');
    // Stage beta as available, remove the prior alpha selection, then stage the
    // picker draft in the ordinary form and save once. No skill ID/JSON is typed.
    keys('\x1b[B'); keys('a'); keys('\x1b[A'); keys('d'); keys('S');
    await visible('Modify agent · revision 8');
    expect(f.changes).toHaveLength(0);
    keys('S');
    await waitFor(() => f.changes.some(request => request.agentId === 'root'));
    expect(f.changes).toEqual([{
      agentId: 'root', expectedRevision: 8,
      settings: { extensions: { managed: { beta: 'available' }, sibling: { retained: true } } },
    }]);
  } finally { await f.ui.close(); await f.mock.close(); }
}, 20_000);

test('create can stage an installed skill and picker cancellation never mutates the agent', async () => {
  const created = await fixture();
  try {
    const { keys, visible } = created.ui;
    await visible('worker'); keys('n'); await visible('Create agent');
    keys('\x1b[B'.repeat(9)); await visible('Skills:'); keys('\r'); await visible('Alpha instructions');
    keys('i'); await visible('installed'); keys('S'); await visible('Create agent');
    expect(created.changes).toHaveLength(0);
    keys('S'); await waitFor(() => created.changes.length === 1);
    expect(created.changes[0]).toMatchObject({ settings: { extensions: { managed: { alpha: 'installed' } } } });
  } finally { await created.ui.close(); await created.mock.close(); }

  const cancelled = await fixture();
  try {
    const { keys, visible } = cancelled.ui;
    await visible('worker'); keys('e'); await visible('Modify agent · revision 8');
    keys('\x1b[B'.repeat(9)); await visible('Skills:'); keys('\r'); await visible('Alpha instructions');
    keys('a'); keys('\x1b'); await visible('Modify agent · revision 8'); keys('\x1b'); await visible('worker');
    expect(cancelled.changes).toHaveLength(0);
  } finally { await cancelled.ui.close(); await cancelled.mock.close(); }
});

test('skills picker filters without losing its input, scrolls, and explains empty catalogs', async () => {
  const manySkills = [...skills, ...Array.from({ length: 40 }, (_, i) => ({ name: `skill-${String(i).padStart(2, '0')}`, description: `Instructions ${i}`, gitUrl: `https://github.com/org/skill-${i}` }))];
  const f = await fixture({ skillCatalog: manySkills });
  try {
    const { keys, visible, screen } = f.ui;
    await visible('worker'); keys('e'); await visible('Modify agent · revision 8');
    keys('\x1b[B'.repeat(9)); await visible('Skills:'); keys('\r'); await visible('Alpha instructions');
    keys('\x1b[B'.repeat(40)); await visible('skill-38');
    expect(screen()).not.toContain('skill-00');
    keys('/skill-31\r');
    await waitFor(() => {
      const filtered = screen();
      return filtered.includes('Skills: worker') && filtered.includes('a available') && filtered.includes('skill-31') &&
        !filtered.includes('Filter skills') && !filtered.includes('skill-30') && !filtered.includes('skill-32');
    });
  } finally { await f.ui.close(); await f.mock.close(); }

  const empty = await fixture({ skillCatalog: [] });
  try {
    const { keys, visible } = empty.ui;
    await visible('worker'); keys('e'); await visible('Modify agent · revision 8');
    keys('\x1b[B'.repeat(9)); await visible('Skills:'); keys('\r');
    await visible('No catalog skills yet. Open server settings');
    keys('S'); await visible('Modify agent · revision 8');
    keys('\r'); await visible('alpha');
    expect(empty.ui.screen()).toContain('[not in catalog]');
    keys('?'); await visible('Keys · agent-skills'); keys('d');
    await waitFor(() => !empty.ui.screen().includes('[not in catalog]'));
  } finally { await empty.ui.close(); await empty.mock.close(); }
}, 20_000);

test('skill becoming ready after an editor opens can be staged from refreshed discovery', async () => {
  const f = await fixture({ skillCatalog: [] });
  try {
    const { keys, visible } = f.ui;
    await visible('worker'); keys('e'); await visible('Modify agent · revision 8');
    keys('\x1b[B'.repeat(9)); await visible('Skills:'); keys('\r'); await visible('No catalog skills yet');
    f.setSkillCatalog([skills[1]!]);
    send([...f.mock.sockets][0]!, event(1, 'skills.catalog_changed', { state: 'ready' }));
    await waitFor(() => f.requests.filter(request => request.method === 'skills.list').length >= 2 && !f.ui.screen().includes('unavailable  beta'));
    await visible('Beta instructions');
    keys('a'); await visible('available  beta');
    keys('S'); await visible('Modify agent · revision 8');
    await visible('2 selected');
    keys('S'); await waitFor(() => f.changes.some(change => change.agentId === 'root'));
    expect(f.changes[0]).toMatchObject({ settings: { extensions: { managed: { alpha: 'installed', beta: 'available' } } } });
  } finally { await f.ui.close(); await f.mock.close(); }
}, 20_000);

test('a staged skill whose source is removed becomes stale and is never silently submitted', async () => {
  const f = await fixture();
  try {
    const { keys, visible, screen } = f.ui;
    await visible('worker'); keys('e'); await visible('Modify agent · revision 8');
    keys('\x1b[B'.repeat(9)); await visible('Skills:'); keys('\r'); await visible('Beta instructions');
    keys('\x1b[B'); keys('a'); keys('S'); await visible('Modify agent · revision 8');
    f.setSkillCatalog([skills[0]!]);
    const socket = [...f.mock.sockets][0]!;
    send(socket, event(1, 'organization.settings.changed', { namespace: 'skills', revision: 4 }));
    await waitFor(() => f.requests.filter(request => request.method === 'skills.list').length >= 2);
    keys('\r'); await visible('Beta instructions');
    expect(screen()).toContain('stale');
    expect(f.changes).toHaveLength(0);
  } finally { await f.ui.close(); await f.mock.close(); }
}, 20_000);

test('retained installed skill can be downgraded to available', async () => {
  const f = await fixture({ skillCatalog: [] });
  try {
    const { keys, visible, screen } = f.ui;
    await visible('worker'); keys('e'); await visible('Modify agent · revision 8');
    keys('\x1b[B'.repeat(9)); await visible('Skills:'); keys('\r'); await visible('No catalog skills yet');
    keys('S'); await visible('Modify agent · revision 8'); keys('\r'); await visible('alpha');
    expect(screen()).toContain('[not in catalog]');
    keys('a'); await waitFor(() => /available\s+alpha/.test(screen()));
    keys('S'); await visible('Modify agent · revision 8');
    await visible('1 selected');
    keys('S'); await waitFor(() => f.changes.some(change => change.agentId === 'root'));
    expect(f.changes[0]).toMatchObject({ settings: { extensions: { managed: { alpha: 'available' } } } });
  } finally { await f.ui.close(); await f.mock.close(); }
}, 20_000);

test('conflicts, failed operations and disconnects retain the staged skills draft without retry', async () => {
  for (const [outcome, message] of [
    ['conflict', 'revision conflict in fixture'],
    ['failed', 'fixture operation failed'],
    ['disconnect', 'outcome unknown'],
  ] as const) {
    const f = await fixture({ modifyOutcome: outcome });
    try {
      const { keys, visible, screen } = f.ui;
      await visible('worker'); keys('e'); await visible('Modify agent · revision 8');
      keys('\x1b[B'.repeat(9)); await visible('Skills:'); keys('\r'); await visible('Beta instructions');
      keys('\x1b[B'); keys('a'); keys('S'); await visible('2 selected');
      expect(f.changes).toHaveLength(0);
      keys('S'); await visible(message);
      await visible('2 selected');
      if (outcome === 'disconnect') {
        await waitFor(() => f.connections() >= 2 && f.requests.filter(request => request.method === 'organization.snapshot').length >= 2);
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      expect(f.changes).toHaveLength(1);
      expect(screen()).toContain('Skills:');
    } finally { await f.ui.close(); await f.mock.close(); }
  }
}, 30_000);

test('skills descriptions fit narrow terminal rows', async () => {
  const f = await fixture({ cols: 42, skillCatalog: [{ name: 'alpha', description: 'A deliberately long skill description that must be clipped to the narrow terminal width', gitUrl: 'https://github.com/org/alpha' }] });
  try {
    const { keys, visible, screen } = f.ui;
    await visible('worker'); keys('e'); await visible('Modify agent · revision 8');
    keys('\x1b[B'.repeat(9)); await visible('Skills:'); keys('\r'); await visible('alpha');
    const rendered = screen(), rows = rendered.split('\n');
    const skillRow = rows.find(row => row.includes('alpha') && row.includes('A …'));
    expect(skillRow).toBeDefined();
    expect(skillRow!.length).toBeLessThanOrEqual(42);
    expect(rendered).not.toContain('narrow terminal width');
  } finally { await f.ui.close(); await f.mock.close(); }
});

test('legacy seed add/edit form is hidden and unrelated saves preserve hidden seed values', async () => {
  const seeds = [{ name: 'alpha', gitUrl: 'https://github.com/org/alpha' }, { name: 'beta', gitUrl: 'https://github.com/org/beta' }];
  const f = await fixture({ withSettings: true, repositories: seeds });
  try {
    const { keys, visible, screen } = f.ui;
    await visible('worker'); keys('v'); await visible('CLIENT ONLY'); keys('s'); await visible('Server settings');
    keys('\r'); await visible('Skills · server-wide · revision 3');
    expect(screen()).toContain('Legacy configured seeds: 2');
    expect(screen()).not.toContain('HTTPS Git URL');
    expect(screen()).not.toContain('Skill name');
    keys('\x1b[B'); await new Promise(resolve => setTimeout(resolve, 40)); keys('\x1b[B\r'); await visible('Git timeout · number'); keys('\x15'); keys('50000\r'); await visible('Git timeout: 50000');
    keys('S'); await visible('Confirm server-wide'); keys('y'); await visible('Saved on server');
    expect(f.changes).toEqual([{ namespace: 'skills', expectedRevision: 3, patch: { gitTimeoutMs: 50000 }, reset: [] }]);
    expect(f.group.values.repositories).toEqual(seeds);
  } finally { await f.ui.close(); await f.mock.close(); }
}, 20_000);

test('server settings exposes explicit skill retry without resaving configuration', async () => {
  const f = await fixture({ withSettings: true });
  try {
    const { keys, visible } = f.ui;
    await visible('worker'); keys('v'); await visible('CLIENT ONLY'); keys('s'); await visible('Server settings');
    keys('\r'); await visible('Skills · server-wide · revision 3');
    keys('R'); await visible('Skills reconciliation retry accepted');
    expect(f.requests.filter(request => request.method === 'skills.reconcile')).toHaveLength(1);
    expect(f.requests.filter(request => request.method === endpoints.update)).toHaveLength(0);
    expect(f.changes).toHaveLength(0);
  } finally { await f.ui.close(); await f.mock.close(); }
});

test('repository reconciliation failure identifies the repository and retains its diagnostic', async () => {
  const f = await fixture({ withSettings: true, repositories: [{ name: 'alpha', gitUrl: 'https://git.example/alpha' }], skillReconciliation: {
    state: 'error', entries: [{ name: 'alpha', gitUrl: 'https://git.example/alpha', status: 'error', error: 'TLS certificate rejected by registry' }],
  } });
  try {
    const { keys, visible, screen } = f.ui;
    await visible('worker'); keys('v'); await visible('CLIENT ONLY'); keys('s'); await visible('Server settings');
    keys('\r'); await visible('Skills · server-wide · revision 3');
    expect(screen()).toContain('alpha');
    expect(screen()).toContain('https://git.example/alpha');
    expect(screen()).toContain('TLS certificate rejected by registry');
  } finally { await f.ui.close(); await f.mock.close(); }
}, 20_000);

test('Add is the only Skills repository entry point; no name/URL TUI form remains', async () => {
  const f = await fixture({ withSettings: true, localImport: true });
  try {
    const { keys, visible, screen } = f.ui;
    await visible('worker'); keys('v'); await visible('CLIENT ONLY'); keys('s'); await visible('Server settings'); keys('\r'); await visible('Skills · server-wide');
    expect(screen()).toContain('Add skill repository…');
    expect(screen()).not.toContain('HTTPS Git URL');
    expect(screen()).not.toContain('Skill name');
    expect(f.requests.filter(request => ['skills.add', 'skills.addFromPath', 'skills.registerRepository'].includes(request.method))).toHaveLength(0);
    expect(f.changes).toHaveLength(0);
  } finally { await f.ui.close(); await f.mock.close(); }
}, 20_000);
