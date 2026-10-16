import { expect, test } from 'bun:test';
import { AgentEditor } from '../src/agent-editor.js';
import { filterVolumes } from '../src/volume-input.js';
import { Session } from '../src/session.js';
import { agent, mockServer, operation, respond, send, waitFor } from './helpers.js';
import { terminalClient } from './terminal.js';

const choices = [
  { name: 'pi-main', destination: '/home/pi/.pi', description: 'Shared credentials', readOnly: false },
  { name: 'pi-secondary', destination: '/home/pi/.pi', readOnly: false },
  { name: 'claude', destination: '/home/pi/.claude', readOnly: true },
];
test('volume fields are arrays, preserve grants on container edits, and suppress duplicate generic descriptors', () => {
  const root = agent('root', null, { settings: { harness: 'pi', cwd: '/project', extensions: { podman: { readOnlyDirs: ['/project'], readOnlyVolumes: ['pi-main'], readWriteVolumes: [] } } } });
  const editor = new AgentEditor(null, root, true, [
    { namespace: 'podman', key: 'readOnlyVolumes', editor: 'list' },
  ], true);
  expect(editor.fields.filter(field => field.includes('readOnlyVolumes'))).toEqual(['readOnlyVolumes']);
  editor.values.readWriteDirs = '["/project", "/workspace"]';
  expect(editor.params().settings).toMatchObject({ extensions: { podman: { readOnlyVolumes: ['pi-main'], readWriteVolumes: [] } } });
  expect(filterVolumes(choices, 'pm', false).map(v => v.name)).toEqual(['pi-main']);
  expect(filterVolumes(choices, '', true).map(v => v.name)).toEqual(['pi-main', 'pi-secondary']);
});

test('volume discovery uses the advertised server endpoint, never local Podman', async () => {
  const requests: string[] = [];
  const mock = await mockServer((socket, request) => {
    requests.push(request.method);
    if (request.method === 'organization.snapshot') respond(socket, request.id, { seq: 0, agents: [], operations: [], capabilities: { plugins: { podman: { endpoints: { modify: 'podman.modify', volumes: 'custom.volumes' } } } } });
    else if (request.method === 'events.history') respond(socket, request.id, { events: [], latestSeq: 0 });
    else if (request.method === 'custom.volumes') respond(socket, request.id, { volumes: choices });
  });
  const session = new Session(mock.path); const running = session.run();
  try {
    await waitFor(() => session.status === 'connected');
    expect(session.podmanVolumesEnabled).toBe(true);
    expect(await session.listVolumes()).toEqual(choices);
    expect(requests).toContain('custom.volumes');
  } finally { session.close(); await running; await mock.close(); }
});

test('terminal volumes support fuzzy choices, arrow selection, Tab/Enter staging, removal and fail-closed discovery', async () => {
  const root = agent('root', null, { name: 'volume-root', settings: { harness: 'fixture', cwd: '/project', extensions: { podman: { readOnlyDirs: ['/project'], readOnlyVolumes: ['claude'], readWriteVolumes: [] }, other: { preserved: true } } } });
  const changes: any[] = []; let fail = false, discovers = 0;
  const mock = await mockServer((socket, request) => {
    if (request.method === 'organization.snapshot') respond(socket, request.id, { seq: 0, agents: [root], operations: [], capabilities: { harnesses: ['fixture'], plugins: { podman: { endpoints: { modify: 'podman.modify', volumes: 'podman.volumes' } } }, settingsEditors: { podman: { fields: [{ key: 'readOnlyVolumes', editor: 'list' }] } } } });
    else if (request.method === 'events.history') respond(socket, request.id, { events: [], latestSeq: 0 });
    else if (request.method === 'podman.volumes') {
      discovers++;
      if (fail) send(socket, { kind: 'response', id: request.id, ok: false, error: { code: 'UNAVAILABLE', message: 'Volume discovery unavailable' } });
      else respond(socket, request.id, { volumes: choices });
    } else if (request.method === 'agent.modify') { changes.push(request.params); respond(socket, request.id, operation('completed')); }
  });
  const ui = terminalClient(mock.path, mock.directory); const { keys, visible, screen } = ui;
  try {
    await visible('volume-root'); keys('e'); await visible('Modify agent');
    keys('\x1b[B'.repeat(11) + '\r'); await visible('Edit readOnlyVolumes · list / map');
    keys('a'); await visible('Shared credentials');
    keys('pm'); await visible('pi-main →');
    await new Promise(resolve => setTimeout(resolve, 150)); expect(screen()).not.toContain('pi-secondary →');
    keys('\t'); await visible('pi-main'); keys('\r'); await visible('Edit readOnlyVolumes · list / map');
    keys('e'); await visible('Edit readOnlyVolumes · value'); // Selected claude, edit it to pi-secondary.
    keys('\x15pi'); await visible('pi-secondary →'); keys('\x1b[B\r'); await visible('Edit readOnlyVolumes · list / map');
    await visible('pi-secondary'); keys('d'); await visible('pi-main');
    fail = true; keys('a'); await visible('Volume discovery unavailable');
    keys('arbitrary'); await visible('Volume discovery unavailable'); keys('\r'); await visible('Choose an eligible server volume');
    expect(screen()).toContain('arbitrary');
    keys('\x1b'); await visible('Edit readOnlyVolumes · list / map');
    expect(changes).toHaveLength(0); keys('S'); await visible('Modify agent'); keys('S');
    await waitFor(() => changes.length === 1);
    expect(changes[0].settings.extensions).toMatchObject({ other: { preserved: true }, podman: { readOnlyDirs: ['/project'], readOnlyVolumes: ['pi-main'], readWriteVolumes: [] } });
    expect(discovers).toBeGreaterThan(3);
  } finally { await ui.close(); await mock.close(); }
}, 30_000);

test('terminal users can select a newly created host volume and register its container destination', async () => {
  const root = agent('root', null, { name: 'host-volume-root', settings: { harness: 'fixture', cwd: '/project', extensions: { podman: { readWriteDirs: ['/project'], readOnlyVolumes: [], readWriteVolumes: [] } } } });
  const registrations: any[] = [], changes: any[] = [];
  const mock = await mockServer((socket, request) => {
    if (request.method === 'organization.snapshot') respond(socket, request.id, { seq: 0, agents: [root], operations: [], capabilities: { harnesses: ['fixture'], plugins: { podman: { endpoints: { modify: 'podman.modify', volumes: 'podman.volumes', configureVolume: 'podman.volume.configure' } } } } });
    else if (request.method === 'events.history') respond(socket, request.id, { events: [], latestSeq: 0 });
    else if (request.method === 'podman.volumes') respond(socket, request.id, { volumes: [{ name: 'pi-host', readOnly: false }] });
    else if (request.method === 'podman.volume.configure') {
      registrations.push(request.params);
      if (request.params.destination === '/usr') send(socket, { kind: 'response', id: request.id, ok: false, error: { code: 'FORBIDDEN', message: 'Protected container runtime path' } });
      else respond(socket, request.id, { ...request.params, readOnly: false });
    } else if (request.method === 'agent.modify') { changes.push(request.params); respond(socket, request.id, operation('completed')); }
  });
  const ui = terminalClient(mock.path, mock.directory); const { keys, visible, screen } = ui;
  try {
    await visible('host-volume-root'); keys('e'); await visible('Modify agent');
    keys('\x1b[B'.repeat(11) + '\r'); await visible('Edit readOnlyVolumes · list / map');
    keys('a'); await visible('pi-host → (choose container destination)');
    keys('\r'); await visible('Container destination · pi-host');
    keys('/usr\r'); await visible('Protected container runtime path'); expect(screen()).toContain('/usr');
    keys('\x15/home/pi/.pi\r'); await visible('Edit readOnlyVolumes · list / map');
    expect(registrations).toEqual([{ name: 'pi-host', destination: '/usr' }, { name: 'pi-host', destination: '/home/pi/.pi' }]);
    expect(changes).toHaveLength(0); // Destination registration is not an agent grant.
    keys('S'); await visible('Modify agent'); keys('S'); await waitFor(() => changes.length === 1);
    expect(changes[0].settings.extensions.podman.readOnlyVolumes).toEqual(['pi-host']);
    expect(changes[0].settings.extensions.podman.readWriteDirs).toEqual(['/project']);
  } finally { await ui.close(); await mock.close(); }
}, 30_000);
