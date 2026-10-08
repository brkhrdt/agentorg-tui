import { describe, expect, test } from 'bun:test';
import stripAnsi from 'strip-ansi';
import stringWidth from 'string-width';
import { chatGroups, clean, clip, eventText, renderEvent } from '../src/render.js';
import { Settings } from '../src/settings.js';
import { Store } from '../src/store.js';
import { agent, event, operation } from './helpers.js';

describe('state and transcripts', () => {
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
    settings.toggle('agent.state');
    store.ingest(event(3, 'agent.state', { state: 'failed' }, { generation: undefined }));
    expect(store.agents.get('root')!.state).toBe('failed');
    expect(store.agents.get('root')!.generation).toBeNull();
    expect(store.latest(settings).get('root')!.seq).toBe(1);
    store.ingest(event(4, 'plugin.custom', { foo: 'bar' }));
    expect(store.latest(settings).get('root')!.seq).toBe(4);
    expect(settings.types(store.discovered)).toContain('plugin.custom');
    expect(store.transcript('root', settings)).toHaveLength(2);
    settings.toggle('agent.message');
    expect(store.transcript('root', settings)).toHaveLength(1);
  });
  test('late acceptance responses cannot regress terminal operations', () => {
    const store = new Store();
    store.install({ seq: 0, agents: [], operations: [] });
    store.ingest(event(1, 'operation.changed', operation('completed')));
    store.putOperation(operation('queued'));
    expect(store.operations.get('op')!.status).toBe('completed');
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

describe('four rendering levels', () => {
  const message = event(1, 'agent.message', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '# Heading\n\n**bold** and _italic_\n\n- list entry\n\n```ts\nconst x = 1;\n```\n' } });
  test('summary is one terminal-width-aware line; indentation and Unicode are preserved', () => {
    const summary = renderEvent(message, 1, 24);
    expect(summary.split('\n')).toHaveLength(1);
    expect(stringWidth(summary)).toBeLessThanOrEqual(24);
    expect(summary).toEndWith('…');
    expect(clip('  child', 20)).toBe('  child');
    expect(clip('🦊🦊🦊', 5)).toBe('🦊🦊…');
    expect(clip('test', 0)).toBe('');
  });
  test('extended is at most two wrapped lines', () => {
    const extended = renderEvent(message, 2, 20);
    expect(extended.split('\n')).toHaveLength(2);
    for (const line of extended.split('\n')) expect(stringWidth(line)).toBeLessThanOrEqual(20);
    expect(extended).toEndWith('…');
  });
  test('full renders Markdown without dropping text, raw retains the complete wire event', () => {
    const full = renderEvent(message, 3, 80);
    expect(full).toContain('\x1b[');
    expect(stripAnsi(full)).toContain('Heading');
    expect(stripAnsi(full)).toContain('bold');
    expect(stripAnsi(full)).not.toContain('**bold**');
    expect(stripAnsi(full)).toContain('const x = 1;');
    expect(JSON.parse(renderEvent(message, 4, 1000))).toEqual(message);
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
    expect(chatGroups([a, { ...b, generation: 'g2' }], settings)).toHaveLength(2);
    settings.excluded.add('prompt.started');
    expect(chatGroups([a, event(3, 'prompt.started'), b], settings)).toHaveLength(2);
    settings.levels['agent.message'] = 4;
    expect(chatGroups([a, b], settings)).toHaveLength(2);
  });
});
