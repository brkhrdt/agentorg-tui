import { expect, test } from 'bun:test';
import { agent, mockServer, respond, waitFor } from './helpers.js';
import { terminalClient } from './terminal.js';

test('terminal tree arrows dispatch, wrap off-screen siblings, preserve vertical navigation and folds', async () => {
  const agents = [agent('root'), ...Array.from({ length: 40 }, (_, index) => agent(`child-${String(index).padStart(2, '0')}`, 'root'))];
  const mock = await mockServer((_socket, request) => {
    if (request.method === 'organization.snapshot') respond(_socket, request.id, { seq: 0, agents, operations: [] });
    else if (request.method === 'events.history') respond(_socket, request.id, { events: [], oldestSeq: 1, latestSeq: 0, expired: false });
  });
  const terminal = terminalClient(mock.path, mock.directory, { cols: 100, rows: 12 });
  try {
    await terminal.visible('child-00');
    const selected = (row: number) => terminal.cell(row, 0)?.getBgColor() === 4;
    const selectedAgent = (id: string) => {
      const row = terminal.screen().split('\n').findIndex(line => line.includes(id));
      return row >= 0 && selected(row);
    };
    await waitFor(() => selectedAgent('root'));

    // Down remains the ordinary adjacent-row navigation key.
    terminal.keys('\x1b[B');
    await waitFor(() => selectedAgent('child-00'));
    // Right advances through the same sibling group; walk to its last (off-screen) row.
    for (let i = 1; i < 40; i++) {
      terminal.keys('\x1b[C');
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    await waitFor(() => selectedAgent('child-39'));
    expect(terminal.screen()).not.toContain('child-00');
    // Right wraps back to the first child and scrolls it into view.
    terminal.keys('\x1b[C');
    await waitFor(() => selectedAgent('child-00'));
    expect(terminal.screen()).toContain('child-00');

    // Left selects the parent; Up and Down continue to traverse adjacent rows.
    terminal.keys('\x1b[D');
    await waitFor(() => selectedAgent('root'));
    terminal.keys('\x1b[B');
    await waitFor(() => selectedAgent('child-00'));
    terminal.keys('\x1b[A');
    await waitFor(() => selectedAgent('root'));

    // Tab folds and unfolds the selected parent as before.
    terminal.keys('\t');
    await waitFor(() => !terminal.screen().includes('child-00'));
    terminal.keys('\t');
    await terminal.visible('child-00');
  } finally {
    try {
      await terminal.close();
    } finally {
      await mock.close();
    }
  }
}, 15_000);
