import { expect, test } from 'bun:test';
import type blessed from 'blessed';
import { enablePathKeys } from '../src/path-input.js';
import { Session } from '../src/session.js';
import { mockServer, respond, waitFor } from './helpers.js';

test('server-backed completion uses captured base and requests five directory candidates', async () => {
  const requests: any[] = [];
  const result = { path: '/server/project', isDirectory: true, entries: [{ name: 'src', path: '/server/project/src', kind: 'directory' as const }] };
  const mock = await mockServer((socket, request) => {
    requests.push(request);
    if (request.method === 'organization.snapshot') respond(socket, request.id, { seq: 0, agents: [], operations: [], capabilities: { cwd: '/server/project', pathCompletion: true } });
    else if (request.method === 'organization.paths') respond(socket, request.id, result);
  });
  const session = new Session(mock.path);
  await expect(session.completePath('./', '/server/project')).rejects.toThrow('not connected');
  const running = session.run();
  try {
    await waitFor(() => session.status === 'connected');
    expect(session.serverCwd).toBe('/server/project');
    expect(session.pathCompletion).toBe(true);
    expect(await session.completePath('./sr', '/parent')).toEqual(result);
    expect(requests.at(-1).params).toEqual({ input: './sr', base: '/parent', kind: 'directory', limit: 5 });
    await session.completePath('./', '/parent', 'any');
    expect(requests.at(-1).params.kind).toBe('any');
  } finally { session.close(); await running; await mock.close(); }
});

test('path keys consume arrows and Tab, Space accepts current path, normal composer remains unchanged', () => {
  let active = true, value = '/cwd/', changed = 0, completions = 0, submitted = '';
  const moves: number[] = [];
  const input = {
    getValue: () => value,
    _listener(ch: string | undefined, key: blessed.Widgets.Events.IKeyEventArg) {
      if (key.name === 'enter') submitted = value;
      else if (key.name === 'backspace') value = value.slice(0, -1);
      else if (ch) value += ch;
    },
  };
  enablePathKeys(input as unknown as blessed.Widgets.TextboxElement, {
    active: () => active, move: delta => moves.push(delta), complete: () => completions++, changed: () => changed++,
  });
  const key = (ch: string | undefined, name: string) => input._listener(ch, { name } as blessed.Widgets.Events.IKeyEventArg);
  key('s', 's'); expect(value).toBe('/cwd/s'); expect(changed).toBe(1);
  key(undefined, 'down'); key(undefined, 'up'); expect(moves).toEqual([1, -1]);
  key('\t', 'tab'); expect(completions).toBe(1); expect(value).not.toContain('\t');
  key(' ', 'space'); expect(submitted).toBe('/cwd/s'); expect(value).toBe('/cwd/s');
  key(undefined, 'backspace'); expect(changed).toBe(2);
  active = false;
  key(' ', 'space'); expect(value).toBe('/cwd/ ');
  key('\t', 'tab'); expect(value).toBe('/cwd/ \t'); expect(completions).toBe(1);
});
