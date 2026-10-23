import wrapAnsi from 'wrap-ansi';
import type { ServerEvent } from './protocol.js';

export type ChatBlockLayout = { identity: string; seq: number; startRow: number; rows: number };
export type ChatViewportAnchor = { identity: string; seq: number; rowOffset: number };
export type ChatLayoutPart = { text: string; event?: ServerEvent; identity?: string };

/** Blessed alwaysScroll exposes the visible top as childBase; getScroll() also adds childOffset. */
export function visibleChatOrigin(chat: { childBase: number; childOffset: number; getScroll: () => number }): number {
  return Math.max(0, Math.floor(chat.childBase));
}

function visualRows(text: string, width: number): number {
  return text.split('\n').reduce((rows, line) => rows + wrapAnsi(line, Math.max(1, width), { hard: true, trim: false }).split('\n').length, 0);
}

/** Layout rows for the exact double-newline join used to populate the chat widget. */
export function layoutChatParts(parts: ChatLayoutPart[], width: number): ChatBlockLayout[] {
  const layout: ChatBlockLayout[] = [];
  let row = 0;
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index]!;
    if (index) row++; // Two newline characters add one blank row between parts.
    const rows = visualRows(part.text, width);
    if (part.event) layout.push({ identity: part.identity ?? `${part.event.seq}`, seq: part.event.seq, startRow: row, rows });
    row += rows;
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
