import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { type Client, createClient } from '@libsql/client';
import { Context, Effect, Layer, Redacted } from 'effect';
import { Kysely } from 'kysely';

import { ServerConfigService } from '../config';
import { LibsqlDialect } from './libsql-dialect';
import type { DatabaseSchema } from './types';

const FILE_URL_PREFIX = 'file:';
const IN_MEMORY_URL = ':memory:';

export class DatabaseService extends Context.Service<DatabaseService, Kysely<DatabaseSchema>>()(
  'DatabaseService',
) {}

export const DatabaseLive = Layer.effect(
  DatabaseService,
  Effect.gen(function* () {
    const config = yield* ServerConfigService;
    return yield* Effect.acquireRelease(
      Effect.sync(() =>
        createDatabase(
          config.dbUrl,
          config.dbAuthToken === undefined ? undefined : Redacted.value(config.dbAuthToken),
        ),
      ),
      (database) => Effect.promise(() => database.destroy()),
    );
  }),
);

/**
 * The database is reached by URL, and the URL alone decides how.
 *
 * `http(s)://` and `libsql://` speak to a libSQL server over the network, which
 * is what production runs so that more than one process can share one database.
 * `file:` and `:memory:` open a local database in-process, which is what tests
 * and local development use. Both are the same engine and the same SQL; only
 * the transport differs, so a local test exercises the dialect that production
 * exercises.
 *
 * The compiled server binary resolves `@libsql/client` to its pure-JavaScript
 * build (`--conditions=workerd` in the Dockerfile), because the local driver is
 * a native module and the signed runtime deliberately carries no `node_modules`
 * for one to live in. A local URL therefore fails in production, loudly, rather
 * than reaching for a file on a container's disk.
 */
export function createDatabase(url: string, authToken: string | undefined): Kysely<DatabaseSchema> {
  return new Kysely<DatabaseSchema>({
    dialect: new LibsqlDialect(createDatabaseClient(url, authToken)),
  });
}

export function createDatabaseClient(url: string, authToken: string | undefined): Client {
  ensureLocalDatabaseDirectory(url);
  return createClient({ url, authToken });
}

/**
 * A local database is opened by raw path and fails with an opaque "unable to
 * open database file" if its parent directory is missing. Creating it is a
 * no-op once it exists, and means nothing has to create `./data` by hand.
 */
function ensureLocalDatabaseDirectory(url: string): void {
  if (!url.startsWith(FILE_URL_PREFIX)) return;
  const filePath = url.slice(FILE_URL_PREFIX.length);
  if (filePath.length === 0 || filePath === IN_MEMORY_URL) return;
  mkdirSync(dirname(filePath), { recursive: true });
}
