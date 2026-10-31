/** Exclusive Web Locks for browser unit tests, with named queues and queued cancellation. */
export function installBrowserLocks(onQueued: () => void = () => {}): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(navigator, 'locks');
  const tails = new Map<string, Promise<void>>();
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: {
      request<T>(name: string, options: LockOptions, run: () => Promise<T>): Promise<T> {
        if (options.mode !== 'exclusive') throw new Error('test lock requires exclusive mode');
        const previous = tails.get(name);
        if (previous !== undefined) onQueued();
        const execution = (previous ?? Promise.resolve()).then(() => {
          options.signal?.throwIfAborted();
          return run();
        });
        const settled = execution.then(
          () => {},
          () => {},
        );
        tails.set(name, settled);
        void settled.then(() => {
          if (tails.get(name) === settled) tails.delete(name);
        });
        const signal = options.signal;
        if (signal === undefined) return execution;
        return new Promise<T>((resolve, reject) => {
          const abort = () => reject(signal.reason);
          signal.addEventListener('abort', abort, { once: true });
          if (signal.aborted) abort();
          void execution
            .then(resolve, reject)
            .finally(() => signal.removeEventListener('abort', abort));
        });
      },
    },
  });
  return () => {
    if (descriptor === undefined) Reflect.deleteProperty(navigator, 'locks');
    else Object.defineProperty(navigator, 'locks', descriptor);
  };
}
