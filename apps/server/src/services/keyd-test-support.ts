/**
 * The real `merkur-keyd` for tests: a key set generated once, and a keyd per test over it with
 * a fresh attempt log, so one test's spent attempts never reach the next. Its socket lives under
 * `/tmp`, which both Bazel sandboxes leave writable and which keeps the path inside the 104
 * bytes a macOS socket address holds.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { Effect, ManagedRuntime } from 'effect';
import {
  keydExecutable,
  newKeydKeySet,
  spawnKeyd,
  writeKeydCredentials,
} from '../../../../scripts/keyd';
import { type KeyService, KeyServiceTag, keydLayer } from './key-service';

const REPOSITORY = path.resolve(import.meta.dir, '../../../..');

/**
 * A credentials directory: a fresh key set (`newKeydKeySet`), or exactly `files`, each the
 * canonical base64url a deployment's file holds. Remove `path.dirname` of it when done.
 */
export async function keydCredentials(files?: Readonly<Record<string, string>>): Promise<string> {
  const directory = path.join(await mkdtemp('/tmp/keyd-'), 'credentials');
  await writeKeydCredentials(directory, files ?? (await newKeydKeySet()));
  return directory;
}

export interface RunningKeyd {
  readonly socket: string;
  stop(): Promise<void>;
}

/** A keyd serving `credentials` with its own attempt log. */
export async function startKeyd(credentials: string): Promise<RunningKeyd> {
  const state = await mkdtemp('/tmp/keyd-state-');
  const socket = path.join(state, 'k.sock');
  const child = await spawnKeyd(
    keydExecutable(REPOSITORY),
    { credentials, state, socket },
    {
      PATH: process.env.PATH ?? '',
      RUST_LOG: 'warn',
    },
  );
  return {
    socket,
    async stop() {
      child.kill('SIGTERM');
      await child.exited;
      await rm(state, { recursive: true, force: true });
    },
  };
}

export interface TestKeyService {
  readonly service: KeyService;
  readonly keyd: RunningKeyd;
  stop(): Promise<void>;
}

/** A `KeyService` over its own keyd, held open until `stop`. */
export async function startTestKeyService(credentials: string): Promise<TestKeyService> {
  const keyd = await startKeyd(credentials);
  const runtime = ManagedRuntime.make(keydLayer(keyd.socket));
  const service = await runtime.runPromise(
    Effect.gen(function* () {
      return yield* KeyServiceTag;
    }),
  );
  return {
    service,
    keyd,
    async stop() {
      await runtime.dispose();
      await keyd.stop();
    },
  };
}
