import { expect, test } from 'vitest';
import { agent, event, mockServer, operation, respond, send, waitFor } from './helpers.js';
import { terminalClient } from './terminal.js';

test('slash completion inserts a draft prefix and submission stays explicit', async () => {
  const prompts: any[] = [], requests: any[] = [], records = [{ name: 'web', description: 'Search the web', input: { hint: 'free-form query' } }, { name: 'skill:review', description: 'Review' }];
  const root = agent('root', null, { name: 'Root' }); root.generation = 'g1'; root.sessionId = 's1'; root.state = 'idle';
  const mock = await mockServer((socket, request) => {
    requests.push(request);
    if (request.method === 'organization.snapshot') respond(socket, request.id, { seq: 0, agents: [root], operations: [], capabilities: { agentCommands: { version: 1 } }, agentCommands: { root: { version: 1, generation: 'g1', sessionId: 's1', commands: records } } });
    else if (request.method === 'events.history') respond(socket, request.id, { events: [], oldestSeq: 0, latestSeq: 0, expired: false });
    else if (request.method === 'agent.prompt') { prompts.push(request.params); respond(socket, request.id, operation('completed')); }
  });
  const tui = terminalClient(mock.path, mock.directory, { cols: 80, rows: 24 });
  try {
    await tui.visible('Root'); tui.keys('\r'); await tui.visible('Prompt · Root');
    tui.keys('/we'); await tui.visible('/web');
    tui.keys('\t'); await waitFor(() => tui.screen().includes('/web '));
    expect(prompts).toHaveLength(0);
    tui.keys('query {literal} "quoted"'); tui.keys('\r'); await waitFor(() => prompts.length === 1);
    expect(prompts[0].text).toBe('/web query {literal} "quoted"');
    const methods = requests.map(request => request.method);
    expect(methods.some(method => ['agent.steer', 'organization.paths'].includes(method))).toBe(false);
  } finally { await tui.close(); await mock.close(); }
});

test('a slash token after prose completes in place without replacing the prompt', async () => {
  const prompts: any[] = [], command = { name: 'skill:dev', description: 'Development skill' };
  const root = agent('root', null, { name: 'Root' }); root.sessionId = 's1';
  const mock = await mockServer((socket, request) => {
    if (request.method === 'organization.snapshot') respond(socket, request.id, { seq: 0, agents: [root], operations: [], capabilities: { agentCommands: { version: 1 } }, agentCommands: { root: { version: 1, generation: 'g1', sessionId: 's1', commands: [command] } } });
    else if (request.method === 'events.history') respond(socket, request.id, { events: [], oldestSeq: 0, latestSeq: 0, expired: false });
    else if (request.method === 'agent.prompt') { prompts.push(request.params); respond(socket, request.id, operation('completed')); }
  });
  const tui = terminalClient(mock.path, mock.directory, { cols: 80, rows: 24 });
  try {
    await tui.visible('Root'); tui.keys('\r'); await tui.visible('Prompt · Root');
    tui.keys('Please use /skill:d'); await tui.visible('/skill:dev'); await new Promise(resolve => setTimeout(resolve, 40));
    tui.keys('\t'); await new Promise(resolve => setTimeout(resolve, 100));
    expect(tui.screen()).toContain('Please use /skill:dev'); expect(prompts).toHaveLength(0);
    tui.keys('with an arbitrary argument'); tui.keys('\r'); await waitFor(() => prompts.length === 1);
    expect(prompts[0].text).toBe('Please use /skill:dev with an arbitrary argument');
  } finally { await tui.close(); await mock.close(); }
});

test('command update clears an open candidate and escape dismisses without changing draft', async () => {
  const root = agent('root', null, { name: 'Root' }); root.generation = 'g1'; root.sessionId = 's1'; root.state = 'idle';
  const initial = { version: 1, generation: 'g1', sessionId: 's1', commands: [{ name: 'web', description: 'Search' }] };
  const mock = await mockServer((socket, request) => {
    if (request.method === 'organization.snapshot') respond(socket, request.id, { seq: 0, agents: [root], operations: [], agentCommands: { root: initial }, capabilities: { agentCommands: { version: 1 } } });
    else if (request.method === 'events.history') respond(socket, request.id, { events: [], oldestSeq: 0, latestSeq: 0, expired: false });
    else if (request.method === 'agent.prompt') respond(socket, request.id, operation('completed'));
  });
  const tui = terminalClient(mock.path, mock.directory, { cols: 80, rows: 24 });
  try {
    await tui.visible('Root'); tui.keys('\r'); await tui.visible('Prompt · Root'); tui.keys('/w'); await tui.visible('/web');
    tui.keys('\x1b'); await new Promise(resolve => setTimeout(resolve, 650));
    expect(tui.screen()).toContain('/w'); expect(tui.screen()).not.toContain('/web');
    send([...mock.sockets][0]!, event(1, 'agent.commands', { ...initial, commands: [] }, { agentId: 'root', generation: 'g1' }));
    await new Promise(resolve => setTimeout(resolve, 30));
    tui.keys('\t'); await new Promise(resolve => setTimeout(resolve, 30));
    expect(tui.screen()).toContain('/w');
  } finally { await tui.close(); await mock.close(); }
});
