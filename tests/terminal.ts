import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import xterm from '@xterm/headless';
import { waitFor } from './helpers.js';

export function terminalClient(socket: string, directory: string, { cols = 120, rows = 30 } = {}) {
  const terminal = new xterm.Terminal({ cols, rows, allowProposedApi: true });
  const command = process.env.ORG_TUI_BINARY ? `'${resolve(process.env.ORG_TUI_BINARY)}'` : 'bun src/main.ts';
  const child = spawn('script', ['-qefc', `stty cols ${cols} rows ${rows}; exec ${command} --socket '${socket}' --config '${join(directory, 'config.json')}'`, '/dev/null'], {
    cwd: join(import.meta.dir, '..'), env: { ...process.env, TERM: 'xterm-256color', LANG: 'C.UTF-8' }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdout.on('data', data => terminal.write(data));
  const screen = () => Array.from({ length: rows }, (_, i) => terminal.buffer.active.getLine(i)?.translateToString(true) ?? '').join('\n');
  const keys = (text: string) => child.stdin.write(text);
  return {
    keys, screen,
    cursor() { return { x: terminal.buffer.active.cursorX, y: terminal.buffer.active.cursorY }; },
    cell(row: number, column: number) { return terminal.buffer.active.getLine(row)?.getCell(column); },
    async visible(text: string) {
      try { await waitFor(() => screen().includes(text), 5000); }
      catch { throw new Error(`Missing ${text}; exit=${child.exitCode}\n${screen()}`); }
    },
    async close() {
      keys('\x03');
      await waitFor(() => child.exitCode !== null || child.signalCode !== null, 3000).catch(() => child.kill('SIGTERM'));
      terminal.dispose();
    },
  };
}
