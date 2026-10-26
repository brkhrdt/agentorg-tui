import type { Agent } from './protocol.js';

export interface MentionChoice { token: string; name: string; depth: number }

/** Full redraws are only needed while a suggestion panel is or was visible. */
export function mentionRedrawRequired(wasOpen: boolean, isOpen: boolean): boolean { return wasOpen || isOpen; }

/** Parent and descendant mention paths, relative to the recipient. */
export function mentionChoices(agents: Iterable<Agent>, recipientId: string): MentionChoice[] {
  const byId = new Map([...agents].filter(agent => !agent.removedAt).map(agent => [agent.id, agent]));
  const recipient = byId.get(recipientId);
  if (!recipient) return [];
  const choices: MentionChoice[] = [];
  const parent = recipient.parentId ? byId.get(recipient.parentId) : undefined;
  if (parent && parent.id !== recipient.id) choices.push({ token: `@../${parent.name}`, name: parent.name, depth: 0 });
  const visit = (parentId: string, prefix: string, depth: number, seen: Set<string>) => {
    for (const child of byId.values()) {
      if (child.parentId !== parentId || seen.has(child.id)) continue;
      const token = prefix ? `${prefix}/${child.name}` : child.name;
      choices.push({ token: `@${token}`, name: child.name, depth });
      const next = new Set(seen); next.add(child.id);
      visit(child.id, token, depth + 1, next);
    }
  };
  visit(recipient.id, '', 0, new Set([recipient.id]));
  return choices;
}

/** Case-insensitive subsequence score: contiguous and earlier matches rank first.
 * Completion tokens end at whitespace; ranking intentionally stays lightweight and deterministic.
 */
export function fuzzyNameScore(name: string, query: string): number | undefined {
  const needle = query.toLocaleLowerCase();
  if (!needle) return 0;
  const haystack = name.toLocaleLowerCase();
  let at = -1, score = 0, first = -1, previous = -2;
  for (const char of needle) {
    at = haystack.indexOf(char, at + 1);
    if (at < 0) return;
    if (first < 0) first = at;
    score += at === previous + 1 ? 0 : 1;
    previous = at;
  }
  return score * 100 + first;
}

export function matchMentionChoices(choices: MentionChoice[], query: string): MentionChoice[] {
  return choices.map((choice, index) => ({ choice, index, score: fuzzyNameScore(choice.name, query) }))
    .filter((entry): entry is { choice: MentionChoice; index: number; score: number } => entry.score !== undefined)
    .sort((a, b) => a.score - b.score || a.index - b.index)
    .map(entry => entry.choice);
}

/** Find the @-word ending at the current draft cursor (composer currently edits at the end). */
export function mentionQuery(value: string): string | undefined {
  const match = value.match(/(?:^|\s)(@[\p{L}\p{N}_./-]*)$/u);
  return match?.[1];
}

/** Replace only the still-active @ word; reject cached queries after draft edits. */
export function replaceMentionQuery(value: string, query: string, token: string): string | undefined {
  if (!query || !value.endsWith(query) || mentionQuery(value) !== query) return;
  return value.slice(0, -query.length) + token;
}

/** Return a bounded menu viewport that always includes the active selection. */
export function mentionWindow<T>(items: T[], selected: number, size = 4): { items: T[]; start: number } {
  const count = Math.max(0, Math.min(size, items.length));
  const start = Math.max(0, Math.min(items.length - count, selected - Math.floor((count - 1) / 2)));
  return { items: items.slice(start, start + count), start };
}
