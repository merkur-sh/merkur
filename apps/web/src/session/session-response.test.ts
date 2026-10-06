import { describe, expect, test } from 'bun:test';

import {
  TEST_DAEMON_BINDING,
  TEST_DAEMON_P256_PUBLIC_KEY,
} from '../auth/test-authorization-fixtures';
import { parseSessionRequestResponse } from './session-response';

const CURRENT_CERT_HASH = Buffer.alloc(32, 1).toString('base64');
const NEXT_CERT_HASH = Buffer.alloc(32, 2).toString('base64');
const DAEMON_IDENTITY_PUBLIC_KEY = Buffer.alloc(2_592, 3).toString('base64url');
const CURRENT_RESPONSE = {
  daemonId: 'daemon-1',
  daemonIdentityPublicKey: DAEMON_IDENTITY_PUBLIC_KEY,
  daemonIdentityP256PublicKey: TEST_DAEMON_P256_PUBLIC_KEY,
  daemonBinding: TEST_DAEMON_BINDING,
  sessionToken: 'token',
  sessionTokenExpiresAtMs: 123_456,
  sessionTokenExpiresInMs: 60_000,
  sessionId: 'session-1',
  edgeWtUrl: 'https://edge.example:4433/',
  edgeCertHashes: [CURRENT_CERT_HASH],
  edgeAttachTicket: Buffer.alloc(26, 5).toString('base64url'),
} as const;

describe('current session response contract', () => {
  test('accepts the exact current response and certificate rotation overlap', () => {
    expect(parseSessionRequestResponse(CURRENT_RESPONSE)).toEqual(CURRENT_RESPONSE);
    expect(
      parseSessionRequestResponse({
        ...CURRENT_RESPONSE,
        edgeCertHashes: [CURRENT_CERT_HASH, NEXT_CERT_HASH],
      }),
    ).not.toBeNull();
  });

  test('requires the explicit credential expiry', () => {
    const { sessionTokenExpiresAtMs: _, ...withoutAbsoluteExpiry } = CURRENT_RESPONSE;
    const { sessionTokenExpiresInMs: __, ...withoutRelativeExpiry } = CURRENT_RESPONSE;
    expect(parseSessionRequestResponse(withoutAbsoluteExpiry)).toBeNull();
    expect(parseSessionRequestResponse(withoutRelativeExpiry)).toBeNull();
    expect(
      parseSessionRequestResponse({ ...CURRENT_RESPONSE, sessionTokenExpiresAtMs: 0 }),
    ).toBeNull();
    expect(
      parseSessionRequestResponse({ ...CURRENT_RESPONSE, sessionTokenExpiresInMs: -1 }),
    ).toBeNull();
    expect(
      parseSessionRequestResponse({ ...CURRENT_RESPONSE, sessionTokenExpiresInMs: 1.5 }),
    ).toBeNull();
  });

  test('rejects empty session identities and credentials', () => {
    expect(parseSessionRequestResponse({ ...CURRENT_RESPONSE, daemonId: '' })).toBeNull();
    expect(
      parseSessionRequestResponse({ ...CURRENT_RESPONSE, daemonIdentityPublicKey: '' }),
    ).toBeNull();
    expect(
      parseSessionRequestResponse({
        ...CURRENT_RESPONSE,
        daemonIdentityPublicKey: Buffer.alloc(2_591, 3).toString('base64url'),
      }),
    ).toBeNull();
    expect(parseSessionRequestResponse({ ...CURRENT_RESPONSE, sessionToken: '' })).toBeNull();
    expect(parseSessionRequestResponse({ ...CURRENT_RESPONSE, sessionId: '' })).toBeNull();
  });

  test('requires one or two unique nonempty certificate pins', () => {
    expect(parseSessionRequestResponse({ ...CURRENT_RESPONSE, edgeCertHashes: [] })).toBeNull();
    expect(
      parseSessionRequestResponse({ ...CURRENT_RESPONSE, edgeCertHashes: ['', 42, null] }),
    ).toBeNull();
    expect(
      parseSessionRequestResponse({
        ...CURRENT_RESPONSE,
        edgeCertHashes: [CURRENT_CERT_HASH, CURRENT_CERT_HASH],
      }),
    ).toBeNull();
    expect(
      parseSessionRequestResponse({
        ...CURRENT_RESPONSE,
        edgeCertHashes: [CURRENT_CERT_HASH, NEXT_CERT_HASH, Buffer.alloc(32, 3).toString('base64')],
      }),
    ).toBeNull();
  });

  test('requires live edge coordinates and names no browser address', () => {
    expect(parseSessionRequestResponse({ ...CURRENT_RESPONSE, edgeWtUrl: null })).toBeNull();
    expect(parseSessionRequestResponse({ ...CURRENT_RESPONSE, edgeWtUrl: '' })).toBeNull();
    expect(parseSessionRequestResponse({ ...CURRENT_RESPONSE, browserIp: null })).toBeNull();
  });

  test('requires the edge attach ticket at its exact size', () => {
    const { edgeAttachTicket: _, ...unticketed } = CURRENT_RESPONSE;
    expect(parseSessionRequestResponse(unticketed)).toBeNull();
    for (const edgeAttachTicket of [
      '',
      Buffer.alloc(25, 5).toString('base64url'),
      Buffer.alloc(27, 5).toString('base64url'),
      `${Buffer.alloc(26, 5).toString('base64url')}=`,
    ]) {
      expect(parseSessionRequestResponse({ ...CURRENT_RESPONSE, edgeAttachTicket })).toBeNull();
    }
  });

  test('rejects removed and unknown response fields', () => {
    expect(
      parseSessionRequestResponse({
        ...CURRENT_RESPONSE,
        edgeCertHash: CURRENT_CERT_HASH,
      }),
    ).toBeNull();
    expect(
      parseSessionRequestResponse({
        ...CURRENT_RESPONSE,
        relayUrl: 'https://relay.example',
      }),
    ).toBeNull();
  });
});
