import { expect, test } from 'bun:test';
import { AgentEditor } from '../src/agent-editor.js';
import { Session } from '../src/session.js';
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
    extensions: { managed: { alpha: 'installed', retained: 'available', legacy: 'available' }, sibling: { keep: true } },
  } });
  const draft = withSkills('root', record);
  draft.setSkillState('beta', 'available');
  draft.removeSkill('alpha');
  expect(draft.params()).toEqual({
    agentId: 'worker', expectedRevision: 12,
    settings: { extensions: { managed: { retained: 'available', legacy: 'available', beta: 'available' }, sibling: { keep: true } } },
  });
  expect(draft.skillChoices().find(skill => skill.name === 'legacy')).toMatchObject({ retainedUnknown: true, state: 'available' });
});

test('catalog discovery works without add endpoint and late responses cannot overwrite newer catalogs', async () => {
  const session = new Session('/unused');
  const waiting: Array<(value: { skills: any[] }) => void> = [];
  const client = { request: async () => new Promise(resolve => waiting.push(resolve)), close() {} } as any;
  (session as any).client = client;
  const snapshot = { seq: 0, agents: [], operations: [], capabilities: { plugins: { skills: { version: 1, settingsNamespace: 'managed', endpoints: { list: 'catalog.list' } } } } } as any;
  const older = (session as any).loadSkills(client, snapshot);
  const newer = (session as any).loadSkills(client, snapshot);
  waiting[1]!({ skills: [{ name: 'beta', description: 'Beta' }] });
  await newer;
  expect(session.skillsEnabled).toBe(true);
  waiting[0]!({ skills: [{ name: 'alpha', description: 'Alpha' }] });
  await older;
  expect(session.skillCatalog.map(skill => skill.name)).toEqual(['beta']);
  session.close();
});

test('raw sibling edits compose with structured skill changes but a raw skills edit conflicts', () => {
  const record = agent('worker', 'root', { revision: 8, settings: {
    harness: 'fixture', model: 'test', extensions: { managed: { alpha: 'available' }, sibling: { keep: true } },
  } });
  const draft = withSkills('root', record);
  draft.stage('extensions', JSON.stringify({ managed: { alpha: 'available' }, sibling: { keep: false } }));
  draft.setSkillState('beta', 'installed');
  expect(draft.params().settings).toEqual({ extensions: { managed: { alpha: 'available', beta: 'installed' }, sibling: { keep: false } } });

  const collision = withSkills('root', record);
  collision.stage('extensions', JSON.stringify({ managed: {}, sibling: { keep: true } }));
  collision.setSkillState('beta', 'available');
  expect(() => collision.params()).toThrow(/Edit Skills or extensions\.managed/);
});

test('skill names inherited from Object.prototype are treated as ordinary catalog IDs', () => {
  const entry = { name: 'constructor', description: 'Constructor skill', gitUrl: 'https://example.test/constructor' };
  const editor = new (AgentEditor as any)(null, undefined, false, [], false, false, false, { skills: { namespace: 'managed', catalog: [entry] } }) as AgentEditor & { skillChoices(): any[]; setSkillState(name: string, state: 'available' | 'installed'): void };
  editor.values.harness = 'fixture';
  expect(editor.skillChoices()[0]).toMatchObject({ name: 'constructor', state: 'unavailable' });
  editor.setSkillState('constructor', 'available');
  expect(editor.params().settings).toMatchObject({ extensions: { managed: { constructor: 'available' } } });
});

test('late discovery cannot overwrite newer skills metadata and malformed catalogs report localized notice', async () => {
  const session = new Session('/unused');
  const waiting: Array<(value: any) => void> = [];
  const client = { request: async () => new Promise(resolve => waiting.push(resolve)), close() {} } as any;
  (session as any).client = client;
  const snapshot = (namespace: string, endpoint: string) => ({ seq: 0, agents: [], operations: [], capabilities: { plugins: { skills: { version: 1, settingsNamespace: namespace, endpoints: { list: endpoint } } } } }) as any;
  const older = (session as any).loadSkills(client, snapshot('old.namespace', 'old.list'));
  const newer = (session as any).loadSkills(client, snapshot('new.namespace', 'new.list'));
  waiting[1]!({ skills: [{ name: 'beta', description: 'Beta' }] });
  await newer;
  waiting[0]!({ skills: [{ name: 'alpha', description: 'Alpha' }] });
  await older;
  expect(session.skillsNamespace).toBe('new.namespace');
  expect(session.skillCatalog.map(skill => skill.name)).toEqual(['beta']);
  expect(session.skillsEnabled).toBe(true);

  const notices: string[] = [];
  session.on('notice', message => notices.push(message));
  const malformed = (session as any).loadSkills(client, snapshot('new.namespace', 'new.list'));
  waiting[2]!(null);
  await malformed;
  expect(session.skillCatalog).toEqual([]);
  expect(notices.some(message => message.includes('Skills catalog response was invalid'))).toBe(true);
  session.close();
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
