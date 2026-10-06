import { Effect } from 'effect';
import { Elysia, status } from 'elysia';

import { type Logger, logWithLoggerEffect } from '../../logger';
import type { runServerProgram } from '../../runtime';
import { BoxWaitlistError, BoxWaitlistServiceTag } from '../../services/box-waitlist-service';
import {
  enforceRateLimit,
  RateLimitedError,
  RateLimitServiceTag,
} from '../../services/rate-limit-service';
import { RybbitEventsTag } from '../../services/rybbit-events';
import { ApiModels } from '../api-models';
import { resolveRateLimitSource } from '../client-ip';
import { runRouteEffect } from '../effect-route';

const BOX_WAITLIST_PATH = '/api/box-waitlist';
const SLASH = 0x2f;
const QUESTION_MARK = 0x3f;
const STATUS_NO_CONTENT = 204;
const STATUS_SEE_OTHER = 303;
const STATUS_BAD_REQUEST = 400;
const STATUS_FORBIDDEN = 403;
const STATUS_TOO_MANY_REQUESTS = 429;
/** Where a form posted without script lands: the page's own "you're on the list" line. */
const WAITLIST_DONE_PATH = '/#waitlist-done';
/** The fetch metadata a browser sends when the post navigates, as a plain form's does. */
const SEC_FETCH_MODE_HEADER = 'sec-fetch-mode';
const NAVIGATE = 'navigate';
/** Joins one source address may send in ten minutes: room for a corrected typo, not a list. */
const WAITLIST_IP_LIMIT = 5;
const WAITLIST_WINDOW_MS = 600_000;

interface BoxWaitlistRoutesOptions {
  readonly runServerProgram: typeof runServerProgram;
  readonly logger: Logger;
  readonly trustedProxyHops: number;
  readonly siteOrigin: string;
}

/**
 * Cross-origin access for the one route the public website calls.
 *
 * The website posts a CORS simple request: url-encoded, no custom header, no
 * credentials. The browser sends no preflight for it, so this server answers no
 * `OPTIONS`; what the browser does check is that the answer names the website
 * in `Access-Control-Allow-Origin`. Every answer on this path carries it, errors
 * included, because the page reads a 400 or a 429 to say why, and an answer
 * without the header reaches it as an opaque network failure.
 *
 * A request hook rather than a route hook, because it runs before the body is
 * parsed and validated: those failures leave through `apiErrorPlugin`, and are
 * answered from the context these headers are already set on. The allowed
 * origin is the configured one, never a reflection of the request, and
 * credentials are never allowed. Which origin may post is the route's own
 * check; this only makes its answers readable to the website.
 *
 * Registered ahead of `apiErrorPlugin`, like the security headers, so it sits
 * in front of every route and every error the app answers on this path.
 */
export function boxWaitlistCorsPlugin(siteOrigin: string) {
  return new Elysia({ name: 'box-waitlist-cors' }).request(({ request, set }) => {
    if (!isWaitlistUrl(request.url)) return;
    set.headers['access-control-allow-origin'] = siteOrigin;
    set.headers.vary = 'Origin';
  });
}

/**
 * Whether a request URL names the waitlist route the way the router matches
 * it: the raw path, undecoded, exactly or with the one trailing slash the
 * app's non-strict routing also sends to the route, and with any query.
 *
 * Compared in place rather than through `new URL`, because the hook runs for
 * every request the server answers.
 */
function isWaitlistUrl(url: string): boolean {
  const start = url.indexOf('/', url.indexOf('//') + 2);
  if (start === -1 || !url.startsWith(BOX_WAITLIST_PATH, start)) return false;
  let end = start + BOX_WAITLIST_PATH.length;
  if (url.charCodeAt(end) === SLASH) end += 1;
  return end === url.length || url.charCodeAt(end) === QUESTION_MARK;
}

/**
 * The public website's Boxes waitlist: an address, and nothing else.
 *
 * Only the website may post, so a page on any other origin cannot add
 * addresses through a visitor's browser. That is checked first, before a
 * rate-limit slot is spent or the list is touched.
 *
 * Every accepted address is answered the same way, whether it was new or already
 * on the list, so the route cannot be used to learn who is on it: a bare 204 to
 * the page's script, and to a form the page posted without script, which the
 * browser marks `Sec-Fetch-Mode: navigate`, a 303 back to the website's line
 * that says the address was taken. Only an address the waitlist will never take
 * is answered differently, with the reason, so the page can tell the person.
 */
export function boxWaitlistRoutesPlugin({
  runServerProgram,
  logger,
  trustedProxyHops,
  siteOrigin,
}: BoxWaitlistRoutesOptions) {
  return new Elysia({ name: 'box-waitlist-routes', normalize: false }).post(
    BOX_WAITLIST_PATH,
    {
      // The one body a plain HTML form sends, and one a fetch can send without
      // a preflight. Anything else is parsed as url-encoding and fails
      // validation rather than being accepted in a second shape.
      parse: 'urlencoded',
      body: ApiModels.BoxWaitlistBody,
      response: {
        204: ApiModels.EmptyResponse,
        400: ApiModels.ErrorResponse,
        403: ApiModels.ErrorResponse,
        429: ApiModels.ErrorResponse,
      },
    },
    async ({ body, request, server }) => {
      if (request.headers.get('origin') !== siteOrigin) {
        return status(STATUS_FORBIDDEN, { error: 'origin_forbidden' as const });
      }
      const clientIp = resolveRateLimitSource(request, server, trustedProxyHops);
      return runRouteEffect(
        runServerProgram,
        Effect.gen(function* () {
          const limiter = yield* RateLimitServiceTag;
          yield* enforceRateLimit(limiter, [
            {
              key: `box-waitlist:ip:${clientIp}`,
              limit: WAITLIST_IP_LIMIT,
              windowMs: WAITLIST_WINDOW_MS,
            },
          ]);
          const waitlist = yield* BoxWaitlistServiceTag;
          const { inserted } = yield* waitlist.record(body.email);
          yield* logWithLoggerEffect(logger, 'info', 'box_waitlist_recorded', { inserted });
          // Counted here, once per new row, because the page cannot tell: it
          // gets the same answer for an address that was already on the list.
          if (inserted) {
            const rybbit = yield* RybbitEventsTag;
            yield* rybbit.send('waitlist_joined');
          }
          // Returned from inside the program so the route span records the status.
          if (request.headers.get(SEC_FETCH_MODE_HEADER) === NAVIGATE) {
            return new Response(null, {
              status: STATUS_SEE_OTHER,
              headers: { location: `${siteOrigin}${WAITLIST_DONE_PATH}` },
            });
          }
          return status(STATUS_NO_CONTENT, undefined);
        }),
        routeOptions(logger, request),
      );
    },
  );
}

function routeOptions(logger: Logger, request: Request) {
  return {
    logger,
    eventName: 'box_waitlist_record_failed',
    request,
    signal: request.signal,
    mapError(error: unknown) {
      if (error instanceof RateLimitedError) {
        return status(STATUS_TOO_MANY_REQUESTS, { error: 'rate_limited' as const });
      }
      if (error instanceof BoxWaitlistError) {
        return status(STATUS_BAD_REQUEST, { error: error.code });
      }
      return null;
    },
  } as const;
}
