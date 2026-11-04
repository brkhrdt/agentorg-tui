import type { TreeRow } from './store.js';
import { clean } from './render.js';
import { fuzzyNameScore } from './mention-completion.js';

export interface AgentSearchChoice { agentId: string; path: string; ancestorIds: string[] }

/** Build ancestry from the store's normalized parent-first projection. */
export function agentSearchChoices(rows: readonly TreeRow[]): AgentSearchChoice[] {
  const stack: { id: string; name: string }[] = [];
  return rows.map(row => {
    while (stack.length > row.depth) stack.pop();
    const name = clean(row.agent.name);
    const choice = { agentId: row.agent.id, path: [...stack.map(item => item.name), name].join(' / '), ancestorIds: stack.map(item => item.id) };
    stack[row.depth] = { id: row.agent.id, name };
    return choice;
  });
}

export function matchAgentSearchChoices(choices: readonly AgentSearchChoice[], query: string): AgentSearchChoice[] {
  const terms = query.trim().split(/\s+/u).filter(Boolean);
  return choices.map((choice, index) => {
    const scores = terms.map(term => fuzzyNameScore(choice.path, term));
    return { choice, index, score: scores.some(score => score === undefined) ? undefined : scores.reduce<number>((sum, score) => sum + score!, 0) };
  }).filter((item): item is { choice: AgentSearchChoice; index: number; score: number } => item.score !== undefined)
    .sort((a, b) => a.score - b.score || a.index - b.index).map(item => item.choice);
}
