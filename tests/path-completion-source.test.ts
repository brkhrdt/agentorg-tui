import { expect, test } from 'bun:test';
import { HostPathCompletionSource, type PathCompletionSource } from '../src/path-completion-source.js';

test('host source uses only organization.paths with recipient cwd and kind any, never creation', async () => {
  const calls: unknown[][] = [];
  const session = { pathCompletion: true, completePath: async (...args: unknown[]) => {
    calls.push(args); return { path: './a', isDirectory: true, entries: [{ name: '.hidden file', path: '/server/.hidden file', kind: 'file' }] };
  } };
  const source = new HostPathCompletionSource(session as any);
  const context = { recipientId: 'agent-1', cwd: '/agent cwd', sourceId: source.id };
  await expect(source.complete(context, './a')).resolves.toEqual({ path: './a', isDirectory: true, entries: [{ name: '.hidden file', path: '/server/.hidden file', kind: 'file' }] });
  await source.complete(context, './/home');
  await source.complete(context, './~/Documents');
  await source.complete(context, './~');
  expect(calls).toEqual([['./a', '/agent cwd', 'any'], ['/home', '/agent cwd', 'any'], ['~/Documents', '/agent cwd', 'any'], ['~/', '/agent cwd', 'any']]);
  session.pathCompletion = false;
  await expect(source.complete(context, './a')).rejects.toThrow('not advertised');
});

test('completion source is replaceable without a plugin/container implementation', async () => {
  const fake: PathCompletionSource = { id: 'fixture', complete: async () => ({ path: './', isDirectory: true, entries: [{ name: 'fixture', path: '/fixture', kind: 'directory' }] }) };
  await expect(fake.complete({ recipientId: 'r', cwd: '/r', sourceId: fake.id }, './')).resolves.toEqual({ path: './', isDirectory: true, entries: [{ name: 'fixture', path: '/fixture', kind: 'directory' }] });
});
