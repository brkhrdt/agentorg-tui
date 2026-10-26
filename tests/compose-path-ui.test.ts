import { expect, test } from 'bun:test';
import { agent, mockServer, operation, respond } from './helpers.js';
import { terminalClient } from './terminal.js';

for (const view of ['chat', 'prompt'] as const) {
  test(`${view} composer completes server-host paths relative to fixed recipient cwd`, async () => {
    const requests: any[] = [], prompts: any[] = [];
    const root = agent('root', null, { name: 'Root', settings: { harness: 'pi', cwd: '/srv/agent cwd' } });
    const mock = await mockServer((socket, request) => {
      requests.push(request);
      if (request.method === 'organization.snapshot') respond(socket, request.id, { seq: 0, agents: [root], operations: [], capabilities: { pathCompletion: true } });
      else if (request.method === 'events.history') respond(socket, request.id, { events: [], oldestSeq: 0, latestSeq: 0, expired: false, hasMore: false });
      else if (request.method === 'organization.paths') respond(socket, request.id, { path: request.params.input, isDirectory: false, entries: [
        { name: 'file name.txt', path: '/srv/agent cwd/file name.txt', kind: 'file' },
        { name: 'sub dir', path: '/srv/agent cwd/sub dir', kind: 'directory' },
      ] });
      else if (request.method === 'agent.prompt') { prompts.push(request.params); respond(socket, request.id, operation('completed')); }
    });
    const tui = terminalClient(mock.path, mock.directory, { cols: 80, rows: 24 });
    try {
      await tui.visible('Root');
      if (view === 'chat') { tui.keys('c'); await tui.visible('Chat · Root'); }
      else { tui.keys('\r'); await tui.visible('Interrupting prompt · Root'); }
      tui.keys('./fi'); await tui.visible('file name.txt');
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(requests.find(r => r.method === 'organization.paths')?.params).toEqual({ input: './fi', base: '/srv/agent cwd', kind: 'any', limit: 5 });
      tui.keys('\t'); await new Promise(resolve => setTimeout(resolve, 30));
      expect(tui.screen()).toContain('./file name.txt');
      tui.keys('note'); await new Promise(resolve => setTimeout(resolve, 100));
      expect(requests.filter(r => r.method === 'organization.paths')).toHaveLength(1);
      tui.keys('\r'); await new Promise(resolve => setTimeout(resolve, 50));
      expect(prompts[0]?.text).toBe('./file name.txt note');
    } finally { await tui.close(); await mock.close(); }
  });

  test(`${view} composer descends into directories and keeps exactly one slash`, async () => {
    const paths: any[] = [];
    const mock = await mockServer((socket, request) => {
      if (request.method === 'organization.snapshot') respond(socket, request.id, { seq: 0, agents: [agent('root', null, { name: 'Root', settings: { harness: 'pi', cwd: '/recipient' } })], operations: [], capabilities: { pathCompletion: true } });
      else if (request.method === 'events.history') respond(socket, request.id, { events: [], oldestSeq: 0, latestSeq: 0, expired: false, hasMore: false });
      else if (request.method === 'organization.paths') {
        paths.push(request.params);
        respond(socket, request.id, { path: request.params.input, isDirectory: true, entries: request.params.input === './sub' ? [{ name: 'sub dir', path: '/recipient/sub dir', kind: 'directory' }] : [{ name: 'child', path: '/recipient/sub dir/child', kind: 'file' }] });
      }
    });
    const tui = terminalClient(mock.path, mock.directory, { cols: 80, rows: 24 });
    try {
      await tui.visible('Root');
      if (view === 'chat') { tui.keys('c'); await tui.visible('Chat · Root'); }
      else { tui.keys('\r'); await tui.visible('Interrupting prompt · Root'); }
      tui.keys('./sub'); await tui.visible('sub dir'); tui.keys('\t'); await tui.visible('child');
      await new Promise(resolve => setTimeout(resolve, 120));
      expect(tui.screen()).toContain('./sub dir/');
      expect(paths.map(p => p.input)).toEqual(['./sub', './sub dir/']);
      expect(paths.every(p => p.base === '/recipient' && p.kind === 'any' && !p.create)).toBe(true);
    } finally { await tui.close(); await mock.close(); }
  });
}

test('only explicit ./ starts completion after prose; bare slash paths remain literal', async () => {
  const requests: any[] = [];
  const mock = await mockServer((socket, request) => {
    requests.push(request);
    if (request.method === 'organization.snapshot') respond(socket, request.id, { seq: 0, agents: [agent('root', null, { name: 'Root', settings: { harness: 'pi', cwd: '/recipient' } })], operations: [], capabilities: { pathCompletion: true } });
    else if (request.method === 'events.history') respond(socket, request.id, { events: [], oldestSeq: 0, latestSeq: 0, expired: false });
    else if (request.method === 'organization.paths') respond(socket, request.id, { path: request.params.input, isDirectory: false, entries: [] });
  });
  const tui = terminalClient(mock.path, mock.directory, { cols: 80, rows: 24 });
  try {
    await tui.visible('Root'); tui.keys('c'); await tui.visible('Chat · Root');
    tui.keys('hi /h'); await new Promise(resolve => setTimeout(resolve, 110));
    expect(requests.some(r => r.method === 'organization.paths')).toBe(false);
    tui.keys(' ./'); await new Promise(resolve => setTimeout(resolve, 110));
    expect(requests.find(r => r.method === 'organization.paths')?.params.input).toBe('./');
  } finally { await tui.close(); await mock.close(); }
});

test('path completion is not requested when server capability is absent', async () => {
  const requests: any[] = [];
  const mock = await mockServer((socket, request) => {
    requests.push(request);
    if (request.method === 'organization.snapshot') respond(socket, request.id, { seq: 0, agents: [agent('root', null, { name: 'Root' }), agent('beta', 'root', { name: 'Beta' })], operations: [] });
    else if (request.method === 'events.history') respond(socket, request.id, { events: [], oldestSeq: 0, latestSeq: 0, expired: false, hasMore: false });
  });
  const tui = terminalClient(mock.path, mock.directory, { cols: 80, rows: 24 });
  try {
    await tui.visible('Root'); tui.keys('c'); await tui.visible('Chat · Root');
    tui.keys('./'); await new Promise(resolve => setTimeout(resolve, 120));
    expect(requests.some(r => r.method === 'organization.paths')).toBe(false); expect(tui.screen()).toContain('./');
    tui.keys('\x1b'); await tui.visible('AGENT');
  } finally { await tui.close(); await mock.close(); }
});

test('first Escape dismisses a path completion without discarding its draft', async () => {
  const mock = await mockServer((socket, request) => {
    if (request.method === 'organization.snapshot') respond(socket, request.id, { seq: 0, agents: [agent('root', null, { name: 'Root', settings: { harness: 'pi', cwd: '/root' } })], operations: [], capabilities: { pathCompletion: true } });
    else if (request.method === 'events.history') respond(socket, request.id, { events: [], oldestSeq: 0, latestSeq: 0, expired: false, hasMore: false });
    else if (request.method === 'organization.paths') respond(socket, request.id, { path: './a', isDirectory: false, entries: [{ name: 'alpha', path: '/root/alpha', kind: 'file' }] });
  });
  const tui = terminalClient(mock.path, mock.directory, { cols: 80, rows: 24 });
  try {
    await tui.visible('Root'); tui.keys('c'); await tui.visible('Chat · Root');
    tui.keys('./a'); await tui.visible('alpha'); tui.keys('\x1b'); await new Promise(resolve => setTimeout(resolve, 30));
    expect(tui.screen()).toContain('Chat · Root'); expect(tui.screen()).toContain('./a');
    tui.keys('\x1b'); await tui.visible('AGENT');
  } finally { await tui.close(); await mock.close(); }
});
