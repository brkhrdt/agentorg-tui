import { fuzzyNameScore } from './mention-completion.js';

export interface ComposeSpan { kind: 'path' | 'mention'; start: number; query: string }
export interface ComposeCandidate { name: string; path: string; kind: 'directory' | 'file'; token?: string }

/** Completion is deliberately end-of-draft only, matching Blessed's composer behavior. */
export function composeSpan(value: string, active?: ComposeSpan): ComposeSpan | undefined {
  const match = [...value.matchAll(/(?:^|\s)(\.\/)/gu)].at(-1);
  if (match && match.index !== undefined) {
    const start = match.index + match[0].length - match[1].length;
    if (active?.kind === 'path' && start > active.start) {
      const query = value.slice(start);
      if (query && !/[\r\n\u0000-\u001f]/u.test(query)) return { kind: 'path', start, query };
    }
  }
  if (active?.kind === 'path' && active.start <= value.length && value.slice(active.start).length >= 0) {
    const suffix = value.slice(active.start);
    // Keep a path span (including spaces) until its marker is removed or the
    // user explicitly dismisses it. '@' belongs to a path once it has begun.
    const marker = active.query.startsWith('../') ? '../' : active.query.startsWith('./') ? './' : '/';
    if (suffix.startsWith(marker) && !/[\r\n\u0000-\u001f]/u.test(suffix)) return { kind: 'path', start: active.start, query: suffix };
  }
  // An explicit path trigger owns the remainder of its span, including spaces
  // and `@`; it must take precedence over an @-word at the end of that path.
  if (match && match.index !== undefined) {
    const start = match.index + match[0].length - match[1].length;
    const query = value.slice(start);
    if (query && !/[\r\n\u0000-\u001f]/u.test(query)) return { kind: 'path', start, query };
  }
  const mention = value.match(/(?:^|\s)(@[\p{L}\p{N}_./-]*)$/u);
  if (mention) return { kind: 'mention', start: value.length - mention[1].length, query: mention[1] };
}

export function pathLookupInput(query: string): string {
  // organization.paths accepts a path spelling and performs component matching.
  return query;
}

export function matchComposeCandidates<T extends { name: string }>(items: T[], query: string): T[] {
  const component = query.slice(query.lastIndexOf('/') + 1);
  return items.map((item, index) => ({ item, index, score: fuzzyNameScore(item.name, component) }))
    .filter((x): x is { item: T; index: number; score: number } => x.score !== undefined)
    .sort((a, b) => a.score - b.score || a.index - b.index).map(x => x.item);
}

export function replaceComposeSpan(value: string, span: ComposeSpan, insertion: string): string | undefined {
  if (span.start < 0 || span.start > value.length || !value.slice(span.start).startsWith(span.query)) return;
  if (span.kind === 'path' && !value.slice(span.start).startsWith(span.query)) return;
  return value.slice(0, span.start) + insertion;
}

export function composeWindow<T>(items: T[], selected: number, size = 4): { items: T[]; start: number } {
  const count = Math.max(0, Math.min(size, items.length));
  const start = Math.max(0, Math.min(items.length - count, selected - Math.floor((count - 1) / 2)));
  return { items: items.slice(start, start + count), start };
}
