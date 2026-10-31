import { Clock, Effect } from 'effect';

import { DatabaseService } from '../db/client';
import { type Logger, logWithLoggerEffect } from '../logger';
import { type InfrastructureError, infrastructureError } from './errors';

export const TOKEN_CLEANUP_INTERVAL = '10 minutes';

const TOKEN_CLEANUP_BATCH_SIZE = 500;

export function cleanupExpiredTokensEffect(
  logger: Logger,
): Effect.Effect<void, InfrastructureError, DatabaseService> {
  return Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const deletedRefresh = yield* deleteExpiredRefreshTokensEffect(now);
    const deletedLink = yield* deleteExpiredLinkTokensEffect(now);
    yield* deleteExpiredPushSubscriptionsEffect(now);
    yield* logWithLoggerEffect(logger, 'info', 'expired_tokens_cleaned', {
      refresh: deletedRefresh,
      link: deletedLink,
    });
  });
}

function deleteExpiredRefreshTokensEffect(
  now: number,
): Effect.Effect<number, InfrastructureError, DatabaseService> {
  return deleteExpiredRowsInBatchesEffect(() =>
    Effect.gen(function* () {
      const db = yield* DatabaseService;
      const staleRefreshTokenIds = db
        .selectFrom('refresh_tokens')
        .select('id')
        .where('expires_at', '<', now)
        .limit(TOKEN_CLEANUP_BATCH_SIZE);

      const deletedRows = yield* Effect.tryPromise({
        try: () =>
          db
            .deleteFrom('refresh_tokens')
            .where('id', 'in', staleRefreshTokenIds)
            .executeTakeFirst(),
        catch: infrastructureError('token-cleanup', 'delete-expired-refresh-tokens'),
      });

      return Number(deletedRows.numDeletedRows);
    }),
  );
}

function deleteExpiredLinkTokensEffect(
  now: number,
): Effect.Effect<number, InfrastructureError, DatabaseService> {
  return deleteExpiredRowsInBatchesEffect(() =>
    Effect.gen(function* () {
      const db = yield* DatabaseService;
      const staleLinkTokenHashes = db
        .selectFrom('link_tokens')
        .select('token_hash')
        .where('expires_at', '<', now)
        .limit(TOKEN_CLEANUP_BATCH_SIZE);

      const deletedRows = yield* Effect.tryPromise({
        try: () =>
          db
            .deleteFrom('link_tokens')
            .where('token_hash', 'in', staleLinkTokenHashes)
            .executeTakeFirst(),
        catch: infrastructureError('token-cleanup', 'delete-expired-link-tokens'),
      });

      return Number(deletedRows.numDeletedRows);
    }),
  );
}

function deleteExpiredPushSubscriptionsEffect(now: number) {
  return deleteExpiredRowsInBatchesEffect(() =>
    Effect.gen(function* () {
      const db = yield* DatabaseService;
      const expired = db
        .selectFrom('push_subscriptions')
        .innerJoin(
          'browser_delegations',
          'browser_delegations.id',
          'push_subscriptions.delegation_id',
        )
        .select('push_subscriptions.id')
        .where('browser_delegations.expires_at', '<=', now)
        .limit(TOKEN_CLEANUP_BATCH_SIZE);
      const deleted = yield* Effect.tryPromise({
        try: () =>
          db.deleteFrom('push_subscriptions').where('id', 'in', expired).executeTakeFirst(),
        catch: infrastructureError('token-cleanup', 'delete-expired-push-subscriptions'),
      });
      return Number(deleted.numDeletedRows);
    }),
  );
}

function deleteExpiredRowsInBatchesEffect(
  deleteBatch: () => Effect.Effect<number, InfrastructureError, DatabaseService>,
): Effect.Effect<number, InfrastructureError, DatabaseService> {
  return Effect.gen(function* () {
    let totalDeleted = 0;

    while (true) {
      const deletedCount = yield* deleteBatch();
      totalDeleted += deletedCount;
      if (deletedCount < TOKEN_CLEANUP_BATCH_SIZE) {
        return totalDeleted;
      }
    }
  });
}
