import type { EdgeRegistration } from './edge-registry-service';
import { type IpZone, zoneForEdgeRegion, zoneForIp, zonesByProximity } from './ip-region';

/**
 * Pick the edge that carries this session, nearest the daemon first.
 *
 * The edge sits between the browser and the daemon, so total path length is
 * browser-to-edge plus edge-to-daemon. Selection is anchored on the daemon and
 * only tie-broken toward the browser, because the daemon is the end that cannot
 * move: a browser can be anywhere and changes between sessions, while a daemon
 * sits on one network for its whole life, and every session for that daemon
 * pays whatever distance is chosen here.
 *
 * Determinism matters as much as proximity, and it is anchored on the daemon
 * for the same reason the proximity is. Every step is a pure function of the
 * inputs, and the final tie-break is `FNV-1a(daemonId)` — deliberately NOT the
 * session id. A session id does not exist until the server mints one, so a
 * browser cannot predict where it will be sent and cannot pre-dial the edge
 * while issuance is still in flight; keyed on the daemon, every session for one
 * machine lands on the same replica and the dial can overlap the request that
 * authorizes it. It also means a browser's cached coordinates are a near
 * certainty rather than a coin flip once a zone holds more than one edge.
 *
 * The trade, stated because it is real: a retry for the same daemon now
 * re-lands on the same replica rather than re-rolling. Escaping a broken edge
 * is the registry's job: one that stops heartbeating leaves the healthy list
 * the caller passes, which is the correct mechanism for it — a coin flip was
 * never one.
 *
 * Selection is a comparison over a handful of registrations already held in
 * memory — the zone was resolved once at the daemon's control upgrade and
 * stored on its presence record, which this request reads anyway. It adds no
 * I/O to `POST /api/sessions/request` and so gets no `Server-Timing` stage of
 * its own; `edgeLookupMs` still covers the registry read that precedes it.
 */
export function selectEdge(
  registrations: readonly EdgeRegistration[],
  daemonId: string,
  daemonZone: IpZone | null,
  browserIp: string | null,
): EdgeRegistration | null {
  if (registrations.length === 0) return null;
  const sorted = [...registrations].sort((left, right) => left.edgeId.localeCompare(right.edgeId));

  const browserZone = browserIp === null ? null : zoneForIp(browserIp);
  let candidates = narrowByZone(sorted, daemonZone);
  // Among edges equally distant from the daemon, prefer the one nearest the
  // browser. With a single edge per zone this never fires; it is what makes a
  // second edge in an existing zone useful rather than arbitrary.
  candidates = narrowByZone(candidates, browserZone);

  let hash = 2_166_136_261;
  for (let index = 0; index < daemonId.length; index += 1) {
    hash ^= daemonId.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return candidates[(hash >>> 0) % candidates.length] ?? null;
}

/**
 * Keep only the edges tied for nearest to `origin`, preserving order.
 *
 * Returns the input untouched when `origin` is unknown or when no edge has a
 * mapped region — both mean "no opinion", and narrowing to an empty set would
 * turn a missing region code into an outage. Edges whose region does not map
 * are dropped only when at least one other edge does map, so an unrecognised
 * region loses a preference contest rather than winning one by default.
 */
function narrowByZone(
  edges: readonly EdgeRegistration[],
  origin: IpZone | null,
): readonly EdgeRegistration[] {
  if (origin === null || edges.length <= 1) return edges;
  const order = zonesByProximity(origin);
  let bestRank = Number.MAX_SAFE_INTEGER;
  let best: EdgeRegistration[] = [];
  for (const edge of edges) {
    const zone = zoneForEdgeRegion(edge.edgeRegion);
    if (zone === null) continue;
    const rank = order.indexOf(zone);
    if (rank < bestRank) {
      bestRank = rank;
      best = [edge];
    } else if (rank === bestRank) {
      best.push(edge);
    }
  }
  return best.length === 0 ? edges : best;
}
