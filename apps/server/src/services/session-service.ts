import {
  createSessionAuthorizationToken,
  deriveDaemonIdentityKeyCommitment,
  deriveSessionRequestCommitment,
} from '@merkur/auth';
import { normalizeEdgeWebTransportUrl, spanAttributes } from '@merkur/shared';
import { type DaemonBinding, parseDaemonBinding } from '@merkur/shared/user-authorization';
import { Clock, Context, Data, Effect, Fiber, Layer } from 'effect';

import { ServerConfigService } from '../config';
import { createLogger, logWithLoggerEffect } from '../logger';
import type { AuthenticatedBrowser } from './auth-service';
import { type DaemonControlDeliveryError, DaemonControlServiceTag } from './daemon-control-service';
import { DeviceServiceTag } from './device-service';
import { createEdgeAttachTicketIssuer } from './edge-attach-ticket';
import { EdgeRegistryServiceTag } from './edge-registry-service';
import { selectEdge } from './edge-selection';
import type { InfrastructureError } from './errors';
import { RealtimeCoordinationServiceTag } from './realtime-coordination-service';
import type { RedisError } from './redis-service';
import type { SessionIssuanceStateError } from './session-issuance-contract';
import { SessionIssuanceConflictError } from './session-issuance-contract';
import { type SessionIssuanceError, SessionIssuanceServiceTag } from './session-issuance-service';
import { retireCancelledSession, retireSupersededSession } from './session-retirement';

export class DaemonNotConnectedError extends Data.TaggedError('DaemonNotConnectedError') {}
export class DelegationMismatchError extends Data.TaggedError('DelegationMismatchError') {}
export class EdgeTemporarilyUnavailableError extends Data.TaggedError(
  'EdgeTemporarilyUnavailableError',
) {}
export class SessionIdentityStateError extends Data.TaggedError('SessionIdentityStateError')<{
  readonly daemonId: string;
  readonly cause: unknown;
}> {}

interface SessionRequestInput {
  readonly daemonId: string;
  readonly browserNodeId: string;
  readonly delegationId: string;
  readonly clientNonce: string;
  readonly encapsulationKey: string;
  readonly issuanceId: string;
  readonly supersedesIssuanceId?: string;
}

interface SessionRenewalInput {
  readonly daemonId: string;
  readonly browserNodeId: string;
  readonly delegationId: string;
  readonly sessionId: string;
  readonly commitment: string;
  /** The edge the session's attachments dial, whose hashes the answer states. */
  readonly edgeWtUrl: string;
}

interface SessionResponse {
  readonly daemonId: string;
  readonly daemonIdentityPublicKey: string;
  readonly daemonIdentityP256PublicKey: string;
  readonly daemonBinding: DaemonBinding;
  readonly sessionToken: string;
  readonly sessionTokenExpiresAtMs: number;
  readonly sessionTokenExpiresInMs: number;
  readonly sessionId: string;
  readonly edgeWtUrl: string;
  readonly edgeCertHashes: string[];
  readonly edgeAttachTicket: string;
}

type SessionPrincipal = Pick<AuthenticatedBrowser, 'userId' | 'delegationId'>;

export type SessionRenewalError =
  | InfrastructureError
  | SessionIdentityStateError
  | DaemonNotConnectedError
  | DelegationMismatchError
  | RedisError;

export type SessionRequestError =
  | SessionRenewalError
  | SessionIssuanceError
  | DaemonControlDeliveryError
  | EdgeTemporarilyUnavailableError;

export type SessionCancellationError =
  | RedisError
  | SessionIssuanceStateError
  | DaemonControlDeliveryError;

export interface SessionService {
  request(
    principal: SessionPrincipal,
    input: SessionRequestInput,
    browserIp: string | null,
    diagnostics: SessionRequestDiagnostics,
  ): Effect.Effect<SessionResponse, SessionRequestError>;
  renew(
    principal: SessionPrincipal,
    input: SessionRenewalInput,
  ): Effect.Effect<
    {
      readonly sessionToken: string;
      readonly sessionTokenExpiresInMs: number;
      /**
       * The named edge's certificate hashes as its registration states them
       * now, or null while the registry holds no live registration for it.
       */
      readonly edgeCertHashes: string[] | null;
    },
    SessionRenewalError
  >;
  cancel(userId: string, issuanceId: string): Effect.Effect<void, SessionCancellationError>;
  revokeAll(userId: string): Effect.Effect<void, RedisError>;
}

export class SessionServiceTag extends Context.Service<SessionServiceTag, SessionService>()(
  'SessionService',
) {}

export interface SessionRequestDiagnostics {
  sameUserPresenceEstablished?: boolean;
  requestSucceeded?: boolean;
  presenceMs?: number;
  edgeLookupMs?: number;
  prepareMs?: number;
  deliveryMs?: number;
  issuanceMs?: number;
}

function measureEffect<A, E, R>(
  effect: Effect.Effect<A, E, R>,
  record: (elapsedMs: number) => void,
): Effect.Effect<A, E, R> {
  return Effect.suspend(() => {
    const startedAt = performance.now();
    return effect.pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          record(performance.now() - startedAt);
        }),
      ),
    );
  });
}

export const SessionServiceLive = Layer.effect(
  SessionServiceTag,
  Effect.gen(function* () {
    const config = yield* ServerConfigService;
    const coordination = yield* RealtimeCoordinationServiceTag;
    const daemonControl = yield* DaemonControlServiceTag;
    const deviceService = yield* DeviceServiceTag;
    const edgeRegistry = yield* EdgeRegistryServiceTag;
    const sessionIssuance = yield* SessionIssuanceServiceTag;
    const logger = createLogger('session-service');
    const edgeAttachTickets = createEdgeAttachTicketIssuer(config.edgeAttachTicketKey);

    const resolveIdentity = Effect.fnUntraced(function* (userId: string, daemonId: string) {
      const identity = yield* deviceService.getDaemonSessionIdentity(userId, daemonId);
      if (identity === null) return yield* new DaemonNotConnectedError();
      return yield* Effect.try({
        try: () => {
          const binding = parseDaemonBinding(JSON.parse(identity.daemonBindingJson));
          const commitment = deriveDaemonIdentityKeyCommitment(
            Buffer.from(identity.daemonIdentityPublicKey, 'base64url'),
            Buffer.from(identity.daemonIdentityP256PublicKey, 'base64url'),
          );
          if (
            binding.userId !== userId ||
            binding.daemonId !== daemonId ||
            binding.daemonIdentityKeyCommitment !== commitment
          ) {
            throw new Error('Linked daemon identity does not match its binding');
          }
          return {
            daemonIdentityPublicKey: identity.daemonIdentityPublicKey,
            daemonIdentityP256PublicKey: identity.daemonIdentityP256PublicKey,
            binding,
            commitment,
          };
        },
        catch: (cause) => new SessionIdentityStateError({ daemonId, cause }),
      });
    });

    const renew = Effect.fnUntraced(function* (
      principal: SessionPrincipal,
      input: SessionRenewalInput,
    ) {
      if (input.delegationId !== principal.delegationId) {
        return yield* Effect.fail(new DelegationMismatchError());
      }
      const identity = yield* resolveIdentity(principal.userId, input.daemonId);
      // The edge rotates its certificate under live sessions; each renewal
      // restates the one the session's attachments dial.
      const edgeWtUrl = normalizeEdgeWebTransportUrl(input.edgeWtUrl);
      const edge = (yield* edgeRegistry.listHealthyEdges()).find(
        (registration) => registration.edgeWtUrl === edgeWtUrl,
      );
      const issuedAtMs = yield* Clock.currentTimeMillis;
      return {
        edgeCertHashes: edge === undefined ? null : [...edge.certHashes],
        sessionTokenExpiresInMs: config.sessionTokenTtlMs,
        sessionToken: createSessionAuthorizationToken({
          userId: principal.userId,
          delegationId: principal.delegationId,
          browserNodeId: input.browserNodeId,
          daemonId: input.daemonId,
          sessionId: input.sessionId,
          daemonIdentityKeyCommitment: identity.commitment,
          sessionRequestCommitment: input.commitment,
          issuedAtMs,
          expiresAtMs: issuedAtMs + config.sessionTokenTtlMs,
          signingKey: config.sessionTokenSigningKey,
        }),
      };
    });
    const request = Effect.fnUntraced(function* (
      principal: SessionPrincipal,
      input: SessionRequestInput,
      browserIp: string | null,
      diagnostics: SessionRequestDiagnostics,
    ) {
      if (input.delegationId !== principal.delegationId) {
        return yield* Effect.fail(new DelegationMismatchError());
      }

      const clientNonce = Buffer.from(input.clientNonce, 'base64url');
      const encapsulationKey = Buffer.from(input.encapsulationKey, 'base64url');
      const sessionRequestCommitment = deriveSessionRequestCommitment(
        clientNonce,
        encapsulationKey,
      );

      if (input.supersedesIssuanceId === input.issuanceId) {
        return yield* new SessionIssuanceConflictError({
          issuanceId: input.issuanceId,
        });
      }

      // Resolve and commit the currently linked identity before touching
      // a predecessor. An invalid or unowned successor must not cancel a
      // valid in-flight session.
      const daemonIdentity = yield* resolveIdentity(principal.userId, input.daemonId);
      const daemonIdentityPublicKey = daemonIdentity.daemonIdentityPublicKey;
      const daemonIdentityP256PublicKey = daemonIdentity.daemonIdentityP256PublicKey;
      const daemonBinding = daemonIdentity.binding;
      const daemonIdentityKeyCommitment = daemonIdentity.commitment;

      if (input.supersedesIssuanceId !== undefined) {
        const superseded = yield* sessionIssuance.supersede({
          userId: principal.userId,
          delegationId: principal.delegationId,
          predecessorIssuanceId: input.supersedesIssuanceId,
          successorIssuanceId: input.issuanceId,
          daemonId: input.daemonId,
          browserNodeId: input.browserNodeId,
          daemonIdentityKeyCommitment,
          sessionRequestCommitment,
        });
        if (superseded._tag === 'Cancelled') {
          yield* retireSupersededSession(
            superseded,
            principal.userId,
            coordination,
            daemonControl,
            logger,
          );
        }
      }

      const response = yield* measureEffect(
        sessionIssuance.issue(
          {
            issuanceId: input.issuanceId,
            userId: principal.userId,
            delegationId: principal.delegationId,
            daemonId: input.daemonId,
            browserNodeId: input.browserNodeId,
            daemonIdentityKeyCommitment,
            sessionRequestCommitment,
          },
          {
            prepare: (sessionId) =>
              measureEffect(
                Effect.scoped(
                  Effect.gen(function* () {
                    const measuredHealthyEdges = measureEffect(
                      edgeRegistry.listHealthyEdges(),
                      (elapsedMs) => {
                        diagnostics.edgeLookupMs = elapsedMs;
                      },
                    );
                    const healthyEdgesFiber = yield* measuredHealthyEdges.pipe(Effect.forkScoped);

                    const issuedAtMs = yield* Clock.currentTimeMillis;
                    const expiresAtMs = issuedAtMs + config.sessionTokenTtlMs;
                    const sessionToken = createSessionAuthorizationToken({
                      userId: principal.userId,
                      delegationId: principal.delegationId,
                      browserNodeId: input.browserNodeId,
                      daemonId: input.daemonId,
                      sessionId,
                      daemonIdentityKeyCommitment,
                      sessionRequestCommitment,
                      issuedAtMs,
                      expiresAtMs,
                      signingKey: config.sessionTokenSigningKey,
                    });
                    const presence = yield* measureEffect(
                      coordination.createSessionForDaemonPresence({
                        sessionId,
                        userId: principal.userId,
                        daemonId: input.daemonId,
                        browserNodeId: input.browserNodeId,
                      }),
                      (elapsedMs) => {
                        diagnostics.presenceMs = elapsedMs;
                      },
                    );
                    if (presence === null) {
                      return yield* Effect.fail(new DaemonNotConnectedError());
                    }
                    diagnostics.sameUserPresenceEstablished = true;

                    const registrations = yield* Fiber.join(healthyEdgesFiber);
                    // Anchored on the daemon, not the session: the
                    // browser can then dial the edge it will be given
                    // while this request is still in flight.
                    const edge = selectEdge(
                      registrations,
                      input.daemonId,
                      presence.zone,
                      browserIp,
                    );
                    if (edge === null) {
                      return yield* Effect.fail(new EdgeTemporarilyUnavailableError());
                    }

                    return {
                      expiresAtMs,
                      response: {
                        daemonId: input.daemonId,
                        daemonIdentityPublicKey,
                        daemonIdentityP256PublicKey,
                        daemonBinding,
                        controlPresence: presence,
                        sessionToken,
                        sessionTokenExpiresAtMs: expiresAtMs,
                        sessionId,
                        edgeWtUrl: edge.edgeWtUrl,
                        edgeCertHashes: [...edge.certHashes],
                        // Admits this session's browser lanes at any edge,
                        // paired only with a live ticket of this daemon.
                        edgeAttachTicket: edgeAttachTickets.forBrowser(input.daemonId, sessionId),
                        clientNonce: input.clientNonce,
                        encapsulationKey: input.encapsulationKey,
                      },
                    };
                  }),
                ),
                (elapsedMs) => {
                  diagnostics.prepareMs = elapsedMs;
                },
              ),
            deliver: (prepared) =>
              measureEffect(
                daemonControl.startSession({
                  presence: prepared.controlPresence,
                  sessionId: prepared.sessionId,
                  browserNodeId: input.browserNodeId,
                  offer: {
                    userId: principal.userId,
                    delegationId: principal.delegationId,
                    edgeWtUrl: prepared.edgeWtUrl,
                    edgeCertHashes: prepared.edgeCertHashes,
                    clientNonce: prepared.clientNonce,
                    encapsulationKey: prepared.encapsulationKey,
                  },
                }),
                (elapsedMs) => {
                  diagnostics.deliveryMs = elapsedMs;
                },
              ),
            compensate: (sessionId) =>
              coordination.removeSessionForUser({ sessionId, userId: principal.userId }).pipe(
                Effect.catch((error) =>
                  logWithLoggerEffect(logger, 'error', 'session_claim_cleanup_failed', {
                    error: String(error),
                  }),
                ),
              ),
          },
        ),
        (elapsedMs) => {
          diagnostics.issuanceMs = elapsedMs;
        },
      );
      diagnostics.requestSucceeded = true;
      // Same attribute names the edge puts on `edge.session.splice`, so a
      // session can be followed from issuance here to the splice there.
      // The two run in different processes with no shared trace context,
      // so this attribute is what joins them.
      yield* Effect.annotateCurrentSpan(
        spanAttributes({
          'merkur.session.id': response.sessionId,
          'merkur.daemon.id': response.daemonId,
        }),
      );
      const responseTimeMs = yield* Clock.currentTimeMillis;
      return {
        daemonId: response.daemonId,
        daemonIdentityPublicKey: response.daemonIdentityPublicKey,
        daemonIdentityP256PublicKey: response.daemonIdentityP256PublicKey,
        daemonBinding: response.daemonBinding,
        sessionToken: response.sessionToken,
        sessionTokenExpiresAtMs: response.sessionTokenExpiresAtMs,
        sessionTokenExpiresInMs: Math.max(0, response.sessionTokenExpiresAtMs - responseTimeMs),
        sessionId: response.sessionId,
        edgeWtUrl: response.edgeWtUrl,
        edgeCertHashes: response.edgeCertHashes,
        edgeAttachTicket: response.edgeAttachTicket,
      };
    });
    const cancel = Effect.fnUntraced(function* (userId: string, issuanceId: string) {
      const cancellation = yield* sessionIssuance.cancel(userId, issuanceId);
      if (cancellation._tag === 'Cancelled') {
        yield* retireCancelledSession(cancellation, userId, coordination, daemonControl);
      }
    });
    const revokeAll = Effect.fnUntraced(function* (userId: string) {
      const generation = yield* coordination.incrementRevocationGeneration(userId);
      yield* daemonControl.pushRevocationGeneration(userId, generation);
    });
    return { request, renew, cancel, revokeAll } satisfies SessionService;
  }),
);
