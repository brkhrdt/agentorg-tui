import type blessed from 'blessed';

export interface PathCandidate { name: string; path: string; kind: 'directory' | 'file' }
export interface PathCompletion { path: string; isDirectory: boolean; entries: PathCandidate[] }

/** Blessed has no cancellable before-input event. Wrap its textbox listener once,
 * before readInput binds it, keeping normal editing unchanged outside the picker. */
export function enablePathKeys(input: blessed.Widgets.TextboxElement, handlers: {
  active(): boolean;
  acceptSpace?: boolean | (() => boolean);
  move(delta: number): void;
  complete(): void;
  changed(): void;
}): void {
  type Listener = (ch: string | undefined, key: blessed.Widgets.Events.IKeyEventArg) => void;
  const textbox = input as blessed.Widgets.TextboxElement & { _listener: Listener };
  const original = textbox._listener;
  textbox._listener = function(ch, key) {
    if (!handlers.active()) return original.call(this, ch, key);
    if (key.name === 'up' || key.name === 'down') return handlers.move(key.name === 'up' ? -1 : 1);
    if (key.name === 'tab') return handlers.complete();
    if ((typeof handlers.acceptSpace === 'function' ? handlers.acceptSpace() : handlers.acceptSpace !== false) && ch === ' ' && !key.ctrl && !key.meta) return original.call(this, '\r', { ...key, name: 'enter' });
    const value = this.getValue();
    original.call(this, ch, key);
    if (this.getValue() !== value) handlers.changed();
  };
}
