export const PROXY_IMPAIRMENT_SCHEMA_VERSION = 9;
export const PROXY_DELAY_HISTOGRAM_BUCKET_US = 500 as const;
export const PROXY_DELAY_HISTOGRAM_BUCKETS = 512;
export const PROXY_CONTROL_CHUNK_PAYLOAD_BYTES = 4 * 1024;
export const PROXY_CONTROL_MAX_CHUNKS = 64;
export const PROXY_CONTROL_MAX_DATAGRAM_BYTES = 8 * 1024;
/**
 * The proxy's fixed relay table (`MAX_PROXY_CLIENTS` in `delay_proxy.rs`); every
 * status lists at most this many relays.
 */
export const PROXY_MAX_RELAYS = 64;
/** A trace key must stay exact as a JSON number; `reset` owns key 0. */
export const PROXY_MAX_TRACE_MARK_KEY = 2 ** 53;
/**
 * One relay's packet leases, across both directions. Every packet in a delay
 * line holds one, so no line can hold more; the lease is the proxy's only
 * capacity bound.
 */
export const PROXY_RELAY_PACKET_LEASES = 0xffff;
/**
 * Drops outside the configured impairment. Any of them means the proxy was
 * not the configured network: a datagram too large to relay, a new source the
 * one-packet admission handoff displaced or refused, a packet an exhausted
 * relay lease refused.
 * A declared link's capacity drops are the configured network, and are
 * counted apart as `bottleneckDrops`.
 */
export const PROXY_HARNESS_DROP_KINDS = ['oversized', 'admission', 'leaseExhausted'] as const;
export type ProxyHarnessDrops = Readonly<Record<(typeof PROXY_HARNESS_DROP_KINDS)[number], number>>;
const LOSS_WINDOW_PACKETS = 100;
/** Log2 histograms: bucket 0 holds zero, bucket `i` holds `[2^(i−1), 2^i)`. */
export const PROXY_LINK_LOG2_BUCKETS = 26;
export const PROXY_ROLES = ['daemon', 'browser'] as const;
export type ProxyRole = (typeof PROXY_ROLES)[number];
export const PROXY_LINK_DIRECTIONS = ['up', 'down'] as const;
export type ProxyLinkDirection = (typeof PROXY_LINK_DIRECTIONS)[number];

/** Whose relays a listener admits: a role, and whether they are a competing flow. */
export interface ProxyListener {
  readonly role: ProxyRole;
  readonly competitor: boolean;
}

export interface ProxyLinkConfig {
  readonly role: ProxyRole;
  readonly direction: ProxyLinkDirection;
  readonly rateBps: number;
  readonly bufferBytes: number;
  readonly fq: boolean;
  /** The rate `afterMarkMs` after each trace mark or reset. */
  readonly step: { readonly afterMarkMs: number; readonly rateBps: number } | null;
}

/** One link since the last reset. Residence is departure less arrival on its virtual clock. */
export interface ProxyLinkTotals {
  readonly arrivals: number;
  readonly departures: number;
  readonly bottleneckDrops: number;
  readonly lostAfterLink: number;
  readonly departedBytes: number;
  readonly busyNs: number;
  readonly rateChanges: number;
  readonly residenceLog2Us: readonly number[];
  readonly bytesAheadLog2: readonly number[];
  /** How late the link task released packets: the run's validity evidence. */
  readonly releaseOvershootLog2Us: readonly number[];
}

export interface ProxyLinkStatus {
  readonly config: ProxyLinkConfig;
  readonly rateBps: number;
  readonly totals: ProxyLinkTotals;
  readonly releaseOvershootP99UpperUs: number;
  /** One 1,500-byte packet at the link's lowest rate. */
  readonly lowestRatePacketUs: number;
}

/** One relay's use of one link since the trace mark. */
export interface ProxyRelayLinkStats {
  readonly packets: number;
  readonly bytes: number;
  readonly bottleneckDrops: number;
  readonly maxResidenceUs: number;
  readonly residenceLog2Us: readonly number[];
  readonly bytesAheadLog2: readonly number[];
}

export interface ProxyRelayLinkStatus {
  readonly direction: ProxyLinkDirection;
  readonly stats: ProxyRelayLinkStats;
  /** On a stepping link: the largest residence per 10 ms slot after the step, by entry. */
  readonly stepTraceMaxResidenceUs?: readonly number[];
}

export interface ProxyRelayLinks {
  readonly admissionSeq: number;
  readonly listener: ProxyListener;
  readonly upstreamPort: number;
  readonly links: readonly ProxyRelayLinkStatus[];
}

/** The trace every relay follows: `mark` and `reset` advance the generation. */
export interface ProxyTraceMark {
  readonly generation: number;
  readonly key: number;
}

/** Packets decided since the current trace mark: one relay's, or every relay's together. */
export interface ProxyTraceLedger {
  readonly upSeen: number;
  readonly downSeen: number;
  readonly downDropped: number;
  readonly downReordered: number;
}

/** One live relay (one UDP source) and its exact ledger since the current mark. */
export interface ProxyRelayStatus extends ProxyTraceLedger {
  readonly admissionSeq: number;
  /** The listener it arrived on: its role's links apply to it. */
  readonly listener: ProxyListener;
  /** The edge sees this connection at this port of the proxy's host. */
  readonly upstreamPort: number;
  /** Delayed packets this relay owns right now. */
  readonly pending: number;
  /** The most packets each delay line held at once since the mark, counting what it held then. */
  readonly upMaxInFlight: number;
  readonly downMaxInFlight: number;
  /** Dropped by its role's links since the mark: capacity, not impairment. */
  readonly bottleneckDrops: number;
}

export interface ProxyDelayDistribution {
  readonly count: number;
  readonly mean: number;
  readonly min: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly max: number;
  readonly histogramBucketUs: typeof PROXY_DELAY_HISTOGRAM_BUCKET_US;
  /** Exact per-reset counts; the last bucket includes every value >=255.5 ms. */
  readonly histogram: readonly number[];
}

export interface ProxyDirectionStats {
  readonly seen: number;
  readonly forwarded: number;
  readonly dropped: number;
  readonly exactLossDropped: number;
  readonly burstLossDropped: number;
  readonly burstLossRunsCompleted: number;
  readonly jittered: number;
  /** Packets actually released behind a later trace sequence. */
  readonly reorderInversions: number;
  /** Packets selected for deterministic downstream holdback. */
  readonly reordered: number;
  readonly congested: number;
  readonly congestedForwarded: number;
  readonly congestionClamped: number;
  readonly maxCongestionQueueDelayUs: number;
  readonly maxForwardedCongestionQueueDelayUs: number;
  /** UDP packet loss observed in this proxy direction. */
  readonly achievedPacketLossPercent: number;
  /** Controller-selected target per accepted ingress UDP packet. */
  readonly scheduledDelayUs: ProxyDelayDistribution;
  /** Enqueue-to-deadline target per released UDP unit, including split units. */
  readonly releaseTargetResidenceUs: ProxyDelayDistribution;
  /** Userspace enqueue-to-release residence; excludes socket/kernel/QUIC transit. */
  readonly actualResidenceUs: ProxyDelayDistribution;
  readonly releaseOvershootUs: ProxyDelayDistribution;
  readonly releaseEarlyCount: number;
  readonly maxReleaseEarlyUs: number;
}

export interface ProxyImpairmentStats {
  readonly schemaVersion: typeof PROXY_IMPAIRMENT_SCHEMA_VERSION;
  readonly epoch: number;
  readonly config: {
    readonly profile: string;
    readonly targetRttMs: number;
    readonly baseDelayUs: number;
    readonly jitterRadiusUs: number;
    readonly datagramLossPercent: number;
    readonly faultSite: 'edge-to-client';
    readonly faultSitesPerLogicalDirection: 1;
    readonly reorder: string;
    readonly scenario: string;
    readonly seed: number;
  };
  readonly upstream: ProxyDirectionStats;
  readonly downstream: ProxyDirectionStats;
  readonly logicalPathImpairment: {
    readonly faultSite: 'edge-to-client';
    readonly faultSitesPerLogicalDirection: 1;
    readonly requestedDatagramLossPercent: number;
    readonly observedFaultSitePackets: number;
    readonly droppedAtFaultSite: number;
    readonly achievedPacketLossPercent: number;
  };
  /** Process-wide, never reset. */
  readonly harnessDrops: ProxyHarnessDrops;
  readonly splitDatagrams: number;
  /** Delayed packets not yet released from any live proxy relay. */
  readonly pendingScheduledPackets: number;
  /** Downstream 100-packet loss windows any relay completed this epoch. */
  readonly exactLossWindowsCompleted: number;
  /** Exact-loss drops inside those windows. */
  readonly exactLossDroppedInCompletedWindows: number;
  /** Live relays in admission order. */
  readonly relays: readonly ProxyRelayStatus[];
  /** Every declared link since the reset. */
  readonly links: readonly ProxyLinkStatus[];
  /** Each live relay's use of its role's links since the mark, in admission order. */
  readonly relayLinks: readonly ProxyRelayLinks[];
}

export interface ProxySettleDirectionStatus {
  readonly seen: number;
  readonly forwarded: number;
  readonly dropped: number;
  /** Delayed UDP units whose userspace release deadline has been observed. */
  readonly released: number;
  readonly reorderInversions: number;
}

/**
 * Settle snapshot, also the reply to `mark`. It intentionally contains no delay
 * histograms; its relay list holds at most `PROXY_MAX_RELAYS` entries, so it
 * arrives in chunks like the full snapshot.
 */
export interface ProxySettleStatus {
  readonly schemaVersion: typeof PROXY_IMPAIRMENT_SCHEMA_VERSION;
  readonly epoch: number;
  readonly mark: ProxyTraceMark;
  /**
   * Every relay's ledger since `mark` together. A relay that detaches takes its
   * own ledger out of `relays`, never its packets out of this one.
   */
  readonly sinceMark: ProxyTraceLedger;
  readonly upstream: ProxySettleDirectionStatus;
  readonly downstream: ProxySettleDirectionStatus;
  /** Process-wide, never reset. */
  readonly harnessDrops: ProxyHarnessDrops;
  readonly splitDatagrams: number;
  readonly pendingScheduledPackets: number;
  /** Live relays in admission order; their ledgers count since `mark`. */
  readonly relays: readonly ProxyRelayStatus[];
}

export interface ProxyFaultEvidence {
  readonly exactLossObserved: boolean;
  /** At least one complete deterministic 100-packet selector window was verified. */
  readonly exactLossSelectorWindowVerified: boolean;
  readonly reorderObserved: boolean;
  readonly burstLossObserved: boolean;
  readonly congestionObserved: boolean;
}

export interface ProxyFaultValidationOptions {
  /** Artifact closure requires an empty scheduler; live priming does not. */
  readonly requireDrained: boolean;
  /** Live recovery priming requires every configured fault family to fire. */
  readonly requireConfiguredFaultsObserved: boolean;
}

export function proxyFaultEvidence(stats: ProxyImpairmentStats): ProxyFaultEvidence {
  return {
    exactLossObserved: stats.downstream.exactLossDropped > 0,
    exactLossSelectorWindowVerified:
      stats.exactLossWindowsCompleted > 0 && exactLossWindowsAreExact(stats),
    reorderObserved: stats.downstream.reorderInversions > 0,
    burstLossObserved: stats.downstream.burstLossRunsCompleted > 0,
    congestionObserved:
      stats.downstream.congestedForwarded >= 2 &&
      stats.downstream.maxForwardedCongestionQueueDelayUs >= 2_000,
  };
}

/**
 * Validate facts intrinsic to one reset epoch. This deliberately calls the
 * fault unit a downstream UDP packet: application display-datagram outcomes
 * are measured independently by browser sequence telemetry.
 */
export function configuredProxyFaultEvidenceErrors(
  stats: ProxyImpairmentStats,
  options: ProxyFaultValidationOptions,
): string[] {
  const errors: string[] = [];
  const evidence = proxyFaultEvidence(stats);
  if (stats.epoch <= 0) errors.push('proxy trace epoch was not reset');
  if (stats.downstream.seen === 0) errors.push('proxy observed no downstream UDP packets');
  if (stats.upstream.seen !== stats.upstream.forwarded + stats.upstream.dropped) {
    errors.push('upstream packet accounting is inconsistent');
  }
  if (stats.downstream.seen !== stats.downstream.forwarded + stats.downstream.dropped) {
    errors.push('downstream packet accounting is inconsistent');
  }
  if (!exactLossWindowsAreExact(stats)) {
    errors.push('downstream exact-loss count is impossible for its selector windows');
  }
  if (
    stats.upstream.scheduledDelayUs.count !== stats.upstream.forwarded ||
    stats.downstream.scheduledDelayUs.count !== stats.downstream.forwarded
  ) {
    errors.push('proxy delay sample count does not match forwarded packets');
  }
  const expectedReleasedUpstream = stats.upstream.forwarded;
  const expectedReleasedDownstream = stats.downstream.forwarded + stats.splitDatagrams;
  for (const [name, direction, expectedReleased] of [
    ['upstream', stats.upstream, expectedReleasedUpstream],
    ['downstream', stats.downstream, expectedReleasedDownstream],
  ] as const) {
    if (
      options.requireDrained &&
      (direction.releaseTargetResidenceUs.count !== expectedReleased ||
        direction.actualResidenceUs.count !== expectedReleased ||
        direction.releaseOvershootUs.count !== expectedReleased)
    ) {
      errors.push(`${name} actual release sample count does not match released UDP units`);
    }
    if (direction.releaseEarlyCount !== 0 || direction.maxReleaseEarlyUs !== 0) {
      errors.push(`${name} proxy released a UDP unit before its target deadline`);
    }
  }

  const baseDelayUs = stats.config.baseDelayUs;
  const jitterRadiusUs = stats.config.jitterRadiusUs;
  const reorderHoldUs = stats.config.reorder === 'none' ? 0 : jitterRadiusUs * 4;
  const congestionHoldUs = stats.config.scenario === 'congestion' ? 32_000 : 0;
  const splitHoldUs = stats.config.scenario === 'handshake-split' ? baseDelayUs : 0;
  const scheduledFloorUs = baseDelayUs - jitterRadiusUs;
  const scheduledCeilingUs =
    baseDelayUs + jitterRadiusUs + reorderHoldUs + congestionHoldUs + splitHoldUs;
  const enqueueAccountingAllowanceUs = 2_000;
  const releaseTargetFloorUs = Math.max(0, scheduledFloorUs - enqueueAccountingAllowanceUs);
  const schedulerP99AllowanceUs = jitterRadiusUs * 2 + 5_000;
  const schedulerMaxAllowanceUs = jitterRadiusUs * 2 + reorderHoldUs + congestionHoldUs + 20_000;
  for (const [name, direction] of [
    ['upstream', stats.upstream],
    ['downstream', stats.downstream],
  ] as const) {
    if (jitterRadiusUs > 0 && direction.seen > 0) {
      if (direction.jittered === 0 || direction.jittered > direction.seen) {
        errors.push(`${name} configured jitter was not realized`);
      }
      if (direction.scheduledDelayUs.count >= 20) {
        const spreadFloorUs = Math.max(1, Math.floor(jitterRadiusUs / 4));
        if (
          direction.scheduledDelayUs.min > baseDelayUs - spreadFloorUs ||
          direction.scheduledDelayUs.max < baseDelayUs + spreadFloorUs
        ) {
          errors.push(`${name} scheduled delay did not realize two-sided jitter spread`);
        }
        // Upstream has no reorder/congestion hold, so its mean is an exact
        // centred-jitter oracle. Downstream's configured positive holds make
        // the same mean test invalid even though its min/max still prove
        // jitter was sampled in both directions.
        if (
          name === 'upstream' &&
          Math.abs(direction.scheduledDelayUs.mean - baseDelayUs) > jitterRadiusUs / 2
        ) {
          errors.push('upstream scheduled jitter mean is not centred on the configured delay');
        }
      }
    }
    if (
      direction.scheduledDelayUs.count > 0 &&
      (direction.scheduledDelayUs.min < scheduledFloorUs ||
        direction.scheduledDelayUs.max > scheduledCeilingUs)
    ) {
      errors.push(`${name} controller-selected delay escaped the configured profile bounds`);
    }
    if (
      direction.releaseTargetResidenceUs.count > 0 &&
      (direction.releaseTargetResidenceUs.min < releaseTargetFloorUs ||
        direction.releaseTargetResidenceUs.max > scheduledCeilingUs)
    ) {
      errors.push(`${name} enqueue-to-deadline target escaped the configured profile bounds`);
    }
    if (
      direction.actualResidenceUs.count > 0 &&
      direction.actualResidenceUs.min < releaseTargetFloorUs
    ) {
      errors.push(`${name} actual userspace residence was shorter than the configured profile`);
    }
    if (
      direction.actualResidenceUs.count > 0 &&
      (direction.actualResidenceUs.min < direction.releaseTargetResidenceUs.min ||
        direction.actualResidenceUs.p50 < direction.releaseTargetResidenceUs.p50 ||
        direction.actualResidenceUs.p95 < direction.releaseTargetResidenceUs.p95 ||
        direction.actualResidenceUs.p99 < direction.releaseTargetResidenceUs.p99 ||
        direction.actualResidenceUs.max < direction.releaseTargetResidenceUs.max ||
        Math.abs(
          direction.actualResidenceUs.mean -
            direction.releaseTargetResidenceUs.mean -
            direction.releaseOvershootUs.mean,
        ) > 1)
    ) {
      errors.push(`${name} userspace release residence is inconsistent with target plus overshoot`);
    }
    if (
      direction.releaseOvershootUs.count > 0 &&
      (direction.releaseOvershootUs.p99 > schedulerP99AllowanceUs ||
        direction.releaseOvershootUs.max > schedulerMaxAllowanceUs)
    ) {
      errors.push(`${name} userspace release scheduler exceeded its bounded overshoot budget`);
    }
  }
  if (PROXY_HARNESS_DROP_KINDS.some((kind) => stats.harnessDrops[kind] !== 0)) {
    errors.push('proxy dropped packets outside the configured impairment');
  }
  errors.push(...proxyLinkReleaseErrors(stats));
  if (options.requireDrained && stats.pendingScheduledPackets !== 0) {
    errors.push('proxy still owns scheduled packets at artifact closure');
  }

  if (stats.config.datagramLossPercent === 0 && evidence.exactLossObserved) {
    errors.push('proxy applied exact loss in a zero-loss trace');
  }
  if (
    stats.config.reorder === 'none' &&
    (stats.downstream.reordered > 0 || evidence.reorderObserved)
  ) {
    errors.push('proxy reordered packets in a no-reorder trace');
  }
  if (stats.config.scenario !== 'burst-loss' && evidence.burstLossObserved) {
    errors.push('proxy applied burst loss outside the burst-loss scenario');
  }
  if (stats.config.scenario !== 'congestion' && evidence.congestionObserved) {
    errors.push('proxy applied congestion outside the congestion scenario');
  }

  if (options.requireConfiguredFaultsObserved) {
    if (stats.config.datagramLossPercent > 0 && !evidence.exactLossObserved) {
      errors.push('configured exact downstream UDP loss was not observed');
    }
    if (stats.config.reorder !== 'none' && !evidence.reorderObserved) {
      errors.push('configured downstream reordering was not observed');
    }
    if (stats.config.scenario === 'burst-loss' && !evidence.burstLossObserved) {
      errors.push('configured short downstream burst loss was not observed');
    }
    if (stats.config.scenario === 'congestion' && !evidence.congestionObserved) {
      errors.push('configured bounded downstream congestion was not observed');
    }
  }
  return errors;
}

/**
 * A link run is valid only while its task released packets on time: the p99
 * lateness bucket must stay below one full packet at the link's lowest rate.
 */
export function proxyLinkReleaseErrors(stats: ProxyImpairmentStats): string[] {
  return stats.links
    .filter((link) => link.releaseOvershootP99UpperUs >= link.lowestRatePacketUs)
    .map(
      (link) =>
        `${link.config.role} ${link.config.direction}link released packets late: p99 below ` +
        `${link.releaseOvershootP99UpperUs} µs is not under one ${link.lowestRatePacketUs} µs packet`,
    );
}

/**
 * Loss windows are per relay and a mark abandons a relay's partial window, so
 * the aggregate seen/dropped counts bound nothing. The proxy totals completed
 * windows instead, and each holds exactly the configured selections.
 */
function exactLossWindowsAreExact(stats: ProxyImpairmentStats): boolean {
  return (
    stats.exactLossDroppedInCompletedWindows ===
    stats.config.datagramLossPercent * stats.exactLossWindowsCompleted
  );
}

export interface ProxyControlResponseAssembler<T> {
  /** Returns a complete validated reply only after every exact chunk arrives. */
  push(raw: string): T | null;
}

/**
 * Reassemble one control reply from bounded UDP chunks.
 *
 * Full snapshots contain eight 512-bucket histograms and exceed macOS's
 * default 9,216-byte UDP ceiling even when empty, and a settle or mark status
 * lists every live relay, up to `PROXY_MAX_RELAYS`. A request nonce identifies
 * one cached native reply; responseId rejects mixed retries, and duplicate
 * chunks are accepted only when byte-identical.
 */
export function createProxyControlResponseAssembler<T>(
  expectedKind: 'reset' | 'stats' | 'settle' | 'mark',
  expectedNonce: string,
  parse: (value: unknown) => T | null,
): ProxyControlResponseAssembler<T> {
  if (expectedNonce.length === 0) throw new Error('proxy control nonce must not be empty');
  let responseId: number | null = null;
  let chunkCount = 0;
  let payloadByteLength = 0;
  let receivedChunkCount = 0;
  let chunks: (Buffer | null)[] = [];

  return {
    push(raw: string): T | null {
      if (Buffer.byteLength(raw, 'utf8') > PROXY_CONTROL_MAX_DATAGRAM_BYTES) {
        throw new Error('delay proxy control response chunk exceeds the portable UDP ceiling');
      }
      let value: unknown;
      try {
        value = JSON.parse(raw);
      } catch {
        return null;
      }
      if (!isRecord(value) || value.kind !== expectedKind || value.nonce !== expectedNonce) {
        return null;
      }
      if (
        !hasExactKeys(value, [
          'kind',
          'nonce',
          'responseId',
          'chunkIndex',
          'chunkCount',
          'payloadByteLength',
          'payloadBase64',
        ]) ||
        !isPositiveU32(value.responseId) ||
        !isNonNegativeSafeInteger(value.chunkIndex) ||
        !isPositiveSafeInteger(value.chunkCount) ||
        value.chunkCount > PROXY_CONTROL_MAX_CHUNKS ||
        value.chunkIndex >= value.chunkCount ||
        !isPositiveSafeInteger(value.payloadByteLength) ||
        value.payloadByteLength > PROXY_CONTROL_CHUNK_PAYLOAD_BYTES * PROXY_CONTROL_MAX_CHUNKS ||
        value.chunkCount !==
          Math.ceil(value.payloadByteLength / PROXY_CONTROL_CHUNK_PAYLOAD_BYTES) ||
        typeof value.payloadBase64 !== 'string'
      ) {
        throw new Error('delay proxy returned malformed control chunk metadata');
      }
      const payload = Buffer.from(value.payloadBase64, 'base64');
      const expectedChunkByteLength =
        value.chunkIndex + 1 === value.chunkCount
          ? value.payloadByteLength - value.chunkIndex * PROXY_CONTROL_CHUNK_PAYLOAD_BYTES
          : PROXY_CONTROL_CHUNK_PAYLOAD_BYTES;
      if (
        payload.length !== expectedChunkByteLength ||
        payload.length === 0 ||
        payload.toString('base64') !== value.payloadBase64
      ) {
        throw new Error('delay proxy returned malformed control chunk payload');
      }

      if (responseId === null) {
        responseId = value.responseId;
        chunkCount = value.chunkCount;
        payloadByteLength = value.payloadByteLength;
        chunks = Array<Buffer | null>(chunkCount).fill(null);
      } else if (
        responseId !== value.responseId ||
        chunkCount !== value.chunkCount ||
        payloadByteLength !== value.payloadByteLength
      ) {
        throw new Error('delay proxy mixed control response snapshots for one nonce');
      }

      const prior = chunks[value.chunkIndex];
      if (prior !== null && prior !== undefined) {
        if (!prior.equals(payload)) {
          throw new Error('delay proxy returned conflicting duplicate control chunks');
        }
        return null;
      }
      chunks[value.chunkIndex] = payload;
      receivedChunkCount += 1;
      if (receivedChunkCount !== chunkCount) return null;

      const encoded = Buffer.concat(chunks as Buffer[], payloadByteLength);
      if (encoded.length !== payloadByteLength) {
        throw new Error('delay proxy control response length does not match its chunk metadata');
      }
      let body: unknown;
      try {
        body = JSON.parse(encoded.toString('utf8'));
      } catch {
        throw new Error('delay proxy control response payload is not valid JSON');
      }
      const parsed = parse(body);
      if (parsed === null) throw new Error('delay proxy control response payload is malformed');
      return parsed;
    },
  };
}

/**
 * The status a reply to `mark:<nonce>:<key>` carries: the settle status as the
 * mark found it, already carrying the new generation and key.
 */
export function parseProxyMarkStatus(
  value: unknown,
  expectedKey: number,
): ProxySettleStatus | null {
  const status = parseProxySettleStatus(value);
  return status?.mark.key === expectedKey ? status : null;
}

export function parseProxySettleStatus(value: unknown): ProxySettleStatus | null {
  if (
    !isRecord(value) ||
    value.schemaVersion !== PROXY_IMPAIRMENT_SCHEMA_VERSION ||
    !isNonNegativeSafeInteger(value.epoch) ||
    !isNonNegativeSafeInteger(value.splitDatagrams) ||
    !isNonNegativeSafeInteger(value.pendingScheduledPackets)
  ) {
    return null;
  }
  const harnessDrops = parseHarnessDrops(value.harnessDrops);
  const mark = parseTraceMark(value.mark);
  const sinceMark = parseTraceLedger(value.sinceMark);
  const upstream = parseProxySettleDirection(value.upstream);
  const downstream = parseProxySettleDirection(value.downstream);
  const relays =
    sinceMark === null
      ? null
      : parseRelayStatuses(value.relays, value.pendingScheduledPackets, sinceMark);
  if (
    harnessDrops === null ||
    mark === null ||
    sinceMark === null ||
    relays === null ||
    upstream === null ||
    downstream === null ||
    // A mark only ever narrows the epoch.
    sinceMark.upSeen > upstream.seen ||
    sinceMark.downSeen > downstream.seen ||
    sinceMark.downDropped > downstream.dropped ||
    upstream.dropped !== 0 ||
    upstream.seen !== upstream.forwarded ||
    downstream.seen !== downstream.forwarded + downstream.dropped ||
    upstream.released > upstream.forwarded ||
    downstream.released > downstream.forwarded + value.splitDatagrams ||
    upstream.reorderInversions !== 0 ||
    upstream.reorderInversions > upstream.released ||
    downstream.reorderInversions > downstream.released
  ) {
    return null;
  }
  return {
    schemaVersion: PROXY_IMPAIRMENT_SCHEMA_VERSION,
    epoch: value.epoch,
    mark,
    sinceMark,
    upstream,
    downstream,
    harnessDrops,
    splitDatagrams: value.splitDatagrams,
    pendingScheduledPackets: value.pendingScheduledPackets,
    relays,
  };
}

function parseHarnessDrops(value: unknown): ProxyHarnessDrops | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, PROXY_HARNESS_DROP_KINDS) ||
    !PROXY_HARNESS_DROP_KINDS.every((kind) => isNonNegativeSafeInteger(value[kind]))
  ) {
    return null;
  }
  return {
    oversized: value.oversized as number,
    admission: value.admission as number,
    leaseExhausted: value.leaseExhausted as number,
  };
}

function parseListener(value: unknown): ProxyListener | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['role', 'competitor']) ||
    !isMember(PROXY_ROLES, value.role) ||
    typeof value.competitor !== 'boolean'
  ) {
    return null;
  }
  return { role: value.role, competitor: value.competitor };
}

function parseLog2Histogram(value: unknown): number[] | null {
  if (
    !Array.isArray(value) ||
    value.length !== PROXY_LINK_LOG2_BUCKETS ||
    !value.every(isNonNegativeSafeInteger)
  ) {
    return null;
  }
  return [...value];
}

function parseLinkConfig(value: unknown): ProxyLinkConfig | null {
  if (
    !isRecord(value) ||
    !isMember(PROXY_ROLES, value.role) ||
    !isMember(PROXY_LINK_DIRECTIONS, value.direction) ||
    !isPositiveSafeInteger(value.rateBps) ||
    !isPositiveSafeInteger(value.bufferBytes) ||
    typeof value.fq !== 'boolean'
  ) {
    return null;
  }
  let step: ProxyLinkConfig['step'] = null;
  if (value.step !== null) {
    if (
      !isRecord(value.step) ||
      !isPositiveSafeInteger(value.step.afterMarkMs) ||
      !isPositiveSafeInteger(value.step.rateBps)
    ) {
      return null;
    }
    step = { afterMarkMs: value.step.afterMarkMs, rateBps: value.step.rateBps };
  }
  return {
    role: value.role,
    direction: value.direction,
    rateBps: value.rateBps,
    bufferBytes: value.bufferBytes,
    fq: value.fq,
    step,
  };
}

function parseLinkStatus(value: unknown): ProxyLinkStatus | null {
  if (!isRecord(value)) return null;
  const config = parseLinkConfig(value.config);
  const totals = value.totals;
  if (
    config === null ||
    !isPositiveSafeInteger(value.rateBps) ||
    !isNonNegativeSafeInteger(value.releaseOvershootP99UpperUs) ||
    !isNonNegativeSafeInteger(value.lowestRatePacketUs) ||
    !isRecord(totals)
  ) {
    return null;
  }
  const residenceLog2Us = parseLog2Histogram(totals.residenceLog2Us);
  const bytesAheadLog2 = parseLog2Histogram(totals.bytesAheadLog2);
  const releaseOvershootLog2Us = parseLog2Histogram(totals.releaseOvershootLog2Us);
  const counters = [
    totals.arrivals,
    totals.departures,
    totals.bottleneckDrops,
    totals.lostAfterLink,
    totals.departedBytes,
    totals.busyNs,
    totals.rateChanges,
  ];
  if (
    residenceLog2Us === null ||
    bytesAheadLog2 === null ||
    releaseOvershootLog2Us === null ||
    !counters.every(isNonNegativeSafeInteger) ||
    (totals.departures as number) > (totals.arrivals as number) ||
    (totals.lostAfterLink as number) > (totals.departures as number)
  ) {
    return null;
  }
  return {
    config,
    rateBps: value.rateBps,
    totals: {
      arrivals: totals.arrivals as number,
      departures: totals.departures as number,
      bottleneckDrops: totals.bottleneckDrops as number,
      lostAfterLink: totals.lostAfterLink as number,
      departedBytes: totals.departedBytes as number,
      busyNs: totals.busyNs as number,
      rateChanges: totals.rateChanges as number,
      residenceLog2Us,
      bytesAheadLog2,
      releaseOvershootLog2Us,
    },
    releaseOvershootP99UpperUs: value.releaseOvershootP99UpperUs,
    lowestRatePacketUs: value.lowestRatePacketUs,
  };
}

function parseRelayLinkStatus(value: unknown): ProxyRelayLinkStatus | null {
  if (!isRecord(value) || !isMember(PROXY_LINK_DIRECTIONS, value.direction)) return null;
  const stats = value.stats;
  if (!isRecord(stats)) return null;
  const residenceLog2Us = parseLog2Histogram(stats.residenceLog2Us);
  const bytesAheadLog2 = parseLog2Histogram(stats.bytesAheadLog2);
  const trace = value.stepTraceMaxResidenceUs;
  if (
    residenceLog2Us === null ||
    bytesAheadLog2 === null ||
    ![stats.packets, stats.bytes, stats.bottleneckDrops, stats.maxResidenceUs].every(
      isNonNegativeSafeInteger,
    ) ||
    (trace !== undefined && (!Array.isArray(trace) || !trace.every(isNonNegativeSafeInteger)))
  ) {
    return null;
  }
  return {
    direction: value.direction,
    stats: {
      packets: stats.packets as number,
      bytes: stats.bytes as number,
      bottleneckDrops: stats.bottleneckDrops as number,
      maxResidenceUs: stats.maxResidenceUs as number,
      residenceLog2Us,
      bytesAheadLog2,
    },
    ...(trace === undefined ? {} : { stepTraceMaxResidenceUs: [...(trace as number[])] }),
  };
}

function parseRelayLinks(value: unknown): ProxyRelayLinks[] | null {
  if (!Array.isArray(value) || value.length > PROXY_MAX_RELAYS) return null;
  const relays: ProxyRelayLinks[] = [];
  for (const entry of value) {
    if (!isRecord(entry) || !Array.isArray(entry.links)) return null;
    const listener = parseListener(entry.listener);
    const links = entry.links.map(parseRelayLinkStatus);
    if (
      listener === null ||
      links.some((link) => link === null) ||
      !isPositiveSafeInteger(entry.admissionSeq) ||
      !isNonNegativeSafeInteger(entry.upstreamPort) ||
      entry.upstreamPort > 0xffff ||
      entry.admissionSeq <= (relays.at(-1)?.admissionSeq ?? 0)
    ) {
      return null;
    }
    relays.push({
      admissionSeq: entry.admissionSeq,
      listener,
      upstreamPort: entry.upstreamPort,
      links: links as ProxyRelayLinkStatus[],
    });
  }
  return relays;
}

function parseTraceMark(value: unknown): ProxyTraceMark | null {
  if (
    !isRecord(value) ||
    !isNonNegativeSafeInteger(value.generation) ||
    !isNonNegativeSafeInteger(value.key) ||
    value.key >= PROXY_MAX_TRACE_MARK_KEY
  ) {
    return null;
  }
  return { generation: value.generation, key: value.key };
}

function parseTraceLedger(value: unknown): ProxyTraceLedger | null {
  if (
    !isRecord(value) ||
    !isNonNegativeSafeInteger(value.upSeen) ||
    !isNonNegativeSafeInteger(value.downSeen) ||
    !isNonNegativeSafeInteger(value.downDropped) ||
    !isNonNegativeSafeInteger(value.downReordered) ||
    value.downDropped > value.downSeen ||
    value.downReordered > value.downSeen
  ) {
    return null;
  }
  return {
    upSeen: value.upSeen,
    downSeen: value.downSeen,
    downDropped: value.downDropped,
    downReordered: value.downReordered,
  };
}

/**
 * Relays arrive in strict admission order, their pending packets are the whole
 * scheduled total, and their since-mark ledgers sum to no more than `bound`:
 * the trace-wide ledger, which also keeps relays that have detached, or the
 * epoch's counters, which a mark or reset only ever narrows.
 */
function parseRelayStatuses(
  value: unknown,
  pendingScheduledPackets: number,
  bound: ProxyTraceLedger,
): ProxyRelayStatus[] | null {
  if (!Array.isArray(value) || value.length > PROXY_MAX_RELAYS) return null;
  const relays: ProxyRelayStatus[] = [];
  let pending = 0;
  let upSeen = 0;
  let downSeen = 0;
  let downDropped = 0;
  let downReordered = 0;
  for (const entry of value) {
    const ledger = parseTraceLedger(entry);
    const listener = isRecord(entry) ? parseListener(entry.listener) : null;
    if (
      ledger === null ||
      listener === null ||
      !isRecord(entry) ||
      !isPositiveSafeInteger(entry.admissionSeq) ||
      !isNonNegativeSafeInteger(entry.upstreamPort) ||
      entry.upstreamPort > 0xffff ||
      !isNonNegativeSafeInteger(entry.bottleneckDrops) ||
      !isNonNegativeSafeInteger(entry.pending) ||
      entry.pending > PROXY_RELAY_PACKET_LEASES ||
      !isNonNegativeSafeInteger(entry.upMaxInFlight) ||
      entry.upMaxInFlight > PROXY_RELAY_PACKET_LEASES ||
      !isNonNegativeSafeInteger(entry.downMaxInFlight) ||
      entry.downMaxInFlight > PROXY_RELAY_PACKET_LEASES ||
      entry.admissionSeq <= (relays.at(-1)?.admissionSeq ?? 0)
    ) {
      return null;
    }
    relays.push({
      admissionSeq: entry.admissionSeq,
      listener,
      upstreamPort: entry.upstreamPort,
      pending: entry.pending,
      ...ledger,
      upMaxInFlight: entry.upMaxInFlight,
      downMaxInFlight: entry.downMaxInFlight,
      bottleneckDrops: entry.bottleneckDrops,
    });
    pending += entry.pending;
    upSeen += ledger.upSeen;
    downSeen += ledger.downSeen;
    downDropped += ledger.downDropped;
    downReordered += ledger.downReordered;
  }
  if (
    pending !== pendingScheduledPackets ||
    upSeen > bound.upSeen ||
    downSeen > bound.downSeen ||
    downDropped > bound.downDropped ||
    downReordered > bound.downReordered
  ) {
    return null;
  }
  return relays;
}

/** Parse one artifact/control impairment snapshot using the same hard schema. */
export function parseProxyImpairmentStats(value: unknown): ProxyImpairmentStats | null {
  const stats = value;
  if (
    !isRecord(stats) ||
    stats.schemaVersion !== PROXY_IMPAIRMENT_SCHEMA_VERSION ||
    !isNonNegativeSafeInteger(stats.epoch)
  ) {
    return null;
  }
  const config = stats.config;
  const upstream = parseDirectionStats(stats.upstream);
  const downstream = parseDirectionStats(stats.downstream);
  const harnessDrops = parseHarnessDrops(stats.harnessDrops);
  if (
    !isRecord(config) ||
    typeof config.profile !== 'string' ||
    !isNonNegativeSafeInteger(config.targetRttMs) ||
    !isNonNegativeSafeInteger(config.baseDelayUs) ||
    !isNonNegativeSafeInteger(config.jitterRadiusUs) ||
    !isNonNegativeSafeInteger(config.datagramLossPercent) ||
    config.faultSite !== 'edge-to-client' ||
    config.faultSitesPerLogicalDirection !== 1 ||
    typeof config.reorder !== 'string' ||
    typeof config.scenario !== 'string' ||
    !isNonNegativeSafeInteger(config.seed) ||
    upstream === null ||
    downstream === null ||
    !isLogicalPathImpairment(stats.logicalPathImpairment) ||
    harnessDrops === null ||
    !isNonNegativeSafeInteger(stats.splitDatagrams) ||
    !isNonNegativeSafeInteger(stats.pendingScheduledPackets) ||
    !isNonNegativeSafeInteger(stats.exactLossWindowsCompleted) ||
    !isNonNegativeSafeInteger(stats.exactLossDroppedInCompletedWindows)
  ) {
    return null;
  }
  const relays = parseRelayStatuses(stats.relays, stats.pendingScheduledPackets, {
    upSeen: upstream.seen,
    downSeen: downstream.seen,
    downDropped: downstream.dropped,
    downReordered: downstream.reordered,
  });
  const links = Array.isArray(stats.links) ? stats.links.map(parseLinkStatus) : null;
  const relayLinks = parseRelayLinks(stats.relayLinks);
  const logicalPathImpairment = stats.logicalPathImpairment;
  if (
    relays === null ||
    links === null ||
    links.some((link) => link === null) ||
    relayLinks === null ||
    stats.exactLossWindowsCompleted * LOSS_WINDOW_PACKETS > downstream.seen ||
    stats.exactLossDroppedInCompletedWindows > downstream.exactLossDropped ||
    upstream.dropped !== 0 ||
    upstream.exactLossDropped !== 0 ||
    upstream.burstLossDropped !== 0 ||
    upstream.burstLossRunsCompleted !== 0 ||
    upstream.reordered !== 0 ||
    upstream.reorderInversions !== 0 ||
    upstream.congested !== 0 ||
    upstream.congestedForwarded !== 0 ||
    upstream.congestionClamped !== 0 ||
    upstream.maxCongestionQueueDelayUs !== 0 ||
    upstream.maxForwardedCongestionQueueDelayUs !== 0 ||
    upstream.achievedPacketLossPercent !== 0 ||
    logicalPathImpairment.requestedDatagramLossPercent !== config.datagramLossPercent ||
    logicalPathImpairment.observedFaultSitePackets !== downstream.seen ||
    logicalPathImpairment.droppedAtFaultSite !== downstream.dropped ||
    logicalPathImpairment.achievedPacketLossPercent !== downstream.achievedPacketLossPercent
  ) {
    return null;
  }
  return {
    schemaVersion: stats.schemaVersion,
    epoch: stats.epoch,
    config: {
      profile: config.profile,
      targetRttMs: config.targetRttMs,
      baseDelayUs: config.baseDelayUs,
      jitterRadiusUs: config.jitterRadiusUs,
      datagramLossPercent: config.datagramLossPercent,
      faultSite: config.faultSite,
      faultSitesPerLogicalDirection: config.faultSitesPerLogicalDirection,
      reorder: config.reorder,
      scenario: config.scenario,
      seed: config.seed,
    },
    upstream,
    downstream,
    logicalPathImpairment,
    harnessDrops,
    splitDatagrams: stats.splitDatagrams,
    pendingScheduledPackets: stats.pendingScheduledPackets,
    exactLossWindowsCompleted: stats.exactLossWindowsCompleted,
    exactLossDroppedInCompletedWindows: stats.exactLossDroppedInCompletedWindows,
    relays,
    links: links as ProxyLinkStatus[],
    relayLinks,
  };
}

function parseDirectionStats(value: unknown): ProxyDirectionStats | null {
  if (!isRecord(value)) return null;
  const scheduledDelayUs = parseDelayDistribution(value.scheduledDelayUs);
  const releaseTargetResidenceUs = parseDelayDistribution(value.releaseTargetResidenceUs);
  const actualResidenceUs = parseDelayDistribution(value.actualResidenceUs);
  const releaseOvershootUs = parseDelayDistribution(value.releaseOvershootUs);
  const counters = [
    value.seen,
    value.forwarded,
    value.dropped,
    value.exactLossDropped,
    value.burstLossDropped,
    value.burstLossRunsCompleted,
    value.jittered,
    value.reorderInversions,
    value.reordered,
    value.congested,
    value.congestedForwarded,
    value.congestionClamped,
    value.maxCongestionQueueDelayUs,
    value.maxForwardedCongestionQueueDelayUs,
    value.releaseEarlyCount,
    value.maxReleaseEarlyUs,
  ];
  if (
    !counters.every(isNonNegativeSafeInteger) ||
    typeof value.achievedPacketLossPercent !== 'number' ||
    !Number.isFinite(value.achievedPacketLossPercent) ||
    value.achievedPacketLossPercent < 0 ||
    scheduledDelayUs === null ||
    releaseTargetResidenceUs === null ||
    actualResidenceUs === null ||
    releaseOvershootUs === null
  ) {
    return null;
  }
  const seen = value.seen as number;
  const dropped = value.dropped as number;
  const exactLossDropped = value.exactLossDropped as number;
  const burstLossDropped = value.burstLossDropped as number;
  const expectedLossPercent = seen === 0 ? 0 : (dropped * 100) / seen;
  if (
    value.achievedPacketLossPercent !== expectedLossPercent ||
    exactLossDropped > dropped ||
    burstLossDropped > dropped ||
    dropped > exactLossDropped + burstLossDropped ||
    (value.congestedForwarded as number) > (value.congested as number) ||
    (value.congestedForwarded as number) > (value.forwarded as number) ||
    ((value.congestedForwarded as number) === 0 &&
      (value.maxForwardedCongestionQueueDelayUs as number) !== 0) ||
    (value.maxForwardedCongestionQueueDelayUs as number) >
      (value.maxCongestionQueueDelayUs as number)
  ) {
    return null;
  }
  return {
    seen,
    forwarded: value.forwarded as number,
    dropped,
    exactLossDropped,
    burstLossDropped,
    burstLossRunsCompleted: value.burstLossRunsCompleted as number,
    jittered: value.jittered as number,
    reorderInversions: value.reorderInversions as number,
    reordered: value.reordered as number,
    congested: value.congested as number,
    congestedForwarded: value.congestedForwarded as number,
    congestionClamped: value.congestionClamped as number,
    maxCongestionQueueDelayUs: value.maxCongestionQueueDelayUs as number,
    maxForwardedCongestionQueueDelayUs: value.maxForwardedCongestionQueueDelayUs as number,
    achievedPacketLossPercent: value.achievedPacketLossPercent,
    scheduledDelayUs,
    releaseTargetResidenceUs,
    actualResidenceUs,
    releaseOvershootUs,
    releaseEarlyCount: value.releaseEarlyCount as number,
    maxReleaseEarlyUs: value.maxReleaseEarlyUs as number,
  };
}

function parseProxySettleDirection(value: unknown): ProxySettleDirectionStatus | null {
  if (!isRecord(value)) return null;
  const fields = [
    value.seen,
    value.forwarded,
    value.dropped,
    value.released,
    value.reorderInversions,
  ];
  if (!fields.every(isNonNegativeSafeInteger)) return null;
  return {
    seen: value.seen as number,
    forwarded: value.forwarded as number,
    dropped: value.dropped as number,
    released: value.released as number,
    reorderInversions: value.reorderInversions as number,
  };
}

function isLogicalPathImpairment(
  value: unknown,
): value is ProxyImpairmentStats['logicalPathImpairment'] {
  return (
    isRecord(value) &&
    value.faultSite === 'edge-to-client' &&
    value.faultSitesPerLogicalDirection === 1 &&
    isNonNegativeSafeInteger(value.requestedDatagramLossPercent) &&
    isNonNegativeSafeInteger(value.observedFaultSitePackets) &&
    isNonNegativeSafeInteger(value.droppedAtFaultSite) &&
    typeof value.achievedPacketLossPercent === 'number' &&
    Number.isFinite(value.achievedPacketLossPercent) &&
    value.achievedPacketLossPercent >= 0
  );
}

function parseDelayDistribution(value: unknown): ProxyDelayDistribution | null {
  if (!isRecord(value)) return null;
  const histogram = value.histogram;
  if (
    value.histogramBucketUs !== PROXY_DELAY_HISTOGRAM_BUCKET_US ||
    !Array.isArray(histogram) ||
    histogram.length !== PROXY_DELAY_HISTOGRAM_BUCKETS ||
    !histogram.every(isNonNegativeSafeInteger)
  ) {
    return null;
  }
  const histogramCount = histogram.reduce((sum, count) => sum + count, 0);
  const firstOccupiedBucket = histogram.findIndex((count) => count > 0);
  let lastOccupiedBucket = -1;
  for (let index = histogram.length - 1; index >= 0; index -= 1) {
    if ((histogram[index] ?? 0) > 0) {
      lastOccupiedBucket = index;
      break;
    }
  }
  const p50 = proxyHistogramQuantile(histogram, histogramCount, value.max, 50);
  const p95 = proxyHistogramQuantile(histogram, histogramCount, value.max, 95);
  const p99 = proxyHistogramQuantile(histogram, histogramCount, value.max, 99);
  if (
    !isNonNegativeSafeInteger(value.count) ||
    typeof value.mean !== 'number' ||
    !Number.isFinite(value.mean) ||
    value.mean < 0 ||
    !isNonNegativeSafeInteger(value.min) ||
    !isNonNegativeSafeInteger(value.p50) ||
    !isNonNegativeSafeInteger(value.p95) ||
    !isNonNegativeSafeInteger(value.p99) ||
    !isNonNegativeSafeInteger(value.max) ||
    !Number.isSafeInteger(histogramCount) ||
    histogramCount !== value.count ||
    (value.count === 0 &&
      (value.mean !== 0 ||
        value.min !== 0 ||
        value.p50 !== 0 ||
        value.p95 !== 0 ||
        value.p99 !== 0 ||
        value.max !== 0 ||
        firstOccupiedBucket !== -1 ||
        lastOccupiedBucket !== -1)) ||
    (value.count > 0 &&
      (value.min > value.p50 ||
        value.p50 > value.p95 ||
        value.p95 > value.p99 ||
        value.p99 > value.max ||
        value.mean < value.min ||
        value.mean > value.max ||
        firstOccupiedBucket !==
          Math.min(
            PROXY_DELAY_HISTOGRAM_BUCKETS - 1,
            Math.floor(value.min / PROXY_DELAY_HISTOGRAM_BUCKET_US),
          ) ||
        lastOccupiedBucket !==
          Math.min(
            PROXY_DELAY_HISTOGRAM_BUCKETS - 1,
            Math.floor(value.max / PROXY_DELAY_HISTOGRAM_BUCKET_US),
          ) ||
        value.p50 !== p50 ||
        value.p95 !== p95 ||
        value.p99 !== p99))
  ) {
    return null;
  }
  return {
    count: value.count,
    mean: value.mean,
    min: value.min,
    p50: value.p50,
    p95: value.p95,
    p99: value.p99,
    max: value.max,
    histogramBucketUs: PROXY_DELAY_HISTOGRAM_BUCKET_US,
    histogram: [...histogram],
  };
}

function proxyHistogramQuantile(
  histogram: readonly number[],
  count: number,
  maximum: unknown,
  percentile: number,
): number {
  if (count === 0 || !isNonNegativeSafeInteger(maximum)) return 0;
  const target = Math.ceil((count * percentile) / 100);
  let cumulative = 0;
  for (let index = 0; index < histogram.length; index += 1) {
    cumulative += histogram[index] ?? 0;
    if (cumulative >= target) {
      return Math.min((index + 1) * PROXY_DELAY_HISTOGRAM_BUCKET_US, maximum);
    }
  }
  return maximum;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function isPositiveU32(value: unknown): value is number {
  return isPositiveSafeInteger(value) && value <= 0xffff_ffff;
}

function isMember<const T extends readonly string[]>(
  values: T,
  value: unknown,
): value is T[number] {
  return typeof value === 'string' && values.includes(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}
