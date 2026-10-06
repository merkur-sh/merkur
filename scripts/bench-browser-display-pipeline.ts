/**
 * Production browser display pipeline:
 * frame-ring receipt -> parse/zstd WASM decode -> terminal WASM apply -> geometry.
 */
import path from 'node:path';
import {
  browserDisplayCopiedBytesPerPayloadByte,
  type MutableBrowserDisplayIoAccounting,
  noteBrowserDisplayAllocationRequest,
  noteBrowserDisplayCopy,
  noteBrowserDisplayObjectAllocationRequest,
  resetBrowserDisplayIoAccounting,
} from '../apps/web/src/perf/browser-display-io';
import {
  DISPLAY_RECEIVER_CALIBRATION_COLS,
  DISPLAY_RECEIVER_CALIBRATION_ROWS,
  runDisplayReceiverCalibrationSynchronously,
} from '../apps/web/src/terminal/display-receiver-calibration';
import {
  createDisplayReceiverProfileBuffer,
  createDisplayReceiverProfileReader,
  createDisplayReceiverProfileWriter,
} from '../apps/web/src/terminal/display-receiver-profile';
import {
  createFrameRingReader,
  createFrameRingWriter,
  FRAME_KIND_DISPLAY,
  FRAME_RING_SIZE,
} from '../apps/web/src/terminal/shared-ring';
import {
  DISPLAY_CHUNK_COUNT_OFFSET,
  DISPLAY_CHUNK_INDEX_OFFSET,
  DISPLAY_COLOR_MODE_INDEXED,
  DISPLAY_COLUMNS_OFFSET,
  DISPLAY_COMPRESSED_LENGTH_OFFSET,
  DISPLAY_COMPRESSED_PAYLOAD_OFFSET,
  DISPLAY_DATAGRAM_HEADER_BODY_LENGTH_OFFSET,
  DISPLAY_DATAGRAM_HEADER_FLAGS_OFFSET,
  DISPLAY_DEMAND_SERIAL_OFFSET,
  DISPLAY_DICT_COMPRESSED_PAYLOAD_OFFSET,
  DISPLAY_FRAME_ID_OFFSET,
  DISPLAY_GENERATION_OFFSET,
  DISPLAY_GRID_ROWS_OFFSET,
  DISPLAY_HEADER_FLAG_COMPRESSED_ZSTD,
  DISPLAY_HEADER_FLAG_COMPRESSED_ZSTD_DICT,
  DISPLAY_MESSAGE_TYPE_OFFSET,
  DISPLAY_PATCH_FLAG_RESET,
  DISPLAY_PATCH_FLAGS_OFFSET,
  DISPLAY_PRESENTATION_ID_OFFSET,
  DISPLAY_PROTOCOL_VERSION,
  DISPLAY_ROW_COUNT_OFFSET,
  DISPLAY_ROW_PREFIX_BYTES,
  DISPLAY_ROWS_OFFSET,
  DISPLAY_SEQUENCE_OFFSET,
  DISPLAY_STREAM_HEADER_BYTES,
  DISPLAY_VERSION_OFFSET,
  MESSAGE_TYPE_DISPLAY_PATCH,
  writeU32BE,
} from '../packages/shared/src';
import { createViewerDriver } from './perf/client-viewer-driver';
import { loadBenchmarkTerminal } from './perf/declared-terminal';
import { createTextRowBody, trainFixtureDictionary } from './perf/display-text-rows';
import { createGeometryCountReader } from './perf/geometry-counts';
import { emitPerfMetric, summarizeSamples } from './perf/harness';
import { builtZstdFixtureExecutable } from './perf/zstd-fixture';

const ROOT = path.resolve(import.meta.dir, '..');
const SAMPLES = positiveInteger('BENCH_SAMPLES', 1_000);
const WARMUPS = positiveInteger('BENCH_WARMUPS', 100);
const SKIP_GEOMETRY = process.env.BENCH_SKIP_GEOMETRY === '1';
const SCENARIO = process.argv[2] ?? process.env.BENCH_BROWSER_SCENARIO ?? 'compressed-full';
const FIXTURE_BINARY = await builtZstdFixtureExecutable();

const { wasm, runtime: wasmRuntime, terminal } = await loadBenchmarkTerminal(960, 640);
let frameInputPtr = 0;
let frameInputCapacity = 0;
const cols = terminal.cols();
const rows = terminal.rows();
if (cols <= 0 || cols > 255 || rows <= 0) {
  throw new Error(`unsupported benchmark terminal geometry ${cols}x${rows}`);
}

const calibrationProfileBuffer = createDisplayReceiverProfileBuffer();
const calibrationStarted = performance.now();
const calibrationTerminal = wasm.init_display_receiver_calibration(
  DISPLAY_RECEIVER_CALIBRATION_COLS,
  DISPLAY_RECEIVER_CALIBRATION_ROWS,
);
let calibrationFrameInputPtr = 0;
let calibrationFrameInputCapacity = 0;
const calibrationError = runDisplayReceiverCalibrationSynchronously(
  {
    destroy: () => calibrationTerminal.free(),
    applyDelta: (data, frameSeq) => calibrationTerminal.apply_delta_seq(data, frameSeq),
    installDisplayDictionary: (generation, id, hash, bytes) =>
      calibrationTerminal.install_display_dictionary(generation, id, hash, bytes),
    clearDisplayDictionaries: () => calibrationTerminal.clear_display_dictionaries(),
    stageDisplayFrame: (data) => {
      if (data.byteLength > calibrationFrameInputCapacity) {
        calibrationFrameInputPtr = calibrationTerminal.reserve_display_frame_input(data.byteLength);
        if (calibrationFrameInputPtr === 0) return 0;
        calibrationFrameInputCapacity = data.byteLength;
      }
      new Uint8Array(wasmRuntime.memory.buffer, calibrationFrameInputPtr, data.byteLength).set(
        data,
      );
      return calibrationTerminal.stage_display_frame_input(data.byteLength);
    },
    validateStagedFrame: (handle) => calibrationTerminal.validate_staged_frame(handle),
    applyStagedDelta: (handle, frameSeq) =>
      calibrationTerminal.apply_staged_delta_seq(handle, frameSeq),
    releaseStagedFrame: (handle) => calibrationTerminal.release_staged_frame(handle),
    resetDisplayOrdering: () => calibrationTerminal.reset_display_ordering(),
    takeLastError: () => calibrationTerminal.take_last_error() ?? null,
  },
  createDisplayReceiverProfileWriter(calibrationProfileBuffer),
);
const calibrationMs = performance.now() - calibrationStarted;
if (calibrationError !== null) {
  throw new Error(`production receiver calibration failed: ${calibrationError}`);
}
const calibrationProfile =
  createDisplayReceiverProfileReader(calibrationProfileBuffer).readIfChanged();
// How many buckets the fixtures fill depends on their compression ratios, so
// only an empty profile is a failure.
if (calibrationProfile === null || calibrationProfile.buckets.length === 0) {
  throw new Error('production receiver calibration emitted no buckets');
}

const initial = createBlankFrame(cols, rows, DISPLAY_PATCH_FLAG_RESET);
if (!terminal.apply_state_seq(initial, 0)) {
  throw new Error(`browser pipeline initial snapshot failed: ${terminal.take_last_error()}`);
}
const rawDelta = createBlankFrame(cols, rows, 0, SCENARIO.endsWith('one-row') ? 1 : rows);
const compressed = createCompressedDisplayFrame(rawDelta);
const receiverDictionary =
  SCENARIO === 'compressed-full' ? createBenchmarkDictionary(16 * 1024) : null;
if (
  receiverDictionary !== null &&
  !terminal.install_display_dictionary(1, 1, receiverDictionary.hash, receiverDictionary.bytes)
) {
  throw new Error(`browser pipeline dictionary install failed: ${terminal.take_last_error()}`);
}
const wireFrame =
  SCENARIO === 'raw-one-row' ? rawDelta : SCENARIO.startsWith('raw-') ? rawDelta : compressed;
const ring = new SharedArrayBuffer(FRAME_RING_SIZE);
const writer = createFrameRingWriter(ring);
const reader = createFrameRingReader(ring);
const viewerDriver = createViewerDriver(cols, rows);
const viewerGeometry = createGeometryCountReader(viewerDriver.memory, viewerDriver.viewer);
let seq = 1;
let checksum = 0;

for (let index = 0; index < WARMUPS; index += 1) {
  runPipeline(false);
  runPipeline(true);
}
const copiedPipelineSamples: number[] = [];
const leasedPipelineSamples: number[] = [];
for (let index = 0; index < SAMPLES; index += 1) {
  measurePipeline(false, copiedPipelineSamples);
  measurePipeline(true, leasedPipelineSamples);
}
const receiptPayload = new Uint8Array(64 * 1024);
for (let index = 0; index < receiptPayload.length; index += 1) {
  receiptPayload[index] = index & 0xff;
}
const copiedReceipt = benchmarkRingReceipt(false, receiptPayload);
const leasedReceipt = benchmarkRingReceipt(true, receiptPayload);
const explicitIo: MutableBrowserDisplayIoAccounting = {
  explicitCopyCount: 0,
  explicitCopiedBytes: 0,
  explicitAllocationRequestCount: 0,
  explicitAllocationRequestedBytes: 0,
  explicitObjectAllocationRequestCount: 0,
};
runPipeline(true, explicitIo);
const copiedBytesPerPayloadByte = browserDisplayCopiedBytesPerPayloadByte(
  explicitIo.explicitCopiedBytes,
  wireFrame.byteLength,
);
const expectedCopiesPerPayloadByte = 2;
if (copiedBytesPerPayloadByte !== expectedCopiesPerPayloadByte) {
  throw new Error(
    `explicit browser copy oracle drifted: expected ${expectedCopiesPerPayloadByte}, got ${String(copiedBytesPerPayloadByte)}`,
  );
}
const receiverSurface =
  receiverDictionary === null
    ? []
    : [1, 2, 4, 8, 16, rows]
        .filter((encodedRows, index, sizes) => sizes.indexOf(encodedRows) === index)
        .flatMap((encodedRows) => {
          const raw = createBlankFrame(cols, rows, 0, encodedRows);
          const plain = createCompressedDisplayFrame(raw);
          const dictionary = createCompressedDisplayFrame(raw, receiverDictionary);
          return [
            benchmarkReceiverRepresentation(raw, plain, false),
            benchmarkReceiverRepresentation(raw, dictionary, true),
          ];
        });
viewerDriver.close();
terminal.free();

const copiedPipeline = summarizeSamples(copiedPipelineSamples);
const leasedPipeline = summarizeSamples(leasedPipelineSamples);
process.stdout.write(
  `browser display pipeline: scenario=${SCENARIO} geometry=${cols}x${rows} wire=${wireFrame.byteLength}B ` +
    `raw-full=${rawDelta.byteLength}B samples=${SAMPLES}\n` +
    `production calibration=${calibrationMs.toFixed(3)}ms buckets=${calibrationProfile.buckets.length}\n` +
    `copied p50=${copiedPipeline.median.toFixed(6)}ms p95=${copiedPipeline.p95.toFixed(6)}ms; ` +
    `leased p50=${leasedPipeline.median.toFixed(6)}ms p95=${leasedPipeline.p95.toFixed(6)}ms ` +
    `checksum=${checksum}\n` +
    `64KiB ring receipt p50: copied=${copiedReceipt.median.toFixed(6)}ms ` +
    `leased=${leasedReceipt.median.toFixed(6)}ms\n` +
    `explicit steady-state Merkur I/O: copies=${explicitIo.explicitCopyCount} ` +
    `copied/payload=${copiedBytesPerPayloadByte.toFixed(3)}x ` +
    `allocationRequests=${explicitIo.explicitAllocationRequestCount} ` +
    `allocationRequested=${explicitIo.explicitAllocationRequestedBytes}B ` +
    `objectRequests=${explicitIo.explicitObjectAllocationRequestCount}; ` +
    `engine/crypto/allocator/GPU bytes=unmeasured\n`,
);
emitPerfMetric({
  name: 'browser-display-receiver-production-calibration',
  value: calibrationMs,
  unit: 'ms/op',
  direction: 'lower',
  sampleSize: 1,
});
for (const [name, result] of [
  ['browser-display-production-pipeline-copy', copiedPipeline],
  ['browser-display-production-pipeline', leasedPipeline],
] as const) {
  for (const [percentile, value] of [
    [0.5, result.median],
    [0.95, result.p95],
    [0.99, result.p99],
  ] as const) {
    emitPerfMetric({
      name,
      value,
      unit: 'ms/op',
      direction: 'lower',
      percentile,
      sampleSize: SAMPLES,
    });
  }
}
for (const [name, result] of [
  ['browser-display-ring-receipt-64k-copy', copiedReceipt],
  ['browser-display-ring-receipt-64k-lease', leasedReceipt],
] as const) {
  emitPerfMetric({
    name,
    value: result.median,
    unit: 'ms/op',
    direction: 'lower',
    percentile: 0.5,
    sampleSize: SAMPLES,
  });
}
for (const [name, value, unit] of [
  ['browser-display-explicit-copied-bytes-per-payload-byte', copiedBytesPerPayloadByte, 'B/B'],
  [
    'browser-display-explicit-allocation-requests-per-update',
    explicitIo.explicitAllocationRequestCount,
    'count/op',
  ],
  [
    'browser-display-explicit-object-allocation-requests-per-update',
    explicitIo.explicitObjectAllocationRequestCount,
    'count/op',
  ],
] as const) {
  emitPerfMetric({
    name,
    value,
    unit,
    direction: 'lower',
    sampleSize: 1,
  });
}
for (const point of receiverSurface) {
  const dictionaryClass = point.dictionary ? 'dict' : 'plain';
  process.stdout.write(
    `receiver surface raw=${point.rawBytes}B wire=${point.wireBytes}B ` +
      `ratio=${(point.wireBytes / point.rawBytes).toFixed(3)} dict=${point.dictionary ? 'yes' : 'no'} ` +
      `raw-p50=${point.raw.median.toFixed(6)}ms fused-p50=${point.fused.median.toFixed(6)}ms ` +
      `incremental-p50=${point.incremental.median.toFixed(6)}ms ` +
      `incremental-p95=${point.incremental.p95.toFixed(6)}ms\n`,
  );
  for (const [suffix, summary] of [
    [`raw-paired-${dictionaryClass}`, point.raw],
    [`fused-${dictionaryClass}`, point.fused],
    [`incremental-${dictionaryClass}`, point.incremental],
  ] as const) {
    for (const [percentile, value] of [
      [0.5, summary.median],
      [0.95, summary.p95],
    ] as const) {
      emitPerfMetric({
        name: `browser-display-receiver-${suffix}-${point.rawBytes}`,
        value,
        unit: 'ms/op',
        direction: 'lower',
        percentile,
        sampleSize: SAMPLES,
      });
    }
  }
  emitPerfMetric({
    name: `browser-display-receiver-wire-ratio-${dictionaryClass}-${point.rawBytes}`,
    value: point.wireBytes / point.rawBytes,
    unit: 'ratio',
    direction: 'lower',
    sampleSize: 1,
  });
}

function measurePipeline(leased: boolean, samples: number[]): void {
  const started = performance.now();
  runPipeline(leased);
  samples.push(performance.now() - started);
}

function runPipeline(
  leased: boolean,
  accounting: MutableBrowserDisplayIoAccounting | null = null,
): void {
  if (accounting !== null) resetBrowserDisplayIoAccounting(accounting);
  writeU32BE(wireFrame, DISPLAY_SEQUENCE_OFFSET, seq);
  if (!writer.write(wireFrame, FRAME_KIND_DISPLAY, false)) {
    throw new Error('browser pipeline frame ring unexpectedly full');
  }
  if (accounting !== null) noteBrowserDisplayCopy(accounting, wireFrame.byteLength);
  const entry = leased ? reader.tryReadLeased() : reader.tryRead();
  if (entry === null) throw new Error('browser pipeline frame ring lost an entry');
  if (accounting !== null && leased) noteBrowserDisplayObjectAllocationRequest(accounting);
  if (accounting !== null) {
    noteBrowserDisplayCopy(accounting, entry.payload.byteLength);
    if (!leased) noteBrowserDisplayAllocationRequest(accounting, entry.payload.byteLength);
  }
  viewerDriver.apply(entry.payload);
  if ('release' in entry && typeof entry.release === 'function') entry.release();
  if (!SKIP_GEOMETRY) viewerDriver.viewer.build_geometry();
  checksum ^=
    viewerGeometry.glyphs() ^ viewerGeometry.cursors() ^ viewerDriver.viewer.applied_sequence();
  seq = (seq + 1) >>> 0;
  if (seq === 0) seq = 1;
}

function stageDisplayFrame(payload: Uint8Array): number {
  if (payload.byteLength > frameInputCapacity) {
    frameInputPtr = terminal.reserve_display_frame_input(payload.byteLength);
    if (frameInputPtr === 0) return 0;
    frameInputCapacity = payload.byteLength;
  }
  new Uint8Array(wasmRuntime.memory.buffer, frameInputPtr, payload.byteLength).set(payload);
  return terminal.stage_display_frame_input(payload.byteLength);
}

function benchmarkReceiverRepresentation(
  raw: Uint8Array,
  wire: Uint8Array,
  dictionary: boolean,
): {
  rawBytes: number;
  wireBytes: number;
  dictionary: boolean;
  raw: ReturnType<typeof summarizeSamples>;
  fused: ReturnType<typeof summarizeSamples>;
  incremental: ReturnType<typeof summarizeSamples>;
} {
  const rawSamples: number[] = [];
  const fusedSamples: number[] = [];
  const incrementalSamples: number[] = [];
  for (let index = 0; index < WARMUPS + SAMPLES; index += 1) {
    const measureRaw = (): number => {
      const frameSeq = nextSequence();
      const started = performance.now();
      const applied = terminal.apply_delta_seq(raw, frameSeq);
      const elapsed = performance.now() - started;
      if (!applied) throw new Error(`raw receiver surface failed: ${terminal.take_last_error()}`);
      return elapsed;
    };
    const measureFused = (): number => {
      const frameSeq = nextSequence();
      writeU32BE(wire, DISPLAY_SEQUENCE_OFFSET, frameSeq);
      const started = performance.now();
      const handle = stageDisplayFrame(wire);
      const applied = handle !== 0 && terminal.apply_staged_delta_seq(handle, frameSeq);
      const elapsed = performance.now() - started;
      if (handle !== 0) terminal.release_staged_frame(handle);
      if (!applied) throw new Error(`fused receiver surface failed: ${terminal.take_last_error()}`);
      return elapsed;
    };
    const rawMs = index % 2 === 0 ? measureRaw() : 0;
    const fusedMs = measureFused();
    const pairedRawMs = index % 2 === 0 ? rawMs : measureRaw();
    if (index >= WARMUPS) {
      rawSamples.push(pairedRawMs);
      fusedSamples.push(fusedMs);
      incrementalSamples.push(Math.max(0, fusedMs - pairedRawMs));
    }
  }
  return {
    rawBytes: raw.byteLength,
    wireBytes: wire.byteLength,
    dictionary,
    raw: summarizeSamples(rawSamples),
    fused: summarizeSamples(fusedSamples),
    incremental: summarizeSamples(incrementalSamples),
  };
}

function nextSequence(): number {
  const current = seq;
  seq = (seq + 1) >>> 0;
  if (seq === 0) seq = 1;
  return current;
}

function benchmarkRingReceipt(
  leased: boolean,
  payload: Uint8Array,
): ReturnType<typeof summarizeSamples> {
  const receiptRing = new SharedArrayBuffer(FRAME_RING_SIZE);
  const receiptWriter = createFrameRingWriter(receiptRing);
  const receiptReader = createFrameRingReader(receiptRing);
  const receiptSamples: number[] = [];
  for (let index = 0; index < WARMUPS + SAMPLES; index += 1) {
    const started = performance.now();
    if (!receiptWriter.write(payload, FRAME_KIND_DISPLAY, false)) {
      throw new Error('ring receipt benchmark unexpectedly filled its ring');
    }
    if (leased) {
      const entry = receiptReader.tryReadLeased();
      if (entry === null) throw new Error('ring receipt benchmark lost a leased entry');
      checksum ^= entry.payload[entry.payload.byteLength - 1] ?? 0;
      entry.release();
    } else {
      const entry = receiptReader.tryRead();
      if (entry === null) throw new Error('ring receipt benchmark lost a copied entry');
      checksum ^= entry.payload[entry.payload.byteLength - 1] ?? 0;
    }
    if (index >= WARMUPS) receiptSamples.push(performance.now() - started);
  }
  return summarizeSamples(receiptSamples);
}

function createBlankFrame(
  cols: number,
  rows: number,
  patchFlags: number,
  encodedRows = rows,
): Uint8Array {
  // Alternate printable cells so the fixture represents a production-sized
  // dense update instead of collapsing every row to one three-byte RLE run.
  // Row colour mode byte, then two bytes per default-style cell.
  const cellBytes = 1 + cols * 2;
  const rowBytes = DISPLAY_ROW_PREFIX_BYTES + cellBytes;
  const frame = new Uint8Array(DISPLAY_ROWS_OFFSET + encodedRows * rowBytes);
  frame[DISPLAY_MESSAGE_TYPE_OFFSET] = MESSAGE_TYPE_DISPLAY_PATCH;
  writeU32BE(frame, DISPLAY_GENERATION_OFFSET, 1);
  writeU32BE(
    frame,
    DISPLAY_DATAGRAM_HEADER_BODY_LENGTH_OFFSET,
    frame.byteLength - DISPLAY_STREAM_HEADER_BYTES,
  );
  frame[DISPLAY_VERSION_OFFSET] = DISPLAY_PROTOCOL_VERSION;
  frame[DISPLAY_PATCH_FLAGS_OFFSET] = patchFlags;
  writeU16(frame, DISPLAY_COLUMNS_OFFSET, cols);
  writeU16(frame, DISPLAY_GRID_ROWS_OFFSET, rows);
  writeU32BE(frame, DISPLAY_FRAME_ID_OFFSET, 0);
  writeU32BE(frame, DISPLAY_PRESENTATION_ID_OFFSET, 0);
  writeU16(frame, DISPLAY_CHUNK_INDEX_OFFSET, 0);
  writeU16(frame, DISPLAY_CHUNK_COUNT_OFFSET, 1);
  writeU16(frame, DISPLAY_ROW_COUNT_OFFSET, encodedRows);
  writeU32BE(frame, DISPLAY_DEMAND_SERIAL_OFFSET, 0);
  let offset = DISPLAY_ROWS_OFFSET;
  for (let row = 0; row < encodedRows; row += 1) {
    writeU16(frame, offset, row);
    writeU16(frame, offset + 2, 0);
    writeU16(frame, offset + 4, cols);
    writeU16(frame, offset + 6, cellBytes);
    frame[offset + DISPLAY_ROW_PREFIX_BYTES] = DISPLAY_COLOR_MODE_INDEXED;
    let cellOffset = offset + DISPLAY_ROW_PREFIX_BYTES + 1;
    for (let col = 0; col < cols; col += 1) {
      frame[cellOffset] = 0;
      frame[cellOffset + 1] = 0x20 + ((row + col) & 0x3f);
      cellOffset += 2;
    }
    offset += rowBytes;
  }
  return frame;
}

interface BenchmarkDictionary {
  readonly bytes: Uint8Array;
  readonly hash: number;
}

function createCompressedDisplayFrame(
  raw: Uint8Array,
  dictionary?: BenchmarkDictionary,
): Uint8Array {
  const input =
    dictionary === undefined
      ? raw.subarray(DISPLAY_ROWS_OFFSET)
      : concatenate(dictionary.bytes, raw.subarray(DISPLAY_ROWS_OFFSET));
  const result = Bun.spawnSync(
    dictionary === undefined
      ? [FIXTURE_BINARY]
      : [FIXTURE_BINARY, `--dictionary-bytes=${dictionary.bytes.byteLength}`],
    {
      cwd: ROOT,
      stdin: input,
      stdout: 'pipe',
      stderr: 'inherit',
    },
  );
  if (result.exitCode !== 0) throw new Error('zstd fixture compression failed');
  const fixture = new Uint8Array(result.stdout);
  const block = dictionary === undefined ? fixture : fixture.subarray(4);
  const payloadOffset =
    dictionary === undefined
      ? DISPLAY_COMPRESSED_PAYLOAD_OFFSET
      : DISPLAY_DICT_COMPRESSED_PAYLOAD_OFFSET;
  const out = new Uint8Array(payloadOffset + block.byteLength);
  out.set(raw.subarray(0, DISPLAY_ROWS_OFFSET));
  out[DISPLAY_DATAGRAM_HEADER_FLAGS_OFFSET] =
    (out[DISPLAY_DATAGRAM_HEADER_FLAGS_OFFSET] ?? 0) | DISPLAY_HEADER_FLAG_COMPRESSED_ZSTD;
  if (dictionary !== undefined) {
    out[DISPLAY_DATAGRAM_HEADER_FLAGS_OFFSET] |= DISPLAY_HEADER_FLAG_COMPRESSED_ZSTD_DICT;
    writeU32BE(out, DISPLAY_GENERATION_OFFSET, 1);
    writeU32BE(out, DISPLAY_COMPRESSED_LENGTH_OFFSET + 4, 1);
    writeU32BE(out, DISPLAY_COMPRESSED_LENGTH_OFFSET + 8, dictionary.hash);
  }
  writeU32BE(
    out,
    DISPLAY_DATAGRAM_HEADER_BODY_LENGTH_OFFSET,
    out.byteLength - DISPLAY_STREAM_HEADER_BYTES,
  );
  writeU32BE(out, DISPLAY_COMPRESSED_LENGTH_OFFSET, raw.byteLength - DISPLAY_ROWS_OFFSET);
  out.set(block, payloadOffset);
  return out;
}

function createBenchmarkDictionary(size: number): BenchmarkDictionary {
  // The fixture hashes the dictionary while compressing a one-cell row.
  const bytes = trainFixtureDictionary(FIXTURE_BINARY, ROOT, cols, size, 0x2468_ace0);
  const hashResult = Bun.spawnSync([FIXTURE_BINARY, `--dictionary-bytes=${bytes.byteLength}`], {
    cwd: ROOT,
    stdin: concatenate(
      bytes,
      createTextRowBody(1, 1, () => 0x20),
    ),
    stdout: 'pipe',
    stderr: 'inherit',
  });
  if (hashResult.exitCode !== 0 || hashResult.stdout.byteLength < 4) {
    throw new Error('zstd fixture dictionary hash failed');
  }
  const output = new Uint8Array(hashResult.stdout);
  return {
    bytes,
    hash: new DataView(output.buffer, output.byteOffset, 4).getUint32(0, false),
  };
}

function concatenate(first: Uint8Array, second: Uint8Array): Uint8Array {
  const joined = new Uint8Array(first.byteLength + second.byteLength);
  joined.set(first, 0);
  joined.set(second, first.byteLength);
  return joined;
}

function writeU16(target: Uint8Array, offset: number, value: number): void {
  target[offset] = (value >>> 8) & 0xff;
  target[offset + 1] = value & 0xff;
}

function positiveInteger(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be positive`);
  return value;
}
