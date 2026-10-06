import { Effect } from 'effect';

export function waitForProcessSignal(
  signals: readonly NodeJS.Signals[] = ['SIGINT', 'SIGTERM'],
): Effect.Effect<NodeJS.Signals, Error> {
  return Effect.tryPromise({
    try: (abortSignal) =>
      new Promise<NodeJS.Signals>((resolve) => {
        const handlers = new Map<NodeJS.Signals, () => void>();
        const cleanup = (): void => {
          for (const [signal, handler] of handlers) {
            process.off(signal, handler);
          }
          abortSignal.removeEventListener('abort', cleanup);
        };

        for (const signal of signals) {
          const handler = (): void => {
            cleanup();
            resolve(signal);
          };
          handlers.set(signal, handler);
          process.once(signal, handler);
        }

        abortSignal.addEventListener('abort', cleanup, { once: true });
      }),
    catch: (error) => (error instanceof Error ? error : new Error(String(error))),
  });
}
