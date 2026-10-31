import { expect, test } from 'bun:test';
import { agent, event, mockServer, operation, respond, send, waitFor } from './helpers.js';
import { terminalClient } from './terminal.js';
import stripAnsi from 'strip-ansi';
import { renderEvent } from '../src/render.js';
import { Settings } from '../src/settings.js';

function composerRows(tui: ReturnType<typeof terminalClient>): string[] {
  const lines = tui.screen().split('\n');
  const top = lines.findIndex(line => line.startsWith('─ >'));
  const bottom = lines.findIndex((line, index) => index > top && /^─+$/.test(line));
  return top >= 0 && bottom > top ? lines.slice(top + 1, bottom).map(line => line.trimEnd()) : [];
}

for (const view of ['prompt', 'chat'] as const) {
  for (const cols of [32, 120]) {
    test(`${view} composer wraps every repeated key at ${cols} columns, shrinks and sends the entire draft`, async () => {
      const prompts: unknown[] = [];
      const mock = await mockServer((socket, request) => {
        if (request.method === 'organization.snapshot') respond(socket, request.id, { seq: 0, agents: [agent('root')], operations: [] });
        else if (request.method === 'events.history') respond(socket, request.id, { events: [], oldestSeq: 0, latestSeq: 0, expired: false });
        else if (request.method === 'agent.prompt') { prompts.push(request.params); respond(socket, request.id, operation('completed')); }
      });
      const tui = terminalClient(mock.path, mock.directory, { cols });
      try {
        await tui.visible('root   idle');
        tui.keys(view === 'chat' ? 'c' : '\r');
        await tui.visible(view === 'chat' ? 'Chat · root' : 'Prompt · root');
        let draft = '';
        // Include exact row boundaries and multiple growth transitions. The
        // textarea reserves one column so the cursor never wraps the terminal.
        for (const length of [cols - 1, cols, 2 * (cols - 1), 3 * (cols - 1) + 13]) {
          const tail = 'a'.repeat(length - draft.length);
          for (const ch of tail) tui.keys(ch);
          draft += tail;
          await waitFor(() => composerRows(tui).join('') === draft);
          expect(composerRows(tui)).toHaveLength(Math.ceil(length / (cols - 1)));
          expect(tui.cursor()).toEqual({ x: (length - 1) % (cols - 1) + 1, y: 26 });
          expect(tui.screen().split('\n')[27]).toBe('─'.repeat(cols));
        }
        tui.keys('\x7f'.repeat(draft.length - 5));
        await waitFor(() => composerRows(tui).join('') === 'aaaaa' && composerRows(tui).length === 1);
        expect(tui.screen().split('\n')[25]).toStartWith('─ >');
        tui.keys('\x15');
        await waitFor(() => composerRows(tui).join('') === 'aaaaa');
        tui.keys('\x03');
        await waitFor(() => composerRows(tui).join('') === '');
        expect(composerRows(tui)).toHaveLength(1);

        // Word wrapping and terminal-cell widths must use the same layout as
        // the rendered text, not a second independent wrapping algorithm.
        draft = 'wide 界 é words '.repeat(cols === 32 ? 7 : 20).trimEnd();
        tui.keys(draft);
        await waitFor(() => composerRows(tui).join('').replace(/\s/g, '') === draft.replace(/\s/g, ''));
        tui.keys('\r');
        await waitFor(() => prompts.length === 1);
        expect(prompts[0]).toEqual({ agentId: 'root', text: draft, queue: false });
        if (view === 'chat') {
          await waitFor(() => composerRows(tui).length === 1 && composerRows(tui)[0] === '');
        } else {
          // The footer hint is already visible while the prompt is still sending,
          // so wait for the composer itself to disappear after the response.
          await waitFor(() => !tui.screen().includes('─ >'));
          expect(tui.screen()).not.toContain('─ >');
        }
      } finally { await tui.close(); await mock.close(); }
    });
  }
}

test.each([
  ['chat', '\x1b\r', '\x1b[13;5u'],
  ['prompt', '\x1b[27;3;13~', '\x1b[27;5;13~'],
] as const)('%s accepts raw Alt-Enter queue and Ctrl-Enter interrupt modes exactly once', async (view, altEnter, ctrlEnter) => {
  const requests: any[] = [];
  let accepted = 0;
  const active = { ...operation('running'), id: 'active-prompt', agentId: 'root' };
  const backlog = { ...operation('queued'), id: 'old-backlog', agentId: 'root' };
  const mock = await mockServer((socket, request) => {
    requests.push(request);
    if (request.method === 'organization.snapshot') respond(socket, request.id, { seq: 0, agents: [agent('root')], operations: [active, backlog] });
    else if (request.method === 'events.history') respond(socket, request.id, { events: [], oldestSeq: 0, latestSeq: 0, expired: false });
    else if (request.method === 'agent.prompt') {
      accepted++;
      respond(socket, request.id, { ...operation('queued'), id: `queued-${accepted}`, agentId: 'root' });
    } else if (request.method === 'agent.steer') respond(socket, request.id, { agentId: 'root', operationId: 'active-prompt', steeringId: 'plain-enter-steer', disposition: 'submitted' });
  });
  const tui = terminalClient(mock.path, mock.directory, { cols: 100 });
  try {
    await tui.visible('root   idle');
    const openCompose = async () => {
      tui.keys(view === 'chat' ? 'c' : '\r');
      await tui.visible(view === 'chat' ? 'Chat · root' : 'Prompt · root');
    };
    await openCompose();
    await tui.visible('1x queued prompts');
    tui.keys('queue this exact draft'); tui.keys(altEnter);
    await waitFor(() => requests.filter(request => request.method === 'agent.prompt').length === 1);
    if (view === 'prompt') await openCompose();
    await tui.visible('2x queued prompts');
    expect(requests.filter(request => request.method === 'agent.prompt').map(request => request.params)).toEqual([
      { agentId: 'root', text: 'queue this exact draft', queue: true },
    ]);
    tui.keys('replace active with this'); tui.keys(ctrlEnter);
    await waitFor(() => requests.filter(request => request.method === 'agent.prompt').length === 2);
    if (view === 'prompt') { await openCompose(); await tui.visible('3x queued prompts'); }
    else await tui.visible('3x queued prompts');
    expect(requests.filter(request => request.method === 'agent.prompt').map(request => request.params)).toEqual([
      { agentId: 'root', text: 'queue this exact draft', queue: true },
      { agentId: 'root', text: 'replace active with this', queue: false },
    ]);
    tui.keys('plain Enter keeps default'); tui.keys('\r');
    await waitFor(() => requests.filter(request => request.method === 'agent.steer').length === 1);
    expect(requests.filter(request => request.method === 'agent.steer').map(request => request.params)).toEqual([
      { agentId: 'root', operationId: 'active-prompt', text: 'plain Enter keeps default' },
    ]);
  } finally { await tui.close(); await mock.close(); }
});

test.each([
  ['chat', 'queue', '\x1b\r', true],
  ['prompt', 'interrupt', '\x1b[27;5;13~', false],
] as const)('%s rejected %s submission preserves the draft', async (view, _mode, key, queue) => {
  const requests: any[] = [];
  const mock = await mockServer((socket, request) => {
    requests.push(request);
    if (request.method === 'organization.snapshot') respond(socket, request.id, { seq: 0, agents: [agent('root')], operations: [] });
    else if (request.method === 'events.history') respond(socket, request.id, { events: [], oldestSeq: 0, latestSeq: 0, expired: false });
    else if (request.method === 'agent.prompt') send(socket, { kind: 'response', id: request.id, ok: false, error: { code: 'NOT_RUNNING', message: 'recipient unavailable' } });
  });
  const tui = terminalClient(mock.path, mock.directory, { cols: 100 });
  try {
    await tui.visible('root   idle');
    tui.keys(view === 'chat' ? 'c' : '\r');
    await tui.visible(view === 'chat' ? 'Chat · root' : 'Prompt · root');
    const draft = 'preserve exact rejected text';
    tui.keys(draft); tui.keys(key);
    await waitFor(() => requests.filter(request => request.method === 'agent.prompt').length === 1 && tui.screen().includes('recipient unavailable'));
    expect(requests.filter(request => request.method === 'agent.prompt').map(request => request.params)).toEqual([
      { agentId: 'root', text: draft, queue },
    ]);
    await waitFor(() => composerRows(tui).join('') === draft);
    expect(requests.some(request => request.method === 'agent.steer')).toBe(false);
  } finally { await tui.close(); await mock.close(); }
});

test('Enter submits steering promptly and shows its lifecycle without interrupting the operation', async () => {
  const requests: any[] = [];
  const active = { ...operation('running'), id: 'active-child-prompt', agentId: 'root' };
  let pendingSteer: { socket: any; id: string } | undefined;
  const mock = await mockServer((socket, request) => {
    requests.push(request);
    if (request.method === 'organization.snapshot') respond(socket, request.id, { seq: 0, agents: [agent('root')], operations: [active] });
    else if (request.method === 'events.history') respond(socket, request.id, { events: [], oldestSeq: 0, latestSeq: 0, expired: false });
    else if (request.method === 'agent.steer') {
      pendingSteer = { socket, id: request.id };
      send(socket, event(1, 'prompt.steer_submitted', { steeringId: 'steer-1', operationId: active.id, text: 'Continue after the sleep without stopping it' }));
      respond(socket, request.id, { agentId: 'root', operationId: active.id, steeringId: 'steer-1', disposition: 'submitted' });
    } else if (request.method === 'agent.prompt') respond(socket, request.id, operation('queued'));
  });
  const tui = terminalClient(mock.path, mock.directory, { cols: 80 });
  try {
    await tui.visible('root   idle'); tui.keys('c'); await tui.visible('Chat · root');
    tui.keys('Continue after the sleep without stopping it');
    tui.keys('\r');
    const steeringEventCount = () => (stripAnsi(tui.screen()).match(/YOU · STEER/g) ?? []).length;
    await waitFor(() => !!pendingSteer && steeringEventCount() >= 1);
    expect(steeringEventCount()).toBe(1);
    expect(requests.some(request => request.method === 'agent.steer')).toBe(true);
    send(pendingSteer!.socket, event(2, 'prompt.steer_pending', { steeringId: 'steer-1', operationId: active.id, text: 'Continue after the sleep without stopping it' }));
    await waitFor(() => steeringEventCount() >= 2);
    expect(requests.find(request => request.method === 'agent.steer').params).toEqual({ agentId: 'root', operationId: active.id, text: 'Continue after the sleep without stopping it' });
    expect(requests.some(request => request.method === 'agent.prompt')).toBe(false);
    send(pendingSteer!.socket, event(3, 'prompt.steer_delivered', { steeringId: 'steer-1', operationId: active.id, text: 'Continue after the sleep without stopping it' }));
    await waitFor(() => steeringEventCount() >= 3);
    expect(steeringEventCount()).toBe(3);
    expect(stripAnsi(tui.screen())).not.toMatch(/STEERING (SUBMITTED|PENDING|DELIVERED)/);
    expect(active.status).toBe('running');
  } finally { await tui.close(); await mock.close(); }
});

test('steering and queued prompt detail levels label states, stay flush-left, and use literal truncation', () => {
  const steering = event(1, 'prompt.steer_pending', { steeringId: 's', operationId: 'o', text: 'a very long prompt text '.repeat(20) });
  const summary = stripAnsi(renderEvent(steering, 1, 120));
  expect(summary).toStartWith('YOU · STEER —');
  const extended = stripAnsi(renderEvent(steering, 2, 24)).split('\n');
  expect(extended).toHaveLength(2);
  expect(extended[0]).toBe('YOU · STEER');
  expect(extended[1]!.startsWith(' ')).toBe(false);
  expect(extended[1]).toEndWith('...');
  const full = stripAnsi(renderEvent(steering, 3, 24)).split('\n');
  expect(full[0]).toBe('YOU · STEER');
  expect(full.slice(1).every(line => !line.startsWith(' '))).toBe(true);
  for (const [effect, label] of [['normal', 'PROMPT'], ['interrupt', 'INTERRUPT'], ['queue', 'QUEUE']] as const) {
    const queued = event(2, 'prompt.queued', { effect, text: 'a long prompt '.repeat(20) });
    expect(stripAnsi(renderEvent(queued, 1, 120))).toStartWith(`YOU · ${label}`);
    const detail = stripAnsi(renderEvent(queued, 2, 24)).split('\n');
    expect(detail[0]).toContain(label);
    expect(detail[1]!.startsWith(' ')).toBe(false);
    expect(detail[1]).toEndWith('...');
    const all = stripAnsi(renderEvent(queued, 3, 24)).split('\n');
    expect(all[0]).toContain(label);
    expect(all.slice(1).every(line => !line.startsWith(' '))).toBe(true);
  }
});

test('composer caps at the terminal height, follows the tail and restores the full draft when cleared', async () => {
  const prompts: unknown[] = [];
  const mock = await mockServer((socket, request) => {
    if (request.method === 'organization.snapshot') respond(socket, request.id, { seq: 0, agents: [agent('root')], operations: [] });
    else if (request.method === 'events.history') respond(socket, request.id, { events: [], oldestSeq: 0, latestSeq: 0, expired: false });
    else if (request.method === 'agent.prompt') { prompts.push(request.params); respond(socket, request.id, operation('completed')); }
  });
  const tui = terminalClient(mock.path, mock.directory, { cols: 40, rows: 12 });
  try {
    await tui.visible('root   idle');
    tui.keys('c'); await tui.visible('Chat · root');
    const draft = 'START' + 'a'.repeat(39 * 8) + 'END';
    tui.keys(draft);
    await waitFor(() => composerRows(tui).join('').endsWith('END'));
    expect(composerRows(tui)).toHaveLength(5);
    expect(composerRows(tui).join('')).not.toContain('START');
    expect(tui.cursor().y).toBe(8);
    tui.keys('\r'); await waitFor(() => prompts.length === 1);
    expect(prompts[0]).toEqual({ agentId: 'root', text: draft, queue: false });
    await waitFor(() => composerRows(tui).length === 1 && composerRows(tui)[0] === '');
  } finally { await tui.close(); await mock.close(); }
});
