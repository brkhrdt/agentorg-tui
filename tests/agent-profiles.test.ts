import { expect, test } from 'bun:test';
import { AgentEditor } from '../src/agent-editor.js';
import { ServerSettingsEditor } from '../src/server-settings-editor.js';
import { Session } from '../src/session.js';
import { UI } from '../src/ui.js';
import type { AgentProfile, ServerSettingsGroup } from '../src/protocol.js';
import { agent, mockServer, respond, waitFor } from './helpers.js';

const profile = (): AgentProfile => ({ id: 'review', name: 'Reviewer', harness: 'pi', revision: 3,
  provider: 'provider', model: 'model', options: { executable: 'pi', thinking: 'high', tools: ['read'], appendSystemPrompt: 'Review carefully' } });
const editor = () => new AgentEditor(null, undefined, false, [], false, false, true);

test('Agent selector uses profiles and only provider/model/thinking are exposed as Pi creation overrides', () => {
  const draft = editor(), selected = profile();
  draft.selectAgentProfile(selected);
  expect(draft.label('harness')).toBe('Agent');
  expect(draft.display('harness')).toBe('pi — Reviewer');
  expect(draft.fields).toContain('thinking'); expect(draft.fields).not.toContain('options');
  expect(draft.fields).not.toContain('tools'); expect(draft.fields).not.toContain('appendSystemPrompt');
  expect(draft.values).toMatchObject({ harness: 'pi', provider: 'provider', model: 'model', thinking: 'high' });
  expect(draft.params().settings).toMatchObject({ harness: 'pi', options: {}, extensions: { pi: { profile: { id: 'review', revision: 3 }, snapshot: false } } });
  expect(draft.params().settings).not.toHaveProperty('model'); // Displayed inherited values are not one-off overrides.
  draft.select('model', 'one-off'); draft.stage('thinking', 'off');
  expect(draft.params().settings).toMatchObject({ model: 'one-off', options: { thinking: 'off' } });
  expect((draft.params().settings as any).options).not.toHaveProperty('tools');
  expect(selected.options.thinking).toBe('high'); // Drafts never mutate catalogs.
  expect(() => draft.stage('thinking', 'invalid')).toThrow('thinking');
  draft.stage('thinking', '');
  expect(draft.values.thinking).toBe('high'); expect((draft.params().settings as any).options).toEqual({});
  draft.selectAgentProfile({ ...profile(), id: 'fast', name: 'Fast', options: {} });
  expect(draft.values.thinking).toBe(''); expect(draft.params().settings).not.toHaveProperty('model');
  draft.selectAgentProfile({ id: 'default', name: 'Default', harness: 'other', options: {} });
  expect(draft.fields).not.toContain('thinking'); expect(draft.fields).toContain('options');
});

test('child drafts display inherited one-offs without pinning the live profile catalog', () => {
  const parent = agent('root', null, { settings: { harness: 'pi', provider: 'provider', model: 'one-off', options: { thinking: 'low', tools: [] },
    extensions: { pi: { profile: { id: 'deleted', name: 'Deleted' }, snapshot: true } } } });
  const draft = new AgentEditor('root', undefined, false, [], false, false, true);
  draft.inheritAgent(parent);
  expect(draft.display('harness')).toBe('pi — Deleted (inherited)');
  expect(draft.values.model).toBe('one-off'); expect(draft.values.thinking).toBe('low');
  expect(draft.params().settings).toMatchObject({ harness: 'pi', options: {} });
  expect((draft.params().settings as any).extensions).not.toHaveProperty('pi');
  draft.stage('thinking', 'max');
  expect((draft.params().settings as any).options).toEqual({ thinking: 'max' });
  expect((parent.settings.options as any).thinking).toBe('low');
});

test('profile selection preserves container and other extension settings; ordinary edits remain minimal', () => {
  const record = agent('child', 'root', { settings: { harness: 'pi', provider: 'old', model: 'old', options: { thinking: 'low', tools: [] },
    extensions: { pi: { profile: { id: 'old', name: 'Old' }, snapshot: true }, skills: { a: 'installed' }, podman: { image: 'pi:v1' } } } });
  const modify = new AgentEditor('root', record, false, [], false, false, true);
  modify.stage('thinking', 'off');
  expect(modify.params()).toMatchObject({ agentId: 'child', expectedRevision: record.revision, settings: { options: { thinking: 'off', tools: [] } } });
  expect(modify.params().settings).not.toHaveProperty('extensions');
  modify.selectAgentProfile(profile());
  expect((modify.params().settings as any).extensions).toMatchObject({ skills: { a: 'installed' }, podman: { image: 'pi:v1' }, pi: { profile: { id: 'review', revision: 3 } } });
});

test('sparse profile form distinguishes inherited tools/prompts from explicit empty overrides and reset restores absence', () => {
  const group: ServerSettingsGroup = { namespace: 'pi', title: 'Profile', version: 2, revision: 0,
    fields: [
      { key: 'name', label: 'Name', editor: 'text', effect: 'future-launch' },
      { key: 'thinking', label: 'Thinking', editor: 'select', choices: ['off', 'low', 'high'], optional: true, effect: 'future-launch' },
      { key: 'tools', label: 'Tools', editor: 'list', optional: true, effect: 'future-launch' },
      { key: 'appendSystemPrompt', label: 'Prompt', editor: 'text', optional: true, effect: 'future-launch' },
    ], defaults: { name: 'New profile' }, values: { name: 'Review' }, effective: { name: 'Review' }, overridden: [], restartRequired: [] };
  const draft = new ServerSettingsEditor(group);
  expect(draft.valuesObject()).toEqual({ name: 'Review' });
  expect(draft.state('tools')).toContain('inherited');
  draft.stage(group.fields[2]!, '[]'); draft.stage(group.fields[3]!, '');
  expect(draft.valuesObject()).toEqual({ name: 'Review', tools: [], appendSystemPrompt: '' });
  draft.stage(group.fields[1]!, 'off');
  expect(draft.valuesObject().thinking).toBe('off');
  draft.reset(group.fields[1]!); draft.reset(group.fields[2]!); draft.reset(group.fields[3]!);
  expect(draft.valuesObject()).toEqual({ name: 'Review' });
  expect(draft.params().patch).toEqual({});
});

test('session discovers agent profile endpoints independently of containers and never queries host model catalogs for containers', async () => {
  const methods: string[] = [];
  const mock = await mockServer((socket, request) => {
    methods.push(request.method);
    if (request.method === 'organization.snapshot') respond(socket, request.id, { seq: 0, agents: [], operations: [], capabilities: {
      harnesses: ['other', 'pi'], modelDiscovery: ['pi'], plugins: { pi: { endpoints: { profiles: 'pi.profiles' } }, podman: { endpoints: { modify: 'podman.modify', profiles: 'podman.profiles' } } },
    } });
    else if (request.method === 'events.history') respond(socket, request.id, { events: [], oldestSeq: 1, latestSeq: 0, expired: false });
    else if (request.method === 'pi.profiles') respond(socket, request.id, { profiles: [profile()] });
  });
  const session = new Session(mock.path), running = session.run();
  try {
    await waitFor(() => session.status === 'connected');
    expect(session.agentProfilesEnabled).toBe(true); expect(session.modelDiscovery).toEqual([]);
    expect(methods).not.toContain('pi.profiles');
    expect(await session.listAgentProfiles()).toEqual([{ id: 'default', name: 'Default', harness: 'other', options: {} }, profile()]);
    expect(methods).not.toContain('podman.profiles'); expect(methods).not.toContain('organization.models');
  } finally { session.close(); await running; await mock.close(); }
});

test('UI root draft loads Default; child draft inherits without fetching the changed catalog', async () => {
  let requests = 0;
  const parent = agent('root', null, { settings: { harness: 'pi', cwd: '/parent', provider: 'provider', model: 'one-off', options: { thinking: 'off' },
    extensions: { pi: { profile: { id: 'review', name: 'Reviewer' }, snapshot: true } } } });
  const open = async (target?: typeof parent) => {
    const ui = Object.create(UI.prototype) as any;
    Object.assign(ui, { editorRequest: 0, view: 'tree', createParent: () => target, setView: () => {}, session: {
      harnesses: ['pi'], serverCwd: '/server', settingsFields: [], agentProfilesEnabled: true,
      listAgentProfiles: async () => { requests++; return [{ ...profile(), id: 'default', name: 'Default' }]; },
    } });
    await ui.openEditor(false, target);
    return ui.editor as AgentEditor;
  };
  const root = await open();
  expect(root.display('harness')).toBe('pi — Default'); expect(requests).toBe(1);
  const child = await open(parent);
  expect(child.display('harness')).toContain('Reviewer (inherited)'); expect(child.values.thinking).toBe('off');
  expect(requests).toBe(1); expect((child.params().settings as any).extensions).not.toHaveProperty('pi');
});
