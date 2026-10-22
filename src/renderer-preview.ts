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

/** A bounded excerpt, not the renderer's full output; raw remains the synthetic envelope. */
export function rendererPreview(renderer: RendererMetadata, type: string, selected: Level, width: number, height: number, colors: RenderColors = {}, subtype?: string): string {
  const examples = subtype ? renderer.aliasExamples?.[subtype] ?? renderer.examples : renderer.examples;
  const example = examples.find(example => example.type === type) ?? examples[0];
  const title = `${renderer.name} · ${renderer.id}`;
  if (!example) return clip(`${title}\nNo examples available`, width);
  let event: ServerEvent;
  try { event = JSON.parse(example.raw); }
  catch { return clip(`${title} · Invalid example`, width); }
  const rendering = { ...example, rendererId: renderer.id };
  const levels: Level[] = height >= 15 ? [1, 2, 3, 4] : [selected];
  const budget = Math.max(1, Math.floor((height - 2 - levels.length) / levels.length));
  const lines = [clip(title, width), clip('Synthetic examples · preview excerpts', width)];
  for (const level of levels) {
    lines.push(clip(`${level === selected ? '●' : '○'} ${level} ${LEVEL_NAMES[level - 1]}`, width));
    const rendered = renderEvent(event, level, Math.max(1, width), renderer.id === 'client.generic' ? undefined : rendering, colors).split('\n');
    lines.push(...rendered.slice(0, budget).map(line => styledCell(line, width).trimEnd()));
    if (rendered.length > budget) lines[lines.length - 1] = clip(`${clean(lines.at(-1)!)} …`, width);
  }
  return lines.slice(0, height).join('\n');
}
