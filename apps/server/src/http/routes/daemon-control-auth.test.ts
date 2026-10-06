import { describe, expect, jest, test } from 'bun:test';
import { daemonControlTranscript, parseDaemonChallenge, signDaemonProof } from '@merkur/auth';
import { Deferred, Effect } from 'effect';

import { DAEMON_TEST_SEED, daemonAuthFixture } from '../daemon-auth-fixture';
import { daemonControlRoutesPlugin } from './daemon-control-routes';

async function harness(options: Parameters<typeof daemonAuthFixture>[0] = {}) {
  const accepted: string[] = [];
  const disconnected: string[] = [];
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
      socket.onmessage = (event) => {
        frames.push(String(event.data));
        challenged.resolve();
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

async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!condition()) {
    if (performance.now() >= deadline) throw new Error('Control condition timed out');
    await Bun.sleep(2);
  }
}

describe('daemon control proof boundary', () => {
  test('charges upgrade rate limits once, never for proof or command messages', async () => {
    const checks: string[] = [];
    const received: unknown[] = [];
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
          }),
      },
    });
    try {
      const c = await h.connect();
      expect(checks).toHaveLength(2);
      c.socket.send(proof(h.origin, c.nonce));
      await waitFor(() => h.accepted.length === 1);
      const ack = { type: 'command_ack', commandId: 'command-1', status: 'accepted' };
      c.socket.send(JSON.stringify(ack));
      await waitFor(() => received.length === 1);
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
            return { observePing() {} };
          }),
        receive: (id, frame) =>
          Effect.gen(function* () {
            expect(connectionId).toBe(id);
            received.push(frame);
            yield* Deferred.succeed(acknowledged, undefined);
          }),
      },
    });
    try {
      const c = await h.connect();
      c.socket.send(proof(h.origin, c.nonce));
      await waitFor(() => c.frames.length === 3);
      const ack = { type: 'command_ack', commandId: 'revoke-1', status: 'accepted' };
      c.socket.send(JSON.stringify(ack));
      await waitFor(() => received.length === 1);
      expect(received).toEqual([ack]);
      expect(registered).toBe(false);
      expect(c.closed).toBe(false);
      await Effect.runPromise(Deferred.succeed(finishRegistration, undefined));
      await waitFor(() => registered);
      c.socket.send(JSON.stringify(ack));
      await waitFor(() => received.length === 2);
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
      await waitFor(() => second.closed);
      expect(h.accepted).toEqual([]);
      first.socket.send(proof(h.origin, first.nonce));
      await waitFor(() => first.frames.length === 2);
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
      await waitFor(() => resumed.closed);
      const command = await h.connect();
      command.socket.send(JSON.stringify({ type: 'command_ack' }));
      await waitFor(() => command.closed);
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
      await waitFor(() => c.closed);
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
    let entering = false;
    const h = await harness({
      control: {
        acceptConnection: () =>
          Effect.gen(function* () {
            entering = true;
            yield* Effect.promise(() => gate.promise);
            return { observePing() {} };
          }),
      },
    });
    try {
      const c = await h.connect();
      c.socket.send(proof(h.origin, c.nonce));
      await waitFor(() => entering);
      c.socket.close();
      await waitFor(() => c.closed);
      await waitFor(() => h.disconnected.length === 1);
      gate.resolve();
      await waitFor(() => h.disconnected.length === 2);
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
