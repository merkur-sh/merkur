/**
 * Reader for the CPU profile `samply record --presymbolicate` writes at the pinned commit
 * (`packages/profile/README.md`): the Firefox profiler's processed format with shared
 * tables and symbol names inside. Its sample times are milliseconds after a zero samply
 * states on the anchor clock (`startTimeAsMachAbsoluteTimeNanoseconds` on macOS,
 * `startTimeAsClockMonotonicNanosecondsSinceBoot` on Linux), the clock a native trace
 * capture's origin is on, so the two share one timeline without estimation.
 */
import { gunzipSync } from 'node:zlib';
import { Option, Schema } from 'effect';
import type { NativeTraceClock } from './mtrace';

const Column = Schema.Array(Schema.Number);
const NullableColumn = Schema.Array(Schema.NullOr(Schema.Number));

const SamplyProfile = Schema.Struct({
  meta: Schema.Struct({
    startTimeAsMachAbsoluteTimeNanoseconds: Schema.optional(Schema.Number),
    startTimeAsClockMonotonicNanosecondsSinceBoot: Schema.optional(Schema.Number),
  }),
  libs: Schema.Array(Schema.Struct({ name: Schema.String })),
  shared: Schema.Struct({
    stringArray: Schema.Array(Schema.String),
    stackTable: Schema.Struct({ frame: Column, prefixOffset: Column }),
    frameTable: Schema.Struct({ func: Column, address: Column, lib: NullableColumn }),
    funcTable: Schema.Struct({ name: Column }),
  }),
  threads: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      pid: Schema.String,
      tid: Schema.String,
      samples: Schema.Struct({
        stack: NullableColumn,
        timeDeltas: Column,
        threadCPUDelta: Schema.optional(NullableColumn),
      }),
    }),
  ),
});

const decodeProfile = Schema.decodeUnknownOption(Schema.fromJsonString(SamplyProfile));

export interface CpuFrame {
  readonly name: string;
  readonly library: string;
  readonly address: number;
}

export interface CpuSample {
  /** Nanoseconds on the anchor clock. */
  readonly atNs: bigint;
  /** Frame indices, root first. */
  readonly stack: readonly number[];
}

export interface CpuThread {
  readonly pid: number;
  readonly tid: number;
  readonly name: string;
  readonly samples: readonly CpuSample[];
}

export interface CpuProfile {
  readonly clock: NativeTraceClock;
  readonly frames: readonly CpuFrame[];
  readonly threads: readonly CpuThread[];
}

export class CpuProfileDecodeError extends Error {
  override readonly name = 'CpuProfileDecodeError';
}

/**
 * The operating system's id in a samply pid or tid. On Linux samply writes `13711.1` for the
 * image a process exec'd into: the same OS id, told apart from the image before the exec.
 */
export function osId(value: string): number {
  const id = /^(\d+)(?:\.\d+)?$/.exec(value)?.[1];
  if (id === undefined) throw new CpuProfileDecodeError(`not a process or thread id: ${value}`);
  return Number(id);
}

/**
 * Decodes a gzipped samply profile. Only on-CPU samples are kept (`threadCPUDelta` above
 * zero): a sample of a parked thread says where it waits, not where CPU goes.
 */
export function decodeSamplyProfile(gzipped: Uint8Array): CpuProfile {
  const profile = Option.getOrNull(decodeProfile(new TextDecoder().decode(gunzipSync(gzipped))));
  if (profile === null)
    throw new CpuProfileDecodeError('not a samply profile of the pinned format');
  const mach = profile.meta.startTimeAsMachAbsoluteTimeNanoseconds;
  const monotonic = profile.meta.startTimeAsClockMonotonicNanosecondsSinceBoot;
  const zero = mach ?? monotonic;
  if (zero === undefined) throw new CpuProfileDecodeError('profile names no anchor-clock zero');
  const clock: NativeTraceClock = mach !== undefined ? 'mach-uptime-raw' : 'linux-monotonic';
  const { stringArray, stackTable, frameTable, funcTable } = profile.shared;
  const frames = frameTable.func.map((func, index): CpuFrame => {
    const nameIndex = funcTable.name[func];
    const lib = frameTable.lib[index];
    return {
      name: (nameIndex === undefined ? undefined : stringArray[nameIndex]) ?? '?',
      library: (lib === null || lib === undefined ? undefined : profile.libs[lib]?.name) ?? '?',
      address: frameTable.address[index] ?? 0,
    };
  });
  const chains = new Map<number, readonly number[]>();
  const chain = (stack: number): readonly number[] => {
    const known = chains.get(stack);
    if (known !== undefined) return known;
    const leafFirst: number[] = [];
    // A stack names its frame and how far back its prefix is; zero ends at the root.
    for (let index = stack; ; ) {
      const frame = stackTable.frame[index];
      const offset = stackTable.prefixOffset[index];
      if (frame === undefined || offset === undefined || offset > index) {
        throw new CpuProfileDecodeError(`stack ${index} is outside the stack table`);
      }
      leafFirst.push(frame);
      if (offset === 0) break;
      index -= offset;
    }
    const rootFirst = leafFirst.reverse();
    chains.set(stack, rootFirst);
    return rootFirst;
  };
  const threads = profile.threads.map((thread): CpuThread => {
    const samples: CpuSample[] = [];
    let timeMs = 0;
    for (let index = 0; index < thread.samples.timeDeltas.length; index += 1) {
      timeMs += thread.samples.timeDeltas[index] ?? 0;
      const stack = thread.samples.stack[index];
      const cpu = thread.samples.threadCPUDelta?.[index] ?? 1;
      if (stack === null || stack === undefined || cpu === null || cpu <= 0) continue;
      samples.push({ atNs: BigInt(zero) + BigInt(Math.round(timeMs * 1e6)), stack: chain(stack) });
    }
    return { pid: osId(thread.pid), tid: osId(thread.tid), name: thread.name, samples };
  });
  return { clock, frames, threads };
}
