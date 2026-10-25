import type { RendererMetadata, ServerEvent } from './protocol.js';
import { clean, clip, eventText, renderEvent, styledCell, type RenderColors } from './render.js';
import { LEVEL_NAMES, type Level } from './settings.js';

/** Local fallback previews also work with older servers without renderer discovery. */
export function genericPreview(type: string): RendererMetadata {
  const data = type === 'agent.message' ? { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '**Hello** from the agent.\n\nMore detail appears at full level.' } } :
    type === 'agent.plan' ? { entries: [{ content: 'Implement the change', status: 'in_progress' }] } :
    type.startsWith('tool.') ? { title: 'example', status: 'pending', rawInput: { path: 'src/main.ts' } } :
    { state: 'running', status: 'completed', text: 'Example prompt', message: 'Example event', name: 'worker' };
  const event: ServerEvent = { kind: 'event', seq: 0, time: '2026-01-01T00:00:00.000Z', type, data };
  const text = eventText(event);
  return { id: 'client.generic', name: 'Generic event', eventTypes: [type], examples: [{ type, summary: text, extended: text, full: text, raw: JSON.stringify(event, null, 2) }] };
}

/** Older catalogs without alias scope metadata retain their previous behavior. */
export function rendererIdentityMatch(renderer: RendererMetadata, identity: string | undefined, harness?: string): boolean {
  if (!identity) return false;
  if (renderer.harness && harness && renderer.harness !== harness) return false;
  if (renderer.tool === identity) return true;
  const scopes = renderer.aliasHarnesses && Object.hasOwn(renderer.aliasHarnesses, identity) ? renderer.aliasHarnesses[identity] : undefined;
  return !!renderer.aliases?.includes(identity) && (!harness || !scopes || scopes.includes(harness));
}

export function rendererSubtypes(renderers: RendererMetadata[], harness?: string): string[] {
  return [...new Set(renderers.flatMap(renderer => {
    if (renderer.harness && harness && renderer.harness !== harness) return [];
    const identities = [renderer.tool, ...(renderer.aliases ?? [])].filter((identity): identity is string => !!identity && rendererIdentityMatch(renderer, identity, harness));
    return identities.flatMap(identity => renderer.eventTypes.map(type => `${type}:${identity}`));
  }))];
}

export function rendererCandidates(renderers: RendererMetadata[], type: string, identity?: string, harness?: string): RendererMetadata[] {
  return renderers.filter(renderer => renderer.eventTypes.includes(type) && (!renderer.harness || !harness || renderer.harness === harness) && (!renderer.tool || rendererIdentityMatch(renderer, identity, harness)))
    .sort((a, b) => {
      const rank = (renderer: RendererMetadata) => rendererIdentityMatch(renderer, identity, harness) ? renderer.harness === harness ? 0 : 1 : 2;
      return rank(a) - rank(b);
    });
}

/** A bounded excerpt, not the renderer's full output; raw remains the synthetic envelope. */
export function rendererPreview(renderer: RendererMetadata, type: string, selected: Level, width: number, height: number, colors: RenderColors = {}, subtype?: string): string {
  const examples = subtype && renderer.aliasExamples && Object.hasOwn(renderer.aliasExamples, subtype) ? renderer.aliasExamples[subtype]! : renderer.examples;
  const example = examples.find(example => example.type === type) ?? examples[0];
  const title = `${renderer.name} · ${renderer.id}`;
  if (!example) return clip(`${title}\nNo examples available`, width);
  let event: ServerEvent;
  try { event = JSON.parse(example.raw); }
  catch { return clip(`${title} · Invalid example`, width); }
  const rendering = { ...example, updateMode: example.updateMode ?? renderer.updateMode, extendedLayout: example.extendedLayout ?? renderer.extendedLayout, rendererId: renderer.id };
  const levels: Level[] = height >= 15 ? [0, 1, 2, 3, 4] : [selected];
  const separators = Math.max(0, levels.length - 1);
  const budget = Math.max(1, Math.floor((height - 2 - levels.length - separators) / levels.length));
  const lines = [clip(title, width), clip('Synthetic examples · preview excerpts', width)];
  for (const [index, level] of levels.entries()) {
    if (index) lines.push('');
    lines.push(clip(`${level === selected ? '●' : '○'} ${level} ${LEVEL_NAMES[level]}`, width));
    if (level === 0) continue;
    const rendered = renderEvent(event, level, Math.max(1, width), renderer.id === 'client.generic' ? undefined : rendering, colors).split('\n');
    lines.push(...rendered.slice(0, budget).map(line => styledCell(line, width).trimEnd()));
    if (rendered.length > budget) lines[lines.length - 1] = clip(`${clean(lines.at(-1)!)} …`, width);
  }
  return lines.slice(0, height).join('\n');
}
