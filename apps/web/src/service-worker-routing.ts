export interface ServiceWorkerRequestLike {
  readonly method: string;
  readonly url: string;
}

/**
 * Requests that must never wait on service-worker CacheStorage.
 *
 * Terminal fonts are part of worker readiness. Safari can take tens of
 * seconds to materialize a cached multi-megabyte response, so their already
 * content-versioned URLs use the browser HTTP cache directly.
 *
 * `/health` is here for a different and sharper reason: it is the reachability
 * probe's target, and `shellCacheFirst` would `cache.put` a successful response
 * and then serve every later probe from CacheStorage. A probe that answers
 * "reachable" from a local cache while the network is dead is worse than no
 * probe at all, because the circuit breaker reading it would keep dialling.
 */
export function shouldBypassServiceWorkerRequest(
  request: ServiceWorkerRequestLike,
  appOrigin: string,
): boolean {
  if (request.method !== 'GET') return true;

  const requestUrl = new URL(request.url);
  if (requestUrl.origin !== appOrigin) return true;

  const { pathname } = requestUrl;
  return (
    pathname === '/api' ||
    pathname.startsWith('/api/') ||
    // `/fonts` holds the terminal's multi-megabyte .ttf faces, which the
    // renderer fetches itself and the HTTP cache keeps — putting them through
    // the worker would mean 8 MB of cache storage on a phone. The UI .woff2
    // faces share the directory but are shell assets: a first paint in the
    // fallback typeface is exactly what the shell cache exists to prevent.
    (pathname.startsWith('/fonts/') && !pathname.endsWith('.woff2')) ||
    pathname === '/health' ||
    pathname.startsWith('/health/') ||
    // The legal pages are documents of their own, not the app: a navigation
    // to them must reach the server, never the cached shell.
    pathname === '/privacy' ||
    pathname === '/terms' ||
    pathname.startsWith('/legal/')
  );
}
