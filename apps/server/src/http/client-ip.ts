import { isIpAddress } from '@merkur/shared';

const X_FORWARDED_FOR_HEADER = 'x-forwarded-for';
const UNKNOWN_CLIENT_IP = 'unknown';
const IPV6_GROUP_COUNT = 8;
/** The sixth group of `::ffff:a.b.c.d`; the five before it are zero. */
const IPV4_MAPPED_GROUP = 0xffff;

export interface RequestIpSource {
  requestIP(request: Request): { address: string } | null;
}

/**
 * Resolves the client IP that reports which address requested a session, and
 * that `resolveRateLimitSource` keys rate limits from.
 *
 * `X-Forwarded-For` is only consulted when `trustedProxyHops` says how many
 * proxies in front of this server append to it. Each appending hop adds the
 * address it saw, so the entry contributed by the outermost trusted proxy sits
 * `trustedProxyHops` positions from the right; everything to its left is
 * attacker-controlled and is never read. With zero hops the header is ignored
 * outright, because a directly reachable server lets any client forge it and
 * mint a fresh rate-limit key per request.
 *
 * Anything unexpected — a header shorter than the configured hop count, or an
 * entry that is not an IP — falls back to the socket address rather than
 * reaching further left.
 */
export function resolveClientIp(
  request: Request,
  server: RequestIpSource | null,
  trustedProxyHops: number,
): string {
  const forwarded = forwardedClientIp(request, trustedProxyHops);
  if (forwarded !== null) {
    return forwarded;
  }

  const address = server?.requestIP(request)?.address;
  if (address !== undefined && address.length > 0) {
    return address;
  }

  return UNKNOWN_CLIENT_IP;
}

/**
 * The source a per-address rate limit counts against.
 *
 * An IPv4 address is its own source. An IPv6 address is its /64: the low 64
 * bits are the interface identifier, which a host picks for itself, so a key
 * on the whole address hands one subscriber 2^64 budgets. An IPv4-mapped
 * address, which a dual-stack socket reports for an IPv4 peer, is that IPv4
 * address, so one client has one key however its address was resolved.
 */
export function resolveRateLimitSource(
  request: Request,
  server: RequestIpSource | null,
  trustedProxyHops: number,
): string {
  const clientIp = resolveClientIp(request, server, trustedProxyHops);
  if (!clientIp.includes(':') || !isIpAddress(clientIp)) {
    return clientIp;
  }

  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = ipv6Groups(clientIp);
  if ((g0 | g1 | g2 | g3 | g4) === 0 && g5 === IPV4_MAPPED_GROUP) {
    return `${g6 >> 8}.${g6 & 0xff}.${g7 >> 8}.${g7 & 0xff}`;
  }
  return `${g0.toString(16)}:${g1.toString(16)}:${g2.toString(16)}:${g3.toString(16)}::/64`;
}

/** The eight 16-bit groups of an address `isIpAddress` accepted as IPv6. */
function ipv6Groups(address: string): number[] {
  const compression = address.indexOf('::');
  if (compression < 0) {
    return ipv6GroupsOf(address);
  }
  const left = ipv6GroupsOf(address.slice(0, compression));
  const right = ipv6GroupsOf(address.slice(compression + 2));
  const elided = new Array<number>(IPV6_GROUP_COUNT - left.length - right.length).fill(0);
  return [...left, ...elided, ...right];
}

function ipv6GroupsOf(part: string): number[] {
  if (part.length === 0) {
    return [];
  }
  return part.split(':').flatMap((group) => {
    if (!group.includes('.')) {
      return [Number.parseInt(group, 16)];
    }
    const [a = 0, b = 0, c = 0, d = 0] = group.split('.').map(Number);
    return [(a << 8) | b, (c << 8) | d];
  });
}

function forwardedClientIp(request: Request, trustedProxyHops: number): string | null {
  if (trustedProxyHops <= 0) {
    return null;
  }

  const forwardedFor = request.headers.get(X_FORWARDED_FOR_HEADER);
  if (forwardedFor === null) {
    return null;
  }

  const entries = forwardedFor.split(',');
  const candidate = entries[entries.length - trustedProxyHops]?.trim();
  return isIpAddress(candidate) ? candidate : null;
}
