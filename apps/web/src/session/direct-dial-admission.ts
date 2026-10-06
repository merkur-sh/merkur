/**
 * How a claimed endpoint's one handshake ended.
 *
 * - `ready`: the handshake succeeded, so the endpoint proved itself on this
 *   network. Whatever later becomes of that connection — a clean close, the
 *   daemon retiring it, its death — is not a failed handshake, and Chromium's
 *   throttle does not charge it either, so the endpoint is dialable again.
 * - `failed`: the handshake failed, or never answered before its race gave
 *   up. The endpoint stays spent for the rest of this network visit.
 * - `unused`: no handshake started; the reservation is simply returned.
 */
export type DirectDialOutcome = 'ready' | 'failed' | 'unused';

export interface DirectDialClaim {
  /** Idempotent: the first outcome decides. */
  settle(outcome: DirectDialOutcome): void;
}

interface NetworkVisit {
  readonly address: string | null;
  readonly reserved: Set<string>;
  readonly failed: Set<string>;
}

/**
 * Owned by the page, across terminal workers and machine switches. Chromium's
 * handshake throttle has that same lifetime and charges failed direct probes
 * against the next relay dial, so a new session is not new path evidence.
 *
 * A visit is one stay on one network, named by the address the edge validated
 * on the active session's committed signaling carrier. Moving to another
 * address starts a new visit in which nothing has failed; returning to an
 * earlier address is a new visit too, because what failed from there before
 * says nothing about now.
 */
export function createDirectDialAdmission() {
  let visit: NetworkVisit = { address: null, reserved: new Set(), failed: new Set() };
  return {
    claim(endpoint: string): DirectDialClaim | null {
      // Captured: a late outcome settles into the visit it was claimed in,
      // never into a newer network's.
      const claimed = visit;
      if (claimed.reserved.has(endpoint) || claimed.failed.has(endpoint)) return null;
      claimed.reserved.add(endpoint);
      let settled = false;
      return {
        settle(outcome: DirectDialOutcome): void {
          if (settled) return;
          settled = true;
          claimed.reserved.delete(endpoint);
          if (outcome === 'failed') claimed.failed.add(endpoint);
        },
      };
    },
    /**
     * The active session's committed carrier proved `address`. Returns whether
     * that began a new visit.
     */
    observePath(address: string): boolean {
      if (visit.address === address) return false;
      visit = { address, reserved: new Set(), failed: new Set() };
      return true;
    },
  };
}
