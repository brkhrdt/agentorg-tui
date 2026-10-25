import { expect, test } from 'bun:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { agent, event, mockServer, respond, send, waitFor } from './helpers.js';
import { terminalClient } from './terminal.js';
import { rawEventJsonLabel } from '../src/ui.js';

function fixtureEvents(count = 3) {
  const rootEvents = Array.from({ length: count }, (_, i) => {
    const ordinal = i + 1, seq = ordinal === 1 ? 1 : ordinal + 1;
    return event(seq, ordinal === 2 ? 'agent.state' : 'agent.message', {
      sessionUpdate: 'agent_message_chunk', messageId: `m${seq}`,
      content: { type: 'text', text: `ROOT_PAYLOAD_${seq}` },
      nested: { seq, values: [true, false, 'λ'] },
    }, { agentId: 'root', generation: 'g1' });
  });
  return [...rootEvents, event(2, 'agent.message', { content: { type: 'text', text: 'CHILD_ONLY_PAYLOAD' } }, { agentId: 'child', generation: 'g2' })];
}

async function startDemo(initial = fixtureEvents(), hiddenTypes?: string[], size = { cols: 120, rows: 26 }) {
  let history = [...initial];
  const requests: any[] = [];
  const mock = await mockServer((socket, request) => {
    requests.push(request);
    if (request.method === 'organization.snapshot') {
      const latest = Math.max(0, ...history.map(item => item.seq));
      respond(socket, request.id, { seq: latest, agents: [agent('root'), agent('child', 'root')], operations: [] });
    } else if (request.method === 'events.history') {
      const before = request.params?.before ?? Infinity;
      const after = request.params?.after ?? 0;
      const matching = history.filter(item => item.seq < before && item.seq > after && (!request.params?.agentId || item.agentId === request.params.agentId));
      respond(socket, request.id, {
        events: matching.slice(-Math.min(request.params?.limit ?? 200, 200)),
        oldestSeq: Math.min(...history.map(item => item.seq), 0), latestSeq: Math.max(...history.map(item => item.seq), 0),
        expired: false, hasMore: false,
      });
    }
  });
  if (hiddenTypes) await writeFile(join(mock.directory, 'config.json'), JSON.stringify({ levels: Object.fromEntries(hiddenTypes.map(type => [type, 0])), tableFields: ['name'], compactToolCalls: false }));
  const tui = terminalClient(mock.path, mock.directory, size);
  await tui.visible('root');
  await tui.visible('connected');
  await tui.visible('z raw events');
  return {
    mock, tui, requests,
    addHistory(item: ReturnType<typeof event>) { history = [...history, item]; for (const socket of mock.sockets) send(socket, item); },
    historyRequests() { return requests.filter(request => request.method === 'events.history').length; },
    async close() { await tui.close(); await mock.close(); },
  };
}

async function openLoadedChat(demo: Awaited<ReturnType<typeof startDemo>>) {
  demo.tui.keys('c');
  await demo.tui.visible('Chat · root');
  await waitFor(() => ['ROOT_PAYLOAD_', 'FIRST_SNAPSHOT', 'badTYPE', 'No visible events yet.'].some(marker => demo.tui.screen().includes(marker)));
  demo.tui.keys('\x1b');
  await demo.tui.visible('z raw events');
}

test('raw list navigates a selected-agent loaded snapshot and preserves visible list origin through JSON', async () => {
  const demo = await startDemo(fixtureEvents(32));
  try {
    await openLoadedChat(demo);
    const beforeViewer = demo.historyRequests();
    demo.tui.keys('z');
    await demo.tui.visible('› 1');
    const firstPageSeqs = demo.tui.screen().split('\n')
      .filter(line => /│[› ]*\d+ · 2026-10-08/.test(line))
      .map(line => Number(line.match(/│[› ]*(\d+) ·/)?.[1]));
    expect(firstPageSeqs).not.toContain(2); // visible-range child event is agent-scoped out
    expect(firstPageSeqs).not.toContain(3); // root agent.state is chat-filtered
    demo.tui.keys('\x1b[B'); await demo.tui.visible('› 4');
    demo.tui.keys('a'); // No raw-view bypass can reveal level-zero events.
    await demo.tui.visible('› 4');
    expect(demo.tui.screen().split('\n').some(line => /│[› ]*3 · 2026-10-08/.test(line))).toBe(false);
    const allCount = demo.historyRequests();
    expect(allCount).toBe(beforeViewer);
    demo.tui.keys('\x1b[B'.repeat(18));
    await demo.tui.visible('› 22');
    const beforeRows = demo.tui.screen().split('\n').filter(line => line.includes('2026-10-08'));
    expect(beforeRows.length).toBeGreaterThan(1);
    demo.tui.keys('\r');
    await demo.tui.visible('Event JSON');
    await demo.tui.visible('"seq": 22');
    demo.tui.keys('\x1b');
    await demo.tui.visible('Raw events · visible events');
    await demo.tui.visible('› 22');
    const afterRows = demo.tui.screen().split('\n').filter(line => line.includes('2026-10-08'));
    expect(afterRows).toEqual(beforeRows);
    demo.tui.keys('\x1b'); await demo.tui.visible('z raw events');
    demo.tui.keys('\x1b'); await demo.tui.visible('AGENT');
    demo.tui.keys('\x1b[B');
    demo.tui.keys('c'); await demo.tui.visible('Chat · root / child');
    await demo.tui.visible('CHILD_ONLY_PAYLOAD');
    demo.tui.keys('\x1b'); await demo.tui.visible('z raw events');
    demo.tui.keys('z'); await demo.tui.visible('› 2');
    demo.tui.keys('\r'); await demo.tui.visible('"agentId": "child"');
    await demo.tui.visible('"seq": 2');
  } finally { await demo.close(); }
}, 20_000);

test('JSON exposes complete escaped payloads safely and sanitizes hostile event labels', async () => {
  const hostile = event(1, 'bad\x1b[31mTYPE\x7f', { text: `controls \x7f\x80\x9f \x1b[31mRED`, deep: { array: [1, 2, 'é'] } }, { agentId: 'root' });
  const demo = await startDemo([hostile]);
  try {
    await openLoadedChat(demo);
    demo.tui.keys('z'); await demo.tui.visible('badTYPE');
    demo.tui.keys('\r'); await demo.tui.visible('Event JSON');
    await demo.tui.visible('controls \\u007f\\u0080\\u009f');
    await demo.tui.visible('\\u001b[31mRED');
    await demo.tui.visible('"array": [');
    const displayedJson: string[] = [];
    let inJson = false, depth = 0;
    for (const line of demo.tui.screen().split('\n')) {
      if (!line.startsWith('│')) continue;
      const content = line.slice(1).replace(/\s*│$/, '');
      if (!inJson && content.trim() === '{') inJson = true;
      if (inJson) {
        displayedJson.push(content);
        depth += (content.match(/{/g) ?? []).length - (content.match(/}/g) ?? []).length;
        if (depth === 0) break;
      }
    }
    expect(JSON.parse(displayedJson.join('\n'))).toEqual(hostile);
    expect(rawEventJsonLabel(hostile.type, 120)).toBe(' Event JSON · badTYPE ');
    expect(rawEventJsonLabel(hostile.type, 120)).not.toContain('\x1b');
    demo.tui.keys('a'); // inert in JSON mode
    expect(demo.tui.screen()).toContain('Event JSON');
    demo.tui.keys('\x1b'); await demo.tui.visible('› 1');
  } finally { await demo.close(); }
}, 15_000);

test('level-zero snapshots stay empty even when pressing the removed raw filter key', async () => {
  const events = [event(1, 'agent.state', { payload: 'FILTERED_ONE' }, { agentId: 'root' }), event(2, 'agent.error', { payload: 'FILTERED_TWO' }, { agentId: 'root' })];
  const demo = await startDemo(events, ['agent.state', 'agent.error']);
  try {
    await openLoadedChat(demo);
    demo.tui.keys('z'); await demo.tui.visible('No events in this loaded history window.');
    const before = demo.historyRequests();
    demo.tui.keys('a');
    await demo.tui.visible('No events in this loaded history window.');
    expect(demo.tui.screen()).not.toContain('FILTERED_ONE');
    expect(demo.tui.screen()).not.toContain('FILTERED_TWO');
    expect(demo.historyRequests()).toBe(before);
    demo.tui.keys('\r'); // empty list has no selection
    expect(demo.tui.screen()).toContain('No events in this loaded history window.');
  } finally { await demo.close(); }
}, 15_000);

test('an open snapshot ignores live arrivals; reopening after chat reload captures them', async () => {
  const demo = await startDemo([event(1, 'agent.message', { content: { type: 'text', text: 'FIRST_SNAPSHOT' } }, { agentId: 'root' })]);
  try {
    await openLoadedChat(demo);
    demo.tui.keys('z'); await demo.tui.visible('FIRST_SNAPSHOT');
    const before = demo.historyRequests();
    const arrival = event(2, 'agent.message', { content: { type: 'text', text: 'ARRIVED_LATER' } }, { agentId: 'root' });
    demo.addHistory(arrival);
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(demo.tui.screen()).not.toContain('ARRIVED_LATER');
    expect(demo.historyRequests()).toBe(before);
    demo.tui.keys('\x1b'); await demo.tui.visible('z raw events');
    demo.tui.keys('c'); await demo.tui.visible('Chat · root'); await demo.tui.visible('ARRIVED_LATER');
    demo.tui.keys('\x1b'); await demo.tui.visible('z raw events');
    demo.tui.keys('z'); await demo.tui.visible('ARRIVED_LATER');
  } finally { await demo.close(); }
}, 20_000);

test('z opens safely with an empty loaded chat window', async () => {
  const demo = await startDemo([]);
  try {
    demo.tui.keys('z'); await demo.tui.visible('No events in this loaded history window.');
    demo.tui.keys('a'); demo.tui.keys('\r');
    expect(demo.tui.screen()).toContain('Raw events');
    demo.tui.keys('\x1b'); await demo.tui.visible('AGENT');
  } finally { await demo.close(); }
}, 15_000);
