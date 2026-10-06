import {
  advanceInputSequence,
  inputSequenceAdvances,
  olderInputSequence,
} from '../transport/input-sequence-domain';
import type { GraphicsAssetPhase, TerminalPerfEvent } from './terminal-latency';

/**
 * Authoritative submissions outstanding at once are renderer-mailbox bounded.
 * Keep a larger fixed diagnostic ceiling so a malformed/truncated trace fails
 * closed without allowing profiling state to grow with session duration.
 */
export const MAX_PENDING_AUTHORITATIVE_RENDERS = 256;

export interface TelemetryDrainActivityStatus {
  /** Browser-owned profiling lineage; changes exactly when the recorder resets. */
  readonly observationEpoch: number;
  /** Events older than this boundary cannot affect the current observation. */
  readonly observationStartedAtMs: number;
  /** Wrapping change detector. Event count below disambiguates a wrap. */
  readonly activityRevision: number;
  /** Relevant presentation events observed since the current boundary. */
  readonly activityEventCount: number;
  readonly latestActivityAtMs: number;
  /** Visual commits still waiting for their observed GPU-completion proxy. */
  readonly pendingAuthoritativeRenderCount: number;
  /** True means the fixed pending-render identity set could not remain exact. */
  readonly trackingOverflow: boolean;
  readonly graphicsAsset: TelemetryGraphicsAssetStatus;
  readonly input: TelemetryInputFrontierStatus;
}

/**
 * How far the pipeline has carried the awaited input since the current
 * boundary. A harness closes a window with exactly one timed input on this:
 * the input is complete once its cumulative ACK and a fenced authoritative
 * presentation both cover it. The times are the event timestamps that first
 * reached each high-water, the same values the latency report reads.
 */
export interface TelemetryInputFrontierStatus {
  /** `input_queued` events: exactly one per awaited input. */
  readonly queuedCount: number;
  /** Newest awaited input sequence; zero before the first. */
  readonly queuedSeq: number;
  /** Highest cumulative input ACK. */
  readonly ackedSeq: number;
  /** The first ACK that reached `ackedSeq`; zero before any. */
  readonly ackAtMs: number;
  /**
   * The newest input a fenced authoritative commit answers. A commit answers
   * the inputs its `displayInputSeq` covers, and, once the applied display has
   * confirmed them, the inputs up to its `displayEchoHorizonSeq`: an echo can
   * be read before its own write is confirmed, and its frame then carries the
   * older barrier while a header-only frame raises it afterwards.
   */
  readonly fencedSeq: number;
  /** The fence, or the confirming application, that first reached `fencedSeq`; zero before any. */
  readonly fenceAtMs: number;
}

/** Graphics tile job transitions since the current boundary, one counter per phase. */
export interface TelemetryGraphicsAssetStatus {
  readonly eventCount: number;
  /** Jobs demanded and not yet retired: zero once every tile job has ended. */
  readonly open: number;
  readonly demanded: number;
  readonly requested: number;
  readonly firstByte: number;
  readonly fin: number;
  readonly published: number;
  readonly consumed: number;
  readonly retired: number;
  /** Failure-phase transitions: refused, unavailable, cancelled, interrupted, resumed. */
  readonly failed: number;
}

export interface TelemetryDrainActivityTracker {
  reset(observationEpoch: number, observationStartedAtMs: number): void;
  observe(event: TerminalPerfEvent): void;
  snapshot(): TelemetryDrainActivityStatus;
}

/**
 * Incremental O(1) presentation-drain signature.
 *
 * It deliberately ignores continuously emitted cadence/long-task diagnostics.
 * Receipt, queue, apply, transaction, and the matching authoritative GPU fence
 * are enough to prove the browser pipeline stopped changing. Graphics tile job
 * transitions are counted per phase beside them, so a quiet oracle can also
 * require that every demanded tile job retired, and the input frontier beside
 * those, so a harness can see one timed input complete. No retained event
 * array is read or copied when `snapshot()` is called.
 */
export function createTelemetryDrainActivityTracker(
  initialObservationEpoch: number,
  initialObservationStartedAtMs: number,
): TelemetryDrainActivityTracker {
  let observationEpoch = 0;
  let observationStartedAtMs = 0;
  let activityRevision = 0;
  let activityEventCount = 0;
  let latestActivityAtMs = 0;
  let trackingOverflow = false;
  /** Render sequence to the `displayInputSeq` its authoritative commit carries. */
  const pendingAuthoritativeRenders = new Map<number, number>();
  /** The same renders' `displayEchoHorizonSeq`, kept and dropped with the entry above. */
  const pendingEchoHorizons = new Map<number, number>();
  /** The newest input any fenced authoritative commit of this lineage could answer. */
  let fencedEchoHorizonSeq = 0;
  /** The newest input barrier an applied frame, visual or not, has carried. */
  let appliedInputSeq = 0;
  const input = {
    queuedCount: 0,
    queuedSeq: 0,
    ackedSeq: 0,
    ackAtMs: 0,
    fencedSeq: 0,
    fenceAtMs: 0,
  };
  const graphicsAsset = {
    eventCount: 0,
    demanded: 0,
    requested: 0,
    firstByte: 0,
    fin: 0,
    published: 0,
    consumed: 0,
    retired: 0,
    failed: 0,
  };

  function reset(nextObservationEpoch: number, nextObservationStartedAtMs: number): void {
    if (
      !Number.isInteger(nextObservationEpoch) ||
      nextObservationEpoch <= 0 ||
      nextObservationEpoch > 0xffff_ffff ||
      !Number.isFinite(nextObservationStartedAtMs) ||
      nextObservationStartedAtMs < 0
    ) {
      throw new RangeError('telemetry drain observation boundary is invalid');
    }
    observationEpoch = nextObservationEpoch;
    observationStartedAtMs = nextObservationStartedAtMs;
    activityRevision = 0;
    activityEventCount = 0;
    latestActivityAtMs = nextObservationStartedAtMs;
    trackingOverflow = false;
    pendingAuthoritativeRenders.clear();
    pendingEchoHorizons.clear();
    fencedEchoHorizonSeq = 0;
    appliedInputSeq = 0;
    input.queuedCount = 0;
    input.queuedSeq = 0;
    input.ackedSeq = 0;
    input.ackAtMs = 0;
    input.fencedSeq = 0;
    input.fenceAtMs = 0;
    graphicsAsset.eventCount = 0;
    graphicsAsset.demanded = 0;
    graphicsAsset.requested = 0;
    graphicsAsset.firstByte = 0;
    graphicsAsset.fin = 0;
    graphicsAsset.published = 0;
    graphicsAsset.consumed = 0;
    graphicsAsset.retired = 0;
    graphicsAsset.failed = 0;
  }

  function noteActivity(atMs: number): void {
    activityRevision = (activityRevision + 1) >>> 0;
    activityEventCount = Math.min(Number.MAX_SAFE_INTEGER, activityEventCount + 1);
    latestActivityAtMs = Math.max(latestActivityAtMs, atMs);
  }

  /**
   * Fenced pixels answer an input once they could hold its answer and the
   * applied display has confirmed its write, whichever of the two comes last.
   */
  function noteAnswered(atMs: number): void {
    const answered = olderInputSequence(fencedEchoHorizonSeq, appliedInputSeq);
    if (inputSequenceAdvances(input.fencedSeq, answered)) {
      input.fencedSeq = answered;
      input.fenceAtMs = atMs;
    }
  }

  function observe(event: TerminalPerfEvent): void {
    if (!Number.isFinite(event.atMs) || event.atMs < observationStartedAtMs) return;
    switch (event.kind) {
      case 'display_received':
      case 'worker_display_queued':
      case 'presentation_transaction_discarded':
        noteActivity(event.atMs);
        return;
      case 'worker_display_applied':
        noteActivity(event.atMs);
        appliedInputSeq = advanceInputSequence(appliedInputSeq, event.inputSeq);
        noteAnswered(event.atMs);
        return;
      // The input frontier records no activity: the quiet signature stays the
      // presentation pipeline's own.
      case 'input_queued':
        input.queuedCount = Math.min(Number.MAX_SAFE_INTEGER, input.queuedCount + 1);
        input.queuedSeq = advanceInputSequence(input.queuedSeq, event.inputSeq);
        return;
      case 'input_ack':
        if (inputSequenceAdvances(input.ackedSeq, event.inputSeq)) {
          input.ackedSeq = event.inputSeq >>> 0;
          input.ackAtMs = event.atMs;
        }
        return;
      case 'presentation_commit':
        noteActivity(event.atMs);
        // The renderer owns one completion primitive. A resize replacement can
        // submit synchronously and replace that primitive before its normal
        // mailbox completion, so the newer commit definitively retires every
        // older pending render identity. A late completion for an older render
        // must not discharge the new owner below.
        if (!pendingAuthoritativeRenders.has(event.renderSeq)) {
          pendingAuthoritativeRenders.clear();
          pendingEchoHorizons.clear();
        }
        if (!event.authoritativeVisualChange || pendingAuthoritativeRenders.has(event.renderSeq)) {
          return;
        }
        if (pendingAuthoritativeRenders.size >= MAX_PENDING_AUTHORITATIVE_RENDERS) {
          trackingOverflow = true;
          return;
        }
        pendingAuthoritativeRenders.set(event.renderSeq, event.displayInputSeq);
        pendingEchoHorizons.set(event.renderSeq, event.displayEchoHorizonSeq);
        return;
      case 'frame_complete': {
        // Only the fence of a commit still pending retires it. A replacement
        // commit cleared its predecessor above, so its own `displayInputSeq`,
        // cumulative like every commit's, carries the frontier instead.
        const displayInputSeq = pendingAuthoritativeRenders.get(event.renderSeq);
        if (displayInputSeq === undefined) return;
        const echoHorizonSeq = pendingEchoHorizons.get(event.renderSeq) ?? 0;
        pendingAuthoritativeRenders.delete(event.renderSeq);
        pendingEchoHorizons.delete(event.renderSeq);
        noteActivity(event.atMs);
        if (inputSequenceAdvances(input.fencedSeq, displayInputSeq)) {
          input.fencedSeq = displayInputSeq >>> 0;
          input.fenceAtMs = event.atMs;
        }
        fencedEchoHorizonSeq = advanceInputSequence(fencedEchoHorizonSeq, echoHorizonSeq);
        noteAnswered(event.atMs);
        return;
      }
      case 'presentation_epoch_boundary':
        // The worker emitted a discard before this boundary for any hidden
        // transaction. A late fence from the retired renderer must not keep the
        // replacement epoch pending forever, and pixels the boundary replaced
        // answer nothing confirmed after it.
        noteActivity(event.atMs);
        pendingAuthoritativeRenders.clear();
        pendingEchoHorizons.clear();
        fencedEchoHorizonSeq = 0;
        return;
      case 'graphics_asset':
        // Counted apart from presentation activity: a quiet oracle asks for
        // zero open jobs, and a harness waits on exact transitions.
        graphicsAsset.eventCount = Math.min(Number.MAX_SAFE_INTEGER, graphicsAsset.eventCount + 1);
        observeGraphicsAsset(event.phase);
        return;
      default:
        return;
    }
  }

  function observeGraphicsAsset(phase: GraphicsAssetPhase): void {
    switch (phase) {
      case 'demanded':
        graphicsAsset.demanded += 1;
        return;
      case 'requested':
        graphicsAsset.requested += 1;
        return;
      case 'first_byte':
        graphicsAsset.firstByte += 1;
        return;
      case 'fin':
        graphicsAsset.fin += 1;
        return;
      case 'published':
        graphicsAsset.published += 1;
        return;
      case 'consumed':
        graphicsAsset.consumed += 1;
        return;
      case 'retired':
        graphicsAsset.retired += 1;
        return;
      case 'refused':
      case 'unavailable':
      case 'cancelled':
      case 'interrupted':
      case 'resumed':
        graphicsAsset.failed += 1;
        return;
    }
  }

  function snapshot(): TelemetryDrainActivityStatus {
    return {
      observationEpoch,
      observationStartedAtMs,
      activityRevision,
      activityEventCount,
      latestActivityAtMs,
      pendingAuthoritativeRenderCount: pendingAuthoritativeRenders.size,
      trackingOverflow,
      graphicsAsset: {
        eventCount: graphicsAsset.eventCount,
        open: graphicsAsset.demanded - graphicsAsset.retired,
        demanded: graphicsAsset.demanded,
        requested: graphicsAsset.requested,
        firstByte: graphicsAsset.firstByte,
        fin: graphicsAsset.fin,
        published: graphicsAsset.published,
        consumed: graphicsAsset.consumed,
        retired: graphicsAsset.retired,
        failed: graphicsAsset.failed,
      },
      input: {
        queuedCount: input.queuedCount,
        queuedSeq: input.queuedSeq,
        ackedSeq: input.ackedSeq,
        ackAtMs: input.ackAtMs,
        fencedSeq: input.fencedSeq,
        fenceAtMs: input.fenceAtMs,
      },
    };
  }

  reset(initialObservationEpoch, initialObservationStartedAtMs);
  return { reset, observe, snapshot };
}

/**
 * Append to a capacity-stable telemetry-egress backlog.
 *
 * Retained diagnostic storage is independent: refusing this copy never drops
 * the event from the one explicit final dump, and the caller reports the
 * refusal as scalar worker evidence.
 */
export function appendBoundedTelemetryPending<T>(
  pending: T[],
  value: T,
  capacity: number,
): boolean {
  if (!Number.isInteger(capacity) || capacity <= 0) {
    throw new RangeError('telemetry pending capacity must be a positive integer');
  }
  if (pending.length >= capacity) return false;
  pending.push(value);
  return true;
}

/**
 * Decoded events the telemetry worker retains for an explicit `dump`.
 *
 * Bounded because this is a diagnostic convenience, not a second store: the
 * shipped rows are the record of truth, and an unbounded buffer would
 * reintroduce in-page memory growth on a long profiled session.
 *
 * The bound follows the acceptance workload, and that workload got denser. With
 * the daemon's 10 ms coalescing tail gone, a burst spec emits far more display
 * rows in the same wall time; 32,000 truncated the wide-cell burst and the TUI
 * redraw by roughly 2,000 events each, and a truncated trace is not a weaker
 * oracle, it is no oracle. This is cold memory held only while profiling, so the
 * step is cheap. The egress backlog the worker keeps against a dead endpoint is
 * a live cost and deliberately does not move with it.
 */
export const TELEMETRY_RETAINED_EVENT_CAPACITY = 65_536;

/** Fixed-capacity O(1)-append storage. Only an explicit dump materializes it. */
export interface TelemetryRetainedEventRing<T> {
  /** Returns true when the append evicted the oldest retained value. */
  push(value: T): boolean;
  /** Cold observation-boundary operation; releases every retained reference. */
  clear(): void;
  /** Cold observation-boundary compaction, preserving source order exactly. */
  retain(predicate: (value: T) => boolean): void;
  forEach(visitor: (value: T) => void): void;
  snapshot(): T[];
  readonly size: number;
}

export function createTelemetryRetainedEventRing<T>(
  capacity: number,
): TelemetryRetainedEventRing<T> {
  if (!Number.isInteger(capacity) || capacity <= 0) {
    throw new RangeError('telemetry retained-event capacity must be a positive integer');
  }
  const storage = new Array<T | undefined>(capacity);
  let start = 0;
  let count = 0;

  function clear(): void {
    for (let index = 0; index < count; index += 1) {
      storage[(start + index) % capacity] = undefined;
    }
    start = 0;
    count = 0;
  }

  return {
    push(value): boolean {
      if (count < capacity) {
        storage[(start + count) % capacity] = value;
        count += 1;
        return false;
      }
      storage[start] = value;
      start = (start + 1) % capacity;
      return true;
    },
    clear,
    retain(predicate): void {
      // This is deliberately allowed to allocate only at the explicit recorder
      // boundary. The append/drain hot path above remains fixed-capacity O(1).
      const kept: T[] = [];
      for (let index = 0; index < count; index += 1) {
        const value = storage[(start + index) % capacity];
        if (value !== undefined && predicate(value)) kept.push(value);
      }
      clear();
      for (const value of kept) {
        storage[count] = value;
        count += 1;
      }
    },
    forEach(visitor): void {
      for (let index = 0; index < count; index += 1) {
        const value = storage[(start + index) % capacity];
        if (value !== undefined) visitor(value);
      }
    },
    snapshot(): T[] {
      const values = new Array<T>(count);
      for (let index = 0; index < count; index += 1) {
        const value = storage[(start + index) % capacity];
        if (value !== undefined) values[index] = value;
      }
      return values;
    },
    get size(): number {
      return count;
    },
  };
}
