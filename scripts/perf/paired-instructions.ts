import { dlopen, FFIType } from 'bun:ffi';
import { fullGC } from 'bun:jsc';
import { summarizeSamples } from './harness';

// Darwin's rusage_info_v4: ri_instructions is at byte 248, in a 296-byte record.
const usage = new BigUint64Array(37);
const libproc = dlopen('/usr/lib/libproc.dylib', {
  proc_pid_rusage: {
    args: [FFIType.i32, FFIType.i32, FFIType.ptr],
    returns: FFIType.i32,
  },
});

function instructions(): number {
  if (libproc.symbols.proc_pid_rusage(process.pid, 4, usage) !== 0)
    throw new Error('proc_pid_rusage failed');
  const count = usage[31];
  if (count === undefined || count === 0n) throw new Error('instruction counter is unavailable');
  return Number(count);
}

type Batch = () => void | Promise<void>;
type Prepare = (arm: number) => Batch;

interface Observation {
  instructions: number;
  ns: number;
}
interface PairSample {
  before: number;
  after: number;
  delta: number;
  nullDelta: number;
  beforeNs: number;
  afterNs: number;
  deltaNs: number;
  nullDeltaNs: number;
}

async function sample(prepare: Prepare, arm: number, count: number) {
  const run = prepare(arm);
  fullGC();
  const before = instructions();
  const began = performance.now();
  await run();
  const ns = ((performance.now() - began) * 1_000_000) / count;
  return { instructions: (instructions() - before) / count, ns };
}

/** A/B/B/A followed by A/null/null/A; arm 2 is independently compiled identical A code. */
export async function pairedInstructions(prepare: Prepare, count: number, rounds = 11) {
  for (let warm = 0; warm < 4; warm++) for (const arm of [0, 1, 2]) await prepare(arm)();
  const samples: PairSample[] = [];
  for (let round = 0; round < rounds; round++) {
    const arms: Observation[] = [];
    for (const arm of [0, 1, 1, 0, 0, 2, 2, 0]) arms.push(await sample(prepare, arm, count));
    const mean = (left: number, right: number, metric: 'instructions' | 'ns') => {
      const first = arms[left];
      const second = arms[right];
      if (first === undefined || second === undefined) throw new Error('missing measured arm');
      return (first[metric] + second[metric]) / 2;
    };
    samples.push({
      before: mean(0, 3, 'instructions'),
      after: mean(1, 2, 'instructions'),
      delta: mean(1, 2, 'instructions') - mean(0, 3, 'instructions'),
      nullDelta: mean(5, 6, 'instructions') - mean(4, 7, 'instructions'),
      beforeNs: mean(0, 3, 'ns'),
      afterNs: mean(1, 2, 'ns'),
      deltaNs: mean(1, 2, 'ns') - mean(0, 3, 'ns'),
      nullDeltaNs: mean(5, 6, 'ns') - mean(4, 7, 'ns'),
    });
  }
  const summary = (key: keyof (typeof samples)[number]) =>
    summarizeSamples(samples.map((value) => value[key]));
  return {
    count,
    before: summary('before'),
    after: summary('after'),
    delta: summary('delta'),
    nullDelta: summary('nullDelta'),
    beforeNs: summary('beforeNs'),
    afterNs: summary('afterNs'),
    deltaNs: summary('deltaNs'),
    nullDeltaNs: summary('nullDeltaNs'),
    samples,
  };
}
