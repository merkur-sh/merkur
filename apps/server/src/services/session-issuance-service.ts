import { randomUUID } from 'node:crypto';
import { Clock, Context, Effect, Exit, Layer, Result } from 'effect';
import {
  preloadRedisScripts,
  type RedisError,
  type RedisService,
  RedisServiceTag,
} from './redis-service';
import {
  type AllocatingSessionIssuance,
  type CancelledSessionIssuance,
  type CommittedSessionIssuance,
  type MissingPredecessorSupersession,
  type PreparedSessionIssuance,
  type StoredSessionIssuance,
  type SupersededSessionIssuance,
  terminalIssuance,
  validPreparation,
} from './session-issuance-codec';
import {
  type SessionIssuanceCallbacks,
  type SessionIssuanceCancellation,
  SessionIssuanceCancelledError,
  SessionIssuanceConflictError,
  SessionIssuanceExpiredError,
  type SessionIssuanceInput,
  type SessionIssuancePreparation,
  type SessionIssuanceResponse,
  SessionIssuanceStateError,
  type SessionIssuanceSupersessionInput,
} from './session-issuance-contract';
import {
  acquireLeaseAndReadSnapshot,
  COMMITTED_ISSUANCE_TTL_MS,
  deleteIfOwner,
  type IssuanceKeys,
  initializeLeaseAndReadSnapshot,
  issuanceKeys,
  readSnapshot,
  reclaimAndAbandon,
  releaseIfOwner,
  replaceIfCurrent,
  SESSION_ISSUANCE_SCRIPTS,
  type StoredSnapshot,
  storeIfCurrent,
  storeIfOwner,
  supersedeAndReserve,
  waitForSnapshotChange,
} from './session-issuance-store';

const CREDENTIAL_EXPIRY_SAFETY_MS = 1_000;

export type SessionIssuanceError =
  | RedisError
  | SessionIssuanceStateError
  | SessionIssuanceConflictError
  | SessionIssuanceCancelledError
  | SessionIssuanceExpiredError;

export interface SessionIssuanceService {
  issue<PrepareError, DeliveryError, CompensationError>(
    input: SessionIssuanceInput,
    callbacks: SessionIssuanceCallbacks<PrepareError, DeliveryError, CompensationError>,
  ): Effect.Effect<SessionIssuanceResponse, SessionIssuanceError | PrepareError | DeliveryError>;
  cancel(
    userId: string,
    issuanceId: string,
  ): Effect.Effect<SessionIssuanceCancellation, RedisError | SessionIssuanceStateError>;
  /**
   * Atomically validates and retires the predecessor of a refreshed bootstrap.
   * A refresh stays in the same user/daemon/browser/identity lineage but must
   * carry a different request commitment (and therefore a newly prepared
   * browser bootstrap) before the predecessor can be cancelled.
   */
  supersede(
    input: SessionIssuanceSupersessionInput,
  ): Effect.Effect<
    SessionIssuanceCancellation,
    RedisError | SessionIssuanceStateError | SessionIssuanceConflictError
  >;
}

export class SessionIssuanceServiceTag extends Context.Service<
  SessionIssuanceServiceTag,
  SessionIssuanceService
>()('SessionIssuanceService') {}

export const SessionIssuanceServiceLive = Layer.effect(
  SessionIssuanceServiceTag,
  Effect.gen(function* () {
    const redis = yield* RedisServiceTag;
    const clock = yield* Clock.Clock;
    yield* preloadRedisScripts(redis, SESSION_ISSUANCE_SCRIPTS);
    return createSessionIssuanceService(redis, () => clock.currentTimeMillisUnsafe());
  }),
);

export function createSessionIssuanceService(
  redis: RedisService,
  now: () => number = Date.now,
): SessionIssuanceService {
  const issueOwned = Effect.fnUntraced(function* <PrepareError, DeliveryError, CompensationError>(
    input: SessionIssuanceInput,
    callbacks: SessionIssuanceCallbacks<PrepareError, DeliveryError, CompensationError>,
    keys: IssuanceKeys,
    initial: AllocatingSessionIssuance,
    owner: string,
  ) {
    const initialization = yield* initializeLeaseAndReadSnapshot(
      redis,
      keys,
      initial,
      owner,
      input.issuanceId,
    ).pipe(Effect.uninterruptible);
    let initializedSnapshot: StoredSnapshot | undefined = initialization.snapshot;
    let currentLease = initialization.lease;
    const acquireCurrentLease = acquireLeaseAndReadSnapshot(
      redis,
      keys,
      owner,
      input.issuanceId,
    ).pipe(Effect.uninterruptible);
    const preparedCandidate: PreparedCandidateCache = { current: null };

    while (true) {
      const snapshot = initializedSnapshot ?? (yield* readSnapshot(redis, keys, input.issuanceId));
      initializedSnapshot = undefined;
      if (snapshot === null) {
        const initialization = yield* initializeLeaseAndReadSnapshot(
          redis,
          keys,
          initial,
          owner,
          input.issuanceId,
        ).pipe(Effect.uninterruptible);
        initializedSnapshot = initialization.snapshot;
        currentLease = initialization.lease;
        continue;
      }
      const initialOutcome = yield* inspectIssuanceSnapshot(redis, keys, input, snapshot, now());
      if (initialOutcome === 'Retry') continue;
      if (initialOutcome !== 'Active') return initialOutcome;

      // Initialization already owns a newly created record's first lease.
      // Every subsequent acquisition atomically re-reads the current record.
      const lease = yield* currentLease;
      currentLease = acquireCurrentLease;
      if (!lease.acquired) {
        yield* waitForSnapshotChange(redis, keys, snapshot.raw, input.issuanceId);
        continue;
      }

      // The lease script atomically returns the post-acquisition snapshot.
      // This preserves the GET→lease fence: a previous owner that commits
      // before acquisition is observed here, never redelivered from the
      // stale snapshot above.
      const leasedSnapshot = lease.snapshot;
      if (leasedSnapshot === null) {
        yield* releaseIfOwner(redis, keys, owner);
        continue;
      }
      const leasedOutcome = yield* inspectIssuanceSnapshot(
        redis,
        keys,
        input,
        leasedSnapshot,
        now(),
      );
      if (leasedOutcome !== 'Active') {
        yield* releaseIfOwner(redis, keys, owner);
        if (leasedOutcome === 'Retry') continue;
        return leasedOutcome;
      }

      let ownedSnapshot = leasedSnapshot;
      if (ownedSnapshot.record.state === 'allocating') {
        const prepared = yield* prepareIssuance(
          redis,
          keys,
          input,
          owner,
          ownedSnapshot.raw,
          ownedSnapshot.record,
          preparedCandidate,
          callbacks,
        );
        if (prepared === null) continue;
        ownedSnapshot = prepared;
      }

      if (ownedSnapshot.record.state !== 'prepared') {
        yield* releaseIfOwner(redis, keys, owner);
        continue;
      }
      if (credentialsExpired(ownedSnapshot.record.expiresAtMs, now())) {
        const expiredRecord = terminalIssuance(ownedSnapshot.record, 'expired');
        const expired = yield* storeIfOwner(
          redis,
          keys,
          owner,
          ownedSnapshot.raw,
          JSON.stringify(expiredRecord),
          true,
          true,
        );
        if (expired) {
          yield* callbacks.compensate(ownedSnapshot.record.sessionId).pipe(Effect.ignore);
          return yield* new SessionIssuanceExpiredError({
            issuanceId: input.issuanceId,
          });
        }
        continue;
      }

      const deliveryExit = yield* Effect.result(callbacks.deliver(ownedSnapshot.record.response));
      if (Result.isFailure(deliveryExit)) {
        yield* reconcileFailedDelivery(
          redis,
          keys,
          input,
          owner,
          ownedSnapshot.raw,
          ownedSnapshot.record,
          deliveryExit.failure,
          callbacks.compensate,
        );
        continue;
      }

      const committedRecord: CommittedSessionIssuance = {
        ...ownedSnapshot.record,
        state: 'committed',
      };
      let committed = yield* storeIfOwner(
        redis,
        keys,
        owner,
        ownedSnapshot.raw,
        JSON.stringify(committedRecord),
        true,
        true,
        COMMITTED_ISSUANCE_TTL_MS,
      );
      if (!committed) {
        // A successful delivery must not be repeated merely because its
        // local lease elapsed while awaiting the daemon receipt. If the
        // exact prepared record is still current, commit it with a record
        // CAS while preserving any newer owner's lease.
        committed = yield* storeIfCurrent(
          redis,
          keys,
          owner,
          ownedSnapshot.raw,
          JSON.stringify(committedRecord),
          COMMITTED_ISSUANCE_TTL_MS,
        );
      }
      if (committed) {
        return committedRecord.response;
      }
      // Cancellation or a crash-takeover owner won while delivery was in
      // flight. Re-read the durable state: a committed peer returns the same
      // response, while cancellation remains authoritative.
    }
  });
  const issue = <PrepareError, DeliveryError, CompensationError>(
    input: SessionIssuanceInput,
    callbacks: SessionIssuanceCallbacks<PrepareError, DeliveryError, CompensationError>,
  ) =>
    Effect.suspend(() => {
      const keys = issuanceKeys(input.userId, input.issuanceId);
      const initial = createAllocatingRecord(input);
      const owner = randomUUID();
      return issueOwned(input, callbacks, keys, initial, owner).pipe(
        // Releasing the exact owner's lease makes takeover immediate after
        // cancellation. Durable allocating/prepared state retains session
        // identity, including an ambiguously delivered response.
        Effect.onExit((exit) =>
          Exit.isFailure(exit)
            ? releaseIfOwner(redis, keys, owner).pipe(Effect.ignore)
            : Effect.void,
        ),
      );
    });

  const cancel = Effect.fnUntraced(function* (userId: string, issuanceId: string) {
    const keys = issuanceKeys(userId, issuanceId);
    while (true) {
      const snapshot = yield* readSnapshot(redis, keys, issuanceId);
      if (snapshot === null) return { _tag: 'Missing' as const };
      if (snapshot.record.userId !== userId) {
        return yield* new SessionIssuanceStateError({
          issuanceId,
          message: 'Session issuance user binding does not match its storage key',
        });
      }
      if (snapshot.record.state === 'superseded_missing') {
        // The tombstone protects against a late predecessor issue; there is
        // no predecessor daemon session or presence to retire.
        return { _tag: 'Missing' as const };
      }
      if (
        snapshot.record.state === 'cancelled' ||
        snapshot.record.state === 'expired' ||
        snapshot.record.state === 'superseded'
      ) {
        return cancellationFrom(snapshot.record);
      }
      const cancelledRecord = terminalIssuance(snapshot.record, 'cancelled');
      const cancelled = yield* replaceIfCurrent(
        redis,
        keys,
        snapshot.raw,
        JSON.stringify(cancelledRecord),
      );
      if (cancelled) return cancellationFrom(cancelledRecord);
    }
  });

  const supersede = Effect.fnUntraced(function* (input: SessionIssuanceSupersessionInput) {
    if (input.successorIssuanceId === input.predecessorIssuanceId) {
      return yield* new SessionIssuanceConflictError({
        issuanceId: input.successorIssuanceId,
      });
    }
    const issuanceId = input.predecessorIssuanceId;
    const keys = issuanceKeys(input.userId, issuanceId);
    const successorKeys = issuanceKeys(input.userId, input.successorIssuanceId);
    const successorInput: SessionIssuanceInput = {
      issuanceId: input.successorIssuanceId,
      userId: input.userId,
      delegationId: input.delegationId,
      daemonId: input.daemonId,
      browserNodeId: input.browserNodeId,
      daemonIdentityKeyCommitment: input.daemonIdentityKeyCommitment,
      sessionRequestCommitment: input.sessionRequestCommitment,
    };
    // Keep one candidate session id across CAS retries. Only the atomic
    // predecessor transition may install it; an independently allocated
    // successor is always a conflict while the predecessor is active.
    const successorCandidate = createAllocatingRecord(successorInput);
    const missingPredecessor = createMissingPredecessorSupersession(input);
    while (true) {
      const snapshot = yield* readSnapshot(redis, keys, issuanceId);
      if (snapshot === null) {
        const reserved = yield* reserveMissingPredecessor(
          redis,
          keys,
          successorKeys,
          successorCandidate,
          missingPredecessor,
        );
        if (reserved) return { _tag: 'Missing' as const };
        continue;
      }
      if (snapshot.record.userId !== input.userId) {
        return yield* new SessionIssuanceStateError({
          issuanceId,
          message: 'Session issuance user binding does not match its storage key',
        });
      }
      if (
        snapshot.record.state === 'superseded_missing' ||
        snapshot.record.state === 'superseded'
      ) {
        if (!hasExactSupersession(snapshot.record, input)) {
          return yield* new SessionIssuanceConflictError({ issuanceId: input.successorIssuanceId });
        }
        const successor = yield* readSnapshot(redis, successorKeys, input.successorIssuanceId);
        if (!hasReservedSuccessor(successor, successorInput, now())) {
          return yield* new SessionIssuanceStateError({
            issuanceId: input.successorIssuanceId,
            message:
              snapshot.record.state === 'superseded_missing'
                ? 'Missing predecessor tombstone lost its exact reserved successor'
                : 'Superseded issuance is missing its exact reserved successor',
          });
        }
        return snapshot.record.state === 'superseded_missing'
          ? { _tag: 'Missing' as const }
          : cancellationFrom(snapshot.record);
      }
      if (!hasFreshSuccessorLineage(snapshot.record, input)) {
        return yield* new SessionIssuanceConflictError({ issuanceId: input.successorIssuanceId });
      }
      const successor = yield* readSnapshot(redis, successorKeys, input.successorIssuanceId);
      const predecessorIsTerminal =
        snapshot.record.state === 'cancelled' || snapshot.record.state === 'expired';
      if (successor !== null) {
        // An active predecessor may only be retired by the transition that
        // creates its successor. Merely finding an independently allocated
        // record with matching public fields is not proof of that lineage.
        if (!predecessorIsTerminal || !hasReservedSuccessor(successor, successorInput, now())) {
          return yield* new SessionIssuanceConflictError({
            issuanceId: input.successorIssuanceId,
          });
        }
        return cancellationFrom(snapshot.record);
      }
      const supersededRecord: SupersededSessionIssuance | null = predecessorIsTerminal
        ? null
        : {
            state: 'superseded',
            issuanceId: snapshot.record.issuanceId,
            userId: snapshot.record.userId,
            delegationId: snapshot.record.delegationId,
            daemonId: snapshot.record.daemonId,
            browserNodeId: snapshot.record.browserNodeId,
            daemonIdentityKeyCommitment: snapshot.record.daemonIdentityKeyCommitment,
            sessionRequestCommitment: snapshot.record.sessionRequestCommitment,
            sessionId: snapshot.record.sessionId,
            successorIssuanceId: input.successorIssuanceId,
            successorSessionRequestCommitment: input.sessionRequestCommitment,
          };
      const replaced = yield* supersedeAndReserve(
        redis,
        keys,
        successorKeys,
        snapshot.raw,
        JSON.stringify(successorCandidate),
        supersededRecord === null ? null : JSON.stringify(supersededRecord),
      );
      if (!replaced) continue;
      if (supersededRecord !== null) return cancellationFrom(supersededRecord);
      if (snapshot.record.state === 'cancelled' || snapshot.record.state === 'expired') {
        return cancellationFrom(snapshot.record);
      }
      return yield* new SessionIssuanceStateError({
        issuanceId,
        message: 'Terminal predecessor changed state during successor reservation',
      });
    }
  });
  return { issue, cancel, supersede } satisfies SessionIssuanceService;
}

interface PreparedCandidateCache {
  current: {
    readonly sessionId: string;
    readonly preparation: SessionIssuancePreparation;
  } | null;
}

const prepareIssuance = Effect.fnUntraced(function* <
  PrepareError,
  DeliveryError,
  CompensationError,
>(
  redis: RedisService,
  keys: IssuanceKeys,
  input: SessionIssuanceInput,
  owner: string,
  allocatingRaw: string,
  allocating: AllocatingSessionIssuance,
  preparedCandidate: PreparedCandidateCache,
  callbacks: SessionIssuanceCallbacks<PrepareError, DeliveryError, CompensationError>,
) {
  let preparation: SessionIssuancePreparation;
  const cachedPreparation = preparedCandidate.current;
  if (cachedPreparation?.sessionId === allocating.sessionId) {
    preparation = cachedPreparation.preparation;
  } else {
    const preparedExit = yield* Effect.result(callbacks.prepare(allocating.sessionId));
    if (Result.isFailure(preparedExit)) {
      yield* abandonPreparation(
        redis,
        keys,
        owner,
        allocatingRaw,
        allocating.sessionId,
        callbacks.compensate,
      );
      return yield* Effect.fail(preparedExit.failure);
    }
    preparation = preparedExit.success;
    preparedCandidate.current = {
      sessionId: allocating.sessionId,
      preparation,
    };
  }
  if (!validPreparation(preparation, allocating)) {
    yield* abandonPreparation(
      redis,
      keys,
      owner,
      allocatingRaw,
      allocating.sessionId,
      callbacks.compensate,
    );
    return yield* new SessionIssuanceStateError({
      issuanceId: input.issuanceId,
      message: 'Prepared session issuance violates its durable identity',
    });
  }

  const preparedRecord: PreparedSessionIssuance = {
    ...allocating,
    state: 'prepared',
    response: preparation.response,
    expiresAtMs: preparation.expiresAtMs,
  };
  const preparedRaw = JSON.stringify(preparedRecord);
  const stored = yield* storeIfOwner(redis, keys, owner, allocatingRaw, preparedRaw, false, false);
  if (!stored) {
    const current = yield* readSnapshot(redis, keys, input.issuanceId);
    if (current === null) {
      yield* callbacks.compensate(allocating.sessionId).pipe(Effect.ignore);
      return yield* new SessionIssuanceExpiredError({
        issuanceId: input.issuanceId,
      });
    }
    if (
      current.record.state === 'superseded_missing' ||
      current.record.sessionId !== allocating.sessionId
    ) {
      yield* callbacks.compensate(allocating.sessionId).pipe(Effect.ignore);
      yield* assertNotMissingSupersession(current, input);
      return yield* new SessionIssuanceStateError({
        issuanceId: input.issuanceId,
        message: 'Session issuance identity changed during preparation',
      });
    }
    if (
      current.record.state === 'cancelled' ||
      current.record.state === 'expired' ||
      current.record.state === 'superseded'
    ) {
      yield* callbacks.compensate(allocating.sessionId).pipe(Effect.ignore);
    }
    return null;
  }
  preparedCandidate.current = null;
  return { raw: preparedRaw, record: preparedRecord };
});

const assertNotMissingSupersession = Effect.fnUntraced(function* (
  snapshot: StoredSnapshot | null,
  input: SessionIssuanceInput,
) {
  if (
    snapshot?.record.state === 'superseded_missing' &&
    hasMissingPredecessorLineage(snapshot.record, input)
  ) {
    return yield* new SessionIssuanceCancelledError({ issuanceId: input.issuanceId });
  }
});

const activeIssuanceSnapshot = Effect.succeed('Active' as const);

function inspectIssuanceSnapshot(
  redis: RedisService,
  keys: IssuanceKeys,
  input: SessionIssuanceInput,
  snapshot: StoredSnapshot,
  nowMs: number,
): Effect.Effect<SessionIssuanceResponse | 'Active' | 'Retry', SessionIssuanceError> {
  const record = snapshot.record;
  if (record.state === 'superseded_missing') {
    return hasMissingPredecessorLineage(record, input)
      ? Effect.fail(new SessionIssuanceCancelledError({ issuanceId: input.issuanceId }))
      : Effect.fail(new SessionIssuanceConflictError({ issuanceId: input.issuanceId }));
  }
  if (!hasBoundIdentity(record, input)) {
    return Effect.fail(new SessionIssuanceConflictError({ issuanceId: input.issuanceId }));
  }
  switch (record.state) {
    case 'allocating':
    case 'prepared':
      return activeIssuanceSnapshot;
    case 'cancelled':
    case 'superseded':
      return Effect.fail(new SessionIssuanceCancelledError({ issuanceId: input.issuanceId }));
    case 'expired':
      return Effect.fail(new SessionIssuanceExpiredError({ issuanceId: input.issuanceId }));
    case 'committed':
      return credentialsExpired(record.expiresAtMs, nowMs)
        ? expireCommittedSnapshot(redis, keys, input.issuanceId, snapshot.raw, record)
        : Effect.succeed(record.response);
  }
}

const expireCommittedSnapshot = Effect.fnUntraced(function* (
  redis: RedisService,
  keys: IssuanceKeys,
  issuanceId: string,
  raw: string,
  record: CommittedSessionIssuance,
) {
  const expired = yield* replaceIfCurrent(
    redis,
    keys,
    raw,
    JSON.stringify(terminalIssuance(record, 'expired')),
  );
  if (expired) return yield* new SessionIssuanceExpiredError({ issuanceId });
  return 'Retry' as const;
});

const abandonPreparation = Effect.fnUntraced(function* <CompensationError>(
  redis: RedisService,
  keys: IssuanceKeys,
  owner: string,
  expectedRaw: string,
  sessionId: string,
  compensate: SessionIssuanceCallbacks<never, never, CompensationError>['compensate'],
) {
  const abandoned = yield* deleteIfOwner(redis, keys, owner, expectedRaw);
  if (abandoned) {
    yield* compensate(sessionId).pipe(Effect.ignore);
  } else {
    yield* reclaimAndAbandon(redis, keys, owner, expectedRaw, sessionId, compensate);
  }
});

const reconcileFailedDelivery = Effect.fnUntraced(function* <DeliveryError, CompensationError>(
  redis: RedisService,
  keys: IssuanceKeys,
  input: SessionIssuanceInput,
  owner: string,
  preparedRaw: string,
  prepared: PreparedSessionIssuance,
  failure: DeliveryError,
  compensate: SessionIssuanceCallbacks<never, never, CompensationError>['compensate'],
) {
  const released = yield* storeIfOwner(redis, keys, owner, preparedRaw, preparedRaw, true, true);
  if (released) {
    return yield* Effect.fail(failure);
  }
  const current = yield* readSnapshot(redis, keys, input.issuanceId);
  if (current !== null && current.raw === preparedRaw) {
    // The lease expired while daemon delivery was in flight, but no
    // durable owner changed the prepared response. Do not turn an
    // ambiguous delivery into an implicit retry in this request;
    // the caller can redeliver the exact response by issuance id.
    return yield* Effect.fail(failure);
  }
  if (
    current === null ||
    current.record.state === 'superseded_missing' ||
    current.record.sessionId !== prepared.sessionId
  ) {
    yield* compensate(prepared.sessionId).pipe(Effect.ignore);
    yield* assertNotMissingSupersession(current, input);
    return yield* Effect.fail(failure);
  }
});

const reserveMissingPredecessor = Effect.fnUntraced(function* (
  redis: RedisService,
  keys: IssuanceKeys,
  successorKeys: IssuanceKeys,
  successor: AllocatingSessionIssuance,
  predecessor: MissingPredecessorSupersession,
) {
  const reserved = yield* supersedeAndReserve(
    redis,
    keys,
    successorKeys,
    null,
    JSON.stringify(successor),
    JSON.stringify(predecessor),
  );
  if (reserved) return true;
  // A predecessor initialized after our read must retry through its ordinary
  // lineage checks; a separately initialized successor cannot prove lineage.
  const racedPredecessor = yield* readSnapshot(redis, keys, predecessor.issuanceId);
  if (racedPredecessor !== null) return false;
  const racedSuccessor = yield* readSnapshot(redis, successorKeys, successor.issuanceId);
  if (racedSuccessor !== null) {
    return yield* new SessionIssuanceConflictError({ issuanceId: successor.issuanceId });
  }
  return false;
});

function hasReservedSuccessor(
  snapshot: StoredSnapshot | null,
  input: SessionIssuanceInput,
  nowMs: number,
): boolean {
  return (
    snapshot !== null &&
    snapshot.record.state !== 'superseded_missing' &&
    hasBoundIdentity(snapshot.record, input) &&
    successorCanBeReserved(snapshot.record, nowMs)
  );
}

function hasFreshSuccessorLineage(
  record: Exclude<StoredSessionIssuance, MissingPredecessorSupersession>,
  input: SessionIssuanceSupersessionInput,
): boolean {
  return (
    record.daemonId === input.daemonId &&
    record.browserNodeId === input.browserNodeId &&
    record.daemonIdentityKeyCommitment === input.daemonIdentityKeyCommitment &&
    record.sessionRequestCommitment !== input.sessionRequestCommitment
  );
}

function hasExactSupersession(
  record: MissingPredecessorSupersession | SupersededSessionIssuance,
  input: SessionIssuanceSupersessionInput,
): boolean {
  return record.state === 'superseded_missing'
    ? hasExactMissingSupersession(record, input)
    : hasFreshSuccessorLineage(record, input) &&
        record.successorIssuanceId === input.successorIssuanceId &&
        record.successorSessionRequestCommitment === input.sessionRequestCommitment;
}

function createAllocatingRecord(input: SessionIssuanceInput): AllocatingSessionIssuance {
  return {
    state: 'allocating',
    issuanceId: input.issuanceId,
    userId: input.userId,
    delegationId: input.delegationId,
    daemonId: input.daemonId,
    browserNodeId: input.browserNodeId,
    daemonIdentityKeyCommitment: input.daemonIdentityKeyCommitment,
    sessionRequestCommitment: input.sessionRequestCommitment,
    sessionId: randomUUID(),
  };
}

function createMissingPredecessorSupersession(
  input: SessionIssuanceSupersessionInput,
): MissingPredecessorSupersession {
  return {
    state: 'superseded_missing',
    issuanceId: input.predecessorIssuanceId,
    userId: input.userId,
    delegationId: input.delegationId,
    daemonId: input.daemonId,
    browserNodeId: input.browserNodeId,
    daemonIdentityKeyCommitment: input.daemonIdentityKeyCommitment,
    successorIssuanceId: input.successorIssuanceId,
    successorSessionRequestCommitment: input.sessionRequestCommitment,
  };
}

function cancellationFrom(
  record: CancelledSessionIssuance | SupersededSessionIssuance,
): SessionIssuanceCancellation {
  return {
    _tag: 'Cancelled',
    sessionId: record.sessionId,
    daemonId: record.daemonId,
    browserNodeId: record.browserNodeId,
    sessionRequestCommitment: record.sessionRequestCommitment,
  };
}

function hasMissingPredecessorLineage(
  record: MissingPredecessorSupersession,
  input: SessionIssuanceInput,
): boolean {
  return (
    record.issuanceId === input.issuanceId &&
    record.userId === input.userId &&
    record.delegationId === input.delegationId &&
    record.daemonId === input.daemonId &&
    record.browserNodeId === input.browserNodeId &&
    record.daemonIdentityKeyCommitment === input.daemonIdentityKeyCommitment
  );
}

function hasExactMissingSupersession(
  record: MissingPredecessorSupersession,
  input: SessionIssuanceSupersessionInput,
): boolean {
  return (
    record.issuanceId === input.predecessorIssuanceId &&
    record.userId === input.userId &&
    record.delegationId === input.delegationId &&
    record.daemonId === input.daemonId &&
    record.browserNodeId === input.browserNodeId &&
    record.daemonIdentityKeyCommitment === input.daemonIdentityKeyCommitment &&
    record.successorIssuanceId === input.successorIssuanceId &&
    record.successorSessionRequestCommitment === input.sessionRequestCommitment
  );
}

function hasBoundIdentity(
  record: Exclude<StoredSessionIssuance, MissingPredecessorSupersession>,
  input: SessionIssuanceInput,
): boolean {
  return (
    record.issuanceId === input.issuanceId &&
    record.userId === input.userId &&
    record.delegationId === input.delegationId &&
    record.daemonId === input.daemonId &&
    record.browserNodeId === input.browserNodeId &&
    record.daemonIdentityKeyCommitment === input.daemonIdentityKeyCommitment &&
    record.sessionRequestCommitment === input.sessionRequestCommitment
  );
}

function successorCanBeReserved(record: StoredSessionIssuance, nowMs: number): boolean {
  if (record.state === 'allocating') return true;
  if (record.state === 'prepared' || record.state === 'committed') {
    return !credentialsExpired(record.expiresAtMs, nowMs);
  }
  return false;
}

function credentialsExpired(expiresAtMs: number, nowMs: number): boolean {
  return nowMs >= expiresAtMs - CREDENTIAL_EXPIRY_SAFETY_MS;
}
