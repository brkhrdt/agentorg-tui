import { describe, expect, test } from 'bun:test';
import { eventText } from '../src/render.js';
import { Settings } from '../src/settings.js';
import { Store } from '../src/store.js';
import { renderTable } from '../src/table.js';
import { agent, event } from './helpers.js';

const marker = 'QUIET_LATEST';
const message = (seq: number, agentId: string, text: string) => event(seq, 'agent.message', {
  sessionUpdate: 'agent_message_chunk', messageId: `message-${seq}`, content: { type: 'text', text },
}, { agentId, generation: 'g1' });

function setup() {
  const store = new Store();
  const settings = new Settings();
  settings.history = { recentEvents: 3, chatPageSize: 2, cacheBytes: 32_768, idleMinutes: 10 };
  store.configureHistory(settings.history);
  store.install({ seq: 0, agents: [agent('quiet'), agent('busy')], operations: [] });
  return { store, settings };
}

describe('observed tree previews across history eviction', () => {
  test('retains the last observed live message for an active quiet agent under count pressure', () => {
    const { store, settings } = setup();
    store.ingest(message(1, 'quiet', marker), 'live');
    expect(eventText(store.latest(settings).get('quiet')!)).toContain(marker);
    expect(renderTable(store.tree(), store.latest(settings), ['name', 'event'], 120).items.join('\n')).toContain(marker);

    for (let seq = 2; seq <= 5; seq++) store.ingest(message(seq, 'busy', `BUSY_${seq}`), 'live');

    expect(store.events.has(1)).toBe(false);
    expect(store.events.size).toBeLessThanOrEqual(3);
    expect(store.cachedBytes).toBeLessThanOrEqual(settings.history.cacheBytes);
    const latest = store.latest(settings).get('quiet');
    expect(latest ? eventText(latest) : '').toContain(marker);
    expect(renderTable(store.tree(), store.latest(settings), ['name', 'event'], 120).items.join('\n')).toContain(marker);
  });

  test('filters can hide and restore bounded live candidates; older chat cannot regress them', () => {
    const { store, settings } = setup();
    store.ingest(message(5, 'quiet', marker), 'live');
    store.ingest(message(4, 'quiet', 'OLDER_HISTORY'), 'history');
    expect(eventText(store.latest(settings).get('quiet')!)).toContain(marker);
    settings.toggle('agent.message');
    expect(store.latest(settings).has('quiet')).toBe(false);
    settings.toggle('agent.message');
    expect(eventText(store.latest(settings).get('quiet')!)).toContain(marker);
  });

  test('session replacement and generation changes clear stale tree candidates', () => {
    const { store, settings } = setup();
    store.ingest(message(1, 'quiet', marker), 'live');
    store.ingest(event(2, 'agent.session_replaced', { sessionNumber: 2 }, { agentId: 'quiet', generation: 'g1' }), 'live');
    expect(store.latest(settings).has('quiet')).toBe(false);
    store.ingest(message(3, 'quiet', 'NEW_SESSION'), 'live');
    expect(eventText(store.latest(settings).get('quiet')!)).toContain('NEW_SESSION');
    store.ingest(event(4, 'agent.state', { state: 'running' }, { agentId: 'quiet', generation: 'g2' }), 'live');
    expect(store.latest(settings).has('quiet')).toBe(false);
  });

  test('removed agents and store resets release preview ownership', () => {
    const { store, settings } = setup();
    store.ingest(message(1, 'quiet', marker), 'live');
    store.ingest(event(2, 'agent.removed', { removedAt: 'now' }, { agentId: 'quiet' }), 'live');
    expect(store.latest(settings).has('quiet')).toBe(false);
    store.reset();
    expect(store.treePreviewBytes).toBe(0);
    expect(store.latest(settings)).toEqual(new Map());
  });

  test('large records and many event types keep preview memory independently bounded', () => {
    const { store, settings } = setup();
    store.configureHistory({ recentEvents: 3, chatPageSize: 2, cacheBytes: 1024, idleMinutes: 10 });
    const huge = message(1, 'quiet', 'x'.repeat(100_000));
    store.ingest(huge, 'live');
    for (let seq = 2; seq <= 40; seq++) store.ingest(event(seq, `plugin.type-${seq}`, { text: 'x'.repeat(100_000) }, { agentId: 'quiet' }), 'live');
    expect(store.events.size).toBeLessThanOrEqual(3);
    expect(store.cachedBytes).toBeLessThanOrEqual(1024);
    expect(store.treePreviewBytes).toBeLessThanOrEqual(32 * 2_500);
  });

  test('hidden live traffic can update state without displacing a tracked preview', () => {
    const store = new Store();
    const settings = new Settings();
    settings.history = { recentEvents: 3, chatPageSize: 2, cacheBytes: 32_768, idleMinutes: 10 };
    store.configureHistory(settings.history);
    store.install({ seq: 0, agents: [agent('quiet')], operations: [] });
    store.ingest(message(1, 'quiet', marker), 'live');
    for (let seq = 2; seq <= 5; seq++) {
      store.ingest(event(seq, 'operation.changed', { id: `op-${seq}`, agentId: 'quiet', type: 'agent.prompt', status: 'running' }, { agentId: 'quiet' }), 'live');
    }
    expect(store.operations.has('op-5')).toBe(true);
    expect(store.events.has(1)).toBe(false);
    const latest = store.latest(settings).get('quiet');
    expect(latest ? eventText(latest) : '').toContain(marker);
  });
});
