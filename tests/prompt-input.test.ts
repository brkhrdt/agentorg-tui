import { expect, test } from 'bun:test';
import { PassThrough } from 'node:stream';
import blessed from 'blessed';
import { PromptInput } from '../src/prompt-input.js';
import { waitFor } from './helpers.js';

test('unchanged composer value reflows on terminal resize, including recovery from a capped viewport', async () => {
  const output = Object.assign(new PassThrough(), { columns: 60, rows: 20, isTTY: true });
  output.resume();
  const screen = blessed.screen({ input: new PassThrough(), output, terminal: 'xterm-256color', warnings: false });
  const input = new PromptInput({ parent: screen, bottom: 3, height: 1 });
  try {
    const draft = 'a'.repeat(180);
    input.setValue(draft);
    expect(input.reflow(13)).toBe(4);
    expect(input.childBase).toBe(0);
    output.columns = 30;
    output.emit('resize');
    await waitFor(() => Number(screen.width) === 30);
    expect(input.reflow(13)).toBe(7);
    expect(input.childBase).toBe(0);
    expect(input.reflow(5)).toBe(5);
    expect(input.childBase).toBe(2);
    output.columns = 100;
    output.emit('resize');
    await waitFor(() => Number(screen.width) === 100);
    expect(input.reflow(13)).toBe(2);
    expect(input.childBase).toBe(0);
    expect(input.getValue()).toBe(draft);
    input.setValue('');
    expect(input.reflow(13)).toBe(1);
    expect(input.childBase).toBe(0);
  } finally { screen.destroy(); }
});
