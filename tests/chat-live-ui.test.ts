import { expect, test } from 'bun:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { agent, event, mockServer, respond, send } from './helpers.js';
import { terminalClient } from './terminal.js';

const message = (seq: number, text: string) => event(seq, 'agent.message', {
  sessionUpdate: 'agent_message_chunk', messageId: `message-${seq}`, content: { type: 'text', text },
}, { agentId: 'root', generation: 'g1' });

test('a no-op PageDown at chat bottom must not pause live messages; reopening recovers the missing event', async () => {
  const initial = message(1, 'INITIAL_CHAT_MARKER');
  const records = [initial];
  let latest = 1;
  let root = agent('root');
  const mock = await mockServer((socket, request) => {
    if (request.method === 'organization.snapshot') {
      respond(socket, request.id, { seq: latest, agents: [root], operations: [] });
    } else if (request.method === 'events.history') {
      const matches = records.filter(item => item.seq < request.params.before &&
        (!request.params.agentId || item.agentId === request.params.agentId));
      respond(socket, request.id, {
        events: matches.slice(-request.params.limit), hasMore: matches.length > request.params.limit,
        oldestSeq: records[0]?.seq ?? 0, latestSeq: latest, expired: false,
      });
    }
  });
  await writeFile(join(mock.directory, 'config.json'), JSON.stringify({
    levels: {}, compactToolCalls: false,
    history: { recentEvents: 40, chatPageSize: 10, cacheBytes: 131_072, idleMinutes: 10 },
  }));
  const tui = terminalClient(mock.path, mock.directory, { cols: 120, rows: 30 });
  try {
    await tui.visible('LATEST TRACKED EVENT');
    tui.keys('?');
    await tui.visible('Keys · tree');
    tui.keys('\x1b');
    await tui.visible('LATEST TRACKED EVENT');
    tui.keys('c');
    await tui.visible('Chat · root');
    await tui.visible('INITIAL_CHAT_MARKER');
    latest = 2;
    const beforePause = message(2, 'LIVE_BEFORE_NOOP'); records.push(beforePause);
    for (const socket of mock.sockets) send(socket, beforePause);
    await tui.visible('LIVE_BEFORE_NOOP');

    tui.keys('\x1b[6~'); // PageDown while this short transcript is already at its bottom.
    await tui.flush();
    latest = 3;
    const missed = message(3, 'LIVE_AFTER_NOOP'); records.push(missed);
    for (const socket of mock.sockets) send(socket, missed);
    await tui.flush();

    latest = 4;
    root = agent('root', null, { name: 'ROOT_AFTER_DELIVERY_BARRIER' });
    const barrier = event(4, 'agent.modified', root, { agentId: 'root', generation: 'g1' });
    records.push(barrier);
    for (const socket of mock.sockets) send(socket, barrier);
    await tui.visible('ROOT_AFTER_DELIVERY_BARRIER');
    await tui.flush();
    const visibleBeforeReopen = tui.screen().includes('LIVE_AFTER_NOOP');

    tui.keys('\x1b');
    await tui.visible('LATEST TRACKED EVENT');
    tui.keys('c');
    await tui.visible('Chat · ROOT_AFTER_DELIVERY_BARRIER');
    await tui.visible('LIVE_AFTER_NOOP');

    latest = 5;
    const afterReopen = message(5, 'LIVE_AFTER_REOPEN'); records.push(afterReopen);
    for (const socket of mock.sockets) send(socket, afterReopen);
    await tui.visible('LIVE_AFTER_REOPEN');
    expect(visibleBeforeReopen).toBe(true);
  } finally { await tui.close(); await mock.close(); }
}, 15_000);
