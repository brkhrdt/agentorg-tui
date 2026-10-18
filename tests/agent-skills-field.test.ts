import { expect, test } from 'bun:test';
import { AgentEditor } from '../src/agent-editor.js';
import { UI } from '../src/ui.js';
import { agent } from './helpers.js';

const catalog = [
  { name: 'alpha', description: 'Alpha instructions', gitUrl: 'https://github.com/org/alpha' },
  { name: 'beta', description: 'Beta instructions', gitUrl: 'https://github.com/org/beta' },
];
const capability = { namespace: 'managed', catalog };

async function openEditor(skillsEnabled: boolean, target?: ReturnType<typeof agent>) {
  const ui = Object.create(UI.prototype) as any;
  Object.assign(ui, {
    editorRequest: 0, view: 'tree', sending: false, closing: false,
    createParent: () => undefined,
    setView(view: string) { this.view = view; },
    session: {
      harnesses: ['fixture'], serverCwd: '/workspace', settingsFields: [], store: { agents: new Map() },
      podmanEnabled: false, podmanVolumesEnabled: false, podmanProfilesEnabled: false,
      podmanDefaultsEnabled: false, agentProfilesEnabled: false,
      skillsEnabled, skillCatalog: catalog, skillsNamespace: capability.namespace,
      listAgentProfiles: async () => [],
    },
  });
  await ui.openEditor(!!target, target);
  return ui.editor as AgentEditor;
}

const editorOptions = (AgentEditor as any);
const withSkills = (parentId: string | null, record?: ReturnType<typeof agent>) => new editorOptions(
  parentId, record, false, [], false, false, false, { skills: capability },
) as AgentEditor & { setSkillState(name: string, state: 'available' | 'installed'): void; removeSkill(name: string): void };

test('ordinary create form exposes Skills for the advertised catalog capability', async () => {
  expect((await openEditor(true)).fields).toContain('skills');
});

test('ordinary modify form exposes Skills for the advertised catalog capability', async () => {
  const modify = await openEditor(true, agent('worker', 'root', { settings: { harness: 'fixture', model: 'test', extensions: { managed: { alpha: 'available' } } } }));
  expect(modify.fields).toContain('skills');
});

test('unsupported optional capability hides the Skills field', async () => {
  expect((await openEditor(false)).fields).not.toContain('skills');
});

test('skill draft stages a complete map under the advertised namespace and preserves sibling namespaces', () => {
  const record = agent('worker', 'root', { revision: 12, settings: {
    harness: 'fixture', model: 'test',
    extensions: { managed: { alpha: 'installed', retained: 'available' }, sibling: { keep: true } },
  } });
  const draft = withSkills('root', record);
  draft.setSkillState('beta', 'available');
  draft.removeSkill('alpha');
  expect(draft.params()).toEqual({
    agentId: 'worker', expectedRevision: 12,
    settings: { extensions: { managed: { retained: 'available', beta: 'available' }, sibling: { keep: true } } },
  });
});

test('removing the last selection explicitly clears the map; unedited modify omits it and cancel stays local', () => {
  const record = agent('worker', 'root', { revision: 4, settings: {
    harness: 'fixture', model: 'test', extensions: { managed: { alpha: 'installed' }, sibling: { preserve: 1 } },
  } });
  const untouched = withSkills('root', record);
  expect(() => untouched.params()).toThrow('No changes');

  const cleared = withSkills('root', record);
  cleared.removeSkill('alpha');
  expect(cleared.params()).toEqual({
    agentId: 'worker', expectedRevision: 4,
    settings: { extensions: { managed: {}, sibling: { preserve: 1 } } },
  });

  const create = withSkills(null);
  create.values.harness = 'fixture'; create.values.model = 'test';
  create.setSkillState('alpha', 'installed');
  create.removeSkill('alpha');
  expect(create.params().settings).toMatchObject({ extensions: { managed: {} } });
});
