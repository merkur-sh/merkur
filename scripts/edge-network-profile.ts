export const EDGE_NETWORK_PROFILE_NAMES = ['fast', 'typical', 'difficult'] as const;
export type EdgeNetworkProfileName = (typeof EDGE_NETWORK_PROFILE_NAMES)[number];

export const EDGE_NETWORK_DATAGRAM_LOSS_PERCENTAGES = [0, 1, 3, 9] as const;
export type EdgeNetworkDatagramLossPercent =
  (typeof EDGE_NETWORK_DATAGRAM_LOSS_PERCENTAGES)[number];

export const EDGE_NETWORK_REORDER_MODES = ['none', 'light', 'moderate'] as const;
export type EdgeNetworkReorderMode = (typeof EDGE_NETWORK_REORDER_MODES)[number];

export const EDGE_NETWORK_SCENARIOS = [
  'steady',
  'burst-loss',
  'congestion',
  'handshake-split',
] as const;
export type EdgeNetworkScenario = (typeof EDGE_NETWORK_SCENARIOS)[number];

export interface EdgeNetworkProfile {
  readonly name: EdgeNetworkProfileName;
  /** Browser -> daemon -> browser application RTT, before injected jitter. */
  readonly targetRttMs: number;
  /**
   * Delay on one client <-> edge proxy leg. Terminal RTT crosses four such
   * legs, so this is exactly one quarter of `targetRttMs`.
   */
  readonly hopDelayUs: number;
  /** Peak-to-peak jitter across the two proxy legs in one application direction. */
  readonly oneWayJitterUs: number;
}

export const EDGE_NETWORK_PROFILES: Readonly<Record<EdgeNetworkProfileName, EdgeNetworkProfile>> = {
  fast: {
    name: 'fast',
    targetRttMs: 50,
    hopDelayUs: 12_500,
    oneWayJitterUs: 5_000,
  },
  typical: {
    name: 'typical',
    targetRttMs: 120,
    hopDelayUs: 30_000,
    oneWayJitterUs: 15_000,
  },
  difficult: {
    name: 'difficult',
    targetRttMs: 200,
    hopDelayUs: 50_000,
    oneWayJitterUs: 30_000,
  },
};

export const DEFAULT_EDGE_NETWORK_SEED = 0x4d45_5243;

/**
 * Capacity bottlenecks, each one drop-tail (or flow-queued) link that every
 * connection of one peer crosses. Buffers stated as a BDP multiple are that
 * multiple of the link rate times the profile's application RTT.
 */
export const EDGE_NETWORK_BOTTLENECKS = [
  /** A cable uplink on the daemon's side: 10 Mbit/s behind 256 KiB. */
  'uplink-bloat',
  /** A bloated browser downlink: 25 Mbit/s behind 640 KB. */
  'downlink-bloat',
  /** A shallow browser downlink: 25 Mbit/s behind a quarter BDP. */
  'downlink-shallow',
  /** The bloated downlink stepping to 5 Mbit/s two seconds after each mark. */
  'downlink-step',
  /** A flow-queued browser downlink: 50 Mbit/s, 625 KB, one queue per connection. */
  'downlink-fq',
  /** 25 Mbit/s behind exactly one BDP: the random-loss arm. */
  'downlink-bdp',
  /** 25 Mbit/s behind four BDP: a deep buffer beside a competitor. */
  'downlink-deep',
  /** 25 Mbit/s behind half a BDP: a shallow buffer beside a competitor. */
  'downlink-half',
  /** 100 Mbit/s behind one BDP: the daemon hop's credit at a fast downlink. */
  'downlink-fast-bdp',
] as const;
export type EdgeNetworkBottleneckName = (typeof EDGE_NETWORK_BOTTLENECKS)[number];

/** Whose access link a competing flow shares. */
export const EDGE_NETWORK_COMPETITORS = ['daemon', 'browser'] as const;
export type EdgeNetworkCompetitor = (typeof EDGE_NETWORK_COMPETITORS)[number];

/** One link as the delay proxy declares it. */
export interface EdgeNetworkLink {
  readonly role: 'daemon' | 'browser';
  readonly direction: 'up' | 'down';
  readonly rateBps: number;
  readonly bufferBytes: number;
  readonly fq: boolean;
  /** The rate `afterMarkMs` after each proxy trace mark. */
  readonly step: { readonly afterMarkMs: number; readonly rateBps: number } | null;
}

export interface EdgeNetworkBottleneck {
  readonly name: EdgeNetworkBottleneckName;
  readonly links: readonly EdgeNetworkLink[];
}

/** Bytes a link at `rateBps` carries in one application RTT of `profile`. */
export function edgeNetworkLinkBdpBytes(rateBps: number, profile: EdgeNetworkProfile): number {
  return Math.round((rateBps / 8) * (profile.targetRttMs / 1_000));
}

export function edgeNetworkBottleneckLinks(
  name: EdgeNetworkBottleneckName,
  profile: EdgeNetworkProfile,
): EdgeNetworkLink[] {
  const downlink = (
    rateBps: number,
    bufferBytes: number,
    extra: Partial<EdgeNetworkLink> = {},
  ) => ({
    role: 'browser' as const,
    direction: 'down' as const,
    rateBps,
    bufferBytes,
    fq: false,
    step: null,
    ...extra,
  });
  const bdp = (rateBps: number, multiple: number) =>
    Math.round(edgeNetworkLinkBdpBytes(rateBps, profile) * multiple);
  switch (name) {
    case 'uplink-bloat':
      return [
        {
          role: 'daemon',
          direction: 'up',
          rateBps: 10_000_000,
          bufferBytes: 256 * 1024,
          fq: false,
          step: null,
        },
      ];
    case 'downlink-bloat':
      return [downlink(25_000_000, 640_000)];
    case 'downlink-shallow':
      return [downlink(25_000_000, bdp(25_000_000, 0.25))];
    case 'downlink-step':
      return [downlink(25_000_000, 640_000, { step: { afterMarkMs: 2_000, rateBps: 5_000_000 } })];
    case 'downlink-fq':
      return [downlink(50_000_000, 625_000, { fq: true })];
    case 'downlink-bdp':
      return [downlink(25_000_000, bdp(25_000_000, 1))];
    case 'downlink-deep':
      return [downlink(25_000_000, bdp(25_000_000, 4))];
    case 'downlink-half':
      return [downlink(25_000_000, bdp(25_000_000, 0.5))];
    case 'downlink-fast-bdp':
      return [downlink(100_000_000, bdp(100_000_000, 1))];
  }
}

/** The delay proxy's `BOTTLENECK_<ROLE>_<DIRECTION>` value for `link`. */
export function edgeNetworkLinkSpec(link: EdgeNetworkLink): string {
  return (
    `${link.rateBps}:${link.bufferBytes}${link.fq ? ':fq' : ''}` +
    (link.step === null ? '' : `@${link.step.afterMarkMs}=${link.step.rateBps}`)
  );
}

export function edgeNetworkLinkEnvironment(
  links: readonly EdgeNetworkLink[],
): Record<string, string> {
  return Object.fromEntries(
    links.map((link) => [
      `BOTTLENECK_${link.role.toUpperCase()}_${link.direction.toUpperCase()}`,
      edgeNetworkLinkSpec(link),
    ]),
  );
}

const LEGACY_NETWORK_ENVIRONMENT = [
  'EDGE_DELAY_MS',
  'EDGE_LOSS_DENOM',
  'EDGE_LOSS_PHASE',
  'EDGE_REORDER_DENOM',
  'EDGE_SPLIT_ONE_RTT',
  'EDGE_NETWORK_LOSS_PERCENT',
] as const;

const NETWORK_ENVIRONMENT = [
  'EDGE_NETWORK_PROFILE',
  'EDGE_NETWORK_DATAGRAM_LOSS_PERCENT',
  'EDGE_NETWORK_REORDER',
  'EDGE_NETWORK_SCENARIO',
  'EDGE_NETWORK_SEED',
  'EDGE_NETWORK_COMPANION_RTT_MS',
  'EDGE_NETWORK_BOTTLENECK',
  'EDGE_NETWORK_COMPETITOR',
] as const;

export interface EdgeNetworkConfig {
  readonly profile: EdgeNetworkProfile;
  /** Test-only slower companion; never a fourth primary network profile. */
  readonly companionPrimaryProfile: EdgeNetworkProfileName | null;
  /** Exact loss rate at the sole edge-to-client fault site. */
  readonly datagramLossPercent: EdgeNetworkDatagramLossPercent;
  readonly reorder: EdgeNetworkReorderMode;
  readonly scenario: EdgeNetworkScenario;
  readonly seed: number;
  /** Signed jitter on one proxy leg is bounded by this radius. */
  readonly hopJitterRadiusUs: number;
  /** Maximum extra queue/holdback time injected by the selected scenario. */
  readonly maxExtraDelayUs: number;
  /** Wait long enough for pre-reset packets to leave both delayed legs. */
  readonly drainGraceMs: number;
  /** A capacity bottleneck the proxy's links impose, or none. */
  readonly bottleneck: EdgeNetworkBottleneck | null;
  /** A competing bulk flow on that peer's links, or none. */
  readonly competitor: EdgeNetworkCompetitor | null;
}

/**
 * Resolve the one supported network-impairment contract.
 *
 * No profile and no network knobs means the proxy is absent. Supplying any
 * network knob requires a profile, which prevents a typo from silently
 * running a clean loopback measurement.
 */
export function resolveEdgeNetworkConfig(
  environment: Readonly<Record<string, string | undefined>>,
): EdgeNetworkConfig | null {
  for (const legacyName of LEGACY_NETWORK_ENVIRONMENT) {
    if (environment[legacyName] !== undefined) {
      throw new Error(
        `${legacyName} was removed; use EDGE_NETWORK_PROFILE with the exact-rate ` +
          'EDGE_NETWORK_DATAGRAM_LOSS_PERCENT / EDGE_NETWORK_REORDER / EDGE_NETWORK_SCENARIO contract',
      );
    }
  }

  const rawProfile = environment.EDGE_NETWORK_PROFILE;
  if (rawProfile === undefined) {
    const orphan = NETWORK_ENVIRONMENT.find(
      (name) => name !== 'EDGE_NETWORK_PROFILE' && environment[name] !== undefined,
    );
    if (orphan !== undefined) {
      throw new Error(`${orphan} requires EDGE_NETWORK_PROFILE`);
    }
    return null;
  }
  if (!isMember(EDGE_NETWORK_PROFILE_NAMES, rawProfile)) {
    throw new Error(`EDGE_NETWORK_PROFILE must be one of ${EDGE_NETWORK_PROFILE_NAMES.join(', ')}`);
  }

  const baseProfile = EDGE_NETWORK_PROFILES[rawProfile];
  let profile = baseProfile;
  let companionPrimaryProfile: EdgeNetworkProfileName | null = null;
  const rawCompanionRtt = environment.EDGE_NETWORK_COMPANION_RTT_MS;
  if (rawCompanionRtt !== undefined) {
    const primary = environment.DIRECT_NETWORK_PROFILE;
    if (
      environment.FORCE_EDGE !== '0' ||
      primary === undefined ||
      !isMember(EDGE_NETWORK_PROFILE_NAMES, primary)
    ) {
      throw new Error(
        'EDGE_NETWORK_COMPANION_RTT_MS requires FORCE_EDGE=0 and an explicit DIRECT_NETWORK_PROFILE',
      );
    }
    const targetRttMs = Number(rawCompanionRtt);
    if (
      !Number.isSafeInteger(targetRttMs) ||
      targetRttMs <=
        Math.max(baseProfile.targetRttMs, EDGE_NETWORK_PROFILES[primary].targetRttMs) ||
      targetRttMs > 1_000
    ) {
      throw new Error(
        'EDGE_NETWORK_COMPANION_RTT_MS must be an integer above both primary/base RTTs and at most 1000',
      );
    }
    companionPrimaryProfile = primary;
    profile = { ...baseProfile, targetRttMs, hopDelayUs: targetRttMs * 250 };
  }
  const datagramLossPercent = readDatagramLossPercent(
    environment.EDGE_NETWORK_DATAGRAM_LOSS_PERCENT,
  );
  const reorder = readMember(
    'EDGE_NETWORK_REORDER',
    environment.EDGE_NETWORK_REORDER ?? 'none',
    EDGE_NETWORK_REORDER_MODES,
  );
  const scenario = readMember(
    'EDGE_NETWORK_SCENARIO',
    environment.EDGE_NETWORK_SCENARIO ?? 'steady',
    EDGE_NETWORK_SCENARIOS,
  );
  const seed = readSeed(environment.EDGE_NETWORK_SEED);
  const hopJitterRadiusUs = profile.oneWayJitterUs / 4;
  // Reordering holds a selected packet for one full advertised one-way jitter
  // span. Congestion owns a 32 ms hard queue-delay ceiling. The split scenario
  // delays the crypto prefix by one additional base hop.
  const maxExtraDelayUs =
    (reorder === 'none' ? 0 : profile.oneWayJitterUs) +
    (scenario === 'congestion' ? 32_000 : 0) +
    (scenario === 'handshake-split' ? profile.hopDelayUs : 0);
  const maximumHopDelayUs = profile.hopDelayUs + hopJitterRadiusUs + maxExtraDelayUs;
  const rawBottleneck = environment.EDGE_NETWORK_BOTTLENECK;
  const bottleneckName =
    rawBottleneck === undefined
      ? null
      : readMember('EDGE_NETWORK_BOTTLENECK', rawBottleneck, EDGE_NETWORK_BOTTLENECKS);
  const bottleneck =
    bottleneckName === null
      ? null
      : { name: bottleneckName, links: edgeNetworkBottleneckLinks(bottleneckName, profile) };
  const rawCompetitor = environment.EDGE_NETWORK_COMPETITOR;
  const competitor =
    rawCompetitor === undefined
      ? null
      : readMember('EDGE_NETWORK_COMPETITOR', rawCompetitor, EDGE_NETWORK_COMPETITORS);
  if (competitor !== null && !(bottleneck?.links ?? []).some((link) => link.role === competitor)) {
    throw new Error('EDGE_NETWORK_COMPETITOR must share a link of its EDGE_NETWORK_BOTTLENECK');
  }

  return {
    profile,
    companionPrimaryProfile,
    datagramLossPercent,
    reorder,
    scenario,
    seed,
    hopJitterRadiusUs,
    maxExtraDelayUs,
    drainGraceMs: Math.ceil((maximumHopDelayUs * 2) / 1_000) + 10,
    bottleneck,
    competitor,
  };
}

export function edgeNetworkPlaywrightEnvironment(
  config: EdgeNetworkConfig | null,
): Record<string, string> {
  if (config === null) {
    return { EDGE_NETWORK_ACTIVE: '0' };
  }
  return {
    EDGE_NETWORK_ACTIVE: '1',
    EDGE_NETWORK_ROLE: config.companionPrimaryProfile === null ? 'primary' : 'direct-companion',
    ...(config.companionPrimaryProfile === null
      ? {}
      : {
          EDGE_NETWORK_COMPANION_PRIMARY_PROFILE: config.companionPrimaryProfile,
          EDGE_NETWORK_COMPANION_RTT_MS: String(config.profile.targetRttMs),
        }),
    EDGE_NETWORK_PROFILE: config.profile.name,
    EDGE_NETWORK_TARGET_RTT_MS: String(config.profile.targetRttMs),
    EDGE_NETWORK_HOP_DELAY_MS: String(config.profile.hopDelayUs / 1_000),
    EDGE_NETWORK_ONE_WAY_JITTER_MS: String(config.profile.oneWayJitterUs / 1_000),
    EDGE_NETWORK_MAX_EXTRA_DELAY_MS: String(config.maxExtraDelayUs / 1_000),
    EDGE_NETWORK_DATAGRAM_LOSS_PERCENT: String(config.datagramLossPercent),
    EDGE_NETWORK_FAULT_SITE: 'edge-to-client',
    EDGE_NETWORK_FAULT_SITES_PER_LOGICAL_DIRECTION: '1',
    EDGE_NETWORK_REORDER: config.reorder,
    EDGE_NETWORK_SCENARIO: config.scenario,
    EDGE_NETWORK_SEED: String(config.seed),
    EDGE_NETWORK_DRAIN_GRACE_MS: String(config.drainGraceMs),
    ...(config.bottleneck === null
      ? {}
      : {
          EDGE_NETWORK_BOTTLENECK: config.bottleneck.name,
          EDGE_NETWORK_LINKS: JSON.stringify(config.bottleneck.links),
        }),
    ...(config.competitor === null ? {} : { EDGE_NETWORK_COMPETITOR: config.competitor }),
  };
}

function readDatagramLossPercent(raw: string | undefined): EdgeNetworkDatagramLossPercent {
  const value = raw === undefined ? 0 : Number(raw);
  if (!EDGE_NETWORK_DATAGRAM_LOSS_PERCENTAGES.includes(value as EdgeNetworkDatagramLossPercent)) {
    throw new Error(
      `EDGE_NETWORK_DATAGRAM_LOSS_PERCENT must be one of ${EDGE_NETWORK_DATAGRAM_LOSS_PERCENTAGES.join(', ')}`,
    );
  }
  return value as EdgeNetworkDatagramLossPercent;
}

function readSeed(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_EDGE_NETWORK_SEED;
  if (!/^\d+$/.test(raw)) {
    throw new Error('EDGE_NETWORK_SEED must be an unsigned 32-bit integer');
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new Error('EDGE_NETWORK_SEED must be an unsigned 32-bit integer');
  }
  return value;
}

function readMember<const T extends readonly string[]>(
  name: string,
  raw: string,
  values: T,
): T[number] {
  if (!isMember(values, raw)) {
    throw new Error(`${name} must be one of ${values.join(', ')}`);
  }
  return raw;
}

function isMember<const T extends readonly string[]>(values: T, raw: string): raw is T[number] {
  return values.some((value) => value === raw);
}
