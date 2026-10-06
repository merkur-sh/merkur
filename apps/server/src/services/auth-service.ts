import { randomBytes, randomInt, randomUUID } from 'node:crypto';

import {
  type AccessTokenConfig,
  AccessTokenInvalidError,
  createAccessToken,
  createOpaqueRegistrationResponse,
  createRefreshToken,
  finishOpaqueServerLogin,
  revokeRefreshTokenFamily,
  rotateRefreshToken,
  startOpaqueServerLogin,
  validateOpaqueRegistrationRecord,
  verifyAccessToken,
} from '@merkur/auth';
import type { BrowserClient } from '@merkur/shared';
import {
  type AccountDeletionStatement,
  type DelegationRevocationStatement,
  decodeUserAuthorizationBytes,
  deriveUserRootKeyCommitment,
  parseDelegationRevocationStatement,
  serializeUserDelegationCertificate,
  USER_AUTHORIZATION_PUBLIC_KEY_BYTES,
  USER_DELEGATION_LIFETIME_MS,
  USER_ROOT_INITIAL_EPOCH,
  type UserDelegationCertificate,
  verifyAccountDeletionStatement,
  verifyDelegationRevocationStatement,
  verifyUserDelegationCertificate,
} from '@merkur/shared/user-authorization';
import { Clock, Context, Data, Effect, Layer, Redacted } from 'effect';
import {
  CompiledQuery,
  DummyDriver,
  type InferResult,
  Kysely,
  SqliteAdapter,
  SqliteIntrospector,
  type Transaction,
} from 'kysely';

import { ServerConfigService } from '../config';
import { DatabaseService } from '../db/client';
import { createSqliteQueryCompiler } from '../db/libsql-dialect';
import { tryDatabaseTransactionPromise, withDatabaseTransaction } from '../db/transaction';
import type { DatabaseSchema } from '../db/types';
import {
  buildClearRefreshCookieHeader,
  buildRefreshCookieHeader,
  createRefreshCookieValue,
  readRefreshCookie,
} from '../http/cookies';
import { createLogger, errorLogContext, logWithLoggerEffect } from '../logger';
import { normalizeAccountIdentifier } from './account-identifier';
import { createAuthFlowStore, type PasswordResetFlow } from './auth-flow-store';
import { queueBoxRemovals } from './box-removal';
import { readAccountBoxes } from './device-service';
import { isDisposableAddress, suspendedMailboxTaken } from './email-admission';
import { type InfrastructureError, infrastructureError } from './errors';
import { createResendMailSender, type MailSender } from './mail-sender';
import {
  enqueueBrowserSessionChange,
  enqueueDeviceResync,
  NotificationOutboxServiceTag,
} from './notification-outbox-service';
import { type RedisError, type RedisService, RedisServiceTag } from './redis-service';
import { createRefreshTokenStore } from './refresh-token-store';

const ROOT_ENVELOPE_NONCE_BYTES = 12;
const ROOT_ENVELOPE_CIPHERTEXT_BYTES = 48;
const MAX_ACTIVE_DELEGATIONS = 32;
const REVOCATION_CLOCK_SKEW_MS = 30_000;
/**
 * How long an account sits dormant before it is erased.
 *
 * Long enough that a request made in anger, or by someone who walked away from
 * an unlocked screen, can be undone by simply signing in; short enough that
 * "erase my account" still means it.
 */
const ACCOUNT_DELETION_GRACE_MS = 7 * 24 * 60 * 60 * 1_000;
const ENTITY_ID_CHARS = 21;
const AUTH_DISCOVERY_DOMAIN = 'merkur-auth-start-synthetic';
const EMAIL_CODE_DOMAIN = 'merkur-email-code';
const PASSWORD_RESET_CODE_DOMAIN = 'merkur-password-reset-code';
const EMAIL_CODE_PATTERN = /^\d{6}$/u;

export type AuthErrorCode =
  | 'account_suspended'
  | 'delegation_limit'
  | 'email_not_accepted'
  | 'invalid_credentials'
  | 'invalid_delegation'
  | 'invalid_email_code'
  | 'invalid_flow'
  | 'invalid_request'
  | 'registration_closed';

export class AuthError extends Data.TaggedError('AuthError')<{
  readonly code: AuthErrorCode;
  readonly message: string;
  readonly userId?: string;
}> {}

/**
 * How accounts are named. Email identity carries the sender because it is the
 * only mode that mails anything: a username server has no sender to misuse.
 */
export type AuthIdentityConfig =
  | { readonly kind: 'username' }
  | { readonly kind: 'email'; readonly mail: MailSender };

export interface AuthServiceConfig {
  readonly accessToken: AccessTokenConfig;
  readonly tokenHmacSecret: string;
  readonly allowRegistration: boolean;
  readonly identity: AuthIdentityConfig;
  readonly opaqueServerSetup: string;
  readonly publicOrigin: string;
}

export interface AuthSessionResult {
  readonly accessToken: string;
  readonly userId: string;
  readonly delegationId: string;
  readonly delegationExpiresAt: number;
  readonly serverTimeMs: number;
  readonly refreshCookieHeader: string;
  /**
   * True when signing in called off a scheduled erasure.
   *
   * Surfaced rather than done quietly: the owner asked for the account to be
   * destroyed, and coming back cancels that. Reversing it without saying so
   * would leave someone believing their data was on its way out when it is not.
   */
  readonly deletionCancelled: boolean;
}

export interface RegistrationStartResult {
  readonly flowId: string;
  readonly userId: string;
  readonly registrationResponse: string;
  readonly delegationIssuedAt: number;
  readonly delegationExpiresAt: number;
}

export interface LoginStartResult {
  readonly flowId: string;
  readonly userId: string;
  readonly loginResponse: string;
  readonly rootPublicKey: string;
  readonly rootEnvelope: RootEnvelope;
  readonly rootEpoch: number;
  readonly delegationIssuedAt: number;
  readonly delegationExpiresAt: number;
}

export interface AuthStartResult {
  readonly login: LoginStartResult;
  readonly registration: RegistrationStartResult;
}

/** One machine a password reset will unlink; `box` marks a hosted box it will destroy. */
export interface PasswordResetDevice {
  readonly name: string;
  readonly platform: string;
  readonly box: boolean;
}

export interface PasswordResetVerified<A> {
  /** Names the proven reset; the mailed-code flow it replaces is spent. */
  readonly flowId: string;
  readonly devices: readonly PasswordResetDevice[];
  /** Whatever the caller's admission returned, so a correct code can hand it back. */
  readonly admitted: A;
}

export interface PasswordResetStartResult {
  readonly userId: string;
  readonly registrationResponse: string;
  /** The epoch the new root's first delegation must name. */
  readonly rootEpoch: number;
  readonly delegationIssuedAt: number;
  readonly delegationExpiresAt: number;
}

export interface RootEnvelope {
  readonly nonce: string;
  readonly ciphertext: string;
}

export interface BrowserSession {
  readonly delegationId: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly revokedAt: number | null;
  readonly current: boolean;
  /**
   * What this browser is, as parsed when the delegation was issued. Never
   * re-derived: the row outlives the request that made it, and a later browser
   * must not be able to rename a session it did not create.
   */
  readonly client: BrowserClient;
}

export interface BrowserSessionList {
  readonly serverTimeMs: number;
  readonly sessions: BrowserSession[];
}

export interface AuthenticatedBrowser {
  readonly userId: string;
  readonly delegationId: string;
  readonly delegationExpiresAt: number;
}

export interface SignedRevocation {
  readonly actorCertificate: UserDelegationCertificate;
  readonly revocation: DelegationRevocationStatement;
}

export type RevocationSemantics =
  | { readonly kind: 'self' }
  | { readonly kind: 'one'; readonly delegationId: string }
  | { readonly kind: 'others' };

/**
 * What a signed revocation must name. `account` is every active delegation, the
 * actor's own included; only scheduling the account's deletion asks for it, so
 * no route can.
 */
type RevocationScope = RevocationSemantics | { readonly kind: 'account' };

type AuthFailure = InfrastructureError | RedisError | AuthError;

export interface AuthService {
  startAuth(
    username: string,
    startLoginRequest: string,
    registrationRequest: string,
  ): Effect.Effect<AuthStartResult, AuthFailure>;
  /**
   * Email identity only: mails the code a registration finish must carry.
   *
   * Answers identically whether or not the address has an account. A new
   * address is sent its code; an existing one is sent a notice that its
   * password was wrong, and the flow records a code nobody was sent, so every
   * guess at it fails exactly as a wrong code would.
   *
   * `admit` runs with the recipient before anything is recorded or sent, so
   * the caller can bound how much mail one address receives.
   */
  requestEmailCode<E, R>(
    flowId: string,
    admit: (recipient: string) => Effect.Effect<unknown, E, R>,
  ): Effect.Effect<void, AuthFailure | E, R>;
  finishRegistration(input: {
    readonly flowId: string;
    /** The mailed code in email identity; `null` in username identity. */
    readonly emailCode: string | null;
    readonly registrationRecord: string;
    readonly rootPublicKey: string;
    readonly rootEnvelope: RootEnvelope;
    readonly delegationCertificate: UserDelegationCertificate;
    readonly client: BrowserClient;
  }): Effect.Effect<AuthSessionResult, AuthFailure>;
  finishLogin(input: {
    readonly flowId: string;
    readonly finishLoginRequest: string;
    readonly delegationCertificate: UserDelegationCertificate;
    readonly client: BrowserClient;
  }): Effect.Effect<AuthSessionResult, AuthFailure>;
  changePassword(
    browser: AuthenticatedBrowser,
    input: {
      readonly flowId: string;
      readonly finishLoginRequest: string;
      readonly registrationRecord: string;
      readonly rootEnvelope: RootEnvelope;
      readonly delegationCertificate: UserDelegationCertificate;
      readonly revocation: DelegationRevocationStatement | null;
    },
  ): Effect.Effect<AuthSessionResult, AuthFailure>;
  /**
   * Email identity only: opens a password reset for `username` and mails its
   * address one message, the code when it has an account and a notice when it
   * has none. Both answer with a flow id, so the form names no account.
   *
   * `admit` runs for the normalized address before anything is read or sent,
   * and a failure from it aborts the request.
   */
  requestPasswordResetCode<E, R>(
    username: string,
    admit: (recipient: string) => Effect.Effect<unknown, E, R>,
  ): Effect.Effect<string, AuthFailure | E, R>;
  /**
   * Spends one guess at a reset's mailed code. A match proves the mailbox: the
   * mailed-code flow is consumed and a new one, naming the proven reset, is
   * returned with the machines the reset will unlink.
   *
   * `admit` runs for the account the flow is aimed at before the guess is
   * counted, so guesses can be budgeted per account across flows.
   */
  verifyPasswordResetCode<A, E, R>(
    flowId: string,
    emailCode: string,
    admit: (userId: string) => Effect.Effect<A, E, R>,
  ): Effect.Effect<PasswordResetVerified<A>, AuthFailure | E, R>;
  /** The OPAQUE registration response for a proven reset's new password. */
  startPasswordReset(
    flowId: string,
    registrationRequest: string,
  ): Effect.Effect<PasswordResetStartResult, AuthFailure>;
  /**
   * Replaces the account's credential and user root, once.
   *
   * Everything the old root authorized goes with it: every browser delegation
   * and refresh token, every machine link and pending link, every push
   * subscription, and every hosted box, queued for destruction. The account
   * row and what is not bound to a root stay. Nothing here can reach a
   * terminal: the daemons are bound to the root being discarded.
   */
  finishPasswordReset(input: {
    readonly flowId: string;
    readonly registrationRecord: string;
    readonly rootPublicKey: string;
    readonly rootEnvelope: RootEnvelope;
    readonly delegationCertificate: UserDelegationCertificate;
    readonly client: BrowserClient;
  }): Effect.Effect<AuthSessionResult, AuthFailure>;
  refresh(
    cookieHeader: string | null,
  ): Effect.Effect<AuthSessionResult | null, InfrastructureError>;
  logout(
    cookieHeader: string | null,
    proof: SignedRevocation,
  ): Effect.Effect<string, InfrastructureError | AuthError>;
  verifyBearerToken(
    accessToken: string,
  ): Effect.Effect<AuthenticatedBrowser | null, InfrastructureError>;
  listBrowserSessions(
    browser: AuthenticatedBrowser,
  ): Effect.Effect<BrowserSessionList, InfrastructureError>;
  revokeBrowserSessions(
    browser: AuthenticatedBrowser,
    proof: SignedRevocation,
    semantics: RevocationSemantics,
  ): Effect.Effect<number, InfrastructureError | AuthError>;
  requireActiveDelegation(
    userId: string,
    delegationId: string,
  ): Effect.Effect<AuthenticatedBrowser | null, InfrastructureError>;
  /**
   * Schedules the account's erasure and puts it to sleep.
   *
   * An access token is not authority to erase an account — a stolen one would
   * be — so the request carries a statement signed by the root key, which only
   * the password unwraps. Nothing is deleted here: every delegation is revoked
   * so the account goes dormant, and the purge falls due after the grace
   * period. Signing in before then clears the schedule, and because the
   * delegations are gone a sign-in is the only access the account has left.
   *
   * `revocation` must name every active delegation, the caller's own included.
   * Daemons verify delegations themselves, so a revocation they can act on has
   * to be one a delegation signed; it is recorded with the schedule, in one
   * transaction, for the control link to deliver.
   *
   * Returns the instant the purge becomes due.
   */
  scheduleAccountDeletion(
    browser: AuthenticatedBrowser,
    statement: AccountDeletionStatement,
    revocation: SignedRevocation,
  ): Effect.Effect<number, AuthFailure>;
  /** Accounts whose grace period has run out, oldest request first. */
  accountsDueForDeletion(): Effect.Effect<readonly string[], InfrastructureError>;
  /**
   * Erases the account.
   *
   * One statement: every table that belongs to an account declares
   * `references('users.id').onDelete('cascade')`, so SQLite removes the rest.
   * Destroy the account's hosted boxes before calling this — a container that
   * outlives its account is the erasure failure that matters.
   */
  purgeAccount(userId: string): Effect.Effect<void, InfrastructureError>;
}

export class AuthServiceTag extends Context.Service<AuthServiceTag, AuthService>()('AuthService') {}

export const AuthServiceLive = Layer.effect(
  AuthServiceTag,
  Effect.gen(function* () {
    const config = yield* ServerConfigService;
    const db = yield* DatabaseService;
    const redis = yield* RedisServiceTag;
    return createAuthService(
      db,
      redis,
      {
        accessToken: {
          hmacKey: config.accessTokenHmacKey,
          issuer: config.jwtIssuer,
          audience: config.jwtAudience,
        },
        tokenHmacSecret: Redacted.value(config.tokenHmacSecret),
        allowRegistration: config.authAllowRegistration,
        identity:
          config.emailDelivery === undefined
            ? { kind: 'username' }
            : {
                kind: 'email',
                mail: createResendMailSender(config.emailDelivery, config.publicOrigin),
              },
        opaqueServerSetup: Redacted.value(config.opaqueServerSetup),
        publicOrigin: config.publicOrigin,
      },
      (yield* NotificationOutboxServiceTag).wake,
    );
  }),
);

export function createAuthService(
  db: Kysely<DatabaseSchema>,
  redis: RedisService,
  config: AuthServiceConfig,
  wakeNotifications: Effect.Effect<void>,
): AuthService {
  const refreshTokenStore = createRefreshTokenStore(db);
  const flowStore = createAuthFlowStore(redis);
  const logger = createLogger('server');

  return {
    startAuth: Effect.fnUntraced(function* (
      username: string,
      startLoginRequest: string,
      registrationRequest: string,
    ) {
      const normalizedUsername = yield* normalizeIdentifier(config.identity, username);
      const user = yield* findUserByUsername(db, normalizedUsername);
      const accountExists = user !== undefined;
      const synthetic = syntheticAccountMaterial(config.tokenHmacSecret, normalizedUsername);
      const userId = user?.id ?? synthetic.userId;
      const delegationIssuedAt = yield* Clock.currentTimeMillis;
      const delegationExpiresAt = delegationIssuedAt + USER_DELEGATION_LIFETIME_MS;
      const login = yield* Effect.tryPromise({
        try: () =>
          startOpaqueServerLogin({
            serverSetup: config.opaqueServerSetup,
            registrationRecord: user?.opaque_registration_record ?? null,
            startLoginRequest,
            userId,
            serverIdentity: config.publicOrigin,
          }),
        catch: () => new AuthError({ code: 'invalid_request', message: 'Invalid login request' }),
      });
      const registrationResponse = yield* Effect.tryPromise({
        try: () =>
          createOpaqueRegistrationResponse({
            serverSetup: config.opaqueServerSetup,
            userId,
            registrationRequest,
          }),
        catch: () =>
          new AuthError({ code: 'invalid_request', message: 'Invalid registration request' }),
      });
      const flowId = yield* flowStore.createStart({
        kind: 'auth-start',
        userId,
        username: normalizedUsername,
        serverLoginState: login.serverLoginState,
        accountExists,
        credentialFingerprint:
          user === undefined ? null : credentialFingerprint(user.opaque_registration_record),
        registrationAllowed: !accountExists && config.allowRegistration,
        delegationIssuedAt,
        delegationExpiresAt,
      });
      return {
        login: {
          flowId,
          userId,
          loginResponse: login.loginResponse,
          rootPublicKey: user?.root_public_key ?? synthetic.rootPublicKey,
          rootEnvelope:
            user === undefined
              ? {
                  nonce: synthetic.rootEnvelope.nonce,
                  ciphertext: synthetic.rootEnvelope.ciphertext,
                }
              : {
                  nonce: user.root_envelope_nonce,
                  ciphertext: user.root_envelope_ciphertext,
                },
          rootEpoch: user?.root_epoch ?? USER_ROOT_INITIAL_EPOCH,
          delegationIssuedAt,
          delegationExpiresAt,
        },
        registration: {
          flowId,
          userId,
          registrationResponse,
          delegationIssuedAt,
          delegationExpiresAt,
        },
      };
    }),

    requestEmailCode: Effect.fnUntraced(function* <E, R>(
      flowId: string,
      admit: (recipient: string) => Effect.Effect<unknown, E, R>,
    ) {
      const { identity } = config;
      if (identity.kind !== 'email') {
        return yield* authFailure('invalid_request', 'This server does not verify addresses');
      }
      const flow = yield* flowStore.peekStart(flowId);
      if (flow === null) return yield* invalidFlow();
      // The same refusal registration finish gives, before any mail leaves:
      // a closed server must not send codes it will never accept.
      if (!config.allowRegistration) {
        return yield* authFailure(
          'registration_closed',
          'This server is not accepting new accounts',
        );
      }
      // The domain says nothing about whether the address has an account, so
      // it is refused for every flow. The suspended-mailbox match is asked only
      // for a new address: an existing one, suspended or not, gets its notice.
      if (isDisposableAddress(flow.username)) return yield* emailNotAccepted();
      if (
        flow.registrationAllowed &&
        (yield* Effect.tryPromise({
          try: () => suspendedMailboxTaken(db, flow.username),
          catch: infrastructureError('auth', 'match-suspended-mailbox'),
        }))
      ) {
        return yield* emailNotAccepted();
      }
      yield* admit(flow.username);
      const code = flow.registrationAllowed ? createEmailCode() : null;
      const mac =
        code === null
          ? randomBytes(32).toString('hex')
          : emailCodeMac(config.tokenHmacSecret, EMAIL_CODE_DOMAIN, flowId, code);
      const send = yield* flowStore.attachEmailCode(flowId, mac);
      if (send === null) return yield* invalidFlow();
      const idempotencyKey = `${flowId}:${send}`;
      yield* code === null
        ? identity.mail.sendAlreadyRegistered({ to: flow.username, idempotencyKey })
        : identity.mail.sendSignUpCode({ to: flow.username, code, idempotencyKey });
    }),

    finishRegistration: Effect.fnUntraced(function* (
      input: Parameters<AuthService['finishRegistration']>[0],
    ) {
      if (config.identity.kind === 'email') {
        if (input.emailCode === null || !EMAIL_CODE_PATTERN.test(input.emailCode)) {
          return yield* authFailure('invalid_request', 'A six-digit code is required');
        }
        const check = yield* flowStore.checkEmailCode(
          input.flowId,
          emailCodeMac(config.tokenHmacSecret, EMAIL_CODE_DOMAIN, input.flowId, input.emailCode),
        );
        if (check === 'missing' || check === 'exhausted') return yield* invalidFlow();
        if (check === 'mismatch') {
          return yield* authFailure('invalid_email_code', 'The code is not correct');
        }
      } else if (input.emailCode !== null) {
        return yield* authFailure('invalid_request', 'This server does not verify addresses');
      }
      const flow = yield* flowStore.consumeStart(input.flowId);
      if (flow === null) return yield* invalidFlow();
      if (config.identity.kind === 'email') yield* flowStore.discardEmailCode(input.flowId);
      // With sign-up closed, every registration finish gets the same answer
      // whether or not the username exists. The browser reaches this step both
      // for a new username and for a wrong password on an existing one, so
      // answering the two differently would tell a caller which usernames
      // exist. The message covers both readings.
      if (!config.allowRegistration) {
        return yield* authFailure(
          'registration_closed',
          'This server is not accepting new accounts',
        );
      }
      if (!flow.registrationAllowed || flow.accountExists) {
        return yield* invalidCredentials();
      }
      const now = yield* Clock.currentTimeMillis;
      const material = yield* validateRegistrationMaterial(
        input,
        flow.userId,
        USER_ROOT_INITIAL_EPOCH,
        flow.delegationIssuedAt,
        flow.delegationExpiresAt,
        config,
        now,
      );
      const session = yield* withDatabaseTransaction(db, (trx) =>
        tryDatabaseTransactionPromise({
          try: async () => {
            const existing = await trx
              .selectFrom('users')
              .select('id')
              .where('username', '=', flow.username)
              .executeTakeFirst();
            if (existing !== undefined) throw invalidCredentialsError();
            // Asked again here because the code was mailed before this
            // transaction: an account suspended since then still bars it.
            if (
              config.identity.kind === 'email' &&
              (await suspendedMailboxTaken(trx, flow.username))
            ) {
              throw emailNotAcceptedError();
            }
            // The select above answers the ordinary case; this closes the
            // race where two registrations for one username pass it at once.
            // `DO NOTHING` names the username index, so a losing insert is
            // reported as zero rows written rather than raised as an error --
            // the same refusal, decided by a count the database returns
            // rather than by matching the text of a driver's exception, which
            // differs between a local database and one reached over a
            // connection.
            const inserted = await trx
              .insertInto('users')
              .values({
                id: flow.userId,
                username: flow.username,
                opaque_registration_record: input.registrationRecord,
                root_public_key: input.rootPublicKey,
                root_key_commitment: material.rootKeyCommitment,
                root_epoch: USER_ROOT_INITIAL_EPOCH,
                root_envelope_nonce: material.rootEnvelope.nonce,
                root_envelope_ciphertext: material.rootEnvelope.ciphertext,
                created_at: now,
              })
              .onConflict((conflict) => conflict.column('username').doNothing())
              .executeTakeFirst();
            if ((inserted.numInsertedOrUpdatedRows ?? 0n) === 0n) {
              throw invalidCredentialsError();
            }
            await insertDelegation(trx, material.certificate, input.client);
            return issueAuthSession(trx, material.certificate, config, now);
          },
          catch: normalizeAuthInfrastructureError('finish-registration'),
        }),
      );
      yield* wakeNotifications;
      return session;
    }),

    finishLogin: Effect.fnUntraced(function* (input: Parameters<AuthService['finishLogin']>[0]) {
      const flow = yield* flowStore.consumeStart(input.flowId);
      if (flow === null) return yield* invalidFlow();
      const loginResult = yield* Effect.result(
        Effect.tryPromise({
          try: () =>
            finishOpaqueServerLogin({
              serverLoginState: flow.serverLoginState,
              finishLoginRequest: input.finishLoginRequest,
              userId: flow.userId,
              serverIdentity: config.publicOrigin,
            }),
          catch: () =>
            new AuthError({
              code: 'invalid_credentials',
              message: 'Invalid username or password',
              ...(flow.accountExists ? { userId: flow.userId } : {}),
            }),
        }),
      );
      if (loginResult._tag === 'Failure' || !flow.accountExists) {
        return yield* new AuthError({
          code: 'invalid_credentials',
          message: 'Invalid username or password',
          ...(flow.accountExists ? { userId: flow.userId } : {}),
        });
      }
      const now = yield* Clock.currentTimeMillis;
      const user = yield* findUserById(db, flow.userId);
      if (user === undefined) {
        return yield* new AuthError({
          code: 'invalid_credentials',
          message: 'Invalid username or password',
        });
      }
      const certificate = yield* verifyDelegationForUser(
        input.delegationCertificate,
        user,
        config.publicOrigin,
        now,
      );
      const login = yield* withDatabaseTransaction(db, (trx) =>
        tryDatabaseTransactionPromise({
          try: async () => {
            // An OPAQUE exchange started before a password change has no
            // authority to install a delegation after that change commits.
            await requireCurrentCredential(trx, flow.userId, flow.credentialFingerprint);
            const existing = await findStoredDelegation(trx, certificate.delegationId);
            const reusesActiveCertificate =
              existing !== undefined &&
              existing.user_id === certificate.userId &&
              existing.certificate_json === serializeUserDelegationCertificate(certificate) &&
              existing.revoked_at === null &&
              existing.expires_at > now;
            if (
              !reusesActiveCertificate &&
              (certificate.issuedAt !== flow.delegationIssuedAt ||
                certificate.expiresAt !== flow.delegationExpiresAt)
            ) {
              throw invalidDelegationError();
            }
            const inserted = await ensureDelegation(trx, certificate, now, input.client);
            return { session: await issueAuthSession(trx, certificate, config, now), inserted };
          },
          catch: normalizeAuthInfrastructureError('finish-login'),
        }),
      );
      // Only a delegation that did not exist before is news to other browsers.
      if (login.inserted) yield* wakeNotifications;
      return login.session;
    }),

    changePassword: Effect.fnUntraced(function* (
      browser: AuthenticatedBrowser,
      input: Parameters<AuthService['changePassword']>[1],
    ) {
      const flow = yield* flowStore.consumeStart(input.flowId);
      if (flow === null) return yield* invalidFlow();
      if (!flow.accountExists || flow.userId !== browser.userId) return yield* invalidCredentials();
      yield* Effect.tryPromise({
        try: () =>
          finishOpaqueServerLogin({
            serverLoginState: flow.serverLoginState,
            finishLoginRequest: input.finishLoginRequest,
            userId: flow.userId,
            serverIdentity: config.publicOrigin,
          }),
        catch: invalidCredentialsError,
      });
      const envelope = yield* Effect.try({
        try: () => {
          validateOpaqueRegistrationRecord(input.registrationRecord);
          return validateRootEnvelope(input.rootEnvelope);
        },
        catch: () =>
          new AuthError({ code: 'invalid_request', message: 'Invalid password change material' }),
      });
      const now = yield* Clock.currentTimeMillis;
      const session = yield* withDatabaseTransaction(db, (trx) =>
        tryDatabaseTransactionPromise({
          try: async () => {
            await requireCurrentCredential(trx, browser.userId, flow.credentialFingerprint);
            const actor = await findStoredDelegation(trx, browser.delegationId);
            const certificate = input.delegationCertificate;
            if (
              actor === undefined ||
              actor.user_id !== browser.userId ||
              actor.revoked_at !== null ||
              actor.expires_at <= now ||
              certificate.userId !== browser.userId ||
              certificate.delegationId !== browser.delegationId ||
              actor.certificate_json !== serializeUserDelegationCertificate(certificate)
            ) {
              throw invalidDelegationError();
            }
            const targets = (await activeDelegationTargets(trx, browser.userId, now)).filter(
              (target) => target.delegationId !== browser.delegationId,
            );
            if (input.revocation === null) {
              if (targets.length !== 0) throw invalidDelegationError();
            } else {
              // A previously accepted revoke-others statement must not skip
              // checking browsers created since that statement was applied.
              const replay = await trx
                .selectFrom('delegation_revocations')
                .select('nonce')
                .where('nonce', '=', input.revocation.nonce)
                .executeTakeFirst();
              if (replay !== undefined) throw invalidDelegationError();
              await revokeBrowserSessionsTransaction(
                trx,
                browser,
                {
                  actorCertificate: certificate,
                  revocation: input.revocation,
                },
                { kind: 'others' },
                config,
                now,
              );
            }
            await trx
              .updateTable('users')
              .set({
                opaque_registration_record: input.registrationRecord,
                root_envelope_nonce: envelope.nonce,
                root_envelope_ciphertext: envelope.ciphertext,
              })
              .where('id', '=', browser.userId)
              .execute();
            await trx.deleteFrom('refresh_tokens').where('user_id', '=', browser.userId).execute();
            return issueAuthSession(trx, certificate, config, now);
          },
          catch: normalizeAuthInfrastructureError('change-password'),
        }),
      );
      if (input.revocation !== null) yield* wakeNotifications;
      return session;
    }),

    requestPasswordResetCode: Effect.fnUntraced(function* <E, R>(
      username: string,
      admit: (recipient: string) => Effect.Effect<unknown, E, R>,
    ) {
      const { identity } = config;
      if (identity.kind !== 'email') return yield* resetUnavailable();
      const address = yield* normalizeIdentifier(identity, username);
      yield* admit(address);
      const user = yield* findUserByUsername(db, address);
      // An address with no account gets a flow under the same synthetic id a
      // sign-in start would give it, and a code nobody was sent: the answer and
      // the one message that leaves are the same shape either way.
      const flowId = yield* flowStore.createResetCode({
        kind: 'password-reset-code',
        userId: user?.id ?? syntheticAccountMaterial(config.tokenHmacSecret, address).userId,
        username: address,
        accountExists: user !== undefined,
        credentialFingerprint:
          user === undefined ? null : credentialFingerprint(user.opaque_registration_record),
        rootEpoch: user?.root_epoch ?? USER_ROOT_INITIAL_EPOCH,
      });
      const code = user === undefined ? null : createEmailCode();
      const mac =
        code === null
          ? randomBytes(32).toString('hex')
          : emailCodeMac(config.tokenHmacSecret, PASSWORD_RESET_CODE_DOMAIN, flowId, code);
      const send = yield* flowStore.attachEmailCode(flowId, mac);
      if (send === null) return yield* invalidFlow();
      const idempotencyKey = `${flowId}:${send}`;
      yield* code === null
        ? identity.mail.sendPasswordResetNoAccount({ to: address, idempotencyKey })
        : identity.mail.sendPasswordResetCode({ to: address, code, idempotencyKey });
      return flowId;
    }),

    verifyPasswordResetCode: Effect.fnUntraced(function* <A, E, R>(
      flowId: string,
      emailCode: string,
      admit: (userId: string) => Effect.Effect<A, E, R>,
    ) {
      if (config.identity.kind !== 'email') return yield* resetUnavailable();
      if (!EMAIL_CODE_PATTERN.test(emailCode)) {
        return yield* authFailure('invalid_request', 'A six-digit code is required');
      }
      const pending = yield* flowStore.peekResetCode(flowId);
      if (pending === null) return yield* invalidFlow();
      const admitted = yield* admit(pending.userId);
      const check = yield* flowStore.checkEmailCode(
        flowId,
        emailCodeMac(config.tokenHmacSecret, PASSWORD_RESET_CODE_DOMAIN, flowId, emailCode),
      );
      if (check === 'missing' || check === 'exhausted') return yield* invalidFlow();
      if (check === 'mismatch') {
        return yield* authFailure('invalid_email_code', 'The code is not correct');
      }
      // Consumed, not read: two correct submissions of one code prove the
      // mailbox once, and only the first is handed a reset.
      const proven = yield* flowStore.consumeResetCode(flowId);
      yield* flowStore.discardEmailCode(flowId);
      if (proven === null || !proven.accountExists || proven.credentialFingerprint === null) {
        return yield* invalidFlow();
      }
      const devices = yield* Effect.tryPromise({
        try: () => listPasswordResetDevices(db, proven.userId),
        catch: infrastructureError('auth', 'list-password-reset-devices'),
      });
      const delegationIssuedAt = yield* Clock.currentTimeMillis;
      const resetFlowId = yield* flowStore.createReset({
        kind: 'password-reset',
        userId: proven.userId,
        username: proven.username,
        credentialFingerprint: proven.credentialFingerprint,
        rootEpoch: proven.rootEpoch,
        delegationIssuedAt,
        delegationExpiresAt: delegationIssuedAt + USER_DELEGATION_LIFETIME_MS,
      });
      return { flowId: resetFlowId, devices, admitted };
    }),

    startPasswordReset: Effect.fnUntraced(function* (flowId: string, registrationRequest: string) {
      if (config.identity.kind !== 'email') return yield* resetUnavailable();
      const flow = yield* flowStore.peekReset(flowId);
      if (flow === null) return yield* invalidFlow();
      const registrationResponse = yield* Effect.tryPromise({
        try: () =>
          createOpaqueRegistrationResponse({
            serverSetup: config.opaqueServerSetup,
            userId: flow.userId,
            registrationRequest,
          }),
        catch: () =>
          new AuthError({ code: 'invalid_request', message: 'Invalid registration request' }),
      });
      return {
        userId: flow.userId,
        registrationResponse,
        rootEpoch: flow.rootEpoch + 1,
        delegationIssuedAt: flow.delegationIssuedAt,
        delegationExpiresAt: flow.delegationExpiresAt,
      };
    }),

    finishPasswordReset: Effect.fnUntraced(function* (
      input: Parameters<AuthService['finishPasswordReset']>[0],
    ) {
      const { identity } = config;
      if (identity.kind !== 'email') return yield* resetUnavailable();
      const flow = yield* flowStore.consumeReset(input.flowId);
      if (flow === null) return yield* invalidFlow();
      const now = yield* Clock.currentTimeMillis;
      const material = yield* validateRegistrationMaterial(
        input,
        flow.userId,
        flow.rootEpoch + 1,
        flow.delegationIssuedAt,
        flow.delegationExpiresAt,
        config,
        now,
      );
      const reset = yield* withDatabaseTransaction(db, (trx) =>
        tryDatabaseTransactionPromise({
          try: () => finishPasswordResetTransaction(trx, flow, input, material, config, now),
          catch: normalizeAuthInfrastructureError('finish-password-reset'),
        }),
      );
      yield* wakeNotifications;
      yield* logWithLoggerEffect(logger, 'info', 'account_password_reset', {
        userId: flow.userId,
        browsers: reset.browsers,
        machines: reset.machines,
        boxes: reset.boxes,
      });
      for (const box of reset.contestedBoxes) {
        yield* logWithLoggerEffect(logger, 'warn', 'password_reset_box_contested', {
          userId: flow.userId,
          box,
        });
      }
      // The reset has committed; a notice that cannot be sent must not undo it
      // or deny the session it earned.
      yield* identity.mail
        .sendPasswordWasReset({ to: flow.username, idempotencyKey: `${input.flowId}:done` })
        .pipe(
          Effect.catch((error) =>
            logWithLoggerEffect(logger, 'warn', 'password_reset_notice_failed', {
              userId: flow.userId,
              ...errorLogContext(error),
            }),
          ),
        );
      return reset.session;
    }),

    refresh: Effect.fnUntraced(function* (cookieHeader: string | null) {
      const parsedCookie = readRefreshCookie(cookieHeader);
      if (parsedCookie === null) return null;
      const now = yield* Clock.currentTimeMillis;
      const rotation = yield* rotateRefreshTokenInTransaction(
        db,
        parsedCookie.refreshTokenId,
        parsedCookie.refreshToken,
        config.tokenHmacSecret,
        now,
      );
      if (rotation.outcome === 'reuse-detected') {
        yield* logWithLoggerEffect(logger, 'warn', 'refresh_token_reuse_detected', {
          userId: rotation.userId,
          familyId: rotation.familyId,
        });
        return null;
      }
      if (rotation.outcome === 'rejected') return null;
      const active = yield* findActiveDelegation(
        db,
        rotation.rotated.record.userId,
        rotation.rotated.record.delegationId,
        now,
      );
      if (active === null || active.delegationExpiresAt !== rotation.rotated.record.expiresAt) {
        yield* Effect.tryPromise({
          try: () => refreshTokenStore.deleteByFamilyId(rotation.rotated.record.familyId),
          catch: infrastructureError('auth', 'reject-revoked-refresh-family'),
        });
        return null;
      }
      const accessToken = yield* createAccessTokenEffect(
        active,
        rotation.rotated.record.expiresAt,
        config.accessToken,
        now,
      );
      // A refresh never cancels an erasure: scheduling one deletes the
      // account's refresh tokens, so a dormant account has none to rotate.
      return sessionResult(
        accessToken,
        active,
        rotation.rotated.record.id,
        rotation.rotated.token,
        now,
        false,
      );
    }),

    logout: Effect.fnUntraced(function* (cookieHeader: string | null, proof: SignedRevocation) {
      const now = yield* Clock.currentTimeMillis;
      const actor = parseUserDelegationActor(proof.actorCertificate);
      yield* revokeBrowserSessionsEffect(db, actor, proof, { kind: 'self' }, config, now);
      yield* wakeNotifications;
      const parsedCookie = readRefreshCookie(cookieHeader);
      if (parsedCookie !== null) {
        yield* Effect.tryPromise({
          try: () => revokeRefreshTokenFamily(refreshTokenStore, parsedCookie.refreshTokenId),
          catch: infrastructureError('auth', 'revoke-refresh-token'),
        });
      }
      return buildClearRefreshCookieHeader();
    }),

    verifyBearerToken: Effect.fnUntraced(function* (accessToken: string) {
      const verified = yield* Effect.tryPromise({
        try: async () => {
          try {
            return await verifyAccessToken(accessToken, config.accessToken);
          } catch (error) {
            if (error instanceof AccessTokenInvalidError) return null;
            throw error;
          }
        },
        catch: infrastructureError('auth', 'verify-access-token'),
      });
      if (verified === null) return null;
      const now = yield* Clock.currentTimeMillis;
      const active = yield* findActiveDelegation(db, verified.userId, verified.delegationId, now);
      if (active === null || verified.expiresAt > active.delegationExpiresAt) return null;
      return active;
    }),

    listBrowserSessions: Effect.fnUntraced(function* (browser: AuthenticatedBrowser) {
      const serverTimeMs = yield* Clock.currentTimeMillis;
      const sessions = yield* Effect.tryPromise({
        try: async () => {
          const rows = await db
            .selectFrom('browser_delegations')
            .select([
              'id',
              'issued_at',
              'expires_at',
              'revoked_at',
              'client_browser',
              'client_platform',
              'client_installed',
            ])
            .where('user_id', '=', browser.userId)
            .where('expires_at', '>', serverTimeMs)
            .orderBy('issued_at', 'desc')
            .execute();
          return rows.flatMap((row): BrowserSession[] =>
            row.id === null
              ? []
              : [
                  {
                    delegationId: row.id,
                    issuedAt: row.issued_at,
                    expiresAt: row.expires_at,
                    revokedAt: row.revoked_at,
                    current: row.id === browser.delegationId,
                    client: {
                      browser: row.client_browser,
                      platform: row.client_platform,
                      installed: row.client_installed !== 0,
                    },
                  },
                ],
          );
        },
        catch: infrastructureError('auth', 'list-browser-sessions'),
      });
      return { serverTimeMs, sessions };
    }),

    revokeBrowserSessions: Effect.fnUntraced(function* (
      browser: AuthenticatedBrowser,
      proof: SignedRevocation,
      semantics: RevocationSemantics,
    ) {
      const now = yield* Clock.currentTimeMillis;
      const revoked = yield* revokeBrowserSessionsEffect(
        db,
        browser,
        proof,
        semantics,
        config,
        now,
      );
      yield* wakeNotifications;
      return revoked;
    }),

    requireActiveDelegation: Effect.fnUntraced(function* (userId: string, delegationId: string) {
      const now = yield* Clock.currentTimeMillis;
      return yield* findActiveDelegation(db, userId, delegationId, now);
    }),

    scheduleAccountDeletion: Effect.fnUntraced(function* (
      browser: AuthenticatedBrowser,
      statement: AccountDeletionStatement,
      revocation: SignedRevocation,
    ) {
      const now = yield* Clock.currentTimeMillis;
      const scheduledFor = yield* scheduleAccountDeletionEffect(
        db,
        browser,
        statement,
        revocation,
        config,
        now,
      );
      yield* wakeNotifications;
      return scheduledFor;
    }),

    accountsDueForDeletion: Effect.fnUntraced(function* () {
      const now = yield* Clock.currentTimeMillis;
      return yield* Effect.tryPromise({
        try: async () => {
          const rows = await db
            .selectFrom('users')
            .select('id')
            .where('deletion_scheduled_at', 'is not', null)
            .where('deletion_scheduled_at', '<=', now)
            .orderBy('deletion_scheduled_at', 'asc')
            .execute();
          return rows.flatMap((row) => (row.id === null ? [] : [row.id]));
        },
        catch: infrastructureError('auth', 'accounts-due-for-deletion'),
      });
    }),

    purgeAccount(userId) {
      return Effect.tryPromise({
        try: async () => {
          await db.deleteFrom('users').where('id', '=', userId).execute();
        },
        catch: infrastructureError('auth', 'purge-account'),
      });
    },
  };
}

function scheduleAccountDeletionEffect(
  db: Kysely<DatabaseSchema>,
  browser: AuthenticatedBrowser,
  statement: AccountDeletionStatement,
  revocation: SignedRevocation,
  config: AuthServiceConfig,
  now: number,
): Effect.Effect<number, InfrastructureError | AuthError> {
  return withDatabaseTransaction(db, (trx) =>
    tryDatabaseTransactionPromise({
      try: () =>
        scheduleAccountDeletionTransaction(trx, browser, statement, revocation, config, now),
      catch: normalizeAuthInfrastructureError('schedule-account-deletion'),
    }),
  );
}

async function scheduleAccountDeletionTransaction(
  db: Transaction<DatabaseSchema>,
  browser: AuthenticatedBrowser,
  statement: AccountDeletionStatement,
  revocation: SignedRevocation,
  config: AuthServiceConfig,
  now: number,
): Promise<number> {
  const user = await db
    .selectFrom('users')
    .select(['id', 'root_public_key', 'root_key_commitment', 'root_epoch'])
    .where('id', '=', browser.userId)
    .executeTakeFirst();
  if (user === undefined || user.id === null) throw invalidCredentialsError();

  // Every field below is inside the signature, so a mismatch means the
  // statement was not signed for this account in this state: a statement for
  // someone else, or one held over a root rotation, is refused rather than
  // being applied to whatever the row says now.
  if (
    statement.userId !== user.id ||
    statement.rootKeyCommitment !== user.root_key_commitment ||
    statement.rootEpoch !== user.root_epoch ||
    Math.abs(now - statement.issuedAt) > REVOCATION_CLOCK_SKEW_MS
  ) {
    throw invalidCredentialsError();
  }
  const rootPublicKey = decodeUserAuthorizationBytes(
    user.root_public_key,
    USER_AUTHORIZATION_PUBLIC_KEY_BYTES,
    'user root public key',
  );
  if (verifyAccountDeletionStatement(statement, rootPublicKey) === null) {
    throw invalidCredentialsError();
  }

  const scheduledFor = now + ACCOUNT_DELETION_GRACE_MS;
  await db
    .updateTable('users')
    .set({ deletion_scheduled_at: scheduledFor })
    .where('id', '=', user.id)
    .execute();
  // The account goes dormant immediately. Without this the owner's own tab
  // would keep working, and "access cancels the deletion" would have to guess
  // at what access means; with it, signing in is the only access left. The
  // signed revocation is what reaches the daemons, through the outbox it
  // records here.
  await revokeBrowserSessionsTransaction(db, browser, revocation, { kind: 'account' }, config, now);
  await db.deleteFrom('refresh_tokens').where('user_id', '=', user.id).execute();
  return scheduledFor;
}

async function listPasswordResetDevices(
  db: Kysely<DatabaseSchema>,
  userId: string,
): Promise<PasswordResetDevice[]> {
  const rows = await db
    .selectFrom('daemons')
    .select(['name', 'platform', 'box_id'])
    .where('user_id', '=', userId)
    .orderBy('name', 'asc')
    .execute();
  return rows.map((row) => ({ name: row.name, platform: row.platform, box: row.box_id !== null }));
}

interface PasswordResetOutcome {
  readonly session: AuthSessionResult;
  readonly browsers: number;
  readonly machines: number;
  readonly boxes: number;
  readonly contestedBoxes: readonly string[];
}

async function finishPasswordResetTransaction(
  db: Transaction<DatabaseSchema>,
  flow: PasswordResetFlow,
  input: {
    readonly registrationRecord: string;
    readonly rootPublicKey: string;
    readonly client: BrowserClient;
  },
  material: RegistrationMaterial,
  config: AuthServiceConfig,
  now: number,
): Promise<PasswordResetOutcome> {
  const user = await db
    .selectFrom('users')
    .select(['opaque_registration_record', 'root_epoch'])
    .where('id', '=', flow.userId)
    .executeTakeFirst();
  // The mailbox was proven for the account as it stood when the code was
  // requested. A password change or another reset since then moved the
  // credential or the epoch, and this flow has no authority over what the
  // account is now.
  if (
    user === undefined ||
    user.root_epoch !== flow.rootEpoch ||
    credentialFingerprint(user.opaque_registration_record) !== flow.credentialFingerprint
  ) {
    throw invalidFlowError();
  }
  // The same fence again in the write itself, so the replacement lands only on
  // the row that was just read.
  const replaced = await db
    .updateTable('users')
    .set({
      opaque_registration_record: input.registrationRecord,
      root_public_key: input.rootPublicKey,
      root_key_commitment: material.rootKeyCommitment,
      root_epoch: flow.rootEpoch + 1,
      root_envelope_nonce: material.rootEnvelope.nonce,
      root_envelope_ciphertext: material.rootEnvelope.ciphertext,
    })
    .where('id', '=', flow.userId)
    .where('root_epoch', '=', flow.rootEpoch)
    .where('opaque_registration_record', '=', user.opaque_registration_record)
    .executeTakeFirst();
  if (Number(replaced.numUpdatedRows) !== 1) throw invalidFlowError();

  const ended = await activeDelegationTargets(db, flow.userId, now);
  const boxes = await readAccountBoxes(db, flow.userId);
  const machines = await db
    .selectFrom('daemons')
    .select(({ fn }) => fn.countAll<number>().as('count'))
    .where('user_id', '=', flow.userId)
    .executeTakeFirstOrThrow();
  // Queued before the rows that name the boxes are gone: after this
  // transaction the queue is the only record that the containers exist.
  await queueBoxRemovals(db, boxes.owned, now);

  // Everything the discarded root authorized. Dependents first, though each of
  // these also cascades from the row it hangs off.
  await db.deleteFrom('refresh_tokens').where('user_id', '=', flow.userId).execute();
  await db.deleteFrom('delegation_revocation_outbox').where('user_id', '=', flow.userId).execute();
  await db.deleteFrom('delegation_revocations').where('user_id', '=', flow.userId).execute();
  await db.deleteFrom('browser_delegations').where('user_id', '=', flow.userId).execute();
  // A pending or approved claim carries an approval signed by the old root; it
  // must not complete into a machine the new root never approved.
  await db.deleteFrom('daemon_link_claims').where('user_id', '=', flow.userId).execute();
  await db.deleteFrom('link_tokens').where('user_id', '=', flow.userId).execute();
  await db.deleteFrom('daemons').where('user_id', '=', flow.userId).execute();
  // The browsers these reach were signed out above and can no longer ask to be
  // forgotten.
  await db.deleteFrom('push_subscriptions').where('user_id', '=', flow.userId).execute();

  await enqueueBrowserSessionChange(db, flow.userId, {
    issuedDelegationIds: [],
    revokedDelegationIds: ended.map((target) => target.delegationId),
  });
  await enqueueDeviceResync(db, flow.userId);
  await insertDelegation(db, material.certificate, input.client);
  return {
    // Refuses a suspended account, which rolls the whole reset back, and calls
    // off a scheduled erasure: the holder came back.
    session: await issueAuthSession(db, material.certificate, config, now),
    browsers: ended.length,
    machines: Number(machines.count),
    boxes: boxes.owned.length,
    contestedBoxes: boxes.contested,
  };
}

interface StoredUser {
  readonly id: string;
  readonly opaque_registration_record: string;
  readonly root_public_key: string;
  readonly root_key_commitment: string;
  readonly root_epoch: number;
  readonly root_envelope_nonce: string;
  readonly root_envelope_ciphertext: string;
}

function credentialFingerprint(record: string): string {
  return Bun.CryptoHasher.hash('sha256', record, 'hex');
}

async function requireCurrentCredential(
  db: Transaction<DatabaseSchema>,
  userId: string,
  fingerprint: string | null,
): Promise<void> {
  const user = await db
    .selectFrom('users')
    .select('opaque_registration_record')
    .where('id', '=', userId)
    .executeTakeFirst();
  if (
    user === undefined ||
    fingerprint !== credentialFingerprint(user.opaque_registration_record)
  ) {
    throw invalidCredentialsError();
  }
}

async function insertDelegation(
  db: Transaction<DatabaseSchema>,
  certificate: UserDelegationCertificate,
  client: BrowserClient,
): Promise<void> {
  await db
    .insertInto('browser_delegations')
    .values({
      id: certificate.delegationId,
      user_id: certificate.userId,
      root_epoch: certificate.rootEpoch,
      delegate_public_key: certificate.delegatePublicKey,
      certificate_json: serializeUserDelegationCertificate(certificate),
      issued_at: certificate.issuedAt,
      expires_at: certificate.expiresAt,
      revoked_at: null,
      client_browser: client.browser,
      client_platform: client.platform,
      client_installed: client.installed ? 1 : 0,
    })
    .execute();
  await enqueueBrowserSessionChange(db, certificate.userId, {
    issuedDelegationIds: [certificate.delegationId],
    revokedDelegationIds: [],
  });
}

/** Returns whether a new delegation row was inserted, as opposed to reused. */
async function ensureDelegation(
  db: Transaction<DatabaseSchema>,
  certificate: UserDelegationCertificate,
  now: number,
  client: BrowserClient,
): Promise<boolean> {
  const canonical = serializeUserDelegationCertificate(certificate);
  const existing = await findStoredDelegation(db, certificate.delegationId);
  if (existing !== undefined) {
    if (
      existing.user_id === certificate.userId &&
      existing.certificate_json === canonical &&
      existing.revoked_at === null &&
      existing.expires_at > now
    ) {
      return false;
    }
    throw new AuthError({ code: 'invalid_delegation', message: 'Delegation id is unavailable' });
  }
  const activeCount = await db
    .selectFrom('browser_delegations')
    .select(({ fn }) => fn.countAll<number>().as('count'))
    .where('user_id', '=', certificate.userId)
    .where('revoked_at', 'is', null)
    .where('expires_at', '>', now)
    .executeTakeFirstOrThrow();
  if (Number(activeCount.count) >= MAX_ACTIVE_DELEGATIONS) {
    throw new AuthError({
      code: 'delegation_limit',
      message: `At most ${MAX_ACTIVE_DELEGATIONS} browser sessions may be active`,
    });
  }
  await insertDelegation(db, certificate, client);
  return true;
}

function findStoredDelegation(db: Transaction<DatabaseSchema>, delegationId: string) {
  return db
    .selectFrom('browser_delegations')
    .select(['user_id', 'certificate_json', 'expires_at', 'revoked_at'])
    .where('id', '=', delegationId)
    .executeTakeFirst();
}

async function issueAuthSession(
  db: Transaction<DatabaseSchema>,
  certificate: UserDelegationCertificate,
  config: AuthServiceConfig,
  now: number,
): Promise<AuthSessionResult> {
  const refresh = createRefreshToken(
    certificate.userId,
    certificate.delegationId,
    certificate.expiresAt,
    config.tokenHmacSecret,
    now,
  );
  // Checked where sessions are issued, not in one sign-in route: every path
  // that authenticates an existing account ends here, so a suspension cannot be
  // walked around by reaching the account another way. Registration passes
  // because a row created moments ago has nothing set.
  const standing = await db
    .selectFrom('users')
    .select('suspended_at')
    .where('id', '=', certificate.userId)
    .executeTakeFirst();
  if (standing?.suspended_at != null) {
    throw new AuthError({
      code: 'account_suspended',
      message: 'This account is suspended',
    });
  }
  await createRefreshTokenStore(db).insert(refresh.record);
  // Attached to session issuance rather than to one sign-in route: every path
  // that authenticates an account ends here, so none of them can forget to
  // call off a pending erasure. A refresh cannot reach this — scheduling the
  // deletion deletes the account's refresh tokens.
  const cancelled = await db
    .updateTable('users')
    .set({ deletion_scheduled_at: null })
    .where('id', '=', certificate.userId)
    .where('deletion_scheduled_at', 'is not', null)
    .executeTakeFirst();
  const accessToken = await createAccessToken(
    certificate.userId,
    certificate.delegationId,
    certificate.expiresAt,
    config.accessToken,
    new Date(now),
  );
  return sessionResult(
    accessToken,
    {
      userId: certificate.userId,
      delegationId: certificate.delegationId,
      delegationExpiresAt: certificate.expiresAt,
    },
    refresh.record.id,
    refresh.token,
    now,
    Number(cancelled.numUpdatedRows ?? 0n) > 0,
  );
}

function sessionResult(
  accessToken: string,
  browser: AuthenticatedBrowser,
  refreshTokenId: string,
  refreshToken: string,
  now: number,
  deletionCancelled: boolean,
): AuthSessionResult {
  return {
    accessToken,
    deletionCancelled,
    userId: browser.userId,
    delegationId: browser.delegationId,
    delegationExpiresAt: browser.delegationExpiresAt,
    serverTimeMs: now,
    refreshCookieHeader: buildRefreshCookieHeader({
      value: createRefreshCookieValue(refreshTokenId, refreshToken),
      maxAgeSeconds: Math.ceil((browser.delegationExpiresAt - now) / 1_000),
    }),
  };
}

function createAccessTokenEffect(
  browser: AuthenticatedBrowser,
  absoluteExpiresAt: number,
  config: AccessTokenConfig,
  now: number,
): Effect.Effect<string, InfrastructureError> {
  return Effect.tryPromise({
    try: () =>
      createAccessToken(
        browser.userId,
        browser.delegationId,
        absoluteExpiresAt,
        config,
        new Date(now),
      ),
    catch: infrastructureError('auth', 'create-access-token'),
  });
}

interface RegistrationMaterial {
  readonly rootKeyCommitment: string;
  readonly rootEnvelope: RootEnvelope;
  readonly certificate: UserDelegationCertificate;
}

/** A new root's public half, envelope and first delegation, at the epoch it must name. */
function validateRegistrationMaterial(
  input: {
    readonly registrationRecord: string;
    readonly rootPublicKey: string;
    readonly rootEnvelope: RootEnvelope;
    readonly delegationCertificate: UserDelegationCertificate;
  },
  userId: string,
  rootEpoch: number,
  expectedIssuedAt: number,
  expectedExpiresAt: number,
  config: AuthServiceConfig,
  now: number,
): Effect.Effect<RegistrationMaterial, AuthError> {
  return Effect.try({
    try: () => {
      validateOpaqueRegistrationRecord(input.registrationRecord);
      const publicKey = decodeUserAuthorizationBytes(
        input.rootPublicKey,
        USER_AUTHORIZATION_PUBLIC_KEY_BYTES,
        'user root public key',
      );
      const rootKeyCommitment = deriveUserRootKeyCommitment(publicKey);
      const rootEnvelope = validateRootEnvelope(input.rootEnvelope);
      const certificate = verifyUserDelegationCertificate(input.delegationCertificate, publicKey, {
        userId,
        rootKeyCommitment,
        serverOrigin: config.publicOrigin,
        rootEpoch,
        nowMs: now,
      });
      if (certificate === null) throw new Error('Delegation certificate is invalid');
      if (
        certificate.issuedAt !== expectedIssuedAt ||
        certificate.expiresAt !== expectedExpiresAt
      ) {
        throw new Error('Delegation certificate validity does not match its flow');
      }
      return { rootKeyCommitment, rootEnvelope, certificate };
    },
    catch: () =>
      new AuthError({ code: 'invalid_request', message: 'Invalid registration material' }),
  });
}

function verifyDelegationForUser(
  value: UserDelegationCertificate,
  user: StoredUser,
  publicOrigin: string,
  now: number,
): Effect.Effect<UserDelegationCertificate, AuthError> {
  return Effect.try({
    try: () => {
      const publicKey = decodeUserAuthorizationBytes(
        user.root_public_key,
        USER_AUTHORIZATION_PUBLIC_KEY_BYTES,
        'user root public key',
      );
      const certificate = verifyUserDelegationCertificate(value, publicKey, {
        userId: user.id,
        rootKeyCommitment: user.root_key_commitment,
        serverOrigin: publicOrigin,
        rootEpoch: user.root_epoch,
        nowMs: now,
      });
      if (certificate === null) throw invalidDelegationError();
      return certificate;
    },
    catch: invalidDelegationError,
  });
}

function validateRootEnvelope(value: RootEnvelope): RootEnvelope {
  return {
    nonce: validateCanonicalBase64Url(
      value.nonce,
      ROOT_ENVELOPE_NONCE_BYTES,
      'root envelope nonce',
    ),
    ciphertext: validateCanonicalBase64Url(
      value.ciphertext,
      ROOT_ENVELOPE_CIPHERTEXT_BYTES,
      'root envelope ciphertext',
    ),
  };
}

function validateCanonicalBase64Url(value: string, bytes: number, label: string): string {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error(`${label} is malformed`);
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.byteLength !== bytes || decoded.toString('base64url') !== value) {
    throw new Error(`${label} is malformed`);
  }
  return value;
}

function normalizeIdentifier(
  identity: AuthIdentityConfig,
  value: string,
): Effect.Effect<string, AuthError> {
  const normalized = normalizeAccountIdentifier(identity.kind, value);
  if (normalized === null) {
    return authFailure(
      'invalid_request',
      identity.kind === 'email' ? 'Email address is invalid' : 'Username is invalid',
    );
  }
  return Effect.succeed(normalized);
}

function createEmailCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, '0');
}

/**
 * The code is stored as a MAC bound to its flow, so a Redis read yields
 * nothing that finishes a registration, and a code is worthless in any flow
 * but the one it was mailed for.
 */
function emailCodeMac(secret: string, domain: string, flowId: string, code: string): string {
  return new Bun.CryptoHasher('sha256', secret)
    .update(`${domain}\0${flowId}\0${code}`)
    .digest('hex');
}

function findUserByUsername(
  db: Kysely<DatabaseSchema>,
  username: string,
): Effect.Effect<StoredUser | undefined, InfrastructureError> {
  return findUser(db, 'username', username, 'find-user-by-username');
}

function findUserById(
  db: Kysely<DatabaseSchema>,
  userId: string,
): Effect.Effect<StoredUser | undefined, InfrastructureError> {
  return findUser(db, 'id', userId, 'find-user-by-id');
}

function findUser(
  db: Kysely<DatabaseSchema>,
  column: 'id' | 'username',
  value: string,
  operation: string,
): Effect.Effect<StoredUser | undefined, InfrastructureError> {
  return Effect.tryPromise({
    try: () =>
      db
        .selectFrom('users')
        .select([
          'id',
          'opaque_registration_record',
          'root_public_key',
          'root_key_commitment',
          'root_epoch',
          'root_envelope_nonce',
          'root_envelope_ciphertext',
        ])
        .where(column, '=', value)
        .executeTakeFirst(),
    catch: infrastructureError('auth', operation),
  }).pipe(
    Effect.map((row) =>
      row === undefined || row.id === null ? undefined : { ...row, id: row.id },
    ),
  );
}

/**
 * Compiles SQL text only. The active-delegation lookup runs on every
 * authenticated request and its text depends on the query's shape alone, so it
 * is compiled once here instead of rebuilt and recompiled per call.
 */
const sqliteCompiler = new Kysely<DatabaseSchema>({
  dialect: {
    createAdapter: () => new SqliteAdapter(),
    createDriver: () => new DummyDriver(),
    createIntrospector: (db) => new SqliteIntrospector(db),
    // The database dialect's own compiler, not a second one chosen to match it:
    // the text compiled here is run verbatim as a raw query, so it has to be
    // the text the dialect would have produced.
    createQueryCompiler: () => createSqliteQueryCompiler(),
  },
});

// Suspension is a column an operator sets in the database, so it has to bite on
// the next request by itself: every bearer check, refresh, and delegation lookup
// runs this query, and a suspended account matches none of them.
export function activeDelegationQuery(
  db: Kysely<DatabaseSchema>,
  userId: string,
  delegationId: string,
  now: number,
) {
  return db
    .selectFrom('browser_delegations as delegation')
    .innerJoin('users as user', 'user.id', 'delegation.user_id')
    .select([
      'delegation.id as delegation_id',
      'delegation.expires_at as expires_at',
      'delegation.root_epoch as delegation_root_epoch',
      'user.root_epoch as user_root_epoch',
    ])
    .where('delegation.id', '=', delegationId)
    .where('delegation.user_id', '=', userId)
    .where('delegation.revoked_at', 'is', null)
    .where('delegation.expires_at', '>', now)
    .where('user.suspended_at', 'is', null);
}

type ActiveDelegationRow = InferResult<ReturnType<typeof activeDelegationQuery>>[number];

const ACTIVE_DELEGATION_SQL = activeDelegationQuery(sqliteCompiler, '', '', 0).compile().sql;

/** `activeDelegationQuery` compiled once; its parameters bind as delegation id, user id, now. */
export function compileActiveDelegationQuery(
  userId: string,
  delegationId: string,
  now: number,
): CompiledQuery<ActiveDelegationRow> {
  return CompiledQuery.raw(ACTIVE_DELEGATION_SQL, [delegationId, userId, now]);
}

function findActiveDelegation(
  db: Kysely<DatabaseSchema>,
  userId: string,
  delegationId: string,
  now: number,
): Effect.Effect<AuthenticatedBrowser | null, InfrastructureError> {
  return Effect.tryPromise({
    try: async () => {
      const { rows } = await db.executeQuery(
        compileActiveDelegationQuery(userId, delegationId, now),
      );
      const row = rows[0];
      if (
        row === undefined ||
        row.delegation_id === null ||
        row.delegation_root_epoch !== row.user_root_epoch
      ) {
        return null;
      }
      return {
        userId,
        delegationId: row.delegation_id,
        delegationExpiresAt: row.expires_at,
      };
    },
    catch: infrastructureError('auth', 'find-active-delegation'),
  });
}

function rotateRefreshTokenInTransaction(
  db: Kysely<DatabaseSchema>,
  refreshTokenId: string,
  presentedToken: string,
  hmacSecret: string,
  now: number,
) {
  return withDatabaseTransaction(db, (trx) =>
    tryDatabaseTransactionPromise({
      try: () =>
        rotateRefreshToken({
          store: createRefreshTokenStore(trx),
          refreshTokenId,
          presentedToken,
          hmacSecret,
          now,
        }),
      catch: infrastructureError('auth', 'rotate-refresh-token'),
    }),
  );
}

function parseUserDelegationActor(certificate: UserDelegationCertificate): AuthenticatedBrowser {
  try {
    const parsed = JSON.parse(
      serializeUserDelegationCertificate(certificate),
    ) as UserDelegationCertificate;
    return {
      userId: parsed.userId,
      delegationId: parsed.delegationId,
      delegationExpiresAt: parsed.expiresAt,
    };
  } catch {
    throw new AuthError({
      code: 'invalid_delegation',
      message: 'Delegation certificate is invalid',
    });
  }
}

function revokeBrowserSessionsEffect(
  db: Kysely<DatabaseSchema>,
  browser: AuthenticatedBrowser,
  proof: SignedRevocation,
  semantics: RevocationSemantics,
  config: AuthServiceConfig,
  now: number,
): Effect.Effect<number, InfrastructureError | AuthError> {
  return withDatabaseTransaction(db, (trx) =>
    tryDatabaseTransactionPromise({
      try: () => revokeBrowserSessionsTransaction(trx, browser, proof, semantics, config, now),
      catch: normalizeAuthInfrastructureError('revoke-browser-sessions'),
    }),
  );
}

async function revokeBrowserSessionsTransaction(
  db: Transaction<DatabaseSchema>,
  browser: AuthenticatedBrowser,
  proof: SignedRevocation,
  semantics: RevocationScope,
  config: AuthServiceConfig,
  now: number,
): Promise<number> {
  let parsedStatement: DelegationRevocationStatement;
  let actorCertificateJson: string;
  try {
    parsedStatement = parseDelegationRevocationStatement(proof.revocation);
    actorCertificateJson = serializeUserDelegationCertificate(proof.actorCertificate);
  } catch {
    throw invalidDelegationError();
  }
  const revocationJson = JSON.stringify(parsedStatement);
  const replay = await db
    .selectFrom('delegation_revocations')
    .select(['user_id', 'actor_certificate_json', 'revocation_json', 'revoked_count'])
    .where('nonce', '=', parsedStatement.nonce)
    .executeTakeFirst();
  if (replay !== undefined) {
    if (
      replay.user_id === browser.userId &&
      replay.actor_certificate_json === actorCertificateJson &&
      replay.revocation_json === revocationJson
    ) {
      return replay.revoked_count;
    }
    throw invalidDelegationError();
  }
  const userRow = await db
    .selectFrom('users')
    .select(['id', 'root_public_key', 'root_key_commitment', 'root_epoch'])
    .where('id', '=', browser.userId)
    .executeTakeFirst();
  const actorRow = await db
    .selectFrom('browser_delegations')
    .select(['id', 'delegate_public_key', 'certificate_json', 'expires_at', 'revoked_at'])
    .where('id', '=', browser.delegationId)
    .where('user_id', '=', browser.userId)
    .executeTakeFirst();
  if (
    userRow?.id === null ||
    userRow === undefined ||
    actorRow?.id === null ||
    actorRow === undefined
  ) {
    throw invalidDelegationError();
  }
  const rootPublicKey = decodeUserAuthorizationBytes(
    userRow.root_public_key,
    USER_AUTHORIZATION_PUBLIC_KEY_BYTES,
    'user root public key',
  );
  const actorCertificate = verifyUserDelegationCertificate(proof.actorCertificate, rootPublicKey, {
    userId: browser.userId,
    rootKeyCommitment: userRow.root_key_commitment,
    delegationId: browser.delegationId,
    serverOrigin: config.publicOrigin,
    rootEpoch: userRow.root_epoch,
    nowMs: actorRow.revoked_at === null ? now : parsedStatement.issuedAt,
  });
  if (
    actorCertificate === null ||
    serializeUserDelegationCertificate(actorCertificate) !== actorRow.certificate_json
  ) {
    throw invalidDelegationError();
  }
  const actorPublicKey = decodeUserAuthorizationBytes(
    actorRow.delegate_public_key,
    USER_AUTHORIZATION_PUBLIC_KEY_BYTES,
    'delegate public key',
  );
  const statement = verifyDelegationRevocationStatement(proof.revocation, actorPublicKey);
  if (statement === null) throw invalidDelegationError();
  const canonicalStatement = parseDelegationRevocationStatement(statement);
  if (
    canonicalStatement.userId !== browser.userId ||
    canonicalStatement.rootKeyCommitment !== userRow.root_key_commitment ||
    canonicalStatement.actorDelegationId !== browser.delegationId ||
    canonicalStatement.issuedAt > now + REVOCATION_CLOCK_SKEW_MS ||
    canonicalStatement.issuedAt < now - USER_DELEGATION_LIFETIME_MS - REVOCATION_CLOCK_SKEW_MS
  ) {
    throw invalidDelegationError();
  }
  if (actorRow.revoked_at !== null) {
    const target = canonicalStatement.targets[0];
    if (
      semantics.kind === 'self' &&
      canonicalStatement.targets.length === 1 &&
      target?.delegationId === browser.delegationId &&
      target.expiresAt === actorRow.expires_at
    ) {
      return 0;
    }
    throw invalidDelegationError();
  }
  if (actorRow.expires_at <= now) throw invalidDelegationError();

  const active = await activeDelegationTargets(db, browser.userId, now);
  const expectedIds = expectedRevocationTargets(active, browser.delegationId, semantics);
  const actualIds = canonicalStatement.targets.map((target) => target.delegationId);
  if (!sameStrings(expectedIds, actualIds)) throw invalidDelegationError();
  const activeById = new Map(active.map((target) => [target.delegationId, target.expiresAt]));
  if (
    canonicalStatement.targets.some(
      (target) => activeById.get(target.delegationId) !== target.expiresAt,
    )
  ) {
    throw invalidDelegationError();
  }

  let revoked = 0;
  for (const target of canonicalStatement.targets) {
    const result = await db
      .updateTable('browser_delegations')
      .set({ revoked_at: now })
      .where('id', '=', target.delegationId)
      .where('user_id', '=', browser.userId)
      .where('revoked_at', 'is', null)
      .executeTakeFirst();
    revoked += Number(result.numUpdatedRows);
    await createRefreshTokenStore(db).deleteByDelegationId(target.delegationId);
  }
  await persistDelegationRevocation(db, actorCertificate, canonicalStatement, revoked, now);
  await enqueueBrowserSessionChange(db, browser.userId, {
    issuedDelegationIds: [],
    revokedDelegationIds: canonicalStatement.targets.map((target) => target.delegationId),
  });
  return revoked;
}

type DelegationTarget = {
  readonly delegationId: string;
  readonly expiresAt: number;
};

async function activeDelegationTargets(
  db: Kysely<DatabaseSchema> | Transaction<DatabaseSchema>,
  userId: string,
  now: number,
): Promise<DelegationTarget[]> {
  const rows = await db
    .selectFrom('browser_delegations')
    .select(['id', 'expires_at'])
    .where('user_id', '=', userId)
    .where('revoked_at', 'is', null)
    .where('expires_at', '>', now)
    .execute();
  return rows
    .flatMap((row) =>
      row.id === null ? [] : [{ delegationId: row.id, expiresAt: row.expires_at }],
    )
    .sort((left, right) => compareCanonicalIds(left.delegationId, right.delegationId));
}

async function persistDelegationRevocation(
  db: Transaction<DatabaseSchema>,
  actorCertificate: UserDelegationCertificate,
  statement: DelegationRevocationStatement,
  revokedCount: number,
  now: number,
): Promise<void> {
  const actorCertificateJson = serializeUserDelegationCertificate(actorCertificate);
  const revocationJson = JSON.stringify(statement);
  await db
    .insertInto('delegation_revocations')
    .values({
      nonce: statement.nonce,
      user_id: statement.userId,
      actor_delegation_id: statement.actorDelegationId,
      actor_certificate_json: actorCertificateJson,
      revocation_json: revocationJson,
      revoked_count: revokedCount,
      created_at: now,
    })
    .execute();
  const daemons = await db
    .selectFrom('daemons')
    .select('id')
    .where('user_id', '=', statement.userId)
    .execute();
  for (const daemon of daemons) {
    if (daemon.id === null) continue;
    await db
      .insertInto('delegation_revocation_outbox')
      .values({
        command_id: randomUUID(),
        revocation_nonce: statement.nonce,
        daemon_id: daemon.id,
        user_id: statement.userId,
        actor_certificate_json: actorCertificateJson,
        revocation_json: revocationJson,
        created_at: now,
        acknowledged_at: null,
        rejected_reason: null,
      })
      .execute();
  }
}

function expectedRevocationTargets(
  active: readonly { readonly delegationId: string }[],
  actorDelegationId: string,
  semantics: RevocationScope,
): string[] {
  if (semantics.kind === 'self') return [actorDelegationId];
  if (semantics.kind === 'one') return [semantics.delegationId];
  return active
    .map((row) => row.delegationId)
    .filter((delegationId) => semantics.kind === 'account' || delegationId !== actorDelegationId)
    .sort(compareCanonicalIds);
}

function compareCanonicalIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

interface SyntheticAccountMaterial {
  readonly userId: string;
  readonly rootPublicKey: string;
  readonly rootEnvelope: RootEnvelope;
}

function syntheticAccountMaterial(
  secret: string,
  normalizedUsername: string,
): SyntheticAccountMaterial {
  // TOKEN_HMAC_SECRET already has stable, production-grade entropy. Domain separation keeps this
  // discovery material independent from refresh/link-token MACs. Rotating that shared secret also
  // changes future provisional IDs and synthetic root material for usernames not yet registered;
  // stored accounts and already-created authentication flows retain their recorded IDs.
  const userIdBytes = expandSyntheticAccountField(secret, normalizedUsername, 'user-id', 32);
  const rootPublicKeyBytes = expandSyntheticAccountField(
    secret,
    normalizedUsername,
    'root-public-key',
    USER_AUTHORIZATION_PUBLIC_KEY_BYTES,
  );
  const nonceBytes = expandSyntheticAccountField(
    secret,
    normalizedUsername,
    'root-envelope-nonce',
    ROOT_ENVELOPE_NONCE_BYTES,
  );
  const ciphertextBytes = expandSyntheticAccountField(
    secret,
    normalizedUsername,
    'root-envelope-ciphertext',
    ROOT_ENVELOPE_CIPHERTEXT_BYTES,
  );
  try {
    return {
      userId: userIdBytes.toString('base64url').slice(0, ENTITY_ID_CHARS),
      rootPublicKey: rootPublicKeyBytes.toString('base64url'),
      rootEnvelope: {
        nonce: nonceBytes.toString('base64url'),
        ciphertext: ciphertextBytes.toString('base64url'),
      },
    };
  } finally {
    userIdBytes.fill(0);
    rootPublicKeyBytes.fill(0);
    nonceBytes.fill(0);
    ciphertextBytes.fill(0);
  }
}

function expandSyntheticAccountField(
  secret: string,
  normalizedUsername: string,
  field: string,
  length: number,
): Buffer {
  const output = Buffer.allocUnsafe(length);
  const domain = Buffer.from(`${AUTH_DISCOVERY_DOMAIN}\0${field}\0${normalizedUsername}\0`, 'utf8');
  const counterBytes = Buffer.allocUnsafe(4);
  let offset = 0;
  try {
    for (let counter = 0; offset < length; counter += 1) {
      counterBytes.writeUInt32BE(counter);
      const block = new Bun.CryptoHasher('sha512', secret)
        .update(domain)
        .update(counterBytes)
        .digest();
      const copied = Math.min(block.byteLength, length - offset);
      block.copy(output, offset, 0, copied);
      block.fill(0);
      offset += copied;
    }
    return output;
  } finally {
    domain.fill(0);
    counterBytes.fill(0);
  }
}

function invalidCredentialsError(): AuthError {
  return new AuthError({
    code: 'invalid_credentials',
    message: 'Invalid username or password',
  });
}

function emailNotAcceptedError(): AuthError {
  return new AuthError({
    code: 'email_not_accepted',
    message: 'This address cannot be used to create an account',
  });
}

function emailNotAccepted(): Effect.Effect<never, AuthError> {
  return Effect.fail(emailNotAcceptedError());
}

function invalidDelegationError(): AuthError {
  return new AuthError({ code: 'invalid_delegation', message: 'Delegation proof is invalid' });
}

function invalidFlowError(): AuthError {
  return new AuthError({
    code: 'invalid_flow',
    message: 'Authentication flow is invalid or expired',
  });
}

function invalidFlow(): Effect.Effect<never, AuthError> {
  return Effect.fail(invalidFlowError());
}

/** A username server proves no mailbox, so it has nothing to reset a password with. */
function resetUnavailable(): Effect.Effect<never, AuthError> {
  return authFailure('invalid_request', 'This server does not reset passwords');
}

function invalidCredentials(): Effect.Effect<never, AuthError> {
  return Effect.fail(invalidCredentialsError());
}

function authFailure(code: AuthErrorCode, message: string): Effect.Effect<never, AuthError> {
  return Effect.fail(new AuthError({ code, message }));
}

function normalizeAuthInfrastructureError(operation: string) {
  return (error: unknown): InfrastructureError | AuthError =>
    error instanceof AuthError ? error : infrastructureError('auth', operation)(error);
}
