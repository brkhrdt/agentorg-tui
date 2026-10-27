import { expect, test } from 'bun:test';
import { agent, mockServer, respond } from './helpers.js';
import { terminalClient } from './terminal.js';

for (const view of ['chat', 'prompt'] as const) {
  test(`${view}: ./~ home shorthand stays in the home directory after accepting a candidate`, async () => {
    const inputs: string[] = [];
    const mock = await mockServer((socket, request) => {
      if (request.method === 'organization.snapshot') respond(socket, request.id, { seq: 0, agents: [agent('root', null, { name: 'Root', settings: { harness: 'pi', cwd: '/recipient' } })], operations: [], capabilities: { pathCompletion: true } });
      else if (request.method === 'events.history') respond(socket, request.id, { events: [], oldestSeq: 0, latestSeq: 0, expired: false, hasMore: false });
      else if (request.method === 'organization.paths') {
        inputs.push(request.params.input);
        const entries = request.params.input === '~/'
          ? [{ name: 'Documents', path: '/server/home/Documents', kind: 'directory' }]
          : [{ name: 'notes.txt', path: '/server/home/Documents/notes.txt', kind: 'file' }];
        respond(socket, request.id, { path: request.params.input, isDirectory: true, entries });
      }
    });
    const tui = terminalClient(mock.path, mock.directory, { cols: 80, rows: 24 });
    try {
      await tui.visible('Root');
      if (view === 'chat') { tui.keys('c'); await tui.visible('Chat · Root'); }
      else { tui.keys('\r'); await tui.visible('Interrupting prompt · Root'); }
      tui.keys('./~'); await tui.visible('Documents');
      expect(inputs[0]).toBe('~/');
      tui.keys('\t'); await tui.visible('notes.txt');
      expect(tui.screen()).toContain('./~/Documents/');
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(inputs).toEqual(['~/', '~/Documents/']);
    } finally { await tui.close(); await mock.close(); }
  });

  test(`${view}: Escape dismisses cwd-unavailable path notice and does not reopen it`, async () => {
    const mock = await mockServer((socket, request) => {
      if (request.method === 'organization.snapshot') respond(socket, request.id, { seq: 0, agents: [agent('root', null, { name: 'Root', settings: { harness: 'pi' } })], operations: [], capabilities: { pathCompletion: true } });
      else if (request.method === 'events.history') respond(socket, request.id, { events: [], oldestSeq: 0, latestSeq: 0, expired: false, hasMore: false });
    });
    const tui = terminalClient(mock.path, mock.directory, { cols: 80, rows: 24 });
    try {
      await tui.visible('Root');
      if (view === 'chat') { tui.keys('c'); await tui.visible('Chat · Root'); }
      else { tui.keys('\r'); await tui.visible('Interrupting prompt · Root'); }
      tui.keys('./'); await tui.visible('Recipient cwd unavailable');
      tui.keys('\x1b'); await new Promise(resolve => setTimeout(resolve, 150));
      expect(tui.screen()).toContain(view === 'chat' ? 'Chat · Root' : 'Interrupting prompt · Root');
      expect(tui.screen()).not.toContain('Recipient cwd unavailable');
      tui.keys('\x1b'); await tui.visible('AGENT');
    } finally { await tui.close(); await mock.close(); }
  });

  test(`${view}: buffered Tab resolves a path span before a trailing mention`, async () => {
    const inputs: string[] = [];
    const mock = await mockServer((socket, request) => {
      if (request.method === 'organization.snapshot') respond(socket, request.id, { seq: 0, agents: [agent('root', null, { name: 'Root', settings: { harness: 'pi', cwd: '/recipient' } }), agent('beta', 'root', { name: 'Beta' })], operations: [], capabilities: { pathCompletion: true } });
      else if (request.method === 'events.history') respond(socket, request.id, { events: [], oldestSeq: 0, latestSeq: 0, expired: false, hasMore: false });
      else if (request.method === 'organization.paths') {
        inputs.push(request.params.input);
        respond(socket, request.id, { path: request.params.input, isDirectory: true, entries: [{ name: '@be-file', path: '/recipient/folder/@be-file', kind: 'file' }] });
      }
    });
    const tui = terminalClient(mock.path, mock.directory, { cols: 80, rows: 24 });
    try {
      await tui.visible('Root');
      if (view === 'chat') { tui.keys('c'); await tui.visible('Chat · Root'); }
      else { tui.keys('\r'); await tui.visible('Interrupting prompt · Root'); }
      tui.keys('./folder @be\t'); await tui.visible('› @be-file');
      expect(inputs).toContain('./folder @be');
      expect(tui.screen()).not.toContain('› @Beta');
      expect(tui.screen()).toContain('./folder @be');
    } finally { await tui.close(); await mock.close(); }
  });

  test(`${view}: accepting a file preserves trailing mention completion`, async () => {
    const inputs: string[] = [];
    const mock = await mockServer((socket, request) => {
      if (request.method === 'organization.snapshot') respond(socket, request.id, { seq: 0, agents: [agent('root', null, { name: 'Root', settings: { harness: 'pi', cwd: '/recipient' } }), agent('beta', 'root', { name: 'Beta' })], operations: [], capabilities: { pathCompletion: true } });
      else if (request.method === 'events.history') respond(socket, request.id, { events: [], oldestSeq: 0, latestSeq: 0, expired: false, hasMore: false });
      else if (request.method === 'organization.paths') {
        inputs.push(request.params.input);
        respond(socket, request.id, { path: request.params.input, isDirectory: true, entries: [{ name: 'file.txt', path: '/recipient/file.txt', kind: 'file' }] });
      }
    });
    const tui = terminalClient(mock.path, mock.directory, { cols: 80, rows: 24 });
    try {
      await tui.visible('Root');
      if (view === 'chat') { tui.keys('c'); await tui.visible('Chat · Root'); }
      else { tui.keys('\r'); await tui.visible('Interrupting prompt · Root'); }
      tui.keys('./file'); await tui.visible('› file.txt');
      tui.keys('\t'); await tui.visible('./file.txt');
      tui.keys('@be'); await tui.visible('› @Beta');
      tui.keys('\t'); await tui.visible('./file.txt @Beta');
      expect(inputs).toEqual(['./file']);
    } finally { await tui.close(); await mock.close(); }
  });

  test(`${view}: Space dismisses mention after file acceptance without reopening path completion`, async () => {
    const inputs: string[] = [];
    const mock = await mockServer((socket, request) => {
      if (request.method === 'organization.snapshot') respond(socket, request.id, { seq: 0, agents: [agent('root', null, { name: 'Root', settings: { harness: 'pi', cwd: '/recipient' } }), agent('beta', 'root', { name: 'Beta' })], operations: [], capabilities: { pathCompletion: true } });
      else if (request.method === 'events.history') respond(socket, request.id, { events: [], oldestSeq: 0, latestSeq: 0, expired: false, hasMore: false });
      else if (request.method === 'organization.paths') {
        inputs.push(request.params.input);
        respond(socket, request.id, { path: request.params.input, isDirectory: true, entries: [{ name: 'file.txt', path: '/recipient/file.txt', kind: 'file' }] });
      }
    });
    const tui = terminalClient(mock.path, mock.directory, { cols: 80, rows: 24 });
    try {
      await tui.visible('Root');
      if (view === 'chat') { tui.keys('c'); await tui.visible('Chat · Root'); }
      else { tui.keys('\r'); await tui.visible('Interrupting prompt · Root'); }
      tui.keys('./file'); await tui.visible('› file.txt');
      tui.keys('\t'); await tui.visible('./file.txt');
      tui.keys('@be'); await tui.visible('› @Beta');
      tui.keys(' x'); await new Promise(resolve => setTimeout(resolve, 150));
      expect(inputs).toEqual(['./file']);
      expect(tui.screen()).toContain('./file.txt @be x');
      expect(tui.screen()).not.toContain('› @Beta');
      expect(tui.screen()).not.toContain('› file.txt');
    } finally { await tui.close(); await mock.close(); }
  });

  test(`${view}: path-looking prose keeps mention completion when path capability is absent`, async () => {
    const mock = await mockServer((socket, request) => {
      if (request.method === 'organization.snapshot') respond(socket, request.id, { seq: 0, agents: [agent('root', null, { name: 'Root', settings: { harness: 'pi', cwd: '/recipient' } }), agent('beta', 'root', { name: 'Beta' })], operations: [], capabilities: { pathCompletion: false } });
      else if (request.method === 'events.history') respond(socket, request.id, { events: [], oldestSeq: 0, latestSeq: 0, expired: false, hasMore: false });
    });
    const tui = terminalClient(mock.path, mock.directory, { cols: 80, rows: 24 });
    try {
      await tui.visible('Root');
      if (view === 'chat') { tui.keys('c'); await tui.visible('Chat · Root'); }
      else { tui.keys('\r'); await tui.visible('Interrupting prompt · Root'); }
      tui.keys('./literal @be'); await tui.visible('› @Beta');
      tui.keys('\t'); await tui.visible('./literal @Beta');
    } finally { await tui.close(); await mock.close(); }
  });

  test(`${view}: Escape-dismissed mention is not accepted by Tab`, async () => {
    const mock = await mockServer((socket, request) => {
      if (request.method === 'organization.snapshot') respond(socket, request.id, { seq: 0, agents: [agent('root', null, { name: 'Root', settings: { harness: 'pi', cwd: '/recipient' } }), agent('beta', 'root', { name: 'Beta' })], operations: [], capabilities: { pathCompletion: true } });
      else if (request.method === 'events.history') respond(socket, request.id, { events: [], oldestSeq: 0, latestSeq: 0, expired: false, hasMore: false });
    });
    const tui = terminalClient(mock.path, mock.directory, { cols: 80, rows: 24 });
    try {
      await tui.visible('Root');
      if (view === 'chat') { tui.keys('c'); await tui.visible('Chat · Root'); }
      else { tui.keys('\r'); await tui.visible('Interrupting prompt · Root'); }
      tui.keys('@be'); await tui.visible('› @Beta');
      tui.keys('\x1b'); await new Promise(resolve => setTimeout(resolve, 30));
      tui.keys('\t'); await new Promise(resolve => setTimeout(resolve, 30));
      expect(tui.screen().split('\n').some(line => line.trim() === '@be')).toBe(true);
      expect(tui.screen()).not.toContain('› @Beta');
    } finally { await tui.close(); await mock.close(); }
  });

  test(`${view}: @ inside an active space-containing path remains part of the path query`, async () => {
    const inputs: string[] = [];
    const mock = await mockServer((socket, request) => {
      if (request.method === 'organization.snapshot') respond(socket, request.id, { seq: 0, agents: [agent('root', null, { name: 'Root', settings: { harness: 'pi', cwd: '/recipient' } }), agent('beta', 'root', { name: 'Beta' })], operations: [], capabilities: { pathCompletion: true } });
      else if (request.method === 'events.history') respond(socket, request.id, { events: [], oldestSeq: 0, latestSeq: 0, expired: false, hasMore: false });
      else if (request.method === 'organization.paths') {
        inputs.push(request.params.input);
        respond(socket, request.id, { path: request.params.input, isDirectory: false, entries: [{ name: '@be-file', path: '/recipient/folder @be-file', kind: 'file' }] });
      }
    });
    const tui = terminalClient(mock.path, mock.directory, { cols: 80, rows: 24 });
    try {
      await tui.visible('Root');
      if (view === 'chat') { tui.keys('c'); await tui.visible('Chat · Root'); }
      else { tui.keys('\r'); await tui.visible('Interrupting prompt · Root'); }
      tui.keys('./folder @be'); await tui.visible('@be-file');
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(inputs).toContain('./folder @be');
      expect(tui.screen()).not.toContain('› @Beta');
    } finally { await tui.close(); await mock.close(); }
  });
}
