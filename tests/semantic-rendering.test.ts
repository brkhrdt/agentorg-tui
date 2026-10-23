import { expect, test } from 'bun:test';
import stripAnsi from 'strip-ansi';
import stringWidth from 'string-width';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { renderEvent } from '../src/render.js';
import { rendererCandidates, rendererIdentityMatch, rendererPreview, rendererSubtypes } from '../src/renderer-preview.js';
import { validEventRendering, validRendererMetadata, type EventRendering, type ServerEvent, type RendererMetadata } from '../src/protocol.js';

// Optional coordinated-workspace tests: TUI still installs/tests without a core checkout.
const corePath = join(import.meta.dir, '../../agentorg/src/rendering.ts');
const coreModule = existsSync(corePath) ? await import(corePath) : undefined;
const MCP_TOOL_NAMES: string[] = coreModule ? (await import(join(import.meta.dir, '../../agentorg/src/mcp-tool-rendering.ts'))).MCP_TOOL_NAMES : [];
interface CoreRegistry {
  registerHarness(name: string, renderers: unknown[], aliases: (names: string[]) => Record<string, string>): void;
  render(event: ServerEvent, harness: string, defaultId: string, context?: { targetName: string }): EventRendering | undefined;
  catalog(): RendererMetadata[];
}
const registry = (): CoreRegistry => { const registry: CoreRegistry = new coreModule!.RendererRegistry(); registry.registerHarness('pi', [], names => Object.fromEntries(names.map(name => [`mcp__agentorg__${name}`, name]))); return registry; };
const event = (tool: string, value: unknown, rawInput: unknown = { operationId: 'operation-' + 'x'.repeat(80) }): ServerEvent => ({ kind: 'event', seq: 1, time: 'now', type: 'tool.result', data: { title: tool, status: 'completed', rawInput, rawOutput: { content: [{ type: 'text', text: JSON.stringify(value) }], isError: false } } });

test.skipIf(!coreModule)('real core MCP sidecars/catalog preserve all 14 Pi identities, symbol and semantic hints', () => {
  const core = registry();
  for (const row of core.catalog()) expect(validRendererMetadata(row)).toBe(true);
  for (const tool of MCP_TOOL_NAMES) {
    const emitted = `mcp__agentorg__${tool}`, row = core.catalog().find(row => row.tool === tool)!;
    const e = event(emitted, { status: 'running' }, { agentId: 'child-7', text: 'Review this change', operationId: 'op', batchId: 'batch' });
    const rendering = core.render(e, 'pi', 'core.tools')!;
    expect(validEventRendering(rendering)).toBe(true); expect(rendering.subtype).toBe(emitted);
    for (const level of [1, 2, 3] as const) expect(stripAnsi(renderEvent(e, level, 80, rendering))).toStartWith('∴ ');
    if (tool === 'prompt_subagent') expect(stripAnsi(renderEvent(e, 1, 80, rendering))).toBe('∴ @child-7 Review this change');
    expect(JSON.parse(renderEvent(e, 4, 10000, rendering))).toEqual(e);
    const preview = rendererPreview(row, 'tool.update', 2, 80, 12, {}, emitted);
    expect(preview).toContain('∴'); expect(preview).not.toContain('lines received');
  }
});

test.skipIf(!coreModule)('real semantic statuses stay visible at feasible narrow widths including truncation and 23/24/25 boundaries', () => {
  const core = registry();
  for (const state of ['running', 'failed', 'stopped', 'interrupted']) for (const type of ['tool.update', 'tool.result']) {
    const e = { ...event('mcp__agentorg__get_operation', { a: true, s: state, t: true, r: null }), type };
    const presentation = core.render(e, 'pi', 'core.tools')!;
    for (const width of [1, 2, 3, 5, 6, 12, 20, 23, 24, 25, 40, 80]) {
      const lines = stripAnsi(renderEvent(e, 2, width, presentation)).split('\n');
      expect(lines).toHaveLength(2);
      for (const line of lines) expect(stringWidth(line)).toBeLessThanOrEqual(width);
      if (width > state.length) expect(lines[1]).toContain(state);
      if (width >= 28) expect(lines[1]).toContain('[TRUNCATED]');
    }
  }
});

test.skipIf(!coreModule)('full prompt rendering drops decoration before clipping ASCII or multibyte text at tiny widths', () => {
  for (const { width, prompt } of [{ width: 2, prompt: 'FIRST second' }, { width: 3, prompt: '你好世界' }]) {
    const e = event('mcp__agentorg__prompt_subagent', { status: 'running' }, { agentId: 'child', text: prompt });
    const presentation = registry().render(e, 'pi', 'core.tools', { targetName: 'research-worker-with-a-long-name' })!;
    const output = stripAnsi(renderEvent(e, 3, width, presentation));
    expect(output.replace(/\n/g, '')).toContain(prompt);
    for (const line of output.split('\n')) expect(stringWidth(line)).toBeLessThanOrEqual(width);
  }
});

test.skipIf(!coreModule)('prompt_subagent full level shows the complete prompt without operation-status detail', () => {
  const prompt = 'very long prompt '.repeat(100);
  const e = { ...event('mcp__agentorg__prompt_subagent', { status: 'running' }, { agentId: 'child', text: prompt }), type: 'tool.update' };
  const rendering = registry().render(e, 'pi', 'core.tools')!;
  const output = stripAnsi(renderEvent(e, 3, 40, rendering)).split('\n');
  expect(output.join('\n')).toContain('very long prompt');
  expect(output.join('\n')).not.toContain('running');
});

test.skipIf(!coreModule)('MCP lifecycle colors describe invocation errors, not a domain isError/status field', () => {
  const core = registry();
  const direct = event('mcp__agentorg__get_operation', null);
  direct.data = { title: 'mcp__agentorg__get_operation', status: 'completed', rawOutput: { status: 'failed', isError: true } };
  const directPresentation = core.render(direct, 'pi', 'core.tools')!;
  expect(renderEvent(direct, 1, 80, directPresentation)).toStartWith('\x1b[32m∴');
  const failed = event('mcp__agentorg__get_operation', { code: 'FORBIDDEN', message: 'denied' });
  (failed.data as any).rawOutput.isError = true;
  const failedPresentation = core.render(failed, 'pi', 'core.tools')!;
  expect(renderEvent(failed, 1, 80, failedPresentation)).toStartWith('\x1b[31m∴');
});

test.skipIf(!coreModule)('named AgentOrg prompt targets keep their literal text, symbol and independent accent', () => {
  const e = event('mcp__agentorg__prompt_subagent', { status: 'queued' }, { agentId: 'child', text: 'Keep @child literally' });
  const rendering = registry().render(e, 'pi', 'core.tools', { targetName: '[Reviewer] *one*' })!;
  const rendered = renderEvent(e, 1, 100, rendering, { agentTarget: 'magenta' });
  expect(rendered).toContain('\x1b[35m@[Reviewer] *one*\x1b[0m');
  expect(stripAnsi(rendered)).toBe('∴ @[Reviewer] *one* Keep @child literally');
});

test('descriptor hints reach cached previews and alias scopes choose the applicable harness', () => {
  const base: RendererMetadata = { id: 'core', name: 'Core', tool: 'get_operation', eventTypes: ['tool.update'], aliases: ['shared'], aliasHarnesses: { shared: ['a'] }, updateMode: 'semantic', extendedLayout: 'header-detail', examples: [{ type: 'tool.update', summary: 'head', extended: 'head\nstopped', full: 'head\nstopped', raw: JSON.stringify(event('shared', { status: 'stopped' })) }] };
  const other: RendererMetadata = { ...base, id: 'other', tool: 'wait_operation', aliasHarnesses: { shared: ['b'] } };
  expect(rendererCandidates([base, other], 'tool.update', 'shared', 'a').map(row => row.id)).toEqual(['core']);
  expect(rendererCandidates([base, other], 'tool.update', 'shared', 'b').map(row => row.id)).toEqual(['other']);
  expect(rendererIdentityMatch(base, 'shared', 'b')).toBe(false);
  expect(rendererSubtypes([base], 'b')).not.toContain('tool.update:shared');
  base.examples[0]!.updateMode = undefined; base.examples[0]!.extendedLayout = undefined;
  const raw = JSON.parse(base.examples[0]!.raw); raw.type = 'tool.update'; base.examples[0]!.raw = JSON.stringify(raw);
  const preview = stripAnsi(rendererPreview(base, 'tool.update', 2, 40, 9));
  expect(preview).toContain('stopped'); expect(preview).not.toContain('lines received');
});

test('prototype-property identities never select inherited alias scopes or example functions', () => {
  const metadata: RendererMetadata = { id: 'constructor', name: 'Constructor', tool: 'constructor', eventTypes: ['tool.result'], aliases: ['prefixed_constructor', 'toString'], aliasHarnesses: { prefixed_constructor: ['a'] }, aliasExamples: {}, examples: [{ type: 'tool.result', summary: 'Constructor sample', extended: 'Constructor sample', full: 'Constructor sample', raw: JSON.stringify(event('constructor', null)) }] };
  expect(rendererIdentityMatch(metadata, 'toString', 'a')).toBe(true);
  for (const identity of ['constructor', '__proto__', 'toString']) expect(stripAnsi(rendererPreview(metadata, 'tool.result', 1, 60, 10, {}, identity))).toContain('Constructor sample');
});

test('semantic symbol/target validation and rendering cannot inject terminal controls', () => {
  const base = { rendererId: 'core', summary: '@child prompt', extended: '@child prompt\nrunning', full: '@child prompt', toolSymbol: '∴', toolTarget: '@child' };
  expect(validEventRendering({ ...base, toolSymbol: '\x1b[2J' })).toBe(false);
  expect(validEventRendering({ ...base, invocationError: 'yes' })).toBe(false);
  const rendered = renderEvent(event('prompt_subagent', {}), 1, 80, { ...base, toolSymbol: '\x1b[2J∴' });
  expect(rendered).not.toContain('\x1b[2J'); expect(stripAnsi(rendered)).toBe('∴ @child prompt');
  expect(validRendererMetadata({ id: 'bad', name: 'Bad', eventTypes: ['tool.result'], aliases: ['shared'], aliasHarnesses: { unrelated: ['a'] }, examples: [] })).toBe(false);
});
