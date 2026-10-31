import { describe, expect, test } from 'bun:test';
import stripAnsi from 'strip-ansi';
import stringWidth from 'string-width';
import { chatGroups, clean, clip, eventText, renderEvent, renderTreeEvent } from '../src/render.js';
import { Settings } from '../src/settings.js';
import { Store } from '../src/store.js';
import { renderTable } from '../src/table.js';
import { agent, event, operation } from './helpers.js';

describe('state and transcripts', () => {
  test('queued prompt counts follow live operation transitions and resist stale snapshots', () => {
    const store = new Store();
    const first = { ...operation('queued'), id: 'first', agentId: 'root' };
    const second = { ...operation('queued'), id: 'second', agentId: 'root' };
    store.install({ seq: 0, agents: [agent('root')], operations: [first, second] });
    expect(store.queuedPromptCount('root')).toBe(2);
    store.putOperation({ ...first, status: 'running', cancelRequested: true });
    expect(store.queuedPromptCount('root')).toBe(1);
    store.install({ seq: 0, agents: [agent('root')], operations: [first, second] });
    expect(store.queuedPromptCount('root')).toBe(1);
    expect(store.operations.get('first')).toMatchObject({ status: 'running', cancelRequested: true });
    store.ingest(event(2, 'operation.changed', { ...second, status: 'completed' }));
    expect(store.queuedPromptCount('root')).toBe(0);
  });
  test('authoritative snapshots omit stale operations even after their event payloads are evicted', () => {
    const store = new Store();
    store.install({ seq: 0, agents: [agent('root')], operations: [] });
    store.configureHistory({ ...new Settings().history, recentEvents: 1, chatPageSize: 1 });
    const active = { ...operation('running'), id: 'active', agentId: 'root' };
    const queued = { ...operation('queued'), id: 'queued', agentId: 'root' };
    store.ingest(event(1, 'operation.changed', active));
    store.ingest(event(2, 'operation.changed', queued));
    store.ingest(event(3, 'plugin.custom', { marker: true }, { agentId: 'root' }));
    expect(store.events.has(1)).toBe(false);
    expect(store.events.has(2)).toBe(false);
    expect(store.queuedPromptCount('root')).toBe(1);

    store.install({ seq: 3, agents: [agent('root')], operations: [] });
    expect(store.operations.has('active')).toBe(false);
    expect(store.queuedPromptCount('root')).toBe(0);

    const newer = { ...queued, id: 'newer-queued' };
    store.ingest(event(4, 'operation.changed', newer));
    store.install({ seq: 3, agents: [agent('root')], operations: [] });
    expect(store.operations.get('newer-queued')?.status).toBe('queued');
    store.install({ seq: 4, agents: [agent('root')], operations: [] });
    expect(store.operations.has('newer-queued')).toBe(false);
  });
  test('terminal operation provenance blocks delayed unsequenced queued acknowledgements after snapshots omit it', () => {
    const store = new Store();
    store.install({ seq: 0, agents: [agent('root')], operations: [] });
    const terminalOperation = { ...operation('completed'), id: 'settled-queue', agentId: 'root' };
    store.ingest(event(1, 'operation.changed', terminalOperation));
    expect(store.operations.get('settled-queue')?.status).toBe('completed');

    store.install({ seq: 2, agents: [agent('root')], operations: [] });
    expect(store.operations.has('settled-queue')).toBe(false);
    store.putOperation({ ...terminalOperation, status: 'queued' }); // delayed RPC acceptance has no event sequence
    expect(store.operations.has('settled-queue')).toBe(false);
    expect(store.queuedPromptCount('root')).toBe(0);

    store.install({ seq: 3, agents: [agent('root')], operations: [] });
    expect(store.operations.has('settled-queue')).toBe(false);
    expect(store.queuedPromptCount('root')).toBe(0);
  });
  test('snapshot absence blocks delayed acknowledgements after a truncated terminal update', () => {
    const store = new Store();
    store.install({ seq: 0, agents: [agent('root')], operations: [] });
    const queued = { ...operation('queued'), id: 'missed-terminal', agentId: 'root' };
    store.ingest(event(1, 'operation.changed', queued));
    store.ingest(event(2, 'operation.changed', { truncated: true, originalBytes: 256, preview: '{"id":"missed-terminal","status":"completed"}' }));
    expect(store.queuedPromptCount('root')).toBe(1);

    store.install({ seq: 2, agents: [agent('root')], operations: [] });
    expect(store.operations.has('missed-terminal')).toBe(false);
    expect(store.queuedPromptCount('root')).toBe(0);
    store.putOperation(queued); // Delayed RPC acceptance has no sequence and predates the authoritative absence.
    expect(store.queuedPromptCount('root')).toBe(0);
    store.install({ seq: 3, agents: [agent('root')], operations: [] });
    store.putOperation(queued, 3);
    expect(store.queuedPromptCount('root')).toBe(0);
    expect(store.operations.has('missed-terminal')).toBe(false);
  });
  test('tree is parent-first, indented, hides archived agents, handles orphan/cycle records', () => {
    const store = new Store();
    store.install({ seq: 5, agents: [agent('grandchild', 'child'), agent('child', 'root'), agent('root'), agent('removed', 'root', { removedAt: 'yesterday' }), agent('orphan', 'unknown')], operations: [] });
    expect(store.tree().map(row => [row.agent.id, row.depth])).toEqual([['orphan', 0], ['root', 0], ['child', 1], ['grandchild', 2]]);
    store.agents.set('cycle1', agent('cycle1', 'cycle2'));
    store.agents.set('cycle2', agent('cycle2', 'cycle1'));
    expect(store.tree()).toHaveLength(6);
  });
  test('snapshot watermark does not discard transcript; buffered events replay after snapshot', () => {
    const store = new Store();
    store.ingest(event(3, 'agent.state', { state: 'running', revision: 1 }));
    store.ingest(event(1));
    store.install({ seq: 2, agents: [agent('root')], operations: [] });
    expect(store.agents.get('root')!.state).toBe('running');
    expect(store.orderedEvents().map(event => event.seq)).toEqual([1, 3]);
    expect(store.historyCursor).toBe(0);
    store.ingest(event(3));
    expect(store.events.size).toBe(2);
  });
  test('filters affect latest and chat, never control state; unknown events are tracked', () => {
    const store = new Store(); const settings = new Settings();
    store.install({ seq: 0, agents: [agent('root')], operations: [] });
    store.ingest(event(1));
    store.ingest(event(2, 'tool.update', { title: 'hidden' }));
    store.ingest(event(3, 'agent.state', { state: 'failed' }, { generation: undefined }));
    expect(store.agents.get('root')!.state).toBe('failed');
    expect(store.agents.get('root')!.generation).toBeNull();
    expect(store.latest(settings).get('root')!.seq).toBe(2);
    store.ingest(event(4, 'plugin.custom', { foo: 'bar' }));
    expect(store.latest(settings).get('root')!.seq).toBe(4);
    expect(settings.types(store.discovered)).toContain('plugin.custom');
    expect(store.transcript('root', settings)).toHaveLength(3);
    settings.levels['agent.message'] = settings.level('agent.message') === 0 ? 3 : 0;
    expect(store.transcript('root', settings)).toHaveLength(2);
  });
  test('latest message combines chunks per agent and keeps raw records intact', () => {
    const store = new Store(); const settings = new Settings();
    const chunk = (seq: number, text: string) => event(seq, 'agent.message', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
    store.ingest(chunk(1, 'The complete '));
    store.ingest(event(2, 'agent.message', undefined, { agentId: 'worker' }));
    store.ingest(chunk(3, 'answer'));
    store.ingest(chunk(4, '.'));
    settings.levels['prompt.finished'] = 0;
    store.ingest(event(5, 'prompt.finished', { status: 'completed' }));
    settings.levels['agent.message'] = 4; // Tree summaries are independent of chat levels.
    const latest = store.latest(settings).get('root')!;
    expect(latest.seq).toBe(4);
    expect(renderEvent(latest, 1, 80)).toBe('The complete answer.');
    expect(renderEvent(latest, 1, 12)).toBe('The complet…');
    expect(eventText(store.events.get(4)!)).toBe('.');
    expect(store.transcript('root', settings)).toHaveLength(3);
    store.ingest(chunk(6, 'New response'));
    expect(eventText(store.latest(settings).get('root')!)).toBe('New response');
  });
  test('message summaries handle late history, duplicate chunks and reset', () => {
    const store = new Store(); const settings = new Settings();
    const chunk = (seq: number, text: string) => event(seq, 'agent.message', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
    store.ingest(chunk(3, '.'));
    expect(eventText(store.latest(settings).get('root')!)).toBe('.');
    store.ingest(chunk(1, 'Hello '));
    store.ingest(chunk(2, 'world'));
    store.ingest(chunk(2, 'world'));
    expect(eventText(store.latest(settings).get('root')!)).toBe('Hello world.');
    store.ingest(chunk(4, ' More'));
    expect(eventText(store.latest(settings).get('root')!)).toBe('Hello world. More');
    store.reset();
    store.ingest(chunk(1, 'Fresh'));
    expect(eventText(store.latest(settings).get('root')!)).toBe('Fresh');
  });
  test('a compacted Unicode message does not append later chunks after its retained prefix', () => {
    const store = new Store(), settings = new Settings();
    store.install({ seq: 0, agents: [agent('root')], operations: [] });
    const chunk = (seq: number, text: string) => event(seq, 'agent.message', {
      sessionUpdate: 'agent_message_chunk', messageId: 'unicode', content: { type: 'text', text },
    });
    store.ingest(chunk(1, '👩‍💻'.repeat(50)));
    store.ingest(chunk(2, 'TAIL'));
    const row = stripAnsi(renderTable(store.tree(), store.latest(settings), ['event'], 80).items[0]!);
    expect(row).not.toContain('TAIL');
    expect(row.trimEnd()).toEndWith('…');
  });
  test('live message chunks do not merge across a prompt boundary when IDs are absent', () => {
    const store = new Store(), settings = new Settings();
    store.install({ seq: 0, agents: [agent('root')], operations: [] });
    const message = (seq: number, text: string) => event(seq, 'agent.message', {
      sessionUpdate: 'agent_message_chunk', content: { type: 'text', text },
    });
    store.ingest(message(1, 'OLD '));
    store.ingest(event(2, 'prompt.started', { operationId: 'prompt' }));
    store.ingest(message(3, 'NEW'));

    expect(eventText(store.latest(settings).get('root')!)).toBe('NEW');
  });
  test('late out-of-order chunks reconcile summaries even when they do not move the first sequence', () => {
    const store = new Store(), settings = new Settings();
    store.install({ seq: 0, agents: [agent('root')], operations: [] });
    const message = (seq: number, text: string) => event(seq, 'agent.message', {
      sessionUpdate: 'agent_message_chunk', messageId: 'same', content: { type: 'text', text },
    });
    store.ingest(message(1, 'Hello '));
    store.ingest(message(3, '.'));
    store.ingest(message(2, 'world'));
    expect(eventText(store.latest(settings).get('root')!)).toBe('Hello world.');
    store.ingest(message(4, ' More'));
    expect(eventText(store.latest(settings).get('root')!)).toBe('Hello world. More');
  });
  test('live message chunks retain historical prefix and reconcile out-of-order history', () => {
    const settings = new Settings();
    const message = (seq: number, text: string) => event(seq, 'agent.message', {
      sessionUpdate: 'agent_message_chunk', messageId: 'm', content: { type: 'text', text },
    });
    const seeded = new Store();
    seeded.install({ seq: 0, agents: [agent('root')], operations: [] });
    seeded.ingest(message(1, 'HEAD '), 'history');
    seeded.ingest(message(2, 'TAIL'));
    expect(eventText(seeded.latest(settings).get('root')!)).toBe('HEAD TAIL');

    const reordered = new Store();
    reordered.install({ seq: 0, agents: [agent('root')], operations: [] });
    reordered.ingest(message(3, '.'));
    reordered.ingest(message(1, 'Hello '));
    reordered.ingest(message(2, 'world'));
    reordered.ingest(message(4, ' More'));
    expect(eventText(reordered.latest(settings).get('root')!)).toBe('Hello world. More');
  });
  test('a late earlier chunk with a new message ID can extend the retained stream', () => {
    const store = new Store(), settings = new Settings();
    store.install({ seq: 0, agents: [agent('root')], operations: [] });
    const message = (seq: number, text: string, messageId: string) => event(seq, 'agent.message', {
      sessionUpdate: 'agent_message_chunk', messageId, content: { type: 'text', text },
    });
    store.ingest(message(3, 'TAIL', 'new'));
    store.ingest(message(4, ' MORE', 'new'));
    store.ingest(message(1, 'OLD ', 'old'));
    store.ingest(message(2, 'NEW ', 'new'));
    expect(eventText(store.latest(settings).get('root')!)).toBe('NEW TAIL MORE');
  });
  test('a late earlier assistant chunk can extend past an older thought chunk', () => {
    const store = new Store(), settings = new Settings();
    store.install({ seq: 0, agents: [agent('root')], operations: [] });
    const message = (seq: number, sessionUpdate: string, text: string) => event(seq, 'agent.message', {
      sessionUpdate, content: { type: 'text', text },
    });
    store.ingest(message(3, 'agent_message_chunk', 'TAIL'));
    store.ingest(message(4, 'agent_message_chunk', ' MORE'));
    store.ingest(message(1, 'agent_thought_chunk', 'OLD '));
    store.ingest(message(2, 'agent_message_chunk', 'NEW '));
    expect(eventText(store.latest(settings).get('root')!)).toBe('NEW TAIL MORE');
  });
  test('historical prompt boundaries separate later out-of-order live messages', () => {
    const store = new Store(), settings = new Settings();
    store.install({ seq: 0, agents: [agent('root')], operations: [] });
    const message = (seq: number, text: string) => event(seq, 'agent.message', {
      sessionUpdate: 'agent_message_chunk', content: { type: 'text', text },
    });
    store.ingest(event(2, 'prompt.started', { operationId: 'prompt' }), 'history');
    store.ingest(message(1, 'OLD '));
    store.ingest(message(3, 'NEW'));
    expect(eventText(store.latest(settings).get('root')!)).toBe('NEW');
  });
  test('historical message prefixes seed streams after earlier live prompts', () => {
    const store = new Store(), settings = new Settings();
    store.install({ seq: 0, agents: [agent('root')], operations: [] });
    const message = (seq: number, text: string) => event(seq, 'agent.message', {
      sessionUpdate: 'agent_message_chunk', content: { type: 'text', text },
    });
    store.ingest(message(2, 'HEAD '), 'history');
    store.ingest(event(1, 'prompt.started', { operationId: 'prompt' }));
    store.ingest(message(3, 'TAIL'));
    expect(eventText(store.latest(settings).get('root')!)).toBe('HEAD TAIL');
  });
  test('late prompt boundaries reconcile retained previews immediately', () => {
    const store = new Store(), settings = new Settings();
    store.install({ seq: 0, agents: [agent('root')], operations: [] });
    const message = (seq: number, text: string) => event(seq, 'agent.message', {
      sessionUpdate: 'agent_message_chunk', content: { type: 'text', text },
    });
    store.ingest(message(3, 'NEW'));
    store.ingest(message(1, 'OLD '));
    store.ingest(event(2, 'prompt.started', { operationId: 'prompt' }));
    expect(eventText(store.latest(settings).get('root')!)).toBe('NEW');
    store.ingest(message(4, ' TAIL'));
    expect(eventText(store.latest(settings).get('root')!)).toBe('NEW TAIL');
  });
  test('compatible historical chunks are not treated as tree-preview boundaries', () => {
    const store = new Store(), settings = new Settings();
    store.install({ seq: 0, agents: [agent('root')], operations: [] });
    const message = (seq: number, text: string) => event(seq, 'agent.message', {
      sessionUpdate: 'agent_message_chunk', messageId: 'same', content: { type: 'text', text },
    });
    store.ingest(message(1, 'HEAD '));
    store.ingest(message(2, 'MID '), 'history');
    store.ingest(message(3, 'TAIL '));
    expect(eventText(store.latest(settings).get('root')!)).toBe('HEAD MID TAIL ');
    store.ingest(message(4, 'MORE'));
    expect(eventText(store.latest(settings).get('root')!)).toBe('HEAD MID TAIL MORE');
  });
  test('backfilled old chunks cannot cross a retained prompt boundary after eviction', () => {
    const store = new Store(), settings = new Settings();
    store.configureHistory({ ...settings.history, recentEvents: 2 });
    store.install({ seq: 0, agents: [agent('root'), agent('other')], operations: [] });
    const message = (seq: number, text: string) => event(seq, 'agent.message', {
      sessionUpdate: 'agent_message_chunk', content: { type: 'text', text },
    });
    store.ingest(message(1, 'OLD '));
    store.ingest(event(2, 'prompt.started', { operationId: 'prompt' }));
    store.ingest(event(3, 'operation.changed', { id: 'other-1', status: 'running' }, { agentId: 'other' }));
    store.ingest(event(4, 'operation.changed', { id: 'other-2', status: 'running' }, { agentId: 'other' }));
    expect(store.events.has(1)).toBe(false);
    expect(store.events.has(2)).toBe(false);
    store.setActiveChat('root');
    store.ingest(message(1, 'OLD '), 'history');
    store.ingest(message(1, 'OLD '), 'history');
    store.ingest(message(5, 'NEW'));
    expect(eventText(store.latest(settings).get('root')!)).toBe('NEW');
  });
  test('an earlier historical chunk can move a mixed-source message start backward', () => {
    const store = new Store(), settings = new Settings();
    store.install({ seq: 0, agents: [agent('root')], operations: [] });
    const message = (seq: number, text: string, messageId: string) => event(seq, 'agent.message', {
      sessionUpdate: 'agent_message_chunk', messageId, content: { type: 'text', text },
    });
    store.ingest(message(1, 'OLD ', 'old'));
    store.ingest(message(3, 'TAIL', 'new'), 'history');
    store.ingest(message(4, ' MORE', 'new'));
    store.ingest(message(2, 'NEW ', 'new'), 'history');
    expect(eventText(store.latest(settings).get('root')!)).toBe('NEW TAIL MORE');
  });
  test('an earlier historical assistant chunk moves a mixed thought-to-message start backward', () => {
    const store = new Store(), settings = new Settings();
    store.install({ seq: 0, agents: [agent('root')], operations: [] });
    const message = (seq: number, sessionUpdate: string, text: string) => event(seq, 'agent.message', {
      sessionUpdate, content: { type: 'text', text },
    });
    store.ingest(message(1, 'agent_thought_chunk', 'OLD '));
    store.ingest(message(3, 'agent_message_chunk', 'TAIL'), 'history');
    store.ingest(message(4, 'agent_message_chunk', ' MORE'));
    store.ingest(message(2, 'agent_message_chunk', 'NEW '), 'history');
    expect(eventText(store.latest(settings).get('root')!)).toBe('NEW TAIL MORE');
  });
  test('history backfill preserves an evicted custom sidecar after a thought-to-message transition', () => {
    const store = new Store(), settings = new Settings();
    store.configureHistory({ ...settings.history, recentEvents: 2 });
    store.install({ seq: 0, agents: [agent('root'), agent('other')], operations: [] });
    const message = (seq: number, sessionUpdate: string, text: string) => event(seq, 'agent.message', {
      sessionUpdate, content: { type: 'text', text },
    });
    store.ingest(message(1, 'agent_thought_chunk', 'THOUGHT '));
    store.ingest(message(2, 'agent_message_chunk', 'IGNORE '));
    store.present(2, { rendererId: 'fixture', subtype: 'custom', summary: 'custom', extended: 'custom', full: 'custom' });
    store.ingest(message(3, 'agent_message_chunk', 'NEW '));
    store.ingest(event(4, 'operation.changed', { id: 'other-1', status: 'running' }, { agentId: 'other' }));
    store.ingest(event(5, 'operation.changed', { id: 'other-2', status: 'running' }, { agentId: 'other' }));
    expect(store.events.has(1)).toBe(false);
    expect(store.events.has(2)).toBe(false);
    expect(store.renderings.has(2)).toBe(false);
    store.setActiveChat('root');
    store.ingest(message(1, 'agent_thought_chunk', 'THOUGHT '), 'history');
    store.ingest(message(2, 'agent_message_chunk', 'IGNORE '), 'history');
    store.ingest(message(3, 'agent_message_chunk', 'NEW '), 'history');
    store.ingest(message(6, 'agent_message_chunk', 'TAIL'));
    expect(eventText(store.latest(settings).get('root')!)).toBe('NEW TAIL');
  });
  test('history backfill retains a sidecar boundary attached after streamed chunks merged', () => {
    const store = new Store(), settings = new Settings();
    store.configureHistory({ ...settings.history, recentEvents: 2 });
    store.install({ seq: 0, agents: [agent('root'), agent('other')], operations: [] });
    const message = (seq: number, text: string) => event(seq, 'agent.message', {
      sessionUpdate: 'agent_message_chunk', content: { type: 'text', text },
    });
    store.ingest(message(1, 'IGNORE '));
    store.ingest(message(2, 'NEW '));
    store.present(1, { rendererId: 'fixture', subtype: 'custom', summary: 'custom', extended: 'custom', full: 'custom' });
    store.ingest(event(3, 'operation.changed', { id: 'other-1', status: 'running' }, { agentId: 'other' }));
    store.ingest(event(4, 'operation.changed', { id: 'other-2', status: 'running' }, { agentId: 'other' }));
    expect(store.events.has(1)).toBe(false);
    expect(store.renderings.has(1)).toBe(false);
    store.setActiveChat('root');
    store.ingest(message(1, 'IGNORE '), 'history');
    store.ingest(message(2, 'NEW '), 'history');
    store.ingest(message(5, 'TAIL'));
    expect(eventText(store.latest(settings).get('root')!)).toBe('NEW TAIL');
  });
  test('history backfill retains a sidecar boundary that prevented the first join', () => {
    const store = new Store(), settings = new Settings();
    store.configureHistory({ ...settings.history, recentEvents: 2 });
    store.install({ seq: 0, agents: [agent('root'), agent('other')], operations: [] });
    const message = (seq: number, text: string) => event(seq, 'agent.message', {
      sessionUpdate: 'agent_message_chunk', content: { type: 'text', text },
    });
    store.ingest(message(1, 'IGNORE '));
    store.present(1, { rendererId: 'fixture', subtype: 'custom', summary: 'custom', extended: 'custom', full: 'custom' });
    store.ingest(message(2, 'NEW '));
    store.ingest(event(3, 'operation.changed', { id: 'other-1', status: 'running' }, { agentId: 'other' }));
    store.ingest(event(4, 'operation.changed', { id: 'other-2', status: 'running' }, { agentId: 'other' }));
    expect(store.events.has(1)).toBe(false);
    expect(store.events.has(2)).toBe(false);
    expect(store.renderings.has(1)).toBe(false);
    store.setActiveChat('root');
    store.ingest(message(1, 'IGNORE '), 'history');
    store.ingest(message(2, 'NEW '), 'history');
    store.ingest(message(5, 'TAIL'));
    expect(eventText(store.latest(settings).get('root')!)).toBe('NEW TAIL');
  });
  test('repeated old backfills cannot revive a response before an evicted prompt boundary', () => {
    const store = new Store(), settings = new Settings();
    store.configureHistory({ ...settings.history, recentEvents: 2 });
    store.install({ seq: 0, agents: [agent('root'), agent('other')], operations: [] });
    const message = (seq: number, text: string) => event(seq, 'agent.message', {
      sessionUpdate: 'agent_message_chunk', content: { type: 'text', text },
    });
    store.ingest(message(1, 'OLD '));
    store.ingest(event(2, 'prompt.started', { operationId: 'prompt' }));
    store.ingest(event(3, 'operation.changed', { id: 'other-1', status: 'running' }, { agentId: 'other' }));
    store.ingest(event(4, 'operation.changed', { id: 'other-2', status: 'running' }, { agentId: 'other' }));
    expect(store.events.has(1)).toBe(false);
    expect(store.events.has(2)).toBe(false);
    store.setActiveChat('root');
    store.ingest(message(1, 'OLD '), 'history');
    store.ingest(message(1, 'OLD '), 'history');
    store.ingest(message(5, 'NEW '));
    expect(eventText(store.latest(settings).get('root')!)).toBe('NEW ');
    store.ingest(message(1, 'OLD '), 'history');
    store.ingest(message(6, 'TAIL'));
    expect(eventText(store.latest(settings).get('root')!)).toBe('NEW TAIL');
  });
  test('history backfill after eviction preserves the observed beginning of a live stream', () => {
    const store = new Store(), settings = new Settings();
    store.configureHistory({ ...settings.history, recentEvents: 2 });
    store.install({ seq: 0, agents: [agent('root')], operations: [] });
    const message = (seq: number, text: string) => event(seq, 'agent.message', {
      sessionUpdate: 'agent_message_chunk', messageId: 'm', content: { type: 'text', text },
    });
    store.ingest(message(1, 'HEAD '));
    store.ingest(message(2, 'MID '));
    store.ingest(message(3, 'TAIL '));
    store.ingest(message(3, 'TAIL '), 'history');
    store.ingest(message(4, 'MORE'));
    expect(eventText(store.latest(settings).get('root')!)).toBe('HEAD MID TAIL MORE');
  });
  test('an older backfilled prompt cannot invalidate a preserved stream beginning', () => {
    const store = new Store(), settings = new Settings();
    store.configureHistory({ ...settings.history, recentEvents: 2 });
    store.install({ seq: 0, agents: [agent('root')], operations: [] });
    const message = (seq: number, text: string) => event(seq, 'agent.message', {
      sessionUpdate: 'agent_message_chunk', messageId: 'm', content: { type: 'text', text },
    });
    store.ingest(message(1, 'HEAD '));
    store.ingest(message(2, 'MID '));
    store.ingest(message(3, 'TAIL '));
    store.ingest(event(0, 'prompt.started', { operationId: 'old-prompt' }), 'history');
    expect(eventText(store.latest(settings).get('root')!)).toBe('HEAD MID TAIL ');
  });
  test('history message prefix seeds a live continuation after a live prompt boundary', () => {
    const store = new Store(), settings = new Settings();
    store.install({ seq: 0, agents: [agent('root')], operations: [] });
    const message = (seq: number, text: string) => event(seq, 'agent.message', {
      sessionUpdate: 'agent_message_chunk', messageId: 'continuation', content: { type: 'text', text },
    });
    store.ingest(event(1, 'prompt.started', { operationId: 'prompt' }));
    store.ingest(message(2, 'HEAD '), 'history');
    store.ingest(message(3, 'TAIL'));
    expect(eventText(store.latest(settings).get('root')!)).toBe('HEAD TAIL');
  });
  test('historical prompt boundary prevents an old live message from joining a new response', () => {
    const store = new Store(), settings = new Settings();
    store.install({ seq: 0, agents: [agent('root')], operations: [] });
    const message = (seq: number, text: string) => event(seq, 'agent.message', {
      sessionUpdate: 'agent_message_chunk', content: { type: 'text', text },
    });
    store.ingest(message(1, 'OLD '));
    store.ingest(event(2, 'prompt.started', { operationId: 'prompt' }), 'history');
    store.ingest(message(3, 'NEW'));
    expect(eventText(store.latest(settings).get('root')!)).toBe('NEW');
  });
  test('history sidecar breaks a message join before the next live chunk', () => {
    const store = new Store(), settings = new Settings();
    store.install({ seq: 0, agents: [agent('root')], operations: [] });
    store.ingest(event(1, 'agent.message', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'IGNORE ' } }), 'history');
    store.present(1, { rendererId: 'fixture', summary: 'custom summary', extended: 'custom summary', full: 'custom summary' });
    store.ingest(event(2, 'agent.message', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'NEW' } }));
    expect(eventText(store.latest(settings).get('root')!)).toBe('NEW');
  });
  test('Store-to-table Unicode previews end on a grapheme boundary with an ellipsis', () => {
    const store = new Store(), settings = new Settings();
    store.install({ seq: 0, agents: [agent('root')], operations: [] });
    store.ingest(event(1, 'agent.message', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '👩‍💻'.repeat(50) } }));
    const summary = stripAnsi(renderTable(store.tree(), store.latest(settings), ['event'], 80).items[0]!).slice(2).trimEnd();
    expect(summary).toEndWith('…');
    expect([...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(summary.slice(0, -1))].every(({ segment }) => segment === '👩‍💻')).toBe(true);
  });
  test('history after a live boundary supplies the authoritative continuation prefix', () => {
    const store = new Store(), settings = new Settings();
    store.install({ seq: 0, agents: [agent('root')], operations: [] });
    const message = (seq: number, text: string) => event(seq, 'agent.message', {
      sessionUpdate: 'agent_message_chunk', messageId: 'm', content: { type: 'text', text },
    });
    store.ingest(event(1, 'prompt.started', { operationId: 'prompt' }));
    store.ingest(message(2, 'NEW '), 'history');
    store.ingest(message(3, 'TAIL'));
    expect(eventText(store.latest(settings).get('root')!)).toBe('NEW TAIL');
  });
  test('a late historical boundary replaces an already merged speculative prefix', () => {
    const store = new Store(), settings = new Settings();
    store.install({ seq: 0, agents: [agent('root')], operations: [] });
    const message = (seq: number, text: string) => event(seq, 'agent.message', {
      sessionUpdate: 'agent_message_chunk', messageId: 'm', content: { type: 'text', text },
    });
    store.ingest(message(1, 'OLD '));
    store.ingest(message(3, 'NEW '));
    store.ingest(event(2, 'prompt.started', { operationId: 'prompt' }), 'history');
    store.ingest(message(4, 'TAIL'));
    expect(eventText(store.latest(settings).get('root')!)).toBe('NEW TAIL');
  });
  test('a late rendering sidecar invalidates merged live chunks before the next chunk', () => {
    const store = new Store(), settings = new Settings();
    store.install({ seq: 0, agents: [agent('root')], operations: [] });
    const message = (seq: number, text: string) => event(seq, 'agent.message', {
      sessionUpdate: 'agent_message_chunk', messageId: 'm', content: { type: 'text', text },
    });
    store.ingest(message(1, 'IGNORE '));
    store.ingest(message(2, 'NEW '));
    store.present(1, { rendererId: 'fixture', subtype: 'custom', summary: 'custom summary', extended: 'custom summary', full: 'custom summary' });
    expect(eventText(store.latest(settings).get('root')!)).toBe('NEW ');
    store.ingest(message(3, 'TAIL'));
    expect(eventText(store.latest(settings).get('root')!)).toBe('NEW TAIL');
  });
  test('history reconciles a retained streamed message despite a later hidden event', () => {
    const store = new Store(), settings = new Settings();
    settings.levels['operation.changed'] = 0;
    store.install({ seq: 0, agents: [agent('root')], operations: [] });
    const message = (seq: number, text: string) => event(seq, 'agent.message', {
      sessionUpdate: 'agent_message_chunk', messageId: 'm', content: { type: 'text', text },
    });
    store.ingest(message(3, '.'));
    store.ingest(event(4, 'operation.changed', { id: 'hidden', status: 'running' }));
    store.ingest(message(1, 'Hello '), 'history');
    store.ingest(message(2, 'world'), 'history');
    expect(eventText(store.latest(settings).get('root')!)).toBe('Hello world.');
  });
  test('a late sidecar reconciles a retained message despite a later hidden event', () => {
    const store = new Store(), settings = new Settings();
    settings.levels['operation.changed'] = 0;
    store.install({ seq: 0, agents: [agent('root')], operations: [] });
    const message = (seq: number, text: string) => event(seq, 'agent.message', {
      sessionUpdate: 'agent_message_chunk', messageId: 'm', content: { type: 'text', text },
    });
    store.ingest(message(1, 'IGNORE '));
    store.ingest(message(2, 'NEW '));
    store.ingest(event(3, 'operation.changed', { id: 'hidden', status: 'running' }));
    store.present(1, { rendererId: 'fixture', subtype: 'custom', summary: 'custom summary', extended: 'custom summary', full: 'custom summary' });
    expect(eventText(store.latest(settings).get('root')!)).toBe('NEW ');
  });
  test('history arrival reconciles a pending live preview immediately', () => {
    const store = new Store(), settings = new Settings();
    store.install({ seq: 0, agents: [agent('root')], operations: [] });
    const message = (seq: number, text: string) => event(seq, 'agent.message', {
      sessionUpdate: 'agent_message_chunk', messageId: 'm', content: { type: 'text', text },
    });
    store.ingest(message(3, '.'));
    store.ingest(message(1, 'Hello '), 'history');
    store.ingest(message(2, 'world'), 'history');
    expect(eventText(store.latest(settings).get('root')!)).toBe('Hello world.');
  });
  test('reconciled tree boundaries do not retain oversized history payloads after eviction', () => {
    const store = new Store(), settings = new Settings();
    store.configureHistory({ ...settings.history, recentEvents: 2 });
    store.install({ seq: 0, agents: [agent('root'), agent('other')], operations: [] });
    const message = (seq: number, text: string) => event(seq, 'agent.message', {
      sessionUpdate: 'agent_message_chunk', messageId: 'm', content: { type: 'text', text },
    });
    store.ingest(message(1, 'LARGE_ANCHOR ' + 'x'.repeat(100_000)), 'history');
    store.ingest(message(3, 'TAIL'));
    store.ingest(message(2, 'MID'));
    expect(store.events.has(1)).toBe(false);
    const retained = (store as any).livePreviewBoundaries.get('root').event;
    expect(Buffer.byteLength(JSON.stringify(retained))).toBeLessThan(2048);
  });
  test('reinstalling a same-generation snapshot does not replay message chunks twice', () => {
    const store = new Store(), settings = new Settings();
    const snapshot = { seq: 2, agents: [agent('root')], operations: [] };
    store.install(snapshot);
    store.ingest(event(1, 'agent.message', { sessionUpdate: 'agent_message_chunk', content: { text: 'Hello ' } }));
    store.ingest(event(2, 'agent.message', { sessionUpdate: 'agent_message_chunk', content: { text: 'world' } }));
    expect(eventText(store.latest(settings).get('root')!)).toBe('Hello world');
    store.install(snapshot);
    expect(eventText(store.latest(settings).get('root')!)).toBe('Hello world');
  });
  test('same-sequence live candidates do not replace complete cached non-message events', () => {
    const store = new Store(), settings = new Settings();
    store.install({ seq: 0, agents: [agent('root')], operations: [] });
    store.ingest(event(1, 'tool.call', { title: 'write', rawInput: { path: 'src/file.ts', content: 'x'.repeat(1500) } }));
    const row = renderTable(store.tree(), store.latest(settings), ['event'], 60).items[0]!;
    expect(stripAnsi(row)).toContain('> src/file.ts');
    expect(stripAnsi(row)).not.toContain('TRUNCATED');
  });
  test('long message beginnings survive bounded IDs and raw-history eviction', () => {
    const store = new Store(), settings = new Settings();
    store.install({ seq: 0, agents: [agent('root')], operations: [] });
    const message = (seq: number, text: string) => event(seq, 'agent.message', {
      sessionUpdate: 'agent_message_chunk', messageId: 'i'.repeat(97), content: { type: 'text', text },
    });
    store.ingest(message(1, 'IDENTITY_ANCHOR '));
    for (let seq = 2; seq <= 2001; seq++) store.ingest(message(seq, 'x'));
    expect(store.events.size).toBeLessThanOrEqual(2000);
    expect(stripAnsi(renderTable(store.tree(), store.latest(settings), ['event'], 60).items[0]!).slice(2)).toStartWith('IDENTITY_ANCHOR');
  });
  test('tree table retains the beginning of a long live message after raw events are evicted', () => {
    const store = new Store(), settings = new Settings();
    store.install({ seq: 0, agents: [agent('root')], operations: [] });
    for (let seq = 1; seq <= 2001; seq++) {
      const text = seq === 1 ? 'TREE_ANCHOR ' : 'x';
      store.ingest(event(seq, 'agent.message', {
        sessionUpdate: 'agent_message_chunk', messageId: 'long-message', content: { type: 'text', text },
      }));
    }

    expect(store.events.size).toBeLessThanOrEqual(2000);
    const row = renderTable(store.tree(), store.latest(settings), ['event'], 60).items[0]!;
    expect(stripAnsi(row).slice(2)).toStartWith('TREE_ANCHOR');
  });
  test('message summaries respect generation, kind, message ID and hidden boundaries', () => {
    const settings = new Settings(); settings.levels['prompt.started'] = 0;
    const first = event(1, 'agent.message', { sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: { type: 'text', text: 'Old ' } });
    const next = event(3, 'agent.message', { sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: { type: 'text', text: 'New' } });
    for (const boundary of [
      { ...next, generation: 'g2' },
      { ...next, data: { ...next.data as any, sessionUpdate: 'agent_thought_chunk' } },
      { ...next, data: { ...next.data as any, messageId: 'm2' } },
      event(2, 'prompt.started'),
      event(2, 'agent.message', { content: { type: 'image', data: 'payload' } }),
    ]) {
      const store = new Store();
      store.ingest(first); store.ingest(boundary);
      if (boundary.seq === 2) store.ingest(next);
      expect(eventText(store.latest(settings).get('root')!)).toBe('New');
    }
  });
  test('late acceptance responses cannot regress completed or interrupted operations', () => {
    const store = new Store();
    store.install({ seq: 0, agents: [], operations: [] });
    store.ingest(event(1, 'operation.changed', operation('completed')));
    store.putOperation(operation('queued'));
    expect(store.operations.get('op')!.status).toBe('completed');
    const interrupted = { ...operation('interrupted'), id: 'interrupted-op' };
    store.ingest(event(2, 'operation.changed', interrupted));
    store.putOperation({ ...interrupted, status: 'queued' });
    expect(store.operations.get('interrupted-op')!.status).toBe('interrupted');
  });
  test('truncated and partial lifecycle events request reconciliation', () => {
    const store = new Store(); let refreshes = 0;
    store.on('refresh', () => refreshes++);
    store.install({ seq: 0, agents: [], operations: [] });
    store.ingest(event(1, 'agent.created', { truncated: true, originalBytes: 100, preview: '{' }));
    store.ingest(event(2, 'agent.session_replaced', { sessionNumber: 2 }));
    expect(refreshes).toBe(2);
    expect(store.agents.size).toBe(0);
  });
});

describe('static tree previews', () => {
  const message = (text: string, sessionUpdate = 'agent_message_chunk') => event(1, 'agent.message', { sessionUpdate, content: { type: 'text', text } });
  test('keeps Markdown source literal and folds blocks into one line without an assistant label', () => {
    const rendered = renderTreeEvent(message('# Heading\n\n**bold** and _italic_ with `code`\n\n- item\n\n```ts\nconst x = 1;\n```'), 120);
    expect(rendered.split('\n')).toHaveLength(1);
    const text = stripAnsi(rendered);
    expect(text).toContain('# Heading **bold** and _italic_ with `code` - item ```ts const x = 1; ```');
    expect(text).not.toContain('assistant:');
  });
  test('thinking chunks keep their beginning fixed as streamed Markdown completes', () => {
    const first = stripAnsi(renderTreeEvent(message('[THINKING_ANCHOR', 'agent_thought_chunk'), 80));
    const completed = stripAnsi(renderTreeEvent(message('[THINKING_ANCHOR](https://example.test) and more', 'agent_thought_chunk'), 80));
    expect(first).toStartWith('thinking: [THINKING_ANCHOR');
    expect(completed).toStartWith(first);
  });
  test('right-clips literal summaries by terminal cells', () => {
    const rendered = renderTreeEvent(message('Hello world'), 8);
    expect(stripAnsi(rendered)).toBe('Hello w…');
    expect(stringWidth(rendered)).toBe(8);
    expect(renderTreeEvent(message('bold'), 0)).toBe('');
    expect(stripAnsi(renderTreeEvent(message('bold'), 1))).toBe('…');
    for (const text of ['🦊🦊🦊', '👩‍💻👩‍💻👩‍💻', 'e\u0301e\u0301e\u0301']) {
      const preview = renderTreeEvent(message(text), 5);
      expect(stripAnsi(preview)).toBe(clip(text, 5));
      expect(stringWidth(preview)).toBeLessThanOrEqual(5);
    }
  });
  test('renders other event types and sanitizes remote terminal commands before styling', () => {
    const tool = event(1, 'tool.call', { title: '**Search**', status: 'pending' });
    expect(stripAnsi(renderTreeEvent(tool, 80))).toBe('• **Search**');
    expect(renderTreeEvent(tool, 80, undefined, { toolCall: 'magenta' })).toContain('\x1b[35m•\x1b[0m');
    const rendered = renderTreeEvent(message('\x1b[2J**safe**\x07'), 80);
    expect(stripAnsi(rendered)).toBe('**safe**');
    expect(rendered).not.toContain('\x1b[2J');
    expect(rendered).not.toContain('\x07');
    expect(renderTreeEvent(event(1, 'plugin.\ncustom\x1b[2J', 'payload'), 80)).not.toContain('\n');
    expect(stripAnsi(renderTreeEvent(message('[docs](https://example.com)'), 80))).toBe('[docs](https://example.com)');
    expect(stripAnsi(renderTreeEvent(event(1, 'agent.message', { truncated: true, originalBytes: 1000, preview: '**partial**' }), 80))).toContain('TRUNCATED');
  });
});

describe('four non-hidden rendering levels', () => {
  const message = event(1, 'agent.message', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '# Heading\n\n**bold** and _italic_\n\n- list entry\n\n```ts\nconst x = 1;\n```\n' } });
  test('summary is one terminal-width-aware line; indentation and Unicode are preserved', () => {
    const summary = renderEvent(message, 1, 24);
    expect(summary.split('\n')).toHaveLength(1);
    expect(stringWidth(summary)).toBeLessThanOrEqual(24);
    expect(summary).toBe('# Heading  **bold** and…');
    expect(summary).not.toContain('assistant:');
    expect(renderEvent(event(2, 'agent.message', { sessionUpdate: 'user_message_chunk', content: { text: 'Hello' } }), 1, 80)).toBe('Hello');
    expect(clip('  child', 20)).toBe('  child');
    expect(clip('🦊🦊🦊', 5)).toBe('🦊🦊…');
    expect(clip('test', 0)).toBe('');
  });
  test('chat level-one sidecar summaries retain Markdown rendering', () => {
    const sidecar = { rendererId: 'fixture', summary: '**Hello** from sidecar', extended: '**Hello** from sidecar', full: '**Hello** from sidecar' };
    const rendered = renderEvent(event(1, 'agent.message', { sessionUpdate: 'agent_message_chunk', content: { text: 'ignored' } }), 1, 80, sidecar);
    expect(stripAnsi(rendered)).toBe('Hello from sidecar');
    expect(rendered).toContain('\x1b[1mHello\x1b[0m');
  });
  test('extended is at most two wrapped lines', () => {
    const extended = renderEvent(message, 2, 20);
    expect(extended.split('\n')).toHaveLength(2);
    for (const line of extended.split('\n')) expect(stringWidth(line)).toBeLessThanOrEqual(20);
    expect(extended).toEndWith('…');
  });
  test('agent prompt cue is accented while its untouched Markdown body parses at block start in chat and tree', () => {
    const body = '# Heading\n\n- item with `code`';
    const text = `@Research lead ${body}`;
    const queued = event(3, 'prompt.queued', { operationId: 'op', text, effect: 'queue', promptCue: { version: 1, bodyStart: '@Research lead '.length } });
    const full = renderEvent(queued, 3, 80, undefined, { agentTarget: 'magenta' });
    expect(stripAnsi(full)).toContain('YOU · QUEUE · @Research lead');
    expect(stripAnsi(full)).toContain('Heading');
    expect(full).toContain('\x1b[35mYOU · QUEUE · @Research lead\x1b[0m');
    expect(stripAnsi(full)).toContain('item with code');
    expect(stripAnsi(full)).not.toContain('# Heading');
    const tree = renderTreeEvent(queued, 80, undefined, { agentTarget: 'magenta' });
    const compact = new Store(); compact.install({ seq: 0, agents: [agent('root')], operations: [] }); compact.ingest(queued);
    expect(compact.events.get(3)?.data).toMatchObject({ effect: 'queue' });
    expect(stripAnsi(renderEvent(compact.events.get(3)!, 3, 80))).toContain('QUEUE');
    expect(stripAnsi(tree)).toContain('QUEUE');
    expect(stripAnsi(tree)).toContain('@Research lead');
    expect(stripAnsi(tree)).toContain('Heading');
    expect(tree).toContain('\x1b[35mYOU · QUEUE · @Research lead\x1b[0m');
    const forged = event(4, 'prompt.queued', { text: '@Human # literal', promptCue: { version: 1, bodyStart: 8 } });
    expect(stripAnsi(renderEvent(forged, 3, 80))).toContain('@Human # literal');
  });
  test('prompt sidecars keep summary/extended/full selection and only accent a validated cue', () => {
    const text = '@Root Coordinator ignored source';
    const queued = event(5, 'prompt.queued', { text, promptCue: { version: 1, bodyStart: '@Root Coordinator '.length } });
    const sidecar = { rendererId: 'custom.prompt', summary: '@Root Coordinator **Custom summary**', extended: '@Root Coordinator Custom extended detail', full: '@Root Coordinator Custom full body\nsecond line' };
    const summary = renderEvent(queued, 1, 80, sidecar, { agentTarget: 'magenta' });
    expect(stripAnsi(summary)).toBe('YOU · PROMPT · @Root Coordinator — Custom summary');
    expect(summary).toContain('\x1b[35mYOU · PROMPT · @Root Coordinator\x1b[0m');
    expect(stripAnsi(renderEvent(queued, 2, 80, sidecar))).toContain('Custom extended detail');
    expect(stripAnsi(renderEvent(queued, 3, 80, sidecar))).toContain('Custom full body');
    const treeSidecar = renderTreeEvent(queued, 80, sidecar);
    expect(stripAnsi(treeSidecar)).toBe('YOU · PROMPT · @Root Coordinator — Custom summary');
    expect(treeSidecar).toContain('\x1b[1mCustom summary\x1b[0m');
    const noCue = { ...sidecar, summary: 'Custom summary without a cue' };
    expect(renderEvent(queued, 1, 80, noCue)).not.toContain('\x1b[35m');
    expect(stripAnsi(renderEvent(queued, 1, 80, noCue))).toBe('YOU · PROMPT — Custom summary without a cue');
  });
  test('interrupt prompt effects are distinct in chat and tree rendering', () => {
    const text = '@Root Coordinator Return only a float';
    const interrupted = event(8, 'prompt.queued', { operationId: 'interrupt-op', text, effect: 'interrupt', promptCue: { version: 1, bodyStart: '@Root Coordinator '.length } });
    expect(stripAnsi(renderEvent(interrupted, 1, 100))).toStartWith('YOU · INTERRUPT · @Root Coordinator');
    expect(stripAnsi(renderTreeEvent(interrupted, 100))).toStartWith('YOU · INTERRUPT · @Root Coordinator');
    const store = new Store(); store.install({ seq: 0, agents: [agent('root')], operations: [] }); store.ingest(interrupted);
    expect(store.events.get(8)?.data).toMatchObject({ effect: 'interrupt' });
    expect(stripAnsi(renderEvent(store.events.get(8)!, 3, 100))).toContain('YOU · INTERRUPT · @Root Coordinator');
  });
  test('narrow full prompt cues wrap without losing issuer or body, including wide graphemes', () => {
    for (const mention of ['@Long Parent Name', '@界界界界']) {
      const body = 'Body remains fully visible after a long cue.';
      const text = `${mention} ${body}`;
      const queued = event(6, 'prompt.queued', { text, promptCue: { version: 1, bodyStart: mention.length + 1 } });
      const full = renderEvent(queued, 3, 8, undefined, { agentTarget: 'magenta' });
      const visible = stripAnsi(full).replace(/\s+/g, ' ');
      expect(visible.replace(/\s/g, '')).toContain(mention.replace(/\s/g, ''));
      expect(visible).toContain(body);
      for (const line of full.split('\n')) expect(stringWidth(line)).toBeLessThanOrEqual(8);
    }
    const text = '@Parent 界界Z';
    const queued = event(7, 'prompt.queued', { text, promptCue: { version: 1, bodyStart: '@Parent '.length } });
    const full = renderEvent(queued, 3, 9, undefined, { agentTarget: 'magenta' });
    const visible = stripAnsi(full);
    expect(visible).toContain('@Parent');
    expect(visible.replace(/\s/g, '')).toContain('界界Z');
    for (const line of full.split('\n')) expect(stringWidth(line)).toBeLessThanOrEqual(9);
  });
  test('child prompt chat and tree show only the validated issuer cue', () => {
    const text = '@Root Coordinator # Review the plan';
    const queued = event(4, 'prompt.queued', { operationId: 'op', text, promptCue: { version: 1, bodyStart: '@Root Coordinator '.length } }, { agentId: 'child-id' });
    const full = renderEvent(queued, 3, 100, undefined, { agentTarget: 'magenta' });
    expect(stripAnsi(full)).toContain('YOU · PROMPT · @Root Coordinator');
    expect(stripAnsi(full)).toContain('Review the plan');
    expect(stripAnsi(full)).not.toContain('Child Reviewer');
    expect(full).toContain('\x1b[35mYOU · PROMPT · @Root Coordinator\x1b[0m');
    const tree = renderTreeEvent(queued, 100, undefined, { agentTarget: 'magenta' });
    expect(stripAnsi(tree)).toBe('YOU · PROMPT · @Root Coordinator — # Review the plan');
    expect(stripAnsi(tree)).not.toContain('Child Reviewer');
    expect(tree).toContain('\x1b[35mYOU · PROMPT · @Root Coordinator\x1b[0m');
  });
  test('full renders Markdown without dropping text, raw retains the complete wire event', () => {
    const full = renderEvent(message, 3, 80);
    expect(full).toContain('\x1b[');
    expect(stripAnsi(full)).toContain('Heading');
    expect(stripAnsi(full)).not.toContain('# Heading');
    expect(stripAnsi(full)).not.toContain('`code`');
    expect(stripAnsi(full)).toContain('bold');
    expect(stripAnsi(full)).not.toContain('**bold**');
    expect(stripAnsi(full)).toContain('const x = 1;');
    expect(JSON.parse(renderEvent(message, 4, 1000))).toEqual(message);
  });
  test('inline code styling is token-aware, not applied to fenced or escaped backticks', () => {
    const text = 'Inline `code` remains styled.\n\n```js\nconst template = `raw ${value}`;\n```\n\nEscaped \\`tick\\` remains literal.';
    const rendered = renderEvent(event(7, 'agent.message', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } }), 3, 120);
    expect(rendered).toContain(String.fromCharCode(27) + '[33mcode' + String.fromCharCode(27) + '[0m');
    expect(rendered).not.toContain(String.fromCharCode(27) + '[33m`raw ${value}`' + String.fromCharCode(27) + '[0m');
    expect(rendered).not.toContain(String.fromCharCode(27) + '[33m`tick`' + String.fromCharCode(27) + '[0m');
    expect(stripAnsi(rendered)).toContain('const template = `raw ${value}`;');
    expect(stripAnsi(rendered)).toContain('Escaped `tick` remains literal.');
    const literalBacktick = renderEvent(event(8, 'agent.message', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Double ticks `` `x` `` preserve the literal delimiters.' } }), 3, 80);
    expect(stripAnsi(literalBacktick)).toContain('`x`');
    expect(literalBacktick).toContain(String.fromCharCode(27) + '[33m`x`' + String.fromCharCode(27) + '[0m');
  });
  test('inline emphasis and code render inside tight Markdown lists', () => {
    const list = event(5, 'agent.message', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '- **Markdown Researcher** found `docs/tui.md`.' } });
    const rendered = renderEvent(list, 3, 120);
    expect(rendered).toContain('\x1b[1mMarkdown Researcher\x1b[0m');
    expect(rendered).toContain('\x1b[33mdocs/tui.md\x1b[0m');
    expect(stripAnsi(rendered)).not.toContain('**Markdown Researcher**');
    expect(stripAnsi(rendered)).toContain('Markdown Researcher found docs/tui.md.');
  });
  test('nontext/unknown/truncated content is tolerant and marked incomplete', () => {
    const unknown = event(1, 'plugin.custom', { mystery: 42 });
    expect(renderEvent(unknown, 3, 80)).toContain('mystery');
    expect(eventText(event(2, 'agent.message', { content: { type: 'image', data: 'payload' } }))).toContain('image');
    expect(eventText(event(3, 'agent.message', { truncated: true, originalBytes: 1000, preview: '{partial' }))).toContain('TRUNCATED');
    expect(eventText(event(4, 'operation.changed', { ...operation('completed'), result: { text: 'DO NOT DUPLICATE' } }))).not.toContain('DO NOT DUPLICATE');
    expect(clean('\x1b[2Junsafe\x07')).toBe('unsafe');
  });
  test('text chunks coalesce by generation/type, never across hidden boundaries or in raw mode', () => {
    const settings = new Settings();
    const a = event(1, 'agent.message', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello ' } });
    const b = event(2, 'agent.message', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'world' } });
    const groups = chatGroups([a, b], settings);
    expect(groups).toHaveLength(1);
    expect(eventText(groups[0]!)).toBe('Hello world');
    expect(eventText(a)).toBe('Hello '); // Original records remain intact for raw.
    const history = new Store();
    history.ingest(event(20, 'agent.message', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'History **bo' } }), 'history');
    history.ingest(event(21, 'agent.message', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ld** with `code`.' } }), 'history');
    const historyGroup = chatGroups(history.orderedEvents(), settings)[0]!;
    const historyRendered = renderEvent(historyGroup, 3, 80);
    expect(historyRendered).toContain(String.fromCharCode(27) + '[1mbold' + String.fromCharCode(27) + '[0m');
    expect(historyRendered).toContain(String.fromCharCode(27) + '[33mcode' + String.fromCharCode(27) + '[0m');
    expect(chatGroups([a, { ...b, generation: 'g2' }], settings)).toHaveLength(2);
    settings.levels['prompt.started'] = 0;
    expect(chatGroups([a, event(3, 'prompt.started'), b], settings)).toHaveLength(2);
    settings.levels['agent.message'] = 4;
    expect(chatGroups([a, b], settings)).toHaveLength(2);
  });
});
