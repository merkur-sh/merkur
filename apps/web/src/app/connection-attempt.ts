export interface ConnectionAttempt {
  readonly generation: number;
  readonly deviceId: string;
  readonly startedAtMs: number;
  readonly signal: AbortSignal;
  isCurrent(): boolean;
}

export interface ConnectionAttemptOwner {
  /**
   * Own a new attempt synchronously. A repeated click for the current device is
   * ignored; selecting another device supersedes the older async continuation.
   */
  begin(deviceId: string, startedAtMs?: number): ConnectionAttempt | null;
  hasActive(): boolean;
  isActiveFor(deviceId: string): boolean;
  complete(attempt: ConnectionAttempt): boolean;
  invalidate(reason?: unknown): void;
}

/**
 * Small generation owner for the device-click startup chain.
 *
 * PBKDF2 cannot be cancelled by WebCrypto, so cancellation is semantic: every
 * continuation checks `isCurrent()` before it may publish UI or session state.
 * The AbortSignal also lets cancellable work added to the chain share the same
 * ownership boundary.
 */
export function createConnectionAttemptOwner(
  now: () => number = () => performance.now(),
): ConnectionAttemptOwner {
  let generation = 0;
  let active:
    | {
        readonly generation: number;
        readonly deviceId: string;
        readonly controller: AbortController;
      }
    | undefined;

  function invalidate(reason: unknown = new Error('Connection attempt superseded')): void {
    generation = nextGeneration(generation);
    const displaced = active;
    active = undefined;
    displaced?.controller.abort(reason);
  }

  return {
    begin(deviceId, startedAtMs = now()): ConnectionAttempt | null {
      if (active?.deviceId === deviceId) return null;
      if (active !== undefined) invalidate();

      generation = nextGeneration(generation);
      const ownedGeneration = generation;
      const controller = new AbortController();
      active = { generation: ownedGeneration, deviceId, controller };
      return {
        generation: ownedGeneration,
        deviceId,
        startedAtMs,
        signal: controller.signal,
        isCurrent: () =>
          active?.generation === ownedGeneration &&
          active.deviceId === deviceId &&
          !controller.signal.aborted,
      };
    },

    hasActive(): boolean {
      return active !== undefined && !active.controller.signal.aborted;
    },

    isActiveFor(deviceId): boolean {
      return active?.deviceId === deviceId && !active.controller.signal.aborted;
    },

    complete(attempt): boolean {
      if (
        active?.generation !== attempt.generation ||
        active.deviceId !== attempt.deviceId ||
        active.controller.signal.aborted
      ) {
        return false;
      }
      active = undefined;
      return true;
    },

    invalidate,
  };
}

function nextGeneration(current: number): number {
  return current >= Number.MAX_SAFE_INTEGER ? 1 : current + 1;
}
