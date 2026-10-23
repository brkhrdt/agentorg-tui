import type { ServerEvent } from './protocol.js';

export type ChatBlockLayout = { identity: string; seq: number; startRow: number; rows: number };
export type ChatViewportAnchor = { identity: string; seq: number; rowOffset: number };
export type ChatLayoutPart = { text: string; event?: ServerEvent; identity?: string };

/** Blessed alwaysScroll exposes the visible top as childBase; getScroll() also adds childOffset. */
export function visibleChatOrigin(chat: { childBase: number; childOffset: number; getScroll: () => number }): number {
  return Math.max(0, Math.floor(chat.childBase));
}

/** Uses Blessed's ftor map so row offsets match its actual Unicode, tag, and wrap behavior. */
export function layoutChatParts(parts: ChatLayoutPart[], ftor: number[][]): ChatBlockLayout[] {
  const layout: ChatBlockLayout[] = [];
  let fakeLine = 0;
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index]!;
    if (index) fakeLine++; // Two newlines add one blank logical line between parts.
    const lineCount = part.text.split('\n').length;
    const renderedRows = ftor.slice(fakeLine, fakeLine + lineCount).flat();
    if (part.event && renderedRows.length) {
      layout.push({
        identity: part.identity ?? `${part.event.seq}`,
        seq: part.event.seq,
        startRow: renderedRows[0]!,
        rows: renderedRows.at(-1)! - renderedRows[0]! + 1,
      });
    }
    fakeLine += lineCount;
  }
  return layout;
}

export function resolveChatAnchor(anchor: ChatViewportAnchor | undefined, layout: ChatBlockLayout[]): { row: number; lost: boolean } {
  if (!anchor || !layout.length) return { row: 0, lost: false };
  const exact = layout.find(item => item.identity === anchor.identity);
  const fallback = exact ?? layout.find(item => item.seq >= anchor.seq) ?? layout.at(-1);
  return fallback
    ? { row: fallback.startRow + Math.min(anchor.rowOffset, Math.max(0, fallback.rows - 1)), lost: !exact }
    : { row: 0, lost: true };
}
