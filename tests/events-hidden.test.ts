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
