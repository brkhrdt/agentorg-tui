import { expect, test } from 'vitest';
import { Store } from '../src/store.js';
import { UI } from '../src/ui.js';
import { agent } from './helpers.js';

test('tree context actions wire wrapped Right through the visible projection without changing folds', () => {
  const store = new Store();
  store.install({ seq: 0, agents: [
    agent('root'), agent('a', 'root'), agent('a-hidden', 'a'), agent('b', 'root'), agent('next-root'),
  ], operations: [] });
  const folds = new Set(['a']);
  let draws = 0;
  const ui = Object.create(UI.prototype) as any;
  Object.assign(ui, { session: { store }, view: 'tree', selectedAgent: 'b', collapsedAgentIds: folds, draw: () => { draws++; } });
  const action = (key: string) => ui.contextActions().find((item: any) => item.key === key);

  expect(action('right').label).toContain('wrap');
  action('right').run();
  expect(ui.selectedAgent).toBe('a');
  expect([...folds]).toEqual(['a']);
  expect(draws).toBe(1);
  action('right').run();
  expect(ui.selectedAgent).toBe('b');
  action('left').run();
  expect(ui.selectedAgent).toBe('root');
  expect([...folds]).toEqual(['a']);
  ui.selectedAgent = 'a';
  action('tab').run();
  expect([...folds]).toEqual([]);
  expect(draws).toBe(4);

  ui.selectedAgent = 'next-root';
  action('right').run();
  expect(ui.selectedAgent).toBe('root');
  folds.add('a');
  ui.selectedAgent = 'a-hidden';
  const before = draws;
  action('right').run();
  expect(ui.selectedAgent).toBe('a-hidden');
  expect(draws).toBe(before);
  ui.selectedAgent = 'missing';
  action('right').run();
  expect(draws).toBe(before);
});

test('tree navigation is inactive outside tree while other views retain their Right actions', () => {
  const store = new Store();
  store.install({ seq: 0, agents: [agent('root'), agent('sibling')], operations: [] });
  let draws = 0;
  const ui = Object.create(UI.prototype) as any;
  Object.assign(ui, { session: { store }, view: 'colors', selectedAgent: 'root', collapsedAgentIds: new Set<string>(), draw: () => { draws++; } });
  ui.navigateTreeArrow('right');
  expect(ui.selectedAgent).toBe('root');
  expect(draws).toBe(0);
  expect(ui.contextActions().find((item: any) => item.key === 'right').label).toBe('Next color');
  ui.view = 'table-fields';
  expect(ui.contextActions().find((item: any) => item.key === 'right').label).toBe('Move field later');
  ui.view = 'prompt';
  expect(ui.contextActions().some((item: any) => item.key === 'right')).toBe(false);
});
