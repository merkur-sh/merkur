import { expect, spyOn, test } from 'bun:test';
import { createConnection, createServer, type Socket } from 'node:net';
import { RedisClient } from 'bun';
import { Effect, Fiber, Predicate } from 'effect';
import { TestClock } from 'effect/testing';
import { defineRedisScript } from './redis-script';
import {
  createRedisServiceEffect,
  evalRedisScript,
  type RedisService,
  RedisTimeoutError,
} from './redis-service';

const url = process.env.DRAGONFLY_TEST_URL;

if (url === undefined) {
  test.skip('native Redis connections preserve command and subscription contracts', () => {});
} else {
  test('blackholed_transport_recovers_without_replaying_commands through a response-stalling proxy', async () => {
    const key = `transport-once:${crypto.randomUUID()}`;
    const proxy = await responseStallingProxy(url, key);
    const ownership = nativeCommandOwnership();
    const probe = new RedisClient(url);
    try {
      await probe.connect();
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const redis = yield* createRedisServiceEffect(proxy.url, { error() {} });
            const mutation = yield* redis
              .useCommands((client) => client.sendCommand(['INCR', key]))
              .pipe(Effect.flip, Effect.forkChild);
            const stalled = yield* Effect.promise(() => proxy.stalled.promise);
            yield* Effect.promise(() => stalled.response.promise);
            expect(yield* Effect.promise(() => probe.get(key))).toBe('1');
            yield* TestClock.adjust('5 seconds');
            expect(yield* Fiber.join(mutation)).toBeInstanceOf(RedisTimeoutError);
            process.stdout.write(
              `native_blackhole_before_drain ${JSON.stringify({ mutations: proxy.mutations(), heldReplies: proxy.heldReplies(), nativePending: ownership.pending() })}\n`,
            );
            yield* Effect.promise(() => stalled.closed.promise);
            while (!(yield* redis.healthSnapshot()).commandsReady) yield* Effect.yieldNow;
            expect(yield* redis.useCommands((client) => client.sendCommand(['PING']))).toBe('PONG');
            expect(yield* Effect.promise(() => probe.get(key))).toBe('1');
            const metrics = {
              mutations: proxy.mutations(),
              heldReplies: proxy.heldReplies(),
              nativePending: ownership.pending(),
            };
            process.stdout.write(`native_blackhole_after_drain ${JSON.stringify(metrics)}\n`);
            expect(metrics).toEqual({ mutations: 1, heldReplies: 0, nativePending: 0 });
          }),
        ).pipe(Effect.provide(TestClock.layer())),
        { signal: AbortSignal.timeout(4_000) },
      );
    } finally {
      await probe.del(key);
      probe.close();
      await proxy.close();
      ownership.restore();
    }
  });

  test('blackholed_transport_keeps_other_native_callers_until_their_own_deadlines', async () => {
    const key = `transport-later:${crypto.randomUUID()}`;
    const proxy = await responseStallingProxy(url, key);
    const probe = new RedisClient(url);
    try {
      await probe.connect();
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const redis = yield* createRedisServiceEffect(proxy.url, { error() {} });
            const first = yield* redis
              .useCommands((client) => client.sendCommand(['INCR', key]))
              .pipe(Effect.flip, Effect.forkChild);
            const stalled = yield* Effect.promise(() => proxy.stalled.promise);
            yield* Effect.promise(() => stalled.response.promise);
            yield* TestClock.adjust('1 second');
            const second = yield* redis
              .useCommands((client) => client.sendCommand(['GET', key]))
              .pipe(Effect.forkChild);
            yield* Effect.promise(() => proxy.later.promise);
            yield* TestClock.adjust('4 seconds');
            expect(yield* Fiber.join(first)).toBeInstanceOf(RedisTimeoutError);
            expect(stalled.socket.destroyed).toBe(false);
            stalled.release();
            expect(yield* Fiber.join(second)).toBe('1');
            yield* Effect.promise(() => stalled.closed.promise);
            while (!(yield* redis.healthSnapshot()).commandsReady) yield* Effect.yieldNow;
            expect(yield* redis.useCommands((client) => client.sendCommand(['PING']))).toBe('PONG');
            expect(proxy.mutations()).toBe(1);
            expect(proxy.heldReplies()).toBe(0);
          }),
        ).pipe(Effect.provide(TestClock.layer())),
        { signal: AbortSignal.timeout(4_000) },
      );
    } finally {
      await probe.del(key);
      probe.close();
      await proxy.close();
    }
  });

  test('native_transport_close reconnects command admission without replay', async () => {
    let restore: (() => void) | undefined;
    try {
      await withRedis(url, async (redis, probe) => {
        const reconnected = Promise.withResolvers<void>();
        const original = RedisClient.prototype.connect;
        const connect = spyOn(RedisClient.prototype, 'connect').mockImplementation(async function (
          this: RedisClient,
        ) {
          await original.call(this);
          reconnected.resolve();
        });
        restore = () => connect.mockRestore();
        const id = await Effect.runPromise(
          redis.useCommands((client) => client.sendCommand(['CLIENT', 'ID'])),
        );
        expect(await probe.send('CLIENT', ['KILL', 'ID', String(id)])).toBe(1);
        await reconnected.promise;
        expect(
          await Effect.runPromise(redis.useCommands((client) => client.sendCommand(['PING']))),
        ).toBe('PONG');
        const successor = await Effect.runPromise(
          redis.useCommands((client) => client.sendCommand(['CLIENT', 'ID'])),
        );
        expect(successor).not.toBe(id);
        expect((await Effect.runPromise(redis.healthSnapshot())).commandsReady).toBe(true);
      });
    } finally {
      restore?.();
    }
  });

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

async function responseStallingProxy(redisUrl: string, key: string) {
  interface Peer {
    socket: Socket;
    upstream: Socket;
    held: Buffer[];
    blocked: boolean;
    response: ReturnType<typeof Promise.withResolvers<void>>;
    closed: ReturnType<typeof Promise.withResolvers<void>>;
    release: () => void;
  }
  const target = new URL(redisUrl);
  const peers = new Set<Peer>();
  const requests: string[][] = [];
  const stalled = Promise.withResolvers<Peer>();
  const later = Promise.withResolvers<void>();
  const server = createServer((socket) => {
    const upstream = createConnection({ host: target.hostname, port: Number(target.port || 6379) });
    const peer: Peer = {
      socket,
      upstream,
      held: [],
      blocked: false,
      response: Promise.withResolvers<void>(),
      closed: Promise.withResolvers<void>(),
      release() {
        this.blocked = false;
        for (const chunk of this.held) this.socket.write(chunk);
        this.held.length = 0;
      },
    };
    peers.add(peer);
    let buffered = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buffered = Buffer.concat([buffered, Buffer.from(chunk)]);
      while (buffered.length !== 0) {
        const parsed = parseCommand(buffered);
        if (parsed === null) break;
        buffered = buffered.subarray(parsed.bytes);
        requests.push(parsed.args);
        if (parsed.args[0] === 'INCR' && parsed.args[1] === key) {
          peer.blocked = true;
          stalled.resolve(peer);
        }
        if (parsed.args[0] === 'GET' && parsed.args[1] === key) later.resolve();
      }
      upstream.write(chunk);
    });
    upstream.on('data', (chunk) => {
      if (peer.blocked) {
        peer.held.push(Buffer.from(chunk));
        peer.response.resolve();
      } else socket.write(chunk);
    });
    socket.on('close', () => {
      upstream.destroy();
      peer.held.length = 0;
      peers.delete(peer);
      peer.closed.resolve();
    });
    upstream.on('close', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
    upstream.on('error', () => socket.destroy());
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || Predicate.isString(address)) throw new Error('missing proxy port');
  const proxyUrl = new URL(redisUrl);
  proxyUrl.hostname = '127.0.0.1';
  proxyUrl.port = String(address.port);
  return {
    url: proxyUrl.toString(),
    stalled,
    later,
    mutations: () => requests.filter((args) => args[0] === 'INCR' && args[1] === key).length,
    heldReplies: () => [...peers].reduce((count, peer) => count + peer.held.length, 0),
    close: async () => {
      const closed = [...peers].map((peer) => peer.closed.promise);
      for (const peer of peers) {
        peer.socket.destroy();
        peer.upstream.destroy();
      }
      await Promise.all(closed);
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function parseCommand(buffer: Buffer): { args: string[]; bytes: number } | null {
  const header = buffer.indexOf('\r\n');
  if (header < 0) return null;
  if (buffer[0] !== 42) throw new Error('expected RESP command array');
  const count = Number(buffer.toString('ascii', 1, header));
  let offset = header + 2;
  const args: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const end = buffer.indexOf('\r\n', offset);
    if (end < 0) return null;
    if (buffer[offset] !== 36) throw new Error('expected RESP bulk argument');
    const length = Number(buffer.toString('ascii', offset + 1, end));
    offset = end + 2;
    if (buffer.length < offset + length + 2) return null;
    args.push(buffer.toString('utf8', offset, offset + length));
    offset += length + 2;
  }
  return { args, bytes: offset };
}

function nativeCommandOwnership() {
  const original = RedisClient.prototype.send;
  let pending = 0;
  const send = spyOn(RedisClient.prototype, 'send').mockImplementation(function (
    this: RedisClient,
    command: string,
    args: string[],
  ) {
    const result = original.call(this, command, args);
    pending += 1;
    void result.then(
      () => {
        pending -= 1;
      },
      () => {
        pending -= 1;
      },
    );
    return result;
  });
  return { pending: () => pending, restore: () => send.mockRestore() };
}
