import { type Accessor, createSignal } from 'solid-js';

import {
  type BrowserSessionRecord,
  listBrowserSessions,
  type RevocationAuthorization,
  revokeBrowserSession,
  revokeOtherBrowserSessions,
} from '../auth/account-api';
import { type ActiveBrowserAccount, unlockActiveBrowserDelegation } from '../auth/account-workflow';
import { createBrowserRevocation } from '../auth/browser-delegation';

const SERVER_TIME_SNAPSHOT_MAX_AGE_MS = 20_000;

interface ServerTimeSnapshot {
  readonly serverTimeMs: number;
  readonly monotonicTimeMs: number;
}

export interface BrowserSessionsController {
  readonly error: Accessor<string>;
  readonly pending: Accessor<boolean>;
  readonly sessions: Accessor<BrowserSessionRecord[]>;
  load(): Promise<void>;
  revoke(delegationId: string): Promise<void>;
  revokeOthers(): Promise<void>;
  reset(): void;
}

export function createBrowserSessionsController(options: {
  getAccount(): ActiveBrowserAccount | null;
  /**
   * Run one request with the account's live access token, refreshing it once on
   * a definitive 401. The token is not read from the account snapshot: it
   * rotates underneath it every access-token lifetime, and a Sessions tab
   * opened after the first rotation would otherwise present an expired one.
   */
  authorize<T>(signal: AbortSignal, request: (accessToken: string) => Promise<T>): Promise<T>;
}): BrowserSessionsController {
  const [error, setError] = createSignal('');
  const [pending, setPending] = createSignal(false);
  const [sessions, setSessions] = createSignal<BrowserSessionRecord[]>([]);
  let serverTimeSnapshot: ServerTimeSnapshot | null = null;
  // `load()` refreshes the list mid-mutation and the revoke paths read it back
  // in the same tick. Solid 2 only makes a write visible to `sessions()` after
  // the next flush, so the plain mirror carries the synchronous truth.
  let currentSessions: BrowserSessionRecord[] = [];
  /**
   * Everything in flight belongs to one account lifetime, and `reset` ends it:
   * aborting the controller cancels its requests, and a new one means an answer
   * that still lands cannot publish one account's sessions into the next.
   */
  let lifetime = new AbortController();
  let loadsInFlight = 0;
  let mutationInFlight = false;
  /**
   * Loads overlap — an arrival on the tab, a `sessions-changed` frame, a
   * mutation's own re-read — and answer in any order. Only the newest request
   * describes the list; an older answer landing after it would roll it back.
   */
  let latestLoad = 0;

  function publishSessions(next: BrowserSessionRecord[]): void {
    currentSessions = next;
    setSessions(next);
  }

  function publishPending(): void {
    setPending(loadsInFlight > 0 || mutationInFlight);
  }

  async function load(): Promise<void> {
    requireAccount();
    const owner = lifetime;
    const request = ++latestLoad;
    loadsInFlight += 1;
    publishPending();
    try {
      const response = await options.authorize(owner.signal, (token) =>
        listBrowserSessions(token, owner.signal),
      );
      if (owner !== lifetime) return;
      // Every answer is a valid clock sample at its own receipt, whatever its
      // place in the order, so the revoke paths may sign against any of them.
      serverTimeSnapshot = {
        serverTimeMs: response.serverTimeMs,
        monotonicTimeMs: performance.now(),
      };
      if (request !== latestLoad) return;
      publishSessions(response.sessions);
      setError('');
    } catch (cause) {
      if (owner === lifetime && request === latestLoad) {
        setError('Unable to load browser sessions.');
      }
      throw cause;
    } finally {
      if (owner === lifetime) {
        loadsInFlight -= 1;
        publishPending();
      }
    }
  }

  async function revoke(delegationId: string): Promise<void> {
    await mutate('Unable to revoke that browser session.', async (account, signal) => {
      const target = currentSessions.find((session) => session.delegationId === delegationId);
      if (target === undefined || target.current || target.revokedAt !== null) return false;
      const authorization = await authorizeTargets(account, [target]);
      await options.authorize(signal, (token) =>
        revokeBrowserSession(token, delegationId, authorization, signal),
      );
      return true;
    });
  }

  async function revokeOthers(): Promise<void> {
    await mutate('Unable to revoke other browser sessions.', async (account, signal) => {
      const targets = currentSessions.filter(
        (session) => !session.current && session.revokedAt === null,
      );
      if (targets.length === 0) return false;
      const authorization = await authorizeTargets(account, targets);
      await options.authorize(signal, (token) =>
        revokeOtherBrowserSessions(token, authorization, signal),
      );
      return true;
    });
  }

  /**
   * One revocation at a time, signed against a fresh server clock and followed
   * by a re-read. `run` answers whether it changed anything worth re-reading.
   */
  async function mutate(
    failure: string,
    run: (account: ActiveBrowserAccount, signal: AbortSignal) => Promise<boolean>,
  ): Promise<void> {
    if (mutationInFlight) return;
    const owner = lifetime;
    mutationInFlight = true;
    publishPending();
    setError('');
    try {
      const account = requireAccount();
      await ensureFreshServerTime();
      if (await run(account, owner.signal)) await load();
    } catch (cause) {
      if (owner === lifetime) setError(failure);
      throw cause;
    } finally {
      if (owner === lifetime) {
        mutationInFlight = false;
        publishPending();
      }
    }
  }

  async function authorizeTargets(
    account: ActiveBrowserAccount,
    targets: readonly BrowserSessionRecord[],
  ): Promise<RevocationAuthorization> {
    const issuedAt = currentServerTime();
    const unlocked = await unlockActiveBrowserDelegation(account);
    try {
      return {
        actorCertificate: unlocked.certificate,
        revocation: createBrowserRevocation(
          {
            certificate: unlocked.certificate,
            delegateSeed: unlocked.delegateSeed,
          },
          targets.map((target) => ({
            delegationId: target.delegationId,
            expiresAt: target.expiresAt,
          })),
          issuedAt,
        ),
      };
    } finally {
      unlocked.delegateSeed.fill(0);
      unlocked.rootPublicKey.fill(0);
    }
  }

  async function ensureFreshServerTime(): Promise<void> {
    const snapshot = serverTimeSnapshot;
    if (snapshot === null) {
      await load();
      return;
    }
    const ageMs = performance.now() - snapshot.monotonicTimeMs;
    if (ageMs < 0 || ageMs > SERVER_TIME_SNAPSHOT_MAX_AGE_MS) await load();
  }

  function currentServerTime(): number {
    const snapshot = serverTimeSnapshot;
    if (snapshot === null) throw new Error('Browser-session server time is unavailable');
    const elapsedMs = performance.now() - snapshot.monotonicTimeMs;
    if (elapsedMs < 0 || elapsedMs > SERVER_TIME_SNAPSHOT_MAX_AGE_MS) {
      throw new Error('Browser-session server time is stale');
    }
    return Math.round(snapshot.serverTimeMs + elapsedMs);
  }

  function requireAccount(): ActiveBrowserAccount {
    const account = options.getAccount();
    if (account === null) throw new Error('No active browser account');
    return account;
  }

  function reset(): void {
    lifetime.abort();
    lifetime = new AbortController();
    loadsInFlight = 0;
    mutationInFlight = false;
    serverTimeSnapshot = null;
    publishSessions([]);
    setError('');
    setPending(false);
  }

  return { error, pending, sessions, load, revoke, revokeOthers, reset };
}
