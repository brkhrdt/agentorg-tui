import { expect, test } from 'vitest';
import blessed from 'blessed';
import { PassThrough } from 'node:stream';
import { chatGroupIdentity, chatGroups } from '../src/render.js';
import { layoutChatParts, resolveChatAnchor, visibleChatOrigin } from '../src/chat-viewport.js';
import { Settings } from '../src/settings.js';
import { event } from './helpers.js';

const tool = (seq: number, type: string) => event(seq, type, { toolCallId: 'call-1' }, { agentId: 'root', generation: 'g1' });

test('tool phase anchors are distinct unless compact chat truly coalesces them', () => {
  const call = tool(1, 'tool.call'), update = tool(2, 'tool.update'), result = tool(3, 'tool.result');
  const settings = new Settings();
  const separate = chatGroups([call, update, result], settings);
  expect(separate.map(chatGroupIdentity)).toHaveLength(3);
  expect(new Set(separate.map(chatGroupIdentity)).size).toBe(3);

  settings.compactToolCalls = true;
  const compact = chatGroups([call, update, result], settings);
  expect(compact).toHaveLength(1);
  expect(chatGroupIdentity(compact[0]!)).toContain('call-1');

  settings.levels['tool.update'] = 4;
  const rawBoundary = chatGroups([call, update, result], settings);
  expect(rawBoundary.map(chatGroupIdentity)).toHaveLength(3);
  expect(new Set(rawBoundary.map(chatGroupIdentity)).size).toBe(3);

  settings.levels['tool.update'] = 1;
  const reused = chatGroups([call, result, tool(4, 'tool.call'), tool(5, 'tool.update')], settings);
  expect(reused).toHaveLength(2);
  expect(chatGroupIdentity(reused[0]!)).not.toBe(chatGroupIdentity(reused[1]!));
});

test('visible origin excludes Blessed alwaysScroll childOffset', () => {
  expect(visibleChatOrigin({ childBase: 24, childOffset: 23, getScroll: () => 47 })).toBe(24);
  expect(visibleChatOrigin({ childBase: 0, childOffset: 0, getScroll: () => 0 })).toBe(0);
});

test('chat row starts and anchor restoration follow Blessed layout at narrow widths through insertions and removals', () => {
  const screen = blessed.screen({
    input: new PassThrough(), output: new PassThrough(),
    terminal: 'xterm-256color', smartCSR: false,
  });
  const widget = blessed.box({ parent: screen, width: 37, height: 20, scrollable: true, alwaysScroll: true, tags: false,
    scrollbar: { ch: '│', style: { bg: 'gray' } } });
  const anchorEvent = event(10, 'agent.message', { content: { text: `anchor ${'wrapped '.repeat(24)}` } }, { agentId: 'root' });
  const laterEvent = event(11, 'agent.message', { content: { text: 'later' } }, { agentId: 'root' });
  const anchorPart = { text: `anchor ${'wrapped '.repeat(24)}`, event: anchorEvent, identity: 'anchor' };
  const anchor = { identity: 'anchor', seq: 10, rowOffset: 1 };
  const compareWithBlessed = (parts: Array<{ text: string; event?: ReturnType<typeof event>; identity?: string }>) => {
    widget.setContent(parts.map(part => part.text).join('\n\n'));
    const ftor = (widget as any)._clines.ftor as number[][];
    const layout = layoutChatParts(parts, ftor);
    let fakeLine = 0;
    for (let index = 0; index < parts.length; index++) {
      if (index) fakeLine++;
      const part = parts[index]!;
      if (part.event) expect(layout.find(item => item.identity === part.identity)?.startRow).toBe(ftor[fakeLine]?.[0]);
      fakeLine += part.text.split('\n').length;
    }
    return { ftor, layout };
  };
  try {
    const originalParts = [{ text: '[History gap: earlier events have expired.]' }, anchorPart,
      { text: 'later', event: laterEvent, identity: 'later' }];
    const original = compareWithBlessed(originalParts);
    const originalRow = original.ftor[2]?.[0]!;
    expect(resolveChatAnchor(anchor, original.layout)).toEqual({ row: originalRow + 1, lost: false });

    const insertedParts = [{ text: '[History gap: earlier events have expired.]' },
      { text: `[Coverage ${'notice '.repeat(30)}]` }, { text: 'older', event: event(8), identity: 'older' },
      anchorPart, { text: 'later', event: laterEvent, identity: 'later' }];
    const inserted = compareWithBlessed(insertedParts);
    const insertedFakeLine = insertedParts.slice(0, 3).reduce((lines, part) => lines + part.text.split('\n').length + 1, 0);
    expect(resolveChatAnchor(anchor, inserted.layout)).toEqual({ row: inserted.ftor[insertedFakeLine]?.[0]! + 1, lost: false });

    const removed = compareWithBlessed([anchorPart, { text: 'later', event: laterEvent, identity: 'later' }]);
    expect(resolveChatAnchor(anchor, removed.layout)).toEqual({ row: removed.ftor[0]?.[0]! + 1, lost: false });
    expect(resolveChatAnchor(anchor, removed.layout.filter(item => item.identity !== 'anchor'))).toMatchObject({ lost: true });
  } finally { screen.destroy(); }
});
