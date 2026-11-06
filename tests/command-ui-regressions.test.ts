import { expect, test } from 'vitest';
import { agent, event, mockServer, operation, respond, send, waitFor } from './helpers.js';
import { terminalClient } from './terminal.js';

for (const view of ['chat', 'prompt'] as const) {
  test(`${view} command menu stays anchored above a wrapped draft`, async () => {
    const root = agent('root', null, { name: 'Root' }); root.generation = 'g1'; root.sessionId = 's1';
    const commands = [{ name: 'skill:dev', description: 'Development skill' }];
    const mock = await mockServer((socket, request) => {
      if (request.method === 'organization.snapshot') respond(socket, request.id, { seq: 0, agents: [root], operations: [], capabilities: { agentCommands: { version: 1 } }, agentCommands: { root: { version: 1, generation: 'g1', sessionId: 's1', commands } } });
      else if (request.method === 'events.history') respond(socket, request.id, { events: [], oldestSeq: 0, latestSeq: 0, expired: false });
    });
    const tui = terminalClient(mock.path, mock.directory, { cols: 40, rows: 24 });
    try {
      await tui.visible('Root');
      if (view === 'chat') { tui.keys('c'); await tui.visible('Chat · Root'); }
      else { tui.keys('\r'); await tui.visible('Prompt · Root'); }
      tui.keys('One important row of text. '.repeat(9) + '/skill:d');
      await tui.visible('› /skill:dev');
      const lines = tui.screen().split('\n');
      const menuRow = lines.findIndex(line => line.includes('› /skill:dev'));
      const composerRow = lines.findIndex(line => line.includes(' > '));
      expect(menuRow).toBeGreaterThanOrEqual(2);
      expect(composerRow).toBeGreaterThan(menuRow);
      expect(lines[menuRow]).toContain('skill:dev');
    } finally { await tui.close(); await mock.close(); }
  });

  test(`${view} command menu remains visible and selectable on a small screen`, async () => {
    const root = agent('root', null, { name: 'Root' }); root.sessionId = 's1';
    const mock = await mockServer((socket, request) => {
      if (request.method === 'organization.snapshot') respond(socket, request.id, { seq: 0, agents: [root], operations: [], capabilities: { agentCommands: { version: 1 } }, agentCommands: { root: { version: 1, generation: 'g1', sessionId: 's1', commands: [{ name: 'skill:dev', description: 'Development skill' }] } } });
      else if (request.method === 'events.history') respond(socket, request.id, { events: [], oldestSeq: 0, latestSeq: 0, expired: false });
    });
    const tui = terminalClient(mock.path, mock.directory, { cols: 40, rows: 9 });
    try {
      await tui.visible('Root');
      if (view === 'chat') { tui.keys('c'); await tui.visible('Chat · Root'); }
      else { tui.keys('\r'); await tui.visible('Prompt · Root'); }
      tui.keys('/skill:d'); await tui.visible('› /skill:dev');
      tui.keys('\t'); await waitFor(() => tui.screen().split('\n').some(line => line.trim() === '/skill:dev'));
      expect(tui.screen().split('\n').some(line => line.trim() === '/skill:dev')).toBe(true);
    } finally { await tui.close(); await mock.close(); }
  });

  for (const draft of ['/we\t', '/we']) {
    test(`${view} Tab synchronously completes buffered draft ${JSON.stringify(draft)}`, async () => {
      const prompts: any[] = [], root = agent('root', null, { name: 'Root' }); root.sessionId = 's1';
      const commands = [{ name: 'web', description: 'Search' }, { name: 'web-search', description: 'Search deeply' }];
      const mock = await mockServer((socket, request) => {
        if (request.method === 'organization.snapshot') respond(socket, request.id, { seq: 0, agents: [root], operations: [], capabilities: { agentCommands: { version: 1 } }, agentCommands: { root: { version: 1, generation: 'g1', sessionId: 's1', commands } } });
        else if (request.method === 'events.history') respond(socket, request.id, { events: [], oldestSeq: 0, latestSeq: 0, expired: false });
        else if (request.method === 'agent.prompt') { prompts.push(request.params); respond(socket, request.id, operation('completed')); }
      });
      const tui = terminalClient(mock.path, mock.directory, { cols: 80, rows: 24 });
      try {
        await tui.visible('Root');
        if (view === 'chat') { tui.keys('c'); await tui.visible('Chat · Root'); }
        else { tui.keys('\r'); await tui.visible('Prompt · Root'); }
        if (draft === '/we') tui.keys('/');
        tui.keys(draft === '/we' ? 'we\t' : draft);
        await waitFor(() => tui.screen().split('\n').some(line => line.trim() === '/web'));
        expect(prompts).toHaveLength(0);
        tui.keys('query'); tui.keys('\r'); await waitFor(() => prompts.length === 1);
        expect(prompts[0].text).toBe('/web query');
      } finally { await tui.close(); await mock.close(); }
    });
  }
}

test('chat command geometry preserves the scrolled transcript anchor and dismissal restores it', async () => {
  const root = agent('root', null, { name: 'Root' }); root.generation = 'g1'; root.sessionId = 's1';
  const records = Array.from({ length: 32 }, (_, index) => event(index + 1, 'agent.message', {
    sessionUpdate: 'agent_message_chunk', messageId: `message-${index + 1}`, content: { type: 'text', text: `COMMAND_HISTORY_${index + 1}` },
  }, { agentId: 'root', generation: 'g1' }));
  const mock = await mockServer((socket, request) => {
    if (request.method === 'organization.snapshot') respond(socket, request.id, { seq: 32, agents: [root], operations: [], capabilities: { agentCommands: { version: 1 } }, agentCommands: { root: { version: 1, generation: 'g1', sessionId: 's1', commands: [{ name: 'skill:dev', description: 'Development' }] } } });
    else if (request.method === 'events.history') {
      const matches = records.filter(item => item.seq > request.params.after && item.seq < request.params.before && (!request.params.agentId || item.agentId === request.params.agentId));
      respond(socket, request.id, { events: matches.slice(-request.params.limit), hasMore: matches.length > request.params.limit, oldestSeq: 1, latestSeq: 32, expired: false });
    }
  });
  const tui = terminalClient(mock.path, mock.directory, { cols: 80, rows: 24 });
  const firstVisibleHistory = () => tui.screen().split('\n').find(line => /COMMAND_HISTORY_\d+/.test(line))?.match(/COMMAND_HISTORY_\d+/)?.[0];
  try {
    await tui.visible('Root'); tui.keys('c'); await tui.visible('Chat · Root'); await tui.visible('COMMAND_HISTORY_32');
    const beforeScroll = firstVisibleHistory();
    tui.keys('\x1b[5~'); await waitFor(() => firstVisibleHistory() !== beforeScroll); await tui.flush();
    const anchor = firstVisibleHistory(); expect(anchor).toBeDefined();
    tui.keys('Please use /skill:d'); await tui.visible('› /skill:dev');
    expect(firstVisibleHistory()).toBe(anchor);
    tui.keys('\x1b'); await new Promise(resolve => setTimeout(resolve, 80));
    expect(tui.screen()).not.toContain('› /skill:dev');
    expect(firstVisibleHistory()).toBe(anchor);
  } finally { await tui.close(); await mock.close(); }
});

async function selectionFixture(initial: { name: string; description: string }[]) {
  const prompts: any[] = [], root = agent('root', null, { name: 'Root' }); root.sessionId = 's1';
  let seq = 0;
  const mock = await mockServer((socket, request) => {
    if (request.method === 'organization.snapshot') respond(socket, request.id, { seq, agents: [root], operations: [], capabilities: { agentCommands: { version: 1 } }, agentCommands: { root: { version: 1, generation: 'g1', sessionId: 's1', commands: initial } } });
    else if (request.method === 'events.history') respond(socket, request.id, { events: [], oldestSeq: 0, latestSeq: 0, expired: false });
    else if (request.method === 'agent.prompt') { prompts.push(request.params); respond(socket, request.id, operation('completed')); }
  });
  const tui = terminalClient(mock.path, mock.directory, { cols: 80, rows: 24 });
  await tui.visible('Root'); tui.keys('\r'); await tui.visible('Prompt · Root'); tui.keys('/');
  await tui.visible(`/${initial[0]!.name}`);
  const replace = (commands: { name: string; description: string }[]) => {
    seq++;
    send([...mock.sockets][0]!, event(seq, 'agent.commands', { version: 1, generation: 'g1', sessionId: 's1', commands }, { agentId: 'root', generation: 'g1' }));
  };
  return { tui, mock, prompts, replace };
}

test('selected command name survives reorder and insertion before it', async () => {
  const fixture = await selectionFixture([{ name: 'web', description: 'Search' }, { name: 'compact', description: 'Compact' }]);
  try {
    fixture.replace([{ name: 'compact', description: 'Compact' }, { name: 'web', description: 'Search' }]);
    await waitFor(() => fixture.tui.screen().indexOf('/compact') < fixture.tui.screen().indexOf('› /web'));
    fixture.tui.keys('\t'); await waitFor(() => fixture.tui.screen().split('\n').some(line => line.trim() === '/web'));
    expect(fixture.prompts).toHaveLength(0);
    fixture.tui.keys('\r'); await waitFor(() => fixture.prompts.length === 1);
    expect(fixture.prompts[0].text).toBe('/web ');
  } finally { await fixture.tui.close(); await fixture.mock.close(); }
});

test('insertion before the selected command preserves that name', async () => {
  const fixture = await selectionFixture([{ name: 'compact', description: 'Compact' }, { name: 'web', description: 'Search' }]);
  try {
    fixture.tui.keys('\x1b[B');
    fixture.replace([{ name: 'alpha', description: 'First' }, { name: 'compact', description: 'Compact' }, { name: 'web', description: 'Search' }]);
    await waitFor(() => fixture.tui.screen().indexOf('/alpha') < fixture.tui.screen().indexOf('/compact') && fixture.tui.screen().indexOf('/compact') < fixture.tui.screen().indexOf('› /web'));
    fixture.tui.keys('\t'); await fixture.tui.visible('/web ');
    fixture.tui.keys('\r'); await waitFor(() => fixture.prompts.length === 1);
    expect(fixture.prompts[0].text).toBe('/web ');
  } finally { await fixture.tui.close(); await fixture.mock.close(); }
});

test('deleting the selected command blocks Tab until the user deliberately selects another', async () => {
  const fixture = await selectionFixture([{ name: 'web', description: 'Search' }, { name: 'compact', description: 'Compact' }]);
  try {
    fixture.replace([{ name: 'compact', description: 'Compact' }]);
    await fixture.tui.visible('› /compact');
    fixture.tui.keys('\t'); await new Promise(resolve => setTimeout(resolve, 50));
    expect(fixture.tui.screen().split('\n')).toContain('/');
    fixture.tui.keys('\t'); await new Promise(resolve => setTimeout(resolve, 50));
    expect(fixture.tui.screen().split('\n')).toContain('/');
    expect(fixture.prompts).toHaveLength(0);
    fixture.tui.keys('\x1b[B'); fixture.tui.keys('\t'); await waitFor(() => fixture.tui.screen().split('\n').some(line => line.trim() === '/compact'));
    fixture.tui.keys('\r'); await waitFor(() => fixture.prompts.length === 1);
    expect(fixture.prompts[0].text).toBe('/compact ');
  } finally { await fixture.tui.close(); await fixture.mock.close(); }
});
