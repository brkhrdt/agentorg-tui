import { expect, test } from 'bun:test';
import { Session } from '../src/session.js';
import { ServerSettingsEditor } from '../src/server-settings-editor.js';
import { StructuredEditor } from '../src/structured-editor.js';
import type { ServerSettingsCatalog, ServerSettingsGroup } from '../src/protocol.js';
import { event, mockServer, respond, send, waitFor } from './helpers.js';
import { terminalClient } from './terminal.js';

const core = (): ServerSettingsGroup => ({ namespace: 'core', title: 'Organization / core', version: 1, revision: 0,
  fields: [
    { key: 'maxDepth', label: 'Maximum depth', editor: 'number', min: 1, effect: 'immediate', description: 'Maximum hierarchy depth.' },
    { key: 'maxLineBytes', label: 'Message limit', editor: 'number', min: 256, effect: 'restart' },
  ], defaults: { maxDepth: 8, maxLineBytes: 4096 }, values: { maxDepth: 8, maxLineBytes: 4096 }, effective: { maxDepth: 8, maxLineBytes: 4096 }, overridden: [], restartRequired: [],
});
const demo = (): ServerSettingsGroup => ({ namespace: 'demo', plugin: 'demo', title: 'Demo plugin', version: 1, revision: 0,
  fields: [{ key: 'entries', label: 'Containers', editor: 'list', effect: 'future-launch' }, { key: 'mode', label: 'Mode', editor: 'select', choices: ['safe', 'fast'], effect: 'restart' }],
  defaults: { entries: [{ id: 'one' }], mode: 'safe' }, values: { entries: [{ id: 'one' }], mode: 'safe' }, effective: { entries: [{ id: 'one' }], mode: 'safe' }, overridden: [], restartRequired: [],
});
const endpoints = { list: 'organization.settings.list', get: 'organization.settings.get', update: 'organization.settings.update' };
async function fixture() {
  const catalog: ServerSettingsCatalog = { groups: [core(), demo()], facts: { cwd: '/server', dataDir: '/private/org', socketPath: '/private/org/server.sock', harnesses: ['pi'], plugins: ['demo', 'pi'] } };
  let seq = 0;
  const changes: any[] = [], methods: string[] = [];
  const mock = await mockServer((socket, request) => {
    const { id, method, params } = request; methods.push(method);
    if (method === 'organization.snapshot') respond(socket, id, { seq, agents: [], operations: [], capabilities: { serverSettings: { version: 1, groups: catalog.groups, endpoints } } });
    else if (method === 'events.history') respond(socket, id, { events: [], expired: false, latestSeq: seq, oldestSeq: seq + 1 });
    else if (method === endpoints.list) respond(socket, id, catalog);
    else if (method === endpoints.update) {
      changes.push(params);
      const group = catalog.groups.find(g => g.namespace === params.namespace)!;
      if (params.expectedRevision !== group.revision) send(socket, { kind: 'response', id, ok: false, error: { code: 'CONFLICT', message: 'Stale server settings revision' } });
      else {
        for (const key of params.reset) { group.values[key] = structuredClone(group.defaults[key]); group.overridden = group.overridden.filter(k => k !== key); }
        Object.assign(group.values, params.patch);
        group.overridden = [...new Set([...group.overridden, ...Object.keys(params.patch)])];
        group.revision++;
        for (const field of group.fields) if (field.effect !== 'restart') group.effective[field.key] = structuredClone(group.values[field.key]);
        group.restartRequired = group.fields.filter(f => f.effect === 'restart' && group.values[f.key] !== group.effective[f.key]).map(f => f.key);
        respond(socket, id, group);
        broadcast();
      }
    } else respond(socket, id, { seq, liveOnly: true });
  });
  const broadcast = () => { for (const socket of mock.sockets) send(socket, event(++seq, 'organization.settings.changed', { namespace: 'core', revision: catalog.groups[0]!.revision }, { agentId: undefined, generation: undefined })); };
  return { mock, catalog, changes, methods, broadcast };
}

test('server draft separates resets, list deletion and revision-fenced patches from client preferences', () => {
  const group = core(), editor = new ServerSettingsEditor(group);
  expect(() => editor.stage(group.fields[0]!, '0')).toThrow();
  expect(editor.values.maxDepth).toBe('8');
  editor.stage(group.fields[0]!, '3'); editor.stage(group.fields[1]!, '1024');
  editor.reset(group.fields[0]!);
  expect(editor.params()).toEqual({ namespace: 'core', expectedRevision: 0, patch: { maxLineBytes: 1024 }, reset: ['maxDepth'] });
  const plugin = demo(), draft = new ServerSettingsEditor(plugin);
  expect(() => draft.stage(plugin.fields[1]!, 'invalid')).toThrow('Choose');
  const list = new StructuredEditor({ editor: 'list', genericList: true }, draft.values.entries!);
  list.remove('0'); list.put(undefined, '', { id: 'two', image: 'local:latest' });
  draft.stage(plugin.fields[0]!, list.serialize());
  expect(draft.params().patch.entries).toEqual([{ id: 'two', image: 'local:latest' }]);
  list.remove('0'); draft.stage(plugin.fields[0]!, list.serialize());
  expect(draft.params().patch.entries).toEqual([]);
  expect(group.values.maxDepth).toBe(8);
});

test('deprecated public compatibility fields are retained but omitted from normal form rows and patches', () => {
  const group = demo(); group.fields[1]!.deprecated = true;
  const editor = new ServerSettingsEditor(group);
  expect(editor.fields.map(field => field.key)).toEqual(['entries']);
  expect(editor.valuesObject().mode).toBe('safe');
  editor.stage(editor.fields[0]!, '[]');
  expect(editor.params().patch).toEqual({ entries: [] });
  expect(editor.group.fields[1]!.deprecated).toBe(true); // Presentation only, not secret masking or data deletion.
});

test('session loads server settings only when requested, refreshes on changes and does not retry conflicts', async () => {
  const { mock, catalog, changes, methods, broadcast } = await fixture();
  const session = new Session(mock.path), running = session.run();
  try {
    await waitFor(() => session.status === 'connected');
    expect(methods).not.toContain(endpoints.list);
    await session.loadServerSettings();
    const draft = new ServerSettingsEditor(session.serverSettingsCatalog!.groups[0]!);
    catalog.groups[0]!.revision = 1; catalog.groups[0]!.values.maxDepth = 4; broadcast();
    await waitFor(() => session.serverSettingsCatalog!.groups[0]!.revision === 1);
    draft.stage(draft.group.fields[0]!, '3');
    await expect(session.updateServerSettings(draft.params())).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(changes).toHaveLength(1);
    expect(draft.values.maxDepth).toBe('3');
    expect(draft.group.revision).toBe(0);
    expect(methods).not.toContain('agent.modify');
  } finally { session.close(); await running; await mock.close(); }
});

test('terminal server settings show facts, stage/reset, confirm server-wide saves and report restart and conflicts', async () => {
  const { mock, catalog, changes, broadcast } = await fixture();
  const ui = terminalClient(mock.path, mock.directory), { keys, visible } = ui;
  try {
    await visible('connected'); keys('v'); await visible('CLIENT ONLY'); keys('s');
    await visible('Server settings'); await visible('pi · no server settings declared');
    keys('\r'); await visible('Organization facts'); await visible('/private/org');
    keys('\x1b'); await visible('shared by all clients'); keys('\x1b[B\r'); await visible('server-wide · revision 0');
    keys('\r'); await visible('Maximum hierarchy depth'); keys('\x15' + '3\r'); await visible('3 · edited draft');
    expect(changes).toHaveLength(0);
    keys('S'); await visible('Confirm server-wide'); expect(changes).toHaveLength(0);
    keys('y'); await visible('Saved on server'); expect(changes[0]).toEqual({ namespace: 'core', expectedRevision: 0, patch: { maxDepth: 3 }, reset: [] });
    keys('z'); await visible('8 · reset draft'); keys('S'); await visible('Confirm server-wide'); keys('y');
    await waitFor(() => changes.length === 2); await visible('revision 2');
    expect(changes[1].reset).toEqual(['maxDepth']);
    keys('\x1b[B\r'); await visible('Message limit · number'); keys('\x15' + '1024\r'); await visible('1024 · edited draft');
    keys('S'); await visible('Confirm server-wide'); keys('y'); await visible('RESTART REQUIRED');
    expect(catalog.groups[0]!.effective.maxLineBytes).toBe(4096);
    keys('\x1b[A\r'); await visible('Maximum hierarchy depth'); keys('\x15' + '2\r'); await visible('2 · edited draft');
    catalog.groups[0]!.revision++; catalog.groups[0]!.values.maxDepth = 4; broadcast();
    await visible('draft is stale'); keys('S'); await visible('Confirm server-wide'); keys('y');
    await visible('draft retained'); expect(changes).toHaveLength(4);
    await visible('2 · edited draft');
    keys('r'); await visible('4 · default'); // Explicitly discard the stale draft.
    // Generic object lists support deletion without granting anything to agents.
    keys('\x1b'); await visible('shared by all clients'); keys('\x1b[B\x1b[B\r'); await visible('Demo plugin · server-wide');
    keys('\r'); await visible('Edit Containers'); keys('d'); await visible('No matching entries'); keys('S'); await visible('0 entries');
    keys('S'); await visible('Confirm server-wide'); keys('y'); await waitFor(() => changes.length === 5);
    expect(changes[4]).toEqual({ namespace: 'demo', expectedRevision: 0, patch: { entries: [] }, reset: [] });
  } finally { await ui.close(); await mock.close(); }
}, 25_000);
