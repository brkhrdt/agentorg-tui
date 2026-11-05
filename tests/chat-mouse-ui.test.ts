import { expect, test } from 'bun:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { agent, event, mockServer, operation, respond, send, waitFor } from './helpers.js';
import { terminalClient } from './terminal.js';

const message = event(1, 'agent.message', {
  sessionUpdate: 'agent_message_chunk', messageId: 'mouse-message', content: { type: 'text', text: 'CLICK_TARGET_TRANSCRIPT' },
}, { agentId: 'root', generation: 'g1' });

test('clicking chat transcript preserves chat and keeps the composer ready', async () => {
  let root = agent('root');
  const prompts: any[] = [];
  const mock = await mockServer((socket, request) => {
    if (request.method === 'organization.snapshot') respond(socket, request.id, { seq: 1, agents: [root], operations: [] });
    else if (request.method === 'events.history') respond(socket, request.id, { events: [message], hasMore: false, oldestSeq: 1, latestSeq: 1, expired: false });
    else if (request.method === 'agent.prompt') {
      prompts.push(request.params);
      respond(socket, request.id, { ...operation('completed'), agentId: 'root' });
    }
  });
  await writeFile(join(mock.directory, 'config.json'), JSON.stringify({
    levels: { 'agent.modified': 0, 'agent.message': 1, 'operation.changed': 0 },
    history: { recentEvents: 100, chatPageSize: 30, cacheBytes: 1_048_576, idleMinutes: 10 },
  }));
  const tui = terminalClient(mock.path, mock.directory, { cols: 120, rows: 30 });
  try {
    await tui.visible('LATEST TRACKED EVENT');
    tui.keys('?'); await tui.visible('Keys · tree');
    tui.keys('\x1b'); await tui.visible('LATEST TRACKED EVENT');
    tui.keys('c');
    await tui.visible('Chat · root');
    await tui.visible('CLICK_TARGET_TRANSCRIPT');
    const draft = 'draft with whitespace';
    tui.keys(draft);
    await tui.visible(draft);

    tui.keys('\x1b[<0;11;6M'); // SGR left press in transcript.
    tui.keys('\x1b[<0;11;6m'); // SGR left release synthesizes Blessed click.
    root = agent('root', null, { name: 'CLICK_DELIVERY_BARRIER' });
    const barrier = event(2, 'agent.modified', root, { agentId: 'root', generation: 'g1' });
    for (const socket of mock.sockets) send(socket, barrier);
    await tui.visible('Chat · CLICK_DELIVERY_BARRIER');
    await new Promise(resolve => setTimeout(resolve, 80));
    expect(tui.screen()).toContain('Chat · CLICK_DELIVERY_BARRIER');
    expect(tui.screen()).toContain(draft);
    expect(prompts).toHaveLength(0);

    // Other ordinary mouse boundaries must remain passive too: X10 at the
    // scrollbar edge, coalesced SGR click on blank transcript, and release-only.
    const x10 = '\x1b[M' + String.fromCharCode(32, 120, 10) + '\x1b[M' + String.fromCharCode(35, 120, 10);
    tui.keys(x10);
    tui.keys('\x1b[<0;110;8M\x1b[<0;110;8m');
    tui.keys('\x1b[<0;11;8m');
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(tui.screen()).toContain('Chat · CLICK_DELIVERY_BARRIER');
    expect(tui.screen()).toContain(draft);
    expect(prompts).toHaveLength(0);

    tui.keys('still editable');
    tui.keys('\r');
    await waitFor(() => prompts.length === 1);
    expect(prompts).toEqual([{ agentId: 'root', text: `${draft}still editable`, queue: false }]);
  } finally { await tui.close(); await mock.close(); }
}, 15_000);
