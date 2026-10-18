import { expect, test } from 'bun:test';
import { agent, mockServer, operation, respond, waitFor } from './helpers.js';
import { terminalClient } from './terminal.js';

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
        await tui.visible(view === 'chat' ? 'Chat · root' : 'Interrupting');
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
          await tui.visible('↑↓ select');
          expect(tui.screen()).not.toContain('─ >');
        }
      } finally { await tui.close(); await mock.close(); }
    });
  }
}

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
