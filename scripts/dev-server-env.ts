import '../packages/shared/src/e2e-wasm-bun';
import { randomBytes, randomUUID } from 'node:crypto';
import { chmod, open, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { validateOpaqueServerSetup } from '@merkur/auth';
import { ConfigProvider, Effect, Redacted } from 'effect';
import {
  EnvironmentError,
  type EnvironmentRecord,
  resolveEnvironment,
} from '../packages/config/src/environment';
import { loadServerConfig } from '../packages/config/src/server-config';
import type { ServerEnvironmentKey } from '../packages/config/src/server-environment';
import { developmentWebOrigin } from './dev-environment';
import { KEYD_OPAQUE_SERVER_SETUP, newKeydKeySet, writeKeydCredentials } from './keyd';

/** keyd's socket in development, relative to apps/server. */
export const DEVELOPMENT_KEYD_SOCKET = './data/keyd.sock';

/** Where development keeps keyd's keys and attempt log: the server's gitignored data directory. */
export function developmentKeydPaths(root: string, socket: string) {
  const server = path.join(root, 'apps/server');
  return {
    credentials: path.join(server, 'data/keyd/credentials'),
    state: path.join(server, 'data/keyd/state'),
    socket: path.resolve(server, socket),
  };
}

const developmentDefaults = {
  HOST: '127.0.0.1',
  PORT: '3100',
  PUBLIC_ORIGIN: developmentWebOrigin,
  DB_URL: 'file:./data/merkur.db',
  REDIS_URL: 'redis://127.0.0.1:6379',
  AUTH_ALLOW_REGISTRATION: 'true',
  AUTH_IDENTITY: 'username',
  TRUSTED_PROXY_HOPS: '0',
  // Relative to apps/server, where the server runs; `bun run dev` starts keyd on it.
  KEYD_SOCKET: DEVELOPMENT_KEYD_SOCKET,
  // Blackholed TEST-NET-1: local NAT behavior must not depend on a developer's router.
  STUN_SERVERS: '192.0.2.1:3478,192.0.2.1:3479',
} satisfies Partial<Record<ServerEnvironmentKey, string>>;

export const prepareDevelopmentEnvironment = Effect.fnUntraced(function* (
  contents: string,
  overrides: EnvironmentRecord,
  opaquePublicKey: string,
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
  if (existing.EDGE_REGISTRATION_KEYS_JSON === undefined) {
    additions.EDGE_REGISTRATION_KEYS_JSON = JSON.stringify({
      'local-dev-1': randomBytes(64).toString('base64url'),
    });
  }
  // The browser pins keyd's OPAQUE key; a pin for any other key is an identity to repair by hand.
  const pin = existing.VITE_MERKUR_OPAQUE_SERVER_PUBLIC_KEY;
  if (pin === undefined) additions.VITE_MERKUR_OPAQUE_SERVER_PUBLIC_KEY = opaquePublicKey;
  else if (pin !== opaquePublicKey) {
    return yield* new EnvironmentError({
      message:
        "VITE_MERKUR_OPAQUE_SERVER_PUBLIC_KEY is not keyd's OPAQUE key; existing identity was preserved",
    });
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

/**
 * keyd's development keys, generated into `directory` the first time and kept after: replacing
 * them would invalidate every development password and daemon link. Answers the OPAQUE key the
 * browser pins.
 */
export const ensureDevelopmentKeydCredentials = Effect.fnUntraced(function* (directory: string) {
  const setupPath = path.join(directory, KEYD_OPAQUE_SERVER_SETUP);
  const setup = yield* Effect.tryPromise({
    try: async () => {
      try {
        return (await readFile(setupPath, 'utf8')).trim();
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
        const keys = await newKeydKeySet();
        await writeKeydCredentials(directory, keys);
        return keys[KEYD_OPAQUE_SERVER_SETUP] ?? '';
      }
    },
    catch: () => new EnvironmentError({ message: `Cannot provision keyd's keys in ${directory}` }),
  });
  return yield* Effect.tryPromise({
    try: () => validateOpaqueServerSetup(setup),
    catch: () =>
      new EnvironmentError({
        message: `${setupPath} is not an OPAQUE server setup; existing identity was preserved`,
      }),
  });
});

/** A held lock serializes generation; validation completes before an atomic replacement. */
export const ensureDevelopmentServerEnvironment = Effect.fnUntraced(function* (
  envPath: string,
  overrides: EnvironmentRecord,
  keydCredentials: string,
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
      const opaquePublicKey = yield* ensureDevelopmentKeydCredentials(keydCredentials);
      const candidate = yield* prepareDevelopmentEnvironment(current, overrides, opaquePublicKey);
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
