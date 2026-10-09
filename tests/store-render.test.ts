import { describe, expect, test } from 'bun:test';
import stripAnsi from 'strip-ansi';
import stringWidth from 'string-width';
import { chatGroups, clean, clip, eventText, renderEvent, renderTreeEvent } from '../src/render.js';
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
  test('latest message combines chunks per agent and keeps raw records intact', () => {
    const store = new Store(); const settings = new Settings();
    const chunk = (seq: number, text: string) => event(seq, 'agent.message', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
    store.ingest(chunk(1, 'The complete '));
    store.ingest(event(2, 'agent.message', undefined, { agentId: 'worker' }));
    store.ingest(chunk(3, 'answer'));
    store.ingest(chunk(4, '.'));
    settings.excluded.add('prompt.finished');
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
  test('message summaries respect generation, kind, message ID and hidden boundaries', () => {
    const settings = new Settings(); settings.excluded.add('prompt.started');
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

describe('Markdown tree previews', () => {
  const message = (text: string) => event(1, 'agent.message', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
  test('styles Markdown and folds blocks into one line without an assistant label', () => {
    const rendered = renderTreeEvent(message('# Heading\n\n**bold** and _italic_ with `code`\n\n- item\n\n```ts\nconst x = 1;\n```'), 120);
    expect(rendered).toContain('\x1b[1m');
    expect(rendered).toContain('\x1b[3m');
    expect(rendered).toContain('\x1b[33m');
    expect(rendered.split('\n')).toHaveLength(1);
    const text = stripAnsi(rendered);
    expect(text).toContain('Heading bold and italic with code');
    expect(text).toContain('item');
    expect(text).toContain('const x = 1;');
    expect(text).not.toContain('assistant:');
    expect(text).not.toContain('**');
    expect(text).not.toContain('`');
  });
  test('clips styled text by terminal cells and resets styles at the column boundary', () => {
    const rendered = renderTreeEvent(message('**Hello world**'), 8);
    expect(stripAnsi(rendered)).toBe('Hello w…');
    expect(rendered).toStartWith('\x1b[1mHello w');
    expect(rendered).toEndWith('\x1b[0m…');
    expect(stringWidth(rendered)).toBe(8);
    expect(renderTreeEvent(message('**bold**'), 0)).toBe('');
    expect(stripAnsi(renderTreeEvent(message('**bold**'), 1))).toBe('…');
    for (const text of ['🦊🦊🦊', '👩‍💻👩‍💻👩‍💻', 'e\u0301e\u0301e\u0301']) {
      const preview = renderTreeEvent(message(`**${text}**`), 5);
      expect(stripAnsi(preview)).toBe(clip(text, 5));
      expect(stringWidth(preview)).toBeLessThanOrEqual(5);
    }
  });
  test('renders other event types and sanitizes remote terminal commands before styling', () => {
    const tool = event(1, 'tool.call', { title: '**Search**', status: 'pending' });
    expect(stripAnsi(renderTreeEvent(tool, 80))).toBe('tool.call: Search · pending');
    const rendered = renderTreeEvent(message('\x1b[2J**safe**\x07'), 80);
    expect(stripAnsi(rendered)).toBe('safe');
    expect(rendered).not.toContain('\x1b[2J');
    expect(rendered).not.toContain('\x07');
    expect(stripAnsi(renderTreeEvent(message('[docs](https://example.com)'), 80))).toContain('docs');
    expect(stripAnsi(renderTreeEvent(event(1, 'agent.message', { truncated: true, originalBytes: 1000, preview: '**partial**' }), 80))).toContain('TRUNCATED');
  });
});

describe('four rendering levels', () => {
  const message = event(1, 'agent.message', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '# Heading\n\n**bold** and _italic_\n\n- list entry\n\n```ts\nconst x = 1;\n```\n' } });
  test('summary is one terminal-width-aware line; indentation and Unicode are preserved', () => {
    const summary = renderEvent(message, 1, 24);
    expect(summary.split('\n')).toHaveLength(1);
    expect(stringWidth(summary)).toBeLessThanOrEqual(24);
    expect(summary).toBe('# Heading  **bold** and…');
    expect(summary).not.toContain('assistant:');
    expect(renderEvent(event(2, 'agent.message', { sessionUpdate: 'user_message_chunk', content: { text: 'Hello' } }), 1, 80)).toBe('user: Hello');
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
