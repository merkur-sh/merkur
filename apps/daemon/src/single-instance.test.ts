import { afterEach, beforeEach, expect, test } from 'bun:test';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Effect } from 'effect';
import vector from '../../../packages/shared/test-vectors/user-authorization-mldsa87.json';
import { compileArguments, releaseIdentity } from '../../../scripts/compile-daemon-cli';

import { createLogger } from './logger';
import { acquireDaemonInstanceLockEffect, DaemonAlreadyRunningError } from './single-instance';

const logger = createLogger('single-instance-test');

let lockDir: string;
let lockPath: string;

beforeEach(async () => {
  lockDir = await mkdtemp(path.join(tmpdir(), 'merkur-lock-'));
  lockPath = path.join(lockDir, 'daemon.lock');
});

afterEach(async () => {
  await rm(lockDir, { recursive: true, force: true });
});

async function acquireScoped(): Promise<void> {
  await Effect.runPromise(Effect.scoped(acquireDaemonInstanceLockEffect(lockPath, logger)));
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

test('acquires a fresh lock and releases it when the scope closes', async () => {
  await acquireScoped();
  // Ownership ends with the descriptor; the inode remains stable.
  expect(await fileExists(lockPath)).toBe(true);
});

test('release preserves a replacement lock with a different byte representation', async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* acquireDaemonInstanceLockEffect(lockPath, logger);
        yield* Effect.promise(() => writeFile(lockPath, `\uFEFF${process.pid}\n`, 'utf8'));
      }),
    ),
  );
  expect(await fileExists(lockPath)).toBe(true);
});

test('reclaims a lock left behind by a previous re-exec (same pid)', async () => {
  // Simulates `bun --watch` re-execing in place: the lock file persists with
  // our own pid because finalizers never ran on the previous run.
  await writeFile(lockPath, `${process.pid}\n`, { mode: 0o600 });
  await expect(acquireScoped()).resolves.toBeUndefined();
});

test('acquires an unlocked file whose pid is not alive', async () => {
  // 2^31 - 2 is effectively never a live pid on these platforms.
  await writeFile(lockPath, '2147483646\n', { mode: 0o600 });
  await expect(acquireScoped()).resolves.toBeUndefined();
});

test('does not treat a live PID in an unlocked file as ownership', async () => {
  // pid 1 (launchd/init) is always alive; signalling it yields EPERM, which
  // isProcessAlive treats as alive.
  await writeFile(lockPath, '1\n', { mode: 0o600 });
  await expect(acquireScoped()).resolves.toBeUndefined();
});

test('refuses a concurrent process while the holder has not written its PID', async () => {
  const modulePath = new URL('./single-instance.ts', import.meta.url).href;
  const script = `
    import { mock } from 'bun:test';
    import * as fs from 'node:fs/promises';
    import { Effect } from 'effect';
import vector from '../../../packages/shared/test-vectors/user-authorization-mldsa87.json';
import { compileArguments, releaseIdentity } from '../../../scripts/compile-daemon-cli';
    const original = { ...fs };
    mock.module('node:fs/promises', () => ({ ...original, open: async (...args) => {
      const handle = await original.open(...args);
      const write = handle.writeFile.bind(handle);
      handle.writeFile = async (...values) => {
        process.stdout.write('created\\n');
        await new Promise(resolve => process.stdin.once('data', resolve));
        return write(...values);
      };
      return handle;
    }}));
    const { acquireDaemonInstanceLockEffect } = await import(${JSON.stringify(modulePath)});
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      yield* acquireDaemonInstanceLockEffect(process.argv[1], { warn() {} });
      process.stdout.write('owned\\n');
      yield* Effect.promise(() => new Promise(resolve => process.stdin.once('end', resolve)));
    })));
  `;
  const holder = Bun.spawn([process.execPath, '-e', script, lockPath], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  try {
    const reader = holder.stdout.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('created\n');
    let rejected = false;
    try {
      await acquireScoped();
    } catch (error) {
      rejected = error instanceof DaemonAlreadyRunningError;
    }
    expect(rejected).toBe(true);
    holder.stdin.write('publish');
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('owned\n');
    holder.stdin.end();
    expect(await holder.exited).toBe(0);
  } finally {
    holder.kill('SIGKILL');
    await holder.exited;
  }
});

test.each(['bun', 'node'] as const)(
  'does not pass the lock descriptor to a %s child',
  async (api) => {
    const modulePath = new URL('./single-instance.ts', import.meta.url).href;
    const script = `
    import { Effect } from 'effect';
    import { spawn } from 'node:child_process';
    import { acquireDaemonInstanceLockEffect } from ${JSON.stringify(modulePath)};
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      yield* acquireDaemonInstanceLockEffect(process.argv[1], { warn() {} });
      const args = ['-e', "process.stdout.write('ready'); setInterval(() => {}, 1000)"];
      const child = ${api === 'bun' ? "Bun.spawn([process.execPath, ...args], { stdin: 'ignore', stdout: 'pipe', stderr: 'inherit' })" : "spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'inherit'] })"};
      ${api === 'bun' ? 'yield* Effect.promise(() => child.stdout.getReader().read());' : "yield* Effect.promise(() => new Promise(resolve => child.stdout.once('data', resolve)));"}
      process.stdout.write(String(child.pid));
      process.stdin.resume();
      yield* Effect.never;
    })));
  `;
    const holder = Bun.spawn([process.execPath, '-e', script, lockPath], {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'inherit',
    });
    let childPid: number | undefined;
    try {
      childPid = Number(new TextDecoder().decode((await holder.stdout.getReader().read()).value));
      if (!Number.isSafeInteger(childPid) || childPid <= 0)
        throw new Error('Child did not publish a PID');
      holder.kill('SIGKILL');
      await holder.exited;
      process.kill(childPid, 0);
      await expect(acquireScoped()).resolves.toBeUndefined();
    } finally {
      holder.kill('SIGKILL');
      await holder.exited;
      if (childPid !== undefined && childPid > 0) process.kill(childPid, 'SIGKILL');
    }
  },
);

test('the compiled daemon uses the same kernel instance lock', async () => {
  const binary = path.join(lockDir, 'merkur');
  const compile = Bun.spawn(
    [process.execPath, ...compileArguments(releaseIdentity({ MERKUR_VERSION: 'dev' }), binary)],
    { stdout: 'pipe', stderr: 'pipe' },
  );
  const output = new Response(compile.stderr).text();
  expect(await compile.exited, await output).toBe(0);
  const home = path.join(lockDir, 'home');
  const root = path.join(home, '.merkur');
  await mkdir(root, { recursive: true });
  await writeFile(
    path.join(root, 'config.json'),
    JSON.stringify({
      daemon_id: vector.daemonBinding.daemonId,
      server_origin: vector.serverOrigin,
      daemon_identity_seal: { backend: 'software', material: vector.daemonIdentitySeedBase64Url },
      shell: '/bin/sh',
      webtransport_port: 44433,
      session_token_verify_key: vector.rootPublicKey,
      user_root_public_key: vector.rootPublicKey,
      root_epoch: vector.rootEpoch,
      daemon_binding: vector.daemonBinding,
      revoked_delegations: [],
    }),
  );
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* acquireDaemonInstanceLockEffect(
          path.join(root, `daemon-${vector.daemonBinding.daemonId}.lock`),
          logger,
        );
        yield* Effect.promise(async () => {
          const daemon = Bun.spawn([binary, 'daemon'], {
            env: { ...process.env, MERKUR_DAEMON_HOME: home, LOG_LEVEL: 'error' },
            stdout: 'pipe',
            stderr: 'pipe',
          });
          const errors = new Response(daemon.stderr).text();
          const logs = new Response(daemon.stdout).text();
          expect(await daemon.exited).toBe(1);
          expect((await errors) + (await logs)).toContain('daemon_already_running');
        });
      }),
    ),
  );
}, 60_000);
