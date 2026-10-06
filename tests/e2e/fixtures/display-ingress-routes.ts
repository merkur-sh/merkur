import type { BrowserDisplayIngressRoute } from '../../../apps/web/src/perf/browser-display-io';
import type { TerminalPerfEvent } from '../../../apps/web/src/perf/terminal-latency';

type DisplayReceipt = Extract<TerminalPerfEvent, { kind: 'display_received' }>;
type DisplayIo = Extract<TerminalPerfEvent, { kind: 'browser_display_io' }>;

/**
 * Offline evidence only. Join callback-owned routes by the complete frame identity,
 * never the current carrier, timestamp proximity or whichever replica arrived first.
 * Multiple admitted routes remain ambiguous: this event does not identify the SAB
 * record consumed by a particular terminal receipt. FEC likewise has no single
 * original ingress route. Neither ambiguity is packet loss or missing telemetry.
 */
export function summarizeDisplayIngressRoutes(events: readonly TerminalPerfEvent[]) {
  const attempts = new Map<string, { traceOrdinal: number; event: DisplayIo }[]>();
  const receipts: { traceOrdinal: number; event: DisplayReceipt }[] = [];
  const fecIngress: { traceOrdinal: number; event: DisplayIo }[] = [];
  for (let traceOrdinal = 0; traceOrdinal < events.length; traceOrdinal += 1) {
    const event = events[traceOrdinal];
    if (event?.kind === 'display_received') receipts.push({ traceOrdinal, event });
    if (event?.kind !== 'browser_display_io') continue;
    if (event.stage !== 'transport_ingress' && event.stage !== 'transport_fec_ingress') continue;
    if (!isRoute(event.ingressRoute)) throw new Error('ingress attempt lacks an exact route');
    if (event.stage === 'transport_fec_ingress') {
      fecIngress.push({ traceOrdinal, event });
      continue;
    }
    const key = frameKey(event);
    const group = attempts.get(key);
    if (group === undefined) attempts.set(key, [{ traceOrdinal, event }]);
    else group.push({ traceOrdinal, event });
  }
  const errors: string[] = [];
  const owned = new Set<string>();
  const units = receipts.map(({ traceOrdinal, event }) => {
    const key = frameKey(event);
    const ingress = attempts.get(key) ?? [];
    if (owned.has(key)) errors.push(`display ${key} has duplicate terminal receipt evidence`);
    owned.add(key);
    for (const attempt of ingress) {
      if (attempt.event.payloadByteLength !== event.byteLength) {
        errors.push(`display ${key} has conflicting ingress/receipt payload sizes`);
      }
    }
    const admittedRoutes = [
      ...new Set(
        ingress
          .filter((attempt) => attempt.event.admitted)
          .map((attempt) => attempt.event.ingressRoute),
      ),
    ].sort();
    if (!event.fecRecovered && admittedRoutes.length === 0) {
      errors.push(`display ${key} has no admitted ingress evidence`);
    }
    return {
      generation: event.generation,
      displaySeq: event.displaySeq,
      frameId: event.frameId,
      chunkIndex: event.chunkIndex,
      chunkCount: event.chunkCount,
      inputSeq: event.inputSeq,
      presentationId: event.presentationId,
      memberIndex: event.presentationMemberIndex,
      memberCount: event.presentationMemberCount,
      rowCount: event.rowCount,
      byteLength: event.byteLength,
      receiveTraceOrdinal: traceOrdinal,
      receivedAtMs: event.atMs,
      attribution: event.fecRecovered
        ? 'fec-reconstructed'
        : admittedRoutes.length === 0
          ? 'missing-ingress'
          : admittedRoutes.length === 1
            ? 'sole-admitted-route'
            : 'ambiguous-multiple-routes',
      soleAdmittedRoute:
        !event.fecRecovered && admittedRoutes.length === 1 ? admittedRoutes[0] : null,
      admittedRoutes,
      attempts: ingress,
    };
  });
  return {
    schemaVersion: 1,
    complete: errors.length === 0,
    errors,
    interpretation:
      'exact callback carrier/lane census, not winner attribution for mixed replicas; timestamps do not measure network transit',
    units,
    // Preserve late replicas and refused/unconsumed arrivals instead of silently
    // shrinking the transport population to what became terminal receipts.
    unmatchedIngressAttempts: [...attempts].flatMap(([key, values]) =>
      owned.has(key) ? [] : values,
    ),
    fecIngress,
  };
}

function frameKey(event: DisplayReceipt | DisplayIo): string {
  return `${event.generation}:${event.displaySeq}:${event.frameId}:${event.chunkIndex}:${event.chunkCount}`;
}

function isRoute(value: unknown): value is BrowserDisplayIngressRoute {
  return (
    value === 'direct-datagram' ||
    value === 'direct-reliable' ||
    value === 'relay-datagram' ||
    value === 'relay-reliable'
  );
}
