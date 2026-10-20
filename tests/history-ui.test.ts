import { expect, test } from 'bun:test';
import { writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { agent, event, mockServer, respond, waitFor } from './helpers.js';
import { terminalClient } from './terminal.js';

test('history preferences are editable in the TUI, persist, and apply immediately; PgUp loads older agent history', async () => {
  const history = Array.from({ length: 30 }, (_, i) => event(i + 1, 'agent.message', { messageId: String(i), content: { text: `MESSAGE_${String(i + 1).padStart(2, '0')}` } }));
  const requests: any[] = [];
  const mock = await mockServer((socket, request) => {
    requests.push(request);
    if (request.method === 'organization.snapshot') respond(socket, request.id, { seq: 30, agents: [agent('root')], operations: [] });
    else if (request.method === 'events.history') {
      const matches = history.filter(e => e.seq < request.params.before);
      respond(socket, request.id, { events: matches.slice(-request.params.limit), hasMore: matches.length > request.params.limit, oldestSeq: 1, latestSeq: 30, expired: false });
    }
  });
  const path = join(mock.directory, 'config.json');
  await writeFile(path, JSON.stringify({ excluded: [], levels: {}, history: { recentEvents: 6, chatPageSize: 2, cacheBytes: 32768, idleMinutes: 10 } }));
  const tui = terminalClient(mock.path, mock.directory);
  try {
    await tui.visible('MESSAGE_30');
    tui.keys('v'); await tui.visible('View settings');
    tui.keys('h'); await tui.visible('History cache');
    await tui.visible('Cached events (maximum): 6');
    tui.keys('\r'); await tui.visible('Edit Cached events');
    tui.keys('\x15' + '0\r'); await tui.visible('Invalid history');
    tui.keys('\x15' + '4\r'); await tui.visible('Cached events (maximum): 4');
    await waitFor(() => JSON.parse(readFileSync(path, 'utf8')).history.recentEvents === 4);
    tui.keys('\x1b'); await tui.visible('LATEST TRACKED EVENT');
    tui.keys('c'); await tui.visible('Chat · root'); await tui.visible('MESSAGE_29');
    expect(tui.screen()).not.toContain('MESSAGE_28');
    tui.keys('\x1b[5~'); // PageUp reaches the loaded top and requests an older page.
    await waitFor(() => requests.some(r => r.method === 'events.history' && r.params.agentId === 'root' && r.params.before === 29));
    await tui.visible('MESSAGE_27');
    tui.keys('\x1b[1;5F'); // Ctrl+End follows the recent tail again.
    await tui.visible('MESSAGE_30');
    tui.keys('\x1b'); await tui.visible('LATEST TRACKED EVENT');
    tui.keys('v'); await tui.visible('View settings'); tui.keys('h'); await tui.visible('Cached events (maximum): 4');
  } finally { await tui.close(); await mock.close(); }
}, 15_000);
