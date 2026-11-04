import { expect, test } from 'bun:test';
import { Store } from '../src/store.js';
import type { Agent, ServerEvent, Snapshot } from '../src/protocol.js';
const agent = (generation = 'g1', state = 'idle'): Agent => ({ id: 'a', name: 'agent', parentId: null, state, settings: { harness: 'fixture' }, revision: 1, generation, sessionId: 's1', removedAt: null });
const payload = { version: 1 as const, generation: 'g1', sessionId: 's1', commands: [{ name: 'help', description: 'help' }] };
const snapshot = (seq: number, commands?: any, a = agent()): Snapshot => ({ seq, agents: [a], operations: [], ...(commands ? { capabilities: { agentCommands: { version: 1 } }, agentCommands: { a: commands } } : {}) });
const event = (seq: number, type: string, data: any, generation = 'g1'): ServerEvent => ({ kind: 'event', seq, time: 'now', type, agentId: 'a', generation, data });
test('snapshot state, live replacement and empty clear are authoritative and agent-scoped', () => {
  const store = new Store(); store.install(snapshot(10, payload));
  expect(store.getCommands('a')?.commands).toEqual(payload.commands);
  store.ingest(event(11, 'agent.commands', { ...payload, commands: [{ name: 'new', description: '' }] }));
  expect(store.getCommands('a')?.commands[0]?.name).toBe('new');
  store.ingest(event(12, 'agent.commands', { ...payload, commands: [] }));
  expect(store.getCommands('a')?.commands).toEqual([]);
});
test('generation, session, stop and removal mismatches invalidate live command state', () => {
  const store = new Store(); store.install(snapshot(1, payload));
  store.ingest(event(2, 'agent.state', { state: 'stopped' }));
  expect(store.getCommands('a')).toBeUndefined();
  store.ingest(event(3, 'agent.commands', payload));
  expect(store.getCommands('a')).toBeUndefined();
  store.install(snapshot(4, payload));
  store.ingest(event(5, 'agent.commands', { ...payload, sessionId: 'wrong' }));
  expect(store.getCommands('a')).toBeUndefined();
});
test('post-snapshot invalidation tombstone is not resurrected by a delayed stale snapshot', () => {
  const store = new Store(); store.install(snapshot(5, payload));
  store.ingest(event(8, 'agent.session_replaced', {}));
  store.install(snapshot(6, payload));
  expect(store.getCommands('a')).toBeUndefined();
});
