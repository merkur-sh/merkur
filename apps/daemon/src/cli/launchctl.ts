import { normalizeUnknownError } from '@merkur/shared';
import { Effect } from 'effect';

import type { Logger } from '../logger';

export function resolveLaunchctlUserId(): string {
  if (typeof process.getuid !== 'function') {
    throw new Error('Unable to resolve uid for launchctl domain');
  }
  return String(process.getuid());
}

export function runLaunchctlEffect(
  logger: Logger,
  args: string[],
  ignoreFailure: boolean,
  events: {
    readonly ignored: string;
    readonly failed: string;
  },
): Effect.Effect<boolean, Error> {
  return Effect.tryPromise({
    try: async () => {
      const proc = Bun.spawn(['launchctl', ...args], {
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const exitCode = await proc.exited;
      if (exitCode === 0) {
        return true;
      }

      const errorOutput = (await new Response(proc.stderr).text()).trim();
      if (ignoreFailure) {
        logger.warn(events.ignored, {
          args: args.join(' '),
          exitCode,
          error: errorOutput,
        });
        return false;
      }

      logger.error(events.failed, {
        args: args.join(' '),
        exitCode,
        error: errorOutput,
      });
      return false;
    },
    catch: normalizeUnknownError,
  });
}
