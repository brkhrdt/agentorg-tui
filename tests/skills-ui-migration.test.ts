import { expect, test } from 'bun:test';
import { agent, mockServer, respond, waitFor } from './helpers.js';
import { terminalClient } from './terminal.js';

const endpointNames = { list: 'organization.settings.list', get: 'organization.settings.get', update: 'organization.settings.update' };
const group = {
  namespace: 'skills', plugin: 'skills', title: 'Skills', version: 2, revision: 0,
  fields: [
    { key: 'directory', label: 'Skills store directory', editor: 'text', effect: 'restart', description: 'Server-side Git repository container.' },
    { key: 'gitTimeoutMs', label: 'Git timeout (ms)', editor: 'number', min: 1000, max: 60000, effect: 'immediate' },
    { key: 'maxCatalogEntries', label: 'Maximum catalog entries', editor: 'number', min: 1, max: 256, effect: 'immediate' },
  ],
  defaults: { directory: 'skills', gitTimeoutMs: 60000, maxCatalogEntries: 256 },
  values: { directory: 'skills', gitTimeoutMs: 60000, maxCatalogEntries: 256 },
  effective: { directory: 'skills', gitTimeoutMs: 60000, maxCatalogEntries: 256 }, overridden: [], restartRequired: [],
};

test('Skills settings show the restart-required store path and only Git registration controls', async () => {
  const requests: any[] = [];
  const mock = await mockServer((socket, request) => {
    requests.push(request);
    if (request.method === 'organization.snapshot') respond(socket, request.id, { seq: 0, agents: [agent('root', null, { name: 'worker' })], operations: [], capabilities: {
      plugins: { skills: { version: 1, settingsNamespace: 'skills', serverSettingsNamespace: 'skills',
        endpoints: { list: 'skills.list', registerRepository: 'skills.registerRepository' },
        repositoryRegistration: { version: 2, sourceKinds: ['https', 'server-path'], semantics: 'committed-head-v2' } } },
      serverSettings: { version: 1, groups: ['skills'], endpoints: endpointNames },
    } });
    else if (request.method === endpointNames.list) respond(socket, request.id, { groups: [group], facts: { cwd: '/work', dataDir: '/data', socketPath: '/org.sock', harnesses: ['fixture'], plugins: ['skills'] } });
    else if (request.method === endpointNames.get) respond(socket, request.id, group);
    else if (request.method === 'skills.list') respond(socket, request.id, { skills: [] });
    else if (request.method === 'events.subscribe') respond(socket, request.id, { subscribed: true, seq: 0 });
    else respond(socket, request.id, {});
  });
  const ui = terminalClient(mock.path, mock.directory);
  try {
    await ui.visible('worker');
    ui.keys('v'); await ui.visible('CLIENT ONLY'); ui.keys('s'); await ui.visible('Server settings');
    ui.keys('\r'); await ui.visible('Skills · server-wide');
    expect(ui.screen()).toContain('Skills store directory');
    expect(ui.screen()).toContain('· restart');
    expect(ui.screen()).not.toContain('Repositories:');
    expect(ui.screen()).not.toContain('retry legacy');
    expect(ui.screen()).toContain('Add Git skill repository…');
    ui.keys('a'); await ui.visible('Add skill repository · one source locator');
    expect(requests.some(request => request.method === 'skills.reconcile')).toBe(false);
  } finally { await ui.close(); await mock.close(); }
});
