import blessed from 'blessed';

// Blessed exposes these methods at runtime but omits them from its typings.
const Textarea = blessed.textarea as unknown as new (options: blessed.Widgets.TextareaOptions) => blessed.Widgets.TextareaElement & {
  _clines: string[];
  parseContent(): void;
  _listener(ch: string, key: blessed.Widgets.Events.IKeyEventArg): void;
  _done?: (error: null, value: string) => void;
  childBase: number;
  childOffset: number;
};

/** A wrapping composer with textbox-style Enter-to-send behavior. */
export class PromptInput extends Textarea {
  _listener(ch: string, key: blessed.Widgets.Events.IKeyEventArg): void {
    if (key.name === 'enter') this.submit();
    else super._listener(ch, key);
  }

  submit(): void {
    this._done?.(null, this.value);
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
