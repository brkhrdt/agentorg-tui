import { parseArgs } from 'node:util';
import { resolve, dirname } from 'node:path';
import { mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { TreeProbe } from '../src/bench-probe.js';

const { values } = parseArgs({ options: {
  socket: { type: 'string' }, duration: { type: 'string', default: '30' }, output: { type: 'string' },
  width: { type: 'string', default: '120' }, 'frame-ms': { type: 'string', default: '16' }, help: { type: 'boolean' },
} });
if (values.help) {
  console.log('npm run bench:probe --socket PATH [--duration 30|0] [--output report.json] [--width 120] [--frame-ms 16]\nMeasures the real TUI session/tree renderer, not terminal paint. History replay is disabled.');
  process.exit(0);
}
if (!values.socket) throw new Error('--socket is required');
const duration = Number(values.duration), width = Number(values.width), frameMs = Number(values['frame-ms']);
if (!Number.isFinite(duration) || duration < 0 || !Number.isInteger(width) || width < 10 || !Number.isInteger(frameMs) || frameMs < 1)
  throw new Error('Invalid probe duration/width/frame-ms');
const probe = new TreeProbe(resolve(values.socket), width, frameMs);
function save() {
  const result = JSON.stringify(probe.report(), null, 2);
  if (values.output) {
    const path = resolve(values.output);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path + '.tmp', result, { mode: 0o600 });
    renameSync(path + '.tmp', path);
  }
}
const stop = new AbortController();
const interrupted = () => stop.abort();
process.on('SIGINT', interrupted);
process.on('SIGTERM', interrupted);
const timer = duration ? setTimeout(interrupted, duration * 1000) : undefined;
const samples = setInterval(save, 1000);
try {
  probe.start();
  await new Promise<void>(resolve => stop.signal.addEventListener('abort', () => resolve(), { once: true }));
} finally {
  if (timer) clearTimeout(timer);
  clearInterval(samples);
  await probe.close();
  save();
  const report = probe.report();
  console.log(JSON.stringify(report));
  if (report.readyMs === undefined || report.disconnects) process.exitCode = 1;
  process.off('SIGINT', interrupted);
  process.off('SIGTERM', interrupted);
}
