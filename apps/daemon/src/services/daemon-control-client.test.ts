import { describe, expect, test } from 'bun:test';
import {
  daemonControlTranscript,
  deriveSessionAuthorizationKeyPair,
  deriveSoftwareDaemonP256PublicKey,
  parseDaemonControlSignature,
  signDaemonProof,
  verifyDaemonProof,
} from '@merkur/auth';
import {
  createDaemonControlDelegationRevokeMessage,
  createDaemonControlLeaseMessage,
  createDaemonControlRegisteredMessage,
  createDaemonControlRevocationMessage,
  createDaemonControlSessionCancelMessage,
  createDaemonControlSessionStartMessage,
  createDaemonControlSupersededMessage,
  encodeDaemonControlMessage,
  parseDaemonControlDaemonMessage,
} from '@merkur/daemon-control-protocol';
import { isRecord } from '@merkur/shared';
import type {
  DelegationRevocationStatement,
  UserDelegationCertificate,
} from '@merkur/shared/user-authorization';
import {
  Cause,
  Deferred,
  Effect,
  Logger as EffectLogger,
  Exit,
  Fiber,
  Queue,
  References,
} from 'effect';
import { TestClock } from 'effect/testing';

import type { DaemonConfig } from '../config';
import {
  DAEMON_CONTROL_EVENT_QUEUE_CAPACITY,
  DAEMON_SHUTDOWN_CLOSE_CODE,
  type DaemonControlClientDependencies,
  type DaemonControlClientOptions,
  type DaemonControlHealthReporter,
  type DaemonControlPathSignal,
  type DaemonControlSocket,
  daemonControlWebSocketUrl,
  runDaemonControlClientEffect,
} from './daemon-control-client';
import type {
  DataplaneCommandResult,
  DataplaneEdgeAdmission,
  DataplaneStunCredential,
} from './dataplane-client';

const CERT_HASH = Buffer.alloc(32, 7).toString('base64');
const USER_ID = 'user-1';
const DELEGATION_ID = 'delegation-1';
const CLIENT_NONCE = Buffer.alloc(32, 0x11).toString('base64url');
const ENCAPSULATION_KEY = Buffer.alloc(1_568, 0x22).toString('base64url');
const ROOT_KEY_COMMITMENT = Buffer.alloc(64, 0x33).toString('base64url');
const DELEGATE_PUBLIC_KEY = Buffer.alloc(2_592, 0x44).toString('base64url');
const DELEGATION_SIGNATURE = Buffer.alloc(4_627, 0x55).toString('base64url');
const REVOCATION_NONCE = Buffer.alloc(32, 0x66).toString('base64url');
const DELEGATION_ISSUED_AT = 1_800_000_000_000;
const DELEGATION_EXPIRES_AT = DELEGATION_ISSUED_AT + 30 * 24 * 60 * 60 * 1_000;
/** The registry every registration and lease in these tests states. */
const EDGES = [
  {
    edgeWtUrl: 'https://edge.example:4433/',
    certHashes: [CERT_HASH, Buffer.alloc(32, 8).toString('base64')],
  },
];

const DELEGATION_CERTIFICATE = {
  userId: USER_ID,
  rootKeyCommitment: ROOT_KEY_COMMITMENT,
  delegationId: DELEGATION_ID,
  delegatePublicKey: DELEGATE_PUBLIC_KEY,
  scopes: ['terminal-session', 'session-revoke'],
  serverOrigin: 'https://merkur.example',
  rootEpoch: 1,
  issuedAt: DELEGATION_ISSUED_AT,
  expiresAt: DELEGATION_EXPIRES_AT,
  signature: DELEGATION_SIGNATURE,
} as const;

const DELEGATION_REVOCATION = {
  userId: USER_ID,
  rootKeyCommitment: ROOT_KEY_COMMITMENT,
  actorDelegationId: DELEGATION_ID,
  targets: [
    { delegationId: 'delegation-1', expiresAt: DELEGATION_EXPIRES_AT },
    { delegationId: 'delegation-2', expiresAt: DELEGATION_EXPIRES_AT },
  ],
  issuedAt: DELEGATION_ISSUED_AT + 1_000,
  nonce: REVOCATION_NONCE,
  signature: DELEGATION_SIGNATURE,
} as const;

describe('daemon control WebSocket URL', () => {
  test('derives WSS from HTTPS without putting credentials in the URL', () => {
    expect(daemonControlWebSocketUrl('https://merkur.example')).toBe(
      'wss://merkur.example/api/daemon/control',
    );
  });

  test('allows plaintext WebSocket only for explicit loopback development', () => {
    expect(daemonControlWebSocketUrl('http://127.0.0.1:3000')).toBe(
      'ws://127.0.0.1:3000/api/daemon/control',
    );
    expect(daemonControlWebSocketUrl('http://[::1]:3000')).toBe(
      'ws://[::1]:3000/api/daemon/control',
    );
    expect(() => daemonControlWebSocketUrl('http://merkur.example')).toThrow('requires HTTPS');
  });
});

describe('daemon control connection', () => {
  test('reports a resume instead of a ping timeout after the process was suspended', async () => {
    const harness = createHarness();
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* runHarnessControlClient(harness).pipe(Effect.forkScoped);
          yield* Effect.promise(() => waitFor(() => harness.sockets.length === 1));
          const socket = required(harness.sockets[0]);
          socket.emitMessage(
            createDaemonControlRegisteredMessage(
              'connection-1',
              'presence-1',
              1,
              0,
              1_000,
              3_000,
              ['stun.test:3478', 'stun.test:3479'],
              'ticket',
              'secret',
              4_000,
              'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
              EDGES,
            ),
          );
          yield* Effect.promise(() => waitFor(() => harness.revocations.length === 1));

          // A laptop slept: the monotonic schedule barely moved, but the wall
          // clock jumped far past what this sleep should have cost.
          harness.advanceWallClock(38 * 60 * 60 * 1_000);
          yield* TestClock.adjust('1000 millis');

          yield* Effect.promise(() =>
            waitFor(() =>
              harness.logs.some((entry) => entry.message === 'daemon_control_process_resumed'),
            ),
          );
          // The distinction is the point: this used to land in the ping
          // timeout bucket, which made that metric unreadable.
          expect(
            harness.logs.some((entry) => entry.message === 'daemon_control_ping_timeout'),
          ).toBe(false);
          // No doomed ping is queued behind the teardown.
          expect(socket.pings).toBe(1);

          // A resume skips the ladder entirely — no backoff is scheduled.
          yield* Effect.promise(() => waitFor(() => harness.sockets.length === 2));
          expect(
            harness.logs.some((entry) => entry.message === 'daemon_control_reconnect_scheduled'),
          ).toBe(false);
        }),
      ).pipe(Effect.provide(TestClock.layer())),
    );
  });

  test('an OS network path change tears the carrier down and reconnects', async () => {
    const harness = createHarness();
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const pathSignals = yield* Queue.sliding<DaemonControlPathSignal>(1);
          yield* runHarnessControlClient(harness, undefined, harness.dataplane, {
            pathSignals,
          }).pipe(Effect.forkScoped);
          yield* Effect.promise(() => waitFor(() => harness.sockets.length === 1));
          const socket = required(harness.sockets[0]);
          socket.emitMessage(
            createDaemonControlRegisteredMessage(
              'connection-1',
              'presence-1',
              1,
              0,
              1_000,
              3_000,
              ['stun.test:3478', 'stun.test:3479'],
              'ticket',
              'secret',
              4_000,
              'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
              EDGES,
            ),
          );
          yield* Effect.promise(() => waitFor(() => harness.revocations.length === 1));

          Queue.offerUnsafe(pathSignals, { coalescedEvents: 4 });
          yield* Effect.promise(() =>
            waitFor(() =>
              harness.logs.some((entry) => entry.message === 'daemon_control_network_path_changed'),
            ),
          );
          // No pong deadline was waited out: that blind spot is the whole
          // reason this signal exists.
          expect(
            harness.logs.some((entry) => entry.message === 'daemon_control_ping_timeout'),
          ).toBe(false);

          yield* TestClock.adjust('250 millis');
          yield* Effect.promise(() => waitFor(() => harness.sockets.length === 2));
        }),
      ).pipe(Effect.provide(TestClock.layer())),
    );
  });

  test('a network path change wakes a pending reconnect without resetting failure backoff', async () => {
    const harness = createHarness({ initialReconnectDelayMs: 30_000 });
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const pathSignals = yield* Queue.sliding<DaemonControlPathSignal>(1);
          yield* runHarnessControlClient(harness, undefined, harness.dataplane, {
            pathSignals,
          }).pipe(Effect.forkScoped);
          yield* Effect.promise(() => waitFor(() => harness.sockets.length === 1));
          required(harness.sockets[0]).emitClose(1_006);
          yield* Effect.promise(() => waitForReconnectLogCount(harness.logs, 1));
          expect(reconnectDelays(harness.logs)).toEqual([30_000]);

          // The OS has supplied a new path. No virtual time advances: retrying
          // it must not wait for the failed path's thirty-second deadline.
          Queue.offerUnsafe(pathSignals, { coalescedEvents: 4 });
          yield* Effect.promise(() => waitFor(() => harness.sockets.length === 2));
          const replacement = required(harness.sockets[1]);
          expect(replacement.terminated).toBe(false);

          // Another failure without another path edge still waits on the
          // existing ladder. Waking one attempt must not enable rapid polling.
          replacement.emitClose(1_006);
          yield* Effect.promise(() => waitForReconnectLogCount(harness.logs, 2));
          expect(reconnectDelays(harness.logs)).toEqual([30_000, 30_000]);
          yield* TestClock.adjust('29999 millis');
          expect(harness.sockets).toHaveLength(2);
          yield* TestClock.adjust('1 millis');
          yield* Effect.promise(() => waitFor(() => harness.sockets.length === 3));
        }),
      ).pipe(Effect.provide(TestClock.layer())),
    );
  });

  test('a completed reconnect delay leaves path signals owned by the new carrier', async () => {
    const harness = createHarness();
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const pathSignals = yield* Queue.sliding<DaemonControlPathSignal>(1);
          yield* runHarnessControlClient(harness, undefined, harness.dataplane, {
            pathSignals,
          }).pipe(Effect.forkScoped);
          yield* Effect.promise(() => waitFor(() => harness.sockets.length === 1));
          required(harness.sockets[0]).emitClose(1_006);
          yield* Effect.promise(() => waitForReconnectLogCount(harness.logs, 1));
          yield* TestClock.adjust('250 millis');
          yield* Effect.promise(() => waitFor(() => harness.sockets.length === 2));

          Queue.offerUnsafe(pathSignals, { coalescedEvents: 2 });
          yield* Effect.promise(() => waitForReconnectLogCount(harness.logs, 2));
          expect(required(harness.sockets[1]).terminated).toBe(true);
          expect(
            harness.logs.filter((entry) => entry.message === 'daemon_control_network_path_changed'),
          ).toHaveLength(1);
          yield* TestClock.adjust('500 millis');
          yield* Effect.promise(() => waitFor(() => harness.sockets.length === 3));
        }),
      ).pipe(Effect.provide(TestClock.layer())),
    );
  });

  test('a path change observed before a carrier exists does not tear down the new one', async () => {
    const harness = createHarness();
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const pathSignals = yield* Queue.sliding<DaemonControlPathSignal>(1);
          // Observed while nothing was connected, so the socket about to be
          // created already reflects it.
          Queue.offerUnsafe(pathSignals, { coalescedEvents: 1 });
          yield* runHarnessControlClient(harness, undefined, harness.dataplane, {
            pathSignals,
          }).pipe(Effect.forkScoped);
          yield* Effect.promise(() => waitFor(() => harness.sockets.length === 1));
          const socket = required(harness.sockets[0]);
          socket.emitMessage(
            createDaemonControlRegisteredMessage(
              'connection-1',
              'presence-1',
              1,
              0,
              1_000,
              3_000,
              ['stun.test:3478', 'stun.test:3479'],
              'ticket',
              'secret',
              4_000,
              'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
              EDGES,
            ),
          );
          yield* Effect.promise(() => waitFor(() => harness.revocations.length === 1));

          yield* TestClock.adjust('500 millis');
          expect(harness.sockets).toHaveLength(1);
          expect(
            harness.logs.some((entry) => entry.message === 'daemon_control_network_path_changed'),
          ).toBe(false);
        }),
      ).pipe(Effect.provide(TestClock.layer())),
    );
  });

  test('a burst of path signals cannot overflow the bounded event queue', async () => {
    const harness = createHarness();
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const pathSignals = yield* Queue.sliding<DaemonControlPathSignal>(1);
          yield* runHarnessControlClient(harness, undefined, harness.dataplane, {
            pathSignals,
          }).pipe(Effect.forkScoped);
          yield* Effect.promise(() => waitFor(() => harness.sockets.length === 1));
          const socket = required(harness.sockets[0]);
          socket.emitMessage(
            createDaemonControlRegisteredMessage(
              'connection-1',
              'presence-1',
              1,
              0,
              1_000,
              3_000,
              ['stun.test:3478', 'stun.test:3479'],
              'ticket',
              'secret',
              4_000,
              'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
              EDGES,
            ),
          );
          yield* Effect.promise(() => waitFor(() => harness.revocations.length === 1));

          // sliding(1) collapses these, so the connection's dropping queue never
          // sees enough to escalate an overflow into a fatal event.
          for (let index = 0; index < 500; index += 1) {
            Queue.offerUnsafe(pathSignals, { coalescedEvents: index + 1 });
          }
          yield* Effect.promise(() =>
            waitFor(() =>
              harness.logs.some((entry) => entry.message === 'daemon_control_network_path_changed'),
            ),
          );
          expect(
            harness.logs.some((entry) => entry.message === 'daemon_control_event_backpressure'),
          ).toBe(false);
        }),
      ).pipe(Effect.provide(TestClock.layer())),
    );
  });

  test('treats ordinary scheduler jitter as a normal ping', async () => {
    const harness = createHarness();
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* runHarnessControlClient(harness).pipe(Effect.forkScoped);
          yield* Effect.promise(() => waitFor(() => harness.sockets.length === 1));
          const socket = required(harness.sockets[0]);
          socket.emitMessage(
            createDaemonControlRegisteredMessage(
              'connection-1',
              'presence-1',
              1,
              0,
              1_000,
              3_000,
              ['stun.test:3478', 'stun.test:3479'],
              'ticket',
              'secret',
              4_000,
              'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
              EDGES,
            ),
          );
          yield* Effect.promise(() => waitFor(() => harness.revocations.length === 1));

          // Just under the threshold: a loaded machine, not a suspended one.
          harness.advanceWallClock(1_000 + (5_000 - 1));
          yield* TestClock.adjust('1000 millis');
          yield* Effect.promise(() => waitFor(() => socket.pings === 2));

          expect(
            harness.logs.some((entry) => entry.message === 'daemon_control_process_resumed'),
          ).toBe(false);
          expect(socket.terminated).toBe(false);
        }),
      ).pipe(Effect.provide(TestClock.layer())),
    );
  });

  test('re-acknowledges a replayed command without executing it twice', async () => {
    const harness = createHarness();
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* runHarnessControlClient(harness).pipe(Effect.forkScoped);
          yield* Effect.promise(() => waitFor(() => harness.sockets.length === 1));
          const socket = required(harness.sockets[0]);
          socket.emitMessage(
            createDaemonControlRegisteredMessage(
              'connection-1',
              'presence-1',
              1,
              0,
              1_000,
              3_000,
              ['stun.test:3478', 'stun.test:3479'],
              'ticket',
              'secret',
              4_000,
              'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
              EDGES,
            ),
          );
          yield* Effect.promise(() => waitFor(() => harness.revocations.length === 1));

          const start = createDaemonControlSessionStartMessage(
            'command-replay',
            'session-1',
            'browser-1',
            {
              userId: USER_ID,
              delegationId: DELEGATION_ID,
              clientNonce: CLIENT_NONCE,
              encapsulationKey: ENCAPSULATION_KEY,
              edgeWtUrl: 'https://edge.example/session',
              edgeCertHashes: [CERT_HASH],
            },
            '',
          );
          socket.emitMessage(start);
          yield* Effect.promise(() => waitFor(() => harness.starts.length === 1));
          harness.resolveStart?.({ status: 'accepted' });
          yield* Effect.promise(() => waitFor(() => outboundMessages(socket).length === 1));

          // The server replays anything it never saw acknowledged. Executing a
          // `session_start` twice tears down the edge dial this session already
          // established and restarts it, so the memo must answer instead.
          socket.emitMessage(start);
          yield* Effect.promise(() => waitFor(() => outboundMessages(socket).length === 2));
          expect(harness.starts).toHaveLength(1);
          expect(outboundMessages(socket)[1]).toEqual({
            type: 'command_ack',
            version: 1,
            commandId: 'command-replay',
            status: 'accepted',
          });
        }),
      ).pipe(Effect.provide(TestClock.layer())),
    );
  });

  test('re-executes a replayed command that was rejected', async () => {
    const harness = createHarness();
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* runHarnessControlClient(harness).pipe(Effect.forkScoped);
          yield* Effect.promise(() => waitFor(() => harness.sockets.length === 1));
          const socket = required(harness.sockets[0]);
          socket.emitMessage(
            createDaemonControlRegisteredMessage(
              'connection-1',
              'presence-1',
              1,
              0,
              1_000,
              3_000,
              ['stun.test:3478', 'stun.test:3479'],
              'ticket',
              'secret',
              4_000,
              'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
              EDGES,
            ),
          );
          yield* Effect.promise(() => waitFor(() => harness.revocations.length === 1));

          const start = createDaemonControlSessionStartMessage(
            'command-rejected',
            'session-1',
            'browser-1',
            {
              userId: USER_ID,
              delegationId: DELEGATION_ID,
              clientNonce: CLIENT_NONCE,
              encapsulationKey: ENCAPSULATION_KEY,
              edgeWtUrl: 'https://edge.example/session',
              edgeCertHashes: [CERT_HASH],
            },
            '',
          );
          socket.emitMessage(start);
          yield* Effect.promise(() => waitFor(() => harness.starts.length === 1));
          harness.resolveStart?.({ status: 'rejected', reason: 'dataplane_unavailable' });
          yield* Effect.promise(() => waitFor(() => outboundMessages(socket).length === 1));

          // A rejection applied nothing, so a replay has to reach the dataplane
          // again rather than being answered from the memo. The revocation
          // outbox reuses one commandId until it is acknowledged, so a memoized
          // rejection would answer every subsequent retry from cache and the
          // revocation would never be applied.
          socket.emitMessage(start);
          yield* Effect.promise(() => waitFor(() => harness.starts.length === 2));
          harness.resolveStart?.({ status: 'accepted' });
          yield* Effect.promise(() => waitFor(() => outboundMessages(socket).length === 2));
          expect(outboundMessages(socket)[1]).toEqual({
            type: 'command_ack',
            version: 1,
            commandId: 'command-rejected',
            status: 'accepted',
          });
        }),
      ).pipe(Effect.provide(TestClock.layer())),
    );
  });

  test('re-executes a replayed command once its memo entry has expired', async () => {
    const harness = createHarness();
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* runHarnessControlClient(harness).pipe(Effect.forkScoped);
          yield* Effect.promise(() => waitFor(() => harness.sockets.length === 1));
          const socket = required(harness.sockets[0]);
          socket.emitMessage(
            createDaemonControlRegisteredMessage(
              'connection-1',
              'presence-1',
              1,
              0,
              1_000,
              3_000,
              ['stun.test:3478', 'stun.test:3479'],
              'ticket',
              'secret',
              4_000,
              'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
              EDGES,
            ),
          );
          yield* Effect.promise(() => waitFor(() => harness.revocations.length === 1));

          const start = createDaemonControlSessionStartMessage(
            'command-expiring',
            'session-1',
            'browser-1',
            {
              userId: USER_ID,
              delegationId: DELEGATION_ID,
              clientNonce: CLIENT_NONCE,
              encapsulationKey: ENCAPSULATION_KEY,
              edgeWtUrl: 'https://edge.example/session',
              edgeCertHashes: [CERT_HASH],
            },
            '',
          );
          socket.emitMessage(start);
          yield* Effect.promise(() => waitFor(() => harness.starts.length === 1));
          harness.resolveStart?.({ status: 'accepted' });
          yield* Effect.promise(() => waitFor(() => outboundMessages(socket).length === 1));

          // Past the memo TTL, which is an order of magnitude beyond the window
          // in which the server could still replay this command. Forgetting it
          // here is therefore safe — and this is the only way an entry is ever
          // dropped, which is what removes the "applied but forgotten" case.
          harness.advanceWallClock(61_000);

          socket.emitMessage(start);
          yield* Effect.promise(() => waitFor(() => harness.starts.length === 2));
        }),
      ).pipe(Effect.provide(TestClock.layer())),
    );
  });

  test('offers its lease back on reconnect', async () => {
    const harness = createHarness();
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* runHarnessControlClient(harness).pipe(Effect.forkScoped);
          yield* Effect.promise(() => waitFor(() => harness.sockets.length === 1));
          // Nothing to reclaim on a first connect.
          expect(harness.connectionHeaders?.['x-merkur-resume-presence']).toBeUndefined();

          const first = required(harness.sockets[0]);
          first.emitMessage(
            createDaemonControlRegisteredMessage(
              'connection-1',
              'presence-abc',
              7,
              0,
              1_000,
              3_000,
              ['stun.test:3478', 'stun.test:3479'],
              'ticket',
              'secret',
              4_000,
              'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
              EDGES,
            ),
          );
          yield* Effect.promise(() => waitFor(() => harness.revocations.length === 1));
          first.emitClose(1006);

          // The next attempt names the lease the server told it about, so the
          // server can reattach it instead of minting a new presence.
          yield* TestClock.adjust('250 millis');
          yield* Effect.promise(() => waitFor(() => harness.sockets.length === 2));
          expect(harness.connectionHeaders?.['x-merkur-resume-presence']).toBe('presence-abc');
        }),
      ).pipe(Effect.provide(TestClock.layer())),
    );
  });

  test('proves identity before registration and acknowledges commands only after dataplane admission', async () => {
    const harness = createHarness();
    const fiber = Effect.runFork(runHarnessControlClient(harness));
    await waitFor(() => harness.sockets.length === 1);

    expect(harness.connectionUrl).toBe('wss://merkur.example/api/daemon/control');
    expect(harness.connectionHeaders).toEqual({
      'x-merkur-daemon-id': 'daemon-1',
      'x-merkur-version': 'dev',
    });
    expect(harness.connectionUrl).not.toContain('secret-api-key');

    const socket = required(harness.sockets[0]);
    socket.emitMessage(
      createDaemonControlRegisteredMessage(
        'connection-1',
        'presence-1',
        7,
        3,
        1_000,
        3_000,
        ['stun.test:3478', 'stun.test:3479'],
        'ticket',
        'secret',
        4_000,
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        EDGES,
      ),
    );
    await waitFor(() => harness.revocations.length === 1);
    const signature = parseDaemonControlSignature(required(socket.sent[0]));
    expect(signature).not.toBeNull();
    const publicKey = Buffer.from(
      deriveSessionAuthorizationKeyPair(Buffer.alloc(32, 0x22)).verifyKey,
    ).toString('base64url');
    expect(
      verifyDaemonProof(
        publicKey,
        Buffer.from(deriveSoftwareDaemonP256PublicKey(Buffer.alloc(32, 0x22))).toString(
          'base64url',
        ),
        'control',
        daemonControlTranscript(
          'daemon-1',
          'https://merkur.example/api/daemon/control',
          'dev',
          null,
          Buffer.alloc(32, 0x88).toString('base64url'),
        ),
        signature?.mldsa ?? '',
        signature?.p256 ?? '',
      ),
    ).toBe(true);
    expect(harness.revocations).toEqual([3]);
    expect(socket.pings).toBe(1);
    expect(outboundMessages(socket)).toEqual([]);

    socket.emitMessage(
      createDaemonControlSessionStartMessage(
        'command-start',
        'session-1',
        'browser-1',
        {
          userId: USER_ID,
          delegationId: DELEGATION_ID,
          clientNonce: CLIENT_NONCE,
          encapsulationKey: ENCAPSULATION_KEY,
          edgeWtUrl: 'https://edge.example/session',
          edgeCertHashes: [CERT_HASH],
        },
        '',
      ),
    );
    await waitFor(() => harness.starts.length === 1);
    expect(harness.starts).toEqual([
      [
        'command-start',
        'session-1',
        'browser-1',
        USER_ID,
        DELEGATION_ID,
        CLIENT_NONCE,
        ENCAPSULATION_KEY,
        'https://edge.example/session',
        [CERT_HASH],
      ],
    ]);
    expect(outboundMessages(socket)).toHaveLength(0);

    socket.emitMessage(
      createDaemonControlSessionCancelMessage('command-cancel', 'session-1', 'browser-1', ''),
    );
    await waitFor(() => harness.cancels.length === 1);
    await waitFor(() => outboundMessages(socket).length === 1);
    expect(outboundMessages(socket)[0]).toEqual({
      type: 'command_ack',
      version: 1,
      commandId: 'command-cancel',
      status: 'rejected',
      reason: 'dataplane_backpressure',
    });

    harness.resolveStart?.({ status: 'accepted' });
    await waitFor(() => outboundMessages(socket).length === 2);
    expect(outboundMessages(socket)[1]).toEqual({
      type: 'command_ack',
      version: 1,
      commandId: 'command-start',
      status: 'accepted',
    });

    // A lease carries the revocation bound, a fresh STUN ticket and a fresh
    // edge attach ticket; a revocation push carries only the generation.
    socket.emitMessage(
      createDaemonControlLeaseMessage(
        4,
        'ticket-2',
        'secret-2',
        4_000,
        'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
        EDGES,
      ),
    );
    await waitFor(() => harness.revocations.length === 2);
    expect(harness.revocations).toEqual([3, 4]);
    expect(harness.stunCredentials.map((credential) => credential.ticket)).toEqual([
      'ticket',
      'ticket-2',
    ]);
    // The edge admission follows the same cadence: one on registration, a
    // replacement on every lease, each with the registry's edges.
    expect(harness.edgeAdmissions).toEqual([
      { ticket: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', edges: EDGES },
      { ticket: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB', edges: EDGES },
    ]);
    socket.emitMessage(createDaemonControlRevocationMessage(5));
    await waitFor(() => harness.revocations.length === 3);
    expect(harness.revocations).toEqual([3, 4, 5]);
    expect(harness.stunCredentials).toHaveLength(2);
    expect(JSON.stringify(harness.logs)).not.toContain('secret-api-key');
    await Effect.runPromise(Fiber.interrupt(fiber));
    expect(socket.terminated).toBe(true);
  });

  test('persists delegation tombstones before acknowledging their durable application', async () => {
    const harness = createHarness();
    const persisted: DaemonConfig[] = [];
    let finishPersistence: (() => void) | undefined;
    const persistence = new Promise<void>((resolve) => {
      finishPersistence = resolve;
    });
    const revocations: string[] = [];
    const fiber = Effect.runFork(
      runHarnessControlClient(
        harness,
        undefined,
        {
          ...harness.dataplane,
          revokeDelegationEffect(commandId) {
            revocations.push(commandId);
            return Effect.succeed({ status: 'accepted' });
          },
        },
        {
          persistConfig: (config) =>
            Effect.promise(async () => {
              await persistence;
              persisted.push(config);
            }),
        },
      ),
    );
    await waitFor(() => harness.sockets.length === 1);
    const socket = required(harness.sockets[0]);
    socket.emitMessage(
      createDaemonControlRegisteredMessage(
        'connection-1',
        'presence-1',
        1,
        0,
        1_000,
        3_000,
        ['stun.test:3478', 'stun.test:3479'],
        'ticket',
        'secret',
        4_000,
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        EDGES,
      ),
    );
    await waitFor(() => socket.pings === 1);
    socket.emitMessage(
      createDaemonControlDelegationRevokeMessage(
        'command-revoke',
        DELEGATION_CERTIFICATE,
        DELEGATION_REVOCATION,
        '',
      ),
    );
    await waitFor(() => revocations.length === 1);
    expect(outboundMessages(socket)).toEqual([]);
    expect(persisted).toEqual([]);

    required(finishPersistence)();
    await waitFor(() => outboundMessages(socket).length === 1);
    expect(persisted).toHaveLength(1);
    expect(required(persisted[0]).revoked_delegations).toEqual(DELEGATION_REVOCATION.targets);
    expect(outboundMessages(socket)[0]).toEqual({
      type: 'command_ack',
      version: 1,
      commandId: 'command-revoke',
      status: 'accepted',
    });
    await Effect.runPromise(Fiber.interrupt(fiber));
  });

  test('reconnects without acknowledging when delegation tombstone persistence fails', async () => {
    const harness = createHarness();
    const revocations: string[] = [];
    const fiber = Effect.runFork(
      runHarnessControlClient(
        harness,
        undefined,
        {
          ...harness.dataplane,
          revokeDelegationEffect(commandId) {
            revocations.push(commandId);
            return Effect.succeed({ status: 'accepted' });
          },
        },
        {
          persistConfig: () => Effect.fail(new Error('disk unavailable')),
        },
      ),
    );
    await waitFor(() => harness.sockets.length === 1);
    const socket = required(harness.sockets[0]);
    socket.emitMessage(
      createDaemonControlRegisteredMessage(
        'connection-1',
        'presence-1',
        1,
        0,
        1_000,
        3_000,
        ['stun.test:3478', 'stun.test:3479'],
        'ticket',
        'secret',
        4_000,
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        EDGES,
      ),
    );
    await waitFor(() => socket.pings === 1);
    socket.emitMessage(
      createDaemonControlDelegationRevokeMessage(
        'command-revoke',
        DELEGATION_CERTIFICATE,
        DELEGATION_REVOCATION,
        '',
      ),
    );

    await waitFor(() => revocations.length === 1);
    await waitFor(() => socket.terminated);
    expect(outboundMessages(socket)).toEqual([]);
    expect(
      harness.logs.some(
        (entry) => entry.message === 'daemon_control_revocation_persistence_failed',
      ),
    ).toBe(true);
    await Effect.runPromise(Fiber.interrupt(fiber));
  });

  test('a pong replaces the scoped deadline', async () => {
    const harness = createHarness();
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* runHarnessControlClient(harness).pipe(Effect.forkScoped);
          yield* Effect.promise(() => waitFor(() => harness.sockets.length === 1));
          const socket = required(harness.sockets[0]);
          socket.emitMessage(
            createDaemonControlRegisteredMessage(
              'connection-1',
              'presence-1',
              1,
              0,
              1_000,
              3_000,
              ['stun.test:3478', 'stun.test:3479'],
              'ticket',
              'secret',
              4_000,
              'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
              EDGES,
            ),
          );
          yield* Effect.promise(() => waitFor(() => harness.revocations.length === 1));

          // The daemon-side deadline is the server's silence window plus three
          // ping intervals: 3_000 + 3 × 1_000 here.
          yield* TestClock.adjust('5999 millis');
          expect(socket.terminated).toBe(false);

          socket.emitPong();
          // Events are processed in order, so a lease observed after the pong
          // proves the pong was handled and the deadline re-armed.
          socket.emitMessage(
            createDaemonControlLeaseMessage(
              1,
              'ticket',
              'secret',
              4_000,
              'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
              EDGES,
            ),
          );
          yield* Effect.promise(() => waitFor(() => harness.revocations.length === 2));
          yield* TestClock.adjust('5999 millis');
          expect(socket.terminated).toBe(false);

          yield* TestClock.adjust('1 millis');
          yield* Effect.promise(() => waitFor(() => socket.terminated));
          expect(
            harness.logs.some((entry) => entry.message === 'daemon_control_ping_timeout'),
          ).toBe(true);
        }),
      ).pipe(Effect.provide(TestClock.layer())),
    );
  });

  test('superseded is terminal for the old daemon connection', async () => {
    const harness = createHarness({ initialReconnectDelayMs: 1 });
    const fiber = Effect.runFork(runHarnessControlClient(harness));
    await waitFor(() => harness.sockets.length === 1);
    required(harness.sockets[0]).emitMessage(createDaemonControlSupersededMessage());
    const outcome = await Effect.runPromise(Fiber.join(fiber));

    expect(outcome).toEqual({ _tag: 'DaemonControlSuperseded' });
    expect(harness.sockets).toHaveLength(1);
  });

  test('publishes control registration and degradation through the health reporter', async () => {
    const harness = createHarness({ initialReconnectDelayMs: 1 });
    const updates: Parameters<DaemonControlHealthReporter['updateControl']>[0][] = [];
    const health: DaemonControlHealthReporter = {
      updateControl: (update) =>
        Effect.sync(() => {
          updates.push(update);
        }),
    };
    const fiber = Effect.runFork(runHarnessControlClient(harness, health));
    await waitFor(() => harness.sockets.length === 1);
    const socket = required(harness.sockets[0]);
    socket.emitMessage(
      createDaemonControlRegisteredMessage(
        'connection-1',
        'presence-1',
        1,
        0,
        1_000,
        3_000,
        ['stun.test:3478', 'stun.test:3479'],
        'ticket',
        'secret',
        4_000,
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        EDGES,
      ),
    );
    await waitFor(() => updates.some((update) => update.state === 'registered'));
    socket.emitClose(1_006);
    await waitFor(() => updates.some((update) => update.state === 'backoff'));
    await Effect.runPromise(Fiber.interrupt(fiber));

    expect(updates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ state: 'connecting' }),
        expect.objectContaining({ state: 'registering' }),
        expect.objectContaining({
          state: 'registered',
          connectionId: 'connection-1',
          lastFailure: null,
        }),
        expect.objectContaining({ state: 'backoff', reconnectDelayMs: 1 }),
      ]),
    );
  });

  test('bounds both socket opening and server registration with TestClock watchdogs', async () => {
    const opening = createHarness({ socketOpenTimeoutMs: 25 }, 0);
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* runHarnessControlClient(opening).pipe(Effect.forkScoped);
          yield* Effect.promise(() => waitFor(() => opening.sockets.length === 1));
          yield* TestClock.adjust('25 millis');
          yield* Effect.promise(() => waitFor(() => required(opening.sockets[0]).terminated));
          expect(
            opening.logs.some((entry) => entry.message === 'daemon_control_socket_open_timeout'),
          ).toBe(true);
        }),
      ).pipe(Effect.provide(TestClock.layer())),
    );

    const registering = createHarness({ registrationTimeoutMs: 40 });
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* runHarnessControlClient(registering).pipe(Effect.forkScoped);
          yield* Effect.promise(() => waitFor(() => registering.sockets.length === 1));
          yield* TestClock.adjust('40 millis');
          yield* Effect.promise(() => waitFor(() => required(registering.sockets[0]).terminated));
          expect(
            registering.logs.some(
              (entry) => entry.message === 'daemon_control_registration_timeout',
            ),
          ).toBe(true);
        }),
      ).pipe(Effect.provide(TestClock.layer())),
    );
  });

  test('resets reconnect backoff only after stable uptime and pong liveness', async () => {
    const harness = createHarness({
      initialReconnectDelayMs: 100,
      maxReconnectDelayMs: 800,
      stableConnectionUptimeMs: 1_000,
    });
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* runHarnessControlClient(harness).pipe(Effect.forkScoped);
          yield* Effect.promise(() => waitFor(() => harness.sockets.length === 1));
          required(harness.sockets[0]).emitClose(1_006);
          yield* Effect.promise(() => waitForReconnectLogCount(harness.logs, 1));
          expect(reconnectDelays(harness.logs)).toEqual([100]);

          yield* TestClock.adjust('100 millis');
          yield* Effect.promise(() => waitFor(() => harness.sockets.length === 2));
          const shortConnection = required(harness.sockets[1]);
          shortConnection.emitMessage(
            createDaemonControlRegisteredMessage(
              'connection-short',
              'presence-short',
              2,
              0,
              1_000,
              3_000,
              ['stun.test:3478', 'stun.test:3479'],
              'ticket',
              'secret',
              4_000,
              'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
              EDGES,
            ),
          );
          yield* Effect.promise(() =>
            waitFor(() =>
              harness.logs.some(
                (entry) =>
                  entry.message === 'daemon_control_registered' &&
                  entry.context?.connectionId === 'connection-short',
              ),
            ),
          );
          shortConnection.emitPong();
          shortConnection.emitMessage(
            createDaemonControlLeaseMessage(
              1,
              'ticket',
              'secret',
              4_000,
              'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
              EDGES,
            ),
          );
          yield* Effect.promise(() => waitFor(() => harness.revocations.includes(1)));
          shortConnection.emitClose(1_006);
          yield* Effect.promise(() => waitForReconnectLogCount(harness.logs, 2));
          expect(reconnectDelays(harness.logs)).toEqual([100, 200]);

          yield* TestClock.adjust('200 millis');
          yield* Effect.promise(() => waitFor(() => harness.sockets.length === 3));
          const stableConnection = required(harness.sockets[2]);
          stableConnection.emitMessage(
            createDaemonControlRegisteredMessage(
              'connection-stable',
              'presence-stable',
              3,
              0,
              1_000,
              3_000,
              ['stun.test:3478', 'stun.test:3479'],
              'ticket',
              'secret',
              4_000,
              'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
              EDGES,
            ),
          );
          yield* Effect.promise(() =>
            waitFor(() =>
              harness.logs.some(
                (entry) =>
                  entry.message === 'daemon_control_registered' &&
                  entry.context?.connectionId === 'connection-stable',
              ),
            ),
          );
          yield* TestClock.adjust('1000 millis');
          expect(
            harness.logs.some((entry) => entry.message === 'daemon_control_connection_stable'),
          ).toBe(false);
          stableConnection.emitPong();
          yield* Effect.promise(() =>
            waitFor(() =>
              harness.logs.some((entry) => entry.message === 'daemon_control_connection_stable'),
            ),
          );
          stableConnection.emitClose(1_006);
          yield* Effect.promise(() => waitForReconnectLogCount(harness.logs, 3));
          expect(reconnectDelays(harness.logs)).toEqual([100, 200, 100]);
        }),
      ).pipe(Effect.provide(TestClock.layer())),
    );
  });

  test('rejects commands before registration and inexact frames', async () => {
    const harness = createHarness();
    const fiber = Effect.runFork(runHarnessControlClient(harness));
    await waitFor(() => harness.sockets.length === 1);
    const socket = required(harness.sockets[0]);
    socket.emitMessage(
      createDaemonControlSessionCancelMessage('command-1', 'session-1', 'browser-1', ''),
    );

    await waitFor(() => socket.closedWith !== null);
    expect(socket.closedWith).toEqual({ code: 1_002, reason: 'protocol error' });
    expect(harness.cancels).toEqual([]);
    await Effect.runPromise(Fiber.interrupt(fiber));
  });

  test('fails closed when native socket callbacks overflow the bounded Effect queue', async () => {
    const harness = createHarness({ eventQueueCapacity: 1 });
    const fiber = Effect.runFork(runHarnessControlClient(harness));
    await waitFor(() => harness.sockets.length === 1);
    const socket = required(harness.sockets[0]);

    socket.emitMessage(
      createDaemonControlRegisteredMessage(
        'connection-1',
        'presence-1',
        1,
        0,
        1_000,
        3_000,
        ['stun.test:3478', 'stun.test:3479'],
        'ticket',
        'secret',
        4_000,
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        EDGES,
      ),
    );
    for (let generation = 1; generation <= 8; generation += 1) {
      socket.emitMessage(
        createDaemonControlLeaseMessage(
          generation,
          'ticket',
          'secret',
          4_000,
          'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
          EDGES,
        ),
      );
    }

    await waitFor(() => socket.terminated);
    await waitFor(() =>
      harness.logs.some((entry) => entry.message === 'daemon_control_event_backpressure'),
    );
    await Effect.runPromise(Fiber.interrupt(fiber));
  });

  test('bounds concurrent dataplane admissions without blocking the owner fiber', async () => {
    const harness = createHarness({ eventQueueCapacity: 2 });
    const fiber = Effect.runFork(runHarnessControlClient(harness));
    await waitFor(() => harness.sockets.length === 1);
    const socket = required(harness.sockets[0]);
    socket.emitMessage(
      createDaemonControlRegisteredMessage(
        'connection-1',
        'presence-1',
        1,
        0,
        1_000,
        3_000,
        ['stun.test:3478', 'stun.test:3479'],
        'ticket',
        'secret',
        4_000,
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        EDGES,
      ),
    );
    await waitFor(() => socket.pings === 1);

    for (let index = 1; index <= 2; index += 1) {
      socket.emitMessage(
        createDaemonControlSessionStartMessage(
          `command-${index}`,
          `session-${index}`,
          'browser-1',
          {
            userId: USER_ID,
            delegationId: DELEGATION_ID,
            clientNonce: CLIENT_NONCE,
            encapsulationKey: ENCAPSULATION_KEY,
            edgeWtUrl: 'https://edge.example/session',
            edgeCertHashes: [CERT_HASH],
          },
          '',
        ),
      );
      await waitFor(() => harness.starts.length === index);
    }
    socket.emitMessage(
      createDaemonControlSessionStartMessage(
        'command-3',
        'session-3',
        'browser-1',
        {
          userId: USER_ID,
          delegationId: DELEGATION_ID,
          clientNonce: CLIENT_NONCE,
          encapsulationKey: ENCAPSULATION_KEY,
          edgeWtUrl: 'https://edge.example/session',
          edgeCertHashes: [CERT_HASH],
        },
        '',
      ),
    );

    await waitFor(() => outboundMessages(socket).length === 1);
    expect(outboundMessages(socket)[0]).toEqual({
      type: 'command_ack',
      version: 1,
      commandId: 'command-3',
      status: 'rejected',
      reason: 'control_backpressure',
    });
    expect(harness.starts).toHaveLength(2);
    await Effect.runPromise(Fiber.interrupt(fiber));
  });

  test('propagates a command admission defect through the control owner', async () => {
    const harness = createHarness();
    const fiber = Effect.runFork(
      runHarnessControlClient(harness, undefined, {
        ...harness.dataplane,
        startSessionEffect: () => Effect.die(new Error('injected command admission defect')),
      }),
    );
    await waitFor(() => harness.sockets.length === 1);
    const socket = required(harness.sockets[0]);
    socket.emitMessage(
      createDaemonControlRegisteredMessage(
        'connection-1',
        'presence-1',
        1,
        0,
        1_000,
        3_000,
        ['stun.test:3478', 'stun.test:3479'],
        'ticket',
        'secret',
        4_000,
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        EDGES,
      ),
    );
    await waitFor(() => socket.pings === 1);
    socket.emitMessage(
      createDaemonControlSessionStartMessage(
        'command-defect',
        'session-1',
        'browser-1',
        {
          userId: USER_ID,
          delegationId: DELEGATION_ID,
          clientNonce: CLIENT_NONCE,
          encapsulationKey: ENCAPSULATION_KEY,
          edgeWtUrl: 'https://edge.example/session',
          edgeCertHashes: [CERT_HASH],
        },
        '',
      ),
    );

    const exit = await Effect.runPromise(Fiber.await(fiber));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Cause.pretty(exit.cause)).toContain('injected command admission defect');
    }
    expect(outboundMessages(socket)).toEqual([]);
    expect(socket.terminated).toBe(true);
  });

  test('scope finalization detaches callbacks and suppresses late dataplane completion', async () => {
    const harness = createHarness();
    const fiber = Effect.runFork(runHarnessControlClient(harness));
    await waitFor(() => harness.sockets.length === 1);
    const socket = required(harness.sockets[0]);
    socket.emitMessage(
      createDaemonControlRegisteredMessage(
        'connection-1',
        'presence-1',
        1,
        0,
        1_000,
        3_000,
        ['stun.test:3478', 'stun.test:3479'],
        'ticket',
        'secret',
        4_000,
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        EDGES,
      ),
    );
    await waitFor(() => socket.pings === 1);
    socket.emitMessage(
      createDaemonControlSessionStartMessage(
        'command-start',
        'session-1',
        'browser-1',
        {
          userId: USER_ID,
          delegationId: DELEGATION_ID,
          clientNonce: CLIENT_NONCE,
          encapsulationKey: ENCAPSULATION_KEY,
          edgeWtUrl: 'https://edge.example/session',
          edgeCertHashes: [CERT_HASH],
        },
        '',
      ),
    );
    await waitFor(() => harness.starts.length === 1);
    const capturedMessageHandler = socket.onmessage;
    const outboundBeforeInterrupt = outboundMessages(socket).length;

    await Effect.runPromise(Fiber.interrupt(fiber));
    expect(socket.onopen).toBeNull();
    expect(socket.onmessage).toBeNull();
    expect(socket.onerror).toBeNull();
    expect(socket.onclose).toBeNull();
    expect(socket.onpong).toBeNull();
    expect(socket.terminated).toBe(true);
    // Without shutdown intent the teardown is a lost carrier: no close code is
    // sent, so the server holds the lease through its resume grace window.
    expect(socket.closedWith).toBeNull();

    capturedMessageHandler?.(
      new MessageEvent('message', {
        data: encodeDaemonControlMessage(
          createDaemonControlSessionCancelMessage('late-cancel', 'session-1', 'browser-1', ''),
        ),
      }),
    );
    harness.resolveStart?.({ status: 'accepted' });
    await Bun.sleep(1);

    expect(harness.cancels).toEqual([]);
    expect(outboundMessages(socket)).toHaveLength(outboundBeforeInterrupt);
  });

  test('a deliberate shutdown closes with the shutdown code instead of terminating', async () => {
    const harness = createHarness();
    const shutdownIntent = await Effect.runPromise(Deferred.make<void>());
    const fiber = Effect.runFork(
      runHarnessControlClient(harness, undefined, harness.dataplane, { shutdownIntent }),
    );
    await waitFor(() => harness.sockets.length === 1);
    const socket = required(harness.sockets[0]);
    socket.emitMessage(
      createDaemonControlRegisteredMessage(
        'connection-1',
        'presence-1',
        1,
        0,
        1_000,
        3_000,
        ['stun.test:3478', 'stun.test:3479'],
        'ticket',
        'secret',
        4_000,
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        EDGES,
      ),
    );
    await waitFor(() => socket.pings === 1);

    // The signal handler records intent before it interrupts the runtime.
    await Effect.runPromise(Deferred.succeed(shutdownIntent, undefined));
    await Effect.runPromise(Fiber.interrupt(fiber));

    expect(socket.closedWith).toEqual({
      code: DAEMON_SHUTDOWN_CLOSE_CODE,
      reason: 'daemon_shutdown',
    });
    // The handshake completed, so there was nothing left to terminate.
    expect(socket.lifecycle).toEqual(['close']);
    expect(socket.terminated).toBe(false);
  });

  test('interruption during Effect backoff prevents reconnect', async () => {
    const harness = createHarness();
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const pathSignals = yield* Queue.sliding<DaemonControlPathSignal>(1);
          const fiber = yield* runHarnessControlClient(harness, undefined, harness.dataplane, {
            pathSignals,
          }).pipe(Effect.forkScoped);
          yield* Effect.promise(() => waitFor(() => harness.sockets.length === 1));
          required(harness.sockets[0]).emitClose(1_006);
          yield* Effect.promise(() =>
            waitFor(() =>
              harness.logs.some((entry) => entry.message === 'daemon_control_reconnect_scheduled'),
            ),
          );

          yield* Fiber.interrupt(fiber);
          Queue.offerUnsafe(pathSignals, { coalescedEvents: 1 });
          expect(yield* Queue.take(pathSignals)).toEqual({ coalescedEvents: 1 });
          yield* TestClock.adjust('1 hour');
          expect(harness.sockets).toHaveLength(1);
        }),
      ).pipe(Effect.provide(TestClock.layer())),
    );
  });
});

class FakeSocket implements DaemonControlSocket {
  readyState: number;
  bufferedAmount = 0;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onpong: (() => void) | null = null;
  readonly sent: string[] = [];
  private challengeSent = false;
  /** Ping control frames sent; they carry no payload worth recording. */
  pings = 0;
  terminated = false;
  closedWith: { readonly code: number | undefined; readonly reason: string | undefined } | null =
    null;
  /** Order of close-side calls, so a test can assert close precedes terminate. */
  readonly lifecycle: string[] = [];

  constructor(readyState = 1) {
    this.readyState = readyState;
  }

  send(data: string): void {
    this.sent.push(data);
  }

  ping(): void {
    this.pings += 1;
  }

  close(code?: number, reason?: string): void {
    this.closedWith = { code, reason };
    this.lifecycle.push('close');
    // A real socket completes the close handshake asynchronously.
    queueMicrotask(() => {
      this.readyState = 3;
      this.onclose?.(new CloseEvent('close', { code: code ?? 1_005 }));
    });
  }

  terminate(): void {
    this.terminated = true;
    this.lifecycle.push('terminate');
    this.readyState = 3;
  }

  emitPong(): void {
    this.onpong?.();
  }

  emitMessage(message: Parameters<typeof encodeDaemonControlMessage>[0]): void {
    if (!this.challengeSent) {
      this.challengeSent = true;
      this.onmessage?.(
        new MessageEvent('message', {
          data: JSON.stringify({
            type: 'auth_challenge',
            nonce: Buffer.alloc(32, 0x88).toString('base64url'),
          }),
        }),
      );
    }
    this.onmessage?.(
      new MessageEvent('message', {
        data: encodeDaemonControlMessage(message),
      }),
    );
  }

  emitClose(code: number): void {
    this.readyState = 3;
    this.onclose?.(new CloseEvent('close', { code }));
  }
}

function createHarness(
  overrides: Partial<DaemonControlClientDependencies> = {},
  socketReadyState = 1,
): {
  readonly dependencies: DaemonControlClientDependencies;
  readonly dataplane: {
    signDaemonProofEffect(
      commandId: string,
      purpose: 'http' | 'control',
      transcript: Uint8Array,
    ): Effect.Effect<import('./dataplane-client').DataplaneProofResult>;
    startSessionEffect(
      commandId: string,
      sessionId: string,
      browserNodeId: string,
      userId: string,
      delegationId: string,
      clientNonce: string,
      encapsulationKey: string,
      edgeWtUrl: string,
      edgeCertHashes: readonly string[],
    ): Effect.Effect<DataplaneCommandResult>;
    cancelSessionEffect(
      commandId: string,
      sessionId: string,
      browserNodeId: string,
    ): Effect.Effect<DataplaneCommandResult>;
    revokeDelegationEffect(
      commandId: string,
      actorCertificate: UserDelegationCertificate,
      revocation: DelegationRevocationStatement,
    ): Effect.Effect<DataplaneCommandResult>;
    updateRevocation(generation: number): void;
    updateStunCredential(credential: DataplaneStunCredential): void;
    updateEdgeAdmission(admission: DataplaneEdgeAdmission): void;
  };
  /** Moves the harness wall clock without touching TestClock's schedule. */
  advanceWallClock(ms: number): void;
  readonly sockets: FakeSocket[];
  readonly starts: unknown[][];
  readonly cancels: unknown[][];
  readonly revocations: number[];
  readonly stunCredentials: DataplaneStunCredential[];
  readonly edgeAdmissions: DataplaneEdgeAdmission[];
  readonly logs: Array<{ readonly message: string; readonly context?: Record<string, unknown> }>;
  readonly connectionUrl: string | null;
  readonly connectionHeaders: Readonly<Record<string, string>> | null;
  readonly resolveStart: ((result: DataplaneCommandResult) => void) | null;
} {
  const sockets: FakeSocket[] = [];
  const starts: unknown[][] = [];
  const cancels: unknown[][] = [];
  const revocations: number[] = [];
  const stunCredentials: DataplaneStunCredential[] = [];
  const edgeAdmissions: DataplaneEdgeAdmission[] = [];
  const logs: Array<{ message: string; context?: Record<string, unknown> }> = [];
  let connectionUrl: string | null = null;
  let connectionHeaders: Readonly<Record<string, string>> | null = null;
  let resolveStart: ((result: DataplaneCommandResult) => void) | null = null;
  // Wall clock, separate from TestClock on purpose: suspension is measured as
  // overshoot of a sleep, and TestClock wakes each sleeper at its exact
  // deadline, so it can never produce one. Tests move this by hand.
  let wallClockMs = 0;

  const dependencies: DaemonControlClientDependencies = {
    createSocket(url, headers) {
      connectionUrl = url;
      connectionHeaders = headers;
      const socket = new FakeSocket(socketReadyState);
      sockets.push(socket);
      return socket;
    },
    random: () => 0.5,
    now: () => wallClockMs,
    initialReconnectDelayMs: 250,
    maxReconnectDelayMs: 30_000,
    eventQueueCapacity: DAEMON_CONTROL_EVENT_QUEUE_CAPACITY,
    socketOpenTimeoutMs: 10_000,
    registrationTimeoutMs: 10_000,
    stableConnectionUptimeMs: 10_000,
    ...overrides,
  };

  return {
    advanceWallClock(ms: number) {
      wallClockMs += ms;
    },
    dependencies,
    dataplane: {
      signDaemonProofEffect(
        _commandId: string,
        purpose: 'http' | 'control',
        transcript: Uint8Array,
      ) {
        const pair = signDaemonProof(
          Buffer.alloc(32, 0x22).toString('base64url'),
          purpose,
          transcript,
        );
        return Effect.succeed({
          status: 'accepted' as const,
          signature: pair.mldsa,
          p256Signature: pair.p256,
        });
      },
      startSessionEffect(...args): Effect.Effect<DataplaneCommandResult> {
        starts.push([...args]);
        return Effect.promise(
          () =>
            new Promise((resolve) => {
              resolveStart = resolve;
            }),
        );
      },
      cancelSessionEffect(...args): Effect.Effect<DataplaneCommandResult> {
        cancels.push([...args]);
        return Effect.succeed({ status: 'rejected', reason: 'dataplane_backpressure' });
      },
      revokeDelegationEffect(): Effect.Effect<DataplaneCommandResult> {
        return Effect.succeed({ status: 'accepted' });
      },
      updateRevocation(generation): void {
        revocations.push(generation);
      },
      updateStunCredential(credential): void {
        stunCredentials.push(credential);
      },
      updateEdgeAdmission(admission): void {
        edgeAdmissions.push(admission);
      },
    },
    sockets,
    starts,
    cancels,
    revocations,
    stunCredentials,
    edgeAdmissions,
    logs,
    get connectionUrl() {
      return connectionUrl;
    },
    get connectionHeaders() {
      return connectionHeaders;
    },
    get resolveStart() {
      return resolveStart;
    },
  };
}

function runHarnessControlClient(
  harness: ReturnType<typeof createHarness>,
  health?: DaemonControlHealthReporter,
  dataplane: ReturnType<typeof createHarness>['dataplane'] = harness.dataplane,
  options: Omit<DaemonControlClientOptions, 'dependencies' | 'health'> = {},
) {
  const captureLogger = EffectLogger.make(({ message, fiber }) => {
    const annotations = fiber.getRef(References.CurrentLogAnnotations);
    const encodedContext = annotations.__merkur_context_json;
    const parsedContext: unknown =
      typeof encodedContext === 'string' ? JSON.parse(encodedContext) : undefined;
    const context = isRecord(parsedContext) ? parsedContext : undefined;
    harness.logs.push({
      message: typeof message === 'string' ? message : String(message),
      context,
    });
  });

  return runDaemonControlClientEffect(daemonConfig(), dataplane, {
    dependencies: harness.dependencies,
    health,
    ...options,
  }).pipe(Effect.provide(EffectLogger.layer([captureLogger])));
}

function daemonConfig(): DaemonConfig {
  return {
    daemon_id: 'daemon-1',
    server_origin: 'https://merkur.example',
    daemon_identity_seal: {
      backend: 'software',
      material: Buffer.alloc(32, 0x22).toString('base64url'),
    },
    shell: '/bin/sh',
    webtransport_port: 44_433,
    session_token_verify_key: Buffer.alloc(2_592, 0x33).toString('base64url'),
    user_root_public_key: Buffer.alloc(2_592, 0x44).toString('base64url'),
    root_epoch: 1,
    daemon_binding: {
      userId: USER_ID,
      rootKeyCommitment: Buffer.alloc(64, 0x55).toString('base64url'),
      daemonId: 'daemon-1',
      daemonIdentityKeyCommitment: Buffer.alloc(64, 0x66).toString('base64url'),
      serverOrigin: 'https://merkur.example',
      linkClaimId: 'claim-1',
      issuedAt: 1,
      signature: Buffer.alloc(4_627, 0x77).toString('base64url'),
    },
    revoked_delegations: [],
  };
}

function outboundMessages(socket: FakeSocket): unknown[] {
  return socket.sent
    .map((message) => parseDaemonControlDaemonMessage(message))
    .filter((message) => message !== null);
}

function reconnectDelays(
  logs: ReadonlyArray<{ readonly message: string; readonly context?: Record<string, unknown> }>,
): number[] {
  return logs
    .filter((entry) => entry.message === 'daemon_control_reconnect_scheduled')
    .map((entry) => Number(entry.context?.delayMs));
}

function waitForReconnectLogCount(
  logs: ReadonlyArray<{ readonly message: string; readonly context?: Record<string, unknown> }>,
  count: number,
): Promise<void> {
  return waitFor(() => reconnectDelays(logs).length === count);
}

async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!condition()) {
    if (Date.now() >= deadline) {
      throw new Error('condition not met before deadline');
    }
    await Bun.sleep(1);
  }
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('required test value missing');
  return value;
}
