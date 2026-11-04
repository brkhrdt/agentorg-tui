import { expect, test } from 'bun:test';
import { acceptCommand, commandSpan, matchCommands, validCommandList } from '../src/command-completion.js';
const commands = [{ name: 'skill:review', description: 'review', input: { hint: 'free text' } }, { name: 'web-search', description: '' }, { name: 'web', description: '' }];
test('command completion is prefix-only at draft start and preserves arbitrary arguments', () => {
  expect(commandSpan('/')).toEqual({ start: 0, query: '' });
  expect(commandSpan('/skill:re')).toEqual({ start: 0, query: 'skill:re' });
  for (const text of ['hello /we', 'https://example.org', '/web args', '/web\nnext', './path']) expect(commandSpan(text)).toBeUndefined();
  expect(matchCommands(commands, 'web').map(x => x.name)).toEqual(['web', 'web-search']);
  expect(acceptCommand('/skill:re', { start: 0, query: 'skill:re' }, commands[0]!, commands)).toBe('/skill:review ');
  expect(acceptCommand('/skill:re', { start: 0, query: 'skill:re' }, commands[0]!, commands.slice(1))).toBeUndefined();
});
test('command lists fail closed on malformed or oversized payloads', () => {
  expect(validCommandList(commands)).toBe(true);
  expect(validCommandList([{ name: '/unsafe', description: '' }])).toBe(false);
  expect(validCommandList([{ name: 'x', description: '', input: { schema: {} } }])).toBe(false);
});
