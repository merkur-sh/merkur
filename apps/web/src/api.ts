import { treaty } from '@elysia/eden';
import { defineDatabase, keyedStore, withDatabase } from '@merkur/browser-storage';
import type { App } from '@merkur/server';
import {
  type AccountKeyboardSettings,
  type BrowserErrorReportBody,
  type BrowserStorageReportBody,
  type BrowserUpgradeReport,
  type DeviceLinkTokenResponse,
  isAccountKeyboardSettings,
  isDeviceLinkTokenResponse,
  mintTraceparent,
  TERMINAL_KEYBOARD_LAYER_IDS,
} from '@merkur/shared';
import {
  AccountTelemetry,
  BoxAccessResponse,
  BoxCreatedResponse,
  PushVapidPublicKeyResponse,
  ReleaseResponse,
} from '@merkur/shared/api-schema';
import { compileCheck, compileRequire } from '@merkur/shared/schema-check';
import { Effect } from 'effect';
import {
  type AccountSessionResponse,
  changeAccountPasswordRequest,
  refreshAccountSession,
  withAccountCookieLock,
} from './auth/account-api';
import { ApiError } from './lib/api-error';
import { STORAGE_NAMES } from './lib/storage-names';
import type { BrowserLinkReportBody } from './perf/telemetry-reporter';
import {
  parseSessionRenewResponse,
  parseSessionRequestResponse,
  type SessionRequestResponse,
} from './session/session-response';
import type { RenewSessionRequest, RenewSessionResult } from './transport-worker-protocol';

export { isApiError } from './lib/api-error';
export type { SessionRequestResponse } from './session/session-response';

const JSON_CONTENT_TYPE = 'application/json';

const api = treaty<App>(globalThis.location.origin, {
  fetch: {
    credentials: 'include',
  },
});

export type LoginResponse = AccountSessionResponse;
export type LinkTokenResponse = DeviceLinkTokenResponse;

export type { PushVapidPublicKeyResponse } from '@merkur/shared/api-schema';

const isRelease = compileCheck(ReleaseResponse);

const asCreatedBox = compileRequire(BoxCreatedResponse, 'Invalid box creation response');

const asAccountTelemetry = compileRequire(AccountTelemetry, 'Invalid account telemetry response');

const asBoxAccess = compileRequire(BoxAccessResponse, 'Invalid box access response');

const isPushVapidPublicKey = compileCheck(PushVapidPublicKeyResponse);

export interface PushSubscriptionPayload {
  readonly endpoint: string;
  readonly keys: {
    readonly p256dh: string;
    readonly auth: string;
  };
}

interface EdenErrorLike {
  readonly status: unknown;
  readonly value: unknown;
}

interface EdenResult<A> {
  readonly data: A | null;
  readonly error: EdenErrorLike | null;
}

let refreshPromise: Promise<LoginResponse | null> | null = null;

// iOS standalone PWAs can cold-launch into a state where fetch stalls while the
// page is still waking. Bound the rotating refresh-token mutation so boot can
// never hang on the splash screen. Do not retry an ambiguous timeout/network
// failure: the server may already have rotated the one-use token and a repeated
// request would present the now-revoked cookie.
const REFRESH_TIMEOUT = '4 seconds';

/**
 * Set once a refresh stops proving that the origin still holds a live
 * credential.
 *
 * The server grants no grace for a spent refresh token: presenting one revokes
 * the whole chain. A refresh that times out, fails the network, or errors may
 * already have rotated server-side with the `Set-Cookie` lost, which leaves the
 * cookie jar holding a spent token. Re-presenting it would be indistinguishable
 * from a replay, so the credential is retired and the session ends in a
 * re-login instead of a revocation.
 *
 * Retirement is origin-wide, because the cookie is. One IndexedDB record,
 * {@link refreshCredential}, carries it to every tab on the origin, including
 * ones opened after the failure. Not `localStorage`: Firefox gives each tab its
 * own snapshot of it, so a tab that took the lock after another retired the
 * credential could still read it live (`@merkur/browser-storage` measured the
 * lost update). An IndexedDB write that completed before the lock was released
 * is what every later transaction in every tab reads.
 *
 * It is recorded as the *generation* it applies to rather than as a boolean.
 * Sign-in increments the generation, so a refresh that captured
 * an older generation and only fails afterwards writes a value that no longer
 * matches, and is inert. That is what keeps a tab whose refresh timed out from
 * retiring the brand-new chain another tab just signed in for. Authentication
 * finish holds the same lock only during cookie delivery; password stretching
 * stays outside the lock.
 *
 * Both the read and the write happen inside the lock callback. Web Locks
 * releases the lock when that callback's promise settles, so retiring from the
 * surrounding `.then`/`.catch` would let a waiting tab read the flag before it
 * was written. {@link withRefreshCredentialLock} is what enforces that: the
 * writer exists only as a closure it passes in, so there is nothing to call
 * from outside the locked region.
 *
 * Persisting costs one property: a reload used to heal a purely client-side
 * stall by retrying. Now the first stalled cold launch — the case
 * {@link REFRESH_TIMEOUT} exists for — retires the credential for good and costs
 * a password prompt even though nothing was spent. That is accepted
 * deliberately: a false `refresh_token_reuse_detected` is more expensive than a
 * sign-in, and the app is already showing the login form at that point.
 */
const FIRST_GENERATION = 0;

interface RefreshCredentialState {
  /** Counts sign-ins on this origin; a retirement applies to one generation only. */
  readonly generation: number;
  readonly retired: boolean;
}

const INITIAL_CREDENTIAL: RefreshCredentialState = { generation: FIRST_GENERATION, retired: false };

const refreshCredential = defineDatabase(STORAGE_NAMES.refresh_credential, 1, {
  credential: keyedStore<'current', RefreshCredentialState>((value) =>
    value instanceof Object &&
    'generation' in value &&
    'retired' in value &&
    Number.isSafeInteger(value.generation) &&
    Number(value.generation) >= FIRST_GENERATION &&
    (value.retired === true || value.retired === false)
      ? { generation: Number(value.generation), retired: value.retired }
      : null,
  ),
});

/**
 * Every write resolves only once it is on disk: a retirement lost to a crash
 * would let the next launch present a spent token.
 */
const DURABLE = { durability: 'strict' } as const;

/**
 * The generation this tab last read or wrote. It stands in for the record when
 * IndexedDB is unavailable, which keeps this tab's own latch failing closed.
 */
let knownGeneration = FIRST_GENERATION;

/**
 * The generation this tab retired, or null while it holds a live credential.
 * Compared against the current generation rather than read as a boolean, so a
 * sign-in elsewhere clears it without this tab having to observe the event.
 */
let retiredAtGeneration: number | null = null;

/** The stored state, or `null` when IndexedDB failed (counted by the package). */
async function readRefreshCredential(): Promise<RefreshCredentialState | null> {
  try {
    const state =
      (await withDatabase(refreshCredential, (database) =>
        database.read(['credential'], (transaction) =>
          transaction.store('credential').get('current'),
        ),
      )) ?? INITIAL_CREDENTIAL;
    knownGeneration = state.generation;
    return state;
  } catch (cause) {
    if (!(cause instanceof DOMException)) throw cause;
    return null;
  }
}

/**
 * Applies `change` to the stored state in one read-write transaction, so no tab
 * interleaves between the read and the write. A storage failure is counted by
 * the package and leaves this tab's latch as the only record.
 */
async function updateRefreshCredential(
  change: (current: RefreshCredentialState) => RefreshCredentialState,
): Promise<void> {
  try {
    await withDatabase(refreshCredential, (database) =>
      database.write(
        ['credential'],
        async (transaction) => {
          const store = transaction.store('credential');
          const next = change((await store.get('current')) ?? INITIAL_CREDENTIAL);
          knownGeneration = next.generation;
          store.put('current', next);
        },
        DURABLE,
      ),
    );
  } catch (cause) {
    if (!(cause instanceof DOMException)) throw cause;
  }
}

/** Retires `generation`, which a sign-in since then has already made inert. */
function retireGeneration(generation: number): Promise<void> {
  retiredAtGeneration = generation;
  return updateRefreshCredential((current) =>
    current.generation === generation ? { generation, retired: true } : current,
  );
}

export async function refreshAccessToken(): Promise<LoginResponse | null> {
  if (await isRefreshCredentialRetired()) {
    return null;
  }
  if (refreshPromise !== null) {
    return refreshPromise;
  }

  const refreshOnce = Effect.tryPromise({
    try: (signal) => refreshAccountSession(signal),
    catch: toError,
  }).pipe(
    Effect.timeoutOrElse({
      duration: REFRESH_TIMEOUT,
      orElse: () => Effect.fail(new Error('Session refresh timed out')),
    }),
  );

  refreshPromise = withRefreshCredentialLock((retire) =>
    Effect.runPromise(refreshOnce)
      .then((response) => {
        return response;
      })
      .catch(async (error: unknown) => {
        await retire();
        throw error;
      }),
  ).finally(() => {
    refreshPromise = null;
  });
  return refreshPromise;
}

/** Serialize password rotation with other tabs' refreshes so a late Set-Cookie cannot restore a retired token. */
export async function changePasswordSession(
  accessToken: string,
  body: Parameters<typeof changeAccountPasswordRequest>[1],
  signal?: AbortSignal,
): Promise<AccountSessionResponse> {
  return withAccountCookieLock(async () => {
    try {
      const session = await changeAccountPasswordRequest(accessToken, body, signal);
      await markAccountSessionEstablished();
      return session;
    } catch (error) {
      // An ambiguous response may have replaced the cookie server-side. Do not
      // let another tab retry the previous refresh family after releasing the lock.
      if (!(error instanceof ApiError && error.status >= 400 && error.status < 500)) {
        await retireAccountRefreshCredential();
      }
      throw error;
    }
  }, signal);
}

/**
 * A successful OPAQUE finish installed a fresh refresh-token family: a new
 * generation, not retired. This tab's own latch clears at once, which is what
 * lets a tab that retired sign back in when storage is unavailable.
 */
export function markAccountSessionEstablished(): Promise<void> {
  retiredAtGeneration = null;
  return updateRefreshCredential((current) => ({
    generation: current.generation + 1,
    retired: false,
  }));
}

/**
 * Stop this origin from repeatedly presenting a refresh chain that failed local
 * delegation checks. This tab stops at once; the returned promise is the
 * origin-wide record landing, which never rejects for a storage failure.
 */
export function retireAccountRefreshCredential(): Promise<void> {
  return retireGeneration(knownGeneration);
}

/** The release this server's daemons run (`/api/release`). */
export async function fetchServerRelease(): Promise<string | null> {
  return Effect.runPromise(
    edenEffect((signal) => api.api.release.get({ fetch: { signal } })).pipe(
      Effect.map((response) => (isRelease(response) ? response.release : null)),
    ),
  );
}

export async function requestSession(
  accessToken: string,
  delegationId: string,
  daemonId: string,
  browserNodeId: string,
  issuanceId: string,
  supersedesIssuanceId: string | undefined,
  clientNonce: string,
  encapsulationKey: string,
  signal?: AbortSignal,
  traceparent?: string,
): Promise<SessionRequestResponse> {
  return Effect.runPromise(
    requestSessionEffect(
      accessToken,
      delegationId,
      daemonId,
      browserNodeId,
      issuanceId,
      supersedesIssuanceId,
      clientNonce,
      encapsulationKey,
      signal,
      traceparent,
    ),
  );
}

export function requestSessionEffect(
  accessToken: string,
  delegationId: string,
  daemonId: string,
  browserNodeId: string,
  issuanceId: string,
  supersedesIssuanceId: string | undefined,
  clientNonce: string,
  encapsulationKey: string,
  signal?: AbortSignal,
  traceparent?: string,
): Effect.Effect<SessionRequestResponse, Error> {
  return edenEffect((effectSignal) =>
    api.api.sessions.request.post(
      {
        delegationId,
        daemonId,
        browserNodeId,
        issuanceId,
        ...(supersedesIssuanceId === undefined ? {} : { supersedesIssuanceId }),
        clientNonce,
        encapsulationKey,
      },
      authenticatedRequestOptions(
        accessToken,
        combineAbortSignals(effectSignal, signal),
        undefined,
        traceparent,
      ),
    ),
  ).pipe(
    Effect.flatMap((response) => {
      const parsed = parseSessionRequestResponse(response);
      if (parsed === null) {
        return Effect.fail(new ApiError(200, 'invalid_session_response'));
      }
      return Effect.succeed(parsed);
    }),
  );
}

export function renewSession(
  accessToken: string,
  delegationId: string,
  renewal: RenewSessionRequest,
  signal: AbortSignal,
): Promise<RenewSessionResult> {
  return Effect.runPromise(
    edenEffect((effectSignal) =>
      api.api.sessions.renew.post(
        { ...renewal, delegationId },
        authenticatedRequestOptions(accessToken, combineAbortSignals(effectSignal, signal)),
      ),
    ).pipe(
      Effect.flatMap((response) => {
        const parsed = parseSessionRenewResponse(response);
        if (parsed === null) {
          return Effect.fail(new ApiError(200, 'invalid_session_response'));
        }
        return Effect.succeed(parsed);
      }),
    ),
  );
}

export async function cancelSessionRequest(
  accessToken: string,
  issuanceId: string,
  signal?: AbortSignal,
): Promise<void> {
  return Effect.runPromise(
    edenEffect((effectSignal) =>
      api.api.sessions.request.cancel.post(
        { issuanceId },
        authenticatedRequestOptions(accessToken, combineAbortSignals(effectSignal, signal), {
          keepalive: true,
        }),
      ),
    ).pipe(Effect.asVoid),
  );
}

export function createLinkTokenEffect(
  accessToken: string,
): Effect.Effect<LinkTokenResponse | null, Error> {
  return edenEffect((signal) =>
    api.api['link-token'].post({}, authenticatedRequestOptions(accessToken, signal)),
  ).pipe(Effect.map((response) => (isDeviceLinkTokenResponse(response) ? response : null)));
}

export async function deleteDevice(accessToken: string, deviceId: string): Promise<void> {
  return Effect.runPromise(deleteDeviceEffect(accessToken, deviceId));
}

export function deleteDeviceEffect(
  accessToken: string,
  deviceId: string,
): Effect.Effect<void, Error> {
  return edenEffect((signal) =>
    api.api
      .devices({ id: deviceId })
      .delete(undefined, authenticatedRequestOptions(accessToken, signal)),
  ).pipe(Effect.asVoid);
}

export type CreatedBox = BoxCreatedResponse;

/**
 * Creates a box that runs its own Merkur daemon.
 *
 * Returns once the daemon has emitted its link code, not once it is linked —
 * approval requires the user root key, so the caller completes the flow.
 */
export function createBoxEffect(
  accessToken: string,
  boxId: string,
): Effect.Effect<CreatedBox, Error> {
  return edenEffect((signal) =>
    api.api.boxes.post({ boxId }, authenticatedRequestOptions(accessToken, signal)),
  ).pipe(
    Effect.flatMap((response) => Effect.try({ try: () => asCreatedBox(response), catch: toError })),
  );
}

export async function createBox(accessToken: string, boxId: string): Promise<CreatedBox> {
  return Effect.runPromise(createBoxEffect(accessToken, boxId));
}

/** Whether this account may create boxes, and whether it runs the waitlist. */
export type BoxAccess = BoxAccessResponse;

export function fetchBoxAccessEffect(accessToken: string): Effect.Effect<BoxAccess, Error> {
  return edenEffect((signal) =>
    api.api.boxes.access.get(authenticatedRequestOptions(accessToken, signal)),
  ).pipe(Effect.flatMap(parseBoxAccess));
}

/** Joins the box waitlist. Idempotent: the answer is the account's standing after it. */
export function joinBoxWaitlistEffect(accessToken: string): Effect.Effect<BoxAccess, Error> {
  return edenEffect((signal) =>
    api.api.boxes.waitlist.post({}, authenticatedRequestOptions(accessToken, signal)),
  ).pipe(Effect.flatMap(parseBoxAccess));
}

/** The server's answer, typed by its route, held to that route's schema all the same. */
function parseBoxAccess(response: BoxAccess): Effect.Effect<BoxAccess, Error> {
  return Effect.try({ try: () => asBoxAccess(response), catch: toError });
}

/**
 * Starts a box that the TTL reaper stopped.
 *
 * Resolves once the host has accepted; the device comes back online when its
 * daemon reconnects, which arrives over the device-events stream.
 */
export function startDeviceBoxEffect(
  accessToken: string,
  deviceId: string,
): Effect.Effect<void, Error> {
  return edenEffect((signal) =>
    api.api
      .devices({ id: deviceId })
      .start.post(undefined, authenticatedRequestOptions(accessToken, signal)),
  ).pipe(Effect.asVoid);
}

export async function startDeviceBox(accessToken: string, deviceId: string): Promise<void> {
  return Effect.runPromise(startDeviceBoxEffect(accessToken, deviceId));
}

export async function renameDevice(
  accessToken: string,
  deviceId: string,
  name: string,
): Promise<void> {
  return Effect.runPromise(renameDeviceEffect(accessToken, deviceId, name));
}

export function renameDeviceEffect(
  accessToken: string,
  deviceId: string,
  name: string,
): Effect.Effect<void, Error> {
  return edenEffect((signal) =>
    api.api
      .devices({ id: deviceId })
      .patch({ name }, authenticatedRequestOptions(accessToken, signal)),
  ).pipe(Effect.asVoid);
}

export async function getPushVapidPublicKey(
  accessToken: string,
): Promise<PushVapidPublicKeyResponse | null> {
  return Effect.runPromise(getPushVapidPublicKeyEffect(accessToken));
}

export function getPushVapidPublicKeyEffect(
  accessToken: string,
): Effect.Effect<PushVapidPublicKeyResponse | null, Error> {
  return edenEffect((signal) =>
    api.api.push['vapid-public-key'].get(authenticatedRequestOptions(accessToken, signal)),
  ).pipe(Effect.map((response) => (isPushVapidPublicKey(response) ? response : null)));
}

/**
 * Post one browser link-quality window.
 *
 * Fire-and-forget by contract: the caller drops a failed window rather than
 * retrying, because a retried window double-counts and observability must not
 * consume the budget of the thing it observes.
 */
export function reportBrowserLinkEffect(
  accessToken: string,
  report: BrowserLinkReportBody,
): Effect.Effect<void, Error> {
  return edenEffect((signal) =>
    api.api.telemetry.link.post(report, authenticatedRequestOptions(accessToken, signal)),
  ).pipe(Effect.asVoid);
}

export async function reportBrowserLink(
  accessToken: string,
  report: BrowserLinkReportBody,
): Promise<void> {
  return Effect.runPromise(reportBrowserLinkEffect(accessToken, report));
}

/**
 * Post one direct-WebTransport upgrade attempt.
 *
 * Fire-and-forget on the same contract as the link window: a dropped report is
 * a non-event, and retrying would double-count the attempt.
 */
export async function reportBrowserUpgrade(
  accessToken: string,
  report: BrowserUpgradeReport,
): Promise<void> {
  // The wire body takes mutable arrays; the report is readonly by design so a
  // caller cannot mutate what it already handed off. Copy at the boundary.
  const body = {
    outcome: report.outcome,
    natType: report.natType,
    natFiltering: report.natFiltering,
    winnerKind: report.winnerKind,
    admissionStage: report.admissionStage,
    admissionReason: report.admissionReason,
    candidates: report.candidates.map((candidate) => ({
      kind: candidate.kind,
      disposition: candidate.disposition,
    })),
  };
  return Effect.runPromise(
    edenEffect((signal) =>
      api.api.telemetry.upgrade.post(body, authenticatedRequestOptions(accessToken, signal)),
    ).pipe(Effect.asVoid),
  );
}

/**
 * Post one browser failure report.
 *
 * Fire-and-forget on the same contract as the other telemetry surfaces: a dropped report is
 * a non-event, and retrying would double-count a failure. Deliberately *not* awaited by any
 * caller — reporting that something broke must never be able to break anything else.
 */
export async function reportBrowserError(
  accessToken: string,
  report: BrowserErrorReportBody,
): Promise<void> {
  return Effect.runPromise(
    edenEffect((signal) =>
      api.api.telemetry.error.post(
        { source: report.source, kind: report.kind, count: report.count },
        authenticatedRequestOptions(accessToken, signal),
      ),
    ).pipe(Effect.asVoid),
  );
}

/** Post one browser storage failure report, on the failure report's fire-and-forget terms. */
export async function reportBrowserStorage(
  accessToken: string,
  report: BrowserStorageReportBody,
): Promise<void> {
  return Effect.runPromise(
    edenEffect((signal) =>
      api.api.telemetry.storage.post(
        { target: report.target, failure: report.failure, count: report.count },
        authenticatedRequestOptions(accessToken, signal),
      ),
    ).pipe(Effect.asVoid),
  );
}

/**
 * The account's keyboard arrangement, or `null` when it has never saved one.
 *
 * Guarded rather than trusted: the treaty type says what the route declares,
 * and this value is about to decide which keys the keyboard draws.
 */
export function fetchAccountKeyboardSettingsEffect(
  accessToken: string,
): Effect.Effect<AccountKeyboardSettings | null, Error> {
  return edenEffect((signal) =>
    api.api.settings.keyboard.get(authenticatedRequestOptions(accessToken, signal)),
  ).pipe(
    Effect.map((response) => {
      if (typeof response !== 'object' || response === null || !('settings' in response)) {
        return null;
      }
      const settings = response.settings;
      return isAccountKeyboardSettings(settings) ? settings : null;
    }),
  );
}

export function saveAccountKeyboardSettingsEffect(
  accessToken: string,
  settings: AccountKeyboardSettings,
): Effect.Effect<void, Error> {
  // The wire body takes mutable arrays; the settings are readonly by design so
  // a caller cannot mutate what it already handed off. Copy at the boundary.
  const body = {
    toolbarKeys: [...settings.toolbarKeys],
    macros: settings.macros.map((macro) => ({
      ...macro,
      steps: macro.steps.map((step) => ({ ...step })),
    })),
    layerKeyOrder: Object.fromEntries(
      TERMINAL_KEYBOARD_LAYER_IDS.map((layerId) => [layerId, [...settings.layerKeyOrder[layerId]]]),
    ) as Record<(typeof TERMINAL_KEYBOARD_LAYER_IDS)[number], string[]>,
  };
  return edenEffect((signal) =>
    api.api.settings.keyboard.put(body, authenticatedRequestOptions(accessToken, signal)),
  ).pipe(Effect.asVoid);
}

export function saveAccountTelemetry(
  accessToken: string,
  enabled: boolean,
  signal: AbortSignal,
): Promise<{ enabled: boolean }> {
  return Effect.runPromise(
    edenEffect((effectSignal) =>
      api.api.account.telemetry.put(
        { enabled },
        authenticatedRequestOptions(accessToken, combineAbortSignals(effectSignal, signal)),
      ),
    ).pipe(Effect.map(asAccountTelemetry)),
  );
}

export async function savePushSubscription(
  accessToken: string,
  subscription: PushSubscriptionPayload,
): Promise<void> {
  return Effect.runPromise(savePushSubscriptionEffect(accessToken, subscription));
}

export function savePushSubscriptionEffect(
  accessToken: string,
  subscription: PushSubscriptionPayload,
): Effect.Effect<void, Error> {
  return edenEffect((signal) =>
    api.api.push.subscriptions.post(subscription, authenticatedRequestOptions(accessToken, signal)),
  ).pipe(Effect.asVoid);
}

export async function deletePushSubscription(accessToken: string, endpoint: string): Promise<void> {
  return Effect.runPromise(deletePushSubscriptionEffect(accessToken, endpoint));
}

export function deletePushSubscriptionEffect(
  accessToken: string,
  endpoint: string,
): Effect.Effect<void, Error> {
  return edenEffect((signal) =>
    api.api.push.subscriptions.delete(
      { endpoint },
      authenticatedRequestOptions(accessToken, signal),
    ),
  ).pipe(Effect.asVoid);
}

/**
 * Take the refresh credential exclusively and run `run` against it.
 *
 * `run` receives the only way to retire the credential. Keeping the writer as a
 * closure scoped to the locked region — rather than a module-level function — is
 * what makes it impossible to retire after the lock has been released, which
 * would let a waiting tab read a credential that is about to be retired.
 */
function withRefreshCredentialLock(
  run: (retire: () => Promise<void>) => Promise<LoginResponse | null>,
): Promise<LoginResponse | null> {
  return withAccountCookieLock(async (): Promise<LoginResponse | null> => {
    // This tab was clear when it called, but it may have queued behind a
    // holder that retired the credential before releasing.
    if (await isRefreshCredentialRetired()) {
      return null;
    }
    const generation = knownGeneration;
    let released = false;
    return run(async () => {
      // A `retire` captured and called after the locked region has finished
      // carries no ordering guarantee, so it must not take effect. One called
      // inside it is awaited there, so the record lands before the lock is
      // released and the next holder reads it.
      if (released) return;
      await retireGeneration(generation);
    }).finally(() => {
      released = true;
    });
  });
}

async function isRefreshCredentialRetired(): Promise<boolean> {
  const state = await readRefreshCredential();
  return retiredAtGeneration === knownGeneration || state?.retired === true;
}

function edenEffect<A>(
  request: (signal: AbortSignal) => Promise<EdenResult<A>>,
): Effect.Effect<A, Error> {
  return Effect.tryPromise({
    try: (signal) => request(signal),
    catch: toError,
  }).pipe(
    Effect.flatMap((result) => {
      if (result.error !== null) {
        return Effect.fail(toApiError(result.error));
      }

      return Effect.succeed(result.data as A);
    }),
  );
}

/**
 * Per-call options for an authenticated request, including its trace context.
 *
 * The `traceparent` lives here rather than on the treaty constructor so a caller can supply
 * one. `requestSession` does: the connect attempt mints its trace before the request goes
 * out, so the server's `session_request` span joins the browser's bootstrap trace instead of
 * rooting one of its own. Everything else gets a fresh id per call, which is the correct
 * default — a shared id across unrelated requests is what makes a trace view useless.
 *
 * Note this covers authenticated calls only. `GET /api/release` is unauthenticated and
 * carries no trace context; it is a single unauthenticated read with nothing to correlate.
 */
function authenticatedRequestOptions(
  accessToken: string,
  signal?: AbortSignal,
  fetchOptions?: RequestInit,
  traceparent?: string,
): {
  readonly headers: {
    readonly authorization: string;
    readonly 'content-type': string;
    readonly traceparent: string;
  };
  readonly fetch?: RequestInit;
} {
  const options: {
    headers: { authorization: string; 'content-type': string; traceparent: string };
    fetch?: RequestInit;
  } = {
    headers: {
      authorization: `Bearer ${accessToken}`,
      'content-type': JSON_CONTENT_TYPE,
      traceparent: traceparent ?? mintTraceparent(),
    },
  };
  if (signal !== undefined || fetchOptions !== undefined) {
    options.fetch = {
      ...fetchOptions,
      ...(signal === undefined ? {} : { signal }),
    };
  }
  return options;
}

function combineAbortSignals(effectSignal: AbortSignal, callerSignal?: AbortSignal): AbortSignal {
  return callerSignal === undefined ? effectSignal : AbortSignal.any([effectSignal, callerSignal]);
}

function toApiError(error: EdenErrorLike): ApiError {
  const status = typeof error.status === 'number' ? error.status : 0;
  const code = readErrorCode(error.value) ?? (status === 0 ? 'network_error' : 'request_failed');
  const details = readErrorDetails(error.value);
  return new ApiError(status, code, details ?? undefined);
}

function toError(error: unknown): Error {
  if (error instanceof ApiError) {
    return error;
  }
  return error instanceof Error ? error : new Error(String(error));
}

function readErrorCode(value: unknown): string | null {
  if (typeof value !== 'object' || value === null || !('error' in value)) {
    return null;
  }

  const code = value.error;
  return typeof code === 'string' && code.length > 0 ? code : null;
}

function readErrorDetails(value: unknown): string | null {
  if (typeof value !== 'object' || value === null || !('details' in value)) {
    return null;
  }

  const details = value.details;
  return typeof details === 'string' && details.length > 0 ? details : null;
}
