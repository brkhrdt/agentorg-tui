import { build } from 'esbuild';
import { readFile, writeFile, copyFile, chmod, mkdir, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const nodeMajor = Number(process.versions.node.split('.')[0]);
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 14)) throw new Error('Building requires Node.js 22.14 or newer');
await mkdir(dist, { recursive: true });
const entry = join(dist, 'org-tui.cjs');
await build({
  entryPoints: [join(root, 'src/main.ts')], outfile: entry, bundle: true, platform: 'node', format: 'cjs',
  plugins: [{
    name: 'blessed-standalone',
    setup(build) {
      build.onLoad({ filter: /[/\\]blessed[/\\]lib[/\\]widget\.js$/ }, () => ({
        contents: ['screen', 'box', 'list', 'textbox', 'textarea'].map(name => `exports.${name} = exports.${name[0].toUpperCase() + name.slice(1)} = require('./widgets/${name}');`).join('\n'), loader: 'js',
      }));
      build.onLoad({ filter: /[/\\]blessed[/\\]lib[/\\]tput\.js$/ }, async ({ path }) => ({
        contents: (await readFile(path, 'utf8')).replace("__dirname + '/../usr/xterm'", JSON.stringify(join(dirname(path), '../usr/xterm'))), loader: 'js',
      }));
    },
  }],
});
const blob = join(dist, 'sea.blob');
await writeFile(join(dist, 'sea-config.json'), JSON.stringify({ main: entry, output: blob, disableExperimentalSEAWarning: true }));
const configured = spawnSync(process.execPath, ['--experimental-sea-config', join(dist, 'sea-config.json')], { stdio: 'inherit' });
if (configured.status !== 0) process.exit(configured.status ?? 1);
const binary = join(dist, 'org-tui');
await copyFile(process.execPath, binary);
if (process.platform === 'darwin') {
  const sign = spawnSync('codesign', ['--remove-signature', binary], { stdio: 'inherit' });
  if (sign.status !== 0) process.exit(sign.status ?? 1);
}
const injector = join(root, 'node_modules/.bin/postject');
const injected = spawnSync(injector, [binary, 'NODE_SEA_BLOB', blob, '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'], { stdio: 'inherit' });
if (injected.status !== 0) process.exit(injected.status ?? 1);
await chmod(binary, 0o755);
await rm(entry); await rm(blob); await rm(join(dist, 'sea-config.json'));
console.log(`Built ${binary} for ${process.platform}-${process.arch} with Node ${process.version}`);
