import { Transform, type TransformCallback } from 'node:stream';

export type ComposeSubmitMode = 'default' | 'queue' | 'interrupt';
export const ESCAPE_DISAMBIGUATION_MS = 60;

type RawInput = NodeJS.ReadStream & { setRawMode?: (mode: boolean) => RawInput };
interface ModifiedEnter { bytes: Buffer; mode: Exclude<ComposeSubmitMode, 'default'> }
const ESC = 0x1b;
const MODIFIED_ENTER: ModifiedEnter[] = [
  { bytes: Buffer.from('\x1b\r'), mode: 'queue' },
  { bytes: Buffer.from('\x1b[13;3u'), mode: 'queue' },
  { bytes: Buffer.from('\x1b[13;5u'), mode: 'interrupt' },
  { bytes: Buffer.from('\x1b[27;3;13~'), mode: 'queue' },
  { bytes: Buffer.from('\x1b[27;5;13~'), mode: 'interrupt' },
];

/** Byte-preserving filter installed before Blessed's key decoder. */
export class ComposeKeyInput extends Transform {
  private source?: RawInput;
  private pending = Buffer.alloc(0);
  private rawMode = false;
  private blocked = false;
  private flushCallback?: TransformCallback;
  private disambiguation?: ReturnType<typeof setTimeout>;

  constructor(private readonly composeActive: () => boolean, private readonly timeoutMs = ESCAPE_DISAMBIGUATION_MS) {
    super();
  }

  get isTTY(): boolean { return !!this.source?.isTTY; }
  get isRaw(): boolean { return this.source?.isRaw ?? this.rawMode; }
  setRawMode(mode: boolean): this { this.rawMode = mode; this.source?.setRawMode?.(mode); return this; }

  attach(source: RawInput): void {
    if (this.source) throw new Error('Compose key input is already attached');
    this.source = source;
    source.setRawMode?.(this.rawMode);
    source.pipe(this);
  }

  dispose(): void {
    if (this.disambiguation) clearTimeout(this.disambiguation);
    this.disambiguation = undefined;
    this.pending = Buffer.alloc(0);
    this.blocked = false;
    this.flushCallback = undefined;
    this.source?.unpipe(this);
    this.source = undefined;
    this.destroy();
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    if (this.disambiguation) clearTimeout(this.disambiguation);
    this.disambiguation = undefined;
    this.pending = this.pending.length ? Buffer.concat([this.pending, chunk]) : Buffer.from(chunk);
    this.drain();
    callback();
  }

  override _flush(callback: TransformCallback): void {
    if (this.disambiguation) clearTimeout(this.disambiguation);
    this.disambiguation = undefined;
    this.flushCallback = callback;
    this.drain(true);
  }

  /** Release bytes buffered after modified Enter once Blessed has rearmed input. */
  resumeAfterSubmit(): void {
    if (!this.blocked) return;
    this.blocked = false;
    this.drain();
  }

  private finishFlush(): void {
    if (!this.blocked && !this.pending.length && this.flushCallback) {
      const callback = this.flushCallback;
      this.flushCallback = undefined;
      callback();
    }
  }

  private drain(forcePrefix = false): void {
    if (this.blocked) return;
    while (this.pending.length) {
      const exact = MODIFIED_ENTER.find(sequence => this.pending.length >= sequence.bytes.length && this.pending.subarray(0, sequence.bytes.length).equals(sequence.bytes));
      if (exact) {
        this.pending = this.pending.subarray(exact.bytes.length);
        if (this.composeActive()) {
          this.blocked = true;
          this.emit('modifiedEnter', exact.mode);
          return;
        }
        forcePrefix = false;
        continue;
      }
      const isPrefix = MODIFIED_ENTER.some(sequence => this.pending.length < sequence.bytes.length && sequence.bytes.subarray(0, this.pending.length).equals(this.pending));
      if (isPrefix) {
        if (!forcePrefix) {
          this.disambiguation = setTimeout(() => {
            this.disambiguation = undefined;
            this.drain(true);
          }, this.timeoutMs);
          return;
        }
        const nextEscape = this.pending.indexOf(ESC, 1);
        const length = nextEscape > 0 ? nextEscape : this.pending.length;
        this.push(this.pending.subarray(0, length));
        this.pending = this.pending.subarray(length);
        forcePrefix = false;
        continue;
      }
      const startsWithEscape = this.pending[0] === ESC;
      const nextEscape = this.pending.indexOf(ESC, startsWithEscape ? 1 : 0);
      const length = nextEscape >= 0 ? nextEscape : this.pending.length;
      this.push(this.pending.subarray(0, length));
      this.pending = this.pending.subarray(length);
      forcePrefix = false;
    }
    this.finishFlush();
  }
}
