import { Effect, Fiber } from 'effect';

import {
  beginAsyncTask,
  claimAsyncTaskCompletion,
  createAsyncTaskOwnership,
  invalidateAsyncTask,
  isAsyncTaskCurrent,
} from '../lib/async-task-ownership';

interface LinkCommandToken {
  readonly command: string | null;
  readonly expiresAt: number | null;
}

interface LinkCommandRefreshOptions<T extends LinkCommandToken> {
  readonly refreshMarginMs: number;
  createToken(accessToken: string): Promise<T | null>;
  onToken?(token: T): void;
  onCommand(command: string): void;
  onAutoRefreshError(error: unknown): void;
  now?(): number;
  scheduleWake?(delayMs: number, wake: () => void): () => void;
}

export interface LinkCommandRefresh {
  refresh(accessToken: string): Promise<boolean>;
  stop(): void;
}

/**
 * Owns link-token requests and command-expiry wakeups as separate cancel/replace
 * lineages. A stopped or superseded request cannot publish a stale command, a
 * retiring timer cannot clear its successor, and an in-flight replacement
 * request cannot revoke the displayed command's existing expiry guarantee.
 */
export function createLinkCommandRefresh<T extends LinkCommandToken>(
  options: LinkCommandRefreshOptions<T>,
): LinkCommandRefresh {
  const requestOwnership = createAsyncTaskOwnership();
  const wakeOwnership = createAsyncTaskOwnership();
  let scheduledWake: { cancel(): void } | null = null;
  const now = options.now ?? Date.now;
  const scheduleWake = options.scheduleWake ?? scheduleEffectWake;

  async function refresh(accessToken: string): Promise<boolean> {
    // A replacement request revokes only an older request. The currently
    // displayed command keeps its independent expiry wake until a successful
    // replacement atomically installs a new one.
    const generation = beginAsyncTask(requestOwnership);
    let nextToken: T | null;
    try {
      nextToken = await options.createToken(accessToken);
    } catch (error) {
      if (!claimAsyncTaskCompletion(requestOwnership, generation)) {
        return false;
      }
      throw error;
    }

    if (!claimAsyncTaskCompletion(requestOwnership, generation)) {
      return false;
    }

    if (nextToken !== null) options.onToken?.(nextToken);
    if (
      nextToken === null ||
      nextToken.expiresAt === null ||
      (nextToken.command !== null && nextToken.expiresAt <= now())
    ) {
      clearScheduledWake();
      options.onCommand('');
      return true;
    }

    return installToken(accessToken, nextToken, nextToken.expiresAt);
  }

  function installToken(accessToken: string, token: LinkCommandToken, expiresAt: number): boolean {
    clearScheduledWake();
    const refreshInMs = Math.max(
      0,
      expiresAt - now() - (token.command === null ? 0 : options.refreshMarginMs),
    );
    const generation = beginAsyncTask(wakeOwnership);
    // Publish an identity before installing the wake callback so even a custom
    // synchronous scheduler cannot race handle publication.
    let installedCancel: (() => void) | null = null;
    let cancelBeforePublication = false;
    const wakeOwner = {
      cancel(): void {
        if (installedCancel === null) {
          cancelBeforePublication = true;
          return;
        }
        installedCancel();
      },
    };
    scheduledWake = wakeOwner;
    try {
      installedCancel = scheduleWake(refreshInMs, () => {
        if (!claimAsyncTaskCompletion(wakeOwnership, generation)) {
          return;
        }
        if (scheduledWake === wakeOwner) {
          scheduledWake = null;
        }
        options.onCommand('');
        void refresh(accessToken).catch(options.onAutoRefreshError);
      });
    } catch (error) {
      if (claimAsyncTaskCompletion(wakeOwnership, generation) && scheduledWake === wakeOwner) {
        scheduledWake = null;
      }
      options.onCommand('');
      throw error;
    }

    if (cancelBeforePublication || scheduledWake !== wakeOwner) {
      installedCancel();
    }
    if (!isAsyncTaskCurrent(wakeOwnership, generation)) {
      return false;
    }
    options.onCommand(token.command ?? '');
    return isAsyncTaskCurrent(wakeOwnership, generation);
  }

  function clearScheduledWake(): void {
    invalidateAsyncTask(wakeOwnership);
    if (scheduledWake === null) {
      return;
    }
    const wake = scheduledWake;
    scheduledWake = null;
    wake.cancel();
  }

  function stop(): void {
    invalidateAsyncTask(requestOwnership);
    clearScheduledWake();
  }

  return { refresh, stop };
}

function scheduleEffectWake(delayMs: number, wake: () => void): () => void {
  const fiber = Effect.runFork(
    Effect.sleep(`${delayMs} millis`).pipe(Effect.andThen(Effect.sync(wake))),
  );
  return () => {
    Effect.runFork(Fiber.interrupt(fiber));
  };
}
