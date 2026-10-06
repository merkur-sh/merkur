import { createLogger } from '@merkur/logger';
import { Effect, Fiber } from 'effect';
import { onSettled } from 'solid-js';

const logger = createLogger('web');
const LOCALHOST_NAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const MERKUR_CACHE_PREFIX = 'merkur-';
const SW_OPT_IN_QUERY_PARAM = 'sw';
const SW_OPT_IN_ENABLED = 'on';

/**
 * What the update banner shows.
 *
 * `ready`: a complete build is installed and waiting. `applying`: this page
 * asked it to take over and reloads the moment it does — the banner stays up,
 * inert, so a tap that already landed is never offered again.
 */
export type SwUpdateState = 'none' | 'ready' | 'applying';

interface UseServiceWorkerLifecycleOptions {
  readonly setSwUpdate: (next: SwUpdateState) => void;
}

export function useServiceWorkerLifecycle({
  setSwUpdate,
}: UseServiceWorkerLifecycleOptions): () => void {
  let apply: () => void = () => {};
  onSettled(() => {
    if (!('serviceWorker' in navigator)) {
      return;
    }

    if (!shouldEnableServiceWorker()) {
      Effect.runFork(
        disableServiceWorkerForLocalDevEffect().pipe(
          Effect.catch((error) =>
            Effect.sync(() => {
              logger.warn('service_worker_disable_failed', {
                error: String(error),
              });
            }),
          ),
        ),
      );
      return;
    }

    const serviceWorker = navigator.serviceWorker;
    let registration: ServiceWorkerRegistration | null = null;
    let controller = serviceWorker.controller;
    let disposed = false;
    let reloading = false;
    /**
     * The reader chose Reload. Consent outlives the worker it was given to: a
     * newer build that supersedes the waiting one is applied without asking
     * again, and this page reloads on the controller change its request causes
     * even when it was not controlled to begin with (a hard reload bypasses the
     * worker, so `controller` starts null and the first-claim rule below would
     * otherwise leave the page on the old build with a dead button).
     */
    let applyRequested = false;
    let installing: ServiceWorker | null = null;
    let waiting: ServiceWorker | null = null;
    /** What the banner last offered: Reload acts only on an offered update. */
    let offered = false;

    const reload = (): void => {
      if (reloading) return;
      reloading = true;
      window.location.reload();
    };
    /**
     * Follow `registration.waiting` exactly. It changes when an install
     * completes, when the waiting worker activates, and when a newer build
     * replaces it (the old one turns `redundant`); each is a `statechange` on
     * one of the two workers observed here, so the banner is never left
     * pointing at a worker that no longer exists.
     */
    const syncWaiting = (): void => {
      const next = registration?.waiting ?? null;
      if (next !== waiting) {
        waiting?.removeEventListener('statechange', syncWaiting);
        waiting = next;
        waiting?.addEventListener('statechange', syncWaiting);
        if (waiting !== null && applyRequested) waiting.postMessage('activate_update');
      }
      // Once asked, the page is on its way out: the waiting slot empties as the
      // worker activates, and the reload follows on its controller change.
      if (applyRequested) {
        setSwUpdate('applying');
        return;
      }
      // A worker waits in front of nothing only for the instant before a first
      // installation activates itself; an update is a waiting worker with an
      // active one to replace.
      offered = waiting !== null && registration?.active != null;
      setSwUpdate(offered ? 'ready' : 'none');
    };
    // Its own function, not `syncWaiting`: an installed worker is both the
    // `installing` just observed and the new `waiting`, and one shared listener
    // would be dropped from it when the next installation replaces this one.
    const onInstallingStateChange = (): void => syncWaiting();
    const observeInstalling = (): void => {
      installing?.removeEventListener('statechange', onInstallingStateChange);
      installing = registration?.installing ?? null;
      installing?.addEventListener('statechange', onInstallingStateChange);
      syncWaiting();
    };
    const onControllerChange = (): void => {
      const nextController = serviceWorker.controller;
      // The first claim installs offline support for the current page. Only
      // replacement crosses builds. Reload every controlled page at that exact
      // boundary, including a tab whose sibling applied the waiting update, and
      // the page that asked for the update whatever controlled it before.
      if (
        nextController !== null &&
        nextController !== controller &&
        (controller !== null || applyRequested)
      ) {
        reload();
      }
      controller = nextController;
    };
    /**
     * An installed app can stay open for days without a navigation, and the
     * browser only looks for a new worker on navigations and functional events.
     * Returning to the page is the moment the reader can act on an update, so it
     * is the moment to look for one.
     */
    const onVisibilityChange = (): void => {
      if (document.visibilityState !== 'visible' || registration === null) return;
      registration.update().catch((error: unknown) => {
        logger.warn('service_worker_update_check_failed', { error: String(error) });
      });
    };
    // Listen before registration: installation can finish before it resolves.
    serviceWorker.addEventListener('controllerchange', onControllerChange);
    document.addEventListener('visibilitychange', onVisibilityChange);

    apply = (): void => {
      if (applyRequested || !offered || waiting === null) return;
      applyRequested = true;
      waiting.postMessage('activate_update');
      setSwUpdate('applying');
    };

    const serviceWorkerFiber = Effect.runFork(
      Effect.tryPromise({
        try: async () => {
          const next = await serviceWorker.register('/sw.js', { type: 'module' });
          if (disposed) return;
          registration = next;
          registration.addEventListener('updatefound', observeInstalling);
          observeInstalling();
        },
        catch: toError,
      }).pipe(
        Effect.catch((error) =>
          Effect.sync(() =>
            logger.error('service_worker_register_failed', { error: String(error) }),
          ),
        ),
      ),
    );

    return () => {
      disposed = true;
      apply = () => {};
      serviceWorker.removeEventListener('controllerchange', onControllerChange);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      registration?.removeEventListener('updatefound', observeInstalling);
      installing?.removeEventListener('statechange', onInstallingStateChange);
      waiting?.removeEventListener('statechange', syncWaiting);
      registration = null;
      installing = null;
      waiting = null;
      Effect.runFork(Fiber.interrupt(serviceWorkerFiber));
    };
  });
  return () => apply();
}

function shouldEnableServiceWorker(): boolean {
  if (import.meta.env.DEV) {
    return false;
  }

  if (!LOCALHOST_NAMES.has(window.location.hostname)) {
    return true;
  }

  const query = new URLSearchParams(window.location.search);
  return query.get(SW_OPT_IN_QUERY_PARAM) === SW_OPT_IN_ENABLED;
}

function disableServiceWorkerForLocalDevEffect(): Effect.Effect<void, Error> {
  return Effect.gen(function* () {
    const registrations = yield* Effect.tryPromise({
      try: () => navigator.serviceWorker.getRegistrations(),
      catch: toError,
    });
    yield* Effect.forEach(
      registrations,
      (registration) =>
        Effect.tryPromise({
          try: () => registration.unregister(),
          catch: toError,
        }),
      {
        concurrency: 'unbounded',
        discard: true,
      },
    );

    const cacheStorage = globalThis.caches;
    if (cacheStorage === undefined) {
      return;
    }

    const cacheKeys = yield* Effect.tryPromise({
      try: () => cacheStorage.keys(),
      catch: toError,
    });
    yield* Effect.forEach(
      cacheKeys.filter((cacheKey) => cacheKey.startsWith(MERKUR_CACHE_PREFIX)),
      (cacheKey) =>
        Effect.tryPromise({
          try: () => cacheStorage.delete(cacheKey),
          catch: toError,
        }),
      { concurrency: 'unbounded', discard: true },
    );
  });
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
