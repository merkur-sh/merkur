import { describe, expect, jest, test } from 'bun:test';
import { daemonControlTranscript, parseDaemonChallenge, signDaemonProof } from '@merkur/auth';
import { Deferred, Effect } from 'effect';

import { DAEMON_TEST_SEED, daemonAuthFixture } from '../daemon-auth-fixture';
import { daemonControlRoutesPlugin } from './daemon-control-routes';

async function harness(options: Parameters<typeof daemonAuthFixture>[0] = {}) {
  const accepted: string[] = [];
  const disconnected: string[] = [];
  const disconnectionWaiters = new Set<() => void>();
  const f = daemonAuthFixture({
    ...options,
    control: {
      acceptConnection: (input) =>
        Effect.sync(() => {
          accepted.push(input.connectionId);
          input.socket.sendText(JSON.stringify({ type: 'accepted' }));
          return { observePing() {} };
        }),
      disconnect: (id) =>
        Effect.sync(() => {
          disconnected.push(id);
          for (const notify of disconnectionWaiters) notify();
        }),
      ...options.control,
    },
  });
  const app = daemonControlRoutesPlugin({
    runServerProgram: f.runProgram,
    logger: f.logger,
    publicOrigin: f.origin,
    trustedProxyHops: 0,
  }).listen(0);
  const NativeWebSocket = WebSocket as typeof WebSocket & {
    new (url: string, options: Bun.WebSocketOptions): WebSocket & { terminate(): void };
  };
  const sockets: Array<WebSocket & { terminate(): void }> = [];
  return {
    accepted,
    disconnected,
    origin: f.origin,
    waitForDisconnections(count: number): Promise<void> {
      return new Promise((resolve) => {
        const check = () => {
          if (disconnected.length < count) return;
          disconnectionWaiters.delete(check);
          resolve();
        };
        disconnectionWaiters.add(check);
        check();
      });
    },
    async connect(resume?: string) {
      const socket = new NativeWebSocket(`ws://127.0.0.1:${app.server?.port}/api/daemon/control`, {
        headers: {
          'x-merkur-daemon-id': 'daemon-1',
          'x-merkur-version': 'dev',
          ...(resume === undefined ? {} : { 'x-merkur-resume-presence': resume }),
        },
      });
      sockets.push(socket);
      const frames: string[] = [];
      // Socket events, not polling, so a test can run the server's timers in virtual time.
      const challenged = Promise.withResolvers<void>();
      const closing = Promise.withResolvers<CloseEvent>();
      const frameWaiters = new Set<() => void>();
      socket.onmessage = (event) => {
        frames.push(String(event.data));
        challenged.resolve();
        for (const notify of frameWaiters) notify();
      };
      let closed = false;
      socket.onclose = (event) => {
        closed = true;
        challenged.resolve();
        closing.resolve(event);
      };
      await challenged.promise;
      const nonce = parseDaemonChallenge(frames[0]);
      if (nonce === null) throw new Error('Missing fresh challenge');
      return {
        socket,
        frames,
        nonce,
        closing: closing.promise,
        waitForFrames(count: number): Promise<void> {
          return new Promise((resolve) => {
            const check = () => {
              if (frames.length < count) return;
              frameWaiters.delete(check);
              resolve();
            };
            frameWaiters.add(check);
            check();
          });
        },
        get closed() {
          return closed;
        },
      };
    },
    async stop() {
      for (const socket of sockets) socket.terminate();
      await app.stop(true);
    },
  };
}

function proof(origin: string, nonce: string, resume: string | null = null) {
  const pair = signDaemonProof(
    DAEMON_TEST_SEED,
    'control',
    daemonControlTranscript('daemon-1', `${origin}/api/daemon/control`, 'dev', resume, nonce),
  );
  return JSON.stringify({ type: 'auth_proof', signature: pair.mldsa, p256_signature: pair.p256 });
}

describe('daemon control proof boundary', () => {
  test('refuses a daemon on another release before any rate limit, challenge or proof', async () => {
    const checks: string[] = [];
    const f = daemonAuthFixture({
      rateLimit: {
        consume: (rule) =>
          Effect.sync(() => {
            checks.push(rule.key);
            return { allowed: true as const };
          }),
      },
    });
    const app = daemonControlRoutesPlugin({
      runServerProgram: f.runProgram,
      logger: f.logger,
      publicOrigin: f.origin,
      trustedProxyHops: 0,
    }).listen(0);
    try {
      // The test process is a source build, so its release is `dev`.
      const response = await fetch(`http://127.0.0.1:${app.server?.port}/api/daemon/control`, {
        headers: {
          connection: 'Upgrade',
          upgrade: 'websocket',
          'sec-websocket-version': '13',
          'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
          'x-merkur-daemon-id': 'daemon-1',
          'x-merkur-version': 'v9.9.9',
        },
      });
      expect(response.status).toBe(426);
      expect(checks).toEqual([]);
    } finally {
      await app.stop(true);
    }
  });

  test('charges upgrade rate limits once, never for proof or command messages', async () => {
    const checks: string[] = [];
    const received: unknown[] = [];
    const acknowledged = Promise.withResolvers<void>();
    const h = await harness({
      rateLimit: {
        consume: (rule) =>
          Effect.sync(() => {
            checks.push(rule.key);
            return checks.length <= 2
              ? { allowed: true as const }
              : { allowed: false as const, retryAfterMs: 60_000 };
          }),
      },
      control: {
        receive: (_id, frame) =>
          Effect.sync(() => {
            received.push(frame);
            acknowledged.resolve();
          }),
      },
    });
    try {
      const c = await h.connect();
      expect(checks).toHaveLength(2);
      c.socket.send(proof(h.origin, c.nonce));
      await c.waitForFrames(2);
      const ack = { type: 'command_ack', commandId: 'command-1', status: 'accepted' };
      c.socket.send(JSON.stringify(ack));
      await acknowledged.promise;
      expect(received).toEqual([ack]);
      expect(checks).toHaveLength(2);
      expect(c.closed).toBe(false);
    } finally {
      await h.stop();
    }
  });

  test('delivers command acknowledgements while registration awaits the revocation flush', async () => {
    const acknowledged = Effect.runSync(Deferred.make<void>());
    const finishRegistration = Effect.runSync(Deferred.make<void>());
    const received: unknown[] = [];
    const registrationFinished = Promise.withResolvers<void>();
    const secondAcknowledged = Promise.withResolvers<void>();
    let registered = false;
    let connectionId: string | undefined;
    const h = await harness({
      control: {
        acceptConnection: (input) =>
          Effect.gen(function* () {
            connectionId = input.connectionId;
            input.socket.sendText(JSON.stringify({ type: 'registered' }));
            input.socket.sendText(
              JSON.stringify({ type: 'delegation_revoke', commandId: 'revoke-1' }),
            );
            yield* Deferred.await(acknowledged);
            yield* Deferred.await(finishRegistration);
            registered = true;
            registrationFinished.resolve();
            return { observePing() {} };
          }),
        receive: (id, frame) =>
          Effect.gen(function* () {
            expect(connectionId).toBe(id);
            received.push(frame);
            if (received.length === 2) secondAcknowledged.resolve();
            yield* Deferred.succeed(acknowledged, undefined);
          }),
      },
    });
    try {
      const c = await h.connect();
      c.socket.send(proof(h.origin, c.nonce));
      await c.waitForFrames(3);
      const ack = { type: 'command_ack', commandId: 'revoke-1', status: 'accepted' };
      c.socket.send(JSON.stringify(ack));
      await Effect.runPromise(Deferred.await(acknowledged));
      expect(received).toEqual([ack]);
      expect(registered).toBe(false);
      expect(c.closed).toBe(false);
      await Effect.runPromise(Deferred.succeed(finishRegistration, undefined));
      await registrationFinished.promise;
      c.socket.send(JSON.stringify(ack));
      await secondAcknowledged.promise;
      expect(h.disconnected).toEqual([]);
    } finally {
      await Effect.runPromise(Deferred.succeed(acknowledged, undefined));
      await Effect.runPromise(Deferred.succeed(finishRegistration, undefined));
      await h.stop();
    }
  });

  test('registers only after proof and rejects a captured proof on another socket', async () => {
    const h = await harness();
    try {
      const first = await h.connect();
      const second = await h.connect();
      expect(first.nonce).not.toBe(second.nonce);
      expect(h.accepted).toEqual([]);
      second.socket.send(proof(h.origin, first.nonce));
      await second.closing;
      expect(h.accepted).toEqual([]);
      first.socket.send(proof(h.origin, first.nonce));
      await first.waitForFrames(2);
      expect(h.accepted).toHaveLength(1);
    } finally {
      await h.stop();
    }
  });

  test('rejects unsigned resume metadata and commands before authentication', async () => {
    const h = await harness();
    try {
      const resumed = await h.connect('3f1b2c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d');
      resumed.socket.send(proof(h.origin, resumed.nonce));
      await resumed.closing;
      const command = await h.connect();
      command.socket.send(JSON.stringify({ type: 'command_ack' }));
      await command.closing;
      expect(h.accepted).toEqual([]);
    } finally {
      await h.stop();
    }
  });

  test('a concurrent second proof cancels the pending verification', async () => {
    const gate = Promise.withResolvers<void>();
    const h = await harness({ beforeVerify: () => gate.promise });
    try {
      const c = await h.connect();
      const signed = proof(h.origin, c.nonce);
      c.socket.send(signed);
      c.socket.send(signed);
      await c.closing;
      gate.resolve();
      await Bun.sleep(20);
      expect(h.accepted).toEqual([]);
    } finally {
      gate.resolve();
      await h.stop();
    }
  });

  test('a close during registration cleans up a late service acceptance', async () => {
    const gate = Promise.withResolvers<void>();
    const entering = Promise.withResolvers<void>();
    const h = await harness({
      control: {
        acceptConnection: () =>
          Effect.gen(function* () {
            entering.resolve();
            yield* Effect.promise(() => gate.promise);
            return { observePing() {} };
          }),
      },
    });
    try {
      const c = await h.connect();
      c.socket.send(proof(h.origin, c.nonce));
      await entering.promise;
      c.socket.close();
      await c.closing;
      await h.waitForDisconnections(1);
      gate.resolve();
      await h.waitForDisconnections(2);
      expect(h.disconnected[0]).toBe(h.disconnected[1]);
    } finally {
      gate.resolve();
      await h.stop();
    }
  });

  test('expires an unanswered challenge without registering a daemon', async () => {
    // Virtual time: the five-second authentication deadline elapses without the wall clock.
    jest.useFakeTimers();
    const h = await harness();
    try {
      const c = await h.connect();
      jest.advanceTimersByTime(5_000);
      const close = await c.closing;
      expect(close.code).toBe(1008);
      expect(close.reason).toBe('authentication_timeout');
      expect(h.accepted).toEqual([]);
    } finally {
      jest.useRealTimers();
      await h.stop();
    }
  });
});
