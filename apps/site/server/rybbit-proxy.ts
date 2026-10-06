import { isIP } from 'node:net';

import { errorLogContext, type Logger } from '@merkur/logger';

/**
 * First-party proxy for Rybbit Cloud.
 *
 * The page loads `/analytics/script.js`, and the script derives its API host
 * from its own `src`, so every analytics request stays on the site's origin and
 * the page's CSP keeps `connect-src 'self'`. Rybbit classifies a visitor from
 * the browser's own headers, so they are all forwarded except the ones that
 * describe this hop (`Host`, hop-by-hop fields, `Content-Length`), the cookie
 * jar, and `X-Forwarded-For`, which is replaced by the one address resolved
 * under the application server's trust rule. Rybbit Cloud's "First-Party
 * Proxy" site setting is what makes it trust that header.
 *
 * Replay and identify are deliberately absent: the site records no sessions
 * and has no users to identify.
 *
 * The one thing the script asks for that is not forwarded is its tracking
 * config: the site answers `/analytics/site/tracking-config/<id>` itself with
 * `TRACKING_CONFIG`, so what the page records is fixed in this repository and
 * never falls back to the script's defaults when Rybbit is slow, down, blocked
 * or edited.
 */
export interface RybbitRoute {
  readonly upstreamPath: string;
  /** `GET` also admits `HEAD`. */
  readonly method: 'GET' | 'POST';
  /** Applied to a relayed 2xx or 304; any other relayed status is `no-store`. */
  readonly cacheControl: string;
}

export interface RequestIpSource {
  requestIP(request: Request): { address: string } | null;
}

export type RybbitProxy = (
  request: Request,
  route: RybbitRoute,
  search: string,
  ipSource: RequestIpSource,
) => Promise<Response>;

export interface RybbitProxyOptions {
  /** Rybbit's origin, e.g. `https://app.rybbit.io`. */
  readonly host: string;
  readonly trustedProxyHops: number;
  readonly timeoutMs: number;
  /** Security headers and `Vary`, carried by every response the site sends. */
  readonly baseHeaders: Readonly<Record<string, string>>;
  readonly logger: Logger;
}

const SCRIPT_CACHE_CONTROL = 'public, max-age=3600';
export const TRACKING_CONFIG_CACHE_CONTROL = 'public, max-age=300';
const NO_STORE = 'no-store';
/**
 * A beacon's answer is never reused, and is not `no-store`: the script sends a
 * beacon as a keepalive fetch and never reads the answer, and Chrome does not
 * finish loading an unread `no-store` body of such a fetch. The request then
 * stays open for as long as the page does, and an audit that waits for the
 * network to go quiet (Lighthouse) runs into its time limit.
 */
const BEACON_CACHE_CONTROL = 'no-cache';
const CACHE_CONTROL_HEADER = 'cache-control';
const X_FORWARDED_FOR_HEADER = 'x-forwarded-for';

const FIXED_ROUTES: ReadonlyMap<string, RybbitRoute> = new Map<string, RybbitRoute>([
  [
    '/analytics/script.js',
    { upstreamPath: '/api/script.js', method: 'GET', cacheControl: SCRIPT_CACHE_CONTROL },
  ],
  [
    '/analytics/track',
    { upstreamPath: '/api/track', method: 'POST', cacheControl: BEACON_CACHE_CONTROL },
  ],
]);
const TRACKING_CONFIG_PREFIX = '/analytics/site/tracking-config/';
/** One path segment, as Rybbit's site ids are. */
const SITE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * What the script records on this site, as the privacy policy's website
 * analytics section states it: the first pageview, Web Vitals (the "page-load
 * timing"), and the events the page names with `data-rybbit-event`. Never the
 * address's query string, links followed off the site, errors, clicks, copies
 * or form input the page does not name, session replay, or feature flags. Every
 * field the script reads is set, so none takes the script's own default.
 */
export const TRACKING_CONFIG = {
  trackInitialPageView: true,
  trackSpaNavigation: false,
  trackUrlParams: false,
  trackOutbound: false,
  webVitals: true,
  trackErrors: false,
  sessionReplay: false,
  trackButtonClicks: false,
  trackCopy: false,
  trackFormInteractions: false,
  featureFlagsEnabled: false,
} as const;

/** Whether `pathname` is the script's request for its site's tracking config. */
export function isTrackingConfigPath(pathname: string): boolean {
  return (
    pathname.startsWith(TRACKING_CONFIG_PREFIX) &&
    SITE_ID_PATTERN.test(pathname.slice(TRACKING_CONFIG_PREFIX.length))
  );
}

/**
 * Fields that describe this connection rather than the visitor's request
 * (RFC 9110 §7.6.1), plus the three this proxy owns: the body length it
 * re-derives, the cookie jar it never forwards, and the forwarding chain it
 * replaces. `Proxy-*` is dropped by prefix.
 */
const DROPPED_REQUEST_HEADERS = new Set([
  'connection',
  'content-length',
  'cookie',
  'host',
  'keep-alive',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  X_FORWARDED_FOR_HEADER,
]);
const PROXY_HEADER_PREFIX = 'proxy-';

/**
 * The only upstream response fields the site relays. An allowlist rather than a
 * strip list: Rybbit's own `Set-Cookie`, CORS, HSTS, NEL or `Alt-Svc` must never
 * become the site origin's policy. With `decompress: false` the body is the
 * upstream's encoded bytes, so its `Content-Encoding` travels with it.
 */
const RELAYED_RESPONSE_HEADERS = ['content-type', 'content-encoding', 'etag', 'last-modified'];
/** Statuses the Fetch API forbids a body on. */
const NULL_BODY_STATUSES = new Set([204, 205, 304]);

export function matchRybbitRoute(pathname: string): RybbitRoute | null {
  return FIXED_ROUTES.get(pathname) ?? null;
}

export function createRybbitProxy(options: RybbitProxyOptions): RybbitProxy {
  const badGateway = { ...options.baseHeaders, [CACHE_CONTROL_HEADER]: NO_STORE };
  const failed = (route: RybbitRoute, context: Record<string, unknown>): Response => {
    options.logger.warn('rybbit_upstream_failed', { upstreamPath: route.upstreamPath, ...context });
    return new Response(null, { status: 502, headers: badGateway });
  };

  return async (request, route, search, ipSource) => {
    const visitor = visitorIp(request, ipSource, options.trustedProxyHops);
    if (visitor === null) {
      return failed(route, { error: 'visitor address unavailable' });
    }
    let upstream: Response;
    let body: ArrayBuffer | null;
    try {
      upstream = await fetch(`${options.host}${route.upstreamPath}${search}`, {
        method: request.method,
        headers: forwardedRequestHeaders(request.headers, visitor),
        body: route.method === 'POST' ? await request.arrayBuffer() : null,
        redirect: 'manual',
        decompress: false,
        signal: AbortSignal.timeout(options.timeoutMs),
      });
      if (!isRelayedStatus(upstream.status)) {
        await upstream.body?.cancel();
        return failed(route, { status: upstream.status });
      }
      body =
        request.method === 'HEAD' || NULL_BODY_STATUSES.has(upstream.status)
          ? null
          : await upstream.arrayBuffer();
    } catch (error) {
      return failed(route, errorLogContext(error));
    }
    return new Response(body, {
      status: upstream.status,
      headers: relayedResponseHeaders(upstream, route, options.baseHeaders),
    });
  };
}

/**
 * The visitor's address under the application server's rule
 * (`apps/server/src/http/client-ip.ts`): with `trustedProxyHops` proxies that
 * each append to `X-Forwarded-For`, the outermost trusted proxy's entry sits
 * that many positions from the right, and everything to its left is
 * client-controlled and never read. Zero hops, a short header or a non-address
 * entry falls back to the socket peer, never further left.
 */
function visitorIp(
  request: Request,
  ipSource: RequestIpSource,
  trustedProxyHops: number,
): string | null {
  if (trustedProxyHops > 0) {
    const forwardedFor = request.headers.get(X_FORWARDED_FOR_HEADER);
    if (forwardedFor !== null) {
      const entries = forwardedFor.split(',');
      const candidate = entries[entries.length - trustedProxyHops]?.trim();
      if (candidate !== undefined && isIP(candidate) !== 0) {
        return candidate;
      }
    }
  }
  const address = ipSource.requestIP(request)?.address;
  return address !== undefined && address.length > 0 ? address : null;
}

function forwardedRequestHeaders(source: Headers, visitor: string): Headers {
  const nominated = new Set(
    (source.get('connection') ?? '')
      .split(',')
      .map((token) => token.trim().toLowerCase())
      .filter((token) => token.length > 0),
  );
  const headers = new Headers();
  source.forEach((value, name) => {
    if (
      DROPPED_REQUEST_HEADERS.has(name) ||
      name.startsWith(PROXY_HEADER_PREFIX) ||
      nominated.has(name)
    ) {
      return;
    }
    headers.append(name, value);
  });
  headers.set(X_FORWARDED_FOR_HEADER, visitor);
  return headers;
}

/**
 * Relayed: success, not-modified, and the client errors Rybbit answers a bad
 * beacon with. A redirect would point the visitor off the site's origin, and a
 * 5xx is the upstream failing; both become a bare 502.
 */
function isRelayedStatus(status: number): boolean {
  return (status >= 200 && status < 300) || status === 304 || (status >= 400 && status < 500);
}

function relayedResponseHeaders(
  upstream: Response,
  route: RybbitRoute,
  baseHeaders: Readonly<Record<string, string>>,
): Record<string, string> {
  const cacheable = upstream.status < 300 || upstream.status === 304;
  const headers: Record<string, string> = {
    ...baseHeaders,
    [CACHE_CONTROL_HEADER]: cacheable ? route.cacheControl : NO_STORE,
  };
  for (const name of RELAYED_RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value !== null) {
      headers[name] = value;
    }
  }
  return headers;
}
