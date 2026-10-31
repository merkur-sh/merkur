import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { merkurRelease, normalizeUnknownError } from '@merkur/shared';
import { type Deferred, Duration, Effect, Predicate, type Queue, Result, Semaphore } from 'effect';

import type { DaemonConfig } from '../config';
import { type Logger, logEffect } from '../logger';
import { DAEMON_INSTANCE_LOCK_FD_ENV } from '../single-instance';
import {
  type DaemonControlHealthReporter,
  type DaemonControlPathSignal,
  type DaemonControlSuperseded,
  runDaemonControlClientEffect,
} from './daemon-control-client';
import {
  activateReleaseEffect,
  resolveVersionedDaemonExecutables,
  stageReleaseEffect,
} from './daemon-release';
import { DATAPLANE_ADOPT_ENV, encodeDataplaneAdoption } from './dataplane-adoption';
import type { DataplaneClient } from './dataplane-client';

/**
 * After a convergence attempt fails, how long before the server's release is read again,
 * doubling to the ceiling: an attempt downloads tens of megabytes, so a failure that repeats
 * (a full disk, a store missing the release) is retried on a minutes scale, not seconds.
 */
const CONVERGENCE_RETRY_INITIAL = Duration.seconds(5);
const CONVERGENCE_RETRY_CEILING = Duration.minutes(5);

/** Replaces the process image while preserving its instance lock descriptor. */
export type Execve = (
  file: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  descriptor: number,
) => never;

export interface ConvergenceContext {
  readonly config: DaemonConfig;
  readonly logger: Logger;
  readonly installRoot: string;
  readonly instanceLockDescriptor: number;
  readonly dataplane: Pick<DataplaneClient, 'upgradeEffect' | 'dataplanePid'>;
  readonly execve?: Execve;
}

export interface ReleaseStager {
  /** Stages `release`, one stager at a time, and names its directory. */
  readonly stage: (release: string) => Effect.Effect<string, Error>;
  /** Stages `release` in the background: the control client's `stageRelease`. */
  readonly request: (release: string) => Effect.Effect<void>;
}

/**
 * The control client, and convergence whenever it reports that the server runs another
 * release. Convergence ends this process when it succeeds; a failure leaves this release
 * running, and the client dials again after a doubling delay, reading the server's release
 * first, so a release that has since moved on is the one converged to next.
 */
export function runConvergingControlEffect(
  context: ConvergenceContext & { readonly dataplane: DataplaneClient },
  health: DaemonControlHealthReporter,
  pathSignals: Queue.Dequeue<DaemonControlPathSignal>,
  shutdownIntent: Deferred.Deferred<void> | undefined,
  setTelemetryEnabled: (enabled: boolean) => Effect.Effect<void>,
): Effect.Effect<DaemonControlSuperseded> {
  return Effect.scoped(
    Effect.gen(function* () {
      const stager = yield* releaseStagerScoped(context);
      // A release this daemon refuses for good (its signature, its rollback floor, its
      // expiry) is not fetched again until the server names another.
      let refused: string | null = null;
      let retry = CONVERGENCE_RETRY_INITIAL;
      while (true) {
        const outcome = yield* Effect.result(
          runDaemonControlClientEffect(context.config, context.dataplane, {
            health,
            pathSignals,
            shutdownIntent,
            stageRelease: stager.request,
            setTelemetryEnabled,
          }),
        );
        if (Result.isSuccess(outcome)) return outcome.success;
        const { release } = outcome.failure;
        if (release !== refused) {
          const failure = yield* Effect.flip(convergeEffect(context, stager, release));
          const permanent = Predicate.isTagged(failure, 'DaemonUpdateTrustError');
          if (permanent) refused = release;
          yield* logEffect('error', 'daemon', 'daemon_update_blocked', {
            running: merkurRelease(),
            release,
            permanent,
            reason: failure.message,
          });
        }
        yield* Effect.sleep(retry);
        retry = Duration.min(Duration.times(retry, 2), CONVERGENCE_RETRY_CEILING);
      }
    }),
  );
}

/**
 * The scope's one stager. A staged release is found complete on disk, so a second request
 * for it checks the executables and their staged identity.
 */
function releaseStagerScoped(context: Omit<ConvergenceContext, 'dataplane' | 'execve'>) {
  return Effect.gen(function* () {
    const permit = yield* Semaphore.make(1);
    const scope = yield* Effect.scope;
    const stage = (release: string) =>
      permit.withPermit(
        stageReleaseEffect({
          logger: context.logger,
          installRoot: context.installRoot,
          origin: context.config.server_origin,
          release,
        }),
      );
    const request = (release: string) =>
      stage(release).pipe(
        Effect.catch((error) =>
          logEffect('warn', 'daemon', 'daemon_release_staging_failed', {
            release,
            error: String(error),
          }),
        ),
        Effect.forkIn(scope),
        Effect.asVoid,
      );
    return { stage, request } satisfies ReleaseStager;
  });
}

/**
 * Converges this daemon to `release`: stages it if the announcement did not, points
 * `current` at it, hands the terminal to its dataplane, and replaces this process with its
 * owner. On success this never returns: the process that continues is the new release,
 * which adopts the dataplane (`dataplane-adoption.ts`). A failure before the dataplane
 * accepts leaves this release running as it was.
 */
export function convergeEffect(
  context: ConvergenceContext,
  stager: ReleaseStager,
  release: string,
): Effect.Effect<never, Error> {
  return Effect.gen(function* () {
    const versionDirectory = yield* stager.stage(release);
    yield* activateReleaseEffect({
      logger: context.logger,
      installRoot: context.installRoot,
      versionDirectory,
      running: merkurRelease(),
    });
    const executables = resolveVersionedDaemonExecutables(versionDirectory);
    const pid = context.dataplane.dataplanePid();
    if (pid === null) {
      return yield* Effect.fail(new Error('no running dataplane to hand the terminal over'));
    }
    const runDirectory = path.join(context.installRoot, 'run');
    const socketPath = path.join(runDirectory, `dataplane-${process.pid}.sock`);
    yield* Effect.tryPromise({
      try: async () => {
        await mkdir(runDirectory, { recursive: true, mode: 0o700 });
        await rm(socketPath, { force: true });
      },
      catch: normalizeUnknownError,
    });
    const result = yield* context.dataplane.upgradeEffect(
      `upgrade-${release}-${process.pid}`,
      executables.dataplane,
      socketPath,
    );
    if (result.status !== 'accepted') {
      return yield* Effect.fail(new Error(`the dataplane refused the upgrade: ${result.reason}`));
    }
    yield* logEffect('info', 'daemon', 'daemon_release_handover', {
      from: merkurRelease(),
      to: release,
    });
    // The dataplane is replacing itself now. This process follows, keeping the pid the
    // dataplane accepts as its owner; nothing after this line runs in this release.
    const execve =
      context.execve ?? (yield* Effect.promise(() => import('./owner-exec'))).execDaemonOwner;
    return execve(
      executables.daemon,
      [executables.daemon, 'daemon'],
      {
        ...process.env,
        [DATAPLANE_ADOPT_ENV]: encodeDataplaneAdoption({ pid, socketPath }),
        [DAEMON_INSTANCE_LOCK_FD_ENV]: String(context.instanceLockDescriptor),
      },
      context.instanceLockDescriptor,
    );
  });
}
