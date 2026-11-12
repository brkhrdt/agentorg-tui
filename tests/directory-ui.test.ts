import { expect, test } from 'vitest';
import { agent, mockServer, operation, respond, waitFor } from './helpers.js';
import { terminalClient } from './terminal.js';

test('cwd-only edit submits once, updates the snapshot, and reopens with all grants intact', async () => {
  const root = agent('root', null, { name: 'grant-preservation-root', settings: { harness: 'fixture', cwd: '/before', extensions: {
    podman: { image: 'fixture:v1', profile: { id: 'profile', name: 'Profile' }, runtime: { network: 'none' },
      configGrants: { readOnlyDirs: ['/configured-ro'], readWriteDirs: ['/configured-rw'], readOnlyVolumes: ['config-ro'], readWriteVolumes: ['config-rw'] },
      readOnlyDirs: ['/ro'], readWriteDirs: ['/rw-one', '/rw-two'], readOnlyVolumes: ['data-ro'], readWriteVolumes: ['data-rw'] },
    sibling: { retained: true },
  } } });
  const changes: any[] = [], snapshots: any[] = [];
  const mock = await mockServer((socket, request) => {
    if (request.method === 'organization.snapshot') {
      snapshots.push(structuredClone(root));
      respond(socket, request.id, { seq: snapshots.length - 1, agents: [root], operations: [], capabilities: { harnesses: ['fixture'] } });
    } else if (request.method === 'events.history') respond(socket, request.id, { events: [], oldestSeq: 1, latestSeq: 0, expired: false });
    else if (request.method === 'agent.modify') {
      changes.push(structuredClone(request.params));
      root.settings = { ...root.settings, ...request.params.settings };
      root.revision++;
      respond(socket, request.id, operation('completed'));
    }
  });
  const ui = terminalClient(mock.path, mock.directory, { cols: 100, rows: 30 });
  const { keys, visible, screen } = ui;
  try {
    await visible('grant-preservation-root'); keys('e'); await visible('Modify agent');
    keys('\x1b[B'.repeat(4) + '\r'); await visible('Edit cwd · text');
    keys('\x15/after'); keys('\r'); await visible('Modify agent');
    expect(changes).toHaveLength(0);
    keys('S'); await visible('grant-preservation-root');
    await waitFor(() => changes.length === 1 && snapshots.at(-1)?.revision === 2);
    expect(changes).toEqual([{ agentId: 'root', expectedRevision: 1, settings: { cwd: '/after' } }]);
    expect(snapshots).toHaveLength(2);
    expect(root.settings.cwd).toBe('/after');
    const podman = root.settings.extensions!.podman as any;
    expect(podman).toMatchObject({ readOnlyDirs: ['/ro'], readWriteDirs: ['/rw-one', '/rw-two'], readOnlyVolumes: ['data-ro'], readWriteVolumes: ['data-rw'],
      profile: { id: 'profile', name: 'Profile' }, runtime: { network: 'none' },
      configGrants: { readOnlyDirs: ['/configured-ro'], readWriteDirs: ['/configured-rw'], readOnlyVolumes: ['config-ro'], readWriteVolumes: ['config-rw'] } });
    expect(root.settings.extensions!.sibling).toEqual({ retained: true });
    keys('e'); await visible('Modify agent · revision 2');
    for (const [field, count] of [['readOnlyDirs', '1 directory'], ['readWriteDirs', '2 directories'], ['readOnlyVolumes', '1 volume'], ['readWriteVolumes', '1 volume']]) {
      expect(screen().split('\n').some(line => line.includes(field) && line.includes(count))).toBe(true);
    }
    expect(changes).toHaveLength(1);
  } finally { await ui.close(); await mock.close(); }
}, 30_000);

test('Podman grants reuse server cwd completion for add/edit/remove without creating directories', async () => {
  const root = agent('root', null, { name: 'directory-root', settings: { harness: 'fixture', cwd: '/project', extensions: { podman: { image: null, readOnlyDirs: ['/existing'], readWriteDirs: ['/project'] }, other: { preserved: true } } } });
  const paths: any[] = [], changes: any[] = [];
  const mock = await mockServer((socket, request) => {
    if (request.method === 'organization.snapshot') respond(socket, request.id, { seq: 0, agents: [root], operations: [], capabilities: { cwd: '/server/start', pathCompletion: true, harnesses: ['fixture'], plugins: { podman: { endpoints: { modify: 'podman.modify' } } } } });
    else if (request.method === 'events.history') respond(socket, request.id, { events: [], latestSeq: 0 });
    else if (request.method === 'organization.paths') {
      paths.push(request.params);
      const input = request.params.input;
      const result = { path: input.replace(/\/$/, ''), isDirectory: !input.endsWith('missing'), entries: [{ name: 'src', path: '/server/start/src', kind: 'directory' }, { name: 'space dir', path: '/server/start/space dir', kind: 'directory' }] };
      if (input.endsWith('slow')) setTimeout(() => respond(socket, request.id, { ...result, entries: [{ name: 'STALE', path: '/stale', kind: 'directory' }] }), 400);
      else respond(socket, request.id, result);
    } else if (request.method === 'agent.modify') { changes.push(request.params); respond(socket, request.id, operation('completed')); }
  });
  const ui = terminalClient(mock.path, mock.directory);
  const { keys, visible, screen } = ui;
  try {
    await visible('directory-root'); keys('e'); await visible('Modify agent');
    keys('\x1b[B'.repeat(9) + '\r'); await visible('Edit readOnlyDirs · list / map');
    await visible('/existing'); keys('a'); await visible('Edit readOnlyDirs · value');
    await visible('space dir/'); expect(screen()).toContain('/server/start/');
    keys('\x15/server/start/missing\r'); await visible('Choose an existing server directory');
    expect(screen()).toContain('/server/start/missing'); expect(paths.at(-1).create).toBeUndefined();
    keys('\x15/server/start/slow'); await waitFor(() => paths.some(p => p.input.endsWith('slow')));
    keys('\x15/server/start/sr'); await visible('src/');
    keys('\t'); await visible('/server/start/src/');
    await new Promise(resolve => setTimeout(resolve, 500)); expect(screen()).not.toContain('STALE');
    keys(' '); await visible('Edit readOnlyDirs · list / map'); await visible('/server/start/src');
    keys('/'); await visible('Filter: type freely'); keys('src\x1b'); await visible('filter: src');
    keys('e'); await visible('Edit readOnlyDirs · value'); await visible('space dir/');
    keys('\x15/server/start/s'); await waitFor(() => paths.some(p => p.input === '/server/start/s')); await visible('space dir/');
    keys('\x1b[B\t'); await visible('/server/start/space dir/');
    keys('\r'); await visible('No matching entries'); // Existing filter no longer matches edited path.
    keys('/'); await visible('Filter: type freely'); keys('\x15existing\x1b'); await visible('filter: existing');
    keys('d'); await visible('No matching entries'); keys('S'); await visible('Modify agent');
    expect(changes).toHaveLength(0); keys('S'); await waitFor(() => changes.length === 1);
    expect(changes[0]).toEqual({ agentId: 'root', expectedRevision: 1, settings: { extensions: { other: { preserved: true }, podman: { executionEnvironment: 'container', image: null, readOnlyDirs: ['/server/start/space dir'], readWriteDirs: ['/project'] } } } });
    expect(paths.every(p => p.base === '/server/start' && p.kind === 'directory' && p.limit === 5 && !p.create)).toBe(true);
  } finally { await ui.close(); await mock.close(); }
}, 30_000);
