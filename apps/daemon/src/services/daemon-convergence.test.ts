import { describe, expect, spyOn, test } from 'bun:test';
import * as filesystem from 'node:fs/promises';
import { chmod, mkdir, mkdtemp, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Deferred, Effect, Fiber } from 'effect';

import type { DaemonConfig } from '../config';
import { createLogger } from '../logger';
import { convergeEffect, type ReleaseStager } from './daemon-convergence';
import {
  activateReleaseEffect,
  DaemonUpdateTrustError,
  persistReleaseTrustFloorEffect,
  readReleaseTrustFloorEffect,
  stageReleaseEffect,
} from './daemon-release';
import { DATAPLANE_ADOPT_ENV } from './dataplane-adoption';
import type { DataplaneCommandResult } from './dataplane-client';

const logger = createLogger('daemon-convergence-test');

class Replaced extends Error {
  constructor(
    readonly file: string,
    readonly args: readonly string[],
    readonly env: NodeJS.ProcessEnv,
  ) {
    super('replaced');
  }
}

async function stagedInstall(
  release: string,
  sequence = 42,
): Promise<{
  readonly installRoot: string;
  readonly versionDirectory: string;
}> {
  const installRoot = await mkdtemp(path.join(os.tmpdir(), 'merkur-converge-'));
  const versionDirectory = path.join(installRoot, 'versions', release);
  await mkdir(versionDirectory, { recursive: true });
  for (const name of ['merkur', 'merkur-dataplane', 'merkur-image-worker', 'merkur-tui']) {
    const file = path.join(versionDirectory, name);
    await writeFile(file, '#!/bin/sh\n');
    await chmod(file, 0o755);
  }
  await writeFile(
    path.join(versionDirectory, 'release-trust.json'),
    `${JSON.stringify({ manifestSha512: 'ab'.repeat(64), sequence })}\n`,
  );
  return { installRoot, versionDirectory };
}

function context(
  installRoot: string,
  upgrade: (executable: string, socketPath: string) => DataplaneCommandResult,
) {
  const decisions: string[] = [];
  const preparedIds: string[] = [];
  const upgrades: Array<{ executable: string; socketPath: string }> = [];
  return {
    upgrades,
    decisions,
    preparedIds,
    value: {
      // SAFETY: convergence reads only the origin, which the release store is fetched from.
      config: { server_origin: 'https://merkur.test' } as DaemonConfig,
      logger,
      installRoot,
      dataplane: {
        commitUpgradeEffect: (_id: string, preparedId: string) =>
          Effect.sync(() => {
            decisions.push(`commit:${preparedId}`);
            return { status: 'accepted' } as const;
          }),
        abortUpgradeEffect: (_id: string, preparedId: string) =>
          Effect.sync(() => {
            decisions.push(`abort:${preparedId}`);
            return { status: 'accepted' } as const;
          }),
        dataplanePid: () => 4242,
        prepareUpgradeEffect: (commandId: string, executable: string, socketPath: string) =>
          Effect.sync(() => {
            upgrades.push({ executable, socketPath });
            preparedIds.push(commandId);
            return upgrade(executable, socketPath);
          }),
      },
      execve: (file: string, args: readonly string[], env: NodeJS.ProcessEnv): never => {
        throw new Replaced(file, args, env);
      },
    },
  };
}

const stagerFor = (versionDirectory: string): ReleaseStager => ({
  stage: () => Effect.succeed(versionDirectory),
  request: () => Effect.void,
});

describe('convergence', () => {
  test('refuses a cached release below the current floor before handover', async () => {
    const { installRoot, versionDirectory } = await stagedInstall('v1.0.0', 41);
    try {
      const current = path.join(installRoot, 'versions', 'v2.0.0');
      await mkdir(current);
      await symlink(current, path.join(installRoot, 'current'));
      await Effect.runPromise(
        persistReleaseTrustFloorEffect(installRoot, {
          manifestSha512: 'cd'.repeat(64),
          sequence: 42,
        }),
      );
      const harness = context(installRoot, () => ({ status: 'accepted' }));
      const failure = await Effect.runPromise(
        convergeEffect(
          harness.value,
          {
            ...stagerFor(versionDirectory),
            stage: (release) =>
              stageReleaseEffect({ installRoot, logger, origin: 'https://merkur.test', release }),
          },
          'v1.0.0',
        ).pipe(
          Effect.catchDefect((defect) => Effect.succeed(defect)),
          Effect.catch((error) => Effect.succeed(error)),
        ),
      );
      process.stdout.write(
        `${JSON.stringify({
          workload: 'cached-below-floor',
          upgrades: harness.upgrades.length,
          execs: failure instanceof Replaced ? 1 : 0,
          currentUnchanged: (await readlink(path.join(installRoot, 'current'))) === current,
        })}\n`,
      );
      expect(failure instanceof DaemonUpdateTrustError).toBe(true);
      expect(harness.decisions).toEqual([`abort:${harness.preparedIds[0]}`]);
      expect(failure).not.toBeInstanceOf(Replaced);
      expect(await readlink(path.join(installRoot, 'current'))).toBe(current);
    } finally {
      await rm(installRoot, { recursive: true, force: true });
    }
  });

  test.each(['different manifest', 'missing identity', 'invalid identity', 'missing hash'])(
    'refuses cached activation with %s before handover',
    async (scenario) => {
      const { installRoot, versionDirectory } = await stagedInstall('v2.0.0');
      try {
        const identity = path.join(versionDirectory, 'release-trust.json');
        if (scenario === 'missing identity') await rm(identity);
        if (scenario === 'invalid identity') await writeFile(identity, '{}\n');
        if (scenario === 'missing hash') {
          await writeFile(identity, `${JSON.stringify({ manifestSha512: null, sequence: 42 })}\n`);
        }
        const current = path.join(installRoot, 'versions', 'v1.0.0');
        await mkdir(current);
        await symlink(current, path.join(installRoot, 'current'));
        await Effect.runPromise(
          persistReleaseTrustFloorEffect(installRoot, {
            manifestSha512: 'cd'.repeat(64),
            sequence: 42,
          }),
        );
        const harness = context(installRoot, () => ({ status: 'accepted' }));
        const failure = await Effect.runPromise(
          Effect.flip(convergeEffect(harness.value, stagerFor(versionDirectory), 'v2.0.0')),
        );
        expect(failure instanceof DaemonUpdateTrustError).toBe(true);
        expect(harness.decisions).toEqual([`abort:${harness.preparedIds[0]}`]);
        expect(await readlink(path.join(installRoot, 'current'))).toBe(current);
      } finally {
        await rm(installRoot, { recursive: true, force: true });
      }
    },
  );

  test('checks the embedded floor when no durable floor exists', async () => {
    const { installRoot, versionDirectory } = await stagedInstall('v2.0.0');
    const previousSequence = process.env.MERKUR_RELEASE_SEQUENCE;
    try {
      process.env.MERKUR_RELEASE_SEQUENCE = '43';
      const error = await Effect.runPromise(
        Effect.flip(
          activateReleaseEffect({ logger, installRoot, versionDirectory, running: null }),
        ),
      );
      expect(error.message).toContain('below rollback floor 43');
      expect(await Bun.file(path.join(installRoot, 'current', 'merkur')).exists()).toBe(false);
    } finally {
      if (previousSequence === undefined) delete process.env.MERKUR_RELEASE_SEQUENCE;
      else process.env.MERKUR_RELEASE_SEQUENCE = previousSequence;
      await rm(installRoot, { recursive: true, force: true });
    }
  });

  test.each([41, 42])(
    'activates an allowed cached release at floor %d without fetching',
    async (floor) => {
      const { installRoot, versionDirectory } = await stagedInstall('v2.0.0');
      const fetchSpy = spyOn(globalThis, 'fetch');
      try {
        await Effect.runPromise(
          persistReleaseTrustFloorEffect(installRoot, {
            manifestSha512: 'ab'.repeat(64),
            sequence: floor,
          }),
        );
        const harness = context(installRoot, () => ({ status: 'accepted' }));
        const failure = await Effect.runPromise(
          convergeEffect(
            harness.value,
            {
              ...stagerFor(versionDirectory),
              stage: (release) =>
                stageReleaseEffect({ installRoot, logger, origin: 'https://merkur.test', release }),
            },
            'v2.0.0',
          ).pipe(Effect.catchDefect((defect) => Effect.succeed(defect))),
        );
        expect(failure).toBeInstanceOf(Replaced);
        expect(harness.upgrades).toHaveLength(1);
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(await readlink(path.join(installRoot, 'current'))).toBe(versionDirectory);
      } finally {
        fetchSpy.mockRestore();
        await rm(installRoot, { recursive: true, force: true });
      }
    },
  );

  test.each(['activation', 'floor advancement'])(
    'excludes concurrent trust changes during %s',
    async (owner) => {
      const { installRoot, versionDirectory } = await stagedInstall('v2.0.0');
      const reached = Promise.withResolvers<void>();
      const resume = Promise.withResolvers<void>();
      const rename = filesystem.rename;
      const target = path.join(
        installRoot,
        owner === 'activation' ? 'current' : 'release-trust.json',
      );
      const renameSpy = spyOn(filesystem, 'rename').mockImplementation(async (from, to) => {
        if (to === target) {
          reached.resolve();
          await resume.promise;
        }
        return rename(from, to);
      });
      const activate = activateReleaseEffect({
        logger,
        installRoot,
        versionDirectory,
        running: null,
      });
      const advance = persistReleaseTrustFloorEffect(installRoot, {
        manifestSha512: 'cd'.repeat(64),
        sequence: 43,
      });
      const pending = Effect.runPromise(owner === 'activation' ? activate : advance);
      try {
        await reached.promise;
        const error = await Effect.runPromise(
          Effect.flip(owner === 'activation' ? advance : activate),
        );
        expect(error.message).toContain('another update owns');
        resume.resolve();
        await pending;
        if (owner === 'activation') {
          expect(await readlink(path.join(installRoot, 'current'))).toBe(versionDirectory);
          await Effect.runPromise(advance);
        } else {
          const rejected = await Effect.runPromise(Effect.flip(activate));
          expect(rejected.message).toContain('below rollback floor 43');
          expect(await Bun.file(path.join(installRoot, 'current', 'merkur')).exists()).toBe(false);
        }
        expect(await Effect.runPromise(readReleaseTrustFloorEffect(installRoot, 1))).toEqual({
          manifestSha512: 'cd'.repeat(64),
          sequence: 43,
        });
      } finally {
        resume.resolve();
        await pending;
        renameSpy.mockRestore();
        await rm(installRoot, { recursive: true, force: true });
      }
    },
  );

  test('points current at the release, hands the terminal over, then replaces this process', async () => {
    const { installRoot, versionDirectory } = await stagedInstall('v2.0.0');
    try {
      const harness = context(installRoot, () => ({ status: 'accepted' }));
      const failure = await Effect.runPromise(
        convergeEffect(harness.value, stagerFor(versionDirectory), 'v2.0.0').pipe(
          Effect.catchDefect((defect) => Effect.succeed(defect)),
          Effect.catch((error) => Effect.succeed(error)),
        ),
      );
      expect(failure).toBeInstanceOf(Replaced);
      if (!(failure instanceof Replaced)) throw new Error('not replaced');
      expect(await readlink(path.join(installRoot, 'current'))).toBe(versionDirectory);
      const socketPath = path.join(installRoot, 'run', `dataplane-${process.pid}.sock`);
      expect(harness.upgrades).toEqual([
        { executable: path.join(versionDirectory, 'merkur-dataplane'), socketPath },
      ]);
      expect(harness.decisions).toEqual([`commit:${harness.preparedIds[0]}`]);
      expect(failure.file).toBe(path.join(versionDirectory, 'merkur'));
      expect(failure.args).toEqual([path.join(versionDirectory, 'merkur'), 'daemon']);
      expect(failure.env[DATAPLANE_ADOPT_ENV]).toBe(`4242:${socketPath}`);
    } finally {
      await rm(installRoot, { recursive: true, force: true });
    }
  });

  test('a refused upgrade fails and leaves this process running', async () => {
    const { installRoot, versionDirectory } = await stagedInstall('v2.0.0');
    try {
      const harness = context(installRoot, () => ({
        status: 'rejected',
        reason: 'upgrade_unavailable',
      }));
      const failure = await Effect.runPromise(
        Effect.flip(convergeEffect(harness.value, stagerFor(versionDirectory), 'v2.0.0')),
      );
      expect(failure.message).toContain('upgrade_unavailable');
      expect(harness.decisions).toEqual([`abort:${harness.preparedIds[0]}`]);
      await expect(readlink(path.join(installRoot, 'current'))).rejects.toThrow();
    } finally {
      await rm(installRoot, { recursive: true, force: true });
    }
  });
  test('activation failure aborts preparation without committing or replacing either process', async () => {
    const { installRoot, versionDirectory } = await stagedInstall('v2.0.0');
    try {
      // A directory at current makes the atomic activation rename fail.
      await mkdir(path.join(installRoot, 'current'));
      const harness = context(installRoot, () => ({ status: 'accepted' }));
      const failure = await Effect.runPromise(
        Effect.flip(convergeEffect(harness.value, stagerFor(versionDirectory), 'v2.0.0')),
      );
      expect(failure).toBeInstanceOf(Error);
      expect(harness.decisions).toEqual([`abort:${harness.preparedIds[0]}`]);
      expect(harness.upgrades).toHaveLength(1);
    } finally {
      await rm(installRoot, { recursive: true, force: true });
    }
  });
  test('cancellation while preparing aborts before activation after the prepared acknowledgement', async () => {
    const { installRoot, versionDirectory } = await stagedInstall('v2.0.0');
    try {
      const harness = context(installRoot, () => ({ status: 'accepted' }));
      await Effect.runPromise(
        Effect.gen(function* () {
          const entered = yield* Deferred.make<void>();
          const prepared = yield* Deferred.make<void>();
          const original = harness.value.dataplane.prepareUpgradeEffect;
          harness.value.dataplane.prepareUpgradeEffect = (id, executable, socketPath) =>
            Effect.gen(function* () {
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(prepared);
              return yield* original(id, executable, socketPath);
            });
          const fiber = yield* convergeEffect(
            harness.value,
            stagerFor(versionDirectory),
            'v2.0.0',
          ).pipe(Effect.forkChild);
          yield* Deferred.await(entered);
          // Immediate interruption injection at the preparation barrier, with no elapsed-time guess.
          fiber.interruptUnsafe();
          yield* Deferred.succeed(prepared, undefined);
          yield* Fiber.await(fiber);
        }),
      );
      expect(harness.decisions).toEqual([`abort:${harness.preparedIds[0]}`]);
      await expect(readlink(path.join(installRoot, 'current'))).rejects.toThrow();
    } finally {
      await rm(installRoot, { recursive: true, force: true });
    }
  });
  test('a lost preparation acknowledgement is aborted before another attempt gets a fresh token', async () => {
    const { installRoot, versionDirectory } = await stagedInstall('v2.0.0');
    try {
      const harness = context(installRoot, () => ({
        status: 'rejected',
        reason: 'dataplane_ack_timeout',
      }));
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const failure = await Effect.runPromise(
          Effect.flip(convergeEffect(harness.value, stagerFor(versionDirectory), 'v2.0.0')),
        );
        expect(failure.message).toContain('dataplane_ack_timeout');
      }
      expect(new Set(harness.preparedIds).size).toBe(2);
      expect(harness.decisions).toEqual(harness.preparedIds.map((id) => `abort:${id}`));
      await expect(readlink(path.join(installRoot, 'current'))).rejects.toThrow();
    } finally {
      await rm(installRoot, { recursive: true, force: true });
    }
  });
});
