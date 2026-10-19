import { expect, test } from 'bun:test';
import { agent, event, mockServer, operation, respond, send, waitFor } from './helpers.js';
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
    key: 'repositories', label: 'Repositories', editor: 'list', effect: 'immediate',
    itemIdKey: 'name', itemLabelKey: 'name', itemDefaults: { name: '', gitUrl: '' },
    itemFields: [
      { key: 'name', label: 'Skill name', editor: 'text', effect: 'immediate' },
      { key: 'gitUrl', label: 'HTTPS Git URL', editor: 'text', effect: 'immediate' },
    ],
  }],
  defaults: { repositories: [] }, values: { repositories }, effective: { repositories }, overridden: [], restartRequired: [],
});

async function fixture({ withSettings = false, skillCatalog = skills, repositories = [], modifyOutcome = 'ok', cols = 120 }: { withSettings?: boolean; skillCatalog?: typeof skills; repositories?: Array<{ name: string; gitUrl: string }>; modifyOutcome?: 'ok' | 'conflict' | 'failed' | 'disconnect'; cols?: number } = {}) {
  const root = agent('root', null, { name: 'worker', revision: 8, settings: {
    harness: 'fixture', model: 'test', extensions: { managed: { alpha: 'installed' }, sibling: { retained: true } },
  } });
  const group = repositoryGroup(repositories);
  let currentSkillCatalog = skillCatalog;
  const serverSettings: ServerSettingsCatalog = { groups: [group], facts: { cwd: '/work', dataDir: '/data', socketPath: '/socket', harnesses: ['fixture'], plugins: ['skills'] } };
  const requests: any[] = [], changes: any[] = [];
  let connections = 0;
  const mock = await mockServer((socket, request) => {
    requests.push(request);
    if (request.method === 'organization.snapshot') respond(socket, request.id, { seq: 0, agents: [root], operations: [], capabilities: {
      harnesses: ['fixture'],
      plugins: { skills: { version: 1, settingsNamespace: 'managed', endpoints: { list: 'skills.list', add: 'skills.add', reconcile: 'skills.reconcile' } } },
      ...(withSettings && { serverSettings: { version: 1, groups: [group], endpoints } }),
    } });
    else if (request.method === 'skills.list') respond(socket, request.id, { skills: currentSkillCatalog });
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
    setSkillCatalog(catalog: typeof skills) { currentSkillCatalog = catalog; } };
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

test('server repository record edits and confirmed immediate save show preparing status without restart marker', async () => {
  const initial = [
    { name: 'alpha', gitUrl: 'https://github.com/org/alpha' },
    { name: 'beta', gitUrl: 'https://github.com/org/beta' },
  ];
  const cancelled = await fixture({ withSettings: true, repositories: initial });
  try {
    const { keys, visible } = cancelled.ui;
    await visible('worker'); keys('v'); await visible('CLIENT ONLY'); keys('s'); await visible('Server settings');
    keys('\r'); await visible('Skills · server-wide · revision 3'); keys('\r'); await visible('Repositories');
    keys('d'); keys('\x1b'); await visible('Skills · server-wide · revision 3');
    expect(cancelled.ui.screen()).toContain('[2 entries; edit to inspect]');
    expect(cancelled.changes).toHaveLength(0);
  } finally { await cancelled.ui.close(); await cancelled.mock.close(); }

  const edited = await fixture({ withSettings: true, repositories: initial });
  try {
    const { keys, visible } = edited.ui;
    await visible('worker'); keys('v'); await visible('CLIENT ONLY'); keys('s'); await visible('Server settings');
    keys('\r'); await visible('Skills · server-wide · revision 3'); keys('\r'); await visible('Repositories');
    keys('\r'); await visible('Repositories: alpha');
    keys('\x1b[B\r'); await visible('HTTPS Git URL · text');
    keys('\x15https://github.com/org/alpha-v2\r'); await visible('Repositories: alpha');
    keys('S'); await visible('Repositories'); expect(edited.changes).toHaveLength(0);
    keys('\x1b[B'); keys('d'); keys('S'); await visible('Skills · server-wide · revision 3');
    keys('S'); await visible('Confirm server-wide'); keys('y'); await visible('preparing');
    expect(edited.ui.screen()).not.toContain('RESTART REQUIRED');
    expect(edited.changes).toEqual([{ namespace: 'skills', expectedRevision: 3, patch: { repositories: [{ name: 'alpha', gitUrl: 'https://github.com/org/alpha-v2' }] }, reset: [] }]);
  } finally { await edited.ui.close(); await edited.mock.close(); }
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

test('server settings repository add stages without a write until revision-confirmed save', async () => {
  const f = await fixture({ withSettings: true });
  const { keys, visible } = f.ui;
  try {
    await visible('worker');
    keys('v'); await visible('CLIENT ONLY'); keys('s'); await visible('Server settings');
    keys('\r'); await visible('Skills · server-wide · revision 3');
    keys('\r'); await visible('Repositories');
    keys('\r'); await visible('No configurations. Press a to add.');
    keys('a'); await visible('Repositories: New entry');
    keys('\r'); await visible('Skill name · text'); keys('alpha\r'); await visible('Repositories: New entry');
    keys('\x1b[B\r'); await visible('HTTPS Git URL · text'); keys('https://github.com/org/alpha\r'); await visible('Repositories: New entry');
    expect(f.changes).toHaveLength(0);
    keys('S'); await visible('Repositories'); expect(f.changes).toHaveLength(0);
    keys('S'); await visible('Skills · server-wide · revision 3'); expect(f.changes).toHaveLength(0);
    keys('S'); await visible('Confirm server-wide'); keys('y'); await visible('Saved on server');
    await waitFor(() => f.changes.length === 1);
    expect(f.changes[0]).toEqual({ namespace: 'skills', expectedRevision: 3,
      patch: { repositories: [{ name: 'alpha', gitUrl: 'https://github.com/org/alpha' }] }, reset: [] });
  } finally { await f.ui.close(); await f.mock.close(); }
}, 20_000);
