import { expect, test } from 'bun:test';
import { agent, mockServer, operation, respond } from './helpers.js';
import { terminalClient } from './terminal.js';

for (const view of ['chat', 'prompt'] as const) {
  test(`${view} composer completes a later path trigger without replacing its prefix`, async () => {
    const inputs: string[] = [];
    const mock = await mockServer((socket, request) => {
      if (request.method === 'organization.snapshot') respond(socket, request.id, { seq: 0, agents: [agent('root', null, { name: 'Root', settings: { harness: 'pi', cwd: '/recipient' } })], operations: [], capabilities: { pathCompletion: true } });
      else if (request.method === 'events.history') respond(socket, request.id, { events: [], oldestSeq: 0, latestSeq: 0, expired: false, hasMore: false });
      else if (request.method === 'organization.paths') {
        inputs.push(request.params.input);
        const entries = request.params.input === './' ? [{ name: 'new file.txt', path: '/recipient/new file.txt', kind: 'file' }] : [];
        respond(socket, request.id, { path: request.params.input, isDirectory: false, entries });
      }
    });
    const tui = terminalClient(mock.path, mock.directory, { cols: 80, rows: 24 });
    try {
      await tui.visible('Root');
      if (view === 'chat') { tui.keys('c'); await tui.visible('Chat · Root'); }
      else { tui.keys('\r'); await tui.visible('Prompt · Root'); }
      tui.keys('./notafile'); await tui.visible('No matching paths');
      tui.keys(' ./'); await tui.visible('new file.txt');
      expect(inputs).toEqual(['./notafile', './']);
      tui.keys('\t'); await new Promise(resolve => setTimeout(resolve, 30));
      expect(tui.screen()).toContain('./notafile ./new file.txt');
    } finally { await tui.close(); await mock.close(); }
  });

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
      else { tui.keys('\r'); await tui.visible('Prompt · Root'); }
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

  test(`${view} composer closes after manually typing a complete file candidate`, async () => {
    const paths: string[] = [];
    const mock = await mockServer((socket, request) => {
      if (request.method === 'organization.snapshot') respond(socket, request.id, { seq: 0, agents: [agent('root', null, { name: 'Root', settings: { harness: 'pi', cwd: '/recipient' } })], operations: [], capabilities: { pathCompletion: true } });
      else if (request.method === 'events.history') respond(socket, request.id, { events: [], oldestSeq: 0, latestSeq: 0, expired: false, hasMore: false });
      else if (request.method === 'organization.paths') {
        paths.push(request.params.input);
        respond(socket, request.id, { path: request.params.input, isDirectory: false, entries: request.params.input === './fi' ? [{ name: 'file name.txt', path: '/recipient/file name.txt', kind: 'file' }] : [] });
      }
    });
    const tui = terminalClient(mock.path, mock.directory, { cols: 80, rows: 24 });
    try {
      await tui.visible('Root');
      if (view === 'chat') { tui.keys('c'); await tui.visible('Chat · Root'); }
      else { tui.keys('\r'); await tui.visible('Interrupting prompt · Root'); }
      tui.keys('./fi'); await tui.visible('file name.txt'); await new Promise(resolve => setTimeout(resolve, 100));
      tui.keys('le name.txt'); await new Promise(resolve => setTimeout(resolve, 120));
      expect(paths).toEqual(['./fi']);
      expect(tui.screen()).toContain('./file name.txt');
      expect(tui.screen()).not.toContain('No matching paths');
      const count = paths.length;
      tui.keys(' note'); await new Promise(resolve => setTimeout(resolve, 100));
      expect(paths).toHaveLength(count);
      expect(tui.screen()).toContain('./file name.txt note');
    } finally { await tui.close(); await mock.close(); }
  });

  test(`${view} hides no-match status after a space starts prose`, async () => {
    const inputs: string[] = [];
    const mock = await mockServer((socket, request) => {
      if (request.method === 'organization.snapshot') respond(socket, request.id, { seq: 0, agents: [agent('root', null, { name: 'Root', settings: { harness: 'pi', cwd: '/recipient' } })], operations: [], capabilities: { pathCompletion: true } });
      else if (request.method === 'events.history') respond(socket, request.id, { events: [], oldestSeq: 0, latestSeq: 0, expired: false, hasMore: false });
      else if (request.method === 'organization.paths') {
        inputs.push(request.params.input);
        respond(socket, request.id, { path: request.params.input, isDirectory: false, entries: request.params.input === './read' ? [{ name: 'README.md', path: '/recipient/README.md', kind: 'file' }] : [] });
      }
    });
    const tui = terminalClient(mock.path, mock.directory, { cols: 80, rows: 24 });
    try {
      await tui.visible('Root');
      if (view === 'chat') { tui.keys('c'); await tui.visible('Chat · Root'); }
      else { tui.keys('\r'); await tui.visible('Interrupting prompt · Root'); }
      tui.keys('./read'); await tui.visible('README.md'); await new Promise(resolve => setTimeout(resolve, 100));
      tui.keys(' suppose I am writing prose'); await new Promise(resolve => setTimeout(resolve, 150));
      expect(inputs).toContain('./read suppose I am writing prose');
      expect(tui.screen()).toContain('./read suppose I am writing prose');
      expect(tui.screen()).not.toContain('No matching paths');
      const count = inputs.length;
      tui.keys(' now'); await new Promise(resolve => setTimeout(resolve, 120));
      expect(inputs.length).toBeGreaterThan(count);
      expect(tui.screen()).not.toContain('No matching paths');
    } finally { await tui.close(); await mock.close(); }
  });

  test(`${view} keeps editing a space-containing path after a no-match lookup`, async () => {
    const inputs: string[] = [];
    const mock = await mockServer((socket, request) => {
      if (request.method === 'organization.snapshot') respond(socket, request.id, { seq: 0, agents: [agent('root', null, { name: 'Root', settings: { harness: 'pi', cwd: '/recipient' } })], operations: [], capabilities: { pathCompletion: true } });
      else if (request.method === 'events.history') respond(socket, request.id, { events: [], oldestSeq: 0, latestSeq: 0, expired: false, hasMore: false });
      else if (request.method === 'organization.paths') {
        inputs.push(request.params.input);
        const entries = request.params.input === './my folder' ? [{ name: 'child.txt', path: '/recipient/my folder/child.txt', kind: 'file' as const }] : [];
        respond(socket, request.id, { path: request.params.input, isDirectory: request.params.input === './my folder', entries });
      }
    });
    const tui = terminalClient(mock.path, mock.directory, { cols: 80, rows: 24 });
    try {
      await tui.visible('Root');
      if (view === 'chat') { tui.keys('c'); await tui.visible('Chat · Root'); }
      else { tui.keys('\r'); await tui.visible('Interrupting prompt · Root'); }
      tui.keys('./my f'); await new Promise(resolve => setTimeout(resolve, 150));
      expect(tui.screen()).not.toContain('No matching paths');
      tui.keys('older'); await tui.visible('child.txt'); await new Promise(resolve => setTimeout(resolve, 120));
      expect(inputs).toContain('./my folder');
    } finally { await tui.close(); await mock.close(); }
  });

  test(`${view} closes an exact path returned after manual typing outpaces the lookup`, async () => {
    const mock = await mockServer((socket, request) => {
      if (request.method === 'organization.snapshot') respond(socket, request.id, { seq: 0, agents: [agent('root', null, { name: 'Root', settings: { harness: 'pi', cwd: '/recipient' } })], operations: [], capabilities: { pathCompletion: true } });
      else if (request.method === 'events.history') respond(socket, request.id, { events: [], oldestSeq: 0, latestSeq: 0, expired: false, hasMore: false });
      else if (request.method === 'organization.paths') respond(socket, request.id, { path: request.params.input, isDirectory: false, entries: [{ name: 'file name.txt', path: '/recipient/file name.txt', kind: 'file' }] });
    });
    const tui = terminalClient(mock.path, mock.directory, { cols: 80, rows: 24 });
    try {
      await tui.visible('Root');
      if (view === 'chat') { tui.keys('c'); await tui.visible('Chat · Root'); }
      else { tui.keys('\r'); await tui.visible('Interrupting prompt · Root'); }
      tui.keys('./file name.txt'); await new Promise(resolve => setTimeout(resolve, 180));
      const screen = tui.screen();
      expect(screen).toContain('./file name.txt');
      expect(screen.match(/file name\.txt/g)).toHaveLength(1);
    } finally { await tui.close(); await mock.close(); }
  });

  test(`${view} resumes path editing after a manually matched candidate when extending its name`, async () => {
    const inputs: string[] = [];
    const mock = await mockServer((socket, request) => {
      if (request.method === 'organization.snapshot') respond(socket, request.id, { seq: 0, agents: [agent('root', null, { name: 'Root', settings: { harness: 'pi', cwd: '/recipient' } })], operations: [], capabilities: { pathCompletion: true } });
      else if (request.method === 'events.history') respond(socket, request.id, { events: [], oldestSeq: 0, latestSeq: 0, expired: false, hasMore: false });
      else if (request.method === 'organization.paths') {
        inputs.push(request.params.input);
        const entries = request.params.input === './f' ? [
          { name: 'foo', path: '/recipient/foo', kind: 'file' as const },
          { name: 'foo bar.txt', path: '/recipient/foo bar.txt', kind: 'file' as const },
          { name: 'foobar.txt', path: '/recipient/foobar.txt', kind: 'file' as const },
        ] : request.params.input.startsWith('./foo b') ? [{ name: 'foo bar.txt', path: '/recipient/foo bar.txt', kind: 'file' as const }] : request.params.input === './foobar' ? [{ name: 'foobar.txt', path: '/recipient/foobar.txt', kind: 'file' as const }] : [];
        respond(socket, request.id, { path: request.params.input, isDirectory: false, entries });
      }
    });
    const tui = terminalClient(mock.path, mock.directory, { cols: 80, rows: 24 });
    try {
      await tui.visible('Root');
      if (view === 'chat') { tui.keys('c'); await tui.visible('Chat · Root'); }
      else { tui.keys('\r'); await tui.visible('Interrupting prompt · Root'); }
      tui.keys('./f'); await tui.visible('foo'); await new Promise(resolve => setTimeout(resolve, 100));
      tui.keys('oo'); await new Promise(resolve => setTimeout(resolve, 60));
      tui.keys(' bar'); await new Promise(resolve => setTimeout(resolve, 150));
      expect(inputs).toContain('./foo bar'); expect(tui.screen()).toContain('foo bar.txt');
      tui.keys('\x03'); await new Promise(resolve => setTimeout(resolve, 50));
      tui.keys('./f'); await tui.visible('foo'); await new Promise(resolve => setTimeout(resolve, 100));
      tui.keys('oo'); await new Promise(resolve => setTimeout(resolve, 60));
      tui.keys('bar'); await tui.visible('foobar.txt'); await new Promise(resolve => setTimeout(resolve, 100));
      expect(inputs).toContain('./foobar');
    } finally { await tui.close(); await mock.close(); }
  });

  test(`${view} composer closes a manually completed directory and resumes after slash`, async () => {
    const paths: string[] = [];
    const mock = await mockServer((socket, request) => {
      if (request.method === 'organization.snapshot') respond(socket, request.id, { seq: 0, agents: [agent('root', null, { name: 'Root', settings: { harness: 'pi', cwd: '/recipient' } })], operations: [], capabilities: { pathCompletion: true } });
      else if (request.method === 'events.history') respond(socket, request.id, { events: [], oldestSeq: 0, latestSeq: 0, expired: false, hasMore: false });
      else if (request.method === 'organization.paths') {
        paths.push(request.params.input);
        const entries = request.params.input === './su' ? [{ name: 'sub dir', path: '/recipient/sub dir', kind: 'directory' as const }] : request.params.input === './sub dir/' ? [{ name: 'child', path: '/recipient/sub dir/child', kind: 'file' as const }] : [];
        respond(socket, request.id, { path: request.params.input, isDirectory: request.params.input.startsWith('./sub dir'), entries });
      }
    });
    const tui = terminalClient(mock.path, mock.directory, { cols: 80, rows: 24 });
    try {
      await tui.visible('Root');
      if (view === 'chat') { tui.keys('c'); await tui.visible('Chat · Root'); }
      else { tui.keys('\r'); await tui.visible('Interrupting prompt · Root'); }
      tui.keys('./su'); await tui.visible('sub dir'); await new Promise(resolve => setTimeout(resolve, 100));
      tui.keys('b dir'); await new Promise(resolve => setTimeout(resolve, 80));
      expect(tui.screen()).not.toContain('No matching paths');
      const priorCount = paths.length;
      tui.keys('/'); await tui.visible('child'); await new Promise(resolve => setTimeout(resolve, 100));
      expect(paths).toContain('./sub dir/');
      expect(paths.length).toBeGreaterThan(priorCount);
    } finally { await tui.close(); await mock.close(); }
  });

  test(`${view} resumes editing after an empty directory is manually completed`, async () => {
    const inputs: string[] = [];
    const mock = await mockServer((socket, request) => {
      if (request.method === 'organization.snapshot') respond(socket, request.id, { seq: 0, agents: [agent('root', null, { name: 'Root', settings: { harness: 'pi', cwd: '/recipient' } })], operations: [], capabilities: { pathCompletion: true } });
      else if (request.method === 'events.history') respond(socket, request.id, { events: [], oldestSeq: 0, latestSeq: 0, expired: false, hasMore: false });
      else if (request.method === 'organization.paths') {
        inputs.push(request.params.input);
        const entries = request.params.input === './empty2' ? [{ name: 'empty2-child', path: '/recipient/empty2-child', kind: 'file' as const }] : request.params.input === './empty/' ? [{ name: 'child.txt', path: '/recipient/empty/child.txt', kind: 'file' as const }] : [];
        respond(socket, request.id, { path: request.params.input, isDirectory: request.params.input === './empty' || request.params.input === './empty/', entries });
      }
    });
    const tui = terminalClient(mock.path, mock.directory, { cols: 80, rows: 24 });
    try {
      await tui.visible('Root');
      if (view === 'chat') { tui.keys('c'); await tui.visible('Chat · Root'); }
      else { tui.keys('\r'); await tui.visible('Interrupting prompt · Root'); }
      tui.keys('./empty'); await new Promise(resolve => setTimeout(resolve, 150));
      expect(tui.screen()).not.toContain('No matching paths');
      tui.keys('2'); await tui.visible('empty2-child'); await new Promise(resolve => setTimeout(resolve, 100));
      expect(inputs).toContain('./empty2');
      tui.keys('\x03'); await new Promise(resolve => setTimeout(resolve, 50));
      tui.keys('./empty'); await new Promise(resolve => setTimeout(resolve, 150));
      tui.keys('/'); await tui.visible('child.txt'); await new Promise(resolve => setTimeout(resolve, 100));
      expect(inputs).toContain('./empty/');
    } finally { await tui.close(); await mock.close(); }
  });

  test(`${view} later path trigger escapes a manually accepted directory span`, async () => {
    const inputs: string[] = [];
    const mock = await mockServer((socket, request) => {
      if (request.method === 'organization.snapshot') respond(socket, request.id, { seq: 0, agents: [agent('root', null, { name: 'Root', settings: { harness: 'pi', cwd: '/recipient' } })], operations: [], capabilities: { pathCompletion: true } });
      else if (request.method === 'events.history') respond(socket, request.id, { events: [], oldestSeq: 0, latestSeq: 0, expired: false, hasMore: false });
      else if (request.method === 'organization.paths') {
        const input = request.params.input as string;
        inputs.push(input);
        const entries = input.startsWith('./s') && !input.endsWith('/') ? [{ name: 'src', path: '/recipient/src', kind: 'directory' as const }] : input === './src/' ? [{ name: 'child.ts', path: '/recipient/src/child.ts', kind: 'file' as const }] : input === './' ? [{ name: 'ROOT.txt', path: '/recipient/ROOT.txt', kind: 'file' as const }] : [];
        respond(socket, request.id, { path: input, isDirectory: input === './src' || input === './src/', entries });
      }
    });
    const tui = terminalClient(mock.path, mock.directory, { cols: 80, rows: 24 });
    try {
      await tui.visible('Root'); tui.keys(view === 'chat' ? 'c' : '\r'); await tui.visible(view === 'chat' ? 'Chat · Root' : 'Prompt · Root');
      tui.keys('./s'); await tui.visible('src'); tui.keys('rc'); await new Promise(resolve => setTimeout(resolve, 100));
      tui.keys('/'); await tui.visible('child.ts');
      tui.keys(' prose ./'); await new Promise(resolve => setTimeout(resolve, 150));
      expect(inputs).toContain('./');
      expect(inputs).not.toContain('./src/ prose ./');
      await tui.visible('ROOT.txt');
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
      else { tui.keys('\r'); await tui.visible('Prompt · Root'); }
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
