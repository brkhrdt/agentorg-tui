import { expect, test } from 'bun:test';
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

test('chat layout counts wrapped notices and the single blank row in double-newline joins', () => {
  const a = event(1, 'agent.message', { content: { text: 'first' } }, { agentId: 'root' });
  const b = event(2, 'agent.message', { content: { text: 'second' } }, { agentId: 'root' });
  const layout = layoutChatParts([
    { text: '[History gap: earlier events have expired.]' },
    { text: 'first', event: a, identity: 'a' },
    { text: 'second', event: b, identity: 'b' },
  ], 10);
  expect(layout).toEqual([
    { identity: 'a', seq: 1, startRow: 7, rows: 1 },
    { identity: 'b', seq: 2, startRow: 9, rows: 1 },
  ]);
});

test('anchor rows remap across prepends/header changes and report eviction fallback', () => {
  const a = event(10, 'agent.message', { content: { text: 'anchor' } }, { agentId: 'root' });
  const b = event(11, 'agent.message', { content: { text: 'newer' } }, { agentId: 'root' });
  const anchor = { identity: 'anchor', seq: 10, rowOffset: 0 };
  const original = layoutChatParts([{ text: 'anchor', event: a, identity: 'anchor' }, { text: 'newer', event: b, identity: 'newer' }], 20);
  expect(resolveChatAnchor(anchor, original)).toEqual({ row: 0, lost: false });

  const prepended = event(8, 'agent.message', { content: { text: 'older' } }, { agentId: 'root' });
  const afterPrepend = layoutChatParts([
    { text: 'A history gap notice that wraps across this narrow pane' },
    { text: 'older', event: prepended, identity: 'older' },
    { text: 'anchor', event: a, identity: 'anchor' },
    { text: 'newer', event: b, identity: 'newer' },
  ], 10);
  const mapped = resolveChatAnchor(anchor, afterPrepend);
  expect(mapped.lost).toBe(false);
  expect(mapped.row).toBe(afterPrepend.find(item => item.identity === 'anchor')?.startRow ?? -1);
  const evicted = resolveChatAnchor(anchor, afterPrepend.filter(item => item.identity !== 'anchor'));
  expect(evicted.lost).toBe(true);
  expect(evicted.row).toBeGreaterThan(0);
});
