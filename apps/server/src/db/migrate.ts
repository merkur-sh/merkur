import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Effect } from 'effect';
import { Kysely } from 'kysely';
import { FileMigrationProvider, Migrator } from 'kysely/migration';

import { type Logger, logWithLoggerEffect } from '../logger';
import { InfrastructureError, infrastructureError } from '../services/errors';
import { createDatabaseClient, DatabaseService } from './client';
import { LibsqlDialect } from './libsql-dialect';

const CURRENT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIRECTORY = path.join(CURRENT_DIRECTORY, '../../migrations');

export async function createMigratedKyselyDatabase<T>(
  databaseUrl: string,
  authToken?: string,
): Promise<Kysely<T>> {
  const db = new Kysely<T>({
    dialect: new LibsqlDialect(createDatabaseClient(databaseUrl, authToken)),
  });
  const migrator = new Migrator({
    db,
    provider: new FileMigrationProvider({ fs, path, migrationFolder: MIGRATIONS_DIRECTORY }),
  });
  const result = await migrator.migrateToLatest();
  if (result.error !== undefined) {
    await db.destroy();
    throw new Error(`Migration failed: ${String(result.error)}`);
  }
  return db;
}

export function runMigrationsEffect(
  logger: Logger,
): Effect.Effect<void, InfrastructureError, DatabaseService> {
  return Effect.gen(function* () {
    const database = yield* DatabaseService;
    const migrator = new Migrator({
      db: database,
      provider: new FileMigrationProvider({
        fs,
        path,
        migrationFolder: MIGRATIONS_DIRECTORY,
      }),
    });

    const migrationResult = yield* Effect.tryPromise({
      try: () => migrator.migrateToLatest(),
      catch: infrastructureError('database', 'run-migrations'),
    });

    if (migrationResult.error !== undefined) {
      yield* logWithLoggerEffect(logger, 'error', 'migration_failed', {
        error: String(migrationResult.error),
      });
      return yield* Effect.fail(
        new InfrastructureError({
          cause: migrationResult.error,
          message: String(migrationResult.error),
          operation: 'run-migrations',
          service: 'database',
        }),
      );
    }

    for (const migration of migrationResult.results ?? []) {
      yield* logWithLoggerEffect(logger, 'info', 'migration_applied', {
        migrationName: migration.migrationName,
        status: migration.status,
      });
    }
  });
}
