/**
 * Cells and time per record drained from a profiling perf ring.
 *
 * `scripts/bench-perf-ring.ts` prices the writer, the side every producer
 * thread pays per event. This prices the reader: the telemetry worker drains
 * all three rings on every tick, every compact status poll, and every
 * observation boundary, copying each record out of shared memory before the
 * decoder sees it. At the ring's design rate (~1,200 events/s) and in a redraw
 * storm (~11,000 rows/s, the figure `telemetry-worker.ts` records) every cell
 * allocated per record is multiplied by that rate for the whole profiled
 * session.
 *
 * Workloads use the production writer and reader over three rings, drained in
 * turn as the telemetry worker drains its terminal, transport and main rings:
 *
 * - `drain-1200`: one second of events at the design rate.
 * - `drain-22000`: one two-second drain interval of a redraw storm.
 *
 * The visitor reads the kind and every slot, as `decodePerfEvent` may. Cells
 * are `bun:jsc` object-type counts across one drain with a full collection
 * before each snapshot, minus an empty drain. With
 * `BENCH_COMPARE_MODULE=/abs/path.ts` a second perf-ring module must first
 * return the identical visited sequence and drained/lost counts, including a
 * lapped ring, before the two are timed in ABBA order.
 */
import { fullGC, heapStats } from 'bun:jsc';
import * as production from '../apps/web/src/perf/perf-ring';
import { emitPerfMetric, perfEnvInteger } from './perf/harness';

type PerfRingModule = Pick<
  typeof production,
  | 'createPerfRingBuffer'
  | 'createPerfRingReader'
  | 'createPerfRingWriter'
  | 'PERF_RECORD_F64_SLOTS'
  | 'PERF_RECORD_U32_SLOTS'
>;

const WORKLOADS = [
  { name: 'drain-1200', records: 1_200 },
  { name: 'drain-22000', records: 22_000 },
] as const;
const RING_RECORDS = 65_536;
const ALLOCATION_SAMPLES = perfEnvInteger('BENCH_ALLOCATION_SAMPLES', 11);
const TIMING_SAMPLES = perfEnvInteger('BENCH_TIMING_SAMPLES', 120);
const WARMUPS = perfEnvInteger('BENCH_WARMUPS', 20);

let sink = 0;

interface Driver {
  fill(records: number): void;
  drain(): number;
}

/** The telemetry worker's shape: three producer rings, each drained in turn every tick. */
const PRODUCER_RINGS = 3;

function createDriver(module: PerfRingModule): Driver {
  const rings = Array.from({ length: PRODUCER_RINGS }, () => {
    const sab = module.createPerfRingBuffer(RING_RECORDS);
    return { writer: module.createPerfRingWriter(sab), reader: module.createPerfRingReader(sab) };
  });
  const f64Slots = module.PERF_RECORD_F64_SLOTS;
  const u32Slots = module.PERF_RECORD_U32_SLOTS;
  let serial = 0;
  let checksum = 0;
  const visit = (record: production.PerfRecordView): void => {
    let value = record.kind;
    for (let slot = 0; slot < f64Slots; slot += 1) value += record.f64(slot);
    for (let slot = 1; slot < u32Slots; slot += 1) value += record.u32(slot) + record.i32(slot);
    checksum += value;
  };
  return {
    fill(records: number): void {
      for (let index = 0; index < records; index += 1) {
        serial += 1;
        const writer = rings[serial % PRODUCER_RINGS]?.writer;
        if (writer === undefined) continue;
        writer.begin(1 + (serial % 23));
        writer.f64(0, serial * 0.25);
        writer.f64(3, serial);
        writer.u32(1, serial);
        writer.i32(2, -serial);
        writer.u32(7, serial * 3);
        writer.commit();
      }
    },
    drain(): number {
      let records = 0;
      for (const ring of rings) {
        const result = ring.reader.drain(visit);
        records += result.drained + result.lost;
      }
      sink += checksum;
      checksum = 0;
      return records;
    },
  };
}

/** Visited records and counts for an ordinary drain, a lapped drain, and an empty one. */
function oracle(module: PerfRingModule): string {
  const sab = module.createPerfRingBuffer(64);
  const writer = module.createPerfRingWriter(sab);
  const reader = module.createPerfRingReader(sab);
  const seen: number[] = [];
  const visit = (record: production.PerfRecordView): void => {
    seen.push(record.kind);
    for (let slot = 0; slot < module.PERF_RECORD_F64_SLOTS; slot += 1) seen.push(record.f64(slot));
    for (let slot = 0; slot < module.PERF_RECORD_U32_SLOTS; slot += 1) {
      seen.push(record.u32(slot), record.i32(slot));
    }
  };
  const write = (count: number, base: number): void => {
    for (let index = 0; index < count; index += 1) {
      writer.begin(base + index);
      writer.f64(index % module.PERF_RECORD_F64_SLOTS, (base + index) / 7);
      writer.u32(1 + (index % (module.PERF_RECORD_U32_SLOTS - 1)), base * 31 + index);
      writer.i32(2, -index);
      writer.commit();
    }
  };
  const counts: Array<{ drained: number; lost: number }> = [];
  write(40, 100);
  counts.push(reader.drain(visit));
  write(200, 1_000);
  counts.push(reader.drain(visit));
  counts.push(reader.drain(visit));
  return JSON.stringify({ counts, seen });
}

function cellTotal(): number {
  const counts = heapStats().objectTypeCounts;
  let total = 0;
  for (const key in counts) total += counts[key] ?? 0;
  return total;
}

function measureCellsPerRecord(driver: Driver, records: number): number {
  const perRecord: number[] = [];
  for (let sample = 0; sample < ALLOCATION_SAMPLES; sample += 1) {
    driver.drain();
    fullGC();
    const emptyBefore = cellTotal();
    driver.drain();
    driver.drain();
    const emptyCells = cellTotal() - emptyBefore;
    driver.fill(records);
    fullGC();
    const before = cellTotal();
    const drained = driver.drain();
    const pathCells = cellTotal() - before;
    // The two empty drains above bound the per-drain constant; charge one.
    perRecord.push((pathCells - emptyCells / 2) / drained);
  }
  perRecord.sort((left, right) => left - right);
  return perRecord[Math.floor(perRecord.length / 2)] ?? Number.NaN;
}

interface Summary {
  readonly median: number;
  readonly p95: number;
  readonly count: number;
}

function summarize(values: number[]): Summary {
  values.sort((left, right) => left - right);
  return {
    median: values[Math.floor(values.length / 2)] ?? Number.NaN,
    p95: values[Math.min(values.length - 1, Math.ceil(values.length * 0.95) - 1)] ?? Number.NaN,
    count: values.length,
  };
}

function timeDrain(driver: Driver, records: number): number {
  driver.fill(records);
  const startedAt = performance.now();
  const drained = driver.drain();
  return ((performance.now() - startedAt) * 1_000_000) / drained;
}

function measureTiming(
  drivers: readonly Driver[],
  records: number,
): { perModule: Summary[]; paired: Summary | null } {
  for (let warmup = 0; warmup < WARMUPS; warmup += 1) {
    for (const driver of drivers) timeDrain(driver, records);
  }
  const samples: number[][] = drivers.map(() => []);
  const differences: number[] = [];
  for (let sample = 0; sample < TIMING_SAMPLES; sample += 1) {
    const order = sample % 4 === 0 || sample % 4 === 3 ? [0, 1] : [1, 0];
    const round: number[] = [];
    for (const index of order) {
      const driver = drivers[index];
      if (driver === undefined) continue;
      round[index] = timeDrain(driver, records);
      samples[index]?.push(round[index] ?? Number.NaN);
    }
    if (round[0] !== undefined && round[1] !== undefined) differences.push(round[1] - round[0]);
  }
  return {
    perModule: samples.map((values) => summarize(values)),
    paired: differences.length > 0 ? summarize(differences) : null,
  };
}

async function loadCompareModule(): Promise<PerfRingModule | null> {
  const modulePath = process.env.BENCH_COMPARE_MODULE;
  if (modulePath === undefined || modulePath.length === 0) return null;
  return (await import(modulePath)) as PerfRingModule;
}

if (import.meta.main) {
  const compare = await loadCompareModule();
  const modules: PerfRingModule[] = compare === null ? [production] : [production, compare];
  const labels = compare === null ? ['production'] : ['production', 'compare'];
  const reference = oracle(production);
  for (let index = 1; index < modules.length; index += 1) {
    const module = modules[index];
    if (module !== undefined && oracle(module) !== reference) {
      throw new Error(`${labels[index]} perf ring diverges from production on the oracle`);
    }
  }
  process.stdout.write(
    `perf ring drain benchmark: ringRecords=${RING_RECORDS}, allocationSamples=${ALLOCATION_SAMPLES}, ` +
      `timingSamples=${TIMING_SAMPLES}, warmups=${WARMUPS}, oracle identical across ${modules.length} module(s)\n`,
  );
  for (const workload of WORKLOADS) {
    const drivers = modules.map((module) => createDriver(module));
    const timing = measureTiming(drivers, workload.records);
    drivers.forEach((driver, index) => {
      const cells = measureCellsPerRecord(driver, workload.records);
      const time = timing.perModule[index];
      const label = labels[index] ?? 'module';
      process.stdout.write(
        `${workload.name} [${label}]: cells/record=${cells.toFixed(3)}, ns/record median=` +
          `${time?.median.toFixed(2)} p95=${time?.p95.toFixed(2)} (n=${time?.count})\n`,
      );
      if (label !== 'production') return;
      emitPerfMetric({
        name: `perf-ring-${workload.name}-cells`,
        value: cells,
        unit: 'cells/record',
        direction: 'lower',
        sampleSize: ALLOCATION_SAMPLES,
      });
      emitPerfMetric({
        name: `perf-ring-${workload.name}-time`,
        value: time?.median ?? Number.NaN,
        unit: 'ns/record',
        direction: 'lower',
        percentile: 0.5,
        sampleSize: TIMING_SAMPLES,
      });
    });
    if (timing.paired !== null) {
      process.stdout.write(
        `${workload.name} [compare - production]: paired ns/record median=` +
          `${timing.paired.median.toFixed(2)} p95=${timing.paired.p95.toFixed(2)} ` +
          `(n=${timing.paired.count}, ABBA)\n`,
      );
    }
  }
  process.stdout.write(`sink=${sink}\n`);
}
