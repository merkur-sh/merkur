import { normalizeUnknownError } from '@merkur/shared';
import { Clock, Effect } from 'effect';

import { daemonInstanceLockPath, launchAgentPath, loadDaemonConfigEffect } from '../config';
import type { Logger } from '../logger';
import { isProcessAlive } from '../process-utils';
import { readLockPidEffect, removeLockFileEffect } from '../single-instance';
import { resolveLaunchctlUserId, runLaunchctlEffect } from './launchctl';
import { DAEMON_LAUNCHD_LABEL, DAEMON_SYSTEMD_UNIT_NAME } from './service-identity';
import { runSystemctlEffect } from './systemctl';

const LABEL = DAEMON_LAUNCHD_LABEL;
const SYSTEMD_UNIT_NAME = DAEMON_SYSTEMD_UNIT_NAME;
const STOP_TIMEOUT_MS = 3_000;
const STOP_POLL_MS = 100;
const MERKUR_PROCESS_MARKERS = ['merkur', 'apps/daemon', 'src/index.ts'];
const LAUNCHCTL_EVENTS = {
  ignored: 'daemon_stop_launchctl_ignored',
  failed: 'daemon_stop_launchctl_failed',
};
const SYSTEMCTL_EVENTS = {
  ignored: 'daemon_stop_systemctl_ignored',
  failed: 'daemon_stop_systemctl_failed',
};

export interface ProcessInfo {
  readonly command: string;
  readonly args: string;
}

export async function runStopCommand(logger: Logger): Promise<number> {
  return Effect.runPromise(runStopCommandEffect(logger));
}

function runStopCommandEffect(logger: Logger): Effect.Effect<number, Error> {
  return Effect.gen(function* () {
    const config = yield* loadDaemonConfigEffect().pipe(Effect.catch(() => Effect.succeed(null)));
    const lockPath = config === null ? null : daemonInstanceLockPath(config.daemon_id);
    const lockPid = lockPath === null ? null : yield* readLockPidEffect(lockPath);

    if (process.platform === 'linux') {
      yield* runSystemctlEffect(
        logger,
        ['disable', '--now', SYSTEMD_UNIT_NAME],
        true,
        SYSTEMCTL_EVENTS,
      );
    } else if (process.platform === 'darwin') {
      const uid = resolveLaunchctlUserId();
      const launchDomain = `gui/${uid}`;
      const plistPath = launchAgentPath();
      yield* runLaunchctlEffect(
        logger,
        ['bootout', `${launchDomain}/${LABEL}`],
        true,
        LAUNCHCTL_EVENTS,
      );
      yield* runLaunchctlEffect(
        logger,
        ['bootout', launchDomain, plistPath],
        true,
        LAUNCHCTL_EVENTS,
      );
    }

    if (lockPath !== null && lockPid === null) {
      yield* removeLockFileEffect(lockPath);
    } else if (lockPath !== null && lockPid !== null) {
      yield* stopLockedProcessEffect(lockPath, lockPid, logger);
    }

    logger.info('daemon_stop_success', { lockPid });
    return 0;
  });
}

function stopLockedProcessEffect(
  lockPath: string,
  pid: number,
  logger: Logger,
): Effect.Effect<void, Error> {
  return Effect.gen(function* () {
    if (!isProcessAlive(pid)) {
      yield* removeLockFileEffect(lockPath);
      return;
    }

    const processInfo = yield* inspectProcessEffect(pid);
    if (processInfo === null) {
      return yield* Effect.fail(
        new Error(`Refusing to kill pid ${pid}: unable to verify it is a Merkur daemon`),
      );
    }

    if (!isMerkurProcessInfo(processInfo)) {
      return yield* Effect.fail(
        new Error(`Refusing to kill pid ${pid}: process does not look like Merkur`),
      );
    }

    yield* stopProcessEffect(pid, logger);
    yield* removeLockFileEffect(lockPath);
  });
}

function inspectProcessEffect(pid: number): Effect.Effect<ProcessInfo | null, Error> {
  return Effect.tryPromise({
    try: async () => {
      const proc = Bun.spawn(['ps', '-p', String(pid), '-o', 'comm=', '-o', 'args='], {
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const exitCode = await proc.exited;
      if (exitCode !== 0) {
        return null;
      }

      const output = (await new Response(proc.stdout).text()).trim();
      return parseProcessInfo(output);
    },
    catch: normalizeUnknownError,
  });
}

export function parseProcessInfo(output: string): ProcessInfo | null {
  const line = output
    .split('\n')
    .map((item) => item.trim())
    .find((item) => item.length > 0);
  if (line === undefined) {
    return null;
  }

  const separator = /\s+/.exec(line);
  if (separator === null || separator.index <= 0) {
    return { command: line, args: '' };
  }

  return {
    command: line.slice(0, separator.index),
    args: line.slice(separator.index + separator[0].length),
  };
}

export function isMerkurProcessInfo(processInfo: ProcessInfo): boolean {
  const haystack = `${processInfo.command}\n${processInfo.args}`.toLowerCase();
  return MERKUR_PROCESS_MARKERS.some((marker) => haystack.includes(marker));
}

function stopProcessEffect(pid: number, logger: Logger): Effect.Effect<void, Error> {
  return Effect.gen(function* () {
    if (!isProcessAlive(pid)) {
      return;
    }

    yield* Effect.try({
      try: () => process.kill(pid, 'SIGTERM'),
      catch: normalizeUnknownError,
    }).pipe(Effect.catchIf(isProcessMissingError, () => Effect.void));

    const deadline = (yield* Clock.currentTimeMillis) + STOP_TIMEOUT_MS;
    while ((yield* Clock.currentTimeMillis) < deadline) {
      if (!isProcessAlive(pid)) {
        return;
      }
      yield* Effect.sleep(`${STOP_POLL_MS} millis`);
    }

    if (isProcessAlive(pid)) {
      logger.warn('daemon_stop_force_kill', { pid });
      yield* Effect.try({
        try: () => process.kill(pid, 'SIGKILL'),
        catch: normalizeUnknownError,
      }).pipe(Effect.catchIf(isProcessMissingError, () => Effect.void));
    }
  });
}

function isProcessMissingError(error: Error): boolean {
  return 'code' in error && error.code === 'ESRCH';
}
