import '../packages/shared/src/e2e-wasm-bun';
import { randomBytes, randomUUID } from 'node:crypto';
import { chmod, open, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { createOpaqueServerSetup, validateOpaqueServerSetup } from '@merkur/auth';
import { ConfigProvider, Effect, Redacted } from 'effect';
import {
  EnvironmentError,
  type EnvironmentRecord,
  resolveEnvironment,
} from '../packages/config/src/environment';
import { loadServerConfig } from '../packages/config/src/server-config';
import type { ServerEnvironmentKey } from '../packages/config/src/server-environment';
import { developmentWebOrigin } from './dev-environment';

const developmentDefaults = {
  HOST: '127.0.0.1',
  PORT: '3100',
  PUBLIC_ORIGIN: developmentWebOrigin,
  DB_URL: 'file:./data/merkur.db',
  REDIS_URL: 'redis://127.0.0.1:6379',
  AUTH_ALLOW_REGISTRATION: 'true',
  AUTH_IDENTITY: 'username',
  TRUSTED_PROXY_HOPS: '0',
  // Blackholed TEST-NET-1: local NAT behavior must not depend on a developer's router.
  STUN_SERVERS: '192.0.2.1:3478,192.0.2.1:3479',
} satisfies Partial<Record<ServerEnvironmentKey, string>>;

export const prepareDevelopmentEnvironment = Effect.fnUntraced(function* (
  contents: string,
  overrides: EnvironmentRecord,
) {
  const parsed = yield* resolveEnvironment(contents);
  const existing = Redacted.value(parsed.values);
  const additions: Record<string, string> = {};
  for (const [key, value] of Object.entries(developmentDefaults)) {
    if (existing[key] === undefined) additions[key] = value;
  }
  if (existing.REDIS_URL === undefined && overrides.REDIS_URL !== undefined) {
    additions.REDIS_URL = overrides.REDIS_URL;
  }
  for (const key of [
    'TOKEN_HMAC_SECRET',
    'ACCESS_TOKEN_HMAC_KEY',
    'STUN_TICKET_KEY',
    'EDGE_ATTACH_TICKET_KEY',
  ]) {
    if (existing[key] === undefined) additions[key] = randomBytes(64).toString('base64url');
  }
  if (existing.SESSION_TOKEN_MLDSA87_SEED === undefined) {
    additions.SESSION_TOKEN_MLDSA87_SEED = randomBytes(32).toString('base64url');
  }
  if (existing.EDGE_REGISTRATION_KEYS_JSON === undefined) {
    additions.EDGE_REGISTRATION_KEYS_JSON = JSON.stringify({
      'local-dev-1': randomBytes(64).toString('base64url'),
    });
  }
  const setup = existing.OPAQUE_SERVER_SETUP;
  if (
    setup === undefined &&
    (existing.OPAQUE_SERVER_PUBLIC_KEY !== undefined ||
      existing.VITE_MERKUR_OPAQUE_SERVER_PUBLIC_KEY !== undefined)
  ) {
    return yield* new EnvironmentError({
      message:
        'OPAQUE public-key pin exists without OPAQUE_SERVER_SETUP; repair the identity group explicitly',
    });
  }
  const opaqueSetup =
    setup ??
    (yield* Effect.tryPromise({
      try: createOpaqueServerSetup,
      catch: () => new EnvironmentError({ message: 'Cannot generate OPAQUE setup' }),
    }));
  const publicKey = yield* Effect.tryPromise({
    try: () => validateOpaqueServerSetup(opaqueSetup),
    catch: () =>
      new EnvironmentError({
        message: 'OPAQUE_SERVER_SETUP is invalid; existing identity was preserved',
      }),
  });
  if (setup === undefined) additions.OPAQUE_SERVER_SETUP = opaqueSetup;
  for (const key of ['OPAQUE_SERVER_PUBLIC_KEY', 'VITE_MERKUR_OPAQUE_SERVER_PUBLIC_KEY']) {
    if (existing[key] === undefined) additions[key] = publicKey;
  }
  const next =
    contents +
    (contents === '' || contents.endsWith('\n') ? '' : '\n') +
    Object.entries(additions)
      .map(([key, value]) => `${key}=${encodeValue(value)}\n`)
      .join('');
  // Check the persisted file independently so external overrides cannot conceal corruption.
  const file = yield* resolveEnvironment(next);
  yield* loadServerConfig.pipe(
    Effect.provide(
      ConfigProvider.layer(
        ConfigProvider.fromEnvRecord(Redacted.value(file.values), { preserveEmptyStrings: true }),
      ),
    ),
  );
  const effective = yield* resolveEnvironment(next, overrides);
  const config = yield* loadServerConfig.pipe(
    Effect.provide(
      ConfigProvider.layer(
        ConfigProvider.fromEnvRecord(Redacted.value(effective.values), {
          preserveEmptyStrings: true,
        }),
      ),
    ),
  );
  return { contents: next, added: Object.keys(additions), config };
});

function encodeValue(value: string): string {
  if (value.includes('\n') || value.includes('\r')) {
    throw new EnvironmentError({ message: 'Environment assignments cannot contain line breaks' });
  }
  const escaped = value.replaceAll('$', '\\$');
  for (const quote of ["'", '"', '`']) {
    if (!value.includes(quote)) return `${quote}${escaped}${quote}`;
  }
  if (
    value.includes('#') ||
    value.startsWith('"') ||
    value.startsWith("'") ||
    value.startsWith('`')
  ) {
    throw new EnvironmentError({
      message: 'Environment assignment requires URL-encoded delimiters',
    });
  }
  return escaped;
}

/** A held lock serializes generation; validation completes before an atomic replacement. */
export const ensureDevelopmentServerEnvironment = Effect.fnUntraced(function* (
  envPath: string,
  overrides: EnvironmentRecord,
) {
  const lockPath = `${envPath}.lock`;
  return yield* Effect.scoped(
    Effect.gen(function* () {
      yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: () => open(lockPath, 'wx', 0o600),
          catch: () =>
            new EnvironmentError({
              message: `Cannot acquire ${lockPath}; another setup owns it, or an interrupted setup left the lock for explicit removal`,
            }),
        }),
        (lock) =>
          Effect.promise(async () => {
            await lock.close();
            await unlink(lockPath);
          }),
      );
      const current = yield* Effect.tryPromise({
        try: async () => {
          try {
            return await readFile(envPath, 'utf8');
          } catch (error) {
            if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return '';
            throw error;
          }
        },
        catch: () =>
          new EnvironmentError({ message: 'Cannot read the existing server environment' }),
      });
      const candidate = yield* prepareDevelopmentEnvironment(current, overrides);
      yield* Effect.tryPromise({
        try: async () => {
          if (candidate.contents === current) {
            await chmod(envPath, 0o600);
            return;
          }
          const temporary = `${envPath}.${randomUUID()}.tmp`;
          const file = await open(temporary, 'wx', 0o600);
          try {
            try {
              await file.writeFile(candidate.contents, 'utf8');
              await file.sync();
            } finally {
              await file.close();
            }
            await rename(temporary, envPath);
            const directory = await open(path.dirname(envPath), 'r');
            try {
              await directory.sync();
            } finally {
              await directory.close();
            }
          } finally {
            await unlink(temporary).catch((error: unknown) => {
              if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
                throw error;
            });
          }
        },
        catch: () =>
          new EnvironmentError({
            message: 'Cannot atomically persist the validated server environment',
          }),
      });
      return candidate;
    }).pipe(Effect.uninterruptible),
  );
});
