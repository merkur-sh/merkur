/**
 * Coarse IP -> geographic zone resolution, used to place a session on the edge
 * nearest the daemon.
 *
 * # Why zones and not cities
 *
 * The only decision this feeds is "which of our two or three edges should carry
 * this session". At that granularity a city-accurate GeoIP database buys
 * nothing over a continent-accurate one, and costs a multi-megabyte dataset
 * that goes stale, needs licensing, and turns a pure in-memory comparison on
 * the session-request path into a lookup. RIR delegation is continent-accurate,
 * fits in a 256-character string, and never changes now that the IPv4 free pool
 * is exhausted.
 *
 * # Known imprecision
 *
 * RIPE covers Europe, the Middle East, and Central Asia; APNIC covers Asia and
 * Oceania. A Dubai address therefore resolves to `eu` and a Sydney address to
 * `apac`. Both are the right answer for edge selection and the wrong answer for
 * anything else, which is why this module is not exported as a general-purpose
 * geolocator. It is also not a privacy boundary: it is consulted at the daemon
 * control upgrade and only the resulting zone is stored, never the address.
 */

import { IPV4_ZONE_TABLE } from './ip-region-table.generated';

/**
 * The zones the RIR data can actually distinguish.
 *
 * Deliberately not a continent list. There is no `oc` because APNIC does not
 * separate Oceania from Asia, and inventing the distinction would mean claiming
 * a resolution the underlying data does not have.
 */
export const IP_ZONES = ['na', 'sa', 'eu', 'af', 'apac'] as const;
export type IpZone = (typeof IP_ZONES)[number];

/** Packed table letters -> zone. `?` marks reserved and special-use space. */
const ZONE_BY_LETTER: Readonly<Record<string, IpZone>> = {
  n: 'na',
  s: 'sa',
  e: 'eu',
  f: 'af',
  a: 'apac',
};

/**
 * Top-level IPv6 unicast delegations, RFC-stable and short enough to state.
 *
 * IANA hands each RIR a /12 out of 2000::/3, so twelve bits answer the question
 * outright — except inside 2000::/16, where the early allocations predate that
 * scheme. `2001::/16` is sub-delegated to every RIR in /23 chunks and `2002::/16`
 * is 6to4, so neither carries a zone at /12 resolution and both must resolve to
 * unknown rather than to whichever RIR happens to sort first.
 */
const IPV6_ZONE_BY_SLASH12: ReadonlyArray<readonly [string, IpZone]> = [
  ['2a0', 'eu'], // 2a00::/12 RIPE NCC
  ['260', 'na'], // 2600::/12 ARIN
  ['261', 'na'], // 2610::/12 ARIN
  ['262', 'na'], // 2620::/12 ARIN
  ['240', 'apac'], // 2400::/12 APNIC
  ['280', 'sa'], // 2800::/12 LACNIC
  ['2c0', 'af'], // 2c00::/12 AFRINIC
];

/**
 * Exceptions inside 2000::/16, matched before the /12 table.
 *
 * `2003::/16` is a single RIPE delegation large enough to be worth naming — it
 * is Deutsche Telekom's residential IPv6 space, so it is exactly the population
 * this feature exists to route well.
 */
const IPV6_ZONE_BY_SLASH16: Readonly<Record<string, IpZone>> = {
  '2003': 'eu',
};

/**
 * Preference order when no edge sits in the resolved zone.
 *
 * Equality alone would send a South American daemon to whichever edge won a
 * hash, so each zone carries a full ordering and selection walks it. The
 * orderings are coarse by construction and two of them are judgement calls
 * worth naming: `apac` prefers North America over Europe because the Pacific
 * rim dominates APNIC traffic and Tokyo-to-California is roughly half
 * Tokyo-to-Frankfurt, though the call inverts for India and South East Asia;
 * `af` prefers Europe because almost all African transit lands there anyway.
 */
const ZONE_PREFERENCE: Readonly<Record<IpZone, readonly IpZone[]>> = {
  na: ['na', 'sa', 'eu', 'apac', 'af'],
  sa: ['sa', 'na', 'eu', 'af', 'apac'],
  eu: ['eu', 'af', 'na', 'apac', 'sa'],
  af: ['af', 'eu', 'na', 'apac', 'sa'],
  apac: ['apac', 'na', 'eu', 'af', 'sa'],
};

/**
 * Zone for each Fly region code, since edges report their Fly region verbatim.
 *
 * An unlisted region resolves to `null`, which makes selection fall back to the
 * deterministic hash rather than guess. That is the safe direction: a wrong
 * zone silently routes every session in a continent to the far edge, while an
 * absent one only forfeits the improvement.
 */
const ZONE_BY_FLY_REGION: Readonly<Record<string, IpZone>> = {
  ams: 'eu',
  arn: 'eu',
  atl: 'na',
  bog: 'sa',
  bom: 'apac',
  bos: 'na',
  cdg: 'eu',
  den: 'na',
  dfw: 'na',
  ewr: 'na',
  eze: 'sa',
  fra: 'eu',
  gdl: 'na',
  gig: 'sa',
  gru: 'sa',
  hkg: 'apac',
  iad: 'na',
  jnb: 'af',
  lax: 'na',
  lhr: 'eu',
  mad: 'eu',
  mia: 'na',
  nrt: 'apac',
  ord: 'na',
  otp: 'eu',
  phx: 'na',
  qro: 'na',
  scl: 'sa',
  sea: 'na',
  sin: 'apac',
  sjc: 'na',
  syd: 'apac',
  waw: 'eu',
  yul: 'na',
  yyz: 'na',
};

/** Zone for a Fly region code, or `null` when the region is not mapped. */
export function zoneForEdgeRegion(region: string): IpZone | null {
  return ZONE_BY_FLY_REGION[region.toLowerCase()] ?? null;
}

/**
 * Zone for a client address, or `null` when it cannot be placed.
 *
 * Returns `null` for private, loopback, link-local, and reserved space rather
 * than guessing. A daemon behind a NAT presents its public address here, so
 * private input means the address never left the host and carries no location.
 */
export function zoneForIp(ip: string): IpZone | null {
  if (ip.includes(':')) return zoneForIpv6(ip);
  return zoneForIpv4(ip);
}

/**
 * Special-purpose IPv4 space (RFC 6890) as `[network, prefix length]`.
 *
 * The generated /8 table cannot express these: `172.16/12`, `192.168/16`, and
 * `169.254/16` all sit inside /8s that IANA delegates to ARIN, so a first-octet
 * lookup places a machine on a private network in North America. That is not a
 * cosmetic miss — a daemon whose resolved address is private has told us
 * nothing about where it is, and answering `na` would pin it to an edge on the
 * strength of a number that never left its own LAN.
 *
 * `10/8`, `127/8`, `224/4`, and `240/4` are already RESERVED in the registry
 * and would resolve to unknown anyway; they are listed for completeness so this
 * table can be read as the whole answer rather than half of it.
 */
const IPV4_SPECIAL_USE: ReadonlyArray<readonly [string, number]> = [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8], // RFC1918
  ['100.64.0.0', 10], // RFC6598 CGNAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local
  ['172.16.0.0', 12], // RFC1918
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // TEST-NET-1
  ['192.88.99.0', 24], // 6to4 relay anycast
  ['192.168.0.0', 16], // RFC1918
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // TEST-NET-2
  ['203.0.113.0', 24], // TEST-NET-3
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, includes broadcast
];

/** Parse dotted-quad into a 32-bit value, rejecting anything malformed. */
function parseIpv4(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    // `Number.parseInt` would accept "1abc" and "" would become NaN only after
    // the fact; require the field to be digits and nothing else.
    if (part.length === 0 || part.length > 3 || !/^\d+$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value;
}

const SPECIAL_USE_RANGES: ReadonlyArray<readonly [number, number]> = IPV4_SPECIAL_USE.map(
  ([network, prefixLength]) => {
    const base = parseIpv4(network);
    if (base === null) throw new Error(`unparseable special-use network: ${network}`);
    // Every bitwise operator here works on a signed 32-bit value, so both the
    // mask and the masked network need `>>> 0` to come back as the unsigned
    // number the comparison uses. Omitting it on the network side silently
    // breaks every range at or above 128.0.0.0 — which is all of RFC1918 except
    // 10/8 — while leaving the low ranges working, so the bug looks like a
    // missing table entry rather than an arithmetic one.
    const mask = (0xffff_ffff << (32 - prefixLength)) >>> 0;
    return [(base & mask) >>> 0, mask] as const;
  },
);

function zoneForIpv4(ip: string): IpZone | null {
  const value = parseIpv4(ip);
  if (value === null) return null;
  for (const [network, mask] of SPECIAL_USE_RANGES) {
    if ((value & mask) >>> 0 === network) return null;
  }
  const letter = IPV4_ZONE_TABLE[value >>> 24];
  if (letter === undefined) return null;
  return ZONE_BY_LETTER[letter] ?? null;
}

function zoneForIpv6(ip: string): IpZone | null {
  // IPv4-mapped and IPv4-compatible forms carry a v4 address in the tail; the
  // v6 prefix of such an address describes the encoding, not the holder.
  const lastColon = ip.lastIndexOf(':');
  const tail = ip.slice(lastColon + 1);
  if (tail.includes('.')) return zoneForIpv4(tail);

  const head = ip.slice(0, ip.indexOf(':')).toLowerCase();
  if (head.length === 0) return null; // `::1` and friends: no global prefix.
  const group = head.padStart(4, '0');
  const exception = IPV6_ZONE_BY_SLASH16[group];
  if (exception !== undefined) return exception;
  const slash12 = group.slice(0, 3);
  for (const [prefix, zone] of IPV6_ZONE_BY_SLASH12) {
    if (slash12 === prefix) return zone;
  }
  return null;
}

/**
 * Order `zones` by proximity to `origin`, nearest first.
 *
 * Zones absent from the preference ordering are dropped rather than appended:
 * every zone appears in every ordering by construction, so a missing one means
 * the caller passed something that is not an `IpZone`.
 */
export function zonesByProximity(origin: IpZone): readonly IpZone[] {
  return ZONE_PREFERENCE[origin];
}
