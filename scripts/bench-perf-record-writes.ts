/** Stores and JSC heap cells at the production telemetry writer, one event kind per row. */
import { fullGC, heapStats } from 'bun:jsc';
import { readFileSync } from 'node:fs';
import { encodePerfEvent } from '../apps/web/src/perf/perf-event-codec';
import {
  createPerfRingBuffer,
  createPerfRingWriter,
  type PerfRingWriter,
} from '../apps/web/src/perf/perf-ring';
import {
  createPerfStringInterner,
  createPerfStringTableBuffer,
} from '../apps/web/src/perf/perf-string-table';
import type { TerminalPerfEvent } from '../apps/web/src/perf/terminal-latency';
import { summarizeSamples } from './perf/harness';

function samples(): readonly TerminalPerfEvent[] {
  const source = readFileSync(
    new URL('../apps/web/src/perf/perf-event-codec.test.ts', import.meta.url),
    'utf8',
  );
  const declaration = source.indexOf('const SAMPLES:');
  const start = source.indexOf('= [', declaration) + 2;
  const end = source.indexOf('\n];', start) + 2;
  if (declaration < 0 || start < declaration || end < start)
    throw new Error('missing codec event fixtures');
  return new Function(`return (${source.slice(start, end)});`)();
}

function cells(): number {
  const counts = heapStats().objectTypeCounts;
  let total = 0;
  for (const key in counts) total += counts[key] ?? 0;
  return total;
}

function measure(event: TerminalPerfEvent, sample: number): void {
  const sab = createPerfRingBuffer(64);
  const writer = createPerfRingWriter(sab);
  const interner = createPerfStringInterner(createPerfStringTableBuffer());
  let explicitBytes = 0;
  let clearedBytes = 0;
  const counted: PerfRingWriter = {
    begin(kind) {
      explicitBytes += 4;
      writer.begin(kind);
    },
    f64(slot, value) {
      explicitBytes += 8;
      writer.f64(slot, value);
    },
    u32(slot, value) {
      explicitBytes += 4;
      writer.u32(slot, value);
    },
    i32(slot, value) {
      explicitBytes += 4;
      writer.i32(slot, value);
    },
    commit() {
      writer.commit();
    },
    get writtenCount() {
      return writer.writtenCount;
    },
  };
  const fill = Uint32Array.prototype.fill;
  try {
    Uint32Array.prototype.fill = function (this: Uint32Array, value, start = 0, end = this.length) {
      if (this.buffer === sab) clearedBytes += (end - start) * 4;
      return fill.call(this, value, start, end);
    };
    if (!encodePerfEvent(counted, interner, event)) throw new Error('invalid event fixture');
  } finally {
    Uint32Array.prototype.fill = fill;
  }
  const run = (count: number): void => {
    for (let index = 0; index < count; index++) encodePerfEvent(writer, interner, event);
  };
  for (let warmup = 0; warmup < 20; warmup++) run(1_000);
  const allocations: number[] = [];
  for (let index = 0; index < 15; index++) {
    fullGC();
    const controlStart = cells();
    const controlCells = cells() - controlStart;
    fullGC();
    const before = cells();
    run(256);
    allocations.push((cells() - before - controlCells) / 256);
  }
  const timings: number[] = [];
  for (let index = 0; index < 31; index++) {
    const start = performance.now();
    run(10_000);
    timings.push((performance.now() - start) * 100);
  }
  process.stdout.write(
    `${JSON.stringify({ kind: event.kind, sample, explicitBytes, clearedBytes, storedBytes: explicitBytes + clearedBytes, cellsPerEvent: summarizeSamples(allocations).median, nsPerEvent: summarizeSamples(timings), written: writer.writtenCount })}\n`,
  );
}

if (import.meta.main) {
  samples().forEach((event, index) => {
    if (process.env.BENCH_KIND === undefined || process.env.BENCH_KIND === event.kind)
      measure(event, index);
  });
}
