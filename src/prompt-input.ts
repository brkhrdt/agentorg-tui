import blessed from 'blessed';
import type { ComposeSubmitMode } from './compose-keys.js';

// Blessed exposes these methods at runtime but omits them from its typings.
const Textarea = blessed.textarea as unknown as new (options: blessed.Widgets.TextareaOptions) => blessed.Widgets.TextareaElement & {
  _clines: string[];
  parseContent(): void;
  _listener(ch: string, key: blessed.Widgets.Events.IKeyEventArg): void;
  _done?: (error: null, value: string) => void;
  childBase: number;
  childOffset: number;
};

/** A wrapping composer with explicit, one-shot modified-Enter submission modes. */
export class PromptInput extends Textarea {
  private submitMode: ComposeSubmitMode = 'default';

  _listener(ch: string, key: blessed.Widgets.Events.IKeyEventArg): void {
    if (key.name === 'enter') {
      if (key.ctrl && key.meta || key.ctrl && key.shift || key.meta && key.shift) return;
      this.submit(key.ctrl ? 'interrupt' : key.meta ? 'queue' : 'default');
    } else super._listener(ch, key);
  }

  submit(mode: ComposeSubmitMode = 'default'): void {
    if (!this._done) return;
    this.submitMode = mode;
    this._done(null, this.value);
  }

  takeSubmitMode(): ComposeSubmitMode {
    const mode = this.submitMode;
    this.submitMode = 'default';
    return mode;
  }

  // Native setValue scrolls before we can grow. Defer it to reflow, avoiding
  // Blessed's CSR optimization against the composer's previous coordinates.
  _typeScroll(): void {}

  /** Run before the screen renders, so sibling panes use the new height too. */
  reflow(maxRows: number): number {
    this.setValue(this.value);
    this.parseContent(); // Rewrap even when only the terminal width changed.
    const rows = Math.max(1, Math.min(this._clines.length, maxRows));
    if (Number(this.height) !== rows) this.height = rows;
    // Keep all rows visible until the terminal is full, then follow the tail.
    this.childBase = Math.max(0, this._clines.length - rows);
    this.childOffset = 0;
    return rows;
  }
}
