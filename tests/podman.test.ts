import { expect, test } from 'vitest';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import xterm from '@xterm/headless';
import type { ContainerProfile } from '../src/protocol.js';
import { AgentEditor } from '../src/agent-editor.js';
import { Session } from '../src/session.js';
import { UI } from '../src/ui.js';
import { agent, mockServer, operation, respond, waitFor } from './helpers.js';

test('Podman agent editor selects containers instead of exposing a separate image field', () => {
  const create = new AgentEditor('root', undefined, true, [], false, true);
  create.values.harness = 'pi'; create.values.cwd = '/project';
  expect(create.fields).toContain('container');
  expect(create.fields).not.toContain('containerImage');
  const profile: ContainerProfile = { id: 'default', name: 'Default', image: 'pi:v2', network: 'pasta', containerUid: 1000, containerGid: 1000,
    env: [], cwd: '', readOnlyDirs: [], readWriteDirs: [], readOnlyVolumes: [], readWriteVolumes: [] };
  create.selectProfile(profile, 3);
  expect(create.params().settings).toMatchObject({ extensions: { podman: { image: 'pi:v2', profile: { id: 'default', revision: 3 }, readOnlyDirs: [], readWriteDirs: [] } } });
  const record = agent('worker', 'root', { revision: 4, settings: { harness: 'pi', cwd: '/project', extensions: { skills: { test: 'installed' }, podman: { readOnlyDirs: ['/credentials'], readWriteDirs: ['/project'] } } } });
  const editor = new AgentEditor('root', record, true);
  editor.values.readOnlyDirs = 'bad json'; expect(() => editor.params()).toThrow('JSON array');
  editor.values.readOnlyDirs = '[4]'; expect(() => editor.params()).toThrow('JSON array');
  editor.values.readOnlyDirs = '["/external"]'; expect(editor.params().settings).toMatchObject({ extensions: { podman: { readOnlyDirs: ['/external'] } } });
  expect(new AgentEditor(null).fields).not.toContain('container');
});

test('unrelated editor mutations keep all persisted grant drafts untouched and omit grant replacements', () => {
  const record = agent('worker', null, { revision: 7, settings: { harness: 'fixture', cwd: '/before', options: { retries: 1 }, extensions: {
    podman: { image: 'fixture:v1', profile: { id: 'p' }, runtime: { network: 'none' },
      configGrants: { readOnlyDirs: ['/configured'], readWriteDirs: ['/configured-rw'], readOnlyVolumes: ['config-ro'], readWriteVolumes: ['config-rw'] },
      readOnlyDirs: ['/extra-ro'], readWriteDirs: ['/extra-rw'], readOnlyVolumes: ['extra-ro'], readWriteVolumes: ['extra-rw'] },
    sibling: { retained: true },
  } } });
  const grants = { readOnlyDirs: '["/extra-ro"]', readWriteDirs: '["/extra-rw"]', readOnlyVolumes: '["extra-ro"]', readWriteVolumes: '["extra-rw"]' };
  const cwd = new AgentEditor(null, record, true, [], true);
  cwd.values.cwd = '/after';
  expect(cwd.params()).toEqual({ agentId: 'worker', expectedRevision: 7, settings: { cwd: '/after' } });
  expect(Object.fromEntries(Object.keys(grants).map(key => [key, cwd.values[key as keyof typeof cwd.values]]))).toEqual(grants);
  const rename = new AgentEditor(null, record, true, [], true);
  rename.values.name = 'renamed';
  expect(rename.params()).toEqual({ agentId: 'worker', expectedRevision: 7, name: 'renamed' });
  const options = new AgentEditor(null, record, true, [], true);
  options.values.options = '{"retries":2}';
  expect(options.params()).toEqual({ agentId: 'worker', expectedRevision: 7, settings: { options: { retries: 2 } } });
  const clear = new AgentEditor(null, record, true, [], true);
  clear.values.readOnlyDirs = '[]';
  expect((clear.params().settings as any).extensions.podman).toMatchObject({ readOnlyDirs: [], readWriteDirs: ['/extra-rw'], readOnlyVolumes: ['extra-ro'], readWriteVolumes: ['extra-rw'], configGrants: { readOnlyDirs: ['/configured'] } });
});

test('selecting a container configuration snapshots its runtime and grants without changing harness settings', () => {
  const profile: ContainerProfile = { id: 'coding', name: 'Coding', image: 'pi:v2', network: 'none', containerUid: 2000, containerGid: 2001,
    env: ['PUBLIC_CONFIG'], cwd: '/project', readOnlyDirs: ['/configuration'], readWriteDirs: ['/project'], readOnlyVolumes: ['config'], readWriteVolumes: [] };
  const editor = new AgentEditor(null, undefined, true, [], true, true);
  editor.values.harness = 'fixture'; editor.values.provider = 'provider-a'; editor.values.model = 'model-a'; editor.values.options = '{"thinking":"low"}';
  editor.selectProfile(profile, 4); profile.containerUid = 9999; profile.readWriteDirs.push('/not-copied');
  expect(editor.fields).toContain('container');
  expect(editor.values).toMatchObject({ harness: 'fixture', provider: 'provider-a', model: 'model-a', options: '{"thinking":"low"}' });
  const settings = editor.params().settings as any;
  expect(settings.extensions.podman).toMatchObject({ image: 'pi:v2', profile: { id: 'coding', name: 'Coding', revision: 4 },
    runtime: { network: 'none', containerUid: 2000, containerGid: 2001, env: ['PUBLIC_CONFIG'] }, readWriteDirs: ['/project'], readOnlyVolumes: ['config'] });
  const persisted = agent('worker', null, { settings });
  const modify = new AgentEditor(null, persisted, true, [], true, true); modify.values.readOnlyVolumes = '[]';
  expect(modify.fields).toContain('container');
  expect(modify.values.container).toBe('Coding');
  expect((modify.params().settings as any).extensions.podman.runtime).toEqual(settings.extensions.podman.runtime);
  expect((modify.params().settings as any).extensions.podman.profile).toEqual(settings.extensions.podman.profile);
  modify.selectProfile(profile, 5);
  expect((modify.params().settings as any).extensions.podman.profile.revision).toBe(5);
  expect((editor.params().settings as any).extensions.podman.runtime.containerUid).toBe(2000);
});

test('raw extension image edits still request propagation scopes and conflict with container selection', () => {
  const record = agent('worker', null, { settings: { harness: 'pi', extensions: { podman: { image: 'pi:v1' } } } });
  const editor = new AgentEditor(null, record, true, [], false, true);
  expect(editor.imageChanged).toBe(false);
  editor.values.extensions = JSON.stringify({ podman: { image: 'pi:v2' } });
  expect(editor.imageChanged).toBe(true);
  expect(editor.params().settings).toMatchObject({ extensions: { podman: { image: 'pi:v2' } } });
  editor.selectProfile({ id: 'default', name: 'Default', image: 'pi:v3', network: 'none', containerUid: 1000, containerGid: 1000,
    env: [], cwd: '', readOnlyDirs: [], readWriteDirs: [], readOnlyVolumes: [], readWriteVolumes: [] }, 2);
  expect(() => editor.params()).toThrow('not both');
});

test('new root drafts select Default, while child drafts inherit without fetching server defaults', async () => {
  const profile: ContainerProfile = { id: 'default', name: 'Default', image: 'default:v1', network: 'pasta', containerUid: 1000, containerGid: 1000,
    env: [], cwd: '', readOnlyDirs: [], readWriteDirs: ['/default'], readOnlyVolumes: [], readWriteVolumes: [] };
  const parent = agent('root', null, { settings: { harness: 'pi', cwd: '/parent', extensions: { podman: { image: 'parent:v1' } } } });
  let requests = 0;
  // Exercise draft initialization without allocating terminal widgets.
  const open = async (target?: typeof parent) => {
    const ui = Object.create(UI.prototype) as any;
    Object.assign(ui, { editorRequest: 0, view: 'tree', createParent: () => target, setView: () => {}, session: {
      harnesses: ['pi'], serverCwd: '/server', podmanEnabled: true, settingsFields: [], podmanVolumesEnabled: true,
      podmanProfilesEnabled: true, podmanDefaultsEnabled: false,
      listProfiles: async () => { requests++; return { revision: 3, profiles: [profile] }; },
    } });
    await ui.openEditor(false, target);
    return ui.editor as AgentEditor;
  };
  const root = await open();
  expect(root.values.container).toBe('Default');
  expect(root.params().settings).toMatchObject({ extensions: { podman: { image: 'default:v1', profile: { id: 'default', revision: 3 } } } });
  expect(requests).toBe(1);
  const child = await open(parent);
  expect(requests).toBe(1);
  expect(child.values.container).toBe('Inherited');
  expect(child.params()).toMatchObject({ parentId: 'root', settings: { cwd: '/parent/', extensions: { podman: { readOnlyDirs: [], readWriteDirs: [] } } } });
  const podman = (child.params().settings as any).extensions.podman;
  for (const key of ['image', 'runtime', 'profile', 'configGrants']) expect(podman).not.toHaveProperty(key);
});

test('Podman scopes use discovered client-only endpoint once and surface partial failures', async () => {
  const requests: any[] = [];
  let partial = false;
  const mock = await mockServer((socket, request) => {
    requests.push(request);
    if (request.method === 'organization.snapshot') respond(socket, request.id, { seq: 0, agents: [agent('root')], operations: [], capabilities: { plugins: { podman: { endpoints: { modify: 'podman.modify' } } } } });
    else if (request.method === 'events.history') respond(socket, request.id, { events: [], oldestSeq: 1, latestSeq: 0, expired: false });
    else if (request.method === 'podman.modify') respond(socket, request.id, { operations: [operation('completed')], errors: partial ? [{ agentId: 'child', message: 'stale revision' }] : [] });
  });
  const session = new Session(mock.path);
  const running = session.run();
  try {
    await waitFor(() => session.status === 'connected'); expect(session.podmanEnabled).toBe(true);
    const params = { agentId: 'root', expectedRevision: 4, settings: { extensions: { podman: { image: 'pi:v2', readOnlyDirs: ['/project'] } } } };
    for (const scope of ['node', 'inherited', 'all'] as const) await session.modifyPodman(params, scope);
    expect(requests.filter(r => r.method === 'podman.modify').map(r => r.params.imageScope)).toEqual(['node', 'inherited', 'all']);
    partial = true;
    await expect(session.modifyPodman(params, 'all')).rejects.toThrow('partially applied');
    expect(requests.filter(r => r.method === 'podman.modify')).toHaveLength(4);
    expect(requests.filter(r => r.method === 'agent.modify')).toHaveLength(0);
  } finally { session.close(); await running; await mock.close(); }
});

test('terminal container choices, not image fields, trigger the existing propagation scopes', async () => {
  const root = agent('root', null, { name: 'scope-root', settings: { harness: 'pi', cwd: '/project', extensions: { podman: { image: 'pi:v1', readOnlyDirs: ['/project'], readWriteDirs: [] } } } });
  const changes: any[] = [];
  let selectedImage = 'pi:v2';
  const mock = await mockServer((socket, request) => {
    if (request.method === 'organization.snapshot') respond(socket, request.id, { seq: 0, agents: [root], operations: [], capabilities: { harnesses: ['pi'], plugins: { podman: { endpoints: { modify: 'podman.modify', profiles: 'podman.profiles' }, modelDiscovery: false } } } });
    else if (request.method === 'events.history') respond(socket, request.id, { events: [], oldestSeq: 1, latestSeq: 0, expired: false });
    else if (request.method === 'podman.profiles') respond(socket, request.id, { revision: 1, profiles: [
      { id: 'default', name: 'Default', image: 'pi:v1', network: 'pasta', containerUid: 1000, containerGid: 1000, env: [], cwd: '', readOnlyDirs: [], readWriteDirs: [], readOnlyVolumes: [], readWriteVolumes: [] },
      { id: 'coding', name: 'Coding', image: selectedImage, network: 'none', containerUid: 1000, containerGid: 1000, env: [], cwd: '', readOnlyDirs: ['/project'], readWriteDirs: [], readOnlyVolumes: [], readWriteVolumes: [] },
    ] });
    else if (request.method === 'podman.modify') {
      changes.push(request.params); root.settings.extensions = request.params.settings.extensions; root.revision++;
      respond(socket, request.id, { operations: [{ ...operation('completed'), id: `image-${changes.length}` }], errors: [] });
    }
  });
  const terminal = new xterm.Terminal({ cols: 110, rows: 30, allowProposedApi: true });
  const screen = () => Array.from({ length: 30 }, (_, i) => terminal.buffer.active.getLine(i)?.translateToString(true) ?? '').join('\n');
  const child = spawn('script', ['-qefc', `stty cols 110 rows 30; exec node_modules/.bin/tsx src/main.ts --socket '${mock.path}' --config '${join(mock.directory, 'settings.json')}'`, '/dev/null'], { cwd: join(import.meta.dirname, '..'), env: { ...process.env, TERM: 'xterm-256color', LANG: 'C.UTF-8' }, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdout.on('data', data => terminal.write(data));
  const keys = (text: string) => child.stdin.write(text);
  const visible = async (text: string) => {
    try { await waitFor(() => screen().includes(text), 5000); }
    catch { throw new Error(`Missing ${text}; exit=${child.exitCode}\n${screen()}`); }
  };
  try {
    await visible('scope-root');
    for (const [index, scope] of (['node', 'inherited', 'all'] as const).entries()) {
      selectedImage = `pi:v${index + 2}`;
      keys('e'); await visible('Modify agent');
      keys('\x1b[B'.repeat(9) + '\r'); await visible('Container');
      await visible('select an available option');
      keys('\x1b[B\r'); await visible('Modify agent');
      expect(screen()).toContain('Coding');
      keys('S'); await visible('Image change · choose');
      expect(changes).toHaveLength(index);
      keys('\x1b[B'.repeat(index) + '\r');
      await waitFor(() => changes.length === index + 1);
      expect(changes[index].imageScope).toBe(scope);
      expect(changes[index].settings.extensions.podman.image).toBe(selectedImage);
      await visible('LATEST TRACKED EVENT');
    }
  } finally {
    keys('\x03');
    await waitFor(() => child.exitCode !== null || child.signalCode !== null, 3000).catch(() => child.kill('SIGTERM'));
    await mock.close(); terminal.dispose();
  }
}, 30_000);

