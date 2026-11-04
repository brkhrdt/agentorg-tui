import { expect, test } from 'bun:test';
import { revealTreeAncestors, visibleTreeRows, toggleCollapsedBranch } from '../src/tree-view.js';
import { agent } from './helpers.js';

const rows = [
  { agent: agent('root'), depth: 0 },
  { agent: agent('a', 'root'), depth: 1 },
  { agent: agent('a1', 'a'), depth: 2 },
  { agent: agent('a1x', 'a1'), depth: 3 },
  { agent: agent('b', 'root'), depth: 1 },
  { agent: agent('b1', 'b'), depth: 2 },
];
const ids = (value: typeof rows) => value.map(row => row.agent.id);

test('projection hides all descendants, retains order/depth and unrelated branches', () => {
  expect(ids(visibleTreeRows(rows, new Set(['a', 'b1'])))).toEqual(['root', 'a', 'b', 'b1']);
  expect(visibleTreeRows(rows, new Set(['a']))[1]).toEqual(rows[1]);
});

test('expanding clears nested collapse choices without affecting unrelated branches', () => {
  const collapsed = new Set(['a', 'a1', 'b1']);
  expect(toggleCollapsedBranch(rows, collapsed, 'a')).toBe(true);
  expect([...collapsed]).toEqual(['b1']);
  expect(ids(visibleTreeRows(rows, collapsed))).toEqual(['root', 'a', 'a1', 'a1x', 'b', 'b1']);
});

test('reveal expands only target ancestors and preserves target and unrelated fold choices', () => {
  const collapsed = new Set(['root', 'a', 'a1', 'b']);
  expect(revealTreeAncestors(rows, collapsed, 'a1')).toBe(true);
  expect([...collapsed]).toEqual(['a1', 'b']);
  expect(ids(visibleTreeRows(rows, collapsed))).toEqual(['root', 'a', 'a1', 'b']);
  expect(revealTreeAncestors(rows, collapsed, 'missing')).toBe(false);
  expect(revealTreeAncestors([], collapsed, 'missing')).toBe(false);
});

test('a leaf before a sibling branch is not mistaken for a parent', () => {
  const siblingTree = [
    { agent: agent('root'), depth: 0 },
    { agent: agent('leaf', 'root'), depth: 1 },
    { agent: agent('branch', 'root'), depth: 1 },
    { agent: agent('child', 'branch'), depth: 2 },
  ];
  const collapsed = new Set<string>();
  expect(toggleCollapsedBranch(siblingTree, collapsed, 'leaf')).toBe(false);
  expect([...collapsed]).toEqual([]);
  expect(ids(visibleTreeRows(siblingTree, collapsed))).toEqual(['root', 'leaf', 'branch', 'child']);
});

test('leaves, empty and missing IDs are no-ops; live row changes project naturally', () => {
  const collapsed = new Set<string>();
  expect(toggleCollapsedBranch(rows, collapsed, 'a1x')).toBe(false);
  expect(toggleCollapsedBranch([], collapsed, 'root')).toBe(false);
  expect(toggleCollapsedBranch(rows, collapsed, 'gone')).toBe(false);
  expect(visibleTreeRows([], collapsed)).toEqual([]);
  collapsed.add('a');
  const changed = [...rows, { agent: agent('c', 'root'), depth: 1 }];
  expect(ids(visibleTreeRows(changed, collapsed))).toEqual(['root', 'a', 'b', 'b1', 'c']);
});
