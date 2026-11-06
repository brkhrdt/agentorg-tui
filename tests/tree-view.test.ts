import { expect, test } from 'bun:test';
import { revealTreeAncestors, visibleTreeRows, toggleCollapsedBranch, treeArrowTarget } from '../src/tree-view.js';
import { agent } from './helpers.js';
import { Store } from '../src/store.js';

const rows = [
  { agent: agent('root'), depth: 0 },
  { agent: agent('a', 'root'), depth: 1 },
  { agent: agent('a1', 'a'), depth: 2 },
  { agent: agent('a1x', 'a1'), depth: 3 },
  { agent: agent('b', 'root'), depth: 1 },
  { agent: agent('b1', 'b'), depth: 2 },
];
const ids = (value: typeof rows) => value.map(row => row.agent.id);

test('tree arrows select visible parents and wrap Right within the same sibling group', () => {
  expect(treeArrowTarget(rows, 'a1', 'left')).toBe('a');
  expect(treeArrowTarget(rows, 'a', 'left')).toBe('root');
  expect(treeArrowTarget(rows, 'root', 'left')).toBeUndefined();
  expect(treeArrowTarget(rows, 'a', 'right')).toBe('b');
  expect(treeArrowTarget(rows, 'b', 'right')).toBe('a'); // skips descendants in the parent-first projection
  expect(treeArrowTarget(rows, 'a1', 'right')).toBeUndefined(); // singleton under a
  expect(treeArrowTarget(rows, 'b1', 'right')).toBeUndefined(); // singleton under b
  const twoRoots = [...rows, { agent: agent('next-root'), depth: 0 }];
  expect(treeArrowTarget(twoRoots, 'root', 'right')).toBe('next-root');
  expect(treeArrowTarget(twoRoots, 'next-root', 'right')).toBe('root');
  expect(treeArrowTarget(twoRoots, 'b1', 'left')).toBe('b');
  const groups = [
    { agent: agent('r'), depth: 0 }, { agent: agent('a', 'r'), depth: 1 }, { agent: agent('a-child', 'a'), depth: 2 },
    { agent: agent('b', 'r'), depth: 1 }, { agent: agent('c', 'r'), depth: 1 }, { agent: agent('d', 'r'), depth: 1 },
    { agent: agent('e', 'a-child'), depth: 2 }, { agent: agent('f', 'a-child'), depth: 2 },
  ];
  expect(treeArrowTarget(groups, 'b', 'right')).toBe('c');
  expect(treeArrowTarget(groups, 'd', 'right')).toBe('a');
  expect(treeArrowTarget(groups, 'e', 'right')).toBe('f');
  expect(treeArrowTarget(groups, 'f', 'right')).toBe('e'); // never wraps to same-depth cousin b
  const orphan = [{ agent: agent('unrelated'), depth: 0 }, { agent: agent('orphan', 'missing'), depth: 0 }];
  expect(treeArrowTarget(orphan, 'orphan', 'left')).toBeUndefined();
  expect(treeArrowTarget(orphan, 'unrelated', 'right')).toBeUndefined();
  expect(treeArrowTarget([], 'root', 'left')).toBeUndefined();
  expect(treeArrowTarget([], 'root', 'right')).toBeUndefined();
  expect(treeArrowTarget(rows, undefined, 'right')).toBeUndefined();
  expect(treeArrowTarget(rows, 'gone', 'left')).toBeUndefined();
  expect(treeArrowTarget(rows, 'gone', 'right')).toBeUndefined();
});

test('Right follows Store.tree stable name/ID order for nested siblings and roots', () => {
  const store = new Store();
  store.install({ seq: 0, agents: [
    agent('z-root', null, { name: 'Z' }), agent('a-root', null, { name: 'A' }),
    agent('z', 'a-root', { name: 'z' }), agent('b', 'a-root', { name: 'b' }),
    agent('id-b', 'a-root', { name: 'same' }), agent('id-a', 'a-root', { name: 'same' }), agent('a', 'a-root', { name: 'a' }),
  ], operations: [] });
  const tree = store.tree();
  expect(ids(tree)).toEqual(['a-root', 'a', 'b', 'id-a', 'id-b', 'z', 'z-root']);
  expect(treeArrowTarget(tree, 'a', 'right')).toBe('b');
  expect(treeArrowTarget(tree, 'id-a', 'right')).toBe('id-b');
  expect(treeArrowTarget(tree, 'z', 'right')).toBe('a');
  expect(treeArrowTarget(tree, 'z-root', 'right')).toBe('a-root');
});

test('arrows respect folded projection and do not mutate folds or rows', () => {
  const collapsed = new Set(['a']);
  const visible = visibleTreeRows(rows, collapsed);
  const before = [...visible];
  expect(treeArrowTarget(visible, 'a', 'right')).toBe('b');
  expect(treeArrowTarget(visible, 'b', 'right')).toBe('a');
  expect(treeArrowTarget(visible, 'b', 'left')).toBe('root');
  expect(treeArrowTarget(visible, 'a1', 'left')).toBeUndefined();
  expect(treeArrowTarget(visible, 'a1', 'right')).toBeUndefined();
  expect(visible).toEqual(before);
  expect([...collapsed]).toEqual(['a']);
  const rootCollapsed = new Set(['root']);
  const onlyRoot = visibleTreeRows(rows, rootCollapsed);
  expect(ids(onlyRoot)).toEqual(['root']);
  expect(treeArrowTarget(onlyRoot, 'root', 'right')).toBeUndefined();
  expect([...rootCollapsed]).toEqual(['root']);
});

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

test('revealing a sibling or later root never clears folds from preceding branches', () => {
  const siblingFolds = new Set(['root', 'a', 'b']);
  expect(revealTreeAncestors(rows, siblingFolds, 'b')).toBe(true);
  expect([...siblingFolds]).toEqual(['a', 'b']);
  const roots = [{ agent: agent('first'), depth: 0 }, { agent: agent('first-child', 'first'), depth: 1 }, { agent: agent('later'), depth: 0 }];
  const rootFolds = new Set(['first', 'first-child', 'later']);
  expect(revealTreeAncestors(roots, rootFolds, 'later')).toBe(true);
  expect([...rootFolds]).toEqual(['first', 'first-child', 'later']);
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
