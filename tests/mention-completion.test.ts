import { describe, expect, test } from 'bun:test';
import { fuzzyNameScore, matchMentionChoices, mentionChoices, mentionQuery } from '../src/mention-completion.js';
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
});
