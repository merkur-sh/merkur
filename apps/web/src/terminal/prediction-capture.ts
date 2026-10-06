import { e2eWasm } from '@merkur/shared/e2e-wasm-runtime';
import type { ClientPredictionAdmission } from '../../../../packages/e2e-wasm/pkg/e2e_wasm.js';
import type { PredictionFastStateReader } from './prediction-fast-path';

export const CAPTURE_PRINTABLE = 0;
export const CAPTURE_BACKSPACE = 1;
export const CAPTURE_DELETE = 2;
export const CAPTURE_LEFT = 3;
export const CAPTURE_RIGHT = 4;
export type CaptureOp = 0 | 1 | 2 | 3 | 4;

/** Main owns only a seqlock copy; Rust owns projection and input frontiers. */
export class PredictionCapture {
  private readonly model: ClientPredictionAdmission;
  private readonly pointer: number;
  private words: Uint32Array;
  private closed = false;

  constructor(
    private readonly memory: WebAssembly.Memory,
    private readonly state: PredictionFastStateReader,
  ) {
    this.model = new (e2eWasm().ClientPredictionAdmission)();
    this.pointer = this.model.snapshot_ptr();
    this.words = new Uint32Array(memory.buffer, this.pointer, 7);
  }

  prepare(op: CaptureOp, inputSeq: number): boolean {
    if (this.closed) return false;
    // Authorization operations share this realm and can grow its memory.
    if (this.words.byteLength === 0) {
      this.words = new Uint32Array(this.memory.buffer, this.pointer, 7);
    }
    const version = this.state.readModelWordsInto(this.words);
    return this.model.prepare(op, inputSeq, version);
  }

  invalidate(): void {
    if (!this.closed) this.model.invalidate();
  }

  flush(inputSeq = 0): void {
    if (!this.closed) this.model.flush(inputSeq);
  }

  reset(): void {
    if (!this.closed) this.model.reset();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.model.free();
  }
}
