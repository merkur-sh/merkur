import {
  DISPLAY_PATCH_BODY_HEADER_BYTES,
  DISPLAY_PATCH_FLAG_RESET,
  DISPLAY_PROTOCOL_VERSION,
  DISPLAY_STREAM_HEADER_BYTES,
  MESSAGE_TYPE_DISPLAY_PATCH,
} from '../packages/shared/src';
import { emitPerfMetric } from './perf/harness';

const RAW_FRAME_TYPE = MESSAGE_TYPE_DISPLAY_PATCH;
const DISPLAY_PATCH_FRAME_TYPE = MESSAGE_TYPE_DISPLAY_PATCH;
const FRAME_HEADER_BYTES = 4;
const U24_MAX = 0x00ff_ffff;
const CELL_BYTES = 11;
const DISPLAY_PATCH_VERSION = DISPLAY_PROTOCOL_VERSION;
const DEFAULT_ITERATIONS = 50_000;

interface BenchCase {
  readonly name: string;
  readonly cols: number;
  readonly rows: number;
  readonly rawBytes: number;
  readonly dirtyRows: number;
  readonly dirtyCols: number;
  readonly displayKind: 'delta' | 'snapshot';
  readonly iterations: number;
}

interface BenchResult {
  readonly name: string;
  readonly iterations: number;
  readonly elapsedMs: number;
  readonly avgUs: number;
  readonly opsPerSecond: number;
  readonly heapDelta: number;
  readonly checksum: number;
}

interface DisplayFrameView {
  readonly payload: Uint8Array;
}

const configuredIterations = Number(process.env.BENCH_ITERATIONS ?? DEFAULT_ITERATIONS);

const cases: readonly BenchCase[] = [
  {
    name: 'interactive-echo-16B',
    cols: 120,
    rows: 40,
    rawBytes: 16,
    dirtyRows: 1,
    dirtyCols: 16,
    displayKind: 'delta',
    iterations: configuredIterations,
  },
  {
    name: 'line-burst-4KiB',
    cols: 120,
    rows: 40,
    rawBytes: 4 * 1024,
    dirtyRows: 5,
    dirtyCols: 120,
    displayKind: 'delta',
    iterations: Math.max(5_000, Math.floor(configuredIterations / 4)),
  },
  {
    name: 'fullscreen-64KiB',
    cols: 120,
    rows: 40,
    rawBytes: 64 * 1024,
    dirtyRows: 40,
    dirtyCols: 120,
    displayKind: 'snapshot',
    iterations: Math.max(1_000, Math.floor(configuredIterations / 20)),
  },
];

const lines: string[] = [];
lines.push(`transport story benchmark: baseIterations=${configuredIterations}`);
lines.push(
  'note: raw path models frame+decode+byte-scan lower bound; display path models compact patch frame+decode+grid apply lower bound.',
);

for (const item of cases) {
  runCase(item);
}

process.stdout.write(`${lines.join('\n')}\n`);

function runCase(item: BenchCase): void {
  const rawPayload = createRawPayload(item.rawBytes);
  const displayPayload = buildDisplayPayload(item);
  const displayFrame = encodeDisplayFrame(1, 1, displayPayload);
  const rawFrame = encodeRawPtyFrame(rawPayload);
  const displayBytes = displayFrame.byteLength;
  const rawBytes = rawFrame.byteLength;
  const expansion = displayBytes / rawBytes;
  const displayGrid = new Uint8Array(item.cols * item.rows * CELL_BYTES);

  lines.push('');
  lines.push(
    `${item.name}: rawFrame=${formatBytes(rawBytes)} displayFrame=${formatBytes(displayBytes)} display/raw=${expansion.toFixed(2)}x iterations=${item.iterations}`,
  );

  const rawFrameOnly = bench(`${item.name}:raw-frame-only`, item.iterations, () => {
    const encoded = encodeRawPtyFrame(rawPayload);
    const decoded = decodeRawPtyFrame(encoded);
    return decoded === null ? 0 : decoded.byteLength;
  });

  const displayFrameOnly = bench(`${item.name}:display-frame-only`, item.iterations, () => {
    const encoded = encodeDisplayFrame(1, 1, displayPayload);
    const decoded = decodeDisplayFrameView(encoded, encoded.byteLength);
    return decoded === null ? 0 : decoded.payload.byteLength;
  });

  const rawEndToEnd = bench(`${item.name}:raw-e2e-lower-bound`, item.iterations, () => {
    const encoded = encodeRawPtyFrame(rawPayload);
    const decoded = decodeRawPtyFrame(encoded);
    return decoded === null ? 0 : scanRawPtyBytes(decoded);
  });

  const displayEndToEnd = bench(`${item.name}:display-e2e-lower-bound`, item.iterations, () => {
    const payload = buildDisplayPayload(item);
    const encoded = encodeDisplayFrame(1, 1, payload);
    const decoded = decodeDisplayFrameView(encoded, encoded.byteLength);
    if (decoded === null) return 0;
    return applyDisplayPayload(decoded.payload, displayGrid, item.cols);
  });

  pushResult(rawFrameOnly);
  pushResult(displayFrameOnly);
  pushResult(rawEndToEnd);
  pushResult(displayEndToEnd);
  lines.push(
    `${item.name}: display-e2e/raw-e2e=${(displayEndToEnd.avgUs / rawEndToEnd.avgUs).toFixed(2)}x display-frame/raw-frame=${(displayFrameOnly.avgUs / rawFrameOnly.avgUs).toFixed(2)}x`,
  );
}

function bench(name: string, iterations: number, run: () => number): BenchResult {
  let checksum = run();
  const beforeHeap = process.memoryUsage().heapUsed;
  const start = performance.now();
  for (let index = 0; index < iterations; index += 1) {
    checksum = (checksum + run()) >>> 0;
  }
  const elapsedMs = performance.now() - start;
  const heapDelta = process.memoryUsage().heapUsed - beforeHeap;
  return {
    name,
    iterations,
    elapsedMs,
    avgUs: (elapsedMs * 1000) / iterations,
    opsPerSecond: Math.round((iterations / elapsedMs) * 1000),
    heapDelta,
    checksum,
  };
}

function pushResult(result: BenchResult): void {
  lines.push(
    `${result.name}: ${result.opsPerSecond.toLocaleString('en-US')} ops/s, avg=${result.avgUs.toFixed(2)}us, elapsed=${result.elapsedMs.toFixed(1)}ms, heapDelta=${formatBytes(result.heapDelta)}, checksum=${result.checksum}`,
  );
  emitPerfMetric({
    name: result.name,
    value: result.avgUs,
    unit: 'us/op',
    direction: 'lower',
    sampleSize: result.iterations,
  });
}

function createRawPayload(byteLength: number): Uint8Array {
  const payload = new Uint8Array(byteLength);
  for (let index = 0; index < payload.byteLength; index += 1) {
    payload[index] = index % 64 === 0 ? 0x1b : 32 + (index % 95);
  }
  return payload;
}

function encodeRawPtyFrame(payload: Uint8Array): Uint8Array {
  if (payload.byteLength > U24_MAX) {
    throw new Error('raw payload too large');
  }
  const frame = new Uint8Array(FRAME_HEADER_BYTES + payload.byteLength);
  frame[0] = RAW_FRAME_TYPE;
  frame[1] = (payload.byteLength >>> 16) & 0xff;
  frame[2] = (payload.byteLength >>> 8) & 0xff;
  frame[3] = payload.byteLength & 0xff;
  frame.set(payload, FRAME_HEADER_BYTES);
  return frame;
}

function decodeRawPtyFrame(frame: Uint8Array): Uint8Array | null {
  if (frame.byteLength < FRAME_HEADER_BYTES || frame[0] !== RAW_FRAME_TYPE) {
    return null;
  }
  const declaredLength = ((frame[1] ?? 0) << 16) | ((frame[2] ?? 0) << 8) | (frame[3] ?? 0);
  if (declaredLength + FRAME_HEADER_BYTES !== frame.byteLength) {
    return null;
  }
  return frame.subarray(FRAME_HEADER_BYTES);
}

function scanRawPtyBytes(payload: Uint8Array): number {
  let accumulator = 0;
  for (let index = 0; index < payload.byteLength; index += 1) {
    const byte = payload[index] ?? 0;
    if (byte === 0x1b) accumulator += 7;
    else if (byte >= 0x20) accumulator += 1;
  }
  return accumulator;
}

function writeU16BE_arr(buf: Uint8Array, offset: number, value: number): void {
  buf[offset] = (value >>> 8) & 0xff;
  buf[offset + 1] = value & 0xff;
}

function writeU32BE_arr(buf: Uint8Array, offset: number, value: number): void {
  buf[offset] = (value >>> 24) & 0xff;
  buf[offset + 1] = (value >>> 16) & 0xff;
  buf[offset + 2] = (value >>> 8) & 0xff;
  buf[offset + 3] = value & 0xff;
}

function buildDisplayPayload(item: BenchCase): Uint8Array {
  const reset = item.displayKind === 'snapshot';
  const segmentRows = reset ? item.rows : Math.min(item.rows, item.dirtyRows);
  const segmentCols = reset ? item.cols : Math.min(item.cols, item.dirtyCols);
  // Fixed header includes independent frame and presentation identities.
  const header = new Uint8Array(DISPLAY_PATCH_BODY_HEADER_BYTES);
  header[0] = DISPLAY_PATCH_VERSION;
  header[1] = reset ? DISPLAY_PATCH_FLAG_RESET : 0;
  writeU16BE_arr(header, 2, item.cols);
  writeU16BE_arr(header, 4, item.rows);
  // cursorCol, cursorRow = 0 (already zeroed)
  header[10] = 0x11; // cursor byte
  // modeFlags = 0 (already zeroed)
  writeU32BE_arr(header, 13, 1); // frameId = 1
  // presentationId and chunkIndex = 0 (already zeroed)
  writeU16BE_arr(header, 23, 1); // chunkCount = 1
  writeU16BE_arr(header, 25, segmentRows); // rowCount
  // member index/count, row predecessor and demand serial = 0 (already zeroed)

  // Build row segments with fixed prefix
  const segments: Uint8Array[] = [];
  for (let row = 0; row < segmentRows; row += 1) {
    const cells = buildRawCells(segmentCols, row);
    const prefix = new Uint8Array(8);
    writeU16BE_arr(prefix, 0, row);
    writeU16BE_arr(prefix, 2, 0); // left = 0
    writeU16BE_arr(prefix, 4, segmentCols);
    writeU16BE_arr(prefix, 6, cells.byteLength);
    const segment = new Uint8Array(8 + cells.byteLength);
    segment.set(prefix, 0);
    segment.set(cells, 8);
    segments.push(segment);
  }

  const payload = new Uint8Array(
    DISPLAY_PATCH_BODY_HEADER_BYTES + segments.reduce((b, s) => b + s.byteLength, 0),
  );
  payload.set(header, 0);
  let offset = DISPLAY_PATCH_BODY_HEADER_BYTES;
  for (const segment of segments) {
    payload.set(segment, offset);
    offset += segment.byteLength;
  }
  return payload;
}

function encodeDisplayFrame(generation: number, seq: number, payload: Uint8Array): Uint8Array {
  const frame = new Uint8Array(DISPLAY_STREAM_HEADER_BYTES + payload.byteLength);
  frame[0] = DISPLAY_PATCH_FRAME_TYPE;
  frame[1] = (payload.byteLength >>> 16) & 0xff;
  frame[2] = (payload.byteLength >>> 8) & 0xff;
  frame[3] = payload.byteLength & 0xff;
  writeU32BE(frame, 4, seq);
  writeU32BE(frame, 8, generation);
  frame.set(payload, DISPLAY_STREAM_HEADER_BYTES);
  return frame;
}

function decodeDisplayFrameView(frame: Uint8Array, maxBytes: number): DisplayFrameView | null {
  if (frame.byteLength > maxBytes || frame.byteLength < DISPLAY_STREAM_HEADER_BYTES) return null;
  if (frame[0] !== DISPLAY_PATCH_FRAME_TYPE) return null;
  const declaredLength = ((frame[1] ?? 0) << 16) | ((frame[2] ?? 0) << 8) | (frame[3] ?? 0);
  if (declaredLength !== frame.byteLength - DISPLAY_STREAM_HEADER_BYTES) return null;
  return { payload: frame.subarray(DISPLAY_STREAM_HEADER_BYTES) };
}

function buildRawCells(count: number, seed: number): Uint8Array {
  const payload = new Uint8Array(count * CELL_BYTES);
  for (let cell = 0; cell < count; cell += 1) {
    const offset = cell * CELL_BYTES;
    const codepoint = 32 + ((cell + seed) % 95);
    payload[offset] = codepoint & 0xff;
    payload[offset + 1] = (codepoint >>> 8) & 0xff;
    payload[offset + 2] = 0;
    payload[offset + 3] = 0;
    payload[offset + 4] = 240;
    payload[offset + 5] = 240;
    payload[offset + 6] = 240;
    payload[offset + 7] = 10;
    payload[offset + 8] = 10;
    payload[offset + 9] = 10;
    payload[offset + 10] = cell % 17 === 0 ? 1 : 0;
  }
  return payload;
}

function applyDisplayPayload(payload: Uint8Array, grid: Uint8Array, cols: number): number {
  const segmentCount = readU16BE(payload, 25);
  let offset = DISPLAY_PATCH_BODY_HEADER_BYTES;
  let copiedBytes = 0;
  for (let segment = 0; segment < segmentCount; segment += 1) {
    const rowVal = readU16BE(payload, offset);
    const leftVal = readU16BE(payload, offset + 2);
    const cellCountVal = readU16BE(payload, offset + 4);
    const byteCountVal = readU16BE(payload, offset + 6);
    offset += 8;
    const targetOffset = (rowVal * cols + leftVal) * CELL_BYTES;
    grid.set(payload.subarray(offset, offset + byteCountVal), targetOffset);
    offset += byteCountVal;
    copiedBytes += cellCountVal * CELL_BYTES;
  }
  return copiedBytes;
}

function readU16BE(target: Uint8Array, offset: number): number {
  return (((target[offset] ?? 0) << 8) | (target[offset + 1] ?? 0)) >>> 0;
}

function writeU32BE(buffer: Uint8Array, offset: number, value: number): void {
  buffer[offset] = (value >>> 24) & 0xff;
  buffer[offset + 1] = (value >>> 16) & 0xff;
  buffer[offset + 2] = (value >>> 8) & 0xff;
  buffer[offset + 3] = value & 0xff;
}

function formatBytes(value: number): string {
  const sign = value < 0 ? '-' : '';
  const abs = Math.abs(value);
  if (abs < 1024) return `${value}B`;
  if (abs < 1024 * 1024) return `${sign}${(abs / 1024).toFixed(1)}KiB`;
  return `${sign}${(abs / 1024 / 1024).toFixed(1)}MiB`;
}
