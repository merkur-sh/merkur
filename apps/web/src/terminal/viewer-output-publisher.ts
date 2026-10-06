import {
  VIEWER_OUTPUT_MAX_BYTES,
  VIEWER_OUTPUT_WORDS_BYTES,
  type ViewerOutputRingWriter,
  type ViewerOutputSource,
} from './viewer-output-ring';

/** The viewer's output ABI: `poll_output` and where its words and bytes lie. */
export interface ViewerOutputs {
  poll_output(nowMs: number): number;
  output_words_ptr(): number;
  output_bytes_ptr(): number;
  output_bytes_len(): number;
  output_max_bytes(): number;
}

/** Output kind 6 is the resume claim; its word 5 says it carries row hashes. */
const OUTPUT_KIND_RESUME = 6;
const RESUME_HASHES_WORD_OFFSET = 5 * 4;

export interface ViewerOutputPublisher {
  /**
   * Poll the viewer dry and publish each output under the lineage and fence
   * it was polled in. A full ring ends the drain with one output held where
   * the viewer left it; the next drain publishes that one first, so nothing is
   * lost or reordered, and the viewer coalesces what it would have said next.
   * True when a resume claim carrying row hashes was polled.
   */
  drain(
    viewer: ViewerOutputs,
    memory: WebAssembly.Memory,
    lineage: number,
    frameFenceToken: number,
  ): boolean;
  /** Forget a held output: its viewer or its lineage is gone. */
  reset(): void;
}

/** Throws when the viewer can return an output no ring entry holds. */
export function assertViewerOutputBound(viewer: ViewerOutputs): void {
  const bound = viewer.output_max_bytes();
  if (bound !== VIEWER_OUTPUT_MAX_BYTES) {
    throw new Error(
      `viewer outputs are bounded at ${bound} bytes, their ring at ${VIEWER_OUTPUT_MAX_BYTES}`,
    );
  }
}

export function createViewerOutputPublisher(
  writer: ViewerOutputRingWriter,
  now: () => number,
): ViewerOutputPublisher {
  // One view of the viewer's linear memory, replaced only when growth detaches
  // it. Pointers into it stay valid across growth; the view does not.
  let heap = new Uint8Array(0);
  let heldKind = 0;
  let heldLineage = 0;
  let heldFrameFenceToken = 0;
  let wordsPointer = 0;
  let bytesPointer = 0;
  let payloadLength = 0;

  // The one payload source, repointed for each output: the seven words, then
  // the bytes. Copied byte by byte because a subarray per output is a view,
  // and an ACK is a few dozen bytes.
  const source: ViewerOutputSource = {
    get byteLength(): number {
      return payloadLength;
    },
    copyTo(destination: Uint8Array, destinationOffset: number): void {
      for (let index = 0; index < VIEWER_OUTPUT_WORDS_BYTES; index += 1) {
        destination[destinationOffset + index] = heap[wordsPointer + index] ?? 0;
      }
      const body = destinationOffset + VIEWER_OUTPUT_WORDS_BYTES;
      const bodyLength = payloadLength - VIEWER_OUTPUT_WORDS_BYTES;
      for (let index = 0; index < bodyLength; index += 1) {
        destination[body + index] = heap[bytesPointer + index] ?? 0;
      }
    },
  };

  function publishHeld(): boolean {
    // A refusal is counted before `write` returns, so the second try either
    // finds the room the reader freed meanwhile or is owed its space edge.
    return (
      writer.write(heldKind, heldLineage, heldFrameFenceToken, source) ||
      writer.write(heldKind, heldLineage, heldFrameFenceToken, source)
    );
  }

  return {
    drain(viewer, memory, lineage, frameFenceToken): boolean {
      let resumeWithHashes = false;
      for (;;) {
        if (heap.buffer !== memory.buffer) heap = new Uint8Array(memory.buffer);
        if (heldKind === 0) {
          const kind = viewer.poll_output(now());
          if (kind === 0) return resumeWithHashes;
          // Growth during the poll detaches the view taken above.
          if (heap.buffer !== memory.buffer) heap = new Uint8Array(memory.buffer);
          heldKind = kind;
          heldLineage = lineage;
          heldFrameFenceToken = frameFenceToken;
          wordsPointer = viewer.output_words_ptr();
          bytesPointer = viewer.output_bytes_ptr();
          payloadLength = VIEWER_OUTPUT_WORDS_BYTES + viewer.output_bytes_len();
          if (
            kind === OUTPUT_KIND_RESUME &&
            heap[wordsPointer + RESUME_HASHES_WORD_OFFSET] === 1 &&
            heap[wordsPointer + RESUME_HASHES_WORD_OFFSET + 1] === 0 &&
            heap[wordsPointer + RESUME_HASHES_WORD_OFFSET + 2] === 0 &&
            heap[wordsPointer + RESUME_HASHES_WORD_OFFSET + 3] === 0
          ) {
            resumeWithHashes = true;
          }
        }
        if (!publishHeld()) return resumeWithHashes;
        heldKind = 0;
      }
    },

    reset(): void {
      heldKind = 0;
    },
  };
}
