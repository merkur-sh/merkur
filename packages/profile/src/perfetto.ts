/**
 * One Perfetto trace (`protos/perfetto/trace/trace.proto`, v58) from a native trace capture
 * and, when one was recorded, the samply CPU profile of the same window. Both are stamped on
 * the anchor clock, so every packet carries that clock's nanoseconds and needs no snapshot.
 *
 * - Each thread is a track under one process track.
 * - A span is a slice on its thread's track; a mark is an instant. A carried value is the
 *   `value` debug annotation.
 * - A CPU sample is a `PerfSample` naming an interned callstack, so `trace_processor` puts it
 *   in `perf_sample`, where SQL joins it to the slices it fell inside.
 */
import type { NativeTraceCapture, NativeTraceSpan } from './mtrace';
import { ProtoWriter } from './protobuf';
import type { CpuProfile } from './samply';

/** `TracePacket` and nested field numbers, as `trace_packet.proto` and friends define them. */
const PACKET = 1;
const TIMESTAMP = 8;
const TRACK_EVENT = 11;
const INTERNED_DATA = 12;
const SEQUENCE_FLAGS = 13;
const TRUSTED_SEQUENCE = 10;
const TRACK_DESCRIPTOR = 60;
const PERF_SAMPLE = 66;
const SEQ_INCREMENTAL_STATE_CLEARED = 1;
const SEQ_NEEDS_INCREMENTAL_STATE = 2;
const TYPE_SLICE_BEGIN = 1;
const TYPE_SLICE_END = 2;
const TYPE_INSTANT = 3;

/** `TrackEvent.Type` of each span phase. */
const EVENT_TYPE = {
  begin: TYPE_SLICE_BEGIN,
  end: TYPE_SLICE_END,
  mark: TYPE_INSTANT,
} as const satisfies Record<NativeTraceSpan['phase'], number>;

const SEQUENCE = 1;
const PROCESS_TRACK = 1n;

export class TraceMergeError extends Error {
  override readonly name = 'TraceMergeError';
}

function threadTrack(tid: number): bigint {
  return 0x1_0000_0000n + BigInt(tid);
}

/** The trace's bytes. A CPU profile on another clock, or of another process, is refused. */
export function writePerfettoTrace(
  capture: NativeTraceCapture,
  cpu: CpuProfile | null,
): Uint8Array {
  if (cpu !== null && cpu.clock !== capture.clock) {
    throw new TraceMergeError(`CPU profile is on ${cpu.clock}, the capture on ${capture.clock}`);
  }
  const cpuThreads = cpu?.threads.filter((thread) => thread.pid === capture.pid) ?? [];
  if (cpu !== null && cpuThreads.length === 0) {
    throw new TraceMergeError(`CPU profile has no thread of process ${capture.pid}`);
  }
  const trace = new ProtoWriter();
  trace.message(PACKET, (packet) =>
    packet
      .uint(TRUSTED_SEQUENCE, SEQUENCE)
      .uint(SEQUENCE_FLAGS, SEQ_INCREMENTAL_STATE_CLEARED)
      .message(TRACK_DESCRIPTOR, (track) =>
        track
          .uint(1, PROCESS_TRACK)
          .message(3, (process) => process.uint(1, capture.pid).string(6, 'merkur-dataplane')),
      ),
  );
  const names = new Map(cpuThreads.map((thread) => [thread.tid, thread.name]));
  const tids = new Set([...capture.spans.map((span) => span.thread), ...names.keys()]);
  for (const tid of [...tids].sort((a, b) => a - b)) {
    trace.message(PACKET, (packet) =>
      packet.uint(TRUSTED_SEQUENCE, SEQUENCE).message(TRACK_DESCRIPTOR, (track) =>
        track
          .uint(1, threadTrack(tid))
          .uint(5, PROCESS_TRACK)
          .message(4, (thread) =>
            thread
              .uint(1, capture.pid)
              .uint(2, tid)
              .string(5, names.get(tid) ?? `thread ${tid}`),
          ),
      ),
    );
  }
  for (const span of capture.spans) {
    const type = EVENT_TYPE[span.phase];
    trace.message(PACKET, (packet) =>
      packet
        .uint(TIMESTAMP, capture.originAnchorNs + BigInt(span.atNs))
        .uint(TRUSTED_SEQUENCE, SEQUENCE)
        .message(TRACK_EVENT, (event) => {
          event.uint(9, type).uint(11, threadTrack(span.thread));
          if (type !== TYPE_SLICE_END) event.string(23, span.name);
          if (type !== TYPE_SLICE_END && span.arg !== 0) {
            event.message(4, (annotation) => annotation.string(10, 'value').uint(3, span.arg));
          }
        }),
    );
  }
  if (cpu !== null) writeSamples(trace, capture.pid, cpu, cpuThreads);
  return trace.finish();
}

function writeSamples(
  trace: ProtoWriter,
  pid: number,
  cpu: CpuProfile,
  threads: CpuProfile['threads'],
): void {
  // Interned ids start at 1; 0 means absent.
  const libraries = new Map<string, number>();
  for (const frame of cpu.frames) {
    if (!libraries.has(frame.library)) libraries.set(frame.library, libraries.size + 1);
  }
  const callstacks = new Map<string, number>();
  for (const thread of threads) {
    for (const sample of thread.samples) {
      const key = sample.stack.join(',');
      if (!callstacks.has(key)) callstacks.set(key, callstacks.size + 1);
    }
  }
  trace.message(PACKET, (packet) =>
    packet
      .uint(TRUSTED_SEQUENCE, SEQUENCE)
      .uint(SEQUENCE_FLAGS, SEQ_NEEDS_INCREMENTAL_STATE)
      .message(INTERNED_DATA, (interned) => {
        for (const [library, id] of libraries) {
          interned.message(17, (path) => path.uint(1, id).string(2, library));
          interned.message(19, (mapping) =>
            mapping
              .uint(1, id)
              .uint(4, 0)
              .uint(5, 1n << 48n)
              .uint(7, id),
          );
        }
        cpu.frames.forEach((frame, index) => {
          interned.message(5, (name) => name.uint(1, index + 1).string(2, frame.name));
          interned.message(6, (record) =>
            record
              .uint(1, index + 1)
              .uint(2, index + 1)
              .uint(3, libraries.get(frame.library) ?? 0)
              .uint(4, frame.address),
          );
        });
        for (const [key, id] of callstacks) {
          interned.message(7, (callstack) => {
            callstack.uint(1, id);
            for (const frame of key.split(',')) callstack.uint(2, Number(frame) + 1);
          });
        }
      }),
  );
  for (const thread of threads) {
    for (const sample of thread.samples) {
      trace.message(PACKET, (packet) =>
        packet
          .uint(TIMESTAMP, sample.atNs)
          .uint(TRUSTED_SEQUENCE, SEQUENCE)
          .uint(SEQUENCE_FLAGS, SEQ_NEEDS_INCREMENTAL_STATE)
          .message(PERF_SAMPLE, (perf) =>
            perf
              .uint(1, 0)
              .uint(2, pid)
              .uint(3, thread.tid)
              .uint(4, callstacks.get(sample.stack.join(',')) ?? 0),
          ),
      );
    }
  }
}
