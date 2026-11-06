import { describe, expect, test } from 'vitest';
import { fuzzyNameScore, matchMentionChoices, mentionChoices, mentionQuery, mentionRedrawRequired, mentionWindow, replaceMentionQuery } from '../src/mention-completion.js';
import type { Agent } from '../src/protocol.js';

const agent = (id: string, name: string, parentId: string | null, removedAt: string | null = null): Agent => ({ id, name, parentId, removedAt, state: 'idle', settings: { harness: 'test' }, revision: 1, generation: null });

describe('compose mentions', () => {
  test('offers direct parent and all descendants relative to recipient; excludes archived/current', () => {
    const agents = [agent('root', 'root', null), agent('parent', 'parent', 'root'), agent('current', 'current', 'parent'), agent('child', 'child', 'current'), agent('grand', 'grand', 'child'), agent('archived', 'gone', 'current', 'now')];
    expect(mentionChoices(agents, 'current').map(choice => choice.token)).toEqual(['@../parent', '@child', '@child/grand']);
  });
  test('fuzzy matches names and detects an unfinished @ word', () => {
    expect(fuzzyNameScore('AlphaBeta', 'ab')).toBeDefined();
    expect(fuzzyNameScore('AlphaBeta', 'zz')).toBeUndefined();
    expect(matchMentionChoices([{ token: '@child/grand', name: 'grand', depth: 1 }, { token: '@child', name: 'child', depth: 0 }], 'ch').map(choice => choice.token)).toEqual(['@child']);
    expect(mentionQuery('send @chi')).toBe('@chi');
    expect(mentionQuery('send @chi now')).toBeUndefined();
  });
  test('100 ordinary typing updates cause zero suggestion-panel redraws', () => {
    let value = '', open = false, redraws = 0;
    for (const char of 'a'.repeat(100)) {
      value += char;
      const wasOpen = open;
      const query = mentionQuery(value);
      open = Boolean(query); // Ordinary text has no active @ suffix.
      if (mentionRedrawRequired(wasOpen, open)) redraws++;
    }
    expect(redraws).toBe(0);
  });
  test('active suffix replacement rejects stale queries and the four-row viewport follows selection', () => {
    expect(replaceMentionQuery('hello @chi', '@chi', '@child')).toBe('hello @child');
    expect(replaceMentionQuery('hello @child', '@chi', '@child')).toBeUndefined();
    expect(replaceMentionQuery('hello @chi more', '@chi', '@child')).toBeUndefined();
    const choices = Array.from({ length: 9 }, (_, index) => index);
    const window = mentionWindow(choices, 8, 4);
    expect(window).toEqual({ items: [5, 6, 7, 8], start: 5 });
  });
});
