import { type MerkurSpanAttributes, spanAttributes } from '@merkur/shared';
import { RedisClient } from 'bun';
import { Context, Data, Effect, Exit, Layer, Metric, Queue, Redacted, Schedule } from 'effect';
import { ServerConfigService } from '../config';
import { createLogger, errorLogContext } from '../logger';
import { redisOperationTimeoutCounter } from '../observability/metrics';
import type { RedisScript } from './redis-script';

const COMMAND_QUEUE_MAX_LENGTH = 1_000;
const REDIS_RECONNECT_SCHEDULE = Schedule.min([
  Schedule.exponential('50 millis'),
  Schedule.spaced('1 second'),
]);
const REDIS_CONNECT_DEADLINE = '6 seconds';
const REDIS_OPERATION_DEADLINE = '5 seconds';
const REDIS_CONNECT_DEADLINE_MS = 6_000;
const REDIS_OPERATION_DEADLINE_MS = 5_000;

interface LoggerLike {
  error(event: string, details?: Record<string, unknown>): void;
}

export class RedisError extends Data.TaggedError('RedisError')<{
  readonly cause: unknown;
  readonly message: string;
}> {}

export class RedisTransportError extends RedisError {
  readonly kind = 'transport' as const;

  constructor(
    readonly operation: string,
    cause: unknown,
  ) {
    super({
      cause,
      message: `Redis transport failed during \`${operation}\``,
    });
  }
}

export class RedisTimeoutError extends RedisError {
  readonly kind = 'timeout' as const;
  readonly outcome = 'unknown' as const;

  constructor(
    readonly operation: string,
    readonly deadlineMs: number,
  ) {
    super({
      cause: null,
      message: `Redis operation \`${operation}\` exceeded its ${deadlineMs}ms deadline`,
    });
  }
}

export class RedisReplyError extends RedisError {
  readonly kind = 'reply' as const;

  constructor(
    readonly replyLabel: string,
    message: string,
    cause: unknown = null,
  ) {
    super({
      cause,
      message: `Invalid ${replyLabel} reply: ${message}`,
    });
  }
}

export interface RedisCommandClient {
  sendCommand<T = unknown>(args: string[]): Promise<T>;
  /** Optional so focused test doubles can keep implementing raw EVAL only. */
  evalScript?<T = unknown>(
    script: RedisScript,
    keys: readonly string[],
    args: readonly string[],
  ): Promise<T>;
}

export interface RedisHealthSnapshot {
  readonly commandsReady: boolean;
  readonly publisherReady: boolean;
  readonly subscriberReady: boolean;
}

export interface RedisService {
  useCommands<T>(
    fn: (client: RedisCommandClient) => T | PromiseLike<T>,
  ): Effect.Effect<T, RedisError>;
  publish(channel: string, message: string): Effect.Effect<void, RedisError>;
  subscribe(channel: string, handler: (message: string) => void): Effect.Effect<void, RedisError>;
  unsubscribe(
    channel: string,
    handler?: (message: string) => void,
  ): Effect.Effect<void, RedisError>;
  /** Optional so focused test doubles do not need to model Redis's script cache. */
  loadScripts?(scripts: readonly RedisScript[]): Effect.Effect<void, RedisError>;
  /**
   * Fires after the subscriber connection comes back from a drop. Pub/sub is
   * lossy across that gap — the service re-issues every SUBSCRIBE, but whatever
   * was published meanwhile is gone — so consumers that stream events use this
   * to force their own resync. Returns the unregister effect. Optional so
   * focused test doubles that never reconnect need not model it.
   */
  onSubscriberReconnected?(listener: () => void): Effect.Effect<Effect.Effect<void>>;
  healthSnapshot(): Effect.Effect<RedisHealthSnapshot>;
}

export class RedisServiceTag extends Context.Service<RedisServiceTag, RedisService>()(
  'RedisService',
) {}

export const RedisServiceLive = Layer.effect(
  RedisServiceTag,
  Effect.gen(function* () {
    const config = yield* ServerConfigService;
    const logger = createLogger('server');

    return yield* createRedisServiceEffect(Redacted.value(config.redisUrl), logger);
  }),
);

interface RedisOperationHealth {
  available: boolean;
  replyCompatible: boolean;
}

export const createRedisServiceEffect = Effect.fnUntraced(function* (
  redisUrl: string,
  logger: LoggerLike,
) {
  let closed = false;
  const [commands, publisher, subscriber] = yield* Effect.acquireRelease(
    Effect.sync(
      () =>
        [
          createRedisClient(redisUrl),
          createRedisClient(redisUrl),
          createRedisClient(redisUrl),
        ] as const,
    ),
    ([commands, publisher, subscriber]) =>
      Effect.sync(() => {
        closed = true;
        subscriber.close();
        publisher.close();
        commands.close();
      }),
  );
  const commandsHealth: RedisOperationHealth = {
    available: true,
    replyCompatible: true,
  };
  const publisherHealth: RedisOperationHealth = {
    available: true,
    replyCompatible: true,
  };
  const subscriberHealth: RedisOperationHealth = {
    available: true,
    replyCompatible: true,
  };
  const commandClient = createRedisCommandClient(commands);
  const publishClient = createRedisCommandClient(publisher);
  const subscriberReconnectListeners = new Set<() => void>();

  const subscriptions = createRedisSubscriptionClient(
    subscriber,
    (error) => updateRedisOperationHealth(subscriberHealth, error),
    (error) => logger.error('redis_subscription_cleanup_failed', errorLogContext(error)),
  );
  let subscriberConnected = false;
  let subscriptionsReady = false;
  // Bun retains local listeners across reconnects but does not reissue SUBSCRIBE.
  // Raw SUBSCRIBE restores the wire state without registering duplicate listeners.
  const restoreSubscriptions = useRedisClient(
    subscriber,
    async (client) => {
      await Promise.all(
        [...subscriptions.channels()].map((channel) => client.send('SUBSCRIBE', [channel])),
      );
    },
    'Redis.subscribe',
    (error) => updateRedisOperationHealth(subscriberHealth, error),
  ).pipe(
    Effect.tap(() =>
      Effect.sync(() => {
        subscriptionsReady = true;
        const reconnected = subscriberConnected;
        subscriberConnected = true;
        if (!reconnected) return;
        for (const listener of subscriberReconnectListeners) {
          try {
            listener();
          } catch (error) {
            logger.error('redis_subscriber_reconnect_listener_failed', errorLogContext(error));
          }
        }
      }),
    ),
  );

  const connections = [
    { client: commands, name: 'commands', health: commandsHealth },
    { client: publisher, name: 'publisher', health: publisherHealth },
    { client: subscriber, name: 'subscriber', health: subscriberHealth },
  ];
  const connectAll = yield* Effect.forEach(connections, ({ client, name, health }) =>
    Effect.gen(function* () {
      const disconnected = yield* Queue.dropping<void>(1);
      attachRedisErrorLogger(
        client,
        logger,
        name,
        health,
        () => {
          if (client === subscriber) subscriptionsReady = false;
          Queue.offerUnsafe(disconnected, undefined);
        },
        () => closed,
      );
      const connect = connectRedisClient(client).pipe(
        Effect.andThen(client === subscriber ? restoreSubscriptions : Effect.void),
        Effect.tapError(() => Effect.sync(() => client.close())),
      );
      return {
        connect,
        recover: Effect.forever(
          Queue.take(disconnected).pipe(
            Effect.andThen(
              Queue.clear(disconnected).pipe(
                Effect.andThen(connect),
                Effect.retry(REDIS_RECONNECT_SCHEDULE),
              ),
            ),
          ),
        ),
      };
    }),
  );
  yield* Effect.all(
    connectAll.map(({ connect }) => connect),
    { concurrency: 'unbounded', discard: true },
  );
  yield* Effect.forEach(connectAll, ({ recover }) => Effect.forkScoped(recover));
  return {
    useCommands: (fn) =>
      useRedisClient(commandClient, fn, 'Redis.commands', (error) =>
        updateRedisOperationHealth(commandsHealth, error),
      ),

    loadScripts(scripts: readonly RedisScript[]): Effect.Effect<void, RedisError> {
      return useRedisClient(
        commandClient,
        (client) => loadRedisScripts(client, scripts),
        'Redis.script-load',
        (error) => updateRedisOperationHealth(commandsHealth, error),
      );
    },

    publish(channel: string, message: string): Effect.Effect<void, RedisError> {
      return useRedisClient(
        publishClient,
        async (client) => {
          await client.sendCommand(['PUBLISH', channel, message]);
        },
        'Redis.publish',
        (error) => updateRedisOperationHealth(publisherHealth, error),
      );
    },

    subscribe: subscriptions.subscribe,
    unsubscribe: subscriptions.unsubscribe,

    onSubscriberReconnected(listener: () => void): Effect.Effect<Effect.Effect<void>> {
      return Effect.sync(() => {
        subscriberReconnectListeners.add(listener);
        return Effect.sync(() => {
          subscriberReconnectListeners.delete(listener);
        });
      });
    },

    healthSnapshot(): Effect.Effect<RedisHealthSnapshot> {
      return Effect.sync(() => ({
        commandsReady: redisConnectionHealthy(commands, commandsHealth),
        publisherReady: redisConnectionHealthy(publisher, publisherHealth),
        subscriberReady: subscriptionsReady && redisConnectionHealthy(subscriber, subscriberHealth),
      }));
    },
  } satisfies RedisService;
});

export function evalRedisScript<T = unknown>(
  client: RedisCommandClient,
  script: RedisScript,
  keys: readonly string[],
  args: readonly string[],
): Promise<T> {
  if (client.evalScript !== undefined) {
    return client.evalScript<T>(script, keys, args);
  }
  return client.sendCommand<T>(['EVAL', script.source, String(keys.length), ...keys, ...args]);
}

export function preloadRedisScripts(
  redis: RedisService,
  scripts: readonly RedisScript[],
): Effect.Effect<void, RedisError> {
  return redis.loadScripts?.(scripts) ?? Effect.void;
}

export function createRedisCommandClient(client: Pick<RedisClient, 'send'>): RedisCommandClient {
  let pending = 0;
  const commands: RedisCommandClient = {
    async sendCommand<T = unknown>(args: string[]): Promise<T> {
      const [command, ...parameters] = args;
      if (command === undefined) throw new RedisReplyError('command', 'must not be empty');
      if (pending >= COMMAND_QUEUE_MAX_LENGTH) {
        throw new RedisTransportError('Redis.commands', new Error('Redis command queue is full'));
      }
      pending += 1;
      try {
        return await client.send(command, parameters);
      } finally {
        pending -= 1;
      }
    },
    evalScript<T = unknown>(
      script: RedisScript,
      keys: readonly string[],
      args: readonly string[],
    ): Promise<T> {
      return executeRedisScript<T>(commands, script, keys, args);
    },
  };
  return commands;
}

async function executeRedisScript<T>(
  client: RedisCommandClient,
  script: RedisScript,
  keys: readonly string[],
  args: readonly string[],
): Promise<T> {
  const command = ['EVALSHA', script.sha1, String(keys.length), ...keys, ...args];
  try {
    return await client.sendCommand<T>(command);
  } catch (cause) {
    if (!isNoScriptError(cause)) throw cause;
    await loadRedisScript(client, script);
    return client.sendCommand<T>(command);
  }
}

async function loadRedisScripts(
  client: RedisCommandClient,
  scripts: readonly RedisScript[],
): Promise<void> {
  await Promise.all(scripts.map((script) => loadRedisScript(client, script)));
}

async function loadRedisScript(client: RedisCommandClient, script: RedisScript): Promise<void> {
  const loadedSha = await client.sendCommand<unknown>(['SCRIPT', 'LOAD', script.source]);
  if (loadedSha !== script.sha1) {
    throw new RedisReplyError(`SCRIPT LOAD ${script.name}`, `must return SHA-1 ${script.sha1}`);
  }
}

function isNoScriptError(cause: unknown): boolean {
  return cause instanceof Error && /^NOSCRIPT(?:\s|$)/.test(cause.message);
}

interface RedisPubSubClient {
  subscribe(channel: string, handler: (message: string) => void): Promise<number>;
  unsubscribe(channel: string, handler?: (message: string) => void): Promise<void>;
}

interface RedisSubscription {
  active: boolean;
  established: boolean;
  pending: number;
  readonly nativeHandler: (message: string) => void;
  subscribed?: Promise<number>;
}

/** Each logical registration owns a distinct native listener, including across failed attempts. */
export function createRedisSubscriptionClient(
  client: RedisPubSubClient,
  observe?: (error: RedisError | null) => void,
  cleanupFailed?: (error: unknown) => void,
) {
  const channels = new Map<string, Map<(message: string) => void, RedisSubscription>>();
  const removeNative = (channel: string, subscription: RedisSubscription): void => {
    // Bun's pending native subscribe cannot be cancelled. Disable delivery immediately,
    // then remove its exact listener both now and after that pending operation settles.
    void Promise.resolve()
      .then(() => client.unsubscribe(channel, subscription.nativeHandler))
      .catch((error: unknown) => cleanupFailed?.(error));
  };
  const retire = (
    channel: string,
    handler: (message: string) => void,
    subscription: RedisSubscription,
  ): void => {
    subscription.active = false;
    const handlers = channels.get(channel);
    if (handlers?.get(handler) === subscription) {
      handlers.delete(handler);
      if (handlers.size === 0) channels.delete(channel);
    }
    removeNative(channel, subscription);
  };
  const subscribe = Effect.fnUntraced(function* (
    channel: string,
    handler: (message: string) => void,
  ) {
    yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const handlers =
          channels.get(channel) ?? new Map<(message: string) => void, RedisSubscription>();
        let subscription = handlers.get(handler);
        if (subscription === undefined) {
          const created: RedisSubscription = {
            active: true,
            established: false,
            pending: 0,
            nativeHandler: (message) => {
              if (created.active) handler(message);
            },
          };
          subscription = created;
          handlers.set(handler, created);
          channels.set(channel, handlers);
        }
        const owned = subscription;
        owned.pending += 1;
        yield* restore(
          useRedisClient(
            client,
            (native) => {
              if (owned.subscribed !== undefined) return owned.subscribed;
              const subscribed = native.subscribe(channel, owned.nativeHandler);
              owned.subscribed = subscribed;
              void subscribed.then(
                () => {
                  if (!owned.active) removeNative(channel, owned);
                },
                () => {
                  if (!owned.active) removeNative(channel, owned);
                },
              );
              return subscribed;
            },
            'Redis.subscribe',
            observe,
          ).pipe(
            Effect.andThen(() =>
              owned.active
                ? Effect.void
                : Effect.fail(
                    new RedisTransportError(
                      'Redis.subscribe',
                      new Error('Redis subscription was released before acquisition completed'),
                    ),
                  ),
            ),
          ),
        ).pipe(
          Effect.onExit((exit) =>
            Effect.sync(() => {
              owned.pending -= 1;
              if (Exit.isSuccess(exit) && owned.active) owned.established = true;
              if (!owned.established && owned.pending === 0 && owned.active) {
                retire(channel, handler, owned);
              }
            }),
          ),
        );
      }),
    );
  });
  const unsubscribe = Effect.fnUntraced(function* (
    channel: string,
    handler?: (message: string) => void,
  ) {
    yield* useRedisClient(
      client,
      async (native) => {
        const handlers = channels.get(channel);
        if (handler === undefined) {
          if (handlers !== undefined) {
            for (const subscription of handlers.values()) subscription.active = false;
            channels.delete(channel);
          }
          await native.unsubscribe(channel);
          return;
        }
        const subscription = handlers?.get(handler);
        if (subscription === undefined) return;
        subscription.active = false;
        handlers?.delete(handler);
        if (handlers?.size === 0) channels.delete(channel);
        await native.unsubscribe(channel, subscription.nativeHandler);
      },
      'Redis.unsubscribe',
      observe,
    );
  });
  return { channels: () => channels.keys(), subscribe, unsubscribe };
}

function connectRedisClient(client: RedisClient): Effect.Effect<void, RedisError> {
  return Effect.tryPromise({
    try: async () => {
      await client.connect();
    },
    catch: (cause) => new RedisTransportError('Redis.connect', cause),
  }).pipe(
    Effect.timeoutOrElse({
      duration: REDIS_CONNECT_DEADLINE,
      orElse: () => Effect.fail(new RedisTimeoutError('Redis.connect', REDIS_CONNECT_DEADLINE_MS)),
    }),
    Effect.tapError((error) =>
      error instanceof RedisTimeoutError
        ? Metric.update(redisOperationTimeoutCounter, 1)
        : Effect.void,
    ),
  );
}

export function useRedisClient<T, Client>(
  client: Client,
  fn: (client: Client) => T | PromiseLike<T>,
  // Narrowed to the span attribute's own union rather than `string`: this value
  // becomes `db.operation.name` on every Redis span, and a typo there is a new
  // attribute value nobody reviewed. The type is the review.
  operation: MerkurSpanAttributes['db.operation.name'],
  observe?: (error: RedisError | null) => void,
): Effect.Effect<T, RedisError> {
  return Effect.tryPromise({
    try: () => Promise.resolve(fn(client)),
    catch: (cause) =>
      cause instanceof RedisError ? cause : new RedisTransportError(operation, cause),
  }).pipe(
    Effect.timeoutOrElse({
      duration: REDIS_OPERATION_DEADLINE,
      orElse: () => Effect.fail(new RedisTimeoutError(operation, REDIS_OPERATION_DEADLINE_MS)),
    }),
    Effect.tapError((error) =>
      error instanceof RedisTimeoutError
        ? Metric.update(redisOperationTimeoutCounter, 1)
        : Effect.void,
    ),
    Effect.tap(() =>
      observe === undefined
        ? Effect.void
        : Effect.sync(() => {
            observe(null);
          }),
    ),
    Effect.tapError((error) =>
      observe === undefined
        ? Effect.void
        : Effect.sync(() => {
            observe(error);
          }),
    ),
    // `Debug`, because this wraps *every* Redis command: span volume here
    // scales with Redis QPS rather than request rate, and a presence-heavy
    // request can emit a dozen. Below the default `TRACE_LEVEL` it costs
    // nothing, and lowering the threshold turns the detail back on without a
    // deploy. An unsampled span forces its descendants unsampled, which is
    // correct — a Redis call has none.
    Effect.withSpan('redis.operation', {
      level: 'Debug',
      kind: 'client',
      attributes: spanAttributes({
        'db.system': 'redis',
        'db.operation.name': operation,
      }),
    }),
  );
}

function createRedisClient(redisUrl: string): RedisClient {
  return new RedisClient(redisUrl, {
    enableOfflineQueue: false,
    connectionTimeout: 5_000,
    // Effect owns an unbounded, scoped reconnect loop; Bun's retry budget is finite.
    autoReconnect: false,
  });
}

function attachRedisErrorLogger(
  client: RedisClient,
  logger: LoggerLike,
  connectionName: string,
  health: RedisOperationHealth,
  disconnected: () => void,
  isClosed: () => boolean,
): void {
  client.onconnect = () => {
    if (isClosed()) return;
    // Transport recovery cannot repair a deterministic reply incompatibility.
    health.available = true;
  };
  client.onclose = (error) => {
    if (isClosed()) return;
    health.available = false;
    logger.error('redis_error', { connectionName, ...errorLogContext(error) });
    disconnected();
  };
}

function updateRedisOperationHealth(health: RedisOperationHealth, error: RedisError | null): void {
  if (error === null) {
    health.available = true;
    return;
  }
  health.available = false;
  if (error instanceof RedisReplyError) {
    // A malformed deterministic reply means the deployed Redis/Lua contract
    // is incompatible. A later unrelated PING or command cannot prove that
    // contract healthy, so keep readiness failed until the process is replaced.
    health.replyCompatible = false;
  }
}

function redisConnectionHealthy(client: RedisClient, health: RedisOperationHealth): boolean {
  return client.connected && health.available && health.replyCompatible;
}
