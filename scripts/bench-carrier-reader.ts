/** Native stream record allocations and startup-free instruction counts with an identical null. */
import { estimateShallowMemoryUsageOf, fullGC, heapStats } from 'bun:jsc';
import type { CarrierReader } from '../apps/web/src/transport/client-carrier';
import { carrierRecord } from '../apps/web/src/transport/client-carrier';
import { carrierChunks } from './perf/carrier-reader-fixture';
import { carrierReaderSources } from './perf/carrier-reader-source';
import { summarizeSamples } from './perf/harness';
import { pairedInstructions } from './perf/paired-instructions';

type ReaderMode = 'record' | 'exact' | 'part' | 'eof' | 'truncated' | 'oversized';

type Constructor = {
  new (reader: ReadableStreamDefaultReader<Uint8Array>): CarrierReader;
  prototype: CarrierReader;
};

const { production, comparison } = carrierReaderSources();
const constructors: Constructor[] = [comparison, production, comparison].map((code) =>
  new Function(code)(),
);

function source(
  Constructor: Constructor,
  chunks: readonly Uint8Array[],
  count: number,
): CarrierReader {
  const SharedReader = constructors[0];
  if (SharedReader === undefined) throw new Error('missing shared reader');
  const reader = new SharedReader(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (let index = 0; index < count; index++)
          for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    }).getReader(),
  );
  reader.record = Constructor.prototype.record;
  return reader;
}

async function consume(
  reader: CarrierReader,
  count: number,
  length: number,
  mode: ReaderMode,
): Promise<void> {
  for (let index = 0; index < count; index++) {
    if (mode === 'eof' || mode === 'truncated' || mode === 'oversized') {
      try {
        if ((await reader.record(64)) !== null || mode !== 'eof')
          throw new Error('unexpected record success');
      } catch (error) {
        if (
          mode === 'eof' ||
          !(error instanceof Error) ||
          !error.message.includes(
            mode === 'oversized' ? 'exceeds its bound' : 'ended within a record',
          )
        )
          throw error;
      }
      continue;
    }
    let body: Uint8Array | null;
    switch (mode) {
      case 'record':
        body = await reader.record();
        break;
      case 'part':
        body = await reader.part();
        break;
      default:
        body = await reader.exact(length);
        break;
    }
    if (body === null || body.byteLength !== length || (length > 0 && body[0] !== 97))
      throw new Error('carrier byte oracle diverged');
  }
}

function snapshot() {
  const stats = heapStats();
  let cells = 0;
  for (const key in stats.objectTypeCounts) cells += stats.objectTypeCounts[key] ?? 0;
  return cells;
}

async function allocations(
  Constructor: Constructor,
  chunks: Uint8Array[],
  length: number,
  mode: ReaderMode,
) {
  const cells = [];
  for (let sample = 0; sample < 11; sample++) {
    const reader = source(Constructor, chunks, 32);
    fullGC();
    const controlBefore = snapshot();
    const controlAfter = snapshot();
    fullGC();
    const before = snapshot();
    await consume(reader, 32, length, mode);
    const after = snapshot();
    cells.push((after - before - controlAfter + controlBefore) / 32);
  }
  return summarizeSamples(cells).median;
}

async function bufferAllocations(
  Constructor: Constructor,
  chunks: Uint8Array[],
  length: number,
  mode: ReaderMode,
) {
  const reader = source(Constructor, chunks, 1);
  const Uint8 = Uint8Array;
  const View = DataView;
  const subarray = Uint8.prototype.subarray;
  const existingBuffers = new Set(chunks.map((chunk) => chunk.buffer));
  const counts = {
    buffers: 0,
    bufferBytes: 0,
    arrayBufferObjects: 0,
    dataViews: 0,
    subarrays: 0,
    shallowBytes: 0,
  };
  try {
    globalThis.Uint8Array = new Proxy(Uint8, {
      construct(target, args) {
        const size = args[0];
        if (!Number.isSafeInteger(size) || size < 0)
          throw new Error('expected numeric buffer size');
        counts.buffers++;
        counts.bufferBytes += size;
        const array = Reflect.construct(target, args);
        counts.shallowBytes += estimateShallowMemoryUsageOf(array);
        return array;
      },
    });
    globalThis.DataView = new Proxy(View, {
      construct(target, args) {
        counts.dataViews++;
        const buffer: ArrayBuffer = args[0];
        if (!existingBuffers.has(buffer)) {
          existingBuffers.add(buffer);
          counts.arrayBufferObjects++;
          // Numeric typed-array construction already counted this backing storage.
          counts.shallowBytes += estimateShallowMemoryUsageOf(buffer) - buffer.byteLength;
        }
        const view = Reflect.construct(target, args);
        counts.shallowBytes += estimateShallowMemoryUsageOf(view);
        return view;
      },
    });
    Uint8.prototype.subarray = function (start, end) {
      counts.subarrays++;
      const view = subarray.call(this, start, end);
      counts.shallowBytes += estimateShallowMemoryUsageOf(view);
      return view;
    };
    await consume(reader, 1, length, mode);
  } finally {
    globalThis.Uint8Array = Uint8;
    globalThis.DataView = View;
    Uint8.prototype.subarray = subarray;
  }
  return counts;
}

async function measure(mode: ReaderMode, length: number, splits: number, empty: boolean) {
  const name = `${mode}/${length}/${splits}/${Number(empty)}`;
  if (process.env.BENCH_CASE !== undefined && process.env.BENCH_CASE !== name) return;
  const payload = new Uint8Array(length).fill(97);
  let chunks: Uint8Array[];
  switch (mode) {
    case 'record':
      chunks = carrierChunks(carrierRecord(payload), splits, empty);
      break;
    case 'eof':
      chunks = [];
      break;
    case 'truncated':
      chunks = [new Uint8Array(length)];
      break;
    case 'oversized':
      chunks = carrierChunks(Uint8Array.of(255, 255, 255, 255), splits, empty);
      break;
    default:
      chunks = [payload];
      break;
  }
  const terminal = mode === 'eof' || mode === 'truncated' || mode === 'oversized';
  const count = terminal ? 128 : length >= 16_384 ? 512 : 2_048;
  const prepare = (arm: number) => {
    const Constructor = constructors[arm];
    if (Constructor === undefined) throw new Error('missing carrier arm');
    if (terminal) {
      const readers = Array.from({ length: count }, () => source(Constructor, chunks, 1));
      return async () => {
        for (const reader of readers) await consume(reader, 1, length, mode);
      };
    }
    const reader = source(Constructor, chunks, count);
    return () => consume(reader, count, length, mode);
  };
  const counts = await pairedInstructions(prepare, count);
  const heaps = [];
  const buffers = [];
  for (const Constructor of constructors) {
    heaps.push(terminal ? null : await allocations(Constructor, chunks, length, mode));
    buffers.push(await bufferAllocations(Constructor, chunks, length, mode));
  }
  process.stdout.write(`${JSON.stringify({ name, heaps, buffers, ...counts })}\n`);
}

if (import.meta.main) {
  for (const length of [0, 64, 16_384])
    for (let splits = 0; splits < 8; splits++)
      for (const empty of [false, true]) await measure('record', length, splits, empty);
  await measure('eof', 0, 0, false);
  for (const length of [1, 2, 3]) await measure('truncated', length, 0, false);
  for (let splits = 0; splits < 8; splits++) await measure('oversized', 0, splits, true);
  for (const mode of ['exact', 'part'] as const)
    for (const length of [64, 16_384]) await measure(mode, length, 0, false);
}
