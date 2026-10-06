import { describe, expect, test } from 'bun:test';
import {
  MAX_REBIND_GENERATIONS,
  RACE_DEADLINE_MS,
  REBIND_WINDOW_MS,
  raceGraceMs,
} from './reconnect-policy';

describe('reconnect policy', () => {
  test('race grace window scales with the first handshake, clamped', () => {
    // Floor: LAN handshakes
    expect(raceGraceMs(10)).toBe(80);
    expect(raceGraceMs(26)).toBe(80);
    // Linear region: 3× first handshake
    expect(raceGraceMs(50)).toBe(150);
    expect(raceGraceMs(100)).toBe(300);
    // Ceiling: slow networks
    expect(raceGraceMs(200)).toBe(400);
    expect(raceGraceMs(5_000)).toBe(400);
  });

  test('grace window never exceeds the race deadline', () => {
    expect(raceGraceMs(Number.MAX_SAFE_INTEGER)).toBeLessThan(RACE_DEADLINE_MS);
  });

  test('rebind retention stays well under the parked-peer window', () => {
    const parkedPeerTtlMs = 30 * 60 * 1000; // SessionPolicy::PARKED_PEER_TTL_MS
    expect(REBIND_WINDOW_MS).toBeLessThan(parkedPeerTtlMs / 2);
  });

  test('the rebind window is the same policy on every side', () => {
    // Equality, not ordering: the edge holds a half-paired slot for exactly
    // UNPAIRED_SESSION_TTL and the daemon gives up at REBIND_WINDOW_MS. If
    // these drifted, one side would keep hoping for a rebind after another had
    // already torn its half of the splice down.
    const edgeUnpairedSessionTtlMs = 60_000; // apps/edge/src/splice.rs
    const daemonRebindWindowMs = 60_000; // SessionPolicy::REBIND_WINDOW_MS
    const daemonEdgePreauthLeaseTtlMs = 60_000; // EDGE_PREAUTH_LEASE_TTL_MS
    expect(REBIND_WINDOW_MS).toBe(edgeUnpairedSessionTtlMs);
    expect(REBIND_WINDOW_MS).toBe(daemonRebindWindowMs);
    expect(REBIND_WINDOW_MS).toBe(daemonEdgePreauthLeaseTtlMs);
  });

  test('the browser renews before the native per-epoch generation allowance is spent', () => {
    expect(MAX_REBIND_GENERATIONS).toBe(8); // SessionPolicy::MAX_REBIND_GENERATIONS
  });
});
