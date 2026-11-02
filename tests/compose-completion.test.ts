import { describe, expect, test } from 'bun:test';
import { composeSpan, matchComposeCandidates, replaceComposeSpan } from '../src/compose-completion.js';

describe('compose completion spans', () => {
  test('only ./ activates paths at a boundary; path segments support parent and root traversal', () => {
    expect(composeSpan('look ./src')).toEqual({ kind: 'path', start: 5, query: './src' });
    expect(composeSpan('../a')).toBeUndefined();
    expect(composeSpan('/')).toBeUndefined();
    expect(composeSpan('/home/podman')).toBeUndefined();
    expect(composeSpan('./../a')).toEqual({ kind: 'path', start: 0, query: './../a' });
    expect(composeSpan('.//home')).toEqual({ kind: 'path', start: 0, query: './/home' });
    expect(composeSpan('https://host/a')).toBeUndefined();
    expect(composeSpan('text foo/bar')).toBeUndefined();
    expect(composeSpan('hi /')).toBeUndefined();
    expect(composeSpan('hi /h')).toBeUndefined();
    expect(composeSpan('@../parent')).toEqual({ kind: 'mention', start: 0, query: '@../parent' });
  });
  test('moves path completion to a later ./ trigger instead of extending the persisted span', () => {
    const initial = composeSpan('./notafile')!;
    expect(initial).toEqual({ kind: 'path', start: 0, query: './notafile' });

    const updated = './notafile ./';
    const fresh = composeSpan(updated);
    expect(fresh).toEqual({ kind: 'path', start: 11, query: './' });
    expect(composeSpan(updated, initial)).toEqual(fresh);
    expect(composeSpan('./notafile ./src', initial)).toEqual({ kind: 'path', start: 11, query: './src' });
    expect(composeSpan('./notafile ordinary text', initial)).toEqual({ kind: 'path', start: 0, query: './notafile ordinary text' });
    expect(composeSpan('./notafile x./src', initial)).toEqual({ kind: 'path', start: 0, query: './notafile x./src' });
    expect(composeSpan('embedded x./src')).toBeUndefined();
  });
  test('keeps spaces and Unicode in the active path and preserves prompt prefix on replacement', () => {
    const span = composeSpan('inspect ./space dir/你好')!;
    expect(span).toEqual({ kind: 'path', start: 8, query: './space dir/你好' });
    expect(replaceComposeSpan('inspect ./space dir/你好', span, './space dir/file name ')).toBe('inspect ./space dir/file name ');
    expect(composeSpan('inspect ./space dir/file', span)).toEqual({ kind: 'path', start: 8, query: './space dir/file' });
    expect(composeSpan('inspect .', span)).toBeUndefined();
  });
  test('fuzzy matching ranks contiguous case-insensitive candidates before ties', () => {
    expect(matchComposeCandidates([{ name: 'foo-bar' }, { name: 'fbar' }, { name: 'food' }], './fb').map(x => x.name)).toEqual(['fbar', 'foo-bar']);
  });
});
