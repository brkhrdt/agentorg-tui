import { expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import stripAnsi from 'strip-ansi';
import stringWidth from 'string-width';
import { eventText, renderEvent, renderTreeEvent, chatGroups } from '../src/render.js';
import { renderTable } from '../src/table.js';
import { rendererPreview } from '../src/renderer-preview.js';
import { Settings } from '../src/settings.js';
import { Store } from '../src/store.js';
import { Session } from '../src/session.js';
import type { EventRendering, RendererMetadata } from '../src/protocol.js';
import { terminalClient } from './terminal.js';
import { agent, event, mockServer, respond, send, waitFor } from './helpers.js';

const raw = event(1, 'tool.result', { title: 'read', status: 'completed', rawInput: { path: 'src/main.ts' }, rawOutput: 'ORIGINAL OUTPUT' });
const rendering: EventRendering = { rendererId: 'pi/read', subtype: 'read', summary: '\\< src/main.ts', extended: '\\< src/main.ts\n2 lines', full: '\\< src/main.ts\n\n**Custom read complete**\n\n```ts\nconst answer = 42;\n```' };
const metadata: RendererMetadata = { id: 'pi/read', name: 'Pi read', harness: 'pi', eventTypes: ['tool.result'], tool: 'read', examples: [{ type: 'tool.result', ...rendering, raw: JSON.stringify(raw, null, 2) }] };

test('compaction lifecycle has visible start and completion renderings', () => {
  const start = event(1, 'agent.compaction', { phase: 'start', reason: 'manual' });
  const end = event(2, 'agent.compaction', { phase: 'end', reason: 'manual', tokensBefore: 24195, estimatedTokensAfter: 19993 });
  expect(new Settings().level('agent.compaction')).toBe(3);
  expect(eventText(start)).toBe('Compacting context (manual).');
  expect(stripAnsi(renderEvent(start, 1, 120))).toBe('COMPACTING — Compacting context (manual).');
  expect(stripAnsi(renderTreeEvent(start, 120))).toBe('COMPACTING — Compacting context (manual).');
  expect(stripAnsi(renderEvent(end, 1, 120))).toBe('COMPACTION COMPLETE — Context compacted (24,195 → 19,993 estimated tokens).');
});

test('compaction start is replaced by completion when lifecycle compaction is enabled', () => {
  const start = event(1, 'agent.compaction', { compactionId: 'compact-1', phase: 'start', reason: 'manual' });
  const end = event(2, 'agent.compaction', { compactionId: 'compact-1', phase: 'end', reason: 'manual', tokensBefore: 24195, estimatedTokensAfter: 19993 });
  const settings = new Settings();
  expect(chatGroups([start, end], settings).map(item => item.data)).toEqual([start.data, end.data]);
  settings.compactToolCalls = true;
  expect(chatGroups([start, end], settings)).toEqual([end]);
  settings.levels['agent.compaction'] = 4;
  expect(chatGroups([start, end], settings)).toEqual([start, end]);
});

test('steering phases use tool lifecycle colors and compact to latest state when enabled', () => {
  const submitted = event(1, 'prompt.steer_submitted', { steeringId: 'steer-1', operationId: 'op-1', text: 'Return 5' });
  const pending = event(2, 'prompt.steer_pending', { steeringId: 'steer-1', operationId: 'op-1', text: 'Return 5' });
  const delivered = event(3, 'prompt.steer_delivered', { steeringId: 'steer-1', operationId: 'op-1', text: 'Return 5' });
  const failed = event(4, 'prompt.steer_failed', { steeringId: 'steer-2', operationId: 'op-1', text: 'Try again', error: { code: 'NOT_DELIVERED', message: 'queue cleared' } });
  const settings = new Settings();
  expect(renderEvent(submitted, 1, 100)).toStartWith('\x1b[33mYOU · STEER');
  expect(renderEvent(pending, 1, 100)).toStartWith('\x1b[38;5;208mYOU · STEER');
  expect(renderTreeEvent(pending, 100)).toStartWith('\x1b[38;5;208mYOU · STEER');
  expect(stripAnsi(renderEvent(pending, 1, 100))).toBe('YOU · STEER — Return 5');
  expect(renderEvent(delivered, 1, 100)).toStartWith('\x1b[32mYOU · STEER');
  expect(renderEvent(failed, 1, 100)).toStartWith('\x1b[31mYOU · STEER');
  expect(stripAnsi(renderEvent(failed, 1, 100))).toContain('queue cleared');
  expect(chatGroups([submitted, pending, delivered, failed], settings).map(item => item.type)).toEqual([
    'prompt.steer_submitted', 'prompt.steer_pending', 'prompt.steer_delivered', 'prompt.steer_failed',
  ]);
  settings.compactToolCalls = true;
  expect(chatGroups([submitted, pending, delivered, failed], settings).map(item => item.type)).toEqual([
    'prompt.steer_delivered', 'prompt.steer_failed',
  ]);
});

test('hidden compact steering terminal phases close correlation without hiding the latest visible phase', () => {
  const settings = new Settings(); settings.compactToolCalls = true;
  settings.levels['prompt.steer_delivered'] = 0;
  const submitted = event(1, 'prompt.steer_submitted', { steeringId: 'steer', text: 'help' });
  const pending = event(2, 'prompt.steer_pending', { steeringId: 'steer', text: 'help' });
  const hiddenTerminal = event(3, 'prompt.steer_delivered', { steeringId: 'steer', text: 'help' });
  const latePending = event(4, 'prompt.steer_pending', { steeringId: 'steer', text: 'help' });
  expect(chatGroups([submitted, pending, hiddenTerminal, latePending], settings).map(item => item.seq)).toEqual([2, 4]);
});

test('server Markdown controls content, client controls styles/cell limits and raw ignores presentations', () => {
  const summary = renderTreeEvent(raw, 32, rendering);
  expect(stripAnsi(summary)).toBe('< src/main.ts');
  expect(summary).toStartWith('\x1b[32m<\x1b[0m src/main.ts');
  expect(summary).not.toContain('\x1b[1m');
  expect(summary.split('\n')).toHaveLength(1);
  expect(stringWidth(summary)).toBeLessThanOrEqual(32);
  expect(renderEvent(raw, 1, 32, rendering)).toBe(summary);
  const extended = stripAnsi(renderEvent(raw, 2, 80, rendering));
  expect(extended.split('\n')).toHaveLength(2);
  expect(extended).toContain('2 lines');
  const narrowExtended = renderEvent(raw, 2, 10, rendering);
  expect(narrowExtended.split('\n')).toHaveLength(2);
  expect(narrowExtended).toEndWith('…');
  const full = stripAnsi(renderEvent(raw, 3, 80, rendering));
  expect(full).toContain('Custom read complete'); expect(full).toContain('const answer = 42;');
  expect(JSON.parse(renderEvent(raw, 4, 10000, rendering))).toEqual(raw);
  const hostile = { ...rendering, summary: '\x1b[2J**safe**\x07\nunsafe second line', extended: 'one\ntwo\nthird', full: '\x1b]0;remote title\x07**safe**\x1b[2J' };
  expect(stripAnsi(renderTreeEvent(raw, 80, hostile))).toContain('safe');
  expect(renderTreeEvent(raw, 80, hostile)).not.toContain('unsafe second line');
  expect(renderEvent(raw, 2, 80, hostile)).not.toContain('third');
  expect(renderEvent(raw, 3, 80, hostile)).not.toContain('\x1b[2J');
  expect(renderEvent(raw, 3, 80, hostile)).not.toContain('\x1b]0;');
});

test('extended output truncates wrapped overflow with an ellipsis after two terminal rows', () => {
  const e = event(1, 'agent.message', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ignored' } });
  const longSecondRow = 'second '.repeat(10);
  const presentation: EventRendering = { rendererId: 'fixture', summary: 'short', extended: `short\n${longSecondRow}`, full: 'short' };
  const rendered = stripAnsi(renderEvent(e, 2, 20, presentation));
  expect(rendered.split('\n')).toHaveLength(2);
  expect(rendered).toEndWith('…');
  for (const row of rendered.split('\n')) expect(stringWidth(row)).toBeLessThanOrEqual(20);
});

test('MCP update previews preserve semantic renderer details instead of replacing them with rolling output', () => {
  const update = event(1, 'tool.update', { title: 'wait_operation', status: 'in_progress', rawInput: { operationId: 'op-1' }, rawOutput: { status: 'running', progress: 3 } });
  const presentation: EventRendering = { rendererId: 'core.tools', subtype: 'wait_operation', updateMode: 'semantic', extendedLayout: 'header-detail', summary: '• Wait operation op-1', extended: `• Wait operation op-1\nstatus running · 3 steps`, full: `• Wait operation op-1\n\nstatus running · 3 steps` };
  expect(stripAnsi(renderEvent(update, 2, 80, presentation))).toContain('status running · 3 steps');
  expect(stripAnsi(renderEvent(update, 3, 80, presentation))).toContain('status running · 3 steps');
  const narrow = stripAnsi(renderEvent(update, 2, 12, { ...presentation, summary: '• Wait operation with an exceptionally long operation identifier', extended: `• Wait operation with an exceptionally long operation identifier\nterminal status: stopped` }));
  expect(narrow.split('\n')[1]).toContain('terminal');
  for (const width of [1, 2, 3, 5, 6, 12, 20, 23, 24, 25]) {
    const result = stripAnsi(renderEvent(update, 2, width, { ...presentation, summary: '• Wait operation ' + 'x'.repeat(80), extended: `• Wait operation ${'x'.repeat(80)}\nstopped · returned status` })).split('\n');
    expect(result).toHaveLength(2);
    if (width >= 8) expect(result[1]).toContain('stopped');
    for (const row of result) expect(stringWidth(row)).toBeLessThanOrEqual(width);
  }
});

test('tool updates show the latest output row in extended and five rows in full', () => {
  const update = event(1, 'tool.update', { title: 'bash', status: 'in_progress', rawInput: { command: 'long-running' }, rawOutput: { content: [{ type: 'text', text: 'one\ntwo\nthree\nfour\nfive\nsix' }], details: {} } });
  const presentation: EventRendering = { rendererId: 'core.tools', summary: '$ long-running', extended: '$ long-running\nsix', full: '$ long-running\n\n```\none\ntwo\nthree\nfour\nfive\nsix\n```' };
  const extended = stripAnsi(renderEvent(update, 2, 80, presentation));
  expect(extended).toContain('6 lines received');
  expect(extended).toContain('six');
  expect(extended).not.toContain('five');
  const renderedFull = renderEvent(update, 3, 80, presentation);
  const full = stripAnsi(renderedFull);
  expect(full).toContain('6 lines received');
  expect(full).toContain('two'); expect(full).toContain('three'); expect(full).toContain('four');
  expect(full).toContain('five'); expect(full).toContain('six');
  expect(full).not.toContain('one');
  expect(full).toContain('showing last 5 rows');
  expect(full).toContain('  │ two');
  expect(renderedFull.split('\n')[1]).toStartWith('\x1b[38;5;250m6 lines received');
  expect(renderedFull).toContain('\x1b[38;5;250m  │ \x1b[0m');
  expect(renderedFull).not.toContain('\x1b[47;30m');
});

test('rolling output is bounded after wrapping, stays literal and fits narrow Unicode terminals', () => {
  const update = event(1, 'tool.update', { title: 'bash', rawInput: { command: 'a long command that wraps' }, rawOutput: `OLD OUTPUT\n${'文件🦊 é '.repeat(80)}LATEST` });
  for (const width of [1, 2, 3, 5, 6, 12, 40, 80]) {
    for (const [level, maxRows] of [[2, 1], [3, 5]] as const) {
      const rendered = renderEvent(update, level, width);
      const lines = stripAnsi(rendered).split('\n');
      // Wrapped header, one clipped metadata row, then the bounded output viewport.
      const header = stripAnsi(renderEvent(update, 1, 1000));
      const expectedHeaderRows = Math.ceil(stringWidth(header) / width);
      expect(lines.length).toBeLessThanOrEqual(level === 2 ? 2 : expectedHeaderRows + 1 + maxRows);
      for (const line of lines) expect(stringWidth(line)).toBeLessThanOrEqual(width);
      expect(rendered).not.toContain('OLD OUTPUT');
      if (width >= 12) expect(rendered).toContain('LATEST');
      expect(rendered).not.toContain('�');
    }
  }
  const literal = event(2, 'tool.update', { title: 'bash', rawOutput: '**not bold**\n  indented\n\n```ts\n{blessed}' });
  const rendered = renderEvent(literal, 3, 80);
  expect(stripAnsi(rendered).split('\n').slice(2)).toEqual(['  │ **not bold**', '  │   indented', '  │ ', '  │ ```ts', '  │ {blessed}']);
  expect(rendered).not.toContain('\x1b[1m');
});

test('updates without output retain renderer details instead of inventing received lines', () => {
  const update = event(1, 'tool.update', { title: 'custom', status: 'in_progress' });
  const presentation: EventRendering = { rendererId: 'custom', summary: '• custom', extended: '• custom\n**Waiting for approval**', full: '• custom\n\n**Custom progress**' };
  expect(stripAnsi(renderEvent(update, 2, 80, presentation))).toBe('• custom\nWaiting for approval');
  expect(stripAnsi(renderEvent(update, 3, 80, presentation))).toContain('Custom progress');
  for (const level of [2, 3] as const) {
    expect(stripAnsi(renderEvent(update, level, 80))).not.toContain('lines received');
    const empty = { ...update, data: { ...update.data as object, rawOutput: '' } };
    expect(stripAnsi(renderEvent(empty, level, 80))).toContain('0 lines received');
    expect(stripAnsi(renderEvent(empty, level, 80))).not.toContain('1 line received');
  }
});

test('update output normalizes line endings before removing unsafe terminal commands', () => {
  const update = event(1, 'tool.update', { title: 'bash', rawOutput: '\x1b]0;bad\x07one\r\ntwo\rthree\u2028four\u2029five\n' });
  const rendered = renderEvent(update, 3, 80);
  expect(stripAnsi(rendered)).toContain('5 lines received');
  for (const line of ['one', 'two', 'three', 'four', 'five']) expect(stripAnsi(rendered)).toContain(line);
  expect(rendered).not.toContain('\x1b]0;');
});

test('only tool symbols use lifecycle colors; commands, filenames and output stay plain', () => {
  const presentation: EventRendering = { rendererId: 'core.tools', summary: '$ echo hello', extended: '$ echo hello\nhello', full: '$ echo hello\n\n```\nhello\n```' };
  for (const [type, status, color] of [['tool.call', 'pending', '33'], ['tool.update', 'in_progress', '38;5;208'], ['tool.result', 'completed', '32'], ['tool.result', 'failed', '31'], ['tool.result', 'cancelled', '31'], ['tool.result', undefined, '90']]) {
    const e = event(1, type, { title: 'bash', status });
    for (const level of [1, 2, 3] as const) {
      const rendered = renderEvent(e, level, 80, presentation);
      expect(rendered).toStartWith(`\x1b[${color}m$\x1b[0m echo hello`);
      expect(stripAnsi(rendered)).not.toContain(type! + ':');
      expect(stripAnsi(rendered)).not.toContain('pending');
      if (level === 2 && type !== 'tool.update') expect(rendered.split('\n')[1]).toBe('hello');
    }
    expect(renderTreeEvent(e, 80, presentation)).toStartWith(`\x1b[${color}m$\x1b[0m echo hello`);
    expect(JSON.parse(renderEvent(e, 4, 10000, presentation))).toEqual(e);
  }
  for (const rawOutput of [{ isError: true }, { structuredContent: { exit_code: 7 } }, { content: [{ type: 'text', text: 'exit code: 2' }] }]) {
    expect(renderTreeEvent(event(1, 'tool.result', { title: 'bash', status: 'completed', rawOutput }), 80, presentation)).toStartWith('\x1b[31m');
  }
  for (const [tool, symbol] of [['bash', '$'], ['read', '<'], ['write', '>'], ['edit', 'Δ'], ['mcp__agentorg__create_subagent', '• mcp__agentorg__create_subagent']]) {
    const e = event(1, 'tool.call', { title: tool, status: 'pending', rawInput: { path: 'a.ts', command: 'echo hello' } });
    const rendered = renderEvent(e, 1, 100);
    expect(stripAnsi(rendered)).toStartWith(symbol!);
    expect(rendered).toStartWith(`\x1b[33m${symbol![0]}\x1b[0m `);
    expect(stripAnsi(renderEvent(e, 3, 100))).not.toContain('tool.call');
    expect(stripAnsi(renderEvent(e, 3, 100))).not.toContain('pending');
  }
});

test('AgentOrg tools use the triangle marker and prompt targets get an independent configurable accent', () => {
  const target = '@child-7';
  const presentation: EventRendering = { rendererId: 'core.mcp-prompt-subagent', subtype: 'mcp__agentorg__prompt_subagent', summary: `${target} Review this change`, extended: `${target} Review this change\nReturned status: queued`, full: `${target} Review this change\n\nTool: prompt_subagent`, toolSymbol: '∴', toolTarget: target, extendedLayout: 'header-detail' };
  for (const [type, status, lifecycleColor] of [['tool.call', 'pending', '33'], ['tool.update', 'in_progress', '38;5;208'], ['tool.result', 'completed', '32']]) {
    const e = event(1, type, { title: 'mcp__agentorg__prompt_subagent', status });
    for (const level of [1, 2, 3] as const) {
      const text = renderEvent(e, level, 100, presentation, { agentTarget: 'magenta' });
      expect(text).toStartWith(`\x1b[${lifecycleColor}m∴\x1b[0m \x1b[35m${target}\x1b[0m Review this change`);
      if (level < 3) expect(stripAnsi(text)).not.toContain('prompt_subagent');
    }
    expect(stripAnsi(renderEvent(e, 4, 100, presentation))).toContain('mcp__agentorg__prompt_subagent');
  }
});

test('get_operation uses generic operation details and highlights the associated agent name', () => {
  const e = event(1, 'tool.result', { title: 'mcp__agentorg__get_operation', status: 'completed' });
  const presentation: EventRendering = {
    rendererId: 'core.mcp-get-operation', subtype: 'mcp__agentorg__get_operation',
    summary: 'Inspect operation · op-1 · Reviewer',
    extended: 'Inspect operation · op-1 · Reviewer\nAgent: Reviewer · Operation type: agent.prompt',
    full: 'Inspect operation · op-1 · Reviewer\n\nAgent: Reviewer\nOperation type: agent.prompt',
    toolSymbol: '∴', toolTargets: ['Reviewer'], extendedLayout: 'header-detail',
  };
  for (const level of [1, 2, 3] as const) {
    const text = renderEvent(e, level, 100, presentation, { agentTarget: 'magenta' });
    expect(text).toContain('\x1b[35mReviewer\x1b[0m');
    expect(text).not.toContain('@Coordinator');
  }
  expect(stripAnsi(renderEvent(e, 2, 100, presentation)).split('\n')).toEqual([
    '∴ Inspect operation · op-1 · Reviewer',
    'Agent: Reviewer · Operation type: agent.prompt',
  ]);
});

test('completion lifecycle events render named receipt and review progress', () => {
  const ready = event(1, 'completion.ready', { childNames: ['Reviewer'], childCount: 1, operationCount: 1 });
  expect(eventText(ready)).toBe('Message received from Reviewer.');
  expect(eventText(event(6, 'completion.ready', { operationCount: 1 }))).toBe('Message received.');
  expect(eventText(event(7, 'completion.ready', { operationCount: 2 }))).toBe('Messages received.');
  expect(renderEvent(ready, 3, 100)).toContain('\x1b[1;36m∴\x1b[0m');
  expect(stripAnsi(renderEvent(ready, 3, 100))).toContain('Message received from Reviewer.');
  const multiple = event(2, 'completion.ready', { childNames: ['Coder', 'Tester'], childCount: 2, operationCount: 2 });
  expect(eventText(multiple)).toBe('Messages received from Coder and Tester.');
  const duplicateNames = event(8, 'completion.ready', { childNames: ['Reviewer', 'Reviewer'], childCount: 2, operationCount: 2 });
  expect(eventText(duplicateNames)).toBe('Messages received from 2 child agents named Reviewer.');
  const partialNames = event(9, 'completion.ready', { childNames: [...Array(8).fill('Reviewer'), 'Other'], childCount: 9, operationCount: 9 });
  expect(eventText(partialNames)).toBe('Messages received from Reviewer, Reviewer, Reviewer, Reviewer, Reviewer, Reviewer, Reviewer, Reviewer and 1 more.');
  const started = event(3, 'completion.dispatch_started', { batchId: 'batch' });
  expect(eventText(started)).toBe('Reviewing messages...');
  const renderedStarted = renderEvent(started, 3, 100);
  expect(renderedStarted).toContain('\x1b[1;36m∴\x1b[0m');
  expect(stripAnsi(renderedStarted)).toContain('∴ Reviewing messages...');
  expect(stripAnsi(renderedStarted)).not.toContain('completion.dispatch_started');
  expect(stripAnsi(renderTreeEvent(started, 100))).toBe('∴ Reviewing messages...');
  expect(eventText(event(4, 'completion.dispatch_finished', { status: 'completed' }))).toBe('Done reviewing messages.');
  expect(eventText(event(5, 'completion.dispatch_finished', { status: 'failed' }))).toBe('Done reviewing messages (failed).');
});

test('sender-attributed prompt tool tree previews retain the sender, receiver, and bounded body', () => {
  for (const tool of ['prompt_subagent', 'prompt_parent']) {
    const target = tool === 'prompt_parent' ? '@Coordinator' : '@Researcher';
    const prompt = '**Review this** and inspect `the code`.';
    const e = event(1, 'tool.call', { title: `mcp__agentorg__${tool}`, status: 'pending' });
    const rendering: EventRendering = {
      rendererId: `core.mcp-${tool}`, subtype: `mcp__agentorg__${tool}`,
      summary: `Sender: ${target} ${prompt}`, extended: `Sender: ${target} ${prompt}`, full: `Sender: ${target} ${prompt}`,
      toolSymbol: '∴', toolTarget: target, toolSender: 'Sender', toolPrompt: prompt,
    };
    const store = new Store();
    store.install({ seq: 0, agents: [agent('root')], operations: [] });
    store.ingest(e);
    store.present(e.seq, rendering);
    const compacted = store.treeRenderings().get(e.seq)!;
    expect(compacted.toolPrompt).toBe(prompt);
    const tree = renderTreeEvent(e, 100, compacted, { agentTarget: 'magenta' });
    expect(stripAnsi(tree)).toBe(`∴ Sender: ${target} Review this and inspect the code.`);
    expect(tree).toContain('\x1b[33m∴\x1b[0m');
    expect(tree).toContain('\x1b[1mReview this\x1b[0m');
    expect(tree).toContain('\x1b[33mthe code\x1b[0m');
    expect(tree).toContain('\x1b[35mSender: \x1b[0m\x1b[35m' + target + '\x1b[0m');
    expect(stringWidth(stripAnsi(tree))).toBeLessThanOrEqual(100);
  }
});

test('sender attribution remains visible when Markdown body has no rendered rows', () => {
  for (const tool of ['prompt_subagent', 'prompt_parent']) for (const prompt of ['   ', '[docs]: https://example.com']) {
    const target = tool === 'prompt_parent' ? '@Coordinator' : '@Researcher';
    const e = event(1, 'tool.call', { title: `mcp__agentorg__${tool}`, status: 'pending' });
    const presentation: EventRendering = {
      rendererId: `core.mcp-${tool}`, subtype: `mcp__agentorg__${tool}`,
      summary: `Sender: ${target} ${prompt}`, extended: `Sender: ${target} ${prompt}`, full: `Sender: ${target} ${prompt}`,
      toolSymbol: '∴', toolTarget: target, toolSender: 'Sender', toolPrompt: prompt,
    };
    for (const level of [2, 3] as const) {
      const rendered = renderEvent(e, level, 100, presentation, { agentTarget: 'magenta' });
      expect(stripAnsi(rendered)).toContain(`Sender: ${target}`);
      expect(rendered).toContain(`\x1b[35mSender: \x1b[0m\x1b[35m${target}\x1b[0m`);
    }
  }
});

test('long prompt targets do not steal or clip the prompt body at narrow widths', () => {
  const target = '@research-worker-with-a-long-name', prompt = 'FIRST second';
  const presentation: EventRendering = { rendererId: 'core.mcp-prompt-subagent', subtype: 'mcp__agentorg__prompt_subagent', summary: `${target} ${prompt}`, extended: `${target} ${prompt}`, full: `${target} ${prompt}`, toolSymbol: '∴', toolTarget: target, toolPrompt: prompt };
  const e = event(1, 'tool.call', { title: 'mcp__agentorg__prompt_subagent', status: 'pending', rawInput: { agentId: 'session-1', text: prompt } });
  for (const width of [20, 32]) {
    const full = renderEvent(e, 3, width, presentation);
    expect(stripAnsi(full)).toMatch(/FIRST\s+second/);
    for (const line of full.split('\n')) expect(stringWidth(stripAnsi(line))).toBeLessThanOrEqual(width);
    const summary = renderEvent(e, 1, width, presentation);
    expect(stripAnsi(summary)).toContain('F');
    expect(stringWidth(stripAnsi(summary))).toBeLessThanOrEqual(width);
    const extended = renderEvent(e, 2, width, presentation);
    expect(stripAnsi(extended)).toMatch(/FIRST\s+second/);
    expect(extended.split('\n').length).toBeLessThanOrEqual(2);
  }
});

test('multiline prompt_subagent bodies keep continuation lines flush-left', () => {
  const prompt = 'First response line\n\nSecond response line\n\nThird response line';
  const presentation: EventRendering = { rendererId: 'core.mcp-prompt-subagent', summary: '@Reviewer ' + prompt, extended: '@Reviewer ' + prompt, full: '@Reviewer ' + prompt, toolSymbol: '∴', toolTarget: '@Reviewer', toolPrompt: prompt };
  const e = event(1, 'tool.call', { title: 'mcp__agentorg__prompt_subagent', status: 'pending', rawInput: { agentId: 'reviewer', text: prompt } });
  const lines = stripAnsi(renderEvent(e, 3, 80, presentation)).split('\n');
  expect(lines).toEqual(['∴ @Reviewer First response line', '', 'Second response line', '', 'Third response line']);
  expect(lines.slice(1).every(line => !line.startsWith(' '))).toBe(true);
});

test('prompt_subagent levels bound summaries/details and preserve full Markdown prompts', () => {
  const prompt = '**Review the change** and inspect `src/main.ts`. '.repeat(9) + 'Keep the final recommendation concise.';
  const presentation: EventRendering = { rendererId: 'core.mcp-prompt-subagent', subtype: 'mcp__agentorg__prompt_subagent', summary: `@Reviewer ${prompt}`, extended: `@Reviewer ${prompt}`, full: `@Reviewer ${prompt}`, toolSymbol: '∴', toolTarget: '@Reviewer', toolPrompt: prompt };
  const e = event(1, 'tool.call', { title: 'mcp__agentorg__prompt_subagent', status: 'pending', rawInput: { agentId: 'session-1', text: prompt } });
  const summary = renderEvent(e, 1, 42, presentation);
  expect(summary.split('\n')).toHaveLength(1);
  expect(stringWidth(stripAnsi(summary))).toBeLessThanOrEqual(42);
  expect(stripAnsi(summary)).toContain('…');
  const extended = renderEvent(e, 2, 42, presentation);
  expect(extended.split('\n')).toHaveLength(2);
  expect(extended).toContain('…');
  expect(stripAnsi(extended)).toContain('src/main.ts');
  const full = renderEvent(e, 3, 42, presentation);
  expect(stripAnsi(full)).toMatch(/Keep the final\s+recommendation concise\./);
  expect(full).toContain('\x1b[1mReview the change\x1b[0m');
  expect(full).toContain('\x1b[33m∴\x1b[0m');
  expect(stripAnsi(renderEvent(e, 4, 10000, presentation))).toBe(JSON.stringify(e, null, 2));
});

test('edit filenames stay plain while only the symbol and signed line counts carry color', () => {
  const presentation: EventRendering = { rendererId: 'pi/edit', subtype: 'edit', summary: 'Δ file-2.ts · +3 / -2', extended: 'Δ file-2.ts · +3 / -2', full: 'Δ file-2.ts · +3 / -2' };
  for (const [type, status, color] of [['tool.call', 'pending', '33'], ['tool.update', 'in_progress', '38;5;208'], ['tool.result', 'completed', '32'], ['tool.result', 'failed', '31']]) {
    const e = event(1, type, { toolCallId: 'same', status });
    for (const level of [1, 2, 3] as const) {
      const text = renderEvent(e, level, 80, presentation);
      expect(text).toStartWith(`\x1b[${color}mΔ\x1b[0m file-2.ts · `);
      expect(text).toContain('\x1b[32m+3\x1b[0m / \x1b[31m-2\x1b[0m');
      expect(stripAnsi(text)).toBe('Δ file-2.ts · +3 / -2');
    }
  }
  const sparseBash = event(2, 'tool.result', { toolCallId: 'old-call', status: 'completed', rawOutput: { content: [{ type: 'text', text: 'Command exited with code 127' }] } });
  const bash: EventRendering = { rendererId: 'pi/bash', subtype: 'bash', summary: '$ python --version', extended: '$ python --version\nCommand exited with code 127', full: '$ python --version\nCommand exited with code 127' };
  expect(renderTreeEvent(sparseBash, 80, bash)).toStartWith('\x1b[31m$\x1b[0m python --version');
});

test('edit extended uses semantic old/new colors and aligns using terminal cells; full colors diff hunks', () => {
  const prefix = 'Δ src/文件🦊.ts';
  const e = event(1, 'tool.call', { title: 'edit', rawInput: { path: 'src/文件🦊.ts' } });
  const presentation: EventRendering = {
    rendererId: 'pi/edit', subtype: 'edit', summary: `${prefix} · +1 / -1`, extended: `${prefix} old\n  new`,
    extendedDiff: { prefix, before: 'old <code>*', after: 'new <code>*' },
    full: `${prefix} · +1 / -1\n\nProposed changes:\n\n\`\`\`diff\n@@ -1 +1 @@\n-old <code>*\n+new <code>*\n\`\`\``,
  };
  const extended = renderEvent(e, 2, 100, presentation);
  expect(extended).toContain('\x1b[31mold <code>*'); expect(extended).toContain('\x1b[32mnew <code>*');
  expect(stripAnsi(extended).split('\n')).toEqual([`${prefix} old <code>*`, `${' '.repeat(stringWidth(prefix) + 1)}new <code>*`]);
  const summary = renderTreeEvent(e, 100, presentation);
  expect(summary).toStartWith(`\x1b[33mΔ\x1b[0m src/文件🦊.ts · `);
  expect(summary).toContain('\x1b[32m+1\x1b[0m / \x1b[31m-1\x1b[0m');
  const full = renderEvent(e, 3, 100, presentation);
  expect(full).toStartWith('\x1b[33mΔ\x1b[0m src/文件🦊.ts');
  expect(full).toContain('\x1b[31m-old <code>*'); expect(full).toContain('\x1b[32m+new <code>*');
  expect(stripAnsi(full)).not.toContain('tool.call');
  expect(stripAnsi(full)).toContain('@@ -1 +1 @@');
  for (const width of [1, 8, 16, 40]) {
    const summary = renderTreeEvent(e, width, presentation);
    expect(summary.split('\n')).toHaveLength(1); expect(stringWidth(summary)).toBeLessThanOrEqual(width);
    const wrapped = renderEvent(e, 2, width, presentation);
    for (const line of wrapped.split('\n')) expect(stringWidth(line)).toBeLessThanOrEqual(Math.max(width, 2)); // Wide glyphs occupy two cells.
    expect(stripAnsi(wrapped)).not.toMatch(/\n {8,}\n/);
  }
  const hostile = { ...presentation, extendedDiff: { prefix: '\x1b[2JΔ file\x07', before: '\x1b]0;bad\x07old\ntext', after: '\x1b[2Jnew' } };
  const safe = renderEvent(e, 2, 80, hostile);
  expect(safe).not.toContain('\x1b[2J'); expect(safe).not.toContain('\x1b]0;');
  expect(stripAnsi(safe).split('\n')).toHaveLength(2);
  expect(JSON.parse(renderEvent(e, 4, 10000, presentation))).toEqual(e);
  const metadata: RendererMetadata = { id: 'pi/edit', name: 'Pi edit', tool: 'edit', eventTypes: ['tool.call'], examples: [{ type: e.type, ...presentation, raw: JSON.stringify(e) }] };
  expect(rendererPreview(metadata, e.type, 2, 100, 7)).toContain('\x1b[31mold <code>*');
});

test('chat can replace tool call/update phases in place while preserving raw and unrelated events', () => {
  const settings = new Settings(); for (const type of settings.types([])) settings.levels[type] = 1; settings.compactToolCalls = true;
  const call = event(1, 'tool.call', { toolCallId: 'x', title: 'bash', rawInput: { command: 'echo hi' } });
  const update = event(3, 'tool.update', { toolCallId: 'x', title: 'bash', status: 'in_progress' });
  const result = event(4, 'tool.result', { toolCallId: 'x', title: 'bash', status: 'completed' });
  const other = event(2, 'agent.message', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'working' } });
  expect(chatGroups([call, other, update, result], settings).map(item => item.seq)).toEqual([4, 2]);
  settings.levels['tool.call'] = 4; settings.levels['tool.update'] = 4; settings.levels['tool.result'] = 4;
  expect(chatGroups([call, update, result], settings).map(item => item.seq)).toEqual([1, 3, 4]);
  settings.compactToolCalls = false;
  expect(chatGroups([call, update, result], settings).map(item => item.seq)).toEqual([1, 3, 4]);
});

test('compact tool groups scope IDs by agent/generation and leave unidentified phases separate', () => {
  const settings = new Settings(); settings.compactToolCalls = true;
  const events = [
    event(1, 'tool.call', { toolCallId: 'same' }),
    event(2, 'tool.call', { toolCallId: 'same' }, { agentId: 'worker' }),
    event(3, 'tool.call', { toolCallId: 'same' }, { generation: 'g2' }),
    event(4, 'tool.update', { toolCallId: 'same' }, { agentId: 'worker' }),
    event(5, 'tool.result', { toolCallId: 'same' }, { generation: 'g2' }),
    event(6, 'tool.result', { toolCallId: 'same' }),
    event(7, 'tool.call', {}), event(8, 'tool.update', {}),
    event(9, 'tool.call', { toolCallId: 'same' }, { agentId: undefined }),
    event(10, 'tool.result', { toolCallId: 'same' }, { agentId: undefined }),
  ];
  const original = structuredClone(events);
  expect(chatGroups(events, settings).map(item => item.seq)).toEqual([6, 4, 5, 7, 8, 9, 10]);
  expect(events).toEqual(original);
});

test('compact groups honor filtered phases, close hidden results and retain mixed raw phases', () => {
  const settings = new Settings(); settings.compactToolCalls = true;
  const call = event(1, 'tool.call', { toolCallId: 'x' });
  const update = event(2, 'tool.update', { toolCallId: 'x' });
  const result = event(3, 'tool.result', { toolCallId: 'x' });
  const events = [call, update, result];
  settings.levels['tool.call'] = 0;
  expect(chatGroups(events, settings).map(item => item.seq)).toEqual([3]);
  settings.levels['tool.call'] = 1; settings.levels['tool.update'] = 0;
  expect(chatGroups(events, settings).map(item => item.seq)).toEqual([3]);
  settings.levels['tool.update'] = 1; settings.levels['tool.result'] = 0;
  expect(chatGroups([...events, { ...call, seq: 4 }], settings).map(item => item.seq)).toEqual([2, 4]);
  settings.levels['tool.result'] = 1;
  const sidecars = new Map([[2, { rendererId: 'pi/bash', subtype: 'bash', summary: '$ cmd', extended: '$ cmd', full: '$ cmd' }]]);
  settings.levels['tool.update:bash'] = 4;
  expect(chatGroups(events, settings, sidecars).map(item => item.seq)).toEqual([1, 2, 3]);
  delete settings.levels['tool.update:bash']; settings.levels['tool.result'] = 4;
  expect(chatGroups(events, settings, sidecars).map(item => item.seq)).toEqual([2, 3]);
  settings.levels['tool.call'] = 4; settings.levels['tool.result'] = 2;
  expect(chatGroups(events, settings, sidecars).map(item => item.seq)).toEqual([1, 3]);
});

test('presentation sidecars select tree summaries independently of chat subtype levels and do not merge custom messages', () => {
  const store = new Store(), settings = new Settings();
  store.install({ seq: 0, agents: [agent('root')], operations: [] });
  store.present(raw.seq, rendering); store.ingest(raw);
  settings.levels['tool.result:read'] = 4;
  expect(settings.level('tool.result', 'read')).toBe(4);
  expect(settings.level('tool.result', 'edit')).toBe(2);
  expect(settings.level('tool.result:write')).toBe(2);
  const table = renderTable(store.tree(), store.latest(settings), ['event'], 80, store.renderings);
  expect(stripAnsi(table.items[0]!)).toContain('< src/main.ts');
  expect(stripAnsi(table.items[0]!)).not.toContain('ORIGINAL OUTPUT');
  expect(store.discovered.has('tool.result:read')).toBe(true);
  const messages = [event(2), event(3)];
  store.present(2, { ...rendering, rendererId: 'pi/message' });
  expect(chatGroups(messages, settings, store.renderings)).toHaveLength(2);
  store.ingest(messages[0]!); store.ingest(messages[1]!);
  expect(store.latest(settings).get('root')!.data).toEqual(messages[1]!.data);
  store.reset(); expect(store.renderings.size).toBe(0);
});

test('MCP level previews select alias-specific Pi examples and retain emitted identity for all public tools', () => {
  const names = ['create_subagent', 'prompt_subagent', 'prompt_parent', 'get_subagent', 'snapshot_organization', 'stop_subagent', 'restart_subagent', 'restart_subagent_subtree', 'replace_subagent_session', 'remove_subagent', 'modify_subagent', 'get_completion', 'get_operation', 'wait_operation', 'cancel_operation'];
  for (const tool of names) {
    const emitted = `mcp__agentorg__${tool}`;
    const example = (identity: string, subtype?: string) => {
      const raw = JSON.stringify({ kind: 'event', seq: 0, time: '2026-01-01T00:00:00.000Z', type: 'tool.result', data: { title: identity, status: 'completed', rawInput: { example: tool }, rawOutput: { content: [{ type: 'text', text: '{"status":"completed"}' }], isError: false } } }, null, 2);
      return { type: 'tool.result', summary: `Example ${identity}`, extended: `Example ${identity} · returned completed`, full: `Example ${identity} · details`, raw, ...(subtype && { subtype }) };
    };
    const canonical = example(tool), aliased = example(emitted, emitted);
    const metadata: RendererMetadata = { id: `core.mcp-${tool}`, name: tool, eventTypes: ['tool.call', 'tool.update', 'tool.result'], tool, aliases: [emitted], examples: [canonical], aliasExamples: { [emitted]: [aliased] } };
    for (const level of [1, 2, 3, 4] as const) {
      const preview = rendererPreview(metadata, 'tool.result', level, 120, 60, {}, emitted);
      expect(preview).toContain(`Example ${emitted}`);
      if (level === 4) expect(preview).toContain(`"title": "${emitted}"`);
      expect(preview).not.toContain(`"title": "${tool}"`);
    }
  }
});

test('examples show all five levels when space allows, only the selected level on small terminals', () => {
  const large = rendererPreview(metadata, 'tool.result', 3, 55, 24);
  for (const text of ['0 hidden', '1 summary', '2 extended', '3 full', '4 raw', 'Pi read', 'Custom read complete']) expect(large).toContain(text);
  expect(large).toContain('\n\n○ 1 summary');
  expect(large).toContain('\n\n○ 2 extended');
  const small = rendererPreview(metadata, 'tool.result', 2, 25, 7);
  expect(small).toContain('2 extended'); expect(small).not.toContain('4 raw');
  for (const line of small.split('\n')) expect(stringWidth(line)).toBeLessThanOrEqual(25);
});

async function renderingServer() {
  return mockServer((socket, request) => {
    if (request.method === 'organization.snapshot') respond(socket, request.id, { seq: 1, agents: [agent('root')], operations: [], capabilities: { rendering: { version: 1, catalog: 'events.renderers' } } });
    else if (request.method === 'events.renderers') respond(socket, request.id, { version: 1, renderers: [metadata, { ...metadata, id: 'core.tools', name: 'Core styles', harness: undefined, tool: undefined }] });
    else if (request.method === 'subscribe') respond(socket, request.id, { seq: 1, liveOnly: true });
    else if (request.method === 'events.history') respond(socket, request.id, { events: request.params.after < 1 ? [raw] : [], renderings: { 1: rendering }, oldestSeq: 1, latestSeq: 1, expired: false });
  });
}

test('Session negotiates server rendering, installs history sidecars and dispatches live presentations separately', async () => {
  const mock = await renderingServer(), session = new Session(mock.path);
  const running = session.run();
  try {
    await waitFor(() => session.status === 'connected');
    expect(session.renderers[0]!.id).toBe('pi/read');
    expect(session.store.events.get(1)).toEqual(raw);
    expect(session.store.renderings.get(1)).toEqual(rendering);
    for (const socket of mock.sockets) {
      send(socket, { kind: 'presentation', seq: 2, rendering });
      send(socket, { ...raw, seq: 2 });
    }
    await waitFor(() => session.store.events.has(2));
    expect(session.store.renderings.get(2)).toEqual(rendering);
    expect(session.store.events.get(2)).not.toHaveProperty('rendering');
  } finally { session.close(); await running; await mock.close(); }
});

test('terminal level selector displays examples for the real Pi-prefixed AgentOrg MCP identity', async () => {
  const emitted = 'mcp__agentorg__create_subagent';
  const example = (type: string, identity = emitted) => ({ type, summary: `AgentOrg example ${identity}`, extended: `AgentOrg example ${identity} · operation status running`, full: `AgentOrg example ${identity} · operation details`, raw: JSON.stringify({ kind: 'event', seq: 0, time: '2026-01-01T00:00:00.000Z', type, data: { title: identity, status: 'completed', rawInput: { operationId: 'operation-1' }, rawOutput: { content: [{ type: 'text', text: '{"status":"running"}' }], isError: false } } }, null, 2), ...(identity === emitted && { subtype: emitted }) });
  const renderer = { id: 'core.mcp-create-subagent', name: 'Create child · AgentOrg MCP', eventTypes: ['tool.call', 'tool.update', 'tool.result'], tool: 'create_subagent', aliases: [emitted], examples: ['tool.call', 'tool.update', 'tool.result'].map(type => example(type, 'create_subagent')), aliasExamples: { [emitted]: ['tool.call', 'tool.update', 'tool.result'].map(type => example(type)) } };
  const generic = { id: 'core.tools', name: 'Core generic tool fallback', eventTypes: ['tool.call', 'tool.update', 'tool.result'], examples: ['tool.call', 'tool.update', 'tool.result'].map(type => ({ type, summary: 'unknown', extended: 'unknown', full: 'unknown', raw: JSON.stringify({ kind: 'event', seq: 0, time: '2026-01-01T00:00:00.000Z', type, data: { title: 'unknown', rawInput: { pattern: 'hello' } } }) })) };
  const mock = await mockServer((socket, request) => {
    if (request.method === 'organization.snapshot') respond(socket, request.id, { seq: 0, agents: [agent('root')], operations: [], capabilities: { rendering: { version: 1, catalog: 'events.renderers' } } });
    else if (request.method === 'events.renderers') respond(socket, request.id, { version: 1, renderers: [generic, renderer] });
    else if (request.method === 'subscribe') respond(socket, request.id, { seq: 0, liveOnly: true });
    else if (request.method === 'events.history') respond(socket, request.id, { events: [], oldestSeq: 0, latestSeq: 0, expired: false });
  });
  const tui = terminalClient(mock.path, mock.directory);
  try {
    await tui.visible('connected');
    tui.keys('vl'); await tui.visible('Event visibility / rendering levels');
    const type = `tool.result:${emitted}`;
    const subtypes = ['tool.call', 'tool.update', 'tool.result'].flatMap(phase => [`${phase}:create_subagent`, `${phase}:${emitted}`]);
    const index = new Settings().types(subtypes).indexOf(type);
    tui.keys('\x1b[B'.repeat(index));
    await tui.visible(type);
    await tui.visible(`AgentOrg example ${emitted}`);
    expect(tui.screen()).toContain('Synthetic examples');
    expect(tui.screen()).not.toContain('No examples available');
    const canonicalType = 'tool.result:create_subagent';
    const canonicalIndex = new Settings().types(subtypes).indexOf(canonicalType);
    const steps = canonicalIndex - index;
    tui.keys(steps < 0 ? '\x1b[A'.repeat(-steps) : '\x1b[B'.repeat(steps));
    await tui.visible(canonicalType);
    await tui.visible('AgentOrg example create_subagent');
    expect(tui.screen()).not.toContain('Core generic tool fallback');
  } finally { await tui.close(); await mock.close(); }
}, 15000);

test('z inheritance for default Pi subtypes survives save/reload and follows the parent level', async () => {
  const cases = [
    { phase: 'tool.call', canonical: 'prompt_subagent', parentLevel: 1, defaultLevel: 3 },
    { phase: 'tool.result', canonical: 'get_operation', parentLevel: 4, defaultLevel: 2 },
  ] as const;
  for (const item of cases) {
    const emitted = `mcp__agentorg__${item.canonical}`, type = `${item.phase}:${emitted}`;
    const renderer = {
      id: `core.mcp-${item.canonical}`, name: `${item.canonical} · AgentOrg MCP`, tool: item.canonical,
      aliases: [emitted], eventTypes: ['tool.call', 'tool.update', 'tool.result'], updateMode: 'semantic', extendedLayout: 'header-detail',
      examples: ['tool.call', 'tool.update', 'tool.result'].map(phase => ({ type: phase, summary: `Example ${item.canonical}`, extended: `Example ${item.canonical}\nStatus`, full: `Example ${item.canonical}`, raw: JSON.stringify({ kind: 'event', seq: 0, time: 'now', type: phase, data: { title: item.canonical } }) })),
      aliasExamples: { [emitted]: ['tool.call', 'tool.update', 'tool.result'].map(phase => ({ type: phase, subtype: emitted, summary: `Example ${emitted}`, extended: `Example ${emitted}\nStatus`, full: `Example ${emitted}`, raw: JSON.stringify({ kind: 'event', seq: 0, time: 'now', type: phase, data: { title: emitted } }) })) },
    };
    const mock = await mockServer((socket, request) => {
      if (request.method === 'organization.snapshot') respond(socket, request.id, { seq: 0, agents: [agent('root')], operations: [], capabilities: { rendering: { version: 1, catalog: 'events.renderers' } } });
      else if (request.method === 'events.renderers') respond(socket, request.id, { version: 1, renderers: [renderer] });
      else if (request.method === 'subscribe') respond(socket, request.id, { seq: 0, liveOnly: true });
      else if (request.method === 'events.history') respond(socket, request.id, { events: [], oldestSeq: 0, latestSeq: 0, expired: false });
    });
    const config = join(mock.directory, 'config.json');
    const initial = new Settings();
    if (item.parentLevel !== 1) initial.levels[item.phase] = item.parentLevel;
    await initial.save(config);
    const tui = terminalClient(mock.path, mock.directory);
    try {
      await tui.visible('connected');
      const phases = ['tool.call', 'tool.update', 'tool.result'];
      const subtypes = phases.flatMap(phase => [`${phase}:${item.canonical}`, `${phase}:${emitted}`]);
      const index = (await Settings.load(config)).types(subtypes).indexOf(type);
      tui.keys('vl'); await tui.visible('Event visibility / rendering levels');
      tui.keys('\x1b[B'.repeat(index)); await tui.visible(type);
      expect((await Settings.load(config)).level(item.phase, emitted)).toBe(item.defaultLevel);
      tui.keys('z');
      await tui.visible(`Saved ${config}`);
      const persisted = JSON.parse(await readFile(config, 'utf8'));
      expect(persisted.inheritedLevels).toContain(type);
      expect(persisted.levels[type]).toBeUndefined();
      const reloaded = await Settings.load(config);
      expect(reloaded.levels[type]).toBeUndefined();
      expect(reloaded.inheritedLevels.has(type)).toBe(true);
      expect(reloaded.level(item.phase, emitted)).toBe(item.parentLevel);
    } finally { await tui.close(); await mock.close(); }
  }
}, 15000);

test('terminal level selector previews renderer examples, saves subtype overrides, and tree/raw chat stay independent', async () => {
  const mock = await renderingServer(), tui = terminalClient(mock.path, mock.directory);
  try {
    await tui.visible('< src/main.ts');
    tui.keys('vl'); await tui.visible('Event visibility / rendering levels');
    const settings = new Settings();
    const index = settings.types(['tool.result:read']).indexOf('tool.result:read');
    tui.keys('\x1b[B'.repeat(index));
    await tui.visible('Pi read');
    await tui.visible('1 summary'); await tui.visible('4 raw');
    tui.keys('r'); await tui.visible('Core styles');
    tui.keys('3'); await tui.visible('Custom read complete');
    const path = join(mock.directory, 'config.json');
    await waitFor(() => tui.screen().includes('Saved '));
    expect(JSON.parse(await readFile(path, 'utf8')).levels['tool.result:read']).toBe(3);
    tui.keys('z'); await waitFor(asyncReadGuard(path, 'tool.result:read', undefined));
    expect((await Settings.load(path)).level('tool.result', 'read')).toBe(2);
    tui.keys('4'); await tui.visible('4 raw');
    await waitFor(asyncReadGuard(path, 'tool.result:read', 4));
    tui.keys('\x1b'); await tui.visible('LATEST TRACKED EVENT');
    expect(tui.screen()).toContain('< src/main.ts');
    tui.keys('c'); await tui.visible('Chat · root');
    await tui.visible('ORIGINAL OUTPUT');
    expect(tui.screen()).not.toContain('Custom read complete');
  } finally { await tui.close(); await mock.close(); }
}, 15000);

test('terminal compact controls toggle via selection or shortcut with either settings menu layout', async () => {
  for (const serverSettings of [false, true]) {
    const mock = await mockServer((socket, request) => {
      if (request.method === 'organization.snapshot') respond(socket, request.id, { seq: 0, agents: [agent('root')], operations: [], capabilities: serverSettings ? { serverSettings: { version: 1, groups: [], endpoints: { list: 'settings.list', get: 'settings.get', update: 'settings.update' } } } : {} });
      else if (request.method === 'subscribe') respond(socket, request.id, { seq: 0, liveOnly: true });
      else if (request.method === 'events.history') respond(socket, request.id, { events: [], oldestSeq: 0, latestSeq: 0, expired: false });
    });
    const path = join(mock.directory, 'config.json');
    let tui = terminalClient(mock.path, mock.directory);
    const saved = (value: boolean) => {
      let matched = false;
      return () => { void Settings.load(path).then(settings => { matched = settings.compactToolCalls === value; }); return matched; };
    };
    try {
      await tui.visible('connected');
      tui.keys('v'); await tui.visible('Compact tool/steering phases in chat: off');
      tui.keys('\x1b[B'.repeat(serverSettings ? 4 : 3) + '\r');
      await tui.visible('Compact tool/steering phases in chat: on');
      await waitFor(saved(true));
      tui.keys('?'); await tui.visible('Toggle compact tool and steering phases');
      tui.keys('\x1b'); await tui.visible('View settings');
      tui.keys('c'); await tui.visible('Compact tool/steering phases in chat: off');
      await waitFor(saved(false));
      tui.keys('c'); await tui.visible('Compact tool/steering phases in chat: on');
      await waitFor(saved(true));
      await tui.close();
      tui = terminalClient(mock.path, mock.directory);
      await tui.visible('connected');
      tui.keys('v'); await tui.visible('Compact tool/steering phases in chat: on');
    } finally { await tui.close(); await mock.close(); }
  }
}, 15000);

test('terminal compact chat advances a bounded output tail with a visible gray gutter and count', async () => {
  const call = event(1, 'tool.call', { toolCallId: 'rolling', title: 'bash', rawInput: { command: 'watch-output' } });
  const mock = await mockServer((socket, request) => {
    if (request.method === 'organization.snapshot') respond(socket, request.id, { seq: 1, agents: [agent('root')], operations: [] });
    else if (request.method === 'subscribe') respond(socket, request.id, { seq: 1, liveOnly: true });
    else if (request.method === 'events.history') respond(socket, request.id, { events: request.params.after < 1 ? [call] : [], oldestSeq: 1, latestSeq: 1, expired: false });
  });
  const settings = new Settings(); settings.compactToolCalls = true;
  await settings.save(join(mock.directory, 'config.json'));
  const tui = terminalClient(mock.path, mock.directory);
  const live = (seq: number, type: string, rawOutput: string) => {
    for (const socket of mock.sockets) send(socket, { ...call, seq, type, data: { ...call.data as object, status: type === 'tool.result' ? 'completed' : 'in_progress', rawOutput } });
  };
  try {
    await tui.visible('$ watch-output');
    tui.keys('c'); await tui.visible('Chat · root');
    live(2, 'tool.update', 'FIRST_HIDDEN\ntwo\nthree\nfour\nfive\nsix');
    await tui.visible('6 lines received · showing last 5 rows');
    await tui.visible('│ six');
    expect(tui.screen()).not.toContain('FIRST_HIDDEN');
    expect(tui.screen().match(/\$ watch-output/g)).toHaveLength(1);
    const lines = tui.screen().split('\n');
    const row = lines.findIndex(line => line.includes('│ six'));
    const column = lines[row]!.indexOf('│ six');
    const countRow = lines.findIndex(line => line.includes('6 lines received'));
    for (const [y, x] of [[countRow, 0], [row, column]] as const) {
      expect(tui.cell(y, x)?.getFgColor()).toBe(250); // Explicit gray, not theme-dependent bright black.
      expect(tui.cell(y, x)?.isBgDefault()).toBeTruthy();
    }
    expect(tui.cell(row, column + 2)?.isBgDefault()).toBeTruthy();
    expect(tui.cell(row, column + 2)?.isFgDefault()).toBeTruthy();
    live(3, 'tool.update', `SECOND_HIDDEN\n${'long-output '.repeat(100)}LATEST_TAIL`);
    await tui.visible('2 lines received · showing last 5 rows');
    await tui.visible('LATEST_TAIL');
    expect(tui.screen()).not.toContain('SECOND_HIDDEN');
    expect(tui.screen()).not.toContain('│ six');
    const outputRows = tui.screen().split('\n').filter(line => /^  │ /.test(line));
    expect(outputRows).toHaveLength(5);
    live(4, 'tool.result', 'FINISHED_OUTPUT');
    await tui.visible('FINISHED_OUTPUT');
    expect(tui.screen()).not.toContain('lines received');
    expect(tui.screen()).not.toContain('LATEST_TAIL');
    expect(tui.screen().match(/\$ watch-output/g)).toHaveLength(1);
  } finally { await tui.close(); await mock.close(); }
}, 15000);

test('terminal changes only symbol colors across phases and independently colors edit counts/text', async () => {
  const call = event(1, 'tool.call', { title: 'bash', status: 'pending', rawInput: { command: 'echo ready' } });
  const bash: EventRendering = { rendererId: 'core.tools', subtype: 'bash', summary: '$ echo ready', extended: '$ echo ready\nready', full: '$ echo ready\n\n```\nready\n```' };
  const mock = await mockServer((socket, request) => {
    if (request.method === 'organization.snapshot') respond(socket, request.id, { seq: 1, agents: [agent('root')], operations: [], capabilities: { rendering: { version: 1, catalog: 'events.renderers' } } });
    else if (request.method === 'events.renderers') respond(socket, request.id, { version: 1, renderers: [] });
    else if (request.method === 'subscribe') respond(socket, request.id, { seq: 1, liveOnly: true });
    else if (request.method === 'events.history') respond(socket, request.id, { events: request.params.after < 1 ? [call] : [], renderings: { 1: bash }, oldestSeq: 1, latestSeq: 1, expired: false });
  });
  const settings = new Settings(); for (const type of settings.types([])) settings.levels[type] = 1; settings.levels['tool.result'] = 3;
  await settings.save(join(mock.directory, 'config.json'));
  const tui = terminalClient(mock.path, mock.directory);
  const fg = (text: string) => {
    const lines = tui.screen().split('\n'), row = lines.findIndex(line => line.includes(text));
    return row < 0 ? undefined : tui.cell(row, lines[row]!.indexOf(text))?.getFgColor();
  };
  const live = (e: typeof call, rendering: EventRendering) => {
    for (const socket of mock.sockets) { send(socket, { kind: 'presentation', seq: e.seq, rendering }); send(socket, e); }
  };
  try {
    await tui.visible('$ echo ready');
    await waitFor(() => fg('$ echo ready') === 3).catch(() => { throw new Error(`Expected yellow header; fg=${fg('$ echo ready')}\n${tui.screen()}`); });
    expect(tui.screen()).not.toContain('tool.call:'); expect(tui.screen()).not.toContain('pending');
    expect(fg('echo ready')).toBe(-1); // Event text keeps the terminal default, not selection/lifecycle colors.
    live({ ...call, seq: 2, type: 'tool.update', data: { ...call.data as object, status: 'in_progress' } }, bash);
    await waitFor(() => fg('$ echo ready') === 208);
    expect(fg('echo ready')).toBe(-1);
    live({ ...call, seq: 3, type: 'tool.result', data: { ...call.data as object, status: 'completed' } }, bash);
    await waitFor(() => fg('$ echo ready') === 2);
    expect(fg('echo ready')).toBe(-1);
    live({ ...call, seq: 4, type: 'tool.result', data: { ...call.data as object, status: 'failed' } }, { ...bash, extended: '$ echo ready\nexit 2' });
    await waitFor(() => fg('$ echo ready') === 1);
    expect(fg('echo ready')).toBe(-1);
    const edit = event(5, 'tool.result', { title: 'edit', status: 'completed', rawInput: { path: 'file.ts' } });
    const delta: EventRendering = { rendererId: 'pi/edit', subtype: 'edit', summary: 'Δ file.ts · +1 / -1', extended: 'Δ file.ts old text\n  new text', extendedDiff: { prefix: 'Δ file.ts', before: 'old text', after: 'new text' }, full: 'Δ file.ts · +1 / -1\n\n```diff\n@@ -1 +1 @@\n-old text\n+new text\n```' };
    live(edit, delta); await tui.visible('Δ file.ts');
    expect(fg('file.ts')).toBe(-1); expect(fg('+1')).toBe(2); expect(fg('-1')).toBe(1);
    tui.keys('c'); await tui.visible('Chat · root');
    await tui.visible('-old text'); await tui.visible('+new text');
    expect(fg('Δ file.ts')).toBe(2); expect(fg('-old text')).toBe(1); expect(fg('+new text')).toBe(2);
    tui.keys('\x1b'); await tui.visible('LATEST TRACKED EVENT');
    tui.keys('vl'); await tui.visible('Event visibility / rendering levels');
    const index = settings.types(['tool.call:bash', 'tool.update:bash', 'tool.result:bash', 'tool.result:edit']).indexOf('tool.result:edit');
    tui.keys('\x1b[B'.repeat(index) + '2');
    await waitFor(asyncReadGuard(join(mock.directory, 'config.json'), 'tool.result:edit', 2));
    tui.keys('\x1b'); await tui.visible('LATEST TRACKED EVENT');
    tui.keys('c'); await tui.visible('Chat · root');
    await tui.visible('Δ file.ts old text');
    expect(fg('old text')).toBe(1); expect(fg('new text')).toBe(2);
    expect(tui.screen()).not.toContain('tool.result:');
  } finally { await tui.close(); await mock.close(); }
}, 15000);

test('terminal level names use the available pane width before truncating long MCP tools', async () => {
  const type = 'tool.call:mcp__agentorg__create_subagent';
  const tooLong = `${type}_${'extra'.repeat(12)}`;
  const mock = await mockServer((socket, request) => {
    if (request.method === 'organization.snapshot') respond(socket, request.id, { seq: 2, agents: [agent('root')], operations: [] });
    else if (request.method === 'events.history') respond(socket, request.id, {
      events: request.params.after < 2 ? [event(1, type), event(2, tooLong)] : [], oldestSeq: 1, latestSeq: 2, expired: false,
    });
  });
  const tui = terminalClient(mock.path, mock.directory, { rows: 40 });
  try {
    await tui.visible('connected');
    tui.keys('vl'); await tui.visible('Event visibility / rendering levels');
    const index = new Settings().types([type, tooLong]).indexOf(type);
    tui.keys('\x1b[B'.repeat(index));
    await tui.visible(type);
    const row = tui.screen().split('\n').find(line => line.startsWith(type))!;
    expect(row.slice(0, 60)).toContain('1 summary');
    expect(row.slice(0, 60)).not.toContain('…');
    const clipped = tui.screen().split('\n').find(line => line.startsWith(`${type}_`))!;
    expect(clipped.slice(0, 60)).toContain('…');
    expect(clipped.slice(0, 60)).toContain('1 summary');
    expect(tui.screen()).toContain('Renderer examples');
    tui.keys('2'); await waitFor(asyncReadGuard(join(mock.directory, 'config.json'), type, 2));
    await tui.visible('2 extended');
    expect(tui.screen().split('\n').find(line => line.startsWith(type))!.slice(0, 60)).toContain('2 extended');
  } finally { await tui.close(); await mock.close(); }
}, 15000);

// waitFor's predicate is synchronous; poll a detached read to avoid racing the atomic save.
function asyncReadGuard(path: string, key: string, value: number | undefined): () => boolean {
  let matched = false;
  return () => { void readFile(path, 'utf8').then(text => { matched = JSON.parse(text).levels[key] === value; }).catch(() => {}); return matched; };
}
