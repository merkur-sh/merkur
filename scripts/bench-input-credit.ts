/** Input-ring custody workloads, including paths that never refund credit. */
import { fullGC, heapStats } from 'bun:jsc';
import { readFileSync } from 'node:fs';
import { readerNeedsWakeAfterPublish } from '../apps/web/src/lib/spsc-ring-wake';
import {
  type createInputRingReader,
  type createInputRingWriter,
  INPUT_RING_SIZE,
} from '../apps/web/src/transport/input-ring';
import * as prediction from '../apps/web/src/transport/prediction-admission';
import { perfEnvInteger, summarizeSamples } from './perf/harness';
import { pairedInstructions } from './perf/paired-instructions';

const timingOps = perfEnvInteger('BENCH_TIMING_OPS', 100_000);

type Ring = {
  createInputRingReader: typeof createInputRingReader;
  createInputRingWriter: typeof createInputRingWriter;
};

function ringCode(path: string | URL): string {
  const source = readFileSync(path, 'utf8');
  const start = source.indexOf('// meta (Int32Array):');
  if (start < 0) throw new Error('missing production input ring');
  const code = new Bun.Transpiler({ loader: 'ts' }).transformSync(
    source.slice(start).replaceAll('export ', ''),
  );
  return `${code}\nreturn { createInputRingReader, createInputRingWriter };`;
}

const production = ringCode(new URL('../apps/web/src/transport/input-ring.ts', import.meta.url));
const comparison =
  process.env.BENCH_COMPARE_SOURCE === undefined
    ? production
    : ringCode(process.env.BENCH_COMPARE_SOURCE);
const dependencies = { readerNeedsWakeAfterPublish, ...prediction };
const rings: Ring[] = [comparison, production, comparison].map((code) =>
  new Function(...Object.keys(dependencies), code)(...Object.values(dependencies)),
);

type Workload = 'release' | 'discard' | 'copy' | 'refused' | 'empty' | 'already-released';

function cells(): number {
  const counts = heapStats().objectTypeCounts;
  let total = 0;
  for (const key in counts) total += counts[key] ?? 0;
  return total;
}

function driver(ring: Ring, workload: Workload, bytes: number, batch: number): () => void {
  const sab = new SharedArrayBuffer(workload === 'refused' ? 64 : INPUT_RING_SIZE);
  const writer = ring.createInputRingWriter(sab);
  const reader = ring.createInputRingReader(sab);
  const payload = new Uint8Array(bytes).fill(97);
  const copied = new Uint8Array(bytes);
  let sequence = 0;
  if (workload === 'copy') {
    writer.write(++sequence, payload);
    reader.tryReadNext();
    return () => reader.copyPayload(0, copied, 0);
  }
  if (workload === 'refused') {
    writer.write(++sequence, payload);
    return () => {
      if (writer.write(++sequence, payload)) throw new Error('full ring admitted input');
    };
  }
  if (workload === 'empty')
    return () => {
      if (reader.tryReadNext() !== -1) throw new Error('empty ring produced input');
    };
  if (workload === 'already-released') return () => reader.release(0);
  return () => {
    for (let index = 0; index < batch; index++) {
      if (!writer.write(++sequence, payload)) throw new Error('credit refused');
      if (workload === 'release' && reader.tryReadNext() < 0)
        throw new Error('published input missing');
    }
    if (workload === 'release') reader.release(reader.consumedOrdinal());
    else if (reader.discardQueuedEntries() !== batch) throw new Error('queued input missing');
    if (writer.bufferedBytes() !== 0 || writer.bufferedEntries() !== 0)
      throw new Error('credit leaked');
  };
}

async function measure(workload: Workload, bytes: number, batch: number): Promise<void> {
  const count = bytes >= 16_384 || batch > 1 ? Math.min(timingOps, 2_048) : timingOps;
  const runs = rings.map((ring) => driver(ring, workload, bytes, batch));
  const counts = await pairedInstructions((arm) => {
    const run = runs[arm];
    if (run === undefined) throw new Error('missing input arm');
    return () => {
      for (let index = 0; index < count; index++) run();
    };
  }, count);
  const heaps = [];
  for (const run of runs) {
    const allocations = [];

    for (let sample = 0; sample < 11; sample++) {
      fullGC();
      const controlStart = cells();
      const controlEnd = cells();
      fullGC();
      const before = cells();
      for (let index = 0; index < 512; index++) run();
      const after = cells();
      allocations.push((after - before - controlEnd + controlStart) / 512);
    }
    heaps.push(summarizeSamples(allocations).median);
  }
  process.stdout.write(
    `${JSON.stringify({ name: `${workload}/${bytes}/${batch}`, heaps, ...counts })}\n`,
  );
}

async function measureRefunds(bytes: number, batch: number): Promise<void> {
  const name = `refund-only/${bytes}/${batch}`;
  if (process.env.BENCH_CASE !== undefined && process.env.BENCH_CASE !== name) return;
  for (const ring of rings) {
    const warm = driver(ring, 'release', bytes, batch);
    for (let index = 0; index < 20_000; index++) warm();
  }
  const count = 128;
  const payload = new Uint8Array(bytes).fill(97);
  const counts = await pairedInstructions((arm) => {
    const ring = rings[arm];
    if (ring === undefined) throw new Error('missing refund arm');
    const readers = Array.from({ length: count }, () => {
      const sab = new SharedArrayBuffer(INPUT_RING_SIZE);
      const writer = ring.createInputRingWriter(sab);
      const reader = ring.createInputRingReader(sab);
      for (let sequence = 1; sequence <= batch; sequence++) {
        if (!writer.write(sequence, payload) || reader.tryReadNext() < 0)
          throw new Error('refund setup refused');
      }
      return reader;
    });
    return () => {
      for (const reader of readers) reader.release(batch);
    };
  }, count);
  process.stdout.write(`${JSON.stringify({ name, ...counts })}\n`);
}

if (import.meta.main) {
  for (const [bytes, batch] of [
    [2, 1],
    [16_384, 1],
    [2, 64],
  ] as const)
    await measureRefunds(bytes, batch);
  for (const [workload, bytes, batch] of [
    ['release', 2, 1],
    ['release', 16_384, 1],
    ['release', 2, 64],
    ['discard', 2, 64],
    ['copy', 2, 1],
    ['copy', 16_384, 1],
    ['refused', 16, 1],
    ['empty', 0, 1],
    ['already-released', 0, 1],
  ] as const)
    if (
      process.env.BENCH_CASE === undefined ||
      process.env.BENCH_CASE === `${workload}/${bytes}/${batch}`
    )
      await measure(workload, bytes, batch);
}
