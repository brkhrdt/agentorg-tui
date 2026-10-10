import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { BunPlugin } from 'bun';

// Blessed's widget registry uses computed require() calls that bundlers cannot
// discover. Only expose the widgets this client uses (others include optional
// native dependencies), and embed an xterm terminfo fallback for minimal hosts.
const blessedStandalone: BunPlugin = {
  name: 'blessed-standalone',
  setup(build) {
    build.onLoad({ filter: /[/\\]blessed[/\\]lib[/\\]widget\.js$/ }, () => ({
      loader: 'js',
      contents: ['screen', 'box', 'list', 'textbox'].map(name =>
        `exports.${name} = exports.${name[0].toUpperCase() + name.slice(1)} = require('./widgets/${name}');`
      ).join('\n'),
    }));
    build.onLoad({ filter: /[/\\]blessed[/\\]lib[/\\]tput\.js$/ }, async ({ path }) => ({
      loader: 'js',
      contents: `import fallbackTerminfo from ${JSON.stringify(join(dirname(path), '../usr/xterm'))} with { type: 'file' };\n` +
        (await readFile(path, 'utf8')).replace("__dirname + '/../usr/xterm'", 'fallbackTerminfo'),
    }));
  },
};

const args = process.argv.slice(2);
let target: string | undefined;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--target') target = args[++i];
  else if (args[i].startsWith('--target=')) target = args[i].slice('--target='.length);
  else throw new Error(`Unknown build argument: ${args[i]}`);
  if (!target?.match(/^bun-(linux|darwin)-(x64|arm64)(-baseline|-modern|-musl)*$/))
    throw new Error('Expected --target bun-linux-x64 (or another supported Unix Bun target)');
}
const result = await Bun.build({
  entrypoints: [join(import.meta.dir, '../src/main.ts')],
  target: 'bun',
  compile: { outfile: join(import.meta.dir, '../dist/org-tui'), ...(target ? { target: target as Bun.Build.CompileTarget } : {}) },
  plugins: [blessedStandalone],
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
console.log('Built dist/org-tui');
