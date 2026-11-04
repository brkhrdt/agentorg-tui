import { expect, test } from 'bun:test';
import { agentSearchChoices, matchAgentSearchChoices } from '../src/agent-search.js';
import { agent } from './helpers.js';

const rows = [
  { agent: agent('root'), depth: 0 },
  { agent: agent('agent1', 'root'), depth: 1 },
  { agent: agent('agent2', 'agent1'), depth: 2 },
  { agent: agent('child', 'agent2'), depth: 3 },
  { agent: agent('other'), depth: 0 },
  { agent: agent('child2', 'other', { name: 'child' }), depth: 1 },
];

test('search choices retain distinct IDs and show full ancestry', () => {
  const choices = agentSearchChoices(rows);
  expect(choices.map(choice => choice.path)).toEqual([
    'root', 'root / agent1', 'root / agent1 / agent2', 'root / agent1 / agent2 / child', 'other', 'other / child',
  ]);
  expect(choices[3]?.ancestorIds).toEqual(['root', 'agent1', 'agent2']);
  expect(choices[3]?.agentId).not.toBe(choices[5]?.agentId);
});

test('each whitespace-separated term independently fuzzy-matches full ancestry', () => {
  const choices = agentSearchChoices(rows);
  for (const query of ['1 chi', 'chi 1', 'CHI   1']) expect(matchAgentSearchChoices(choices, query).map(item => item.agentId)).toContain('child');
  expect(matchAgentSearchChoices(choices, '1 absent')).toEqual([]);
  expect(matchAgentSearchChoices(choices, '  ').map(item => item.agentId)).toEqual(choices.map(item => item.agentId));
});
