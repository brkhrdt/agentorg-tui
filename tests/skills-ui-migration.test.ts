import { expect, test } from 'bun:test';
import { agent, mockServer, operation, respond, waitFor } from './helpers.js';
import { terminalClient } from './terminal.js';
import type { ServerSettingsCatalog, ServerSettingsGroup } from '../src/protocol.js';

const skills = [
  { name: 'alpha', description: 'Alpha instructions', gitUrl: 'https://github.com/org/alpha' },
  { name: 'beta', description: 'Beta instructions', gitUrl: 'https://github.com/org/beta' },
];
const endpoints = { list: 'organization.settings.list', get: 'organization.settings.get', update: 'organization.settings.update' };
const repositoryGroup = (repositories: Array<{ name: string; gitUrl: string }> = []): ServerSettingsGroup => ({
  namespace: 'skills', plugin: 'skills', title: 'Skills', version: 1, revision: 3,
  fields: [{
    key: 'repositories', label: 'Repository seeds', editor: 'list', effect: 'restart',
    itemIdKey: 'name', itemLabelKey: 'name', itemDefaults: { name: '', gitUrl: '' },
    itemFields: [
      { key: 'name', label: 'Skill name', editor: 'text', effect: 'restart' },
      { key: 'gitUrl', label: 'HTTPS Git URL', editor: 'text', effect: 'restart' },
    ],
  }],
  defaults: { repositories: [] }, values: { repositories }, effective: { repositories }, overridden: [], restartRequired: [],
});

async function fixture({ withSettings = false, skillCatalog = skills, repositories = [] }: { withSettings?: boolean; skillCatalog?: typeof skills; repositories?: Array<{ name: string; gitUrl: string }> } = {}) {
  const root = agent('root', null, { name: 'worker', revision: 8, settings: {
    harness: 'fixture', model: 'test', extensions: { managed: { alpha: 'installed' }, sibling: { retained: true } },
  } });
  const group = repositoryGroup(repositories);
  const serverSettings: ServerSettingsCatalog = { groups: [group], facts: { cwd: '/work', dataDir: '/data', socketPath: '/socket', harnesses: ['fixture'], plugins: ['skills'] } };
  const requests: any[] = [], changes: any[] = [];
  const mock = await mockServer((socket, request) => {
    requests.push(request);
    if (request.method === 'organization.snapshot') respond(socket, request.id, { seq: 0, agents: [root], operations: [], capabilities: {
      harnesses: ['fixture'],
      plugins: { skills: { version: 1, settingsNamespace: 'managed', endpoints: { list: 'skills.list', add: 'skills.add' } } },
      ...(withSettings && { serverSettings: { version: 1, groups: [group], endpoints } }),
    } });
    else if (request.method === 'skills.list') respond(socket, request.id, { skills: skillCatalog });
    else if (request.method === endpoints.list) respond(socket, request.id, serverSettings);
    else if (request.method === endpoints.update) {
      changes.push(request.params);
      respond(socket, request.id, { ...group, values: { ...group.values, ...request.params.patch }, revision: group.revision + 1, restartRequired: ['repositories'] });
    }
    else if (request.method === 'events.history') respond(socket, request.id, { events: [], expired: false, latestSeq: 0, oldestSeq: 1 });
    else if (request.method === 'agent.create') {
      changes.push(request.params);
      respond(socket, request.id, { ...operation('completed'), id: 'create', type: 'agent.create', agentId: 'created' });
    }
    else if (request.method === 'agent.modify') {
      changes.push(request.params);
      respond(socket, request.id, { ...operation('completed'), id: 'modify', type: 'agent.modify', agentId: 'root' });
    }
    else if (request.method === 'operation.wait') respond(socket, request.id, { ...operation('completed'), id: 'modify', type: 'agent.modify', agentId: 'root', result: root });
    else respond(socket, request.id, { seq: 0, liveOnly: true });
  });
  const ui = terminalClient(mock.path, mock.directory);
  return { mock, ui, root, requests, changes, group };
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
    keys('/'); await visible('Filter skills'); keys('skill-31\r');
    await visible('skill-31');
    expect(screen()).not.toContain('skill-00');
  } finally { await f.ui.close(); await f.mock.close(); }

  const empty = await fixture({ skillCatalog: [] });
  try {
    const { keys, visible } = empty.ui;
    await visible('worker'); keys('e'); await visible('Modify agent · revision 8');
    keys('\x1b[B'.repeat(9)); await visible('Skills:'); keys('\r');
    await visible('No catalog skills yet. Open server settings');
  } finally { await empty.ui.close(); await empty.mock.close(); }
}, 20_000);

test('server repository record edits, deletes and cancellation stage locally; confirmed save shows restart effect', async () => {
  const initial = [
    { name: 'alpha', gitUrl: 'https://github.com/org/alpha' },
    { name: 'beta', gitUrl: 'https://github.com/org/beta' },
  ];
  const cancelled = await fixture({ withSettings: true, repositories: initial });
  try {
    const { keys, visible } = cancelled.ui;
    await visible('worker'); keys('v'); await visible('CLIENT ONLY'); keys('s'); await visible('Server settings');
    keys('\r'); await visible('Skills · server-wide · revision 3'); keys('\r'); await visible('Repository seeds');
    keys('d'); keys('\x1b'); await visible('Skills · server-wide · revision 3');
    expect(cancelled.ui.screen()).toContain('[2 entries; edit to inspect]');
    expect(cancelled.changes).toHaveLength(0);
  } finally { await cancelled.ui.close(); await cancelled.mock.close(); }

  const edited = await fixture({ withSettings: true, repositories: initial });
  try {
    const { keys, visible } = edited.ui;
    await visible('worker'); keys('v'); await visible('CLIENT ONLY'); keys('s'); await visible('Server settings');
    keys('\r'); await visible('Skills · server-wide · revision 3'); keys('\r'); await visible('Repository seeds');
    keys('\r'); await visible('Repository seeds: alpha');
    keys('\x1b[B\r'); await visible('HTTPS Git URL · text');
    keys('\x15https://github.com/org/alpha-v2\r'); await visible('Repository seeds: alpha');
    keys('S'); await visible('Repository seeds'); expect(edited.changes).toHaveLength(0);
    keys('\x1b[B'); keys('d'); keys('S'); await visible('Skills · server-wide · revision 3');
    keys('S'); await visible('Confirm server-wide'); keys('y'); await visible('Saved on server · restart required');
    await visible('RESTART REQUIRED');
    expect(edited.changes).toEqual([{ namespace: 'skills', expectedRevision: 3, patch: { repositories: [{ name: 'alpha', gitUrl: 'https://github.com/org/alpha-v2' }] }, reset: [] }]);
  } finally { await edited.ui.close(); await edited.mock.close(); }
});

test('server settings repository record add stages without a write until revision-confirmed save', async () => {
  const f = await fixture({ withSettings: true });
  const { keys, visible } = f.ui;
  try {
    await visible('worker');
    keys('v'); await visible('CLIENT ONLY'); keys('s'); await visible('Server settings');
    keys('\r'); await visible('Skills · server-wide · revision 3');
    keys('\r'); await visible('Repository seeds');
    keys('\r'); await visible('No configurations. Press a to add.');
    keys('a'); await visible('Repository seeds: New entry');
    keys('\r'); await visible('Skill name · text'); keys('alpha\r'); await visible('Repository seeds: New entry');
    keys('\x1b[B\r'); await visible('HTTPS Git URL · text'); keys('https://github.com/org/alpha\r'); await visible('Repository seeds: New entry');
    expect(f.changes).toHaveLength(0);
    keys('S'); await visible('Repository seeds'); expect(f.changes).toHaveLength(0);
    keys('S'); await visible('Skills · server-wide · revision 3'); expect(f.changes).toHaveLength(0);
    keys('S'); await visible('Confirm server-wide'); keys('y'); await visible('Saved on server');
    await waitFor(() => f.changes.length === 1);
    expect(f.changes[0]).toEqual({ namespace: 'skills', expectedRevision: 3,
      patch: { repositories: [{ name: 'alpha', gitUrl: 'https://github.com/org/alpha' }] }, reset: [] });
  } finally { await f.ui.close(); await f.mock.close(); }
}, 20_000);
