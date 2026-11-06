import { spawnSync } from 'node:child_process';
import { mkdtemp, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const binary = join(root, 'dist/org-tui');
const modules = join(root, 'node_modules');
const hiddenModules = join(root, 'node_modules.hidden-for-relocation-test');
const dir = await mkdtemp(join(tmpdir(), 'org-tui-relocation-'));
let hidden = false;
try {
  await rename(modules, hiddenModules);
  hidden = true;
  // Launch from outside the checkout with an intentionally unavailable TERM so
  // Blessed must use its embedded xterm terminfo fallback during initialization.
  const command = `${binary} --socket ${join(dir, 'missing.sock')}`;
  const result = spawnSync('timeout', ['3s', 'script', '-q', '-e', '-c', command, '/dev/null'], {
    cwd: dir,
    env: { ...process.env, PATH: '/usr/bin:/bin', TERM: 'org-tui-no-such-terminfo' },
    encoding: 'utf8',
    timeout: 5000,
  });
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  if (![0, 124].includes(result.status) || /ENOENT|Cannot find module|node_modules/i.test(output)) {
    throw new Error(`Relocated binary failed without build-time node_modules (status=${result.status}):\n${output}`);
  }
  console.log('Relocation smoke test passed with build-time node_modules hidden and fallback TERM missing');
} finally {
  if (hidden) await rename(hiddenModules, modules);
  await rm(dir, { recursive: true, force: true });
}
