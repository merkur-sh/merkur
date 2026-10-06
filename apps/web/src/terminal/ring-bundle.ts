import { createPerfRingBuffer } from '../perf/perf-ring';
import { createPerfStringTableBuffer } from '../perf/perf-string-table';
import { INPUT_RING_SIZE } from '../transport/input-ring';
import {
  createPredictionAdmissionBuffer,
  PREDICTION_ADMISSION_SIZE,
} from '../transport/prediction-admission';
import { createDisplayReceiverProfileBuffer } from './display-receiver-profile';
import { createPredictionFastPathBuffer, PREDICTION_FAST_PATH_SIZE } from './prediction-fast-path';
import { createPresentationCadenceBuffer } from './presentation-cadence';
import type { TerminalDisplayRingWakeMode } from './runtime-policy';
import { FRAME_RING_SIZE } from './shared-ring';
import { VIEWER_OUTPUT_RING_SIZE } from './viewer-output-ring';

export interface TerminalRingBundle {
  readonly frameRing: SharedArrayBuffer;
  /** What the viewer asks its session to send: terminal writes, transport reads. */
  readonly viewerOutputRing: SharedArrayBuffer;
  readonly inputRing: SharedArrayBuffer;
  readonly predictionAdmission: SharedArrayBuffer;
  readonly predictionFastPath: SharedArrayBuffer;
  /** Quantized browser presentation period, sampled by the transport host. */
  readonly presentationCadence: SharedArrayBuffer;
  /** Latest receiver-cost posterior: terminal writes, transport reads. */
  readonly displayReceiverProfile: SharedArrayBuffer;
  /**
   * Profiling rings, one per producer thread.
   *
   * Separate buffers rather than one shared ring: each stays single-producer,
   * so a write is a few stores plus one `Atomics.store` with no compare-and-swap
   * and no contention between the terminal, transport and main threads.
   */
  readonly terminalPerfRing: SharedArrayBuffer;
  readonly transportPerfRing: SharedArrayBuffer;
  readonly mainPerfRing: SharedArrayBuffer;
  /**
   * Interning table for the few strings records refer to.
   *
   * One table rather than one per ring, because ids must be unique across rings:
   * the drain interleaves all three into a single event stream.
   *
   * Safe as a single-writer structure because **only the main thread interns**.
   * The three string-bearing events — `session_start`, `startup_milestone` and a
   * `transport_state` reason — are all emitted there; the terminal and transport
   * workers emit numbers only. Adding a string-bearing event to either worker
   * would turn this into a multi-writer table and require a CAS on publish.
   */
  readonly perfStrings: SharedArrayBuffer;
  /**
   * The two ends of one `MessageChannel` between the terminal worker and the
   * transport worker, each transferred to its worker inside `init`. It carries
   * the task edge for the two rings the workers exchange — frame ring readable
   * (transport → terminal) and viewer-output ring readable (terminal →
   * transport) — on engines whose SAB readers must park on a task rather than
   * a futex. It also carries, in both wake modes, the rare numeric edges: a
   * display-cadence change, and room in a ring that had refused an entry.
   * Nothing on it crosses the main thread.
   *
   * Lifetimes line up by construction: one bundle per connection attempt, one
   * transport session and one terminal worker per bundle, one `init` per
   * worker. A port is transferred exactly once and closed at that worker's
   * shutdown.
   */
  readonly terminalRingWakePort: MessagePort;
  readonly transportRingWakePort: MessagePort;
  /**
   * How every SAB reader in this bundle parks, resolved once on main from the
   * user agent and carried to both workers in `init`. Resolving it in three
   * realms was the realm-disagreement hazard: a worker with no `navigator`
   * silently picks one arm while its producer picks the other.
   */
  readonly displayRingWakeMode: TerminalDisplayRingWakeMode;
}

export function createTerminalRingBundle(
  displayRingWakeMode: TerminalDisplayRingWakeMode,
): TerminalRingBundle {
  const ringWakeChannel = new MessageChannel();
  return {
    frameRing: new SharedArrayBuffer(FRAME_RING_SIZE),
    viewerOutputRing: new SharedArrayBuffer(VIEWER_OUTPUT_RING_SIZE),
    inputRing: new SharedArrayBuffer(INPUT_RING_SIZE),
    predictionAdmission: createPredictionAdmissionBuffer(),
    predictionFastPath: createPredictionFastPathBuffer(),
    presentationCadence: createPresentationCadenceBuffer(),
    displayReceiverProfile: createDisplayReceiverProfileBuffer(),
    terminalPerfRing: createPerfRingBuffer(),
    transportPerfRing: createPerfRingBuffer(),
    mainPerfRing: createPerfRingBuffer(),
    perfStrings: createPerfStringTableBuffer(),
    terminalRingWakePort: ringWakeChannel.port1,
    transportRingWakePort: ringWakeChannel.port2,
    displayRingWakeMode,
  };
}

export { PREDICTION_ADMISSION_SIZE, PREDICTION_FAST_PATH_SIZE };
