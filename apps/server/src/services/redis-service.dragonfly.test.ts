import { expect, test } from 'bun:test';
import { RedisClient } from 'bun';
import { Effect } from 'effect';
import { defineRedisScript } from './redis-script';
import { createRedisServiceEffect, evalRedisScript, type RedisService } from './redis-service';

const url = process.env.DRAGONFLY_TEST_URL;

if (url === undefined) {
  test.skip('native Redis connections preserve command and subscription contracts', () => {});
} else {
  test('raw replies and cached Lua execution survive SCRIPT FLUSH', async () => {
    await withRedis(url, async (redis, probe) => {
      const script = defineRedisScript('native-client-test', 'return {ARGV[1], 7, false}');
      await Effect.runPromise(redis.loadScripts?.([script]) ?? Effect.void);
      const evaluate = () =>
        Effect.runPromise(
          redis.useCommands((client) => evalRedisScript(client, script, [], ['value'])),
        );
      expect(await evaluate()).toEqual(['value', 7, null]);
      await probe.send('SCRIPT', ['FLUSH']);
      expect(await evaluate()).toEqual(['value', 7, null]);
      expect(await Effect.runPromise(redis.healthSnapshot())).toEqual({
        commandsReady: true,
        publisherReady: true,
        subscriberReady: true,
      });
    });
  });

  test('deduplicates concurrent listeners, unsubscribes individually, and restores channels before resync', async () => {
    await withRedis(url, async (redis, probe) => {
      const channel = `native-client:${crypto.randomUUID()}`;
      const seen: string[] = [];
      const first = (message: string) => seen.push(`first:${message}`);
      const second = (message: string) => seen.push(`second:${message}`);
      const extraChannel = `${channel}:extra`;
      await Effect.runPromise(redis.subscribe(extraChannel, second));
      await Promise.all([
        Effect.runPromise(redis.subscribe(channel, first)),
        Effect.runPromise(redis.subscribe(channel, first)),
        Effect.runPromise(redis.subscribe(channel, second)),
      ]);
      await publishAndWait(redis, channel, 'one', () => seen.length >= 2);
      expect(seen).toEqual(['first:one', 'second:one']);
      await Effect.runPromise(redis.unsubscribe(channel, first));
      await Effect.runPromise(redis.unsubscribe(channel, first));
      await publishAndWait(redis, channel, 'two', () => seen.length >= 3);
      expect(seen).toEqual(['first:one', 'second:one', 'second:two']);
      let recovered = Promise.withResolvers<void>();
      const removeListener = await Effect.runPromise(
        redis.onSubscriberReconnected?.(() => recovered.resolve()) ??
          Effect.die('missing reconnect signal'),
      );
      for (const message of ['three', 'four']) {
        const clients: string = await probe.send('CLIENT', ['LIST']);
        const subscriber = clients
          .split('\n')
          .map(
            (line) =>
              new Map(
                line.split(' ').map((field) => {
                  const separator = field.indexOf('=');
                  return [field.slice(0, separator), field.slice(separator + 1)];
                }),
              ),
          )
          .find((fields) => fields.get('flags')?.includes('P') === true);
        const id = subscriber?.get('id');
        if (id === undefined) throw new Error('missing subscriber connection');
        expect(await probe.send('CLIENT', ['KILL', 'ID', id])).toBe(1);
        await recovered.promise;
        expect((await Effect.runPromise(redis.healthSnapshot())).subscriberReady).toBe(true);
        const before = seen.length;
        await publishAndWait(redis, channel, message, () => seen.length > before);
        expect(seen.slice(before)).toEqual([`second:${message}`]);
        await publishAndWait(
          redis,
          extraChannel,
          `extra-${message}`,
          () => seen.length > before + 1,
        );
        expect(seen.slice(before)).toEqual([`second:${message}`, `second:extra-${message}`]);
        recovered = Promise.withResolvers<void>();
      }
      await Effect.runPromise(removeListener);
      await Effect.runPromise(redis.unsubscribe(channel));
      expect(await probe.publish(channel, 'unsubscribed')).toBe(0);
    });
  });
  test('closing the service scope closes every native connection', async () => {
    const redis = await Effect.runPromise(
      Effect.scoped(createRedisServiceEffect(url, { error() {} })),
    );
    expect(await Effect.runPromise(redis.healthSnapshot())).toEqual({
      commandsReady: false,
      publisherReady: false,
      subscriberReady: false,
    });
    await expect(
      Effect.runPromise(redis.useCommands((client) => client.sendCommand(['PING']))),
    ).rejects.toThrow('Redis transport failed');
  });
}

async function withRedis(
  redisUrl: string,
  run: (redis: RedisService, probe: RedisClient) => Promise<void>,
): Promise<void> {
  const probe = new RedisClient(redisUrl);
  try {
    await probe.connect();
    await Effect.runPromise(
      Effect.scoped(
        createRedisServiceEffect(redisUrl, { error() {} }).pipe(
          Effect.flatMap((redis) => Effect.promise(() => run(redis, probe))),
          Effect.timeout('4 seconds'),
        ),
      ),
    );
  } finally {
    probe.close();
  }
}

async function publishAndWait(
  redis: RedisService,
  channel: string,
  message: string,
  received: () => boolean,
): Promise<void> {
  await Effect.runPromise(redis.publish(channel, message));
  const deadline = AbortSignal.timeout(3_000);
  while (!received()) {
    deadline.throwIfAborted();
    await Bun.sleep(1);
  }
}
