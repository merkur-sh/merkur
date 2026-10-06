import { describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { writeMerkurLog } from '@merkur/logger';
import { isNativePerfTraceChunk, type NativePerfTraceChunk } from '@merkur/shared';
import { SidecarFrameReader } from '@merkur/shared/node-sidecar';
import { Effect, Fiber, Metric } from 'effect';
import { TestClock } from 'effect/testing';

import type { Logger } from '../logger';
import { type DataplaneMetricEvent, daemonDataplaneReady } from './daemon-metrics';
import {
  createDataplaneClientScoped,
  createDataplaneClient as createUnconfiguredDataplaneClient,
  type DataplaneClientDependencies,
  type DataplaneConfig,
  DataplaneFatalError,
  type DataplaneHandlers,
  type DataplaneSidecarProcess,
  type DataplaneTimerHandle,
  MAX_PENDING_DATAPLANE_COMMANDS,
} from './dataplane-client';

const CMD_CONFIGURE = 0x01;
const CMD_UPDATE_REVOCATION = 0x08;
const CMD_UPDATE_STUN = 0x0c;
const CMD_UPDATE_EDGE_ADMISSION = 0x11;
const CMD_CAPTURE_TRANSPORT_STATS = 0x0d;
const CMD_CAPTURE_PERF_TRACE = 0x0e;
const CMD_START_SESSION = 0x09;
const CMD_CANCEL_SESSION = 0x0a;
const CMD_SHUTDOWN = 0x0f;
const EVT_PTY_READY = 0x82;
const EVT_PTY_CLOSED = 0x83;
const EVT_BELL = 0x85;
const EVT_PEER_DISCONNECTED = 0x88;
const EVT_ERROR = 0x8a;
const EVT_NETWORK_PATH_CHANGED = 0x8c;
const EVT_WEBTRANSPORT_READY = 0x8d;
const EVT_PEER_AUTHENTICATED = 0x8e;
const EVT_COMMAND_ACK = 0x8f;
const EVT_TRANSPORT_STATS = 0x90;
const EVT_SESSION_REBIND = 0x92;
const EVT_PERF_TRACE = 0x93;
const EVT_DAEMON_PROOF = 0x94;
const CMD_SIGN_DAEMON_PROOF = 0x10;

interface CapturedFrame {
  readonly kind: number;
  readonly payload: Uint8Array;
}

interface FakeSidecar {
  readonly child: DataplaneSidecarProcess;
  readonly inputChunks: Buffer[];
  readonly killSignals: Array<NodeJS.Signals | number | undefined>;
  emitClose(code: number, signal?: NodeJS.Signals | null): void;
  emitError(error: Error): void;
  emitStdinError(error: Error): void;
  emitFrame(kind: number, payload: object): void;
  emitRawFrame(kind: number, payload: Uint8Array): void;
}

interface ScheduledTimer {
  readonly delayMs: number;
  readonly cancelled: boolean;
  run(): void;
}

const logger: Logger = {
  info(): void {},
  warn(): void {},
  error(): void {},
};

describe('DataplaneClient lifecycle', () => {
  test('requires the exact immutable current configuration before spawning', () => {
    const sidecars: FakeSidecar[] = [];
    const client = createUnconfiguredDataplaneClient(
      logger,
      createHandlers(),
      createDependencies(sidecars),
    );

    client.start();
    expect(sidecars).toHaveLength(0);
    client.configure(createDataplaneConfig());
    client.start();
    expect(sidecars).toHaveLength(1);

    const configure = required(readFrames(sidecars[0]?.inputChunks)[0]);
    expect(configure.kind).toBe(CMD_CONFIGURE);
    const payload: unknown = JSON.parse(new TextDecoder().decode(configure.payload));
    expect(payload).toEqual(createDataplaneWireConfig(createDataplaneConfig()));

    // Pinned literally, not derived from `DataplaneConfig`.
    //
    // The equality above compares the payload against a local copy of the same
    // omission the client performs, so the two drift together: adding a field
    // to `DataplaneConfig` and forgetting to exclude it passes both sides. The
    // Rust `ConfigurePayload` denies unknown fields, so that omission is not
    // harmless — one extra key rejects the whole payload and the dataplane
    // comes up with no session-auth authority, which surfaces only as every
    // session hanging in SIGNALING. This list is the wire contract; changing it
    // means changing the Rust struct in the same commit.
    expect(Object.keys(payload as Record<string, unknown>).sort()).toEqual([
      'daemon_binding',
      'daemon_id',
      'daemon_identity_seal',
      'revoked_delegations',
      'root_epoch',
      'server_origin',
      'session_token_verify_key',
      'user_root_public_key',
    ]);
    client.stop();
  });

  test('replays configuration and revocation state into a replacement sidecar', () => {
    const sidecars: FakeSidecar[] = [];
    const client = createClient(logger, createHandlers(), createDependencies(sidecars));

    client.start();
    client.updateRevocation(17);
    client.stop();
    client.start();
    expect(sidecars).toHaveLength(1);
    required(sidecars[0]).emitClose(0);
    client.start();

    const replacement = required(sidecars[1]);
    const frames = readFrames(replacement.inputChunks);
    expect(frames.map((frame) => frame.kind)).toEqual([CMD_CONFIGURE, CMD_UPDATE_REVOCATION]);
    const generation = required(frames[1]?.payload);
    expect(
      new DataView(generation.buffer, generation.byteOffset, generation.byteLength).getUint32(0),
    ).toBe(17);
    client.stop();
  });

  /**
   * `UpdateStunCmd` is `#[serde(deny_unknown_fields)]` with no `rename_all`, so
   * the wire key set has to match its declared fields exactly. A single renamed
   * or extra key makes the sidecar reject the whole command and keep probing
   * with no credential — a `warn` line and a dead feature, not a failure any
   * other test here notices. Shipped exactly that way in v0.12.0 as `lifetimeMs`
   * against a struct expecting `lifetime_ms`.
   */
  test('sends stun credential keys that match the sidecar struct exactly', () => {
    const sidecars: FakeSidecar[] = [];
    const client = createClient(logger, createHandlers(), createDependencies(sidecars));
    client.start();
    client.updateStunCredential({
      servers: ['stun.test:3478', 'stun.test:3479'],
      ticket: 'ticket',
      secret: 'secret',
      lifetime_ms: 90_000,
    });

    const frame = readFrames(required(sidecars[0]).inputChunks).find(
      (candidate) => candidate.kind === CMD_UPDATE_STUN,
    );
    const payload = JSON.parse(new TextDecoder().decode(required(frame?.payload))) as Record<
      string,
      unknown
    >;
    // Sorted: serde matches by name, not by declaration order.
    expect(Object.keys(payload).sort()).toEqual(['lifetime_ms', 'secret', 'servers', 'ticket']);
    client.stop();
  });

  /**
   * The sidecar stamps the stated lifetime against its own clock on arrival, so
   * a replay must restate what is *left* of the ticket. Replaying the figure it
   * was issued with would hand a nearly-spent credential a full fresh validity
   * and send a probe the responder answers with silence.
   */
  test('replays a stun credential with the lifetime that remains, not the one issued', async () => {
    const sidecars: FakeSidecar[] = [];
    const client = createClient(logger, createHandlers(), createDependencies(sidecars));

    client.start();
    client.updateStunCredential({
      servers: ['stun.test:3478', 'stun.test:3479'],
      ticket: 'ticket',
      secret: 'secret',
      lifetime_ms: 90_000,
    });
    await Bun.sleep(5);
    required(sidecars[0]).emitClose(0);
    client.start();

    const replayed = readFrames(required(sidecars[1]).inputChunks).find(
      (frame) => frame.kind === CMD_UPDATE_STUN,
    );
    const payload = JSON.parse(new TextDecoder().decode(required(replayed?.payload))) as Record<
      string,
      unknown
    >;
    expect(payload.ticket).toBe('ticket');
    expect(typeof payload.lifetime_ms).toBe('number');
    expect(payload.lifetime_ms as number).toBeGreaterThan(0);
    expect(payload.lifetime_ms as number).toBeLessThan(90_000);
    client.stop();
  });

  test('drops a replayed stun credential whose lifetime has already run out', async () => {
    const sidecars: FakeSidecar[] = [];
    const client = createClient(logger, createHandlers(), createDependencies(sidecars));

    client.start();
    client.updateStunCredential({
      servers: ['stun.test:3478', 'stun.test:3479'],
      ticket: 'ticket',
      secret: 'secret',
      lifetime_ms: 1,
    });
    await Bun.sleep(10);
    required(sidecars[0]).emitClose(0);
    client.start();

    expect(
      readFrames(required(sidecars[1]).inputChunks).some((frame) => frame.kind === CMD_UPDATE_STUN),
    ).toBe(false);
    client.stop();
  });

  /**
   * Every credential is forwarded. A replacement rides each control lease — once
   * per renewal — so the sidecar never holds a ticket the server has already
   * superseded, and the server's cadence alone decides the lifetime in hand.
   */
  test('forwards every stun credential it is handed', () => {
    const sidecars: FakeSidecar[] = [];
    const client = createClient(logger, createHandlers(), createDependencies(sidecars));
    client.start();
    const sidecar = required(sidecars[0]);
    const stunFrames = (): number =>
      readFrames(sidecar.inputChunks).filter((frame) => frame.kind === CMD_UPDATE_STUN).length;

    const base = {
      servers: ['stun.test:3478', 'stun.test:3479'],
      ticket: 'ticket',
      secret: 'secret',
      lifetime_ms: 90_000,
    };
    client.updateStunCredential(base);
    expect(stunFrames()).toBe(1);
    client.updateStunCredential({ ...base, ticket: 'ticket-2' });
    expect(stunFrames()).toBe(2);
    client.updateStunCredential({
      ...base,
      ticket: 'ticket-3',
      servers: ['stun.test:3478', 'stun.test:3480'],
    });
    expect(stunFrames()).toBe(3);
    client.stop();
  });

  /**
   * `UpdateEdgeAdmissionCmd` and `EdgePinsCmd` are `deny_unknown_fields`: the
   * exact snake_case key sets, or the sidecar refuses the whole command.
   */
  test('sends the edge admission as the exact sidecar struct and replays it', async () => {
    const sidecars: FakeSidecar[] = [];
    const client = createClient(logger, createHandlers(), createDependencies(sidecars));
    client.start();
    const edges = [
      {
        edgeWtUrl: 'https://edge.example:4433/',
        certHashes: [
          Buffer.alloc(32, 1).toString('base64'),
          Buffer.alloc(32, 2).toString('base64'),
        ],
      },
    ];
    client.updateEdgeAdmission({ ticket: 'ticket-1', edges });
    client.updateEdgeAdmission({ ticket: 'ticket-2', edges });

    const payloads = (sidecar: FakeSidecar): Record<string, unknown>[] =>
      readFrames(sidecar.inputChunks)
        .filter((frame) => frame.kind === CMD_UPDATE_EDGE_ADMISSION)
        .map(
          (frame) => JSON.parse(new TextDecoder().decode(frame.payload)) as Record<string, unknown>,
        );
    const sent = payloads(required(sidecars[0]));
    expect(sent.map((payload) => Object.keys(payload))).toEqual([
      ['ticket', 'edges'],
      ['ticket', 'edges'],
    ]);
    expect(sent.map((payload) => payload.ticket)).toEqual(['ticket-1', 'ticket-2']);
    const expectedEdges = [
      { url: 'https://edge.example:4433/', cert_hashes: edges[0]?.certHashes },
    ];
    expect(sent[1]?.edges).toEqual(expectedEdges);

    // A replacement sidecar is handed the latest admission before its first
    // dial, and with it every edge to state its incarnation to.
    await Bun.sleep(5);
    required(sidecars[0]).emitClose(0);
    client.start();
    expect(payloads(required(sidecars[1]))).toEqual([{ ticket: 'ticket-2', edges: expectedEdges }]);
    client.stop();
  });

  test('settles every pending command when the sidecar exits', async () => {
    const sidecars: FakeSidecar[] = [];
    const exitReasons: string[] = [];
    const client = createClient(
      logger,
      createHandlers((reason) => exitReasons.push(reason)),
      createDependencies(sidecars),
    );
    client.start();

    const pending = Effect.runPromise(
      client.startSessionEffect(
        'command-1',
        'session-1',
        'browser-1',
        'user-1',
        'delegation-1',
        'client-nonce',
        'encapsulation-key',
        'https://edge.example/session',
        ['hash'],
      ),
    );
    required(sidecars[0]).emitClose(0);

    await expect(pending).resolves.toEqual({
      status: 'rejected',
      reason: 'dataplane_unavailable',
    });
    expect(exitReasons).toEqual(['process_closed']);
    client.stop();
  });

  test('gracefully shuts down before the bounded force-kill fallback', async () => {
    const sidecars: FakeSidecar[] = [];
    const client = createClient(logger, createHandlers(), {
      ...createDependencies(sidecars),
      shutdownGracePeriodMs: 25,
    });
    client.start();
    const sidecar = required(sidecars[0]);

    const gracefulFiber = Effect.runFork(client.shutdown());
    await waitFor(() =>
      readFrames(sidecar.inputChunks).some((frame) => frame.kind === CMD_SHUTDOWN),
    );
    expect(sidecar.killSignals).toEqual([]);
    sidecar.emitClose(0);
    await Effect.runPromise(Fiber.join(gracefulFiber));
    expect(sidecar.killSignals).toEqual([]);

    const forcedSidecars: FakeSidecar[] = [];
    const forced = createClient(logger, createHandlers(), {
      ...createDependencies(forcedSidecars),
      shutdownGracePeriodMs: 25,
      shutdownReapTimeoutMs: 25,
    });
    forced.start();
    await Effect.runPromise(
      Effect.gen(function* () {
        const shutdownFiber = yield* forced.shutdown().pipe(Effect.forkChild);
        yield* Effect.promise(() =>
          waitFor(() =>
            readFrames(required(forcedSidecars[0]).inputChunks).some(
              (frame) => frame.kind === CMD_SHUTDOWN,
            ),
          ),
        );
        yield* TestClock.adjust('25 millis');
        expect(required(forcedSidecars[0]).killSignals).toEqual(['SIGKILL']);
        let reaped = false;
        shutdownFiber.addObserver(() => {
          reaped = true;
        });
        yield* Effect.yieldNow;
        expect(reaped).toBe(false);
        yield* TestClock.adjust('25 millis');
        yield* Fiber.join(shutdownFiber);
      }).pipe(Effect.provide(TestClock.layer())),
    );
    expect(required(forcedSidecars[0]).killSignals).toEqual(['SIGKILL']);
  });

  test('an error during graceful shutdown does not impersonate process close', async () => {
    const sidecars: FakeSidecar[] = [];
    const client = createClient(logger, createHandlers(), {
      ...createDependencies(sidecars),
      shutdownGracePeriodMs: 25,
      shutdownReapTimeoutMs: 25,
    });
    client.start();
    const sidecar = required(sidecars[0]);

    await Effect.runPromise(
      Effect.gen(function* () {
        const shutdownFiber = yield* client.shutdown().pipe(Effect.forkChild);
        yield* Effect.promise(() =>
          waitFor(() =>
            readFrames(sidecar.inputChunks).some((frame) => frame.kind === CMD_SHUTDOWN),
          ),
        );
        sidecar.emitError(withErrorCode('temporary spawn pressure', 'EAGAIN'));
        expect(sidecar.killSignals).toEqual([]);

        let completed = false;
        shutdownFiber.addObserver(() => {
          completed = true;
        });
        yield* Effect.yieldNow;
        expect(completed).toBe(false);

        yield* TestClock.adjust('25 millis');
        expect(sidecar.killSignals).toEqual(['SIGKILL']);
        yield* Effect.yieldNow;
        expect(completed).toBe(false);

        sidecar.emitClose(0);
        yield* Fiber.join(shutdownFiber);
      }).pipe(Effect.provide(TestClock.layer())),
    );
  });

  test('propagates missing binaries and protocol schema defects as terminal failures', async () => {
    const missingBinary = createClient(logger, createHandlers(), {
      resolveBinaryPath: () => null,
      spawnSidecar: () => {
        throw new Error('must not spawn');
      },
    });
    missingBinary.start();
    const missingFailure = await Effect.runPromise(
      missingBinary.awaitCriticalFailure().pipe(Effect.flip),
    );
    expect(missingFailure).toBeInstanceOf(DataplaneFatalError);
    expect(missingFailure.reason).toBe('binary_not_found');

    const permissionDenied = createClient(logger, createHandlers(), {
      resolveBinaryPath: () => '/root/merkur-dataplane',
      spawnSidecar: () => {
        throw withErrorCode('permission denied', 'EACCES');
      },
    });
    permissionDenied.start();
    const permissionFailure = await Effect.runPromise(
      permissionDenied.awaitCriticalFailure().pipe(Effect.flip),
    );
    expect(permissionFailure.reason).toBe('binary_permission_denied');

    const sidecars: FakeSidecar[] = [];
    const invalidProtocol = createClient(logger, createHandlers(), createDependencies(sidecars));
    invalidProtocol.start();
    required(sidecars[0]).emitFrame(EVT_COMMAND_ACK, {
      command_id: 'surplus-command',
      status: 'accepted',
      surplus: true,
    });
    const protocolFailure = await Effect.runPromise(
      invalidProtocol.awaitCriticalFailure().pipe(Effect.flip),
    );
    expect(protocolFailure).toBeInstanceOf(DataplaneFatalError);
    expect(protocolFailure.reason).toBe('invalid_event');
  });

  test('accepts a network path change and rejects a malformed one', async () => {
    const observed: number[] = [];
    const accepted: FakeSidecar[] = [];
    const client = createClient(
      logger,
      { ...createHandlers(), onNetworkPathChanged: (count) => observed.push(count) },
      createDependencies(accepted),
    );
    client.start();
    required(accepted[0]).emitFrame(EVT_NETWORK_PATH_CHANGED, { coalesced_events: 3 });
    expect(observed).toEqual([3]);

    // Zero is not a transition, and a surplus key means the two sides of the
    // wire disagree — both are fatal rather than silently ignored.
    const rejected: FakeSidecar[] = [];
    const invalid = createClient(logger, createHandlers(), createDependencies(rejected));
    invalid.start();
    required(rejected[0]).emitFrame(EVT_NETWORK_PATH_CHANGED, { coalesced_events: 0 });
    const failure = await Effect.runPromise(invalid.awaitCriticalFailure().pipe(Effect.flip));
    expect(failure.reason).toBe('invalid_event');
  });

  test('accepts the exact rebind diagnostic event and rejects malformed contract drift', async () => {
    const acceptedSidecars: FakeSidecar[] = [];
    const accepted = createClient(logger, createHandlers(), createDependencies(acceptedSidecars));
    accepted.start();
    required(acceptedSidecars[0]).emitFrame(EVT_SESSION_REBIND, {
      session_id: 'session-rebind-1',
      outcome: 'accepted_held',
      generation: 4,
      attempt_ms: 17,
      events_suppressed: 3,
    });
    await Bun.sleep(0);
    expect(required(acceptedSidecars[0]).killSignals).toEqual([]);
    accepted.stop();

    for (const payload of [
      {
        session_id: '',
        outcome: 'committed',
        generation: 5,
        attempt_ms: 21,
        events_suppressed: 0,
      },
      {
        session_id: 'session-rebind-2',
        outcome: 'committed',
        generation: 5,
        attempt_ms: 21,
        events_suppressed: 0,
        surplus: true,
      },
    ]) {
      const rejectedSidecars: FakeSidecar[] = [];
      const rejected = createClient(logger, createHandlers(), createDependencies(rejectedSidecars));
      rejected.start();
      required(rejectedSidecars[0]).emitFrame(EVT_SESSION_REBIND, payload);
      const failure = await Effect.runPromise(rejected.awaitCriticalFailure().pipe(Effect.flip));
      expect(failure.reason).toBe('invalid_event');
      rejected.stop();
    }
  });

  test('restarts a proven transient process failure without publishing a fatal error', () => {
    const sidecars: FakeSidecar[] = [];
    const reconnectTimers: ScheduledTimer[] = [];
    const client = createClient(logger, createHandlers(), {
      ...createDependencies(sidecars),
      scheduleReconnect(delayMs, callback) {
        return scheduleCallback(reconnectTimers, delayMs, callback);
      },
    });
    client.start();
    required(sidecars[0]).emitClose(0);

    expect(sidecars).toHaveLength(1);
    const retry = required(reconnectTimers[0]);
    expect(retry.delayMs).toBe(250);
    retry.run();
    expect(sidecars).toHaveLength(2);
    client.stop();
  });

  test('reaps a failed child before scheduling or spawning its replacement', () => {
    const sidecars: FakeSidecar[] = [];
    const lifecycleTimers: ScheduledTimer[] = [];
    const reconnectTimers: ScheduledTimer[] = [];
    const client = createClient(logger, createHandlers(), {
      ...createDependencies(sidecars),
      readinessTimeoutMs: 1_000,
      shutdownGracePeriodMs: 10,
      shutdownReapTimeoutMs: 10,
      scheduleTimer(delayMs, callback) {
        return scheduleCallback(lifecycleTimers, delayMs, callback);
      },
      scheduleReconnect(delayMs, callback) {
        return scheduleCallback(reconnectTimers, delayMs, callback);
      },
    });
    client.start();
    const first = required(sidecars[0]);
    first.emitError(withErrorCode('temporary process pressure', 'EAGAIN'));

    expect(sidecars).toHaveLength(1);
    expect(reconnectTimers).toHaveLength(0);
    expect(readFrames(first.inputChunks).some((frame) => frame.kind === CMD_SHUTDOWN)).toBe(true);
    client.start();
    expect(sidecars).toHaveLength(1);

    required(lifecycleTimers.find((timer) => timer.delayMs === 10 && !timer.cancelled)).run();
    expect(first.killSignals).toEqual(['SIGKILL']);
    expect(reconnectTimers).toHaveLength(0);
    expect(sidecars).toHaveLength(1);

    first.emitClose(0);
    expect(reconnectTimers).toHaveLength(1);
    required(reconnectTimers[0]).run();
    expect(sidecars).toHaveLength(2);
    client.stop();
  });

  test('fails terminally when a force-killed child misses its reap deadline', async () => {
    const sidecars: FakeSidecar[] = [];
    const lifecycleTimers: ScheduledTimer[] = [];
    const reconnectTimers: ScheduledTimer[] = [];
    const client = createClient(logger, createHandlers(), {
      ...createDependencies(sidecars),
      readinessTimeoutMs: 1_000,
      shutdownReapTimeoutMs: 10,
      scheduleTimer(delayMs, callback) {
        return scheduleCallback(lifecycleTimers, delayMs, callback);
      },
      scheduleReconnect(delayMs, callback) {
        return scheduleCallback(reconnectTimers, delayMs, callback);
      },
    });
    client.start();
    const first = required(sidecars[0]);
    first.emitStdinError(withErrorCode('broken pipe', 'EPIPE'));
    expect(first.killSignals).toEqual(['SIGKILL']);
    expect(reconnectTimers).toHaveLength(0);

    required(lifecycleTimers.find((timer) => timer.delayMs === 10 && !timer.cancelled)).run();
    const failure = await Effect.runPromise(client.awaitCriticalFailure().pipe(Effect.flip));
    expect(failure.reason).toBe('sidecar_reap_timeout');
    expect(reconnectTimers).toHaveLength(0);
    expect(sidecars).toHaveLength(1);
  });

  test('makes permanent exits terminal and bounds ambiguous crash loops', async () => {
    const permanentSidecars: FakeSidecar[] = [];
    const permanentReconnects: ScheduledTimer[] = [];
    const permanent = createClient(logger, createHandlers(), {
      ...createDependencies(permanentSidecars),
      scheduleReconnect(delayMs, callback) {
        return scheduleCallback(permanentReconnects, delayMs, callback);
      },
    });
    permanent.start();
    required(permanentSidecars[0]).emitClose(1);
    const permanentFailure = await Effect.runPromise(
      permanent.awaitCriticalFailure().pipe(Effect.flip),
    );
    expect(permanentFailure.reason).toBe('sidecar_nonzero_exit');
    expect(permanentReconnects).toHaveLength(0);

    const maskedSidecars: FakeSidecar[] = [];
    const maskedReconnects: ScheduledTimer[] = [];
    const maskedPermanent = createClient(logger, createHandlers(), {
      ...createDependencies(maskedSidecars),
      scheduleReconnect(delayMs, callback) {
        return scheduleCallback(maskedReconnects, delayMs, callback);
      },
    });
    maskedPermanent.start();
    const maskedChild = required(maskedSidecars[0]);
    maskedChild.emitError(withErrorCode('transient-looking process error', 'EAGAIN'));
    maskedChild.emitClose(101);
    const maskedFailure = await Effect.runPromise(
      maskedPermanent.awaitCriticalFailure().pipe(Effect.flip),
    );
    expect(maskedFailure.reason).toBe('sidecar_panic');
    expect(maskedReconnects).toHaveLength(0);

    const crashSidecars: FakeSidecar[] = [];
    const crashReconnects: ScheduledTimer[] = [];
    const crashing = createClient(logger, createHandlers(), {
      ...createDependencies(crashSidecars),
      maxConsecutiveCrashes: 2,
      scheduleReconnect(delayMs, callback) {
        return scheduleCallback(crashReconnects, delayMs, callback);
      },
    });
    crashing.start();
    required(crashSidecars[0]).emitClose(0);
    required(crashReconnects[0]).run();
    expect(crashSidecars).toHaveLength(2);

    required(crashSidecars[1]).emitClose(0);
    const crashFailure = await Effect.runPromise(crashing.awaitCriticalFailure().pipe(Effect.flip));
    expect(crashFailure.reason).toBe('sidecar_crash_loop');
    expect(crashReconnects).toHaveLength(1);
  });

  test('a serving PTY satisfies readiness without direct-WebTransport discovery', () => {
    // `webtransport_ready` only lands once direct-WT NAT discovery resolves,
    // and that path is an optional upgrade — terminal traffic rides the edge
    // relay. Gating readiness on it reaped dataplanes that were already
    // serving a live terminal on any host where discovery has nowhere to go.
    const sidecars: FakeSidecar[] = [];
    const lifecycleTimers: ScheduledTimer[] = [];
    const client = createClient(logger, createHandlers(), {
      ...createDependencies(sidecars),
      readinessTimeoutMs: 10,
      scheduleTimer(delayMs, callback) {
        return scheduleCallback(lifecycleTimers, delayMs, callback);
      },
    });
    client.start();

    required(sidecars[0]).emitFrame(EVT_PTY_READY, { pid: 4242 });

    const watchdog = lifecycleTimers.find((timer) => timer.delayMs === 10);
    expect(watchdog?.cancelled).toBe(true);
    watchdog?.run();
    expect(
      readFrames(required(sidecars[0]).inputChunks).some((frame) => frame.kind === CMD_SHUTDOWN),
    ).toBe(false);
    expect(sidecars).toHaveLength(1);
    client.stop();
  });

  test('bounds missing readiness with the same stable-uptime crash budget', async () => {
    const sidecars: FakeSidecar[] = [];
    const lifecycleTimers: ScheduledTimer[] = [];
    const reconnectTimers: ScheduledTimer[] = [];
    const client = createClient(logger, createHandlers(), {
      ...createDependencies(sidecars),
      readinessTimeoutMs: 10,
      shutdownGracePeriodMs: 10,
      shutdownReapTimeoutMs: 10,
      maxConsecutiveCrashes: 2,
      scheduleTimer(delayMs, callback) {
        return scheduleCallback(lifecycleTimers, delayMs, callback);
      },
      scheduleReconnect(delayMs, callback) {
        return scheduleCallback(reconnectTimers, delayMs, callback);
      },
    });
    client.start();

    required(lifecycleTimers.find((timer) => timer.delayMs === 10 && !timer.cancelled)).run();
    expect(
      readFrames(required(sidecars[0]).inputChunks).some((frame) => frame.kind === CMD_SHUTDOWN),
    ).toBe(true);
    required(sidecars[0]).emitClose(0);
    required(reconnectTimers[0]).run();
    expect(sidecars).toHaveLength(2);

    required(
      [...lifecycleTimers]
        .reverse()
        .find((timer: ScheduledTimer) => timer.delayMs === 10 && !timer.cancelled),
    ).run();
    const failure = await Effect.runPromise(client.awaitCriticalFailure().pipe(Effect.flip));
    expect(failure.reason).toBe('sidecar_crash_loop');
    expect(sidecars).toHaveLength(2);
  });

  test('scoped reconnect scheduling is driven by Effect Clock fibers', async () => {
    const sidecars: FakeSidecar[] = [];
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* createDataplaneClientScoped(createDataplaneConfig(), logger, createHandlers(), {
            ...createDependencies(sidecars),
            shutdownGracePeriodMs: 0,
            shutdownReapTimeoutMs: 0,
          });
          expect(sidecars).toHaveLength(1);

          required(sidecars[0]).emitClose(0);
          yield* Effect.yieldNow;
          yield* TestClock.adjust('249 millis');
          expect(sidecars).toHaveLength(1);
          yield* TestClock.adjust('1 millis');
          yield* Effect.yieldNow;
          expect(sidecars).toHaveLength(2);
          required(sidecars[1]).emitClose(0);
        }),
      ).pipe(Effect.provide(TestClock.layer())),
    );
  });

  test('Effect command admission releases correlation ownership on interruption', async () => {
    const sidecars: FakeSidecar[] = [];
    const client = createClient(logger, createHandlers(), createDependencies(sidecars));
    client.start();
    const sidecar = required(sidecars[0]);
    const interrupted = Effect.runFork(
      client.cancelSessionEffect('command-1', 'session-1', 'browser-1'),
    );
    await waitFor(() =>
      readFrames(sidecar.inputChunks).some((frame) => frame.kind === CMD_CANCEL_SESSION),
    );
    await Effect.runPromise(Fiber.interrupt(interrupted));

    const replacement = Effect.runFork(
      client.cancelSessionEffect('command-1', 'session-2', 'browser-1'),
    );
    await waitFor(
      () =>
        readFrames(sidecar.inputChunks).filter((frame) => frame.kind === CMD_CANCEL_SESSION)
          .length === 2,
    );
    sidecar.emitFrame(EVT_COMMAND_ACK, {
      command_id: 'command-1',
      status: 'accepted',
    });
    await expect(Effect.runPromise(Fiber.join(replacement))).resolves.toEqual({
      status: 'accepted',
    });
    client.stop();
  });

  test('scoped service publishes ready and guaranteed down gauge transitions', async () => {
    const sidecars: FakeSidecar[] = [];
    const healthStates: string[] = [];
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* createDataplaneClientScoped(createDataplaneConfig(), logger, createHandlers(), {
            ...createDependencies(sidecars),
            shutdownGracePeriodMs: 0,
            shutdownReapTimeoutMs: 0,
            updateHealth: (state) =>
              Effect.sync(() => {
                healthStates.push(state);
              }),
          });
          expect((yield* Metric.value(daemonDataplaneReady)).value).toBe(0);
          yield* Effect.sleep('1 millis');
          expect(healthStates.at(-1)).toBe('starting');

          required(sidecars[0]).emitFrame(EVT_WEBTRANSPORT_READY, {
            port: 4433,
            cert_hash: 'hash',
            candidates: [{ addr: '127.0.0.1', port: 4433, kind: 'loopback' }],
            ipv6_reachability: 'unknown',
          });
          yield* Effect.sleep('1 millis');
          expect((yield* Metric.value(daemonDataplaneReady)).value).toBe(1);
          expect(healthStates.at(-1)).toBe('ready');
        }),
      ),
    );

    expect((await Effect.runPromise(Metric.value(daemonDataplaneReady))).value).toBe(0);
    expect(healthStates.at(-1)).toBe('down');
  });

  test('supervises scoped metric worker defects through the critical failure channel', async () => {
    const sidecars: FakeSidecar[] = [];
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const client = yield* createDataplaneClientScoped(
            createDataplaneConfig(),
            logger,
            createHandlers(),
            {
              ...createDependencies(sidecars),
              shutdownGracePeriodMs: 0,
              shutdownReapTimeoutMs: 0,
              recordMetricEffect: () => Effect.die(new Error('metric backend defect')),
            },
          );
          const failure = yield* client.awaitCriticalFailure().pipe(Effect.flip);
          expect(failure.reason).toBe('internal_defect');
          expect(String(failure.cause)).toContain('state worker failed');
        }),
      ),
    );
  });
});

describe('DataplaneClient acknowledged commands', () => {
  function traceChunk(commandId: string): NativePerfTraceChunk {
    return {
      command_id: commandId,
      owner: 1,
      peer_id: 'peer-1',
      session_id: 'session-1',
      observation_epoch: 1,
      attempted: 1,
      dropped: 0,
      stale: 0,
      record_count: 1,
      first_ordinal: 1,
      last_ordinal: 1,
      chunk_index: 0,
      chunk_count: 1,
      records: [
        { ordinal: 1, owner: 1, at_us: 10, kind: 'pty_enqueue', fields: Array(16).fill(0) },
      ],
    };
  }

  test('cold structured logging preserves all 128 records and their 16 fields', () => {
    const chunk: NativePerfTraceChunk = {
      ...traceChunk('trace-log-1'),
      attempted: 128,
      record_count: 128,
      last_ordinal: 128,
      records: Array.from({ length: 128 }, (_, index) => ({
        ordinal: index + 1,
        owner: 1,
        at_us: index,
        kind: 'quic_datagram',
        fields: Array.from({ length: 16 }, (_, field) => field),
      })),
    };
    const context = { daemonId: 'daemon-1', captureRequestedAtMs: 123, chunk };
    const written: string[] = [];
    const originalWrite = process.stdout.write;
    const originalLevel = process.env.LOG_LEVEL;
    Object.defineProperty(process.stdout, 'write', {
      configurable: true,
      value: (value: string) => {
        written.push(value);
        return true;
      },
    });
    try {
      process.env.LOG_LEVEL = 'info';
      writeMerkurLog({
        ts: '2026-09-06T00:00:00.000Z',
        level: 'info',
        scope: 'daemon',
        message: 'daemon_perf_trace_chunk',
        context,
      });
    } finally {
      Object.defineProperty(process.stdout, 'write', { configurable: true, value: originalWrite });
      if (originalLevel === undefined) delete process.env.LOG_LEVEL;
      else process.env.LOG_LEVEL = originalLevel;
    }
    expect(written).toHaveLength(1);
    const decoded: unknown = JSON.parse(required(written[0]));
    expect(decoded).toMatchObject({ context });
    expect(isNativePerfTraceChunk(chunk)).toBe(true);
  });

  test('streams an exact bounded native trace before accepting its correlated ACK', async () => {
    const sidecars: FakeSidecar[] = [];
    const client = createClient(logger, createHandlers(), createDependencies(sidecars));
    client.start();
    const sidecar = required(sidecars[0]);
    const received: NativePerfTraceChunk[] = [];
    const capture = Effect.runPromise(
      client.capturePerfTraceEffect('trace-1', (chunk) => {
        received.push(chunk);
      }),
    );
    const frame = required(
      readFrames(sidecar.inputChunks).find((entry) => entry.kind === CMD_CAPTURE_PERF_TRACE),
    );
    expect(JSON.parse(new TextDecoder().decode(frame.payload))).toEqual({ command_id: 'trace-1' });
    sidecar.emitFrame(EVT_PERF_TRACE, traceChunk('unrelated'));
    expect(received).toEqual([]);
    sidecar.emitFrame(EVT_PERF_TRACE, traceChunk('trace-1'));
    expect(received).toEqual([traceChunk('trace-1')]);
    sidecar.emitFrame(EVT_COMMAND_ACK, { command_id: 'trace-1', status: 'accepted' });
    await expect(capture).resolves.toEqual({ status: 'accepted' });
    sidecar.emitFrame(EVT_PERF_TRACE, traceChunk('trace-1'));
    expect(received).toHaveLength(1);
    client.stop();
  });

  test('rejects incomplete or malformed diagnostic captures without restarting terminal work', async () => {
    for (const failure of ['missing', 'malformed', 'duplicate', 'consumer'] as const) {
      const sidecars: FakeSidecar[] = [];
      const exitReasons: string[] = [];
      const client = createClient(
        logger,
        createHandlers((reason) => exitReasons.push(reason)),
        createDependencies(sidecars),
      );
      client.start();
      const sidecar = required(sidecars[0]);
      let delivered = 0;
      const capture = Effect.runPromise(
        client.capturePerfTraceEffect('trace-1', () => {
          delivered += 1;
          if (failure === 'consumer') throw new Error('capture output unavailable');
        }),
      );
      if (failure === 'malformed') {
        sidecar.emitFrame(EVT_PERF_TRACE, { ...traceChunk('trace-1'), extra: 'not allowed' });
      } else if (failure !== 'missing') {
        sidecar.emitFrame(EVT_PERF_TRACE, traceChunk('trace-1'));
        if (failure === 'duplicate') sidecar.emitFrame(EVT_PERF_TRACE, traceChunk('trace-1'));
      }
      sidecar.emitFrame(EVT_COMMAND_ACK, { command_id: 'trace-1', status: 'accepted' });
      await expect(capture).resolves.toEqual({
        status: 'rejected',
        reason:
          failure === 'missing'
            ? 'incomplete_perf_trace'
            : failure === 'consumer'
              ? 'perf_trace_consumer_failed'
              : 'invalid_perf_trace',
      });
      expect(delivered).toBe(failure === 'consumer' || failure === 'duplicate' ? 1 : 0);
      expect(exitReasons).toEqual([]);
      expect(sidecar.killSignals).toEqual([]);
      const normal = Effect.runPromise(client.captureTransportStatsEffect('normal-1'));
      sidecar.emitFrame(EVT_COMMAND_ACK, { command_id: 'normal-1', status: 'accepted' });
      await expect(normal).resolves.toEqual({ status: 'accepted' });
      client.stop();
    }
  });

  test('expires native trace captures and discards late chunks without invoking consumers', async () => {
    const sidecars: FakeSidecar[] = [];
    const timers: ScheduledTimer[] = [];
    const client = createClient(logger, createHandlers(), {
      ...createDependencies(sidecars),
      commandAckTimeoutMs: 25,
      scheduleTimer: (delayMs, callback) => scheduleCallback(timers, delayMs, callback),
    });
    client.start();
    let delivered = 0;
    const capture = Effect.runPromise(
      client.capturePerfTraceEffect('trace-1', () => {
        delivered += 1;
      }),
    );
    required(timers.find((timer) => timer.delayMs === 25)).run();
    await expect(capture).resolves.toEqual({ status: 'rejected', reason: 'dataplane_ack_timeout' });
    required(sidecars[0]).emitFrame(EVT_PERF_TRACE, traceChunk('trace-1'));
    expect(delivered).toBe(0);
    client.stop();
  });

  test('requests one exact correlated owner-loop transport snapshot', async () => {
    const sidecars: FakeSidecar[] = [];
    const client = createClient(logger, createHandlers(), createDependencies(sidecars));
    client.start();
    const sidecar = required(sidecars[0]);

    const capture = Effect.runPromise(client.captureTransportStatsEffect('transport-final-1'));
    const frame = required(
      readFrames(sidecar.inputChunks).find(
        (candidate) => candidate.kind === CMD_CAPTURE_TRANSPORT_STATS,
      ),
    );
    expect(JSON.parse(new TextDecoder().decode(frame.payload))).toEqual({
      command_id: 'transport-final-1',
    });

    sidecar.emitFrame(EVT_COMMAND_ACK, {
      command_id: 'transport-final-1',
      status: 'accepted',
    });
    await expect(capture).resolves.toEqual({ status: 'accepted' });
    client.stop();
  });

  test('resolves start and cancel only from their exact correlated Rust acknowledgements', async () => {
    const sidecars: FakeSidecar[] = [];
    const client = createClient(logger, createHandlers(), createDependencies(sidecars));
    client.start();
    const sidecar = required(sidecars[0]);

    const start = Effect.runPromise(
      client.startSessionEffect(
        'command-start',
        'session-1',
        'browser-1',
        'user-1',
        'delegation-1',
        'client-nonce',
        'encapsulation-key',
        'https://edge.example/session',
        ['hash-a'],
      ),
    );
    const cancel = Effect.runPromise(
      client.cancelSessionEffect('command-cancel', 'session-1', 'browser-1'),
    );
    const frames = readFrames(sidecar.inputChunks).slice(1);
    expect(frames.map((frame) => frame.kind)).toEqual([CMD_START_SESSION, CMD_CANCEL_SESSION]);
    expect(JSON.parse(new TextDecoder().decode(frames[0]?.payload))).toEqual({
      command_id: 'command-start',
      user_id: 'user-1',
      delegation_id: 'delegation-1',
      session_id: 'session-1',
      browser_node_id: 'browser-1',
      client_nonce: 'client-nonce',
      encapsulation_key: 'encapsulation-key',
      edge_wt_url: 'https://edge.example/session',
      edge_cert_hashes: ['hash-a'],
    });
    expect(JSON.parse(new TextDecoder().decode(frames[1]?.payload))).toEqual({
      command_id: 'command-cancel',
      session_id: 'session-1',
      browser_node_id: 'browser-1',
    });

    sidecar.emitFrame(EVT_COMMAND_ACK, {
      command_id: 'command-cancel',
      status: 'rejected',
      reason: 'session_not_found',
    });
    sidecar.emitFrame(EVT_COMMAND_ACK, {
      command_id: 'command-start',
      status: 'accepted',
    });

    await expect(start).resolves.toEqual({ status: 'accepted' });
    await expect(cancel).resolves.toEqual({
      status: 'rejected',
      reason: 'session_not_found',
    });
    client.stop();
  });

  test('fails closed when no sidecar can admit the command', async () => {
    const client = createClient(logger, createHandlers(), {
      resolveBinaryPath: () => null,
      spawnSidecar: () => {
        throw new Error('must not spawn');
      },
    });
    client.start();

    await expect(
      Effect.runPromise(client.cancelSessionEffect('command-1', 'session-1', 'browser-1')),
    ).resolves.toEqual({
      status: 'rejected',
      reason: 'dataplane_unavailable',
    });
    client.stop();
  });

  test('returns a bounded timeout when Rust never acknowledges admission', async () => {
    const sidecars: FakeSidecar[] = [];
    const timers: ScheduledTimer[] = [];
    const client = createClient(logger, createHandlers(), {
      ...createDependencies(sidecars),
      commandAckTimeoutMs: 25,
      scheduleTimer(delayMs, callback) {
        return scheduleCallback(timers, delayMs, callback);
      },
    });
    client.start();

    const result = Effect.runPromise(
      client.cancelSessionEffect('command-1', 'session-1', 'browser-1'),
    );
    const timeout = required(timers.find((timer) => timer.delayMs === 25));
    timeout.run();

    await expect(result).resolves.toEqual({
      status: 'rejected',
      reason: 'dataplane_ack_timeout',
    });
    client.stop();
  });

  test('rejects duplicate in-flight command IDs without writing a second frame', async () => {
    const sidecars: FakeSidecar[] = [];
    const client = createClient(logger, createHandlers(), createDependencies(sidecars));
    client.start();
    const first = Effect.runPromise(
      client.cancelSessionEffect('command-1', 'session-1', 'browser-1'),
    );
    const duplicate = Effect.runPromise(
      client.cancelSessionEffect('command-1', 'session-2', 'browser-2'),
    );

    await expect(duplicate).resolves.toEqual({
      status: 'rejected',
      reason: 'duplicate_command',
    });
    expect(
      readFrames(required(sidecars[0]).inputChunks)
        .slice(1)
        .map((frame) => frame.kind),
    ).toEqual([CMD_CANCEL_SESSION]);

    required(sidecars[0]).emitFrame(EVT_COMMAND_ACK, {
      command_id: 'command-1',
      status: 'accepted',
    });
    await expect(first).resolves.toEqual({ status: 'accepted' });
    client.stop();
  });

  test('bounds pending acknowledgements independently of pipe buffering', async () => {
    const sidecars: FakeSidecar[] = [];
    const streams: ManualBackpressureWritable[] = [];
    const client = createClient(
      logger,
      createHandlers(),
      createBackpressuredDependencies(sidecars, streams),
    );
    client.start();

    const results: Array<Promise<unknown>> = [];
    for (let index = 0; index < MAX_PENDING_DATAPLANE_COMMANDS; index += 1) {
      results.push(
        Effect.runPromise(
          client.cancelSessionEffect(`command-${index}`, `session-${index}`, 'browser-1'),
        ),
      );
    }
    const overflow = Effect.runPromise(
      client.cancelSessionEffect('command-overflow', 'session-overflow', 'browser-1'),
    );

    await expect(overflow).resolves.toEqual({
      status: 'rejected',
      reason: 'dataplane_backpressure',
    });
    expect(required(streams[0]).inputChunks).toHaveLength(1);
    client.stop();
    await Promise.all(results);
  });

  test('invalid or surplus command acknowledgements fail the sidecar generation', async () => {
    const sidecars: FakeSidecar[] = [];
    const exitReasons: string[] = [];
    const client = createClient(
      logger,
      createHandlers((reason) => exitReasons.push(reason)),
      createDependencies(sidecars),
    );
    client.start();
    const pending = Effect.runPromise(
      client.cancelSessionEffect('command-1', 'session-1', 'browser-1'),
    );

    required(sidecars[0]).emitFrame(EVT_COMMAND_ACK, {
      command_id: 'command-1',
      status: 'accepted',
      reason: 'surplus',
    });

    expect(exitReasons).toEqual(['invalid_event']);
    await expect(pending).resolves.toEqual({
      status: 'rejected',
      reason: 'dataplane_unavailable',
    });
    client.stop();
  });
});

describe('DataplaneClient bounded writer', () => {
  test('writes complete frames FIFO and resumes only after drain', async () => {
    const sidecars: FakeSidecar[] = [];
    const streams: ManualBackpressureWritable[] = [];
    const client = createClient(
      logger,
      createHandlers(),
      createBackpressuredDependencies(sidecars, streams),
    );
    client.start();
    void Effect.runPromise(client.cancelSessionEffect('command-1', 'session-1', 'browser-1'));
    void Effect.runPromise(client.cancelSessionEffect('command-2', 'session-2', 'browser-1'));

    const stream = required(streams[0]);
    expect(stream.inputChunks).toHaveLength(1);
    await stream.releaseNext();
    expect(stream.inputChunks).toHaveLength(2);
    expect(readFrames(stream.inputChunks).map((frame) => frame.kind)).toEqual([
      CMD_CANCEL_SESSION,
      CMD_CANCEL_SESSION,
    ]);
    client.stop();
  });

  test('a missing drain restarts the sidecar and rejects pending admissions', async () => {
    const sidecars: FakeSidecar[] = [];
    const streams: ManualBackpressureWritable[] = [];
    const timers: ScheduledTimer[] = [];
    const exitReasons: string[] = [];
    const client = createClient(
      logger,
      createHandlers((reason) => exitReasons.push(reason)),
      createBackpressuredDependencies(sidecars, streams, {
        commandDrainTimeoutMs: 25,
        scheduleTimer(delayMs, callback) {
          return scheduleCallback(timers, delayMs, callback);
        },
      }),
    );
    client.start();
    const pending = Effect.runPromise(
      client.cancelSessionEffect('command-1', 'session-1', 'browser-1'),
    );

    required(timers.find((timer) => timer.delayMs === 25)).run();
    expect(exitReasons).toEqual([]);
    expect(required(sidecars[0]).killSignals).toEqual(['SIGKILL']);
    await expect(pending).resolves.toEqual({
      status: 'rejected',
      reason: 'dataplane_unavailable',
    });
    required(sidecars[0]).emitClose(0);
    expect(exitReasons).toEqual(['command_drain_timeout']);
    client.stop();
  });
});

describe('DataplaneClient exact sidecar events', () => {
  test('preserves per-path display loss outcomes from the exact transport-stats contract', () => {
    const sidecars: FakeSidecar[] = [];
    const metricEvents: DataplaneMetricEvent[] = [];
    const client = createClient(logger, createHandlers(), {
      ...createDependencies(sidecars),
      recordMetric: (event) => metricEvents.push(event),
    });
    client.start();
    required(sidecars[0]).emitFrame(EVT_TRANSPORT_STATS, {
      window_ms: 10_000,
      peers: 1,
      parked_peers: 0,
      webtransport: pathStatsPayload({
        display_datagrams_received: 90,
        display_datagrams_recovered_by_fec: 7,
        display_datagrams_declared_lost: 3,
        display_datagrams_outcome_unknown: 2,
      }),
      edge: pathStatsPayload({
        display_datagrams_received: 40,
        display_datagrams_recovered_by_fec: 4,
        display_datagrams_declared_lost: 6,
        display_datagrams_outcome_unknown: 5,
      }),
      row_versions_sent: 0,
      row_versions_superseded_unapplied: 0,
      row_versions_superseded_applied: 0,
      row_resends_identical: 0,
      stale_prepared_flushes_sent: 0,
      bursts_abandoned: 0,
      bursts_unsafe_to_rewind: 0,
      datagram_send_failures: 0,
      fec_repairs_sent: 0,
      fec_repairs_refused: 0,
      resync_rows_requested: 0,
      rows_declared_lost: 0,
      unacked_datagrams_max: 0,
      edge_reliable_queued_bytes_max: 0,
      inbound_datagram_drops_wt: 0,
      inbound_datagram_drops_edge: 0,
      over_capacity_session_rejections: 0,
      direct_wt_incoming_expected: 0,
      direct_wt_incoming_unexpected: 0,
      direct_wt_admitted: 0,
      nat_keepalives_sent: 0,
      nat_punch_bursts_sent: 0,
      nat_punch_refused_not_global: 0,
      nat_punch_refused_rate_limited: 0,
      nat_side_channel_send_failed: 0,
      nat_side_channel_would_block: 0,
      stats_events_dropped: 0,
      rebind_requests: 0,
      rebind_accepted: 0,
      rebind_committed: 0,
      rebind_refused: 0,
      rebind_envelopes_rejected: 0,
      rebind_events_suppressed: 0,
    });

    expect(metricEvents).toHaveLength(1);
    const event = required(metricEvents[0]);
    expect(event.type).toBe('transport_stats');
    if (event.type !== 'transport_stats') throw new Error('expected transport stats');
    expect(event.stats.webtransport.displayDatagramsReceived).toBe(90);
    expect(event.stats.webtransport.displayDatagramsRecoveredByFec).toBe(7);
    expect(event.stats.webtransport.displayDatagramsDeclaredLost).toBe(3);
    expect(event.stats.webtransport.displayDatagramsOutcomeUnknown).toBe(2);
    expect(event.stats.edge.displayDatagramsReceived).toBe(40);
    expect(event.stats.edge.displayDatagramsRecoveredByFec).toBe(4);
    expect(event.stats.edge.displayDatagramsDeclaredLost).toBe(6);
    expect(event.stats.edge.displayDatagramsOutcomeUnknown).toBe(5);
    client.stop();
  });

  test('accepts only current terminal and WebTransport lifecycle events', () => {
    const sidecars: FakeSidecar[] = [];
    const observed: string[] = [];
    const client = createClient(
      logger,
      {
        ...createHandlers(),
        onPtyReady: () => observed.push('pty_ready'),
        onPtyClosed: () => observed.push('pty_closed'),
        onBell: () => observed.push('bell'),
        onPeerDisconnected: () => observed.push('disconnected'),
        onError: () => observed.push('error'),
        onWebTransportReady: () => observed.push('wt_ready'),
        onPeerAuthenticated: () => observed.push('authenticated'),
      },
      createDependencies(sidecars),
    );
    client.start();
    const sidecar = required(sidecars[0]);

    sidecar.emitFrame(EVT_PTY_READY, { pid: 123 });
    sidecar.emitFrame(EVT_PTY_CLOSED, { exit_code: 0, signal: 0 });
    sidecar.emitRawFrame(EVT_BELL, new Uint8Array(0));
    sidecar.emitFrame(EVT_PEER_DISCONNECTED, {
      peer_node_id: 'browser-1',
      reason: 'heartbeat_timeout',
    });
    sidecar.emitFrame(EVT_ERROR, { message: 'failure' });
    sidecar.emitFrame(EVT_WEBTRANSPORT_READY, {
      port: 4433,
      cert_hash: 'hash',
      candidates: [{ addr: '127.0.0.1', port: 4433, kind: 'loopback' }],
      ipv6_reachability: 'unknown',
    });
    sidecar.emitFrame(EVT_PEER_AUTHENTICATED, {
      peer_node_id: 'browser-1',
      browser_node_id: 'browser-1',
      session_id: 'session-1',
    });

    expect(observed).toEqual([
      'pty_ready',
      'pty_closed',
      'bell',
      'disconnected',
      'error',
      'wt_ready',
      'authenticated',
    ]);
    client.stop();
  });
  test('rejects a WebTransport ready event whose key set has drifted from the Rust struct', () => {
    // `WebTransportReadyEvt` is checked with an EXACT key set, so the Rust
    // struct and this reader are one contract. That is deliberate and has
    // teeth: a field added on one side only does not degrade gracefully, it
    // rejects the whole event — and a rejected event means
    // `onWebTransportReady` never fires and the daemon never reaches ready.
    //
    // This repo has already paid for the permissive version of this mistake
    // once, with a camelCase key against a `deny_unknown_fields` payload: a
    // silently dead feature that every gate passed.
    const complete = {
      port: 4433,
      cert_hash: 'hash',
      candidates: [{ addr: '127.0.0.1', port: 4433, kind: 'loopback' }],
      ipv6_reachability: 'unknown',
    };

    for (const [label, event] of [
      ['missing ipv6_reachability', { port: 4433, cert_hash: 'hash', candidates: [] }],
      ['unknown extra key', { ...complete, surprise: true }],
      ['empty ipv6_reachability', { ...complete, ipv6_reachability: '' }],
      // The retired mapping report. Its keys are gone from the Rust struct, so
      // an event still carrying them is drift and must reject rather than be
      // tolerated as a superset.
      [
        'retired mapping report',
        { ...complete, mapping: { upnp: false, natpmp: false, pcp: false } },
      ],
      [
        'candidate kind outside the union',
        {
          ...complete,
          candidates: [{ addr: '203.0.113.5', port: 4433, kind: 'turn' }],
        },
      ],
    ] as const) {
      const sidecars: FakeSidecar[] = [];
      const readyPorts: number[] = [];
      const client = createClient(
        logger,
        { ...createHandlers(), onWebTransportReady: (port) => readyPorts.push(port) },
        createDependencies(sidecars),
      );
      client.start();
      required(sidecars[0]).emitFrame(EVT_WEBTRANSPORT_READY, event);
      expect(readyPorts, label).toEqual([]);
      client.stop();
    }

    const sidecars: FakeSidecar[] = [];
    const readyPorts: number[] = [];
    const client = createClient(
      logger,
      { ...createHandlers(), onWebTransportReady: (port) => readyPorts.push(port) },
      createDependencies(sidecars),
    );
    client.start();
    required(sidecars[0]).emitFrame(EVT_WEBTRANSPORT_READY, complete);
    expect(readyPorts).toEqual([4433]);
    client.stop();
  });

  test('passes the shell token path to the sidecar as a process-start argument, and omits it when absent', () => {
    // The token has to be an argv entry rather than a `configure` field: the
    // dataplane reads it before the PTY exists, because the same bytes seed
    // both the child's environment and the OSC verifier. It is also excluded
    // from the wire config, and `ConfigurePayload` denies unknown fields — one
    // stray key there rejects the whole payload and every session hangs in
    // SIGNALING rather than reporting a config error.
    for (const tokenPath of ['/home/u/.merkur/shell-token', null]) {
      const captured: string[][] = [];
      const client = createUnconfiguredDataplaneClient(logger, createHandlers(), {
        resolveBinaryPath: () => '/fake/merkur-dataplane',
        spawnSidecar: (_binaryPath, _frameReader, handleFrame, options) => {
          captured.push([...(options.args ?? [])]);
          return createFakeSidecar(handleFrame).child;
        },
      });
      client.configure(createDataplaneConfig({ shell_token_path: tokenPath }));
      client.start();

      const args = captured[0] ?? [];
      expect(args).toContain('--shell');
      if (tokenPath === null) {
        expect(args).not.toContain('--shell-token-path');
      } else {
        expect(args[args.indexOf('--shell-token-path') + 1]).toBe(tokenPath);
      }
      client.stop();
    }
  });

  test('passes the open-url helper directory as a start argument, never in the payload', () => {
    const captured: string[][] = [];
    const client = createUnconfiguredDataplaneClient(logger, createHandlers(), {
      resolveBinaryPath: () => '/fake/merkur-dataplane',
      spawnSidecar: (_binaryPath, _frameReader, handleFrame, options) => {
        captured.push([...(options.args ?? [])]);
        return createFakeSidecar(handleFrame).child;
      },
    });
    const config = createDataplaneConfig({ open_url_bin_dir: '/home/u/.merkur/bin' });
    client.configure(config);
    client.start();
    const args = captured[0] ?? [];
    expect(args[args.indexOf('--open-url-bin-dir') + 1]).toBe('/home/u/.merkur/bin');
    client.stop();
    expect(Object.keys(createDataplaneWireConfig(config))).not.toContain('open_url_bin_dir');
  });

  test('never lets the shell token path reach the configure payload', () => {
    const config = createDataplaneConfig({ shell_token_path: '/home/u/.merkur/shell-token' });
    expect(Object.keys(createDataplaneWireConfig(config))).not.toContain('shell_token_path');
  });

  test('never lets the declared public endpoint reach the configure payload', () => {
    // A process-start argument, like the three beside it. The Rust
    // `ConfigurePayload` denies unknown fields, so one extra key here does not
    // degrade gracefully — it rejects the whole payload and leaves the
    // dataplane with no session-auth authority, which presents as every session
    // hanging in SIGNALING rather than as a config error.
    const config = createDataplaneConfig({ public_wt_endpoint: '203.0.113.10:44433' });
    expect(Object.keys(createDataplaneWireConfig(config))).not.toContain('public_wt_endpoint');
  });
});

function createClient(
  loggerValue: Logger,
  handlers: DataplaneHandlers,
  dependencies: DataplaneClientDependencies,
) {
  const client = createUnconfiguredDataplaneClient(loggerValue, handlers, dependencies);
  client.configure(createDataplaneConfig());
  return client;
}

function createDataplaneConfig(overrides: Partial<DataplaneConfig> = {}): DataplaneConfig {
  return {
    session_token_verify_key: Buffer.alloc(2_592, 0x33).toString('base64url'),
    daemon_id: 'daemon-1',
    daemon_identity_seal: {
      backend: 'software',
      material: Buffer.alloc(32, 0x22).toString('base64url'),
    },
    server_origin: 'https://merkur.example',
    user_root_public_key: Buffer.alloc(2_592, 0x44).toString('base64url'),
    root_epoch: 1,
    daemon_binding: {
      userId: 'user-1',
      rootKeyCommitment: Buffer.alloc(64, 0x55).toString('base64url'),
      daemonId: 'daemon-1',
      daemonIdentityKeyCommitment: Buffer.alloc(64, 0x66).toString('base64url'),
      serverOrigin: 'https://merkur.example',
      linkClaimId: 'claim-1',
      issuedAt: 1,
      signature: Buffer.alloc(4_627, 0x77).toString('base64url'),
    },
    revoked_delegations: [],
    shell: '/bin/sh',
    webtransport_port: 44_433,
    shell_token_path: null,
    open_url_bin_dir: null,
    public_wt_endpoint: null,
    ...overrides,
  };
}

function createDataplaneWireConfig(
  config: DataplaneConfig,
): Omit<
  DataplaneConfig,
  'shell' | 'webtransport_port' | 'shell_token_path' | 'open_url_bin_dir' | 'public_wt_endpoint'
> {
  const {
    shell: _shell,
    webtransport_port: _webtransportPort,
    shell_token_path: _shellTokenPath,
    open_url_bin_dir: _openUrlBinDir,
    public_wt_endpoint: _publicWtEndpoint,
    ...wireConfig
  } = config;
  return wireConfig;
}

function pathStatsPayload(
  overrides: Readonly<Record<string, number>> = {},
): Record<string, number> {
  return {
    paths_available: 1,
    paths_live: 1,
    rtt_ewma_us_max: 20_000,
    network_rtt_ewma_us_max: 20_000,
    jitter_ewma_us_max: 0,
    send_failures_max: 0,
    last_ack_age_ms_max: 1,
    display_datagrams_received: 0,
    display_datagrams_recovered_by_fec: 0,
    display_datagrams_declared_lost: 0,
    display_datagrams_outcome_unknown: 0,
    quic_sent_packets: 0,
    quic_lost_packets: 0,
    quic_lost_bytes: 0,
    quic_congestion_events: 0,
    quic_black_holes: 0,
    quic_datagrams_tx: 0,
    quic_datagrams_rx: 0,
    quic_udp_tx_bytes: 0,
    quic_udp_rx_bytes: 0,
    quic_mtu_min: 1_200,
    quic_cwnd_bytes_min: 12_000,
    quic_rtt_us_max: 20_000,
    ...overrides,
  };
}

function createHandlers(onSidecarExited: (reason: string) => void = () => {}): DataplaneHandlers {
  return {
    onSidecarExited,
    onPtyReady(): void {},
    onPtyClosed(): void {},
    onBell(): void {},
    onPeerDisconnected(): void {},
    onError(): void {},
    onNetworkPathChanged(): void {},
    onNatMappingOutcome(): void {},
    onWebTransportReady(): void {},
    onPeerAuthenticated(): void {},
  };
}

function createDependencies(sidecars: FakeSidecar[]): DataplaneClientDependencies {
  return {
    resolveBinaryPath: () => '/fake/merkur-dataplane',
    spawnSidecar: (_binaryPath, _frameReader, handleFrame) => {
      const sidecar = createFakeSidecar(handleFrame);
      sidecars.push(sidecar);
      return sidecar.child;
    },
  };
}

function createBackpressuredDependencies(
  sidecars: FakeSidecar[],
  streams: ManualBackpressureWritable[],
  overrides: Partial<DataplaneClientDependencies> = {},
): DataplaneClientDependencies {
  return {
    resolveBinaryPath: () => '/fake/merkur-dataplane',
    spawnSidecar: (_binaryPath, _frameReader, handleFrame) => {
      const stdin = new ManualBackpressureWritable();
      streams.push(stdin);
      const sidecar = createFakeSidecar(handleFrame, stdin, stdin.inputChunks);
      sidecars.push(sidecar);
      return sidecar.child;
    },
    ...overrides,
  };
}

function createFakeSidecar(
  handleFrame: (kind: number, payload: Uint8Array) => void,
  stdinOverride?: Writable,
  capturedInputChunks?: Buffer[],
): FakeSidecar {
  const emitter = new EventEmitter();
  const stdin = stdinOverride ?? new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const inputChunks: Buffer[] = capturedInputChunks ?? [];
  const killSignals: Array<NodeJS.Signals | number | undefined> = [];
  if (stdinOverride === undefined) {
    stdin.on('data', (chunk: Buffer) => {
      inputChunks.push(Buffer.from(chunk));
    });
  }
  const child: DataplaneSidecarProcess = Object.assign(emitter, {
    stdin,
    stdout,
    stderr,
    kill: (signal?: NodeJS.Signals | number) => {
      killSignals.push(signal);
      return true;
    },
  });

  return {
    child,
    inputChunks,
    killSignals,
    emitClose(code, signal = null): void {
      emitter.emit('close', code, signal);
    },
    emitError(error): void {
      emitter.emit('error', error);
    },
    emitStdinError(error): void {
      stdin.emit('error', error);
    },
    emitFrame(kind, payload): void {
      handleFrame(kind, new TextEncoder().encode(JSON.stringify(payload)));
    },
    emitRawFrame(kind, payload): void {
      handleFrame(kind, payload);
    },
  };
}

class ManualBackpressureWritable extends Writable {
  readonly inputChunks: Buffer[] = [];
  readonly bootstrapChunks: Buffer[] = [];
  private readonly pendingCallbacks: Array<(error?: Error | null) => void> = [];
  private expectingBootstrap = true;

  constructor() {
    super({ highWaterMark: 1 });
  }

  override write(
    chunk: Uint8Array | string,
    encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
    callback?: (error?: Error | null) => void,
  ): boolean {
    const isBootstrap = this.expectingBootstrap;
    const accepted =
      encodingOrCallback === undefined
        ? super.write(chunk)
        : typeof encodingOrCallback === 'function'
          ? super.write(chunk, encodingOrCallback)
          : super.write(chunk, encodingOrCallback, callback);
    return isBootstrap ? true : accepted;
  }

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    if (this.expectingBootstrap && chunk[0] === CMD_CONFIGURE) {
      this.expectingBootstrap = false;
      this.bootstrapChunks.push(Buffer.from(chunk));
      callback();
      return;
    }
    this.expectingBootstrap = false;
    this.inputChunks.push(Buffer.from(chunk));
    this.pendingCallbacks.push(callback);
  }

  async releaseNext(): Promise<void> {
    const callback = this.pendingCallbacks.shift();
    if (callback === undefined) throw new Error('no pending sidecar write');
    callback();
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

function readFrames(chunks: readonly Buffer[] | undefined): CapturedFrame[] {
  if (chunks === undefined) return [];
  const reader = new SidecarFrameReader();
  for (const chunk of chunks) reader.push(chunk);
  const frames: CapturedFrame[] = [];
  reader.processFrames((kind, payload) => {
    frames.push({ kind, payload: Uint8Array.from(payload) });
  });
  return frames;
}

function scheduleCallback(
  timers: ScheduledTimer[],
  delayMs: number,
  callback: () => void,
): DataplaneTimerHandle {
  let cancelled = false;
  let completed = false;
  const timer: ScheduledTimer = {
    delayMs,
    get cancelled() {
      return cancelled;
    },
    run(): void {
      if (cancelled || completed) return;
      completed = true;
      callback();
    },
  };
  timers.push(timer);
  return {
    cancel(): void {
      cancelled = true;
    },
  };
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('required test value missing');
  return value;
}

function withErrorCode(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error('condition not met before deadline');
    await Bun.sleep(1);
  }
}

describe('composite identity signing IPC', () => {
  const signature = Buffer.alloc(4627, 1).toString('base64url');
  const p256Signature = Buffer.alloc(64, 2).toString('base64url');
  const transcript = new TextEncoder().encode('management transcript');

  test('requires the correlated pair before its accepted acknowledgement', async () => {
    for (const hasProof of [true, false]) {
      const sidecars: FakeSidecar[] = [];
      const client = createClient(logger, createHandlers(), createDependencies(sidecars));
      client.start();
      const sidecar = required(sidecars[0]);
      const pending = Effect.runPromise(
        client.signDaemonProofEffect('proof-1', 'control', transcript),
      );
      const frame = required(
        readFrames(sidecar.inputChunks).find((entry) => entry.kind === CMD_SIGN_DAEMON_PROOF),
      );
      expect(JSON.parse(new TextDecoder().decode(frame.payload))).toEqual({
        command_id: 'proof-1',
        purpose: 'control',
        transcript: Buffer.from(transcript).toString('base64url'),
      });
      sidecar.emitFrame(EVT_DAEMON_PROOF, {
        command_id: 'stale',
        signature,
        p256_signature: p256Signature,
      });
      if (hasProof)
        sidecar.emitFrame(EVT_DAEMON_PROOF, {
          command_id: 'proof-1',
          signature,
          p256_signature: p256Signature,
        });
      sidecar.emitFrame(EVT_COMMAND_ACK, { command_id: 'proof-1', status: 'accepted' });
      await expect(pending).resolves.toEqual(
        hasProof
          ? { status: 'accepted', signature, p256Signature }
          : { status: 'rejected', reason: 'incomplete_daemon_proof' },
      );
      client.stop();
    }
  });

  test('cancels a waiting proof and discards its late completion', async () => {
    const sidecars: FakeSidecar[] = [];
    const client = createClient(logger, createHandlers(), createDependencies(sidecars));
    client.start();
    const fiber = Effect.runFork(
      client.signDaemonProofEffect('cancelled-proof', 'http', transcript),
    );
    await Effect.runPromise(Fiber.interrupt(fiber));
    const sidecar = required(sidecars[0]);
    sidecar.emitFrame(EVT_DAEMON_PROOF, {
      command_id: 'cancelled-proof',
      signature,
      p256_signature: p256Signature,
    });
    sidecar.emitFrame(EVT_COMMAND_ACK, { command_id: 'cancelled-proof', status: 'accepted' });
    expect(sidecar.killSignals).toEqual([]);
    client.stop();
  });

  test('treats a missing signature half as fatal protocol drift', async () => {
    const sidecars: FakeSidecar[] = [];
    const client = createClient(logger, createHandlers(), createDependencies(sidecars));
    client.start();
    required(sidecars[0]).emitFrame(EVT_DAEMON_PROOF, { command_id: 'proof-1', signature });
    const failure = await Effect.runPromise(Effect.flip(client.awaitCriticalFailure()));
    expect(failure.reason).toBe('invalid_event');
    client.stop();
  });

  test('never retries an identity-unsealable exit', async () => {
    const sidecars: FakeSidecar[] = [];
    const reconnectTimers: ScheduledTimer[] = [];
    const client = createClient(logger, createHandlers(), {
      ...createDependencies(sidecars),
      scheduleReconnect: (delayMs, callback) =>
        scheduleCallback(reconnectTimers, delayMs, callback),
    });
    client.start();
    required(sidecars[0]).emitClose(3);
    const failure = await Effect.runPromise(Effect.flip(client.awaitCriticalFailure()));
    expect(failure.reason).toBe('identity_unsealable');
    expect(reconnectTimers).toEqual([]);
    client.stop();
  });
});
