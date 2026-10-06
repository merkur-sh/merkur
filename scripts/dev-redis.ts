import { RedisClient } from 'bun';
import { Data, Effect, Redacted } from 'effect';

class RedisProbeError extends Data.TaggedError('RedisProbeError')<{
  readonly message: string;
}> {}

/** Auth, selected database, and TLS use exactly the same Bun client as the server. */
export const probeRedis = Effect.fnUntraced(function* (url: Redacted.Redacted<string>) {
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const client = yield* Effect.acquireRelease(
        Effect.try({
          try: () =>
            new RedisClient(Redacted.value(url), {
              connectionTimeout: 2_000,
              enableOfflineQueue: false,
              autoReconnect: false,
            }),
          catch: () => new RedisProbeError({ message: 'Cannot initialize Redis client' }),
        }),
        (client) => Effect.sync(() => client.close()),
      );
      yield* Effect.tryPromise({
        try: () => client.connect(),
        catch: () => new RedisProbeError({ message: 'Redis authentication or connection failed' }),
      });
      const reply = yield* Effect.tryPromise({
        try: () => client.send('PING', []),
        catch: () => new RedisProbeError({ message: 'Redis PING failed' }),
      });
      if (reply !== 'PONG')
        return yield* new RedisProbeError({ message: 'Redis did not answer PONG' });
    }).pipe(Effect.timeout('3 seconds')),
  );
});

export function redisEndpoint(url: Redacted.Redacted<string>): string {
  const parsed = new URL(Redacted.value(url));
  return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
}
