/**
 * How a claimed endpoint's one handshake ended.
 *
 * - `ready`: the handshake succeeded, so the endpoint proved itself on this
 *   network. Whatever later becomes of that connection — a clean close, the
 *   daemon retiring it, its death — is not a failed handshake, and Chromium's
 *   throttle does not charge it either, so the endpoint is dialable again.
 * - `failed`: the native handshake failed. That preparation stays spent for
 *   this network visit; a newly completed router preparation is new evidence.
 * - `unused`: no handshake started; the reservation is simply returned.
 */
export type DirectDialOutcome = 'ready' | 'failed' | 'unused';

export interface DirectDialClaim {
  /** Idempotent: the first outcome decides. */
  settle(outcome: DirectDialOutcome): void;
}

interface NetworkVisit {
  readonly address: string | null;
  readonly reserved: Map<string, Set<(retired?: boolean) => void>>;
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
  let visit: NetworkVisit = { address: null, reserved: new Map(), failed: new Set() };
  function claim(
    claimed: NetworkVisit,
    endpoint: string,
    admission: number,
    signal: AbortSignal,
    receive: (value: DirectDialClaim | null) => void,
  ): void {
    const attempt = JSON.stringify([endpoint, admission]);
    if (signal.aborted || claimed !== visit || claimed.failed.has(attempt)) {
      receive(null);
      return;
    }
    const pending = claimed.reserved.get(endpoint);
    if (pending !== undefined) {
      const wake = (retired = false): void => {
        pending.delete(wake);
        signal.removeEventListener('abort', cancel);
        if (retired) receive(null);
        else claim(claimed, endpoint, admission, signal, receive);
      };
      const cancel = (): void => wake(true);
      pending.add(wake);
      signal.addEventListener('abort', cancel, { once: true });
    } else {
      const waiting = new Set<(retired?: boolean) => void>();
      claimed.reserved.set(endpoint, waiting);
      let settled = false;
      receive({
        settle(outcome: DirectDialOutcome): void {
          if (settled) return;
          settled = true;
          claimed.reserved.delete(endpoint);
          if (outcome === 'failed') claimed.failed.add(attempt);
          for (const wake of waiting) wake();
        },
      });
    }
  }
  return {
    /** A pending native constructor owns the tuple until its actual outcome. */
    claim(
      endpoint: string,
      admission: number,
      signal: AbortSignal,
      receive: (value: DirectDialClaim | null) => void,
    ): void {
      claim(visit, endpoint, admission, signal, receive);
    },
    /**
     * The active session's committed carrier proved `address`. Returns whether
     * that began a new visit.
     */
    observePath(address: string): boolean {
      if (visit.address === address) return false;
      const previous = visit;
      visit = { address, reserved: new Map(), failed: new Set() };
      for (const waiting of previous.reserved.values()) {
        for (const wake of waiting) wake(true);
      }
      return true;
    },
  };
}
