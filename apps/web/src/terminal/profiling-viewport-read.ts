export interface ProfilingViewportReadOwner {
  read(): Promise<string>;
  close(error: Error): void;
}

type ArmTimeout = (expire: () => void, timeoutMs: number) => () => void;

const armTimeout: ArmTimeout = (expire, timeoutMs) => {
  const timer = setTimeout(expire, timeoutMs);
  return () => clearTimeout(timer);
};

/**
 * Own the profiling-only FIFO viewport request across timeout and shutdown.
 *
 * A timed-out worker callback cannot be removed from the response FIFO. Its
 * closure therefore remains a settled no-op so the late response consumes the
 * old slot without resolving the next request with stale text.
 */
export function createProfilingViewportReadOwner(
  issue: (complete: (text: string) => void) => boolean,
  timeoutMs: number,
  scheduleTimeout: ArmTimeout = armTimeout,
): ProfilingViewportReadOwner {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('profiling viewport read timeout must be positive and finite');
  }

  let closedError: Error | null = null;
  let pending: {
    readonly promise: Promise<string>;
    readonly reject: (error: Error) => void;
  } | null = null;

  return {
    read(): Promise<string> {
      if (closedError !== null) return Promise.reject(closedError);
      if (pending !== null) return pending.promise;

      let resolvePromise: (text: string) => void = () => undefined;
      let rejectPromise: (error: Error) => void = () => undefined;
      let settled = false;
      let cancelTimeout: () => void = () => undefined;
      const promise = new Promise<string>((resolve, reject) => {
        resolvePromise = resolve;
        rejectPromise = reject;
      });
      const request = {
        promise,
        reject: (error: Error): void => settle(null, error),
      };
      function settle(text: string | null, error: Error | null): void {
        if (settled) return;
        settled = true;
        cancelTimeout();
        if (pending === request) pending = null;
        if (error === null && text !== null) resolvePromise(text);
        else rejectPromise(error ?? new Error('terminal viewport read returned no text'));
      }

      pending = request;
      cancelTimeout = scheduleTimeout(
        () => settle(null, new Error('terminal viewport read timed out')),
        timeoutMs,
      );
      if (settled) cancelTimeout();
      try {
        if (!issue((text) => settle(text, null))) {
          settle(null, new Error('terminal worker rejected the viewport read'));
        }
      } catch (error) {
        settle(
          null,
          error instanceof Error ? error : new Error('terminal worker viewport read threw'),
        );
      }
      return promise;
    },
    close(error: Error): void {
      closedError ??= error;
      pending?.reject(closedError);
      pending = null;
    },
  };
}
