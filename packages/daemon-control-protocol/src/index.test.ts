import { describe, expect, test } from 'bun:test';

import {
  createDaemonControlCommandAckMessage,
  createDaemonControlDelegationRevokeMessage,
  createDaemonControlLeaseMessage,
  createDaemonControlRegisteredMessage,
  createDaemonControlRevocationMessage,
  createDaemonControlSessionCancelMessage,
  createDaemonControlSessionStartMessage,
  createDaemonControlSupersededMessage,
  DAEMON_CONTROL_PROTOCOL_VERSION,
  MAX_DAEMON_CONTROL_FRAME_BYTES,
  parseDaemonControlDaemonMessage,
  parseDaemonControlServerMessage,
} from './index';

const CERT_HASH = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
const CLIENT_NONCE = Buffer.alloc(32, 8).toString('base64url');
const ENCAPSULATION_KEY = Buffer.alloc(1_568, 9).toString('base64url');
const AUTHORIZATION_HASH = Buffer.alloc(64, 10).toString('base64url');
const DELEGATE_PUBLIC_KEY = Buffer.alloc(2_592, 11).toString('base64url');
const DELEGATION_SIGNATURE = Buffer.alloc(4_627, 12).toString('base64url');
const REVOCATION_NONCE = Buffer.alloc(32, 13).toString('base64url');
const ISSUED_AT = 1_800_000_000_000;
const EXPIRES_AT = ISSUED_AT + 30 * 24 * 60 * 60 * 1_000;

const EDGES = [
  {
    edgeWtUrl: 'https://edge.example:4433/',
    certHashes: [CERT_HASH, btoa(String.fromCharCode(...new Uint8Array(32).fill(8)))],
  },
];

const SESSION_OFFER = {
  userId: 'user-1',
  delegationId: 'delegation-1',
  clientNonce: CLIENT_NONCE,
  encapsulationKey: ENCAPSULATION_KEY,
  edgeWtUrl: 'https://edge.example/session',
  edgeCertHashes: [CERT_HASH],
} as const;

const DELEGATION_CERTIFICATE = {
  userId: 'user-1',
  rootKeyCommitment: AUTHORIZATION_HASH,
  delegationId: 'delegation-1',
  delegatePublicKey: DELEGATE_PUBLIC_KEY,
  scopes: ['terminal-session', 'session-revoke'],
  serverOrigin: 'https://merkur.example',
  rootEpoch: 1,
  issuedAt: ISSUED_AT,
  expiresAt: EXPIRES_AT,
  signature: DELEGATION_SIGNATURE,
} as const;

const DELEGATION_REVOCATION = {
  userId: 'user-1',
  rootKeyCommitment: AUTHORIZATION_HASH,
  actorDelegationId: 'delegation-1',
  targets: [
    { delegationId: 'delegation-1', expiresAt: EXPIRES_AT },
    { delegationId: 'delegation-2', expiresAt: EXPIRES_AT },
  ],
  issuedAt: ISSUED_AT + 1_000,
  nonce: REVOCATION_NONCE,
  signature: DELEGATION_SIGNATURE,
} as const;

describe('daemon control protocol v1', () => {
  test('round-trips every exact daemon message variant', () => {
    const messages = [
      createDaemonControlCommandAckMessage('command-1', { status: 'accepted' }),
      createDaemonControlCommandAckMessage('command-2', {
        status: 'rejected',
        reason: 'dataplane_backpressure',
      }),
    ];
    for (const message of messages) {
      expect(parseDaemonControlDaemonMessage(JSON.stringify(message))).toEqual(message);
    }
  });

  test('round-trips every exact server message variant', () => {
    const messages = [
      createDaemonControlRegisteredMessage(
        'connection-1',
        'presence-1',
        1,
        0,
        2_000,
        5_000,
        ['stun.test:3478', 'stun.test:3479'],
        'ticket',
        'secret',
        4_000,
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        EDGES,
      ),
      createDaemonControlLeaseMessage(
        3,
        'ticket',
        'secret',
        4_000,
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        EDGES,
      ),
      createDaemonControlRevocationMessage(4),
      createDaemonControlSessionStartMessage(
        'command-1',
        'session-1',
        'browser-1',
        SESSION_OFFER,
        '',
      ),
      createDaemonControlSessionCancelMessage('command-2', 'session-1', 'browser-1', ''),
      createDaemonControlDelegationRevokeMessage(
        'command-3',
        DELEGATION_CERTIFICATE,
        DELEGATION_REVOCATION,
        '',
      ),
      createDaemonControlSupersededMessage(),
    ];
    for (const message of messages) {
      expect(
        parseDaemonControlServerMessage(new TextEncoder().encode(JSON.stringify(message))),
      ).toEqual(message);
    }
  });

  test('rejects legacy versions, aliases, extra fields, and inexact ack variants', () => {
    expect(
      parseDaemonControlServerMessage({ type: 'revocation', revocationGeneration: 1 }),
    ).toBeNull();
    expect(
      parseDaemonControlServerMessage({
        ...createDaemonControlRevocationMessage(1),
        protocol_version: DAEMON_CONTROL_PROTOCOL_VERSION,
      }),
    ).toBeNull();
    expect(parseDaemonControlDaemonMessage({ type: 'heartbeat', version: 1 })).toBeNull();
    expect(
      parseDaemonControlDaemonMessage({
        ...createDaemonControlCommandAckMessage('command-1', { status: 'accepted' }),
        reason: 'not_allowed_on_accepted',
      }),
    ).toBeNull();
    expect(
      parseDaemonControlDaemonMessage({
        type: 'command_ack',
        version: DAEMON_CONTROL_PROTOCOL_VERSION,
        commandId: 'command-1',
        status: 'rejected',
      }),
    ).toBeNull();
  });

  test('accepts only distinct canonical edges with one or two distinct hashes', () => {
    const lease = createDaemonControlLeaseMessage(3, 'ticket', 'secret', 4_000, 'A'.repeat(35), []);
    expect(parseDaemonControlServerMessage(lease)).toEqual(lease);
    const [edge] = EDGES;
    for (const edges of [
      [{ ...edge, edgeWtUrl: 'http://edge.example:4433/' }],
      [{ ...edge, certHashes: [] }],
      [{ ...edge, certHashes: [CERT_HASH, CERT_HASH] }],
      [{ ...edge, certHashes: ['not-a-hash'] }],
      [edge, edge],
      [{ edgeWtUrl: edge?.edgeWtUrl, cert_hashes: edge?.certHashes }],
      Array.from({ length: 33 }, (_, index) => ({
        ...edge,
        edgeWtUrl: `https://edge-${index}.example:4433/`,
      })),
    ]) {
      expect(parseDaemonControlServerMessage({ ...lease, edges })).toBeNull();
    }
    const { edges: _omitted, ...edgeless } = lease;
    expect(parseDaemonControlServerMessage(edgeless)).toBeNull();
  });

  test('accepts only an edge attach ticket of the exact wire length', () => {
    const lease = createDaemonControlLeaseMessage(
      3,
      'ticket',
      'secret',
      4_000,
      'A'.repeat(35),
      EDGES,
    );
    expect(parseDaemonControlServerMessage(lease)).toEqual(lease);
    for (const edgeAttachTicket of ['', 'A'.repeat(34), 'A'.repeat(36), `${'A'.repeat(34)}=`]) {
      expect(parseDaemonControlServerMessage({ ...lease, edgeAttachTicket })).toBeNull();
    }
    const { edgeAttachTicket: _omitted, ...unticketed } = lease;
    expect(parseDaemonControlServerMessage(unticketed)).toBeNull();
  });

  test('rejects a silence window no longer than the ping interval', () => {
    const registered = createDaemonControlRegisteredMessage(
      'connection-1',
      'presence-1',
      1,
      0,
      2_000,
      5_000,
      ['stun.test:3478', 'stun.test:3479'],
      'ticket',
      'secret',
      4_000,
      'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      EDGES,
    );
    expect(
      parseDaemonControlServerMessage({
        ...registered,
        silentAfterMs: registered.pingIntervalMs,
      }),
    ).toBeNull();
    expect(
      parseDaemonControlServerMessage({
        ...registered,
        pingIntervalMs: 0,
      }),
    ).toBeNull();
  });

  test('rejects oversized frames before parsing JSON', () => {
    const oversized = `{"type":"command_ack","version":1,"padding":"${'x'.repeat(
      MAX_DAEMON_CONTROL_FRAME_BYTES,
    )}"}`;
    expect(parseDaemonControlDaemonMessage(oversized)).toBeNull();
  });

  test('rejects non-canonical or duplicated edge offer material', () => {
    const valid = createDaemonControlSessionStartMessage(
      'command-1',
      'session-1',
      'browser-1',
      SESSION_OFFER,
      '',
    );
    expect(
      parseDaemonControlServerMessage({
        ...valid,
        offer: { ...valid.offer, delegationId: '' },
      }),
    ).toBeNull();
    expect(
      parseDaemonControlServerMessage({
        ...valid,
        offer: { ...valid.offer, edgeWtUrl: 'http://edge.example/session' },
      }),
    ).toBeNull();
    expect(
      parseDaemonControlServerMessage({
        ...valid,
        offer: { ...valid.offer, edgeCertHashes: [CERT_HASH, CERT_HASH] },
      }),
    ).toBeNull();
    expect(
      parseDaemonControlServerMessage({
        ...valid,
        offer: { ...valid.offer, clientNonce: CLIENT_NONCE.slice(1) },
      }),
    ).toBeNull();
    expect(
      parseDaemonControlServerMessage({
        ...valid,
        offer: { ...valid.offer, encapsulationKey: ENCAPSULATION_KEY.slice(1) },
      }),
    ).toBeNull();
  });

  test('accepts canonical loopback authorization origins and rejects insecure remote origins', () => {
    for (const serverOrigin of [
      'https://merkur.example',
      'http://localhost:54331',
      'http://127.0.0.1:54331',
      'http://[::1]:54331',
    ]) {
      const message = createDaemonControlDelegationRevokeMessage(
        'command-1',
        { ...DELEGATION_CERTIFICATE, serverOrigin },
        DELEGATION_REVOCATION,
        '',
      );
      expect(parseDaemonControlServerMessage(JSON.stringify(message))).toEqual(message);
    }
    for (const serverOrigin of [
      'http://merkur.example',
      'http://127.0.0.1.example',
      'http://[::2]',
      'http://127.0.0.1:54331/',
      'http://user@127.0.0.1:54331',
      'http://127.0.0.1:54331?query=1',
    ]) {
      const message = createDaemonControlDelegationRevokeMessage(
        'command-1',
        { ...DELEGATION_CERTIFICATE, serverOrigin },
        DELEGATION_REVOCATION,
        '',
      );
      expect(parseDaemonControlServerMessage(JSON.stringify(message))).toBeNull();
    }
  });

  test('requires canonical delegation certificate and revocation ordering', () => {
    const valid = createDaemonControlDelegationRevokeMessage(
      'command-1',
      DELEGATION_CERTIFICATE,
      DELEGATION_REVOCATION,
      '',
    );
    expect(parseDaemonControlServerMessage(JSON.stringify(valid))).toEqual(valid);
    expect(
      parseDaemonControlServerMessage({
        ...valid,
        actorCertificate: {
          ...valid.actorCertificate,
          expiresAt: valid.actorCertificate.expiresAt - 1,
        },
      }),
    ).toBeNull();
    expect(
      parseDaemonControlServerMessage({
        ...valid,
        revocation: {
          ...valid.revocation,
          targets: [...valid.revocation.targets].reverse(),
        },
      }),
    ).toBeNull();

    const { signature, ...certificateWithoutSignature } = valid.actorCertificate;
    expect(
      parseDaemonControlServerMessage(
        JSON.stringify({
          ...valid,
          actorCertificate: { signature, ...certificateWithoutSignature },
        }),
      ),
    ).toBeNull();
  });
  /**
   * Trace context on a command.
   *
   * `hasExactKeys` means an omitted `traceparent` is a *rejected frame*, not a
   * missing attribute — which is exactly why it is a required key carrying the
   * empty string rather than an optional one. A daemon that silently dropped
   * commands from a newer server would be far worse than one that fails loudly.
   */
  describe('traceparent', () => {
    const VALID = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';
    const encode = (message: unknown) => new TextEncoder().encode(JSON.stringify(message));

    test('round-trips a valid value on session_start', () => {
      const message = createDaemonControlSessionStartMessage(
        'command-1',
        'session-1',
        'browser-1',
        SESSION_OFFER,
        VALID,
      );
      const parsed = parseDaemonControlServerMessage(encode(message));
      expect(parsed).toEqual(message);
    });

    test('accepts the empty string, which means the sender had no active span', () => {
      const message = createDaemonControlSessionCancelMessage(
        'command-1',
        'session-1',
        'browser-1',
        '',
      );
      const parsed = parseDaemonControlServerMessage(encode(message));
      expect(parsed).toEqual(message);
    });

    test.each([
      ['a malformed value', 'not-a-traceparent'],
      ['a future version', '01-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01'],
      ['uppercase hex', '00-0AF7651916CD43DD8448EB211C80319C-b7ad6b7169203331-01'],
      ['a non-string', 42],
    ])('rejects %s', (_label, traceparent) => {
      const message = {
        ...createDaemonControlSessionCancelMessage('command-1', 'session-1', 'browser-1', ''),
        traceparent,
      };
      expect(parseDaemonControlServerMessage(encode(message))).toBeNull();
    });

    test('a command missing the key entirely is rejected', () => {
      const { traceparent, ...withoutTraceparent } = createDaemonControlSessionCancelMessage(
        'command-1',
        'session-1',
        'browser-1',
        '',
      );
      expect(traceparent).toBe('');
      expect(parseDaemonControlServerMessage(encode(withoutTraceparent))).toBeNull();
    });
  });
});
