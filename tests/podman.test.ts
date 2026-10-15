import { expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import xterm from '@xterm/headless';
import type { ContainerProfile } from '../src/protocol.js';
import { AgentEditor } from '../src/agent-editor.js';
import { Session } from '../src/session.js';
import { agent, mockServer, operation, respond, waitFor } from './helpers.js';

test('Podman editor has explicit empty grants, inheritance and isolated namespace replacement', () => {
  const create = new AgentEditor('root', undefined, true);
  create.values.harness = 'pi'; create.values.cwd = '/project';
  expect(create.fields).toContain('containerImage');
  expect(create.params().settings).toMatchObject({ extensions: { podman: { image: null, readOnlyDirs: [], readWriteDirs: [] } } });
  const record = agent('worker', 'root', { revision: 4, settings: { harness: 'pi', cwd: '/project', extensions: { skills: { test: 'installed' }, podman: { readOnlyDirs: ['/credentials'], readWriteDirs: ['/project'] } } } });
  const editor = new AgentEditor('root', record, true);
  editor.values.containerImage = 'pi:v2';
  expect(editor.imageChanged).toBe(true);
  expect(editor.params()).toEqual({ agentId: 'worker', expectedRevision: 4, settings: { extensions: { skills: { test: 'installed' }, podman: { image: 'pi:v2', readOnlyDirs: ['/credentials'], readWriteDirs: ['/project'] } } } });
  editor.values.containerImage = '';
  expect(editor.imageChanged).toBe(false);
  editor.values.readOnlyDirs = 'bad json'; expect(() => editor.params()).toThrow('JSON array');
  editor.values.readOnlyDirs = '[4]'; expect(() => editor.params()).toThrow('JSON array');
  editor.values.readOnlyDirs = '["/external"]'; expect(editor.params().settings).toMatchObject({ extensions: { podman: { readOnlyDirs: ['/external'] } } });
  const raw = new AgentEditor('root', record, true);
  raw.values.extensions = '{"podman":{"image":"raw:v2","readOnlyDirs":["/project"]}}';
  expect(raw.imageChanged).toBe(true);
  raw.values.containerImage = 'other:v2'; expect(() => raw.params()).toThrow('not both');
  expect(new AgentEditor(null).fields).not.toContain('containerImage');
});

test('selecting a container configuration snapshots its runtime and grants without changing harness settings', () => {
  const profile: ContainerProfile = { id: 'coding', name: 'Coding', image: 'pi:v2', network: 'none', containerUid: 2000, containerGid: 2001,
    env: ['PUBLIC_CONFIG'], cwd: '/project', readOnlyDirs: ['/configuration'], readWriteDirs: ['/project'], readOnlyVolumes: ['config'], readWriteVolumes: [] };
  const editor = new AgentEditor(null, undefined, true, [], true, true);
  editor.values.harness = 'fixture'; editor.values.provider = 'provider-a'; editor.values.model = 'model-a'; editor.values.options = '{"thinking":"low"}';
  editor.selectProfile(profile, 4); profile.containerUid = 9999; profile.readWriteDirs.push('/not-copied');
  expect(editor.fields).toContain('containerProfile');
  expect(editor.values).toMatchObject({ harness: 'fixture', provider: 'provider-a', model: 'model-a', options: '{"thinking":"low"}' });
  const settings = editor.params().settings as any;
  expect(settings.extensions.podman).toMatchObject({ image: 'pi:v2', profile: { id: 'coding', name: 'Coding', revision: 4 },
    runtime: { network: 'none', containerUid: 2000, containerGid: 2001, env: ['PUBLIC_CONFIG'] }, readWriteDirs: ['/project'], readOnlyVolumes: ['config'] });
  const persisted = agent('worker', null, { settings });
  const modify = new AgentEditor(null, persisted, true, [], true, true); modify.values.readOnlyVolumes = '[]';
  expect(modify.fields).toContain('containerProfile');
  expect(modify.values.containerProfile).toBe('Coding');
  expect((modify.params().settings as any).extensions.podman.runtime).toEqual(settings.extensions.podman.runtime);
  expect((modify.params().settings as any).extensions.podman.profile).toEqual(settings.extensions.podman.profile);
  modify.selectProfile(profile, 5);
  expect((modify.params().settings as any).extensions.podman.profile.revision).toBe(5);
  editor.selectProfile(undefined); expect((editor.params().settings as any).extensions.podman.runtime).toBeUndefined();
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

test('terminal image edits explicitly ask for all three propagation scopes', async () => {
  const root = agent('root', null, { name: 'scope-root', settings: { harness: 'pi', cwd: '/project', extensions: { podman: { image: 'pi:v1', readOnlyDirs: ['/project'], readWriteDirs: [] } } } });
  const changes: any[] = [];
  const mock = await mockServer((socket, request) => {
    if (request.method === 'organization.snapshot') respond(socket, request.id, { seq: 0, agents: [root], operations: [], capabilities: { harnesses: ['pi'], plugins: { podman: { endpoints: { modify: 'podman.modify' }, modelDiscovery: false } } } });
    else if (request.method === 'events.history') respond(socket, request.id, { events: [], oldestSeq: 1, latestSeq: 0, expired: false });
    else if (request.method === 'podman.modify') {
      changes.push(request.params); root.settings.extensions = request.params.settings.extensions; root.revision++;
      respond(socket, request.id, { operations: [{ ...operation('completed'), id: `image-${changes.length}` }], errors: [] });
    }
  });
  const terminal = new xterm.Terminal({ cols: 110, rows: 30, allowProposedApi: true });
  const screen = () => Array.from({ length: 30 }, (_, i) => terminal.buffer.active.getLine(i)?.translateToString(true) ?? '').join('\n');
  const child = spawn('script', ['-qefc', `stty cols 110 rows 30; exec bun src/main.ts --socket '${mock.path}' --config '${join(mock.directory, 'settings.json')}'`, '/dev/null'], { cwd: join(import.meta.dir, '..'), env: { ...process.env, TERM: 'xterm-256color', LANG: 'C.UTF-8' }, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdout.on('data', data => terminal.write(data));
  const keys = (text: string) => child.stdin.write(text);
  const visible = async (text: string) => {
    try { await waitFor(() => screen().includes(text), 5000); }
    catch { throw new Error(`Missing ${text}; exit=${child.exitCode}\n${screen()}`); }
  };
  try {
    await visible('scope-root');
    for (const [index, scope] of (['node', 'inherited', 'all'] as const).entries()) {
      keys('e'); await visible('Modify agent');
      keys('\x1b[B'.repeat(9) + '\r'); await visible('Edit containerImage');
      keys('\x15' + `pi:v${index + 2}` + '\r'); await visible('Modify agent');
      keys('\x1b[B'.repeat(3) + '\r'); await visible('Image change · choose');
      expect(changes).toHaveLength(index);
      keys('\x1b[B'.repeat(index) + '\r');
      await waitFor(() => changes.length === index + 1);
      expect(changes[index].imageScope).toBe(scope);
      expect(changes[index].settings.extensions.podman.readOnlyDirs).toEqual(['/project']);
      await visible('LATEST TRACKED EVENT');
    }
  } finally {
    keys('\x03');
    await waitFor(() => child.exitCode !== null || child.signalCode !== null, 3000).catch(() => child.kill('SIGTERM'));
    await mock.close(); terminal.dispose();
  }
}, 30_000);

