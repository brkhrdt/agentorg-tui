import type { TreeRow } from './store.js';

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
