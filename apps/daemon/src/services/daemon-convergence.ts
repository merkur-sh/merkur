import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { merkurRelease, normalizeUnknownError } from '@merkur/shared';
import { type Deferred, Duration, Effect, Predicate, type Queue, Result, Semaphore } from 'effect';

import type { DaemonConfig } from '../config';
import { type Logger, logEffect } from '../logger';
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

let nextPreparationId = 0n;

/**
 * Replaces this process image, keeping its pid: Bun's `process.execve`. A seam for tests;
 * the default never returns.
 */
export type Execve = (file: string, args: readonly string[], env: NodeJS.ProcessEnv) => never;

const liveExecve: Execve = (file, args, env) => {
  if (process.execve === undefined) {
    throw new Error('this runtime cannot replace its process image');
  }
  return process.execve(file, args, env);
};

export interface ConvergenceContext {
  readonly config: DaemonConfig;
  readonly logger: Logger;
  readonly installRoot: string;
  readonly dataplane: Pick<
    DataplaneClient,
    'prepareUpgradeEffect' | 'commitUpgradeEffect' | 'abortUpgradeEffect' | 'dataplanePid'
  >;
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
 * commits leaves this release serving; failed preparation or activation resumes its reader.
 */
export function convergeEffect(
  context: ConvergenceContext,
  stager: ReleaseStager,
  release: string,
): Effect.Effect<never, Error> {
  return Effect.gen(function* () {
    if (context.execve === undefined && process.execve === undefined) {
      return yield* Effect.fail(new Error('this runtime cannot replace its process image'));
    }
    const versionDirectory = yield* stager.stage(release);
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
    const preparedId = `upgrade-${process.pid}-${nextPreparationId++}`;
    let committed = false;
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const prepared = yield* context.dataplane.prepareUpgradeEffect(
          preparedId,
          executables.dataplane,
          socketPath,
        );
        if (prepared.status !== 'accepted') {
          return yield* Effect.fail(
            new Error(`the dataplane refused preparation: ${prepared.reason}`),
          );
        }
        // Cancellation before activation returns ownership through the abort finalizer.
        yield* restore(Effect.void);
        yield* activateReleaseEffect({
          logger: context.logger,
          installRoot: context.installRoot,
          versionDirectory,
          running: merkurRelease(),
        });
        const result = yield* context.dataplane.commitUpgradeEffect(
          `${preparedId}-commit`,
          preparedId,
        );
        if (result.status !== 'accepted') {
          return yield* Effect.fail(
            new Error(`the dataplane refused the commit: ${result.reason}`),
          );
        }
        committed = true;
        yield* logEffect('info', 'daemon', 'daemon_release_handover', {
          from: merkurRelease(),
          to: release,
        });
        return (context.execve ?? liveExecve)(executables.daemon, [executables.daemon, 'daemon'], {
          ...process.env,
          [DATAPLANE_ADOPT_ENV]: encodeDataplaneAdoption({ pid, socketPath }),
        });
      }).pipe(
        Effect.ensuring(
          Effect.gen(function* () {
            if (committed) return;
            const aborted = yield* context.dataplane.abortUpgradeEffect(
              `${preparedId}-abort`,
              preparedId,
            );
            if (aborted.status !== 'accepted') {
              yield* logEffect('error', 'daemon', 'daemon_handoff_abort_failed', {
                reason: aborted.reason,
              });
            }
          }),
        ),
      ),
    );
  });
}
