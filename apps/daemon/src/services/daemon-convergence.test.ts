import { describe, expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, readlink, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Effect } from 'effect';

import type { DaemonConfig } from '../config';
import { createLogger } from '../logger';
import { convergeEffect, type ReleaseStager } from './daemon-convergence';
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

async function stagedInstall(release: string): Promise<{
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
  return { installRoot, versionDirectory };
}

function context(
  installRoot: string,
  upgrade: (executable: string, socketPath: string) => DataplaneCommandResult,
) {
  const upgrades: Array<{ executable: string; socketPath: string }> = [];
  return {
    upgrades,
    value: {
      // SAFETY: convergence reads only the origin, which the release store is fetched from.
      config: { server_origin: 'https://merkur.test' } as DaemonConfig,
      logger,
      installRoot,
      dataplane: {
        dataplanePid: () => 4242,
        upgradeEffect: (_commandId: string, executable: string, socketPath: string) =>
          Effect.sync(() => {
            upgrades.push({ executable, socketPath });
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
    } finally {
      await rm(installRoot, { recursive: true, force: true });
    }
  });
});
