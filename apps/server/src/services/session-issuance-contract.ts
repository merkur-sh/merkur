import type { DaemonBinding } from '@merkur/shared/user-authorization';
import { Data, type Effect } from 'effect';
import type { DaemonPresence } from './realtime-coordination-service';

export interface SessionIssuanceResponse {
  readonly daemonId: string;
  readonly daemonIdentityPublicKey: string;
  readonly daemonIdentityP256PublicKey: string;
  readonly daemonBinding: DaemonBinding;
  readonly controlPresence: DaemonPresence;
  readonly sessionToken: string;
  readonly sessionTokenExpiresAtMs: number;
  readonly sessionId: string;
  readonly edgeWtUrl: string;
  readonly edgeCertHashes: string[];
  /**
   * The browser's attach ticket for this session and daemon, which every lane
   * of the session presents to the edge. See `edge-attach-ticket.ts`.
   */
  readonly edgeAttachTicket: string;
  readonly clientNonce: string;
  readonly encapsulationKey: string;
}

export interface SessionIssuanceInput {
  readonly issuanceId: string;
  readonly userId: string;
  readonly delegationId: string;
  readonly daemonId: string;
  readonly browserNodeId: string;
  readonly daemonIdentityKeyCommitment: string;
  readonly sessionRequestCommitment: string;
}

export interface SessionIssuanceSupersessionInput {
  readonly userId: string;
  readonly delegationId: string;
  readonly predecessorIssuanceId: string;
  readonly successorIssuanceId: string;
  readonly daemonId: string;
  readonly browserNodeId: string;
  readonly daemonIdentityKeyCommitment: string;
  readonly sessionRequestCommitment: string;
}

export interface SessionIssuanceCallbacks<
  PrepareError = never,
  DeliveryError = never,
  CompensationError = never,
> {
  /**
   * Allocates the server-side session claim and exact response. Crash takeover
   * can overlap a lease-expired predecessor, so this callback must be
   * idempotent for the durable `sessionId`; the record CAS selects one exact
   * prepared response.
   */
  readonly prepare: (sessionId: string) => Effect.Effect<SessionIssuancePreparation, PrepareError>;
  /**
   * Delivers the already-durable response to the daemon. A crash after delivery
   * may repeat this exact message; consumers therefore key it by sessionId.
   */
  readonly deliver: (response: SessionIssuanceResponse) => Effect.Effect<void, DeliveryError>;
  /**
   * Removes the exact prepared claim when preparation fails validation, a
   * pre-delivery credential expires, or allocation fails before publication.
   * Ambiguous delivery failures deliberately retain the prepared claim.
   */
  readonly compensate: (sessionId: string) => Effect.Effect<void, CompensationError>;
}

export interface SessionIssuancePreparation {
  readonly response: SessionIssuanceResponse;
  /** Exact expiry encoded into response.sessionToken. */
  readonly expiresAtMs: number;
}

export type SessionIssuanceCancellation =
  | { readonly _tag: 'Missing' }
  | {
      readonly _tag: 'Cancelled';
      readonly sessionId: string;
      readonly daemonId: string;
      readonly browserNodeId: string;
      /** Previous browser bootstrap, used to reject unsafe same-KEM refreshes. */
      readonly sessionRequestCommitment: string;
    };

export class SessionIssuanceConflictError extends Data.TaggedError('SessionIssuanceConflictError')<{
  readonly issuanceId: string;
}> {}

export class SessionIssuanceCancelledError extends Data.TaggedError(
  'SessionIssuanceCancelledError',
)<{
  readonly issuanceId: string;
}> {}

export class SessionIssuanceExpiredError extends Data.TaggedError('SessionIssuanceExpiredError')<{
  readonly issuanceId: string;
}> {}

export class SessionIssuanceStateError extends Data.TaggedError('SessionIssuanceStateError')<{
  readonly issuanceId: string;
  readonly message: string;
}> {}
