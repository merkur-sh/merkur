import { Context, type Duration, Effect, Layer, Redacted, type Scope } from 'effect';

import { type RybbitConfig, ServerConfigService } from '../config';
import { createLogger, errorLogContext, type Logger, logWithLoggerEffect } from '../logger';

/**
 * Rybbit answers a track call in well under a second. The event is one count on
 * a dashboard, so a stalled call is abandoned rather than held open.
 */
const TRACK_TIMEOUT: Duration.Input = '5 seconds';

/**
 * Events only the server can observe. The website's own script sends every
 * other one; this one it cannot, because the waitlist answers a new address and
 * a known one identically.
 */
export type RybbitServerEvent = 'waitlist_joined';

export interface RybbitEvents {
  /**
   * Starts sending one custom event and returns without waiting for Rybbit, so
   * no response ever waits on analytics. The call is bounded by a timeout, and
   * a failure is logged as `rybbit_event_failed` and not retried: a lost count
   * is cheaper than a second request that could double it.
   *
   * The event names the website and the event, and nothing about the person:
   * no address, no IP, no user agent.
   */
  send(event: RybbitServerEvent): Effect.Effect<void>;
}

export class RybbitEventsTag extends Context.Service<RybbitEventsTag, RybbitEvents>()(
  'RybbitEvents',
) {}

export const RybbitEventsLive = Layer.effect(
  RybbitEventsTag,
  Effect.gen(function* () {
    const { website } = yield* ServerConfigService;
    // A deployment that counts nothing: no website, or a website without Rybbit.
    if (website?.rybbit === undefined) return { send: () => Effect.void };
    // Sends are forked into the layer's own scope, so one still in flight at
    // shutdown is interrupted with the runtime instead of outliving it.
    const scope = yield* Effect.scope;
    return createRybbitEvents({
      rybbit: website.rybbit,
      siteOrigin: website.origin,
      logger: createLogger('rybbit-events'),
      scope,
      timeout: TRACK_TIMEOUT,
    });
  }),
);

export function createRybbitEvents(dependencies: {
  readonly rybbit: RybbitConfig;
  readonly siteOrigin: string;
  readonly logger: Logger;
  readonly scope: Scope.Scope;
  readonly timeout: Duration.Input;
}): RybbitEvents {
  const { rybbit, logger, scope, timeout } = dependencies;
  const trackUrl = `${rybbit.host}/api/track`;
  // The name the website's own script reports as `hostname`, so both kinds of
  // event land on the same site in Rybbit.
  const hostname = new URL(dependencies.siteOrigin).hostname;

  const track = (event: RybbitServerEvent) =>
    Effect.tryPromise({
      try: async (signal) => {
        const response = await fetch(trackUrl, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${Redacted.value(rybbit.apiKey)}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            site_id: rybbit.siteId,
            type: 'custom_event',
            hostname,
            pathname: '/',
            event_name: event,
          }),
          signal,
        });
        // Drained so the connection returns to the pool; nothing in it is used.
        await response.arrayBuffer();
        return response.status;
      },
      catch: (error: unknown) => error,
    }).pipe(
      Effect.timeout(timeout),
      Effect.matchEffect({
        onSuccess: (status) =>
          status >= 200 && status < 300
            ? Effect.void
            : logWithLoggerEffect(logger, 'warn', 'rybbit_event_failed', { event, status }),
        // No answer at all: refused, reset, or past the timeout.
        onFailure: (error) =>
          logWithLoggerEffect(logger, 'warn', 'rybbit_event_failed', {
            event,
            status: null,
            ...errorLogContext(error),
          }),
      }),
    );

  return {
    send: (event) => track(event).pipe(Effect.forkIn(scope), Effect.asVoid),
  };
}
