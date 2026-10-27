import { resolve } from 'node:path';
import { defaultConfigPath, Settings } from './settings.js';
import { Session } from './session.js';
import { UI } from './ui.js';

const help = `Agent Organization TUI

Usage: org-tui [--socket PATH] [--config PATH] [--no-history]

  --socket PATH  Unix socket (default: ORG_SOCKET or .org/server.sock)
  --config PATH  Client settings (including history cache) (default: $XDG_CONFIG_HOME/org-tui/settings.json)
  --no-history   Skip startup history; chat can still load history on demand
  -h, --help     Show help

Tree: ↑↓ select, Tab collapse/expand branch, Enter interrupting prompt, c chat, v l visibility / rendering levels, q quit.
Chat: Enter sends an interrupting message; Escape returns to the tree. Prompt composer Tab completes mentions; tree Tab collapses/expands branches.
`;
async function main(): Promise<void> {
  let socket = process.env.ORG_SOCKET ?? '.org/server.sock';
  let config = defaultConfigPath();
  let replayHistory = true;
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '-h' || arg === '--help') { console.log(help); return; }
    if (arg === '--no-history') { replayHistory = false; continue; }
    if (arg !== '--socket' && arg !== '--config') throw new Error(`Unknown argument: ${arg}`);
    const value = args[++index];
    if (!value || value.startsWith('--')) throw new Error(`${arg} requires a path`);
    if (arg === '--socket') socket = value; else config = value;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('An interactive terminal is required. Use --help for usage.');
  const settings = await Settings.load(resolve(config));
  const session = new Session(resolve(socket), { replayHistory, history: settings.history });
  const ui = new UI(session, settings, resolve(config));
  process.once('SIGTERM', () => ui.close());
  process.once('SIGINT', () => ui.close());
  void session.run().catch(error => { ui.close(); console.error(error.message); });
}
main().catch(error => { console.error(`org-tui: ${error.message}`); process.exitCode = 1; });
