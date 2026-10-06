import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { MESSAGE_TYPE_DISPLAY_REPAIR_END } from '@merkur/protocol';

import {
  DISPLAY_CHUNK_COUNT_OFFSET,
  DISPLAY_CHUNK_INDEX_OFFSET,
  DISPLAY_COLOR_MODE_INDEXED,
  DISPLAY_COMPRESSED_LENGTH_OFFSET,
  DISPLAY_COMPRESSED_PAYLOAD_OFFSET,
  DISPLAY_DATAGRAM_HEADER_BODY_LENGTH_OFFSET,
  DISPLAY_DATAGRAM_HEADER_FLAGS_OFFSET,
  DISPLAY_FRAME_ID_OFFSET,
  DISPLAY_GENERATION_OFFSET,
  DISPLAY_HEADER_FLAG_COMPRESSED_ZSTD,
  DISPLAY_HEADER_FLAG_FEC_PROTECTED,
  DISPLAY_PATCH_FLAG_PRESENTATION_COHERENT,
  DISPLAY_PATCH_FLAG_PRESENTATION_END,
  DISPLAY_PATCH_FLAG_RESET,
  DISPLAY_PATCH_FLAGS_OFFSET,
  DISPLAY_PRESENTATION_ID_OFFSET,
  DISPLAY_PRESENTATION_MEMBER_COUNT_OFFSET,
  DISPLAY_PRESENTATION_MEMBER_INDEX_OFFSET,
  DISPLAY_PROTOCOL_VERSION,
  DISPLAY_ROW_COUNT_OFFSET,
  DISPLAY_ROW_PREFIX_BYTES,
  DISPLAY_ROWS_OFFSET,
  DISPLAY_SEQUENCE_OFFSET,
  DISPLAY_STREAM_HEADER_BYTES,
  DISPLAY_VERSION_OFFSET,
  MAX_TERMINAL_CELLS,
  MAX_TERMINAL_ROWS,
  MESSAGE_TYPE_DISPLAY_PATCH,
  TRANSPORT_CHANNEL_ID,
  writeU32BE,
} from '@merkur/shared';
import loadWasm, { init_display_receiver_calibration } from './term-wasm/pkg/term_wasm.js';
import { displayProcessSliceBudgetMs } from './terminal/display-process-budget';
import { createFirstDisplayGpuFenceTracker } from './terminal/first-display-gpu-fence';
import {
  createFrameRingReader,
  createFrameRingWriter,
  FRAME_KIND_CLIENT_INGRESS_BASE,
  FRAME_RING_SIZE,
  FRAME_RING_SPACE_EDGE,
} from './terminal/shared-ring';
import { createViewerOutputPublisher } from './terminal/viewer-output-publisher';
import {
  createViewerOutputRingReader,
  createViewerOutputRingWriter,
  VIEWER_OUTPUT_RING_SIZE,
} from './terminal/viewer-output-ring';
import {
  createWasmClientViewerHandleFromInstance,
  preloadWasmTerminalRuntime,
  type WasmClientViewerHandle,
} from './wasm-loader';

const ROWS = MAX_TERMINAL_ROWS;
const COLS = MAX_TERMINAL_CELLS / ROWS;
const INPUT_MAPPING = { epoch: 1, localMinusWire: 0, wireMin: 1, wireMax: 0xffff_ffff };
const workerSource = readFileSync(new URL('./terminal-worker.ts', import.meta.url), 'utf8');

/** The ring the production `drainViewerOutputs` publishes to, and what it holds. */
function viewerOutputRing(now: () => number = () => 10) {
  const ring = new SharedArrayBuffer(VIEWER_OUTPUT_RING_SIZE);
  const reader = createViewerOutputRingReader(ring);
  return {
    viewerOutputPublisher: createViewerOutputPublisher(createViewerOutputRingWriter(ring), now),
    /** Every entry published since the last call. */
    entries(): { kind: number; lineage: number; frameFenceToken: number }[] {
      const entries = [];
      while (reader.nextLength() >= 0) {
        entries.push({
          kind: reader.kind(),
          lineage: reader.lineage(),
          frameFenceToken: reader.frameFenceToken(),
        });
        reader.consume();
      }
      return entries;
    },
  };
}

/** Run the actual worker adapter with only host clocks, GPU and control scheduling supplied. */
function productionFunctions(names: readonly string[]): string {
  return new Bun.Transpiler({ loader: 'ts' }).transformSync(
    names
      .map((name) => {
        const start = workerSource.indexOf(`function ${name}(`);
        const end = workerSource.indexOf('\n}', start);
        if (start < 0 || end < start) throw new Error(`missing production callback ${name}`);
        return workerSource.slice(start, end + 2);
      })
      .join('\n'),
  );
}
const ownerProgram = productionFunctions([
  'consumeDisplayRingEntry',
  'hasDisplayOwnerWork',
  'drainDisplayQueue',
  'runDisplayPump',
]);

async function createViewer(): Promise<WasmClientViewerHandle> {
  await preloadWasmTerminalRuntime();
  const runtime = await loadWasm();
  return createWasmClientViewerHandleFromInstance(
    runtime.memory,
    init_display_receiver_calibration(COLS, ROWS),
  );
}

function createHarness(terminal: WasmClientViewerHandle, costMs = 0) {
  const ring = new SharedArrayBuffer(FRAME_RING_SIZE);
  const reader = createFrameRingReader(ring),
    writer = createFrameRingWriter(ring);
  let now = 1,
    continuations = 0,
    controls = 0,
    receives = 0;
  const outputs: { kind: number; bytes: Uint8Array }[] = [];
  const context = {
    wasmTerminal: {
      ...terminal,
      receive(at: number, channel: number, bytes: Uint8Array, mapping: typeof INPUT_MAPPING) {
        receives++;
        const accepted = terminal.receive(at, channel, bytes, mapping);
        now += costMs;
        return accepted;
      },
    },
    frameRingReader: reader,
    FRAME_KIND_CLIENT_INGRESS_BASE,
    FRAME_RING_SPACE_EDGE,
    ringWakePort: { postMessage() {} },
    displayOwnerActive: false,
    displayOwnerDatagrams: 0,
    frameRingPumpActive: true,
    displayEpoch: { pumpScheduled: false },
    displayPumpContinuation: { cancel() {} },
    performance: { now: () => now },
    nowMs: () => now,
    viewerNowMs: () => now,
    controlPumpActive: false,
    activeControlBlocksDataPlane: false,
    controlQueue: { hasDataPlaneBarrier: () => false },
    controlQueueSize: () => 0,
    scheduleControlPump() {
      controls++;
    },
    continueDisplayOwner() {
      if (reader.hasPending()) continuations++;
    },
    tuning: { displayProcessBudgetMs: 6 },
    refreshRate: { presentationPeriodMs: () => 16.67 },
    displayProcessSliceBudgetMs,
    renderer: { canSubmitFrame: () => true },
    rendererContextLost: false,
    perfEnabled: false,
    perfWriter: null,
    observeViewerPresentation() {},
    publishPredictionModel() {},
    renderPredictionIfDirty() {},
    scheduleRenderFrame() {},
    armPresentationCommit() {},
    armViewerDeadline() {},
    drainViewerOutputs() {
      let kind = terminal.viewer.poll_output(now);
      while (kind !== 0) {
        outputs.push({
          kind,
          bytes: new Uint8Array(
            terminal.memory.buffer,
            terminal.viewer.output_bytes_ptr(),
            terminal.viewer.output_bytes_len(),
          ).slice(),
        });
        kind = terminal.viewer.poll_output(now);
      }
    },
  };
  runInNewContext(ownerProgram, context);
  return {
    context,
    reader,
    writer,
    outputs,
    run() {
      runInNewContext('runDisplayPump();', context);
    },
    write(bytes: Uint8Array, channel: number = TRANSPORT_CHANNEL_ID.displayDatagram) {
      expect(
        writer.write(
          bytes,
          FRAME_KIND_CLIENT_INGRESS_BASE + channel,
          channel === TRANSPORT_CHANNEL_ID.displayCommit,
          INPUT_MAPPING,
        ),
      ).toBe(true);
    },
    get receives() {
      return receives;
    },
    get continuations() {
      return continuations;
    },
    get controls() {
      return controls;
    },
  };
}

function writeU16BE(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = (value >>> 8) & 0xff;
  bytes[offset + 1] = value & 0xff;
}

function encodeVarint(value: number, out: number[]): void {
  let remaining = value >>> 0;
  while (remaining >= 0x80) {
    out.push((remaining & 0x7f) | 0x80);
    remaining >>>= 7;
  }
  out.push(remaining);
}

function encodeRow(text: string): Uint8Array {
  const encoded: number[] = [DISPLAY_COLOR_MODE_INDEXED];
  const cells = Array.from(text);
  let index = 0;
  while (index < cells.length) {
    const cell = cells[index] ?? ' ';
    let runLength = 1;
    while (index + runLength < cells.length && cells[index + runLength] === cell) {
      runLength += 1;
    }
    encoded.push(runLength > 1 ? 0x80 : 0);
    encodeVarint(cell.codePointAt(0) ?? 0, encoded);
    if (runLength > 1) encodeVarint(runLength, encoded);
    index += runLength;
  }
  return Uint8Array.from(encoded);
}

/**
 * The rows' split payload, as `merkur_codec::split_rows_into` writes it. These
 * rows carry no colours, links or graphics, so the colour, link and graphics
 * regions are empty and every row is in indexed colour mode.
 */
function splitPayload(
  rows: readonly { readonly row: number; readonly text: string }[],
): Uint8Array {
  const tags: number[] = [];
  const runs: number[] = [];
  for (const entry of rows) {
    const cells = Array.from(entry.text);
    let index = 0;
    while (index < cells.length) {
      const cell = cells[index] ?? ' ';
      let runLength = 1;
      while (index + runLength < cells.length && cells[index + runLength] === cell) {
        runLength += 1;
      }
      tags.push(runLength > 1 ? 0x80 : 0);
      encodeVarint(cell.codePointAt(0) ?? 0, runs);
      if (runLength > 1) encodeVarint(runLength, runs);
      index += runLength;
    }
  }
  const out: number[] = [];
  encodeVarint(tags.length, out);
  out.push(0, 0);
  const field = (value: number) => out.push(value >>> 8, value & 0xff);
  for (const entry of rows) field(entry.row);
  for (const _ of rows) field(0);
  for (const entry of rows) field(entry.text.length);
  for (const _ of rows) out.push(DISPLAY_COLOR_MODE_INDEXED);
  out.push(...tags, ...runs);
  return Uint8Array.from(out);
}

/**
 * Rewrite a standard zstd frame as the display payload's frame: magicless,
 * with a window descriptor in place of the frame content size and no checksum.
 * The blocks are unchanged; a window covering the content decodes them.
 */
function magiclessFrame(standard: Uint8Array): Uint8Array {
  const descriptor = standard[4] ?? 0;
  const singleSegment = (descriptor & 0x20) !== 0;
  const dictionaryBytes = [0, 1, 2, 4][descriptor & 0x03] ?? 0;
  const contentSizeBytes = [singleSegment ? 1 : 0, 2, 4, 8][descriptor >>> 6] ?? 0;
  let offset = 5;
  let windowDescriptor = standard[offset] ?? 0;
  if (singleSegment) {
    const view = new DataView(standard.buffer, standard.byteOffset);
    const at = offset + dictionaryBytes;
    const contentSize =
      contentSizeBytes === 1
        ? view.getUint8(at)
        : contentSizeBytes === 2
          ? view.getUint16(at, true) + 256
          : view.getUint32(at, true);
    windowDescriptor = Math.max(0, Math.ceil(Math.log2(Math.max(contentSize, 1))) - 10) << 3;
  } else {
    offset += 1;
  }
  const dictionary = standard.subarray(offset, offset + dictionaryBytes);
  const blocksEnd = standard.byteLength - ((descriptor & 0x04) !== 0 ? 4 : 0);
  const blocks = standard.subarray(offset + dictionaryBytes + contentSizeBytes, blocksEnd);
  return Uint8Array.from([descriptor & 0x03, windowDescriptor, ...dictionary, ...blocks]);
}

interface FrameSpec {
  readonly generation: number;
  readonly seq: number;
  readonly frameId: number;
  readonly presentationId: number;
  readonly rows: readonly { readonly row: number; readonly text: string }[];
  readonly snapshot?: boolean;
  readonly chunkIndex?: number;
  readonly chunkCount?: number;
  readonly memberIndex?: number;
  readonly memberCount?: number;
  readonly coherent?: boolean;
  readonly end?: boolean;
  readonly compressed?: boolean;
  readonly fecProtected?: boolean;
}

function buildFrame(spec: FrameSpec): Uint8Array {
  const encodedRows = spec.rows.map((entry) => ({ ...entry, cells: encodeRow(entry.text) }));
  const rowsLength = encodedRows.reduce(
    (total, entry) => total + DISPLAY_ROW_PREFIX_BYTES + entry.cells.byteLength,
    0,
  );
  const raw = new Uint8Array(DISPLAY_ROWS_OFFSET + rowsLength);
  raw[0] = MESSAGE_TYPE_DISPLAY_PATCH;
  writeU32BE(raw, DISPLAY_SEQUENCE_OFFSET, spec.seq);
  writeU32BE(raw, DISPLAY_GENERATION_OFFSET, spec.generation);
  raw[DISPLAY_VERSION_OFFSET] = DISPLAY_PROTOCOL_VERSION;
  raw[DISPLAY_PATCH_FLAGS_OFFSET] =
    (spec.snapshot === true ? DISPLAY_PATCH_FLAG_RESET : 0) |
    (spec.coherent === true ? DISPLAY_PATCH_FLAG_PRESENTATION_COHERENT : 0) |
    (spec.end === true ? DISPLAY_PATCH_FLAG_PRESENTATION_END : 0);
  writeU16BE(raw, DISPLAY_STREAM_HEADER_BYTES + 2, COLS);
  writeU16BE(raw, DISPLAY_STREAM_HEADER_BYTES + 4, ROWS);
  // Visible block cursor at the first cell. Cursor fields occupy body bytes
  // 6..12 and are deliberately stable across these grid-only workloads.
  raw[DISPLAY_STREAM_HEADER_BYTES + 10] = 0x10;
  writeU32BE(raw, DISPLAY_FRAME_ID_OFFSET, spec.frameId);
  writeU32BE(raw, DISPLAY_PRESENTATION_ID_OFFSET, spec.presentationId);
  writeU16BE(raw, DISPLAY_CHUNK_INDEX_OFFSET, spec.chunkIndex ?? 0);
  writeU16BE(raw, DISPLAY_CHUNK_COUNT_OFFSET, spec.chunkCount ?? 1);
  writeU16BE(raw, DISPLAY_ROW_COUNT_OFFSET, encodedRows.length);
  writeU16BE(raw, DISPLAY_PRESENTATION_MEMBER_INDEX_OFFSET, spec.memberIndex ?? 0);
  writeU16BE(raw, DISPLAY_PRESENTATION_MEMBER_COUNT_OFFSET, spec.memberCount ?? 0);
  let offset = DISPLAY_ROWS_OFFSET;
  for (const entry of encodedRows) {
    writeU16BE(raw, offset, entry.row);
    writeU16BE(raw, offset + 2, 0);
    writeU16BE(raw, offset + 4, entry.text.length);
    writeU16BE(raw, offset + 6, entry.cells.byteLength);
    raw.set(entry.cells, offset + DISPLAY_ROW_PREFIX_BYTES);
    offset += DISPLAY_ROW_PREFIX_BYTES + entry.cells.byteLength;
  }
  writeU32BE(
    raw,
    DISPLAY_DATAGRAM_HEADER_BODY_LENGTH_OFFSET,
    raw.byteLength - DISPLAY_STREAM_HEADER_BYTES,
  );
  if (spec.compressed !== true) {
    if (spec.fecProtected === true) {
      raw[DISPLAY_DATAGRAM_HEADER_FLAGS_OFFSET] =
        (raw[DISPLAY_DATAGRAM_HEADER_FLAGS_OFFSET] ?? 0) | DISPLAY_HEADER_FLAG_FEC_PROTECTED;
    }
    return raw;
  }
  const compressedRows = magiclessFrame(
    Bun.zstdCompressSync(splitPayload(spec.rows), { level: 3 }),
  );
  const wire = new Uint8Array(DISPLAY_COMPRESSED_PAYLOAD_OFFSET + compressedRows.byteLength);
  wire.set(raw.subarray(0, DISPLAY_ROWS_OFFSET));
  wire[DISPLAY_DATAGRAM_HEADER_FLAGS_OFFSET] =
    DISPLAY_HEADER_FLAG_COMPRESSED_ZSTD |
    (spec.fecProtected === true ? DISPLAY_HEADER_FLAG_FEC_PROTECTED : 0);
  writeU32BE(wire, DISPLAY_COMPRESSED_LENGTH_OFFSET, rowsLength);
  wire.set(compressedRows, DISPLAY_COMPRESSED_PAYLOAD_OFFSET);
  writeU32BE(
    wire,
    DISPLAY_DATAGRAM_HEADER_BODY_LENGTH_OFFSET,
    wire.byteLength - DISPLAY_STREAM_HEADER_BYTES,
  );
  return wire;
}

function fullGridRows(marker: string): { row: number; text: string }[] {
  return Array.from({ length: ROWS }, (_, row) => ({
    row,
    text: `${marker}-${row.toString(16).padStart(2, '0')}`.padEnd(COLS, marker),
  }));
}

describe('ClientViewer terminal worker SAB adapter', () => {
  test('one wake applies three compressed max-grid frames and releases every lease', async () => {
    const terminal = await createViewer();
    try {
      const harness = createHarness(terminal);
      harness.write(
        buildFrame({
          generation: 7,
          seq: 0,
          frameId: 1,
          presentationId: 1,
          snapshot: true,
          compressed: true,
          rows: fullGridRows('a'),
        }),
        TRANSPORT_CHANNEL_ID.displayCommit,
      );
      for (const seq of [1, 2])
        harness.write(
          buildFrame({
            generation: 7,
            seq,
            frameId: seq + 1,
            presentationId: seq + 1,
            compressed: true,
            rows: fullGridRows(seq === 1 ? 'b' : 'c'),
          }),
        );
      harness.run();
      expect(harness.reader.hasPending()).toBe(false);
      expect(harness.receives).toBe(3);
      expect(terminal.viewer.applied_frames()).toBe(3);
      expect(terminal.viewer.applied_sequence()).toBe(2);
      expect(terminal.displayRowVersion(ROWS - 1)).toBe(2);
      expect(harness.outputs.some((output) => output.kind === 1)).toBe(true);
      // A released leased ring has its complete capacity available again.
      harness.write(
        buildFrame({
          generation: 7,
          seq: 3,
          frameId: 4,
          presentationId: 4,
          rows: fullGridRows('d'),
        }),
      );
      harness.run();
      expect(terminal.viewer.applied_sequence()).toBe(3);
    } finally {
      terminal.destroy();
    }
  });

  test('slice budgets yield between complete Rust transforms and retain unread SAB bytes', async () => {
    const terminal = await createViewer();
    try {
      const harness = createHarness(terminal, 20);
      harness.write(
        buildFrame({
          generation: 4,
          seq: 0,
          frameId: 1,
          presentationId: 1,
          snapshot: true,
          rows: fullGridRows('a'),
        }),
        TRANSPORT_CHANNEL_ID.displayCommit,
      );
      for (const seq of [1, 2])
        harness.write(
          buildFrame({
            generation: 4,
            seq,
            frameId: seq + 1,
            presentationId: seq + 1,
            rows: fullGridRows('b'),
          }),
        );
      harness.run();
      expect(harness.receives).toBe(1);
      expect(harness.reader.hasPending()).toBe(true);
      expect(harness.continuations).toBe(1);
      harness.run();
      harness.run();
      expect(harness.receives).toBe(3);
      expect(harness.reader.hasPending()).toBe(false);
      expect(terminal.viewer.applied_sequence()).toBe(2);
    } finally {
      terminal.destroy();
    }
  });

  test('pending controls and ownership barriers keep the unread lease with the ring', async () => {
    const terminal = await createViewer();
    try {
      const harness = createHarness(terminal);
      harness.write(
        buildFrame({
          generation: 4,
          seq: 0,
          frameId: 1,
          presentationId: 1,
          snapshot: true,
          rows: fullGridRows('a'),
        }),
      );
      harness.context.controlQueue.hasDataPlaneBarrier = () => true;
      harness.run();
      expect(harness.receives).toBe(0);
      expect(harness.reader.hasPending()).toBe(true);
      expect(harness.controls).toBe(1);
      harness.context.controlQueue.hasDataPlaneBarrier = () => false;
      harness.context.controlQueueSize = () => 1;
      harness.run();
      expect(harness.receives).toBe(0);
      harness.context.controlPumpActive = true;
      harness.run();
      expect(harness.receives).toBe(1);
      expect(harness.reader.hasPending()).toBe(false);
    } finally {
      terminal.destroy();
    }
  });

  test('ahead deltas remain Rust-owned until their snapshot roots the generation', async () => {
    const terminal = await createViewer();
    try {
      const harness = createHarness(terminal);
      terminal.viewer.fence(0, 1);
      harness.write(
        buildFrame({
          generation: 9,
          seq: 1,
          frameId: 2,
          presentationId: 2,
          rows: [{ row: 1, text: 'ahead'.padEnd(COLS, 'a') }],
        }),
      );
      harness.run();
      expect(terminal.viewer.applied_frames()).toBe(0);
      harness.write(
        buildFrame({
          generation: 9,
          seq: 0,
          frameId: 1,
          presentationId: 1,
          snapshot: true,
          rows: fullGridRows('s'),
        }),
        TRANSPORT_CHANNEL_ID.displayCommit,
      );
      harness.run();
      expect(terminal.viewer.applied_frames()).toBe(2);
      expect(terminal.displayRowVersion(1)).toBe(1);
      expect(terminal.viewer.applied_sequence()).toBe(1);
    } finally {
      terminal.destroy();
    }
  });

  test('a superseding snapshot releases an incomplete Rust assembly and applies whole', async () => {
    const terminal = await createViewer();
    try {
      const harness = createHarness(terminal);
      harness.write(
        buildFrame({
          generation: 9,
          seq: 0,
          frameId: 1,
          presentationId: 1,
          snapshot: true,
          chunkCount: 2,
          rows: fullGridRows('x').slice(0, ROWS / 2),
        }),
        TRANSPORT_CHANNEL_ID.displayCommit,
      );
      harness.run();
      expect(terminal.viewer.applied_frames()).toBe(0);
      harness.write(
        buildFrame({
          generation: 9,
          seq: 0,
          frameId: 2,
          presentationId: 2,
          snapshot: true,
          rows: fullGridRows('s'),
        }),
        TRANSPORT_CHANNEL_ID.displayCommit,
      );
      harness.run();
      expect(terminal.viewer.applied_frames()).toBe(1);
      expect(terminal.viewer.applied_snapshot()).toBe(true);
      expect(terminal.viewer.applied_frame_id()).toBe(2);
    } finally {
      terminal.destroy();
    }
  });

  test('GPU capacity defers presentation promotion without delaying authority or ACK', async () => {
    const terminal = await createViewer();
    try {
      const harness = createHarness(terminal);
      harness.context.renderer.canSubmitFrame = () => false;
      harness.write(
        buildFrame({
          generation: 9,
          seq: 0,
          frameId: 1,
          presentationId: 1,
          snapshot: true,
          rows: fullGridRows('s'),
        }),
        TRANSPORT_CHANNEL_ID.displayCommit,
      );
      harness.run();
      const revision = terminal.presentationRevision();
      expect(terminal.viewer.applied_frames()).toBe(1);
      harness.write(
        buildFrame({
          generation: 9,
          seq: 1,
          frameId: 2,
          presentationId: 2,
          rows: [{ row: 1, text: 'authority'.padEnd(COLS, 'a') }],
        }),
      );
      harness.run();
      expect(terminal.viewer.applied_sequence()).toBe(1);
      expect(terminal.presentationRevision()).toBe(revision);
      expect(harness.outputs.some((output) => output.kind === 1)).toBe(true);
      harness.context.renderer.canSubmitFrame = () => true;
      harness.run();
      expect(terminal.presentationRevision()).toBeGreaterThan(revision);
    } finally {
      terminal.destroy();
    }
  });
});

test('a transaction held after the device slept releases at the next worker frame', async () => {
  // WebKit recomputes performance.timeOrigin on every read and moves it forward
  // by each device sleep; performance.now() and worker frame times never see it.
  const terminal = await createViewer();
  try {
    const harness = createHarness(terminal);
    let monotonic = 1;
    let origin = 1_790_000_000_000;
    Object.assign(harness.context, {
      performance: {
        now: () => monotonic,
        get timeOrigin() {
          return origin;
        },
      },
      graphicsVisible: true,
      srttMs: null,
      lastViewerFrameAtMs: -1,
      presentationReleaseBlockedByControl: () => false,
      activeSessionEpoch: 1,
      activeFrameFenceToken: 1,
      resumePresentationPending: false,
      viewerOutputPublisher: viewerOutputRing(() => monotonic).viewerOutputPublisher,
    });
    const workerOrigin = workerSource.indexOf('const WORKER_TIME_ORIGIN_MS =');
    runInNewContext(
      `${workerSource.slice(workerOrigin, workerSource.indexOf('\n', workerOrigin))}\n${productionFunctions(['nowMs', 'viewerNowMs', 'timeOriginDriftMs', 'applyViewerFrame', 'drainViewerOutputs'])}`,
      harness.context,
    );
    harness.write(
      buildFrame({
        generation: 7,
        seq: 0,
        frameId: 1,
        presentationId: 1,
        snapshot: true,
        rows: fullGridRows('a'),
      }),
      TRANSPORT_CHANNEL_ID.displayCommit,
    );
    harness.run();
    const shown = terminal.viewer.applied_presentations();
    origin += 70_000;
    monotonic += 5;
    harness.write(
      buildFrame({
        generation: 7,
        seq: 1,
        frameId: 2,
        presentationId: 2,
        coherent: true,
        end: true,
        memberIndex: 0,
        memberCount: 1,
        rows: [{ row: 0, text: 'after sleep'.padEnd(COLS, '.') }],
      }),
    );
    harness.run();
    expect(terminal.viewer.presentation_held()).toBe(true);
    monotonic += 16;
    runInNewContext(`applyViewerFrame(${monotonic})`, harness.context);
    expect(terminal.viewer.presentation_held()).toBe(false);
    expect(terminal.viewer.applied_presentations()).toBe(shown + 1);
    expect(terminal.presentationViewportRows()).toContain('after sleep');
  } finally {
    terminal.destroy();
  }
});

test('an idle matching resume earns first readiness only after its eligible GPU submission', async () => {
  const terminal = await createViewer();
  try {
    const harness = createHarness(terminal);
    harness.write(
      buildFrame({
        generation: 7,
        seq: 0,
        frameId: 1,
        presentationId: 1,
        snapshot: true,
        rows: fullGridRows('s'),
      }),
      TRANSPORT_CHANNEL_ID.displayCommit,
    );
    harness.run();
    const revision = terminal.presentationRevision();
    const tracker = createFirstDisplayGpuFenceTracker<{
      sessionEpoch: number;
      frameFenceToken: number;
      generation: number;
      frameId: number;
      displayKind: string;
    }>();
    const context = {
      wasmTerminal: terminal,
      activeSessionEpoch: 2,
      activeFrameFenceToken: 2,
      displayEpoch: {
        generation: 7,
        renderPending: false,
        stateReadyPending: false,
        stateAppliedPending: false,
        lastFrameAtMs: 0,
        lastSnapshotAtMs: 0,
      },
      observedViewerFrames: terminal.viewer.applied_frames(),
      observedViewerSnapshots: terminal.viewer.applied_snapshots(),
      observedViewerPresentations: terminal.viewer.applied_presentations(),
      observedPresentationRevision: revision,
      resumePresentationPending: false,
      resumeAppliedFrames: terminal.viewer.applied_frames(),
      graphicsOfferSpaceReleased: false,
      graphicsPresentationDirty: false,
      graphicsResidents: new Set<string>(),
      renderer: { hasGraphicsTile: () => false },
      graphicsEpoch: 2,
      localPresentationPending: false,
      authoritativePresentationUrgent: false,
      firstDisplayGpuFence: tracker,
      lastMouseMode: terminal.mouseMode(),
      perfEnabled: false,
      pendingPresentationTrace: false,
      nowMs: () => 10,
      viewerNowMs: () => 10,
      performance: { now: () => 10 },
      self: { postMessage() {} },
      ringWakePort: { postMessage() {} },
      viewerOutputPublisher: viewerOutputRing().viewerOutputPublisher,
      publishViewerLinks() {},
      syncDimensionsFromWasm() {},
      updatePhysDimensions() {},
      offscreenCanvas: null,
      physW: 80,
      physH: 24,
      displaySurfaceResizePending: false,
    };
    runInNewContext(
      productionFunctions(['observeViewerPresentation', 'drainViewerOutputs']),
      context,
    );
    terminal.viewer.fence(1, 2);
    runInNewContext('drainViewerOutputs()', context);
    expect(context.resumePresentationPending).toBe(true);
    const marker = new Uint8Array(14);
    marker[0] = MESSAGE_TYPE_DISPLAY_REPAIR_END;
    writeU16BE(marker, 2, 10);
    writeU32BE(marker, 4, 7);
    writeU32BE(marker, 8, 2);
    terminal.receive(10, TRANSPORT_CHANNEL_ID.ctrl, marker, INPUT_MAPPING);
    terminal.viewer.present_now(10);
    runInNewContext('observeViewerPresentation()', context);
    expect(terminal.presentationRevision()).toBe(revision);
    expect(context.displayEpoch.renderPending).toBe(true);
    expect(tracker.awaitingFirstApplied()).toBe(false);
    expect(tracker.noteCompleted(true)).toBeNull();
    tracker.noteSubmitted(true);
    expect(tracker.noteCompleted(true)).toEqual({
      sessionEpoch: 2,
      frameFenceToken: 2,
      generation: 7,
      frameId: 0,
      displayKind: 'display_resume',
    });
  } finally {
    terminal.destroy();
  }
});

test('account replacement discards the old Viewer and admits a fresh lineage one', async () => {
  const terminal = await createViewer();
  try {
    const initialPredictionState = terminal.viewer.prediction_state();
    const harness = createHarness(terminal);
    terminal.viewer.fence(0, 3);
    harness.write(
      buildFrame({
        generation: 7,
        seq: 0,
        frameId: 1,
        presentationId: 1,
        snapshot: true,
        rows: fullGridRows('secret'),
      }),
      TRANSPORT_CHANNEL_ID.displayCommit,
    );
    harness.run();
    expect(terminal.presentationViewportRows()).toContain('secret');
    const oldRevision = terminal.presentationRevision();
    harness.write(
      buildFrame({
        generation: 7,
        seq: 1,
        frameId: 2,
        presentationId: 2,
        chunkIndex: 0,
        chunkCount: 2,
        rows: [{ row: 0, text: 'old held chunk'.padEnd(COLS, 'x') }],
      }),
    );
    harness.run();
    const messages: { kind: string; lineage: number; frameFenceToken: number }[] = [];
    const viewerOutputs = viewerOutputRing();
    const context = {
      ...harness.context,
      renderer: { ...harness.context.renderer, clearGraphics() {} },
      ringWakePort: { postMessage: (message: (typeof messages)[number]) => messages.push(message) },
      viewerOutputPublisher: viewerOutputs.viewerOutputPublisher,
      activeSessionEpoch: 3,
      activeFrameFenceToken: 3,
      observedViewerFrames: terminal.viewer.applied_frames(),
      observedViewerSnapshots: terminal.viewer.applied_snapshots(),
      observedViewerPresentations: terminal.viewer.applied_presentations(),
      observedPresentationRevision: terminal.presentationRevision(),
      resumePresentationPending: false,
      resumeAppliedFrames: 0,
      localPresentationPending: false,
      lastMouseMode: -1,
      preeditActive: false,
      clearQueuedPredictions() {},
      finishPerfGridConvergence() {},
      displayOutputSettle: { reset() {} },
      abandonInFlightLatencyFrame() {},
      firstDisplayGpuFence: { resetEpoch() {} },
      presentedPredictionSources: { reset() {} },
      provisionalPreview: { clear() {} },
      predictionModelThroughInputSeq: 0,
      pendingPresentationTrace: false,
      authoritativePresentationUrgent: false,
      graphicsPresentationDirty: false,
      graphicsOfferSpaceReleased: false,
      graphicsEpoch: 3,
      controlsGeometry: false,
      receivedGeometryState: null,
      graphicsOwner: '',
      observedLinkRevision: 0,
      retireWaitingGraphicsAsset() {},
      graphicsResidents: new Set<string>(),
      crypto,
      applyGeometryAuthority() {},
      publishViewerLinks() {},
      displayAvailableWake: { wake() {} },
    };
    runInNewContext(productionFunctions(['applyPeerFence', 'drainViewerOutputs']), context);
    runInNewContext(
      "applyPeerFence({kind:'client_session_fence',newSession:true,lineage:1,frameFenceToken:4})",
      context,
    );
    expect(context.activeSessionEpoch).toBe(1);
    expect(context.activeFrameFenceToken).toBe(4);
    expect(
      messages.some(
        (message) =>
          message.kind === 'client_viewer_fenced' &&
          message.lineage === 1 &&
          message.frameFenceToken === 4,
      ),
    ).toBe(true);
    expect(
      messages.every((message) => message.lineage === 1 && message.frameFenceToken === 4),
    ).toBe(true);
    expect(terminal.viewer.generation()).toBe(0);
    expect(terminal.viewer.applied_frames()).toBe(0);
    expect(terminal.viewer.prediction_state()).toBe(initialPredictionState);
    expect(terminal.viewer.prediction_armed()).toBe(false);
    expect(terminal.mouseMode()).toBe(0);
    expect(terminal.presentationViewportRows()).not.toContain('secret');
    expect(terminal.presentationRevision()).toBeGreaterThan(oldRevision);
    let output = terminal.viewer.poll_output(10);
    const outputs: number[] = [];
    while (output !== 0) {
      outputs.push(output);
      output = terminal.viewer.poll_output(10);
    }
    // What the fresh viewer asked of its session went to the ring, under the
    // new lineage and fence, and none of it is the old lineage's ACK.
    const published = viewerOutputs.entries();
    expect(published.length).toBeGreaterThan(0);
    expect(published.every((entry) => entry.lineage === 1 && entry.frameFenceToken === 4)).toBe(
      true,
    );
    expect(published.map((entry) => entry.kind)).not.toContain(1);
    expect(outputs).not.toContain(1);
    harness.write(
      buildFrame({
        generation: 1,
        seq: 0,
        frameId: 1,
        presentationId: 1,
        snapshot: true,
        rows: fullGridRows('new'),
      }),
      TRANSPORT_CHANNEL_ID.displayCommit,
    );
    harness.run();
    expect(terminal.viewer.generation()).toBe(1);
    expect(terminal.viewer.applied_frames()).toBe(1);
    expect(terminal.presentationViewportRows()).toContain('new');
    expect(terminal.presentationViewportRows()).not.toContain('secret');
  } finally {
    terminal.destroy();
  }
});
