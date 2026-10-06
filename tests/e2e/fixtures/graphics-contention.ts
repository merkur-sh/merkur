import {
  type EgressCounterSnapshot,
  egressCounterSteps,
  type TerminalEgressHop,
  type TerminalEgressRefusals,
  type TerminalPerfEvent,
} from '../../../apps/web/src/perf/terminal-latency';
import { pairedTail } from '../../../scripts/perf/paired-tail';

type DaemonTiming = Extract<TerminalPerfEvent, { kind: 'daemon_timing' }>;
type TransportEgress = Extract<TerminalPerfEvent, { kind: 'transport_egress' }>;
type EdgeForwardResidence = Extract<TerminalPerfEvent, { kind: 'edge_forward_residence' }>;

/**
 * The daemon's share of one timed keystroke, from its own record: datagram
 * receipt to the ACK datagram's packetization is `ackUs`, the three
 * acknowledgment terms in sequence; the echo terms ride along for the fence.
 */
export interface GraphicsDaemonTerms {
  readonly recvToPtyUs: number;
  readonly writeCompletionUs: number | null;
  readonly ackTransmitUs: number | null;
  /** Null unless every acknowledgment boundary was observed. */
  readonly ackUs: number | null;
  readonly ptyToReadUs: number;
  readonly gridApplyUs: number;
  readonly displayCoalesceUs: number;
  readonly selectCaptureUs: number;
  readonly encodeUs: number;
  readonly transportSubmitUs: number;
  /** The ten echo terms' sum: the daemon's whole share of the fence. */
  readonly echoUs: number;
  /**
   * The daemon's owner thread over the echo's span (PTY FIFO enqueue to
   * carrier submission): CPU inside its busy periods, busy time off the CPU,
   * contended QUIC connection-state waits, registry lock waits, and both
   * waits inside the flush alone.
   */
  readonly ownerCpuUs: number;
  readonly ownerOffCpuUs: number;
  readonly ownerQuinnWaitUs: number;
  readonly ownerRegistryWaitUs: number;
  readonly flushLockWaitUs: number;
}

export function graphicsDaemonTerms(
  events: readonly TerminalPerfEvent[],
  inputSeq: number,
): GraphicsDaemonTerms | null {
  const record = events.find(
    (event): event is DaemonTiming => event.kind === 'daemon_timing' && event.inputSeq === inputSeq,
  );
  if (record === undefined || inputSeq === 0) return null;
  return {
    recvToPtyUs: record.recvToPtyUs,
    writeCompletionUs: record.writeCompletionUs,
    ackTransmitUs: record.ackTransmitUs,
    ackUs:
      record.writeCompletionUs === null || record.ackTransmitUs === null
        ? null
        : record.recvToPtyUs + record.writeCompletionUs + record.ackTransmitUs,
    ptyToReadUs: record.ptyToReadUs,
    gridApplyUs: record.gridApplyUs,
    displayCoalesceUs: record.displayCoalesceUs,
    selectCaptureUs: record.selectCaptureUs,
    encodeUs: record.encodeUs,
    transportSubmitUs: record.transportSubmitUs,
    echoUs:
      record.recvToPtyUs +
      record.ptyToReadUs +
      record.gridApplyUs +
      record.displayCoalesceUs +
      record.selectCaptureUs +
      record.prepareQueueUs +
      record.encodeUs +
      record.compressionUs +
      record.completionQueueUs +
      record.transportSubmitUs,
    ownerCpuUs: record.ownerCpuUs,
    ownerOffCpuUs: record.ownerOffCpuUs,
    ownerQuinnWaitUs: record.ownerQuinnWaitUs,
    ownerRegistryWaitUs: record.ownerRegistryWaitUs,
    flushLockWaitUs: record.flushLockWaitUs,
  };
}

export interface GraphicsEgressHopDelta {
  readonly interactive: TerminalEgressRefusals;
  readonly bulk: TerminalEgressRefusals;
}

/**
 * Refusals and relay residence the daemon reported between two page instants:
 * the last snapshot at or before `fromMs` against the last one before `toMs`.
 * Within one counter series a wrap is an exact modular step. A series that
 * replaced another leaves the interval unknowable, and the hop reads null.
 */
export interface GraphicsEgressDelta {
  readonly daemon: GraphicsEgressHopDelta | null;
  readonly edge: GraphicsEgressHopDelta | null;
  readonly edgeForwardResidence: readonly number[] | null;
}

function lastBefore<T extends { readonly atMs: number }>(
  events: readonly T[],
  limitMs: number,
  inclusive: boolean,
): T | null {
  let found: T | null = null;
  for (const event of events) {
    if (inclusive ? event.atMs <= limitMs : event.atMs < limitMs) found = event;
  }
  return found;
}

function counterDelta(
  before: EgressCounterSnapshot,
  after: EgressCounterSnapshot,
): readonly number[] | null {
  const { steps, continuous } = egressCounterSteps(before, after);
  return continuous ? steps : null;
}

function refusals(event: TransportEgress): EgressCounterSnapshot {
  return {
    series: event.series,
    values: [
      event.interactive.blocked,
      event.interactive.paced,
      event.interactive.waitedUs,
      event.bulk.blocked,
      event.bulk.paced,
      event.bulk.waitedUs,
    ],
  };
}

function buckets(event: EdgeForwardResidence): EgressCounterSnapshot {
  return { series: event.series, values: event.buckets };
}

export function graphicsEgressBetween(
  events: readonly TerminalPerfEvent[],
  fromMs: number,
  toMs: number,
): GraphicsEgressDelta {
  const hop = (name: TerminalEgressHop): GraphicsEgressHopDelta | null => {
    const snapshots = events.filter(
      (event): event is TransportEgress => event.kind === 'transport_egress' && event.hop === name,
    );
    const before = lastBefore(snapshots, fromMs, true);
    const after = lastBefore(snapshots, toMs, false);
    if (before === null || after === null) return null;
    const delta = counterDelta(refusals(before), refusals(after));
    if (delta === null) return null;
    const [ib = 0, ip = 0, iw = 0, bb = 0, bp = 0, bw = 0] = delta;
    return {
      interactive: { blocked: ib, paced: ip, waitedUs: iw },
      bulk: { blocked: bb, paced: bp, waitedUs: bw },
    };
  };
  const residence = events.filter(
    (event): event is EdgeForwardResidence => event.kind === 'edge_forward_residence',
  );
  const before = lastBefore(residence, fromMs, true);
  const after = lastBefore(residence, toMs, false);
  return {
    daemon: hop('daemon'),
    edge: hop('edge'),
    edgeForwardResidence:
      before === null || after === null ? null : counterDelta(buckets(before), buckets(after)),
  };
}

/** One member as the attribution reads it. */
export interface GraphicsContentionMember {
  readonly inputAckMs: number;
  readonly fenceMs: number;
  readonly daemon: GraphicsDaemonTerms | null;
  readonly egress: GraphicsEgressDelta;
}

function sumHop(
  members: readonly GraphicsContentionMember[],
  pick: (egress: GraphicsEgressDelta) => GraphicsEgressHopDelta | null,
) {
  const total = {
    members: 0,
    interactive: { blocked: 0, paced: 0, waitedUs: 0 },
    bulk: { blocked: 0, paced: 0, waitedUs: 0 },
  };
  for (const member of members) {
    const hop = pick(member.egress);
    if (hop === null) continue;
    total.members += 1;
    for (const kind of ['interactive', 'bulk'] as const) {
      total[kind].blocked += hop[kind].blocked;
      total[kind].paced += hop[kind].paced;
      total[kind].waitedUs += hop[kind].waitedUs;
    }
  }
  return total;
}

function quantiles(values: readonly number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (rank: number) => sorted[Math.max(0, Math.ceil(sorted.length * rank) - 1)] ?? null;
  return { count: sorted.length, p50: at(0.5), p95: at(0.95), max: sorted.at(-1) ?? null };
}

function armSummary(members: readonly GraphicsContentionMember[]) {
  const observed = (pick: (terms: GraphicsDaemonTerms) => number | null) =>
    quantiles(
      members.flatMap((member) => {
        const value = member.daemon === null ? null : pick(member.daemon);
        return value === null ? [] : [value];
      }),
    );
  const residence = new Array<number>(12).fill(0);
  let residenceMembers = 0;
  for (const member of members) {
    const buckets = member.egress.edgeForwardResidence;
    if (buckets === null) continue;
    residenceMembers += 1;
    buckets.forEach((count, index) => {
      residence[index] = (residence[index] ?? 0) + count;
    });
  }
  return {
    members: members.length,
    daemonUs: {
      recvToPty: observed((terms) => terms.recvToPtyUs),
      writeCompletion: observed((terms) => terms.writeCompletionUs),
      ackTransmit: observed((terms) => terms.ackTransmitUs),
      ack: observed((terms) => terms.ackUs),
      ptyToRead: observed((terms) => terms.ptyToReadUs),
      selectCapture: observed((terms) => terms.selectCaptureUs),
      transportSubmit: observed((terms) => terms.transportSubmitUs),
      echo: observed((terms) => terms.echoUs),
      ownerCpu: observed((terms) => terms.ownerCpuUs),
      ownerOffCpu: observed((terms) => terms.ownerOffCpuUs),
      ownerQuinnWait: observed((terms) => terms.ownerQuinnWaitUs),
      ownerRegistryWait: observed((terms) => terms.ownerRegistryWaitUs),
      flushLockWait: observed((terms) => terms.flushLockWaitUs),
    },
    daemonEgress: sumHop(members, (egress) => egress.daemon),
    edgeEgress: sumHop(members, (egress) => egress.edge),
    edgeForwardResidence: { members: residenceMembers, buckets: residence },
  };
}

function pairedOrError(control: readonly number[], image: readonly number[]) {
  try {
    return pairedTail(control, image);
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Splits the paired ACK tail into the daemon's measured share and the rest of
 * the path (both network legs, the relay, the kernel and the browser), over
 * the pairs whose timed keystrokes carried every acknowledgment boundary. And
 * sets the daemon's added echo share beside what its owner thread did over
 * each echo: CPU, busy time off the CPU, and each lock's wait. A stall that is
 * the owner waiting on a lock shows the same added tail in that lock's wait;
 * one that is the owner descheduled shows it off the CPU with no lock's.
 * Diagnostics only: the acceptance statistics stay on the browser's metrics.
 */
export function graphicsContentionAttribution(
  pairs: readonly {
    readonly control: GraphicsContentionMember;
    readonly image: GraphicsContentionMember;
  }[],
) {
  const complete = pairs.filter(
    (pair) => pair.control.daemon?.ackUs != null && pair.image.daemon?.ackUs != null,
  );
  const daemonAckMs = (member: GraphicsContentionMember) => (member.daemon?.ackUs ?? 0) / 1_000;
  // Never clamped: a negative remainder would mean the two clocks disagree
  // about one interval, and the paired statistic refuses it rather than
  // reporting a zero-cost path.
  const pathAckMs = (member: GraphicsContentionMember) => member.inputAckMs - daemonAckMs(member);
  const echoed = pairs.flatMap((pair) =>
    pair.control.daemon === null || pair.image.daemon === null
      ? []
      : [{ control: pair.control.daemon, image: pair.image.daemon }],
  );
  const pairedMs = (pick: (terms: GraphicsDaemonTerms) => number) =>
    pairedOrError(
      echoed.map((pair) => pick(pair.control) / 1_000),
      echoed.map((pair) => pick(pair.image) / 1_000),
    );
  return {
    pairs: pairs.length,
    pairsWithDaemonAck: complete.length,
    daemonAckMs: pairedOrError(
      complete.map((pair) => daemonAckMs(pair.control)),
      complete.map((pair) => daemonAckMs(pair.image)),
    ),
    pathAckMs: pairedOrError(
      complete.map((pair) => pathAckMs(pair.control)),
      complete.map((pair) => pathAckMs(pair.image)),
    ),
    pairsWithDaemonEcho: echoed.length,
    daemonEchoMs: pairedMs((terms) => terms.echoUs),
    owner: {
      cpuMs: pairedMs((terms) => terms.ownerCpuUs),
      offCpuMs: pairedMs((terms) => terms.ownerOffCpuUs),
      quinnWaitMs: pairedMs((terms) => terms.ownerQuinnWaitUs),
      registryWaitMs: pairedMs((terms) => terms.ownerRegistryWaitUs),
      flushLockWaitMs: pairedMs((terms) => terms.flushLockWaitUs),
    },
    control: armSummary(pairs.map((pair) => pair.control)),
    image: armSummary(pairs.map((pair) => pair.image)),
  };
}
