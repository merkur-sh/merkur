/**
 * Multi-chunk terminal-WASM validation/apply benchmark.
 *
 * The staged cases mirror compressed production frames and the raw staged
 * path used when an assembled frame needs an all-chunks validation barrier.
 * The direct raw case is a control that intentionally validates then applies
 * the same bytes through the legacy slice API. The hashed case alternates two
 * contents, so every row changes each frame, and adds the heartbeat's row-hash
 * refresh over every changed row.
 *
 * `BENCH_LINKS=n` gives every row `n` OSC 8 link spans, evenly laid out, so the
 * link table's validation, the per-cell link ids and the hash suffix are timed.
 */
import path from 'node:path';
import {
  DISPLAY_CHUNK_COUNT_OFFSET,
  DISPLAY_CHUNK_INDEX_OFFSET,
  DISPLAY_COLOR_MODE_INDEXED,
  DISPLAY_COMPRESSED_LENGTH_OFFSET,
  DISPLAY_COMPRESSED_PAYLOAD_OFFSET,
  DISPLAY_DATAGRAM_HEADER_BODY_LENGTH_OFFSET,
  DISPLAY_FRAME_ID_OFFSET,
  DISPLAY_GENERATION_OFFSET,
  DISPLAY_HEADER_FLAG_COMPRESSED_ZSTD,
  DISPLAY_PATCH_FLAG_RESET,
  DISPLAY_PROTOCOL_VERSION,
  DISPLAY_ROW_COUNT_OFFSET,
  DISPLAY_ROW_PREFIX_BYTES,
  DISPLAY_ROWS_OFFSET,
  DISPLAY_STREAM_HEADER_BYTES,
  MESSAGE_TYPE_DISPLAY_PATCH,
  writeU32BE,
} from '../packages/shared/src';
import { loadBenchmarkTerminal } from './perf/declared-terminal';
import { emitPerfMetric, summarizeSamples } from './perf/harness';
import { builtZstdFixtureExecutable } from './perf/zstd-fixture';

const ROOT = path.resolve(import.meta.dir, '..');
const SAMPLES = positiveInteger('BENCH_SAMPLES', 500);
const WARMUPS = positiveInteger('BENCH_WARMUPS', 75);
const CHUNKS = positiveInteger('BENCH_CHUNKS', 4);
const LINKS = Number.parseInt(process.env.BENCH_LINKS ?? '0', 10);
if (!Number.isInteger(LINKS) || LINKS < 0) throw new Error('BENCH_LINKS must be a whole number');
// Row prefix `left` flag and span shape, as merkur-codec writes them.
const ROW_FLAG_LINKS = 0x8000;
const LINK_SPAN_BYTES = 8;
const FIXTURE_BINARY = await builtZstdFixtureExecutable();

const { runtime: wasmRuntime, terminal } = await loadBenchmarkTerminal(1280, 720);
const cols = terminal.cols();
const rows = terminal.rows();
if (cols <= 0 || cols > 255 || rows < CHUNKS) {
  throw new Error(`unsupported benchmark geometry ${cols}x${rows} for ${CHUNKS} chunks`);
}

const snapshot = createChunk(cols, rows, 0, rows, 0, 1, DISPLAY_PATCH_FLAG_RESET, 0);
if (!terminal.apply_state_seq(snapshot, 0)) {
  throw new Error(`initial snapshot failed: ${terminal.take_last_error()}`);
}
const rawChunks = createLogicalFrame(cols, rows, CHUNKS, 0);
const compressedChunks = rawChunks.map(createCompressedDisplayFrame);
const alternateCompressedChunks = createLogicalFrame(cols, rows, CHUNKS, 1).map(
  createCompressedDisplayFrame,
);
let frameInputPtr = 0;
let frameInputCapacity = 0;
let sequence = 1;
let frameId = 1;
let checksum = 0n;

const scenarios = [
  { name: 'raw-direct', chunks: rawChunks, staged: false },
  { name: 'raw-staged', chunks: rawChunks, staged: true },
  { name: 'compressed-staged', chunks: compressedChunks, staged: true },
  {
    name: 'compressed-staged-hashed',
    chunks: compressedChunks,
    alternate: alternateCompressedChunks,
    staged: true,
    hashed: true,
  },
] as const;
const metricSuffix = LINKS > 0 ? `-links-${LINKS}` : '';

for (const scenario of scenarios) {
  for (let index = 0; index < WARMUPS; index += 1) runLogicalFrame(scenario);
  const samples: number[] = [];
  for (let index = 0; index < SAMPLES; index += 1) {
    const started = performance.now();
    runLogicalFrame(scenario);
    samples.push(performance.now() - started);
  }
  const summary = summarizeSamples(samples);
  process.stdout.write(
    `term-wasm multichunk: scenario=${scenario.name} links=${LINKS} chunks=${CHUNKS} geometry=${cols}x${rows} ` +
      `p50=${summary.median.toFixed(6)}ms p95=${summary.p95.toFixed(6)}ms ` +
      `p99=${summary.p99.toFixed(6)}ms checksum=${checksum}\n`,
  );
  for (const [percentile, value] of [
    [0.5, summary.median],
    [0.95, summary.p95],
    [0.99, summary.p99],
  ] as const) {
    emitPerfMetric({
      name: `term-wasm-multichunk-${scenario.name}${metricSuffix}`,
      value,
      unit: 'ms/logical-frame',
      direction: 'lower',
      percentile,
      sampleSize: SAMPLES,
    });
  }
}

terminal.free();

function runLogicalFrame(scenario: (typeof scenarios)[number]): void {
  const handles: number[] = [];
  const chunkSequences: number[] = [];
  const chunks =
    'alternate' in scenario && frameId % 2 === 1 ? scenario.alternate : scenario.chunks;
  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    if (chunk === undefined) throw new Error(`missing chunk ${index}`);
    const chunkSequence = sequence;
    sequence = (sequence + 1) >>> 0;
    if (sequence === 0) sequence = 1;
    chunkSequences.push(chunkSequence);
    writeU32BE(chunk, 4, chunkSequence);
    writeU32BE(chunk, DISPLAY_FRAME_ID_OFFSET, frameId);
    if (scenario.staged) {
      const handle = stageDisplayFrame(chunk);
      if (handle === 0) throw new Error(`stage failed: ${terminal.take_last_error()}`);
      handles.push(handle);
    } else if (!terminal.validate_frame(chunk)) {
      throw new Error(`direct validation failed: ${terminal.take_last_error()}`);
    }
  }

  if (scenario.staged) {
    for (const handle of handles) {
      if (!terminal.validate_staged_frame(handle)) {
        releaseHandles(handles);
        throw new Error(`staged validation failed: ${terminal.take_last_error()}`);
      }
    }
    for (let index = 0; index < handles.length; index += 1) {
      const handle = handles[index];
      const chunkSequence = chunkSequences[index];
      if (
        handle === undefined ||
        chunkSequence === undefined ||
        !terminal.apply_staged_delta_seq(handle, chunkSequence)
      ) {
        releaseHandles(handles);
        throw new Error(`staged apply failed: ${terminal.take_last_error()}`);
      }
    }
    releaseHandles(handles);
    if ('hashed' in scenario) terminal.refresh_row_hashes();
  } else {
    for (let index = 0; index < scenario.chunks.length; index += 1) {
      const chunk = scenario.chunks[index];
      const chunkSequence = chunkSequences[index];
      if (
        chunk === undefined ||
        chunkSequence === undefined ||
        !terminal.apply_delta_seq(chunk, chunkSequence)
      ) {
        throw new Error(`direct apply failed: ${terminal.take_last_error()}`);
      }
    }
  }
  checksum ^= terminal.row_hash(frameId % rows) ^ BigInt(frameId);
  frameId = (frameId + 1) >>> 0;
  if (frameId === 0) frameId = 1;
}

function releaseHandles(handles: readonly number[]): void {
  for (const handle of handles) terminal.release_staged_frame(handle);
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

function createLogicalFrame(
  cols: number,
  rows: number,
  chunkCount: number,
  phase: number,
): Uint8Array[] {
  const baseRows = Math.floor(rows / chunkCount);
  let remainder = rows % chunkCount;
  let rowStart = 0;
  const chunks: Uint8Array[] = [];
  for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) {
    const rowCount = baseRows + (remainder > 0 ? 1 : 0);
    remainder -= remainder > 0 ? 1 : 0;
    chunks.push(createChunk(cols, rows, rowStart, rowCount, chunkIndex, chunkCount, 0, phase));
    rowStart += rowCount;
  }
  return chunks;
}

function createChunk(
  cols: number,
  rows: number,
  rowStart: number,
  rowCount: number,
  chunkIndex: number,
  chunkCount: number,
  patchFlags: number,
  phase: number,
): Uint8Array {
  // Optional link table, row colour mode byte, then two bytes per default-style cell.
  const linkTableBytes = LINKS > 0 ? 2 + LINKS * LINK_SPAN_BYTES : 0;
  const cellBytes = linkTableBytes + 1 + cols * 2;
  const linkSpan = LINKS > 0 ? Math.floor(cols / LINKS) : 0;
  const rowBytes = DISPLAY_ROW_PREFIX_BYTES + cellBytes;
  const frame = new Uint8Array(DISPLAY_ROWS_OFFSET + rowCount * rowBytes);
  frame[0] = MESSAGE_TYPE_DISPLAY_PATCH;
  // The staged path refuses generation 0, which no daemon sends.
  writeU32BE(frame, DISPLAY_GENERATION_OFFSET, 1);
  writeU32BE(
    frame,
    DISPLAY_DATAGRAM_HEADER_BODY_LENGTH_OFFSET,
    frame.byteLength - DISPLAY_STREAM_HEADER_BYTES,
  );
  frame[DISPLAY_STREAM_HEADER_BYTES] = DISPLAY_PROTOCOL_VERSION;
  frame[DISPLAY_STREAM_HEADER_BYTES + 1] = patchFlags;
  writeU16(frame, DISPLAY_STREAM_HEADER_BYTES + 2, cols);
  writeU16(frame, DISPLAY_STREAM_HEADER_BYTES + 4, rows);
  writeU16(frame, DISPLAY_CHUNK_INDEX_OFFSET, chunkIndex);
  writeU16(frame, DISPLAY_CHUNK_COUNT_OFFSET, chunkCount);
  writeU16(frame, DISPLAY_ROW_COUNT_OFFSET, rowCount);
  let offset = DISPLAY_ROWS_OFFSET;
  for (let rowOffset = 0; rowOffset < rowCount; rowOffset += 1) {
    const row = rowStart + rowOffset;
    writeU16(frame, offset, row);
    writeU16(frame, offset + 2, LINKS > 0 ? ROW_FLAG_LINKS : 0);
    writeU16(frame, offset + 4, cols);
    writeU16(frame, offset + 6, cellBytes);
    let tableOffset = offset + DISPLAY_ROW_PREFIX_BYTES;
    if (LINKS > 0) {
      writeU16(frame, tableOffset, LINKS);
      tableOffset += 2;
      for (let link = 0; link < LINKS; link += 1) {
        writeU16(frame, tableOffset, link * linkSpan);
        writeU16(frame, tableOffset + 2, linkSpan);
        writeU32BE(frame, tableOffset + 4, 1 + row * LINKS + link);
        tableOffset += LINK_SPAN_BYTES;
      }
    }
    frame[tableOffset] = DISPLAY_COLOR_MODE_INDEXED;
    let cellOffset = tableOffset + 1;
    for (let col = 0; col < cols; col += 1) {
      frame[cellOffset] = 0;
      frame[cellOffset + 1] = 0x20 + ((row + col + phase) & 0x3f);
      cellOffset += 2;
    }
    offset += rowBytes;
  }
  return frame;
}

function createCompressedDisplayFrame(raw: Uint8Array): Uint8Array {
  const result = Bun.spawnSync([FIXTURE_BINARY], {
    cwd: ROOT,
    stdin: raw.subarray(DISPLAY_ROWS_OFFSET),
    stdout: 'pipe',
    stderr: 'inherit',
  });
  if (result.exitCode !== 0) throw new Error('zstd fixture compression failed');
  const block = new Uint8Array(result.stdout);
  const out = new Uint8Array(DISPLAY_COMPRESSED_PAYLOAD_OFFSET + block.byteLength);
  out.set(raw.subarray(0, DISPLAY_ROWS_OFFSET));
  out[1] = (out[1] ?? 0) | DISPLAY_HEADER_FLAG_COMPRESSED_ZSTD;
  writeU32BE(out, DISPLAY_DATAGRAM_HEADER_BODY_LENGTH_OFFSET, out.byteLength - 16);
  writeU32BE(out, DISPLAY_COMPRESSED_LENGTH_OFFSET, raw.byteLength - DISPLAY_ROWS_OFFSET);
  out.set(block, DISPLAY_COMPRESSED_PAYLOAD_OFFSET);
  return out;
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
