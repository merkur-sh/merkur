import { normalizeUnknownError } from '@merkur/shared';
import { Effect } from 'effect';

import { daemonInstanceLockPath, launchAgentPath, loadDaemonConfigEffect } from '../config';
import type { Logger } from '../logger';
import { isProcessAlive } from '../process-utils';
import { resolveDataplaneBinaryPath } from '../services/dataplane-binary';
import { readLockPidEffect } from '../single-instance';
import { resolveLaunchctlUserId, runLaunchctlEffect } from './launchctl';
import { DAEMON_LAUNCHD_LABEL, DAEMON_SYSTEMD_UNIT_NAME } from './service-identity';
import { runSystemctlEffect } from './systemctl';

const LABEL = DAEMON_LAUNCHD_LABEL;
const SYSTEMD_UNIT_NAME = DAEMON_SYSTEMD_UNIT_NAME;
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
  return Effect.scoped(
    Effect.gen(function* () {
      const config = yield* loadDaemonConfigEffect().pipe(Effect.catch(() => Effect.succeed(null)));
      const lockPath = config === null ? null : daemonInstanceLockPath(config.daemon_id);
      const lockPid = lockPath === null ? null : yield* readLockPidEffect(lockPath);

      const stop = lockPid === null ? null : yield* prepareLockedProcessStop(lockPid);

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

      if (stop !== null) {
        yield* Effect.tryPromise({ try: stop, catch: normalizeUnknownError });
      }

      logger.info('daemon_stop_success', { lockPid });
      return 0;
    }),
  );
}

const prepareLockedProcessStop = Effect.fnUntraced(function* (pid: number) {
  if (!isProcessAlive(pid)) return null;
  const stop = yield* Effect.acquireRelease(
    Effect.tryPromise({ try: () => prepareProcessStop(pid), catch: normalizeUnknownError }),
    (stop) => Effect.promise(stop.close),
  );
  // Check ownership after capture: a stale numeric PID can never redirect the
  // already-armed helper's signal to a successor process.
  const processInfo = yield* inspectProcessEffect(pid);
  if (processInfo === null || !isMerkurProcessInfo(processInfo)) {
    return yield* Effect.fail(
      new Error(`Refusing to stop pid ${pid}: unable to verify a Merkur daemon`),
    );
  }
  return stop.finish;
});

async function prepareProcessStop(pid: number): Promise<{
  finish: () => Promise<void>;
  close: () => Promise<void>;
}> {
  const binary = resolveDataplaneBinaryPath();
  if (binary === null) throw new Error('Dataplane binary not found for graceful process stop');
  const child = Bun.spawn([binary, 'process-stop', String(pid)], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const errors = new Response(child.stderr).text();
  let requested = false;
  const close = async (): Promise<void> => {
    try {
      if (!requested) child.stdin.end();
    } finally {
      await child.exited;
      await errors;
    }
  };
  try {
    const reader = child.stdout.getReader();
    let ready = '';
    while (ready.length < 6) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error(`Unable to watch daemon process: ${await errors}`);
      ready += new TextDecoder().decode(chunk.value);
    }
    reader.releaseLock();
    if (ready !== 'ready\n') throw new Error('Invalid process stop readiness');
    return {
      close,
      finish: async () => {
        if (!requested) {
          requested = true;
          child.stdin.write('s');
          child.stdin.end();
        }
        const exitCode = await child.exited;
        const error = await errors;
        if (exitCode !== 0) throw new Error(`Graceful daemon stop failed: ${error}`);
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
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
