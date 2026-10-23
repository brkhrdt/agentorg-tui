import { expect, test } from 'bun:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { agent, event, mockServer, operation, respond, send, waitFor } from './helpers.js';
import { terminalClient } from './terminal.js';

const message = (seq: number, text: string) => event(seq, 'agent.message', {
  sessionUpdate: 'agent_message_chunk', messageId: `message-${seq}`, content: { type: 'text', text },
}, { agentId: 'root', generation: 'g1' });

test('chat appends while scrolled, preserves the viewport and outgoing prompt, then reveals the live tail by scrolling down', async () => {
  const records = Array.from({ length: 24 }, (_, index) => message(index + 1, index + 1 === 14 ? 'ANCHOR_14' : `HISTORY_${index + 1}`));
  let latest = 24;
  let root = agent('root');
  const requests: any[] = [];
  const prompts: any[] = [];
  const mock = await mockServer((socket, request) => {
    requests.push(request);
    if (request.method === 'organization.snapshot') respond(socket, request.id, { seq: latest, agents: [root], operations: [] });
    else if (request.method === 'events.history') {
      const matches = records.filter(item => item.seq > request.params.after && item.seq < request.params.before &&
        (!request.params.agentId || item.agentId === request.params.agentId));
      respond(socket, request.id, { events: matches.slice(-request.params.limit), hasMore: matches.length > request.params.limit, oldestSeq: 1, latestSeq: latest, expired: false });
    } else if (request.method === 'agent.prompt') {
      prompts.push(request.params);
      latest = 29;
      const queued = event(28, 'prompt.queued', { text: request.params.text, operationId: 'op-1' }, { agentId: 'root', generation: 'g1' });
      const reply = message(29, 'PROMPT_REPLY_MARKER');
      records.push(queued, reply);
      send(socket, queued); send(socket, reply);
      respond(socket, request.id, { ...operation('completed'), id: 'op-1', agentId: 'root' });
    }
  });
  await writeFile(join(mock.directory, 'config.json'), JSON.stringify({
    excluded: ['agent.modified', 'operation.changed', 'prompt.queued'],
    levels: { 'agent.message': 3 }, compactToolCalls: false,
    history: { recentEvents: 100, chatPageSize: 30, cacheBytes: 1_048_576, idleMinutes: 10 },
  }));
  const tui = terminalClient(mock.path, mock.directory, { cols: 120, rows: 30 });
  try {
    await tui.visible('LATEST TRACKED EVENT');
    tui.keys('?'); await tui.visible('Keys · tree');
    tui.keys('\x1b'); await tui.visible('LATEST TRACKED EVENT');
    tui.keys('c'); await tui.visible('Chat · root');
    await tui.visible('HISTORY_24');
    const agentHistoryRequests = () => requests.filter(request => request.method === 'events.history' && request.params.agentId === 'root').length;
    const initialAgentHistoryRequests = agentHistoryRequests();

    tui.keys('\x1b[5~'); // Scroll up, but remain below the loaded top.
    await tui.visible('ANCHOR_14');
    await tui.flush();
    const anchorRow = () => tui.screen().split('\n').findIndex(line => line.includes('ANCHOR_14'));
    const initialAnchorRow = anchorRow();
    expect(initialAnchorRow).toBeGreaterThanOrEqual(0);
    expect(tui.screen()).not.toContain('HISTORY_24');

    for (const [seq, text] of [[25, 'LIVE_25'], [26, 'LIVE_26']] as const) {
      latest = seq;
      const incoming = message(seq, text); records.push(incoming);
      for (const socket of mock.sockets) send(socket, incoming);
    }
    latest = 27;
    root = agent('root', null, { name: 'ROOT_DELIVERY_BARRIER' });
    const barrier = event(27, 'agent.modified', root, { agentId: 'root', generation: 'g1' }); records.push(barrier);
    for (const socket of mock.sockets) send(socket, barrier);
    await tui.visible('Chat · ROOT_DELIVERY_BARRIER');
    await tui.flush();
    expect(anchorRow()).toBe(initialAnchorRow);
    expect(tui.screen()).not.toContain('LIVE_25');
    expect(tui.screen()).not.toContain('LIVE_26');

    const promptText = 'outgoing while scrolled '.repeat(4);
    tui.keys(promptText); tui.keys('\r');
    await tui.visible('Prompt completed');
    await waitFor(() => prompts.length === 1);
    await tui.flush();
    expect(prompts).toEqual([{ agentId: 'root', text: promptText, queue: false }]);
    expect(anchorRow()).toBe(initialAnchorRow);
    expect(tui.screen()).not.toContain('PROMPT_REPLY_MARKER');

    for (let page = 0; page < 6; page++) { tui.keys('\x1b[6~'); await tui.flush(); }
    expect(tui.screen()).toContain('LIVE_25');
    expect(tui.screen()).toContain('LIVE_26');
    expect(tui.screen()).toContain('PROMPT_REPLY_MARKER');
    expect(agentHistoryRequests()).toBe(initialAgentHistoryRequests);

    latest = 30;
    const afterBottom = message(30, 'FOLLOWING_AT_BOTTOM'); records.push(afterBottom);
    for (const socket of mock.sockets) send(socket, afterBottom);
    await tui.visible('FOLLOWING_AT_BOTTOM');
  } finally { await tui.close(); await mock.close(); }
}, 20_000);
