import type { TreeRow } from './store.js';

/** Resolve tree-only arrow navigation against the already-folded visible rows. */
export function treeArrowTarget(rows: readonly TreeRow[], selectedId: string | undefined, direction: 'left' | 'right'): string | undefined {
  const index = rows.findIndex(row => row.agent.id === selectedId);
  if (index < 0) return undefined;
  const selected = rows[index]!;
  if (direction === 'left') {
    const parentId = selected.agent.parentId;
    return parentId && rows.some(row => row.agent.id === parentId) ? parentId : undefined;
  }
  for (let i = index + 1; i < rows.length; i++) {
    if (rows[i]!.agent.parentId === selected.agent.parentId) return rows[i]!.agent.id;
  }
  return undefined;
}

/** Project parent-first tree rows by removing descendants of collapsed agents. */
export function visibleTreeRows(rows: readonly TreeRow[], collapsedIds: ReadonlySet<string>): TreeRow[] {
  const visible: TreeRow[] = [];
  let hiddenBelow = Infinity;
  for (const row of rows) {
    if (row.depth > hiddenBelow) continue;
    hiddenBelow = Infinity;
    visible.push(row);
    if (collapsedIds.has(row.agent.id)) hiddenBelow = row.depth;
  }
  return visible;
}

/** Expand only the ancestor chain of a target, preserving all other fold choices. */
export function revealTreeAncestors(rows: readonly TreeRow[], collapsedIds: Set<string>, agentId: string): boolean {
  const index = rows.findIndex(row => row.agent.id === agentId);
  if (index < 0) return false;
  const ancestors: string[] = [];
  const targetDepth = rows[index]!.depth;
  for (let i = 0; i < index; i++) {
    const row = rows[i]!;
    ancestors.length = row.depth;
    ancestors[row.depth] = row.agent.id;
  }
  ancestors.length = targetDepth;
  for (const id of ancestors) if (id) collapsedIds.delete(id);
  return true;
}

/** Toggle a branch, clearing any nested collapse choices when expanding it. */
export function toggleCollapsedBranch(rows: readonly TreeRow[], collapsedIds: Set<string>, agentId: string): boolean {
  const index = rows.findIndex(row => row.agent.id === agentId);
  if (index < 0) return false;
  const row = rows[index]!;
  const hasChildren = rows[index + 1] !== undefined && rows[index + 1]!.depth > row.depth;
  if (!hasChildren) return false;
  if (collapsedIds.has(agentId)) {
    collapsedIds.delete(agentId);
    for (let i = index + 1; i < rows.length && rows[i]!.depth > row.depth; i++) collapsedIds.delete(rows[i]!.agent.id);
  } else collapsedIds.add(agentId);
  return true;
}
