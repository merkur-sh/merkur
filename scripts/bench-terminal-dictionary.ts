/**
 * Terminal-WASM display-dictionary lookup benchmark.
 *
 * The timed path is the production JS -> WASM ingress copy, dictionary lookup,
 * zstd decode/validation into pooled scratch, and handle release. A previous
 * dictionary frame is also probed once outside the timed region so the common
 * harness can pin the baseline miss and the two-slot candidate hit.
 */
import path from 'node:path';
import {
  DISPLAY_CHUNK_COUNT_OFFSET,
  DISPLAY_COLUMNS_OFFSET,
  DISPLAY_COMPRESSED_LENGTH_OFFSET,
  DISPLAY_DATAGRAM_HEADER_BODY_LENGTH_OFFSET,
  DISPLAY_DICT_COMPRESSED_PAYLOAD_OFFSET,
  DISPLAY_FRAME_ID_OFFSET,
  DISPLAY_GENERATION_OFFSET,
  DISPLAY_GRID_ROWS_OFFSET,
  DISPLAY_HEADER_FLAG_COMPRESSED_ZSTD,
  DISPLAY_HEADER_FLAG_COMPRESSED_ZSTD_DICT,
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
import { createSeededTextRows, trainFixtureDictionary } from './perf/display-text-rows';
import { emitPerfMetric, summarizeSamples } from './perf/harness';
import { builtZstdFixtureExecutable, zstdFixtureExecutable } from './perf/zstd-fixture';

const ROOT = path.resolve(import.meta.dir, '..');
const FIXTURE_BINARY = zstdFixtureExecutable();
const PREVIOUS_GENERATION = 41;
const CURRENT_GENERATION = PREVIOUS_GENERATION;
const PREVIOUS_ID = 7;
const CURRENT_ID = 8;
const DEFAULT_DICTIONARY_BYTES = 16 * 1024;
const DEFAULT_ROWS_BYTES = 16 * 1024;
const DEFAULT_SAMPLES = 30;
const DEFAULT_WARMUPS = 3;
const DEFAULT_ITERATIONS = 2_000;
const COLUMNS = 120;
const ROW_BYTES = DISPLAY_ROW_PREFIX_BYTES + 1 + COLUMNS * 2;
/** Receiver grid cap (`merkur_codec::MAX_TERMINAL_ROWS`). */
const MAX_ROWS = 256;

export type PreviousDictionaryExpectation = 'either' | 'hit' | 'miss';

interface DictionaryBlock {
  readonly hash: number;
  readonly compressed: Uint8Array;
}

interface DictionaryWireOptions extends DictionaryBlock {
  readonly generation: number;
  readonly id: number;
  readonly rowCount: number;
  readonly rowsBytes: number;
}

export function parsePreviousDictionaryExpectation(
  raw: string | undefined,
): PreviousDictionaryExpectation {
  const value = raw ?? 'either';
  if (value === 'either' || value === 'hit' || value === 'miss') return value;
  throw new Error('BENCH_EXPECT_PREVIOUS_DICTIONARY must be either, hit, or miss');
}

export function assertPreviousDictionaryExpectation(
  hit: boolean,
  expectation: PreviousDictionaryExpectation,
): void {
  if (expectation === 'either') return;
  if ((expectation === 'hit') !== hit) {
    throw new Error(`previous dictionary ${hit ? 'hit' : 'missed'}; expected ${expectation}`);
  }
}

export function createDictionaryCompressedFrame(options: DictionaryWireOptions): Uint8Array {
  if (
    options.generation === 0 ||
    options.id === 0 ||
    options.rowCount === 0 ||
    options.rowsBytes === 0
  ) {
    throw new RangeError(
      'dictionary wire generation, id, rowCount, and rowsBytes must be positive',
    );
  }
  const wire = new Uint8Array(
    DISPLAY_DICT_COMPRESSED_PAYLOAD_OFFSET + options.compressed.byteLength,
  );
  wire[0] = MESSAGE_TYPE_DISPLAY_PATCH;
  wire[1] = DISPLAY_HEADER_FLAG_COMPRESSED_ZSTD | DISPLAY_HEADER_FLAG_COMPRESSED_ZSTD_DICT;
  // Staging refuses sequence, frame and presentation 0 and a frame of no chunks.
  writeU32BE(wire, DISPLAY_SEQUENCE_OFFSET, 1);
  writeU32BE(wire, DISPLAY_GENERATION_OFFSET, options.generation);
  wire[DISPLAY_STREAM_HEADER_BYTES] = DISPLAY_PROTOCOL_VERSION;
  writeU16(wire, DISPLAY_COLUMNS_OFFSET, COLUMNS);
  writeU16(wire, DISPLAY_GRID_ROWS_OFFSET, options.rowCount);
  writeU32BE(wire, DISPLAY_FRAME_ID_OFFSET, 1);
  writeU32BE(wire, DISPLAY_PRESENTATION_ID_OFFSET, 1);
  writeU16(wire, DISPLAY_CHUNK_COUNT_OFFSET, 1);
  writeU16(wire, DISPLAY_ROW_COUNT_OFFSET, options.rowCount);
  writeU32BE(
    wire,
    DISPLAY_DATAGRAM_HEADER_BODY_LENGTH_OFFSET,
    wire.byteLength - DISPLAY_STREAM_HEADER_BYTES,
  );
  writeU32BE(wire, DISPLAY_COMPRESSED_LENGTH_OFFSET, options.rowsBytes);
  writeU32BE(wire, DISPLAY_COMPRESSED_LENGTH_OFFSET + 4, options.id);
  writeU32BE(wire, DISPLAY_COMPRESSED_LENGTH_OFFSET + 8, options.hash);
  wire.set(options.compressed, DISPLAY_DICT_COMPRESSED_PAYLOAD_OFFSET);
  return wire;
}

async function main(): Promise<void> {
  const samples = positiveInteger('BENCH_SAMPLES', DEFAULT_SAMPLES);
  const warmups = nonNegativeInteger('BENCH_WARMUPS', DEFAULT_WARMUPS);
  const iterations = positiveInteger('BENCH_ITERATIONS', DEFAULT_ITERATIONS);
  const dictionaryBytes = positiveInteger('BENCH_DICTIONARY_BYTES', DEFAULT_DICTIONARY_BYTES);
  const rowsBytes = positiveInteger('BENCH_ROWS_BYTES', DEFAULT_ROWS_BYTES);
  const rowCount = Math.floor(rowsBytes / ROW_BYTES);
  if (rowCount === 0 || rowCount > MAX_ROWS) {
    throw new Error(`BENCH_ROWS_BYTES must hold 1..${MAX_ROWS} rows of ${ROW_BYTES} bytes`);
  }
  const expectation = parsePreviousDictionaryExpectation(
    process.env.BENCH_EXPECT_PREVIOUS_DICTIONARY,
  );

  await builtZstdFixtureExecutable();

  const previousDictionary = createDictionary(dictionaryBytes, 0x1357_9bdf);
  const currentDictionary = createDictionary(dictionaryBytes, 0x2468_ace0);
  const previousRows = createRows(rowCount, 0x1357_9bdf);
  const currentRows = createRows(rowCount, 0x2468_ace0);
  const previousBlock = compressWithDictionary(previousDictionary, previousRows);
  const currentBlock = compressWithDictionary(currentDictionary, currentRows);
  const previousWire = createDictionaryCompressedFrame({
    generation: PREVIOUS_GENERATION,
    id: PREVIOUS_ID,
    rowCount,
    rowsBytes: previousRows.byteLength,
    ...previousBlock,
  });
  const currentWire = createDictionaryCompressedFrame({
    generation: CURRENT_GENERATION,
    id: CURRENT_ID,
    rowCount,
    rowsBytes: currentRows.byteLength,
    ...currentBlock,
  });

  const { runtime, terminal } = await loadBenchmarkTerminal(960, 640);
  let frameInputPtr = 0;
  let frameInputCapacity = 0;
  let checksum = 0;

  function stage(wire: Uint8Array): number {
    if (wire.byteLength > frameInputCapacity) {
      frameInputPtr = terminal.reserve_display_frame_input(wire.byteLength) >>> 0;
      if (frameInputPtr === 0) {
        throw new Error(`dictionary benchmark reserve failed: ${terminal.take_last_error()}`);
      }
      frameInputCapacity = wire.byteLength;
    }
    new Uint8Array(runtime.memory.buffer, frameInputPtr, wire.byteLength).set(wire);
    return terminal.stage_display_frame_input(wire.byteLength) >>> 0;
  }

  function stageAndRelease(wire: Uint8Array): void {
    const handle = stage(wire);
    if (handle === 0) {
      throw new Error(`dictionary benchmark staging failed: ${terminal.take_last_error()}`);
    }
    checksum ^= handle;
    terminal.release_staged_frame(handle);
  }

  if (
    !terminal.install_display_dictionary(
      PREVIOUS_GENERATION,
      PREVIOUS_ID,
      previousBlock.hash,
      previousDictionary,
    )
  ) {
    throw new Error('failed to install previous dictionary fixture');
  }
  if (
    !terminal.install_display_dictionary(
      CURRENT_GENERATION,
      CURRENT_ID,
      currentBlock.hash,
      currentDictionary,
    )
  ) {
    throw new Error('failed to install current dictionary fixture');
  }

  const previousHandle = stage(previousWire);
  const previousHit = previousHandle !== 0;
  if (previousHit) {
    terminal.release_staged_frame(previousHandle);
  } else {
    const error = terminal.take_last_error();
    if (error !== 'compressed_display_dictionary_missing') {
      throw new Error(`unexpected previous dictionary failure: ${error ?? 'none'}`);
    }
  }
  assertPreviousDictionaryExpectation(previousHit, expectation);
  stageAndRelease(currentWire);

  for (let index = 0; index < warmups; index += 1) {
    measure(iterations, () => stageAndRelease(currentWire));
  }
  const currentHitSamples: number[] = [];
  for (let index = 0; index < samples; index += 1) {
    currentHitSamples.push(measure(iterations, () => stageAndRelease(currentWire)));
  }
  const summary = summarizeSamples(currentHitSamples);
  for (const [suffix, percentile, value] of [
    ['p50', 0.5, summary.median],
    ['p95', 0.95, summary.p95],
    ['p99', 0.99, summary.p99],
  ] as const) {
    emitPerfMetric({
      name: `terminal-dictionary-current-hit-${suffix}`,
      value,
      unit: 'ns/op',
      direction: 'lower',
      percentile,
      sampleSize: samples,
    });
  }
  emitPerfMetric({
    name: 'terminal-dictionary-previous-hit',
    value: previousHit ? 1 : 0,
    unit: 'boolean',
    direction: 'higher',
    sampleSize: 1,
  });
  process.stdout.write(
    `terminal dictionary: current=hit previous=${previousHit ? 'hit' : 'miss'} ` +
      `expect=${expectation} dictionary=${dictionaryBytes}B rows=${rowCount}x${COLUMNS} ` +
      `samples=${samples} iterations=${iterations} checksum=${checksum >>> 0}\n`,
  );
  terminal.free();
}

function compressWithDictionary(dictionary: Uint8Array, payload: Uint8Array): DictionaryBlock {
  const input = new Uint8Array(dictionary.byteLength + payload.byteLength);
  input.set(dictionary, 0);
  input.set(payload, dictionary.byteLength);
  const result = Bun.spawnSync([FIXTURE_BINARY, `--dictionary-bytes=${dictionary.byteLength}`], {
    cwd: ROOT,
    stdin: input,
    stdout: 'pipe',
    stderr: 'inherit',
  });
  if (result.exitCode !== 0 || result.stdout.byteLength <= 4) {
    throw new Error(`dictionary fixture failed for ${payload.byteLength} payload bytes`);
  }
  const output = new Uint8Array(result.stdout);
  const hash = new DataView(output.buffer, output.byteOffset, 4).getUint32(0, false);
  return { hash, compressed: output.slice(4) };
}

// A frame's rows come from its dictionary's seed, so they repeat the rows the
// dictionary was trained on.
function createDictionary(size: number, seed: number): Uint8Array {
  return trainFixtureDictionary(FIXTURE_BINARY, ROOT, COLUMNS, size, seed);
}

function createRows(rows: number, seed: number): Uint8Array {
  return createSeededTextRows(rows, COLUMNS, seed);
}

function measure(iterations: number, operation: () => void): number {
  const startedAt = performance.now();
  for (let index = 0; index < iterations; index += 1) operation();
  return ((performance.now() - startedAt) * 1_000_000) / iterations;
}

function writeU16(target: Uint8Array, offset: number, value: number): void {
  target[offset] = (value >>> 8) & 0xff;
  target[offset + 1] = value & 0xff;
}

function positiveInteger(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return value;
}

function nonNegativeInteger(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative safe integer`);
  }
  return value;
}

if (import.meta.main) await main();
