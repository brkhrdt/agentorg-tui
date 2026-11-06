import { expect, test } from 'vitest';
import { acceptCommand, commandSpan, commandsForSpan, matchCommands, validCommandList } from '../src/command-completion.js';
const commands = [{ name: 'skill:review', description: 'review', input: { hint: 'free text' } }, { name: 'web-search', description: '' }, { name: 'web', description: '' }];
test('command completion is prefix-only at draft start and preserves arbitrary arguments', () => {
  expect(commandSpan('/')).toEqual({ start: 0, query: '' });
  expect(commandSpan('/skill:re')).toEqual({ start: 0, query: 'skill:re' });
  expect(commandSpan('Please use /skill:re')).toEqual({ start: 11, query: 'skill:re' });
  for (const text of ['https://example.org', 'ordinary prose', '/web args', 'Please use /web args', '/web\nnext', './path']) expect(commandSpan(text)).toBeUndefined();
  expect(matchCommands(commands, 'web').map(x => x.name)).toEqual(['web', 'web-search']);
  expect(commandsForSpan(commands, { start: 0, query: '' }).map(x => x.name)).toEqual(commands.map(x => x.name));
  expect(commandsForSpan(commands, { start: 11, query: 'skill:' }).map(x => x.name)).toEqual(['skill:review']);
  expect(acceptCommand('Please use /skill:re', { start: 11, query: 'skill:re' }, commands[0]!, commands)).toBe('Please use /skill:review ');
  expect(acceptCommand('/skill:re', { start: 0, query: 'skill:re' }, commands[0]!, commands.slice(1))).toBeUndefined();
});
test('command lists fail closed on malformed or oversized payloads', () => {
  expect(validCommandList(commands)).toBe(true);
  expect(validCommandList([{ name: '/unsafe', description: '' }])).toBe(false);
  expect(validCommandList([{ name: 'x', description: '', input: { schema: {} } }])).toBe(false);
});
