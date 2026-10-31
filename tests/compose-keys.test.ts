import { expect, test } from 'bun:test';
import { PassThrough } from 'node:stream';
import { once } from 'node:events';
import { ComposeKeyInput, type ComposeSubmitMode } from '../src/compose-keys.js';

async function normalize(chunks: string[], composeActive = true, timeoutMs = 30) {
  const source = new PassThrough();
  const input = new ComposeKeyInput(() => composeActive, timeoutMs);
  let bytes = '';
  const modes: ComposeSubmitMode[] = [];
  input.on('data', chunk => { bytes += Buffer.from(chunk).toString('utf8'); });
  input.on('modifiedEnter', mode => modes.push(mode));
  input.attach(source as any);
  const ended = once(input, 'end');
  for (const chunk of chunks) source.write(Buffer.from(chunk));
  source.end();
  await ended;
  input.dispose();
  return { bytes, modes };
}

test('normalizer recognizes supported Alt/Ctrl Enter encodings across split and coalesced reads', async () => {
  const { bytes, modes } = await normalize([
    `typed\x1b`, `\r-tail\x1b[13;`, `3u`, `middle\x1b[13;5u`,
    `x\x1b[27;3;13~y\x1b[27;5;13~end`,
  ]);
  expect(bytes).toBe('typed-tailmiddlexyend');
  expect(modes).toEqual(['queue', 'queue', 'interrupt', 'queue', 'interrupt']);
});

test('normalizer preserves plain Enter, UTF-8, unknown keys and unsupported modifier combinations', async () => {
  const input = 'wide 界\r\x1b[A\x1b[13;7u\x1b[27;7;13~\x1b\t';
  const { bytes, modes } = await normalize([input]);
  expect(bytes).toBe(input);
  expect(modes).toEqual([]);
});

test('modified Enter sequences are consumed outside chat and prompt composition', async () => {
  const sequences = '\x1b\r\x1b[13;3u\x1b[13;5u\x1b[27;3;13~\x1b[27;5;13~';
  const { bytes, modes } = await normalize([sequences], false);
  expect(bytes).toBe('');
  expect(modes).toEqual([]);
});

test('standalone Escape is disambiguated for a bounded interval then remains ordinary Escape plus Enter', async () => {
  const source = new PassThrough();
  const input = new ComposeKeyInput(() => true, 20);
  let bytes = '';
  const modes: ComposeSubmitMode[] = [];
  input.on('data', chunk => { bytes += Buffer.from(chunk).toString('utf8'); });
  input.on('modifiedEnter', mode => modes.push(mode));
  input.attach(source as any);
  source.write(Buffer.from('\x1b'));
  await new Promise(resolve => setTimeout(resolve, 35));
  source.write(Buffer.from('\r'));
  source.end();
  await once(input, 'end');
  input.dispose();
  expect(bytes).toBe('\x1b\r');
  expect(modes).toEqual([]);
});
