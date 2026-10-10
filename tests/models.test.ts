import { expect, test } from 'bun:test';
import { AgentEditor, AGENT_FIELDS } from '../src/agent-editor.js';
import { Session } from '../src/session.js';
import { agent, mockServer, respond, waitFor } from './helpers.js';

test('agent catalog requests select provider first and forward draft launch configuration', async () => {
  const requests: any[] = [];
  const mock = await mockServer((socket, request) => {
    requests.push(request);
    if (request.method === 'organization.snapshot') respond(socket, request.id, { seq: 0, agents: [], operations: [], capabilities: { harnesses: ['fixture'], modelDiscovery: ['fixture'] } });
    else if (request.method === 'organization.providers') respond(socket, request.id, { providers: ['a', 'b'] });
    else if (request.method === 'organization.models') respond(socket, request.id, { models: [{ id: 'gpt-6-luna', name: 'Luna' }] });
  });
  const session = new Session(mock.path);
  const running = session.run();
  try {
    await waitFor(() => session.status === 'connected');
    expect(session.modelDiscovery).toEqual(['fixture']);
    const editor = new AgentEditor(null);
    editor.values.harness = 'fixture'; editor.values.cwd = '/tmp';
    editor.values.env = '{"CONFIG":"test"}'; editor.values.options = '{"executable":"custom-pi"}';
    await expect(session.agentChoices('model', editor.values)).rejects.toThrow('Select a provider');
    expect(requests.some(r => r.method === 'organization.models')).toBe(false);
    expect(await session.agentChoices('provider', editor.values)).toEqual([{ value: 'a', label: 'a' }, { value: 'b', label: 'b' }]);
    editor.select('provider', 'a');
    expect(await session.agentChoices('model', editor.values)).toEqual([{ value: 'gpt-6-luna', label: 'gpt-6-luna · Luna' }]);
    expect(requests.at(-1).params).toEqual({ harness: 'fixture', provider: 'a', cwd: '/tmp', env: { CONFIG: 'test' }, options: { executable: 'custom-pi' } });
  } finally { session.close(); await running; await mock.close(); }
});

test('changing provider or harness invalidates dependent choices; unchanged selections retain them', () => {
  expect(AGENT_FIELDS.indexOf('provider')).toBeLessThan(AGENT_FIELDS.indexOf('model'));
  const editor = new AgentEditor(null, agent('root', null, { settings: { harness: 'fixture', provider: 'a', model: 'gpt-6-luna' } }));
  editor.select('provider', 'a'); expect(editor.values.model).toBe('gpt-6-luna');
  editor.select('provider', 'b'); expect(editor.values.model).toBe('');
  expect(() => editor.params()).toThrow('model cannot be blank');
  editor.select('model', 'other'); expect(editor.params()).toMatchObject({ settings: { provider: 'b', model: 'other' } });
  editor.select('harness', 'other-harness');
  expect(editor.values.provider).toBe(''); expect(editor.values.model).toBe('');
});
