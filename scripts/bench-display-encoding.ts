/**
 * Browser compressed-display staging benchmark.
 *
 * Measures the production decode boundary: one JS -> terminal-WASM copy,
 * zstd row-payload decompression into terminal-owned reusable storage, and
 * handle release back to the staging pool.
 */
import {
  DISPLAY_CHUNK_COUNT_OFFSET,
  DISPLAY_COLOR_MODE_INDEXED,
  DISPLAY_COLUMNS_OFFSET,
  DISPLAY_COMPRESSED_LENGTH_OFFSET,
  DISPLAY_COMPRESSED_PAYLOAD_OFFSET,
  DISPLAY_DATAGRAM_HEADER_BODY_LENGTH_OFFSET,
  DISPLAY_FRAME_ID_OFFSET,
  DISPLAY_GENERATION_OFFSET,
  DISPLAY_GRID_ROWS_OFFSET,
  DISPLAY_HEADER_FLAG_COMPRESSED_ZSTD,
  DISPLAY_PRESENTATION_ID_OFFSET,
  DISPLAY_PROTOCOL_VERSION,
  DISPLAY_ROW_COUNT_OFFSET,
  DISPLAY_ROW_PREFIX_BYTES,
  DISPLAY_SEQUENCE_OFFSET,
  DISPLAY_STREAM_HEADER_BYTES,
  MESSAGE_TYPE_DISPLAY_PATCH,
  writeU32BE,
} from '../packages/shared/src';
import { loadBenchmarkTerminal } from './perf/declared-terminal';
import { emitPerfMetric } from './perf/harness';
import { zstdFixtureExecutable } from './perf/zstd-fixture';

const FIXTURE_BINARY = zstdFixtureExecutable();
// Leave room for the current visible header, length field, and codec expansion
// so the random-pattern fixture still fits the u16 wire body.
const MAX_ROWS_BYTES = 65_000;
const DEFAULT_SIZES = [512, 1024, 2048, 4096, 8192, 16_384, 32_768, MAX_ROWS_BYTES];
const DEFAULT_TARGET_BYTES = 256 * 1024 * 1024;
const MAX_ITERATIONS = 200_000;
const DEFAULT_MIN_ITERATIONS = 20_000;
type PatternName = 'blank' | 'terminal' | 'gradient' | 'random';

interface BenchResult {
  readonly iterations: number;
  readonly elapsedMs: number;
  readonly opsPerSecond: number;
  readonly heapDelta: number;
}

const sizes = parseSizes(process.env.BENCH_DISPLAY_SIZES ?? '');
const patterns = parsePatterns(process.env.BENCH_DISPLAY_PATTERNS ?? '');
const targetBytes = positiveInteger('BENCH_TARGET_BYTES', DEFAULT_TARGET_BYTES);
const minIterations = positiveInteger('BENCH_MIN_ITERATIONS', DEFAULT_MIN_ITERATIONS);
const forcedIterations =
  process.env.BENCH_ITERATIONS === undefined ? null : positiveInteger('BENCH_ITERATIONS', 1);

// Bazel declares the shipped WASM and native fixture before sampling.

const { runtime: wasmRuntime, terminal } = await loadBenchmarkTerminal(960, 640);
let frameInputPtr = 0;
let frameInputCapacity = 0;

const lines = [
  `display staging benchmark: sizes=${sizes.join(',')} patterns=${patterns.join(',')} targetBytes=${formatBytes(targetBytes)}`,
  'path: JS wire frame -> terminal WASM -> zstd row decode -> pooled staged frame',
];

for (const size of sizes) {
  const iterations = forcedIterations ?? computeIterations(size, targetBytes, minIterations);
  lines.push(
    `\nrows-bytes=${size.toLocaleString('en-US')} iterations=${iterations.toLocaleString('en-US')}`,
  );
  for (const pattern of patterns) {
    const payload = createPayload(size, pattern);
    const wire = createCompressedFrame(payload);
    const result = benchStaging(iterations, wire);
    lines.push(
      `  stage:${pattern} encodedRows=${formatBytes(payload.bytes.byteLength)} wire=${formatBytes(wire.byteLength)}: ${result.opsPerSecond.toLocaleString('en-US')} ops/s, ${result.elapsedMs.toFixed(1)}ms, heapDelta=${formatBytes(result.heapDelta)}`,
    );
    emitPerfMetric({
      name: `${pattern}-${size}-terminal-wasm-stage`,
      value: result.elapsedMs / result.iterations,
      unit: 'ms/op',
      direction: 'lower',
      sampleSize: result.iterations,
    });
  }
}

terminal.free();
process.stdout.write(`${lines.join('\n')}\n`);

function benchStaging(iterations: number, wire: Uint8Array): BenchResult {
  stageAndRelease(wire);
  const beforeHeap = process.memoryUsage().heapUsed;
  const started = performance.now();
  for (let index = 0; index < iterations; index += 1) stageAndRelease(wire);
  const elapsedMs = performance.now() - started;
  return {
    iterations,
    elapsedMs,
    opsPerSecond: Math.round((iterations / elapsedMs) * 1000),
    heapDelta: process.memoryUsage().heapUsed - beforeHeap,
  };
}

function stageAndRelease(wire: Uint8Array): void {
  if (wire.byteLength > frameInputCapacity) {
    frameInputPtr = terminal.reserve_display_frame_input(wire.byteLength);
    if (frameInputPtr === 0) {
      throw new Error(`terminal staging failed: ${terminal.take_last_error()}`);
    }
    frameInputCapacity = wire.byteLength;
  }
  new Uint8Array(wasmRuntime.memory.buffer, frameInputPtr, wire.byteLength).set(wire);
  const handle = terminal.stage_display_frame_input(wire.byteLength);
  if (handle === 0) throw new Error(`terminal staging failed: ${terminal.take_last_error()}`);
  terminal.release_staged_frame(handle);
}

function createCompressedFrame(rows: {
  bytes: Uint8Array;
  count: number;
  cols: number;
}): Uint8Array {
  const compressed = compressFixture(rows.bytes);
  const wire = new Uint8Array(DISPLAY_COMPRESSED_PAYLOAD_OFFSET + compressed.byteLength);
  wire[0] = MESSAGE_TYPE_DISPLAY_PATCH;
  wire[1] = DISPLAY_HEADER_FLAG_COMPRESSED_ZSTD;
  writeU32BE(wire, DISPLAY_SEQUENCE_OFFSET, 1);
  writeU32BE(wire, DISPLAY_GENERATION_OFFSET, 1);
  wire[DISPLAY_STREAM_HEADER_BYTES] = DISPLAY_PROTOCOL_VERSION;
  writeU16(wire, DISPLAY_COLUMNS_OFFSET, rows.cols);
  writeU16(wire, DISPLAY_GRID_ROWS_OFFSET, rows.count);
  writeU32BE(wire, DISPLAY_FRAME_ID_OFFSET, 1);
  writeU32BE(wire, DISPLAY_PRESENTATION_ID_OFFSET, 1);
  writeU16(wire, DISPLAY_CHUNK_COUNT_OFFSET, 1);
  writeU16(wire, DISPLAY_ROW_COUNT_OFFSET, rows.count);
  writeU32BE(
    wire,
    DISPLAY_DATAGRAM_HEADER_BODY_LENGTH_OFFSET,
    wire.byteLength - DISPLAY_STREAM_HEADER_BYTES,
  );
  writeU32BE(wire, DISPLAY_COMPRESSED_LENGTH_OFFSET, rows.bytes.byteLength);
  wire.set(compressed, DISPLAY_COMPRESSED_PAYLOAD_OFFSET);
  return wire;
}

function compressFixture(payload: Uint8Array): Uint8Array {
  const result = Bun.spawnSync([FIXTURE_BINARY], {
    stdin: payload,
    stdout: 'pipe',
    stderr: 'inherit',
  });
  if (result.exitCode !== 0 || result.stdout.byteLength === 0) {
    throw new Error(`zstd fixture failed for ${payload.byteLength} bytes`);
  }
  return new Uint8Array(result.stdout);
}

function createPayload(
  size: number,
  pattern: PatternName,
): { bytes: Uint8Array; count: number; cols: number } {
  // Staging now fuses decompression with row validation. Arbitrary bytes are
  // not a display body and measured an obsolete decoder-only boundary. Use
  // valid default-style cell rows with controlled printable entropy instead.
  // The requested size is a byte budget, not padding after the final row.
  const minimumRowBytes = DISPLAY_ROW_PREFIX_BYTES + 3;
  if (size < minimumRowBytes) throw new Error(`display size must be at least ${minimumRowBytes}`);
  const cols = Math.min(160, Math.floor((size - DISPLAY_ROW_PREFIX_BYTES - 1) / 2));
  const payload = new Uint8Array(size);
  const phrase = 'INFO display_frame_sent rows=12 bytes=4096 merkur daemon output stream  ';
  let state = 0x1234_5678;
  let offset = 0;
  let count = 0;
  let cellIndex = 0;
  while (size - offset >= minimumRowBytes) {
    const cells = Math.min(cols, Math.floor((size - offset - DISPLAY_ROW_PREFIX_BYTES - 1) / 2));
    const cellBytes = 1 + cells * 2;
    writeU16(payload, offset, count);
    writeU16(payload, offset + 4, cells);
    writeU16(payload, offset + 6, cellBytes);
    offset += DISPLAY_ROW_PREFIX_BYTES;
    payload[offset++] = DISPLAY_COLOR_MODE_INDEXED;
    for (let col = 0; col < cells; col += 1) {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      payload[offset++] = 0;
      payload[offset++] =
        pattern === 'blank'
          ? 0x20
          : pattern === 'terminal'
            ? phrase.charCodeAt(cellIndex % phrase.length)
            : pattern === 'gradient'
              ? 0x20 + (cellIndex % 95)
              : 0x20 + ((state >>> 24) % 95);
      cellIndex += 1;
    }
    count += 1;
  }
  return { bytes: payload.subarray(0, offset), count, cols };
}

function computeIterations(size: number, totalBytes: number, floor: number): number {
  return Math.max(floor, Math.min(MAX_ITERATIONS, Math.floor(totalBytes / size)));
}

function parseSizes(raw: string): number[] {
  if (raw.trim().length === 0) return DEFAULT_SIZES;
  const values = raw
    .split(',')
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isInteger(value) && value > 0 && value <= MAX_ROWS_BYTES);
  if (values.length === 0) throw new Error(`BENCH_DISPLAY_SIZES must be in 1..${MAX_ROWS_BYTES}`);
  return [...new Set(values)];
}

function parsePatterns(raw: string): PatternName[] {
  if (raw.trim().length === 0) return ['blank', 'terminal', 'gradient', 'random'];
  const allowed = new Set<PatternName>(['blank', 'terminal', 'gradient', 'random']);
  const values = raw
    .split(',')
    .map((value) => value.trim())
    .filter((value): value is PatternName => allowed.has(value as PatternName));
  if (values.length === 0) throw new Error('BENCH_DISPLAY_PATTERNS has no supported pattern');
  return [...new Set(values)];
}

function positiveInteger(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return value;
}

function writeU16(target: Uint8Array, offset: number, value: number): void {
  target[offset] = (value >>> 8) & 0xff;
  target[offset + 1] = value & 0xff;
}

function formatBytes(value: number): string {
  const sign = value < 0 ? '-' : '';
  const absolute = Math.abs(value);
  if (absolute < 1024) return `${value}B`;
  if (absolute < 1024 * 1024) return `${sign}${(absolute / 1024).toFixed(1)}KiB`;
  return `${sign}${(absolute / 1024 / 1024).toFixed(1)}MiB`;
}
