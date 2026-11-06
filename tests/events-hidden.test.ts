import { describe, expect, test } from 'vitest';
import { eventText } from '../src/render.js';
import { Settings } from '../src/settings.js';
import { Store } from '../src/store.js';
import { renderTable } from '../src/table.js';
import { agent, event } from './helpers.js';

const marker = 'QUIET_LATEST';
const message = (seq: number, agentId: string, text: string) => event(seq, 'agent.message', {
  sessionUpdate: 'agent_message_chunk', messageId: `message-${seq}`, content: { type: 'text', text },
}, { agentId, generation: 'g1' });
const toolResult = (seq: number, agentId: string, title: string) => event(seq, 'tool.result', { title, content: `${title} result` }, { agentId, generation: 'g1' });
const toolRendering = (subtype: string) => ({ rendererId: 'test', subtype, summary: `${subtype} result`, extended: `${subtype} result`, full: `${subtype} result` });
const customMessage = (seq: number, text: string, messageId = 'custom-stream') => event(seq, 'agent.message', {
  sessionUpdate: 'agent_message_chunk', messageId, content: { type: 'text', text },
}, { agentId: 'quiet', generation: 'g1' });

function setup() {
  const store = new Store();
  const settings = new Settings();
  settings.history = { recentEvents: 3, chatPageSize: 2, cacheBytes: 32_768, idleMinutes: 10 };
  store.configureHistory(settings.history);
  store.install({ seq: 0, agents: [agent('quiet'), agent('busy')], operations: [] });
  return { store, settings };
}

describe('observed tree previews across history eviction', () => {
  test('retained subtype presentation keeps a level-zero live preview hidden after raw eviction', () => {
    const { store, settings } = setup();
    settings.levels['tool.result:read'] = 0;
    store.ingest(toolResult(1, 'quiet', 'read'), 'live');
    store.present(1, toolRendering('read'));
    expect(store.latest(settings).has('quiet')).toBe(false);

    for (let seq = 2; seq <= 5; seq++) store.ingest(message(seq, 'busy', `BUSY_${seq}`), 'live');
    expect(store.events.has(1)).toBe(false);
    expect(store.latest(settings).has('quiet')).toBe(false);
  });

  test('long live subtype identity stays hidden before and after raw-history eviction', () => {
    const { store, settings } = setup();
    const subtype = 'r'.repeat(83);
    settings.levels[`tool.result:${subtype}`] = 0;
    store.ingest(toolResult(1, 'quiet', subtype), 'live');
    store.present(1, toolRendering(subtype));
    expect(store.latest(settings).has('quiet')).toBe(false);

    for (let seq = 2; seq <= 5; seq++) store.ingest(message(seq, 'busy', `BUSY_${seq}`), 'live');
    expect(store.events.has(1)).toBe(false);
    expect(store.latest(settings).has('quiet')).toBe(false);
  });

  test('late same-subtype sidecars replace candidates without orphaning renderings and cleanup on lifecycle reset', () => {
    const { store, settings } = setup();
    settings.levels['tool.result'] = 3;
    for (let seq = 1; seq <= 100; seq++) {
      store.ingest(toolResult(seq, 'quiet', 'read'), 'live');
      store.present(seq, toolRendering('read'));
    }
    expect(store.events.size).toBeLessThanOrEqual(3);
    expect(store.treeRenderings().size).toBe(store.renderings.size);
    expect(store.treeRenderings().size).toBeLessThanOrEqual(3);

    store.ingest(event(101, 'agent.session_replaced', { sessionNumber: 2 }, { agentId: 'quiet', generation: 'g1' }), 'live');
    for (let seq = 102; seq <= 105; seq++) store.ingest(message(seq, 'busy', `BUSY_${seq}`), 'live');
    expect(store.latest(settings).has('quiet')).toBe(false);
    expect(store.treeRenderings().size).toBe(store.renderings.size);
  });

  test('late sidecars reconcile every retained message candidate without leaking hidden chunks', () => {
    const { store, settings } = setup();
    settings.levels['agent.message'] = 3;
    settings.levels['agent.message:hidden-first'] = 0;
    settings.levels['agent.message:public-middle'] = 3;
    settings.levels['agent.message:hidden-tail'] = 0;
    store.ingest(customMessage(1, 'SECRET'), 'live');
    store.ingest(customMessage(2, 'PUBLIC'), 'live');
    store.ingest(customMessage(3, 'TAIL'), 'live');
    for (let seq = 4; seq <= 7; seq++) store.ingest(message(seq, 'busy', `BUSY_${seq}`), 'live');
    expect(store.events.has(2)).toBe(false);
    const presentation = (subtype: string) => ({ rendererId: 'plugin/custom', subtype, summary: subtype, extended: subtype, full: subtype });
    store.present(1, presentation('hidden-first'));
    store.present(2, presentation('public-middle'));
    store.present(3, presentation('hidden-tail'));

    const afterEviction = store.latest(settings).get('quiet');
    expect(afterEviction?.seq).toBe(2);
    expect(eventText(afterEviction!).includes('PUBLIC')).toBe(true);
    expect(eventText(afterEviction!).includes('SECRET')).toBe(false);
    expect(eventText(afterEviction!).includes('TAIL')).toBe(false);
  });

  test('late custom streamed-message sidecars retain visible candidate beside hidden subtype after eviction', () => {
    const { store, settings } = setup();
    settings.levels['agent.message:write'] = 3;
    settings.levels['agent.message:read'] = 0;
    store.ingest(customMessage(1, 'visible write'), 'live');
    store.ingest(customMessage(2, 'hidden read'), 'live');
    store.present(1, { rendererId: 'plugin/custom', subtype: 'write', summary: 'write', extended: 'write', full: 'write' });
    store.present(2, { rendererId: 'plugin/custom', subtype: 'read', summary: 'read', extended: 'read', full: 'read' });
    for (let seq = 3; seq <= 6; seq++) store.ingest(message(seq, 'busy', `BUSY_${seq}`), 'live');

    expect(store.events.has(1)).toBe(false);
    const latest = store.latest(settings).get('quiet');
    expect(latest?.seq).toBe(1);
    expect(store.treeRenderings().get(latest!.seq)?.subtype).toBe('write');
  });

  test('subtype-less presentation clears a previous hidden-level identity before and after eviction', () => {
    const { store, settings } = setup();
    settings.levels['tool.result'] = 0;
    settings.levels['tool.result:write'] = 1;
    store.ingest(toolResult(1, 'quiet', 'write'), 'live');
    store.present(1, toolRendering('write'));
    expect(store.latest(settings).get('quiet')?.seq).toBe(1);

    store.present(1, { rendererId: 'test', summary: 'plain', extended: 'plain', full: 'plain' });
    expect(store.latest(settings).has('quiet')).toBe(false);
    for (let seq = 2; seq <= 5; seq++) store.ingest(message(seq, 'busy', `BUSY_${seq}`), 'live');
    expect(store.events.has(1)).toBe(false);
    expect(store.latest(settings).has('quiet')).toBe(false);
  });

  test('live subtype candidates stay independent when late sidecars distinguish visible write from hidden read', () => {
    const { store, settings } = setup();
    settings.levels['tool.result'] = 3;
    settings.levels['tool.result:read'] = 0;
    store.ingest(toolResult(1, 'quiet', 'write'), 'live');
    store.ingest(toolResult(2, 'quiet', 'read'), 'live');
    store.present(1, toolRendering('write'));
    store.present(2, toolRendering('read'));

    const latest = store.latest(settings).get('quiet');
    expect(latest?.seq).toBe(1);
    expect(store.treeRenderings().get(latest!.seq)?.subtype).toBe('write');
  });

  test('historical subtype indexes preserve visible write after hidden read sidecars arrive late', () => {
    const { store, settings } = setup();
    settings.levels['tool.result'] = 3;
    settings.levels['tool.result:read'] = 0;
    store.ingest(toolResult(1, 'quiet', 'write'), 'history');
    store.ingest(toolResult(2, 'quiet', 'read'), 'history');
    store.present(1, toolRendering('write'));
    store.present(2, toolRendering('read'));

    const latest = store.latest(settings).get('quiet');
    expect(latest?.seq).toBe(1);
    expect(store.renderings.get(latest!.seq)?.subtype).toBe('write');
  });

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
    settings.levels['agent.message'] = settings.level('agent.message') === 0 ? 3 : 0;
    expect(store.latest(settings).has('quiet')).toBe(false);
    settings.levels['agent.message'] = settings.level('agent.message') === 0 ? 3 : 0;
    expect(eventText(store.latest(settings).get('quiet')!)).toContain(marker);
  });

  test('chat-history pages cannot regress a live preview after its raw event is evicted', () => {
    const { store, settings } = setup();
    store.ingest(message(20, 'quiet', 'CURRENT_LIVE'), 'live');
    for (let seq = 21; seq <= 24; seq++) store.ingest(message(seq, 'busy', `BUSY_${seq}`), 'live');
    expect(store.events.has(20)).toBe(false);
    expect(eventText(store.latest(settings).get('quiet')!)).toContain('CURRENT_LIVE');

    store.ingest(message(19, 'quiet', 'OLDER_SAME_GENERATION'), 'chat-history');
    store.ingest(event(18, 'agent.message', {
      sessionUpdate: 'agent_message_chunk', messageId: 'old-generation', content: { type: 'text', text: 'OLDER_GENERATION' },
    }, { agentId: 'quiet', generation: 'g0' }), 'chat-history');

    const latest = store.latest(settings).get('quiet');
    expect(latest?.seq).toBe(20);
    expect(eventText(latest!)).toContain('CURRENT_LIVE');
    expect(eventText(latest!)).not.toContain('OLDER');
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

  test('a late hidden chunk sidecar reconciles fallback lineage after raw eviction and hidden traffic', () => {
    const store = new Store();
    const settings = new Settings();
    settings.history = { recentEvents: 3, chatPageSize: 2, cacheBytes: 32_768, idleMinutes: 10 };
    settings.levels['agent.message'] = 3;
    settings.levels['agent.message:secret'] = 0;
    settings.levels['operation.changed'] = 0;
    store.configureHistory(settings.history);
    store.install({ seq: 0, agents: [agent('quiet')], operations: [] });
    store.ingest(customMessage(1, 'SECRET'), 'live');
    store.ingest(customMessage(2, 'PUBLIC'), 'live');
    for (let seq = 3; seq <= 40; seq++) {
      store.ingest(event(seq, 'operation.changed', { id: `op-${seq}`, agentId: 'quiet', type: 'agent.prompt', status: 'running' }, { agentId: 'quiet' }), 'live');
    }
    expect(store.events.has(1)).toBe(false);
    expect(store.events.has(2)).toBe(false);
    store.present(1, { rendererId: 'plugin/custom', subtype: 'secret', summary: 'secret', extended: 'secret', full: 'secret' });

    const latest = store.latest(settings).get('quiet');
    expect(latest?.seq).toBe(2);
    expect(eventText(latest!).includes('PUBLIC')).toBe(true);
    expect(eventText(latest!).includes('SECRET')).toBe(false);
  });

  test('late hidden sidecars for any prefix contributor cannot leak text after raw eviction', () => {
    const { store, settings } = setup();
    settings.levels['agent.message'] = 3;
    settings.levels['agent.message:secret'] = 0;
    store.ingest(customMessage(1, 'START'), 'live');
    store.ingest(customMessage(2, 'SECRET'), 'live');
    for (let seq = 3; seq <= 100; seq++) store.ingest(customMessage(seq, '.'), 'live');
    expect(store.events.has(2)).toBe(false);
    store.present(2, { rendererId: 'plugin/custom', subtype: 'secret', summary: 'secret', extended: 'secret', full: 'secret' });

    const latest = store.latest(settings).get('quiet');
    expect(latest).toBeDefined();
    expect(eventText(latest!).includes('SECRET')).toBe(false);
    expect(eventText(latest!).includes('START')).toBe(false);
  });

  test('lineage-only sidecar metadata is released on session, generation and removal cleanup', () => {
    for (const lifecycle of ['replacement', 'session', 'generation', 'removal'] as const) {
      const { store } = setup();
      store.ingest(customMessage(1, 'SECRET'), 'live');
      store.ingest(customMessage(2, 'PUBLIC'), 'live');
      for (let seq = 3; seq <= 40; seq++) store.ingest(event(seq, 'operation.changed', {
        id: `op-${seq}`, agentId: 'quiet', type: 'agent.prompt', status: 'running',
      }, { agentId: 'quiet' }), 'live');
      store.present(1, { rendererId: 'plugin/custom', subtype: 'secret', summary: 'secret', extended: 'secret', full: 'secret' });
      const internal = store as unknown as { previewRenderings: Map<number, unknown>; previewSubtypeIds: Map<number, string> };
      expect(internal.previewRenderings.has(1)).toBe(true);
      expect(internal.previewSubtypeIds.has(1)).toBe(true);

      if (lifecycle === 'replacement') store.ingest(customMessage(41, 'NEW'), 'live');
      else if (lifecycle === 'session') store.ingest(event(41, 'agent.session_replaced', {}, { agentId: 'quiet', generation: 'g1' }), 'live');
      else if (lifecycle === 'generation') store.install({ seq: 40, agents: [agent('quiet', null, { generation: 'g2' })], operations: [] });
      else store.ingest(event(41, 'agent.removed', { removedAt: 'now' }, { agentId: 'quiet', generation: 'g1' }), 'live');

      expect(internal.previewRenderings.has(1)).toBe(false);
      expect(internal.previewSubtypeIds.has(1)).toBe(false);
    }
  });

  test('evicted sources with long colliding message IDs stay separate after history backfill', () => {
    const { store, settings } = setup();
    const sharedPrefix = 'id'.repeat(50);
    store.ingest(customMessage(1, 'OLD', `${sharedPrefix}-old`), 'live');
    store.ingest(customMessage(3, 'NEW', `${sharedPrefix}-new`), 'live');
    store.ingest(customMessage(4, 'TAIL', `${sharedPrefix}-new`), 'live');
    for (let seq = 5; seq <= 8; seq++) store.ingest(message(seq, 'busy', `BUSY_${seq}`), 'live');
    expect(store.events.has(1)).toBe(false);
    expect(store.events.has(3)).toBe(false);

    const latestBefore = store.latest(settings).get('quiet');
    expect(latestBefore?.seq).toBe(4);
    expect(eventText(latestBefore!).includes('NEWTAIL')).toBe(true);
    expect(eventText(latestBefore!).includes('OLD')).toBe(false);
    store.ingest(event(0, 'agent.prompt.started', { prompt: 'unrelated old history' }, { agentId: 'quiet', generation: 'g1' }), 'history');

    const latestAfter = store.latest(settings).get('quiet');
    expect(latestAfter?.seq).toBe(4);
    expect(eventText(latestAfter!).includes('NEWTAIL')).toBe(true);
    expect(eventText(latestAfter!).includes('OLD')).toBe(false);
  });

  test('identical long message IDs merge across compacted and raw sources after backfill', () => {
    const { store, settings } = setup();
    const messageId = `${'shared-id-'.repeat(10)}tail`;
    store.ingest(customMessage(1, 'START', messageId), 'live');
    store.ingest(customMessage(3, 'TAIL', messageId), 'live');
    store.ingest(message(4, 'busy', 'BUSY_4'), 'live');
    store.ingest(message(5, 'busy', 'BUSY_5'), 'live');
    expect(store.events.has(1)).toBe(false);
    expect(store.events.has(3)).toBe(true);
    expect(eventText(store.latest(settings).get('quiet')!).includes('STARTTAIL')).toBe(true);

    store.ingest(event(0, 'agent.prompt.started', { prompt: 'older unrelated prompt' }, { agentId: 'quiet', generation: 'g1' }), 'history');
    const latest = store.latest(settings).get('quiet');
    expect(latest?.seq).toBe(3);
    expect(eventText(latest!).includes('STARTTAIL')).toBe(true);
  });

  test('hiding the last chunk does not truncate a retained earlier prefix after raw eviction', () => {
    const { store, settings } = setup();
    settings.levels['agent.message'] = 3;
    settings.levels['agent.message:hidden-tail'] = 0;
    for (let seq = 1; seq <= 100; seq++) store.ingest(customMessage(seq, seq === 1 ? 'START' : `chunk-${seq}`), 'live');
    store.present(100, { rendererId: 'plugin/custom', subtype: 'hidden-tail', summary: 'tail', extended: 'tail', full: 'tail' });

    const latest = store.latest(settings).get('quiet');
    expect(store.events.has(1)).toBe(false);
    expect(latest?.seq).toBe(99);
    expect(eventText(latest!).includes('START')).toBe(true);
  });

  test('historical prompt boundaries repair earlier candidates before a later chunk is hidden', () => {
    const { store, settings } = setup();
    settings.levels['agent.message'] = 3;
    settings.levels['agent.message:hidden-tail'] = 0;
    store.ingest(customMessage(1, 'OLD'), 'live');
    store.ingest(customMessage(3, 'NEW'), 'live');
    store.ingest(customMessage(5, 'TAIL'), 'live');
    store.ingest(event(2, 'agent.prompt.started', { prompt: 'new turn' }, { agentId: 'quiet', generation: 'g1' }), 'history');
    store.present(5, { rendererId: 'plugin/custom', subtype: 'hidden-tail', summary: 'tail', extended: 'tail', full: 'tail' });

    let latest = store.latest(settings).get('quiet');
    expect(latest?.seq).toBe(3);
    expect(eventText(latest!).includes('NEW')).toBe(true);
    expect(eventText(latest!).includes('OLD')).toBe(false);
    for (let seq = 6; seq <= 9; seq++) store.ingest(message(seq, 'busy', `BUSY_${seq}`), 'live');
    expect(store.events.has(3)).toBe(false);
    latest = store.latest(settings).get('quiet');
    expect(latest?.seq).toBe(3);
    expect(eventText(latest!).includes('NEW')).toBe(true);
    expect(eventText(latest!).includes('OLD')).toBe(false);
  });

  test('hidden live traffic can update state without displacing a tracked preview', () => {
    const store = new Store();
    const settings = new Settings();
    settings.history = { recentEvents: 3, chatPageSize: 2, cacheBytes: 32_768, idleMinutes: 10 };
    store.configureHistory(settings.history);
    store.install({ seq: 0, agents: [agent('quiet')], operations: [] });
    store.ingest(message(1, 'quiet', marker), 'live');
    for (let seq = 2; seq <= 40; seq++) {
      store.ingest(event(seq, 'operation.changed', { id: `op-${seq}`, agentId: 'quiet', type: 'agent.prompt', status: 'running' }, { agentId: 'quiet' }), 'live');
    }
    expect(store.operations.has('op-40')).toBe(true);
    expect(store.events.has(1)).toBe(false);
    const latest = store.latest(settings).get('quiet');
    expect(latest ? eventText(latest) : '').toContain(marker);
  });
});
