import { treaty } from '@elysia/eden';
import type { App } from '@merkur/server';
import {
  type AccountKeyboardSettings,
  type BrowserErrorReportBody,
  type BrowserUpgradeReport,
  type DeviceLinkTokenResponse,
  isAccountKeyboardSettings,
  isDeviceLinkTokenResponse,
  mintTraceparent,
  TERMINAL_KEYBOARD_LAYER_IDS,
} from '@merkur/shared';
import {
  BoxAccessResponse,
  BoxCreatedResponse,
  PushVapidPublicKeyResponse,
  ServerVersionResponse,
} from '@merkur/shared/api-schema';
import { compileCheck, compileRequire } from '@merkur/shared/schema-check';
import { Effect } from 'effect';
import {
  type AccountSessionResponse,
  changeAccountPasswordRequest,
  refreshAccountSession,
} from './auth/account-api';
import { ApiError } from './lib/api-error';
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

const isServerVersion = compileCheck(ServerVersionResponse);

const asCreatedBox = compileRequire(BoxCreatedResponse, 'Invalid box creation response');

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
 * Cross-tab mutex for the rotating refresh credential.
 *
 * The refresh cookie is one-use and shared by every tab on this origin, so two
 * tabs posting it at the same instant present the same spent token and the
 * server cannot tell the second one from a replay. `refreshPromise` only dedupes
 * within a single JS realm; this lock extends that guarantee across tabs and
 * windows.
 *
 * The waiter does not reuse the winner's response. It runs its own refresh once
 * the lock is free, and by then the browser's cookie jar already holds the
 * rotated successor — so it presents a live token and performs an ordinary
 * rotation rather than a replay.
 */
const REFRESH_LOCK_NAME = 'merkur-auth-refresh';

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
 * Retirement is origin-wide, because the cookie is. {@link REFRESH_RETIREMENT_KEY}
 * carries it to every tab on the origin, including ones opened after the
 * failure.
 *
 * It is recorded as the *generation* it applies to rather than as a boolean.
 * Sign-in increments {@link REFRESH_GENERATION_KEY}, so a refresh that captured
 * an older generation and only fails afterwards writes a value that no longer
 * matches, and is inert. That is what keeps a tab whose refresh timed out from
 * retiring the brand-new chain another tab just signed in for — without taking
 * this lock around sign-in, which would stall every tab's refresh for the length
 * of a password verify.
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
const REFRESH_RETIREMENT_KEY = 'merkur:refresh-credential-retired';
const REFRESH_GENERATION_KEY = 'merkur:refresh-credential-generation';
const FIRST_GENERATION = 0;

/**
 * The generation this tab retired, or null while it holds a live credential.
 * Compared against the current generation rather than read as a boolean, so a
 * sign-in elsewhere clears it without this tab having to observe the event.
 */
let retiredAtGeneration: number | null = null;

export async function refreshAccessToken(): Promise<LoginResponse | null> {
  if (isRefreshCredentialRetired()) {
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
      .catch((error: unknown) => {
        retire();
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
  return navigator.locks.request(
    REFRESH_LOCK_NAME,
    {
      mode: 'exclusive',
      ...(signal === undefined ? {} : { signal }),
    },
    async () => {
      try {
        const session = await changeAccountPasswordRequest(accessToken, body, signal);
        markAccountSessionEstablished();
        return session;
      } catch (error) {
        // An ambiguous response may have replaced the cookie server-side. Do not
        // let another tab retry the previous refresh family after releasing the lock.
        if (!(error instanceof ApiError && error.status >= 400 && error.status < 500)) {
          retireAccountRefreshCredential();
        }
        throw error;
      }
    },
  );
}

/** A successful OPAQUE finish installed a fresh refresh-token family. */
export function markAccountSessionEstablished(): void {
  clearRefreshCredentialRetirement();
}

/** Stop this origin from repeatedly presenting a refresh chain that failed local delegation checks. */
export function retireAccountRefreshCredential(): void {
  const generation = currentRefreshGeneration();
  retiredAtGeneration = generation;
  try {
    localStorage.setItem(REFRESH_RETIREMENT_KEY, String(generation));
  } catch {
    // This tab's in-memory latch still fails closed when storage is unavailable.
  }
}

export async function fetchServerVersion(): Promise<string | null> {
  return Effect.runPromise(
    edenEffect((signal) => api.api.version.get({ fetch: { signal } })).pipe(
      Effect.map((response) => (isServerVersion(response) ? response.version : null)),
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
  run: (retire: () => void) => Promise<LoginResponse | null>,
): Promise<LoginResponse | null> {
  return navigator.locks.request(
    REFRESH_LOCK_NAME,
    { mode: 'exclusive' },
    (): Promise<LoginResponse | null> => {
      // This tab was clear when it called, but it may have queued behind a
      // holder that retired the credential before releasing.
      if (isRefreshCredentialRetired()) {
        return Promise.resolve(null);
      }
      const generation = currentRefreshGeneration();
      let released = false;
      return run(() => {
        // A `retire` captured and called after the locked region has finished
        // carries no ordering guarantee, so it must not take effect.
        if (released) return;
        retiredAtGeneration = generation;
        try {
          localStorage.setItem(REFRESH_RETIREMENT_KEY, String(generation));
        } catch {
          // Storage blocked by the browser. This tab's own latch still holds;
          // only the origin-wide reach is lost.
        }
      }).finally(() => {
        released = true;
      });
    },
  );
}

function isRefreshCredentialRetired(): boolean {
  const generation = currentRefreshGeneration();
  if (retiredAtGeneration === generation) {
    return true;
  }
  return readStoredInteger(REFRESH_RETIREMENT_KEY) === generation;
}

function clearRefreshCredentialRetirement(): void {
  // Clear this tab directly as well as bumping the generation: with storage
  // blocked the generation can never move, and this is what lets a tab that
  // retired sign back in.
  retiredAtGeneration = null;
  try {
    localStorage.removeItem(REFRESH_RETIREMENT_KEY);
    localStorage.setItem(REFRESH_GENERATION_KEY, String(currentRefreshGeneration() + 1));
  } catch {
    // As above.
  }
}

function currentRefreshGeneration(): number {
  return readStoredInteger(REFRESH_GENERATION_KEY) ?? FIRST_GENERATION;
}

function readStoredInteger(key: string): number | null {
  let raw: string | null;
  try {
    raw = localStorage.getItem(key);
  } catch {
    return null;
  }
  if (raw === null) return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isSafeInteger(parsed) && parsed >= FIRST_GENERATION ? parsed : null;
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
 * Note this covers authenticated calls only. `GET /api/version` is unauthenticated and
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
