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
    await waitFor(() => selected(2));

    // Down remains the ordinary adjacent-row navigation key.
    terminal.keys('\x1b[B');
    await waitFor(() => selected(3));
    // Right advances through the same sibling group; walk to its last (off-screen) row.
    for (let i = 1; i < 40; i++) {
      terminal.keys('\x1b[C');
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    await waitFor(() => terminal.screen().includes('child-39'));
    expect(terminal.screen()).not.toContain('child-00');
    // Right wraps back to the first child and scrolls it into view.
    terminal.keys('\x1b[C');
    await waitFor(() => terminal.screen().includes('child-00'));
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(terminal.screen().split('\\n').findIndex(line => line.includes('child-00'))).toBeGreaterThanOrEqual(0);

    // Left selects the parent; Up remains adjacent-row navigation.
    terminal.keys('\x1b[D');
    await waitFor(() => selected(2));
    terminal.keys('\x1b[A');
    await waitFor(() => selected(2)); // Already at the top boundary; no wrap.

    // Tab folds and unfolds the selected parent as before.
    terminal.keys('\t');
    await waitFor(() => !terminal.screen().includes('child-00'));
    terminal.keys('\t');
    await terminal.visible('child-00');
  } finally {
    await terminal.close();
    await mock.close();
  }
}, 15_000);
