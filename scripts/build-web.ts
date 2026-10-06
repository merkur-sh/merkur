import '../packages/shared/src/e2e-wasm-bun';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ConfigProvider, Effect, Redacted } from 'effect';
import { EnvironmentError, resolveEnvironment } from '../packages/config/src/environment';
import { serverEnvironment } from '../packages/config/src/server-environment';
import { toolEnvironment } from './dev-environment';

const root = path.resolve(import.meta.dir, '..');

const build = Effect.scoped(
  Effect.gen(function* () {
    const contents = yield* Effect.tryPromise({
      try: () => readFile(path.join(root, 'apps/server/.env'), 'utf8'),
      catch: () =>
        new EnvironmentError({
          message: 'Local web builds read apps/server/.env; run bun run setup',
        }),
    });
    const environment = yield* resolveEnvironment(contents, process.env);
    const pin = yield* serverEnvironment.VITE_MERKUR_OPAQUE_SERVER_PUBLIC_KEY.config
      .parse(
        ConfigProvider.fromEnvRecord(Redacted.value(environment.values), {
          preserveEmptyStrings: true,
        }),
      )
      .pipe(
        Effect.mapError(
          () =>
            new EnvironmentError({
              message: 'VITE_MERKUR_OPAQUE_SERVER_PUBLIC_KEY is required; run bun run setup',
            }),
        ),
      );
    const decoded = Buffer.from(pin, 'base64url');
    if (decoded.length !== 32 || decoded.toString('base64url') !== pin) {
      return yield* new EnvironmentError({
        message: 'VITE_MERKUR_OPAQUE_SERVER_PUBLIC_KEY must be canonical base64url for 32 bytes',
      });
    }
    const env = toolEnvironment(process.env);
    env.VITE_MERKUR_OPAQUE_SERVER_PUBLIC_KEY = pin;
    for (const key of ['MERKUR_VERSION', 'MERKUR_BUILD_ID', 'MERKUR_RELEASE_MLDSA87_PUBLIC_KEY']) {
      const value = process.env[key];
      if (value !== undefined) env[key] = value;
    }
    const child = yield* Effect.acquireRelease(
      Effect.sync(() =>
        Bun.spawn(
          [process.execPath, '--bun', '--no-env-file', 'run', '--cwd', 'apps/web', 'build'],
          {
            cwd: root,
            env,
            stdout: 'inherit',
            stderr: 'inherit',
          },
        ),
      ),
      (child) =>
        Effect.sync(() => {
          if (child.exitCode === null) child.kill();
        }),
    );
    return yield* Effect.promise(() => child.exited);
  }),
);

const outcome = await Effect.runPromise(Effect.result(build));
if (outcome._tag === 'Failure') {
  process.stderr.write(`${outcome.failure.message}\n`);
  process.exitCode = 1;
} else process.exitCode = outcome.success;
