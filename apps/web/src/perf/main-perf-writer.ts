import type { PerfRingWriter } from './perf-ring';
import { createPerfRingWriter } from './perf-ring';
import type { PerfStringInterner } from './perf-string-table';
import { createPerfStringInterner } from './perf-string-table';

/**
 * The main thread's single profiling producer.
 *
 * Five modules emit profiling records from the main thread — the terminal and
 * transport worker clients, the app controller, the input controller and the
 * speculative glyph overlay. They share one ring rather than owning one each:
 * a ring is single-*producer*, not single-call-site, and every one of these runs
 * on the same thread, so there is no concurrency to guard against and no reason
 * to pay for five buffers.
 *
 * A module-level singleton rather than a value threaded through five call
 * chains. The alternative means adding a ring parameter to the overlay and the
 * input controller, both of which sit on the per-keystroke path and neither of
 * which otherwise knows profiling exists.
 *
 * Null until `installMainPerfProducer` runs, which the app controller does when
 * it builds the ring bundle — before any terminal session can exist.
 */
let writer: PerfRingWriter | null = null;
let interner: PerfStringInterner | null = null;

export function installMainPerfProducer(ring: SharedArrayBuffer, strings: SharedArrayBuffer): void {
  writer = createPerfRingWriter(ring);
  interner = createPerfStringInterner(strings);
}

/**
 * Released on teardown so a stale ring from a previous session cannot absorb
 * records that belong to no session.
 */
export function clearMainPerfProducer(): void {
  writer = null;
  interner = null;
}

export function mainPerfWriter(): PerfRingWriter | null {
  return writer;
}

export function mainPerfInterner(): PerfStringInterner | null {
  return interner;
}
