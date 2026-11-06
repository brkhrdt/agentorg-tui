import { expect, test } from 'vitest';
import { agent, mockServer, respond, waitFor } from './helpers.js';
import { terminalClient } from './terminal.js';

const fixture = [
  agent('root'), agent('a', 'root'), agent('a1', 'a'), agent('a1x', 'a1'),
  agent('b', 'root'), agent('b1', 'b'), agent('b1x', 'b1'), agent('c', 'root'),
];

async function foldedPrompt(exit: 'submit' | 'cancel') {
  const prompts: any[] = [];
  const mock = await mockServer((socket, request) => {
    if (request.method === 'organization.snapshot') respond(socket, request.id, { seq: 0, agents: fixture, operations: [] });
    else if (request.method === 'events.history') respond(socket, request.id, { events: [], oldestSeq: 0, latestSeq: 0, expired: false });
    else if (request.method === 'agent.prompt') {
      prompts.push(request.params);
      respond(socket, request.id, { id: 'op-b', agentId: 'b', type: 'agent.prompt', status: 'completed', input: {} });
    }
  });
  const tui = terminalClient(mock.path, mock.directory);
  try {
    await tui.visible('  a'); await tui.visible('  b');
    tui.keys('\x1b[B\x1b[B'); await new Promise(resolve => setTimeout(resolve, 50));
    tui.keys('\t'); await tui.visible('a1 ▸');
    tui.keys('\x1b[A'); await new Promise(resolve => setTimeout(resolve, 50));
    tui.keys('\t'); await tui.visible('a ▸');
    tui.keys('\x1b[B'); await new Promise(resolve => setTimeout(resolve, 50));
    tui.keys('\t'); await tui.visible('b ▸');
    const assertProjection = () => {
      const lines = tui.screen().split('\n');
      const tree = lines.slice(2, 25).join('\n');
      expect(tree).toContain('a ▸');
      expect(tree).toContain('b ▸');
      for (const hidden of ['a1', 'a1x', 'b1', 'b1x']) expect(tree).not.toContain(hidden);
      const selected = lines.findIndex(line => line.includes(' b ') && !line.includes('Prompt ·'));
      expect(selected).toBeGreaterThanOrEqual(2);
      expect(tui.cell(selected, 0)?.getBgColor()).toBe(4);
    };
    assertProjection();

    tui.keys('\r'); await tui.visible('Prompt · b');
    assertProjection();
    tui.keys('hello fold regression'); await tui.visible('hello fold regression');
    assertProjection();
    if (exit === 'cancel') {
      tui.keys('\x1b'); await tui.visible('Enter prompt');
      expect(prompts).toHaveLength(0);
    } else {
      tui.keys('\r');
      await waitFor(() => prompts.length === 1);
      expect(prompts[0]).toEqual({ agentId: 'b', text: 'hello fold regression', queue: false });
      await tui.visible('Enter prompt');
    }
    assertProjection();
  } finally { await tui.close(); await mock.close(); }
}

test('prompt preserves folded branches on cancel', () => foldedPrompt('cancel'));
test('prompt preserves folded branches on submit', () => foldedPrompt('submit'));
