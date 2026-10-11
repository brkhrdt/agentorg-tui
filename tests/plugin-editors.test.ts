import { expect, test } from 'bun:test';
import { AgentEditor } from '../src/agent-editor.js';
import { pluginFields } from '../src/structured-editor.js';
import { Session } from '../src/session.js';
import { agent, mockServer, operation, respond, waitFor } from './helpers.js';
import { terminalClient } from './terminal.js';

const descriptors = { demo: { fields: [
  { key: 'tags', editor: 'list', label: 'Tags' },
  { key: 'inputs', editor: 'paths', label: 'Input files' },
  { key: 'retries', editor: 'number' },
  { key: 'enabled', editor: 'boolean' },
  { key: 'config', editor: 'path' },
  { key: 'secret', editor: 'text', sensitive: true },
] } };

test('generic descriptors preserve sibling fields, absent fields, revision fences and opaque namespaces', () => {
  const specs = pluginFields(descriptors);
  const root = agent('root', null, { revision: 7, settings: { harness: 'fixture', extensions: { demo: { tags: ['old'], keep: { opaque: 42 } }, other: { keep: true } } } });
  const editor = new AgentEditor(null, root, false, specs);
  expect(editor.fields).toContain('plugin:demo:inputs'); expect(editor.label('plugin:demo:inputs')).toBe('demo.Input files');
  expect(() => editor.params()).toThrow('No changes');
  editor.stage('plugin:demo:tags', '["new"]'); editor.stage('plugin:demo:enabled', 'false');
  expect(editor.params()).toEqual({ agentId: 'root', expectedRevision: 7, settings: { extensions: { demo: { tags: ['new'], keep: { opaque: 42 }, enabled: false } } } });
  expect(() => editor.stage('plugin:demo:retries', 'invalid')).toThrow('number');
  editor.stage('plugin:demo:retries', '5'); expect(editor.params().settings).toMatchObject({ extensions: { demo: { retries: 5 } } });
  editor.values.extensions = '{"demo":{"tags":["raw"]}}'; expect(() => editor.params()).toThrow('not both');
  const create = new AgentEditor(null, undefined, false, specs); create.values.harness = 'fixture';
  expect(create.params().settings).toMatchObject({ extensions: {} });
  create.stage('plugin:demo:tags', '[]'); expect(create.params().settings).toMatchObject({ extensions: { demo: { tags: [] } } });
  const opaque = new AgentEditor(null, agent('root', null, { settings: { harness: 'fixture', extensions: { demo: ['opaque'] } } }), false, specs);
  opaque.stage('plugin:demo:tags', '[]'); expect(() => opaque.params()).toThrow('not an object');
  const podman = new AgentEditor(null, undefined, true, pluginFields({ podman: { fields: [{ key: 'readOnlyDirs', editor: 'directories' }] } }));
  expect(podman.fields.filter(field => field.includes('readOnlyDirs'))).toEqual(['readOnlyDirs']);
  expect(pluginFields({ demo: { fields: [{ key: 'future', editor: 'new-kind' }, { key: 'x', editor: 'list' }, { key: 'x', editor: 'text' }, { key: '', editor: 'list' }] } })).toEqual([{ namespace: 'demo', key: 'x', editor: 'list' }]);
});

test('session discovers plugin editor hints without plugin endpoints', async () => {
  const mock = await mockServer((socket, request) => {
    if (request.method === 'organization.snapshot') respond(socket, request.id, { seq: 0, agents: [], operations: [], capabilities: { settingsEditors: descriptors } });
    else if (request.method === 'events.history') respond(socket, request.id, { events: [], latestSeq: 0 });
  });
  const session = new Session(mock.path); const running = session.run();
  try { await waitFor(() => session.status === 'connected'); expect(session.settingsFields).toEqual(pluginFields(descriptors)); }
  finally { session.close(); await running; await mock.close(); }
});

test('future plugin lists, file paths and typed scalar fields use the existing terminal editors', async () => {
  const root = agent('root', null, { name: 'plugin-root', revision: 8, settings: { harness: 'fixture', extensions: { demo: { tags: ['old'], inputs: [], retries: 3, secret: 'secret-plugin-value', keep: { opaque: 42 } }, other: { preserved: true } } } });
  const changes: any[] = [], paths: any[] = [];
  const mock = await mockServer((socket, request) => {
    if (request.method === 'organization.snapshot') respond(socket, request.id, { seq: 0, agents: [root], operations: [], capabilities: { cwd: '/server/start', pathCompletion: true, harnesses: ['fixture'], settingsEditors: descriptors } });
    else if (request.method === 'events.history') respond(socket, request.id, { events: [], latestSeq: 0 });
    else if (request.method === 'organization.paths') {
      paths.push(request.params);
      respond(socket, request.id, { path: request.params.input.replace(/\/$/, ''), isDirectory: false, entries: [{ name: 'input.txt', path: '/server/start/input.txt', kind: 'file' }, { name: 'folder', path: '/server/start/folder', kind: 'directory' }] });
    } else if (request.method === 'agent.modify') { changes.push(request.params); respond(socket, request.id, operation('completed')); }
  });
  const ui = terminalClient(mock.path, mock.directory); const { keys, visible, screen } = ui;
  try {
    await visible('plugin-root'); keys('e'); await visible('Modify agent · revision 8');
    await visible('demo.Input files'); expect(screen()).not.toContain('secret-plugin-value');
    keys('\x1b[B'.repeat(9) + '\r'); await visible('Edit demo.Tags · list / map');
    keys('a'); await visible('Edit demo.Tags · value'); keys('new tag\r'); await visible('new tag');
    keys('S'); await visible('Modify agent'); keys('\x1b[B\r'); await visible('Edit demo.Input files · list / map');
    keys('a'); await visible('Edit demo.Input files · value'); await visible('input.txt');
    keys('\t'); await visible('/server/start/input.txt'); expect(screen()).not.toContain('/server/start/input.txt/');
    keys('\r'); await visible('Edit demo.Input files · list / map'); keys('S'); await visible('Modify agent');
    keys('\x1b[B\r'); await visible('Edit demo.retries · number'); keys('\x15bad\r'); await visible('valid number');
    keys('\x156\r'); await visible('Modify agent'); keys('\x1b[B\r'); await visible('Edit demo.enabled · boolean');
    keys('\x15true\r'); await visible('Modify agent'); keys('\x1b[B\r'); await visible('Edit demo.config · path');
    await visible('input.txt'); keys('\t\r'); await visible('Modify agent');
    keys('?'); await visible('Keys · agent-edit'); keys('S'); await waitFor(() => changes.length === 1);
    expect(changes[0]).toEqual({ agentId: 'root', expectedRevision: 8, settings: { extensions: { demo: { tags: ['old', 'new tag'], inputs: ['/server/start/input.txt'], retries: 6, enabled: true, config: '/server/start/input.txt', secret: 'secret-plugin-value', keep: { opaque: 42 } } } } });
    expect(paths.every(p => p.kind === 'any' && p.base === '/server/start' && !p.create)).toBe(true);
  } finally { await ui.close(); await mock.close(); }
}, 30_000);
