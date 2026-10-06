import { existsSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { normalizeUnknownError } from '@merkur/shared';
import { Effect } from 'effect';

/** The installed sibling, or the same release directory in a source checkout. */
async function tuiExecutable(): Promise<string> {
  const source = path.resolve(import.meta.dir, '../index.ts');
  return existsSync(source)
    ? path.resolve(import.meta.dir, '../../dist/merkur-tui')
    : path.join(path.dirname(await realpath(process.execPath)), 'merkur-tui');
}

/** Inherited descriptors preserve the caller's controlling TTY. The child
 * restores it before this CLI returns, including an interrupted command. */
export async function runTuiCommand(args: readonly string[]): Promise<number> {
  const executable = await tuiExecutable();
  return Effect.runPromise(
    Effect.acquireUseRelease(
      Effect.try({
        try: () => {
          let child: ReturnType<typeof Bun.spawn> | undefined;
          const interrupt = (): void => child?.kill('SIGINT');
          const terminate = (): void => child?.kill('SIGTERM');
          const hangup = (): void => child?.kill('SIGHUP');
          const release = (): void => {
            process.off('SIGINT', interrupt);
            process.off('SIGTERM', terminate);
            process.off('SIGHUP', hangup);
          };
          process.on('SIGINT', interrupt);
          process.on('SIGTERM', terminate);
          process.on('SIGHUP', hangup);
          try {
            child = Bun.spawn([executable, ...args], {
              stdin: 'inherit',
              stdout: 'inherit',
              stderr: 'inherit',
            });
            return { child, release };
          } catch (error) {
            release();
            throw error;
          }
        },
        catch: normalizeUnknownError,
      }),
      ({ child }) => Effect.tryPromise({ try: () => child.exited, catch: normalizeUnknownError }),
      ({ child, release }) =>
        Effect.promise(async () => {
          try {
            if (child.exitCode === null && child.signalCode === null) {
              child.kill('SIGTERM');
              await child.exited;
            }
          } finally {
            release();
          }
        }),
    ),
  );
}
