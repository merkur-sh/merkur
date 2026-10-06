import type { TelemetryInputFrontierStatus } from '../../../apps/web/src/perf/telemetry-drain-status';
import type { TerminalPerfEvent } from '../../../apps/web/src/perf/terminal-latency';
import {
  PROXY_HARNESS_DROP_KINDS,
  type ProxySettleStatus,
  type ProxyTraceLedger,
} from '../../../scripts/edge-network-stats';

/**
 * One member's timed input and where it completed: the timed mark, the input
 * frontier and proxy status of the first settle poll that saw the input's ACK
 * and authoritative fence, and the ledger read after the whole settle.
 */
export interface GraphicsTimedClose {
  readonly timedMark: ProxySettleStatus | null;
  readonly closedInput: TelemetryInputFrontierStatus;
  readonly closedLedger: ProxySettleStatus | null;
  readonly ledger: ProxySettleStatus | null;
}

/** `U` unimpaired, `L` lossy, `R` reordered without loss: C1 reads `U`, C2 reads `L`. */
export type GraphicsTypingStratum = 'U' | 'L' | 'R';

/**
 * A graphics typing pair's stratum, defined by its control member alone, from
 * every relay's ledger between the control's timed mark and the close at its
 * input's completion: `L` when a relay dropped a downstream packet, `R` when
 * one held a packet back for reorder and none dropped, `U` when neither. A
 * hold delays its packet 15 ms under the typical profile, the fence's second
 * tail, so `R` joins neither criterion
 * (ledger/2026-09-19-graphics-typing-sample-size-rule.md). A drop or hold after
 * the close cannot reach the sample, so it does not count. The trace-wide
 * ledger keeps a relay that detached before the close; the live relays alone
 * would lose its drops and call a lossy control unmatched. Null without a proxy.
 */
export function graphicsTypingStratum(control: GraphicsTimedClose): GraphicsTypingStratum | null {
  if (control.closedLedger === null) return null;
  const { downDropped, downReordered } = control.closedLedger.sinceMark;
  if (downDropped > 0) return 'L';
  return downReordered > 0 ? 'R' : 'U';
}

const TRACE_LEDGER_FIELDS = [
  'upSeen',
  'downSeen',
  'downDropped',
  'downReordered',
] as const satisfies readonly (keyof ProxyTraceLedger)[];

/**
 * Why a member's close cannot stand for its sample. The close must be the
 * report's own completion of the same input: the tracker's input is the
 * report's, and its first covering ACK and fence give the report's latencies
 * exactly, subtracted the same way from the same event timestamps. The ledger
 * it closed must be the timed mark's, and it can count no more than the ledger
 * read after the settle.
 */
export function graphicsTimedCloseErrors(
  label: string,
  close: GraphicsTimedClose,
  input: { readonly inputSeq: number; readonly atMs: number },
  sample: {
    readonly inputAckMs: number | null;
    readonly inputToCompletedAuthoritativePresentationFenceMs: number | null;
  },
): string[] {
  const errors: string[] = [];
  const closed = close.closedInput;
  if (closed.queuedSeq !== input.inputSeq) {
    errors.push(
      `${label}: the close completed input ${closed.queuedSeq}, the report's sample is input ${input.inputSeq}`,
    );
  }
  const ackMs = closed.ackAtMs - input.atMs;
  if (ackMs !== sample.inputAckMs) {
    errors.push(
      `${label}: the close saw the ACK ${ackMs} ms after the input, the report ${sample.inputAckMs} ms`,
    );
  }
  const fenceMs = closed.fenceAtMs - input.atMs;
  if (fenceMs !== sample.inputToCompletedAuthoritativePresentationFenceMs) {
    errors.push(
      `${label}: the close saw the fence ${fenceMs} ms after the input, the report's completed fence ${sample.inputToCompletedAuthoritativePresentationFenceMs} ms`,
    );
  }
  const { timedMark, closedLedger, ledger } = close;
  if (timedMark === null || closedLedger === null || ledger === null) {
    if (timedMark !== null || closedLedger !== null || ledger !== null) {
      errors.push(
        `${label}: the proxy answered only some of the timed mark, the close and the settled ledger`,
      );
    }
    return errors;
  }
  for (const [name, status] of [
    ['close', closedLedger],
    ['settled ledger', ledger],
  ] as const) {
    if (
      status.epoch !== timedMark.epoch ||
      status.mark.generation !== timedMark.mark.generation ||
      status.mark.key !== timedMark.mark.key
    ) {
      errors.push(
        `${label}: the ${name} is under mark ${JSON.stringify(status.mark)} of epoch ${status.epoch}, not the timed mark ${JSON.stringify(timedMark.mark)} of epoch ${timedMark.epoch}`,
      );
    }
  }
  for (const field of TRACE_LEDGER_FIELDS) {
    if (closedLedger.sinceMark[field] > ledger.sinceMark[field]) {
      errors.push(
        `${label}: the close counted ${field} ${closedLedger.sinceMark[field]}, more than the settled ${ledger.sinceMark[field]}`,
      );
    }
  }
  return errors;
}

/** The proxy dropped nothing outside the configured impairment between a batch's start and end. */
export function proxyHarnessDropErrors(
  start: ProxySettleStatus | null,
  end: ProxySettleStatus | null,
): string[] {
  if (
    start === null ||
    (end !== null &&
      PROXY_HARNESS_DROP_KINDS.every((kind) => start.harnessDrops[kind] === end.harnessDrops[kind]))
  ) {
    return [];
  }
  return [
    `proxy harness drops changed during the batch: ${JSON.stringify(start.harnessDrops)} -> ${JSON.stringify(end?.harnessDrops)}`,
  ];
}

/**
 * An image member whose timed input did not ride its transfer: it left once
 * the last tile had finished, or with less transfer to come than the twin
 * control's echo takes.
 */
export interface GraphicsMissedOverlap {
  readonly pair: number;
  /** From the image input's send to the last FIN; not positive once the transfer had ended. */
  readonly remainingTransferMs: number;
  /** The twin control's display receive after its input's send. */
  readonly controlEchoMs: number;
}

/** One ABBA or BAAB block of four pairs that a missed overlap took out of the sample. */
export interface GraphicsMissedQuad {
  readonly batch: number;
  readonly pairs: readonly number[];
  readonly missed: readonly GraphicsMissedOverlap[];
}

/**
 * The pairs a batch contributes, and the quads it does not. A member reaches
 * its timed key through the page's read of the arming transition, the proxy
 * mark and the key's dispatch; a clean 2 MiB transfer lasts about 20 ms, and a
 * stall of that length in any of the three sends the key after the transfer.
 * That member then measured a key with no transfer under it: its pair is not a
 * treatment sample, and counting it would flatter the verdict. Its whole quad
 * leaves the sample with it, so the arms stay balanced in order, and its pairs
 * count toward the run's cap like any other pair the run spent.
 */
export function withoutMissedQuads<Pair extends { readonly pair: number }>(
  batch: number,
  pairs: readonly Pair[],
  missed: readonly GraphicsMissedOverlap[],
) {
  const quadOf = (pair: number) => Math.floor(pair / 4);
  const quads = [...new Set(missed.map((miss) => quadOf(miss.pair)))].sort((a, b) => a - b);
  const missedQuads: GraphicsMissedQuad[] = quads.map((quad) => ({
    batch,
    pairs: pairs.flatMap(({ pair }) => (quadOf(pair) === quad ? [pair] : [])),
    missed: missed.filter((miss) => quadOf(miss.pair) === quad),
  }));

  return { valid: pairs.filter(({ pair }) => !quads.includes(quadOf(pair))), missedQuads };
}

/** What voided a batch: a carrier change, or a data lane its tile jobs recovered from. */
export type GraphicsVoidReason = 'carrier' | 'data-lane';

/** A tile job the transport interrupted and the same job then resumed. */
export interface GraphicsDataLaneRecovery {
  readonly jobId: number;
  readonly interruptedAtMs: number;
  readonly resumedAtMs: number;
}

/**
 * The data-lane evidence in a batch's trace. When a data pairing retires, the
 * asset client re-asks every exchange it may have held: each tile job still
 * awaiting its reply is `interrupted` and its request cancelled, and the
 * UNAVAILABLE answering that cancel `resumed`s the job from its verified
 * prefix. Each `interrupted` pairs with its own job's next `resumed`. Every
 * other failure phase is `unexplained`: an interruption its job never resumed,
 * a resume nothing interrupted, and each refusal, UNAVAILABLE and cancellation.
 * A recorded UNAVAILABLE is always terminal, since the client cancels its job
 * with it.
 */
export function graphicsDataLaneRecoveries(events: readonly TerminalPerfEvent[]): {
  readonly recovered: readonly GraphicsDataLaneRecovery[];
  readonly unexplained: readonly string[];
} {
  const recovered: GraphicsDataLaneRecovery[] = [];
  const unexplained: string[] = [];
  const interrupted = new Map<number, number>();
  for (const event of events) {
    if (event.kind !== 'graphics_asset') continue;
    const { jobId, atMs, phase } = event;
    if (phase === 'interrupted') {
      const open = interrupted.get(jobId);
      if (open !== undefined) {
        unexplained.push(`tile job ${jobId} was interrupted at ${open} and never resumed`);
      }
      interrupted.set(jobId, atMs);
    } else if (phase === 'resumed') {
      const open = interrupted.get(jobId);
      if (open === undefined) {
        unexplained.push(`tile job ${jobId} resumed at ${atMs} without an interruption`);
      } else {
        recovered.push({ jobId, interruptedAtMs: open, resumedAtMs: atMs });
        interrupted.delete(jobId);
      }
    } else if (phase === 'refused' || phase === 'unavailable' || phase === 'cancelled') {
      unexplained.push(`tile job ${jobId} ${phase} at ${atMs}`);
    }
  }
  for (const [jobId, atMs] of interrupted) {
    unexplained.push(`tile job ${jobId} was interrupted at ${atMs} and never resumed`);
  }
  return { recovered, unexplained };
}

/**
 * What still fails the run in a voided batch. A carrier change excuses what it
 * does to the batch: its own signaling reconnect, the tile jobs it interrupts, a
 * member it stalls. A data-lane void excuses exactly its recovered
 * interruptions and a member they stalled; every unexplained failure phase
 * still fails the run. A lost session is neither event, and a harness drop
 * means the proxy was not the configured network.
 */
export function voidedBatchErrors(
  events: readonly TerminalPerfEvent[],
  reason: GraphicsVoidReason,
  proxyAtStart: ProxySettleStatus | null,
  proxyAtEnd: ProxySettleStatus | null,
): string[] {
  const errors: string[] = [];
  for (const event of events) {
    if (event.kind === 'transport_state' && event.state === 'disconnected') {
      errors.push(`the session was lost at ${event.atMs}: ${event.reason ?? 'no reason given'}`);
    }
  }
  if (reason === 'data-lane') errors.push(...graphicsDataLaneRecoveries(events).unexplained);
  errors.push(...proxyHarnessDropErrors(proxyAtStart, proxyAtEnd));
  return errors;
}
