import { describe, expect, test } from 'bun:test';

import type { EdgeRegistration } from './edge-registry-service';
import { selectEdge } from './edge-selection';
import { IP_ZONES, type IpZone } from './ip-region';

function edge(edgeId: string, edgeRegion: string): EdgeRegistration {
  return {
    edgeId,
    edgeRegion,
    edgeWtUrl: `https://${edgeId}.edge.example:4433/`,
    activeCertHash: `${edgeId}-cert`,
    certHashes: [`${edgeId}-cert`],
    updatedAt: 1,
  };
}

const FRA = edge('fra-1', 'fra'); // eu
const IAD = edge('iad-1', 'iad'); // na
const SYD = edge('syd-1', 'syd'); // apac
const GRU = edge('gru-1', 'gru'); // sa

/** One representative public address per zone, taken from the pinned vectors. */
const ADDRESS_IN: Readonly<Record<IpZone, string>> = {
  na: '8.8.8.8',
  sa: '200.3.14.10',
  eu: '193.0.6.139',
  af: '196.216.2.1',
  apac: '1.1.1.1',
};

describe('daemon-anchored selection', () => {
  /**
   * The property the speculative cold-connect dial rests on. A session id does
   * not exist when the browser must start dialling, so if the tie-break were
   * keyed on it the browser could not know where it was going; keyed on the
   * daemon, a cached (daemonId -> edge) entry is a near certainty and the dial
   * can overlap issuance.
   */
  test('every session for one daemon lands on the same edge', () => {
    // Two edges in one zone, so the hash tie-break is what decides.
    const edges = [FRA, edge('fra-2', 'fra')];
    const first = selectEdge(edges, 'daemon-a', 'eu', null)?.edgeId;
    expect(first).toBeDefined();
    for (let index = 0; index < 32; index += 1) {
      expect(selectEdge(edges, 'daemon-a', 'eu', null)?.edgeId).toBe(first as string);
    }
  });

  test('distinct daemons still spread across edges in one zone', () => {
    const edges = [FRA, edge('fra-2', 'fra')];
    const chosen = new Set<string>();
    for (let index = 0; index < 64; index += 1) {
      const selected = selectEdge(edges, `daemon-${index}`, 'eu', null)?.edgeId;
      if (selected !== undefined) chosen.add(selected);
    }
    expect(chosen.size, 'a daemon-keyed hash must still use both replicas').toBe(2);
  });

  test('a daemon is placed on the edge in its own zone', () => {
    const edges = [FRA, IAD];
    expect(selectEdge(edges, 'session-a', 'eu', null)?.edgeId).toBe('fra-1');
    expect(selectEdge(edges, 'session-a', 'na', null)?.edgeId).toBe('iad-1');
  });

  /**
   * The improvement this phase exists for. Before, a European daemon had a 50%
   * chance of every one of its sessions crossing the Atlantic twice.
   */
  test('zone beats the hash for every session key', () => {
    const edges = [FRA, IAD];
    for (let index = 0; index < 200; index += 1) {
      expect(selectEdge(edges, `session-${index}`, 'eu', null)?.edgeId).toBe('fra-1');
    }
  });

  /**
   * With no edge in the daemon's own zone, selection walks the proximity order
   * rather than giving up. An African daemon reaches Frankfurt, not Virginia.
   */
  test('a daemon with no local edge takes the nearest one', () => {
    expect(selectEdge([FRA, IAD], 'k', 'af', null)?.edgeId).toBe('fra-1');
    expect(selectEdge([FRA, IAD], 'k', 'sa', null)?.edgeId).toBe('iad-1');
    expect(selectEdge([FRA, IAD], 'k', 'apac', null)?.edgeId).toBe('iad-1');
    // North America reaches Europe before Asia-Pacific: `na` ranks eu third and
    // apac fourth, and Frankfurt really is the shorter hop from most of the US.
    expect(selectEdge([FRA, SYD], 'k', 'na', null)?.edgeId).toBe('fra-1');
    expect(selectEdge([FRA, GRU], 'k', 'apac', null)?.edgeId).toBe('fra-1');
  });
});

describe('browser tie-break', () => {
  /**
   * The browser only breaks ties. It must never pull a session away from the
   * edge nearest the daemon, because the daemon pays that distance on every
   * session while the browser's position changes between them.
   */
  test('the browser does not override the daemon anchor', () => {
    const chosen = selectEdge([FRA, IAD], 'k', 'eu', ADDRESS_IN.na);
    expect(chosen?.edgeId).toBe('fra-1');
  });

  /**
   * Two edges tied for nearest to the daemon is exactly when the browser gets a
   * say — and is what makes adding a second edge inside an existing zone worth
   * doing rather than arbitrary.
   */
  test('among edges tied for the daemon, the browser decides', () => {
    // Both are `na`, so the daemon cannot separate them.
    const iadAndSjc = [IAD, edge('sjc-1', 'sjc')];
    // A browser in apac ranks `na` edges equally too, so this still ties and
    // falls to the hash; the meaningful case needs edges in different zones
    // that are equidistant from the daemon, which `na` -> [sa, eu] provides.
    const saAndEu = [GRU, FRA];
    const viaEurope = selectEdge(saAndEu, 'k', null, ADDRESS_IN.eu);
    const viaBrazil = selectEdge(saAndEu, 'k', null, ADDRESS_IN.sa);
    expect(viaEurope?.edgeId).toBe('fra-1');
    expect(viaBrazil?.edgeId).toBe('gru-1');
    // Sanity: the tied-in-zone pair really does tie and stays deterministic.
    expect(selectEdge(iadAndSjc, 'k', 'na', ADDRESS_IN.na)?.edgeId).toBe(
      selectEdge(iadAndSjc, 'k', 'na', ADDRESS_IN.na)?.edgeId,
    );
  });

  test('an unplaceable browser address is simply no opinion', () => {
    expect(selectEdge([FRA, IAD], 'k', 'eu', '10.0.0.1')?.edgeId).toBe('fra-1');
    expect(selectEdge([FRA, IAD], 'k', 'eu', 'not-an-ip')?.edgeId).toBe('fra-1');
  });
});

describe('fallbacks', () => {
  test('no registrations yield null', () => {
    expect(selectEdge([], 'k', 'eu', null)).toBeNull();
  });

  /**
   * An unmapped region must not win by default. Selection prefers any edge it
   * can place over one it cannot, and only falls back to the hash when it can
   * place none of them.
   */
  test('an unmapped edge region loses to a mapped one', () => {
    const mystery = edge('aaa-1', 'zzz');
    expect(selectEdge([mystery, FRA], 'k', 'eu', null)?.edgeId).toBe('fra-1');
    expect(selectEdge([mystery, IAD], 'k', 'eu', null)?.edgeId).toBe('iad-1');
  });

  test('when nothing can be placed, the deterministic hash still decides', () => {
    const unmapped = [edge('aaa-1', 'zzz'), edge('bbb-1', 'yyy')];
    const first = selectEdge(unmapped, 'session-x', 'eu', null);
    expect(first).not.toBeNull();
    expect(selectEdge(unmapped, 'session-x', 'eu', null)?.edgeId).toBe(first?.edgeId);
    // An unknown daemon zone with mapped edges is the same "no opinion" case.
    const both = selectEdge([FRA, IAD], 'session-x', null, null);
    expect(both).not.toBeNull();
  });
});

describe('determinism and totality', () => {
  const FLEETS: ReadonlyArray<readonly EdgeRegistration[]> = [
    [FRA],
    [IAD],
    [FRA, IAD],
    [FRA, IAD, SYD],
    [FRA, IAD, SYD, GRU],
    [FRA, edge('aaa-1', 'zzz')],
  ];

  /**
   * Exhaustive over (daemon zone x browser zone x fleet), including unknowns.
   * A session that changed edges mid-flight would leave the daemon dialling one
   * relay while the browser dialled another, so this is a correctness property,
   * not a style preference.
   */
  test('selection is a pure function of its inputs', () => {
    const daemonZones: ReadonlyArray<IpZone | null> = [...IP_ZONES, null];
    const browserAddresses: ReadonlyArray<string | null> = [
      ...IP_ZONES.map((zone) => ADDRESS_IN[zone]),
      null,
    ];
    let cases = 0;
    for (const fleet of FLEETS) {
      for (const daemonZone of daemonZones) {
        for (const browserIp of browserAddresses) {
          const first = selectEdge(fleet, 'session-fixed', daemonZone, browserIp);
          expect(first).not.toBeNull();
          for (let repeat = 0; repeat < 3; repeat += 1) {
            expect(selectEdge(fleet, 'session-fixed', daemonZone, browserIp)?.edgeId).toBe(
              first?.edgeId,
            );
          }
          // Whatever is chosen must be a real member of the fleet.
          expect(fleet.some((candidate) => candidate.edgeId === first?.edgeId)).toBe(true);
          cases += 1;
        }
      }
    }
    expect(cases).toBe(FLEETS.length * daemonZones.length * browserAddresses.length);
  });

  /**
   * Registration order comes from Redis and is not guaranteed. If it leaked
   * into the result, two server instances could answer differently for the
   * same session.
   */
  test('registration order does not change the outcome', () => {
    const daemonZones: ReadonlyArray<IpZone | null> = [...IP_ZONES, null];
    for (const daemonZone of daemonZones) {
      const forward = selectEdge([FRA, IAD, SYD, GRU], 'session-fixed', daemonZone, null);
      const reversed = selectEdge([GRU, SYD, IAD, FRA], 'session-fixed', daemonZone, null);
      expect(reversed?.edgeId).toBe(forward?.edgeId);
    }
  });
});
