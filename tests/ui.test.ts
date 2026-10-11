import { expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { copyFile, chmod, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import xterm from '@xterm/headless';
import { clip } from '../src/render.js';
import { agent, event, mockServer, operation, respond, send, waitFor } from './helpers.js';

// Exercise the real Bun CLI in a Unix pseudo-terminal, then inspect its rendered screen.
test('terminal tree selection, interrupt prompt, vf/vl settings, raw chat, live events and Escape', async () => {
  let seq = 3;
  const root = agent('root', null, { name: 'coordinator' });
  const child = agent('worker', 'root', { name: 'worker' });
  const initialText = '**Initial worker answer** with enough text to fill the rest of the tree row';
  const initial = [event(1), ...[initialText, '.'].map((text, index) => event(index + 2, 'agent.message', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } }, { agentId: 'worker' }))];
  const prompts: any[] = [];
  const modifications: any[] = [];
  const catalog = [{ name: 'alpha', description: 'Alpha instructions', gitUrl: 'https://github.com/org/alpha' }];
  const mock = await mockServer((socket, request) => {
    if (request.method === 'organization.snapshot') respond(socket, request.id, { seq, agents: [child, root], operations: [], capabilities: { harnesses: ['fixture'], plugins: { skills: { settingsNamespace: 'skills', endpoints: { list: 'skills.list', add: 'skills.add' } } } } });
    else if (request.method === 'skills.list') respond(socket, request.id, { skills: catalog });
    else if (request.method === 'skills.add') { catalog.push({ ...request.params, description: 'Beta instructions' }); respond(socket, request.id, catalog.at(-1)); }
    else if (request.method === 'agent.modify') {
      modifications.push(request.params);
      child.settings.extensions = request.params.settings.extensions;
      child.revision++;
      respond(socket, request.id, { ...operation('completed'), id: 'skills-change', type: 'agent.modify', agentId: child.id });
    }
    else if (request.method === 'events.history') respond(socket, request.id, { events: initial.filter(event => event.seq > request.params.after), oldestSeq: 1, latestSeq: seq, expired: false });
    else if (request.method === 'agent.prompt') {
      prompts.push(request.params);
      const op = { ...operation('completed'), id: `op-${prompts.length}`, agentId: request.params.agentId };
      send(socket, event(++seq, 'prompt.queued', { text: request.params.text, operationId: op.id }, { agentId: op.agentId }));
      send(socket, event(++seq, 'operation.changed', op, { agentId: op.agentId }));
      respond(socket, request.id, op);
    }
  });
  const config = join(mock.directory, 'settings.json');
  const terminal = new xterm.Terminal({ cols: 100, rows: 30, allowProposedApi: true });
  const screen = () => Array.from({ length: 30 }, (_, index) => terminal.buffer.active.getLine(index)?.translateToString(true) ?? '').join('\n');
  let command = 'bun src/main.ts';
  if (process.env.ORG_TUI_BINARY) {
    const binary = join(mock.directory, 'org-tui');
    await copyFile(resolve(process.env.ORG_TUI_BINARY), binary);
    await chmod(binary, 0o755);
    command = `'${binary}'`;
  }
  const childProcess = spawn('script', ['-qefc', `stty cols 100 rows 30; ${process.env.ORG_TUI_BINARY ? "PATH='/nonexistent' " : ''}exec ${command} --socket '${mock.path}' --config '${config}'`, '/dev/null'], {
    cwd: process.env.ORG_TUI_BINARY ? mock.directory : join(import.meta.dir, '..'), env: { ...process.env, TERM: 'xterm-256color', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let exited = false;
  let stderr = '';
  childProcess.stderr.on('data', chunk => { stderr += chunk.toString(); });
  childProcess.stdout.on('data', chunk => terminal.write(chunk));
  childProcess.on('exit', () => { exited = true; });
  const keys = (value: string) => { childProcess.stdin.write(value); };
  const visible = async (text: string) => {
    try { await waitFor(() => screen().includes(text), 5000); }
    catch { throw new Error(`Missing ${JSON.stringify(text)}; exited=${exited}; stderr=${stderr}\n${screen()}`); }
  };
  try {
    await visible(clip(initialText.replace(/\*\*/g, '') + '.', 35));
    expect(screen()).not.toContain('assistant:');
    expect(screen()).not.toContain('**Initial worker answer**');
    expect(terminal.buffer.active.getLine(4)?.getCell(64)?.isBold()).toBeTruthy();
    expect(terminal.buffer.active.getLine(4)?.getCell(86)?.isBold()).toBeFalsy();
    expect(screen()).toContain('STATUS');
    expect(screen()).toContain('gpt-6-luna');
    expect(screen()).toContain('  └ worker');
    const selectedBg = (row: number) => terminal.buffer.active.getLine(row)?.getCell(0)?.getBgColor();
    expect(selectedBg(3)).not.toBe(selectedBg(4));
    keys('\x1b[B');
    await waitFor(() => selectedBg(4) === 4); // Selected agent is highlighted in blue.
    keys('\r');
    await visible('Interrupting prompt · worker');
    keys('tree interruption\r');
    await waitFor(() => prompts.length === 1);
    await visible('LATEST TRACKED EVENT');
    expect(prompts[0]).toEqual({ agentId: 'worker', text: 'tree interruption', queue: false });
    keys('c'); await visible('Chat · worker');
    for (const text of ['\n\n# A heading\n\n**Bold streamed** ', 'answer']) {
      for (const socket of mock.sockets) send(socket, event(++seq, 'agent.message', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } }, { agentId: 'worker' }));
    }
    await visible('Bold streamed answer');
    expect(screen()).not.toContain('**Bold streamed**');
    keys('\x1b'); await visible('LATEST TRACKED EVENT');
    await visible('# A heading Bold streamed answer');
    expect(screen()).not.toContain('**Bold streamed**');

    keys('v'); await visible('View settings');
    keys('f'); await visible('Event filters');
    keys('\x1b[B\x1b[B '); // agent.message, alphabetically third.
    await visible('[ ] agent.message');
    await waitFor(() => screen().includes('Saved '));
    expect(JSON.parse(await readFile(config, 'utf8')).excluded).toContain('agent.message');
    keys('\x1b'); await visible('LATEST TRACKED EVENT');
    for (const socket of mock.sockets) {
      send(socket, event(++seq, 'prompt.started', { operationId: 'live-op' }, { agentId: 'worker' }));
      send(socket, event(++seq, 'agent.message', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Live worker answer' } }, { agentId: 'worker' }));
    }
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(screen()).not.toContain('Live worker answer');
    keys('v'); await visible('View settings'); keys('f'); await visible('Event filters');
    keys('\x1b[B\x1b[B '); await visible('[x] agent.message');
    keys('\x1b'); await visible('Live worker answer');

    keys('v'); await visible('View settings'); keys('l'); await visible('Event rendering levels');
    keys('\x1b[B\x1b[B4'); await visible('4 raw');
    keys('\x1b'); await visible('LATEST TRACKED EVENT');
    keys('c'); await visible('Chat · worker');
    await visible('"sessionUpdate": "agent_message_chunk"');
    await visible('"text": "Live worker answer"');
    keys('chat message\r');
    await waitFor(() => prompts.length === 2);
    expect(prompts[1]).toEqual({ agentId: 'worker', text: 'chat message', queue: false });
    keys('\x1b'); await visible('LATEST TRACKED EVENT');
    keys('s'); await visible('Skills · worker');
    await visible('unavailable  alpha');
    keys('i'); await visible('installed    alpha');
    keys('\r'); await waitFor(() => modifications.length === 1);
    expect(modifications[0]).toEqual({ agentId: 'worker', expectedRevision: 1, settings: { extensions: { skills: { alpha: 'installed' } } } });
    await visible('LATEST TRACKED EVENT');
    await new Promise(resolve => setTimeout(resolve, 250));
    keys('s'); await visible('Skills · worker');
    keys('u'); await visible('unavailable  alpha');
    keys('\x1b'); await visible('LATEST TRACKED EVENT');
    expect(modifications.length).toBe(1); // Escape discards staged changes.
    keys('s'); await visible('Skills · worker');
    keys('+'); await visible('Add catalog skill');
    keys('{"name":"beta","gitUrl":"https://github.com/org/beta"}\r');
    await waitFor(() => catalog.length === 2);
    await visible('LATEST TRACKED EVENT');
    keys('q'); await waitFor(() => exited);
  } finally {
    childProcess.kill('SIGTERM');
    terminal.dispose();
    await mock.close();
  }
}, 20_000);

test('terminal lifecycle: empty root/child creation, staged revision-fenced edits, confirmation and all actions', async () => {
  const agents: ReturnType<typeof agent>[] = [];
  const mutations: any[] = [];
  let pending: any;
  let failEdit = false;
  const pathRequests: any[] = [];
  const mock = await mockServer((socket, request) => {
    if (request.method === 'organization.snapshot') respond(socket, request.id, { seq: 0, agents, operations: [], capabilities: { cwd: '/server/project', pathCompletion: true, harnesses: ['fixture'], modelDiscovery: ['fixture'] } });
    else if (request.method === 'organization.paths') {
      pathRequests.push(request.params);
      const input = request.params.input;
      const path = input.replace(/\/$/, '') || request.params.base;
      const names = input.endsWith('/src/') ? ['nested'] : input.endsWith('sr') ? ['src', 'scripts'] : ['alpha', 'beta', 'charlie', 'delta', 'src'];
      const directory = input.endsWith('sr') ? '/server/project' : path;
      const entries = names.map(name => ({ name, path: `${directory}/${name}`, kind: 'directory' }));
      const result = { path, isDirectory: request.params.create === true || (!input.endsWith('missing') && !input.endsWith('sr')), entries };
      if (input.endsWith('slow')) setTimeout(() => respond(socket, request.id, { ...result, entries: [{ name: 'STALE_RESULT', path: '/stale', kind: 'directory' }] }), 500);
      else respond(socket, request.id, result);
    }
    else if (request.method === 'organization.providers') respond(socket, request.id, { providers: ['provider-a', 'provider-b'] });
    else if (request.method === 'organization.models') {
      expect(request.params.provider).toBe('provider-a');
      respond(socket, request.id, { models: [{ id: 'gpt-6-luna', name: 'Luna' }] });
    }
    else if (request.method === 'operation.wait') {
      const params = pending.input;
      let target = agents.find(a => a.id === params.agentId);
      if (pending.type === 'agent.modify' && failEdit) {
        respond(socket, request.id, { ...pending, status: 'failed', error: { code: 'CONFLICT', message: 'Revision changed' } }); return;
      }
      if (pending.type === 'agent.create') {
        target = agent(agents.length ? 'child' : 'root', params.parentId, { name: params.name, settings: params.settings }); agents.push(target);
      } else if (pending.type === 'agent.modify') { target!.name = params.name; target!.revision++; }
      else if (pending.type === 'agent.stop') target!.state = 'stopped';
      else if (pending.type === 'agent.remove') for (const a of agents) a.removedAt = 'archived';
      else target!.state = 'idle';
      respond(socket, request.id, { ...pending, agentId: target!.id, status: 'completed', result: target });
    } else {
      mutations.push(request);
      pending = { id: `op-${mutations.length}`, type: request.method, agentId: request.params.agentId ?? null, input: request.params, status: 'queued' };
      respond(socket, request.id, pending);
    }
  });
  const terminal = new xterm.Terminal({ cols: 120, rows: 30, allowProposedApi: true });
  const screen = () => Array.from({ length: 30 }, (_, i) => terminal.buffer.active.getLine(i)?.translateToString(true) ?? '').join('\n');
  let command = 'bun src/main.ts';
  if (process.env.ORG_TUI_BINARY) {
    const binary = join(mock.directory, 'org-tui');
    await copyFile(resolve(process.env.ORG_TUI_BINARY), binary); await chmod(binary, 0o755); command = `'${binary}'`;
  }
  const childProcess = spawn('script', ['-qefc', `stty cols 120 rows 30; exec ${command} --socket '${mock.path}' --config '${join(mock.directory, 'config.json')}'`, '/dev/null'], {
    cwd: process.env.ORG_TUI_BINARY ? mock.directory : join(import.meta.dir, '..'), env: { ...process.env, TERM: 'xterm-256color' }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let exited = false;
  childProcess.stdout.on('data', chunk => terminal.write(chunk));
  childProcess.on('exit', () => { exited = true; });
  const keys = (value: string) => { childProcess.stdin.write(value); };
  const visible = async (text: string) => {
    try { await waitFor(() => screen().includes(text), 5000); }
    catch { throw new Error(`Missing ${text}; exited=${exited}\n${screen()}`); }
  };
  const down = (count: number) => keys('\x1b[B'.repeat(count));
  const field = async (value: string) => {
    keys('\r'); await visible('Edit ');
    keys('\x15' + value + '\r'); await visible('agent ·');
  };
  const action = async (index: number, method: string) => {
    keys('a'); await visible('Agent actions'); down(index); keys('\r'); await visible('Confirm ·');
    const count = mutations.length;
    keys('\r'); await visible('LATEST TRACKED EVENT'); // Default selection is Cancel.
    expect(mutations).toHaveLength(count);
    keys('a'); await visible('Agent actions'); down(index); keys('\r'); await visible('Confirm ·');
    keys('y'); await waitFor(() => mutations.length === count + 1); await visible('LATEST TRACKED EVENT');
    expect(mutations.at(-1).method).toBe(method);
    expect(mutations.at(-1).params).toEqual({ agentId: 'root' });
  };
  try {
    await visible('No active agents. Press n');
    keys('n'); await visible('Create agent · root');
    await field('coordinator'); down(1); keys('\r'); await visible('Select harness'); keys('\r'); await visible('Create agent · root');
    down(2); keys('\r'); await visible('Select a provider before choosing a model.');
    keys('\x1b[A'); keys('\r'); await visible('Select provider'); await visible('provider-b');
    keys('\x1b'); await visible('Create agent · root'); // Escape keeps the provider unset.
    keys('\r'); await visible('Select provider'); keys('\r'); await visible('Create agent · root');
    down(1); keys('\r'); await visible('Select model · provider-a'); await visible('gpt-6-luna · Luna');
    keys('\r'); await visible('Create agent · root');
    down(1); keys('\r'); await visible('Edit cwd'); await visible('charlie/');
    expect(screen()).toContain('/server/project/');
    expect(terminal.buffer.active.getLine(21)?.translateToString(true)).toContain('/server/project/');
    for (const [index, name] of ['alpha', 'beta', 'charlie', 'delta', 'src'].entries())
      expect(terminal.buffer.active.getLine(23 + index)?.translateToString(true)).toContain(`${name}/`);
    // Explicit acceptance creates a new directory path rather than rejecting it.
    keys('\x15/server/project/missing\r'); await visible('Create agent · root');
    expect(pathRequests.at(-1)).toMatchObject({ input: '/server/project/missing', create: true });
    keys('\r'); await visible('Edit cwd');
    keys('\x15/server/project/slow');
    await waitFor(() => pathRequests.some(p => p.input.endsWith('slow')));
    keys('\x15/server/project/sr'); await visible('scripts/');
    await new Promise(resolve => setTimeout(resolve, 600));
    expect(screen()).not.toContain('STALE_RESULT');
    // Down selects scripts, Up returns to src; Tab descends, preserving input focus.
    keys('\x1b[B\x1b[A\t'); await visible('/server/project/src/'); await visible('nested/');
    keys('\t'); await visible('/server/project/src/nested/');
    keys(' '); await visible('Create agent · root');
    expect(screen()).toContain('/server/project/src/nested');
    down(AGENT_FIELD_COUNT - 4); keys('\r'); await visible('coordinator'); await visible('LATEST TRACKED EVENT');
    expect(mutations[0].params.settings.cwd).toBe('/server/project/src/nested');
    expect(mutations[0].params).toMatchObject({ parentId: null, name: 'coordinator', settings: { harness: 'fixture', provider: 'provider-a', model: 'gpt-6-luna' } });
    keys('n'); await visible('Create agent · child');
    expect(screen()).toContain('/server/project/src/nested/');
    await field('worker'); down(AGENT_FIELD_COUNT); keys('\r'); await visible('  └ worker');
    expect(mutations[1].params.parentId).toBe('root');
    keys('\x1b[A'); // Back to the root after the child was selected on creation.
    keys('e'); await visible('Modify agent · revision 1');
    await field('discarded'); keys('\x1b'); await visible('LATEST TRACKED EVENT');
    expect(mutations).toHaveLength(2);
    keys('e'); await visible('Modify agent · revision 1');
    await field('renamed'); down(AGENT_FIELD_COUNT); keys('\r'); await visible('LATEST TRACKED EVENT');
    expect(mutations[2].params).toEqual({ agentId: 'root', expectedRevision: 1, name: 'renamed' });
    failEdit = true;
    keys('e'); await visible('Modify agent · revision 2');
    await field('conflicting'); down(AGENT_FIELD_COUNT); keys('\r'); await visible('CONFLICT');
    expect(screen()).toContain('Save changes'); // Failure retains the draft, never retries.
    keys('\x1b'); await visible('LATEST TRACKED EVENT'); failEdit = false;
    await action(3, 'agent.stop'); await visible('stopped');
    await action(2, 'agent.restart');
    await action(4, 'agent.restart_subtree');
    await action(5, 'agent.replace_session');
    await action(6, 'agent.remove');
    expect(agents.every(a => a.removedAt)).toBe(true);
    keys('q'); await waitFor(() => exited);
  } finally { childProcess.kill('SIGTERM'); terminal.dispose(); await mock.close(); }
}, 20_000);

const AGENT_FIELD_COUNT = 9;
