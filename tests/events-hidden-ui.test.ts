import { expect, test } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { agent, event, mockServer, respond, send, waitFor } from './helpers.js';
import { terminalClient } from './terminal.js';

const marker = 'QUIET_LATEST';

test('tree keeps an observed quiet-agent preview after pressure while chat recovers durable history', async () => {
  let latestSeq = 0;
  const requests: any[] = [];
  const durable = [event(1, 'agent.message', {
    sessionUpdate: 'agent_message_chunk', messageId: 'quiet-message', content: { type: 'text', text: marker },
  }, { agentId: 'quiet', generation: 'g1' })];
  const mock = await mockServer((socket, request) => {
    requests.push(request);
    if (request.method === 'organization.snapshot') {
      respond(socket, request.id, { seq: 0, agents: [agent('quiet'), agent('busy')], operations: [] });
    } else if (request.method === 'events.history') {
      const matches = durable.filter(e => e.seq < request.params.before &&
        (!request.params.agentId || e.agentId === request.params.agentId));
      respond(socket, request.id, {
        events: matches.slice(-request.params.limit), hasMore: matches.length > request.params.limit,
        oldestSeq: 1, latestSeq, expired: false,
      });
    }
  });
  const config = join(mock.directory, 'config.json');
  await writeFile(config, JSON.stringify({
    levels: {}, tableFields: ['name', 'event'], compactToolCalls: false,
    history: { recentEvents: 3, chatPageSize: 2, cacheBytes: 32768, idleMinutes: 10 },
  }));
  const tui = terminalClient(mock.path, mock.directory, { cols: 120, rows: 30 });
  try {
    await tui.visible('LATEST TRACKED EVENT');
    for (const socket of mock.sockets) send(socket, durable[0]);
    await tui.visible(marker);

    for (let seq = 2; seq <= 5; seq++) {
      latestSeq = seq;
      for (const socket of mock.sockets) send(socket, event(seq, 'agent.message', {
        sessionUpdate: 'agent_message_chunk', messageId: `busy-${seq}`, content: { type: 'text', text: `BUSY_${seq}` },
      }, { agentId: 'busy', generation: 'g1' }));
    }
    await tui.visible('BUSY_5');
    const quietPreviewSurvivedPressure = tui.screen().includes(marker);

    tui.keys('\x1b[B');
    tui.keys('c');
    await tui.visible('Chat · quiet');
    await waitFor(() => requests.some(r => r.method === 'events.history' && r.params.agentId === 'quiet'));
    const historyRequest = requests.find(r => r.method === 'events.history' && r.params.agentId === 'quiet');
    expect(historyRequest.params).toMatchObject({ after: 0, before: 6, agentId: 'quiet', limit: 2 });
    await tui.visible(marker);
    tui.keys('\x1b');
    await tui.visible('LATEST TRACKED EVENT');
    expect(quietPreviewSurvivedPressure).toBe(true);
  } finally {
    await tui.close();
    await mock.close();
  }
}, 15_000);
