import { isCanonicalEdgeWebTransportUrl } from '@merkur/shared';
import { type DaemonBinding, parseDaemonBinding } from '@merkur/shared/user-authorization';

import type { RenewSessionResult } from '../transport-worker-protocol';

export interface SessionRequestResponse {
  readonly daemonId: string;
  readonly daemonIdentityPublicKey: string;
  readonly daemonIdentityP256PublicKey: string;
  readonly daemonBinding: DaemonBinding;
  readonly sessionToken: string;
  readonly sessionTokenExpiresAtMs: number;
  readonly sessionTokenExpiresInMs: number;
  readonly sessionId: string;
  readonly edgeWtUrl: string;
  readonly edgeCertHashes: readonly string[];
  readonly edgeAttachTicket: string;
}

/** `TICKET_LEN` in apps/edge/src/attach_ticket.rs; the ticket is opaque here. */
const EDGE_ATTACH_TICKET_BYTES = 26;

const SESSION_RESPONSE_FIELDS = new Set([
  'daemonId',
  'daemonIdentityPublicKey',
  'daemonIdentityP256PublicKey',
  'daemonBinding',
  'sessionToken',
  'sessionTokenExpiresAtMs',
  'sessionTokenExpiresInMs',
  'sessionId',
  'edgeWtUrl',
  'edgeCertHashes',
  'edgeAttachTicket',
]);

export function parseSessionRequestResponse(value: unknown): SessionRequestResponse | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const fields = Object.keys(record);
  if (
    fields.length !== SESSION_RESPONSE_FIELDS.size ||
    fields.some((field) => !SESSION_RESPONSE_FIELDS.has(field)) ||
    typeof record.daemonId !== 'string' ||
    record.daemonId.length === 0 ||
    typeof record.daemonIdentityPublicKey !== 'string' ||
    !isCanonicalBase64UrlBytes(record.daemonIdentityPublicKey, 2_592) ||
    typeof record.daemonIdentityP256PublicKey !== 'string' ||
    !isCanonicalBase64UrlBytes(record.daemonIdentityP256PublicKey, 65) ||
    typeof record.sessionToken !== 'string' ||
    record.sessionToken.length === 0 ||
    typeof record.sessionTokenExpiresAtMs !== 'number' ||
    !Number.isSafeInteger(record.sessionTokenExpiresAtMs) ||
    record.sessionTokenExpiresAtMs <= 0 ||
    typeof record.sessionTokenExpiresInMs !== 'number' ||
    !Number.isSafeInteger(record.sessionTokenExpiresInMs) ||
    record.sessionTokenExpiresInMs < 0 ||
    typeof record.sessionId !== 'string' ||
    record.sessionId.length === 0 ||
    !isCanonicalEdgeWebTransportUrl(record.edgeWtUrl) ||
    !isCurrentCertificatePins(record.edgeCertHashes) ||
    typeof record.edgeAttachTicket !== 'string' ||
    !isCanonicalBase64UrlBytes(record.edgeAttachTicket, EDGE_ATTACH_TICKET_BYTES)
  ) {
    return null;
  }
  let daemonBinding: DaemonBinding;
  try {
    daemonBinding = parseDaemonBinding(record.daemonBinding);
  } catch {
    return null;
  }
  return {
    daemonId: record.daemonId,
    daemonIdentityPublicKey: record.daemonIdentityPublicKey,
    daemonIdentityP256PublicKey: record.daemonIdentityP256PublicKey,
    daemonBinding,
    sessionToken: record.sessionToken,
    sessionTokenExpiresAtMs: record.sessionTokenExpiresAtMs,
    sessionTokenExpiresInMs: record.sessionTokenExpiresInMs,
    sessionId: record.sessionId,
    edgeWtUrl: record.edgeWtUrl,
    edgeCertHashes: record.edgeCertHashes,
    edgeAttachTicket: record.edgeAttachTicket,
  };
}

/** The renew answer, checked where it leaves the network; null when it is not one. */
export function parseSessionRenewResponse(value: unknown): RenewSessionResult | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  if (
    typeof record.sessionToken !== 'string' ||
    record.sessionToken.length === 0 ||
    typeof record.sessionTokenExpiresInMs !== 'number' ||
    !Number.isSafeInteger(record.sessionTokenExpiresInMs) ||
    record.sessionTokenExpiresInMs <= 0 ||
    (record.edgeCertHashes !== null && !isCurrentCertificatePins(record.edgeCertHashes))
  ) {
    return null;
  }
  return {
    sessionToken: record.sessionToken,
    sessionTokenExpiresInMs: record.sessionTokenExpiresInMs,
    edgeCertHashes: record.edgeCertHashes,
  };
}

function isCanonicalBase64UrlBytes(value: string, expectedBytes: number): boolean {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) return false;
  const paddingLength = (4 - (value.length % 4)) % 4;
  if (paddingLength === 3) return false;
  try {
    const decoded = atob(
      value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat(paddingLength),
    );
    return (
      decoded.length === expectedBytes &&
      btoa(decoded).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '') === value
    );
  } catch {
    return false;
  }
}

/** One or two distinct SHA-256 hashes: the edge's served certificate and its next. */
export function isCurrentCertificatePins(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length >= 1 &&
    value.length <= 2 &&
    value.every((hash) => typeof hash === 'string' && isCanonicalSha256Base64(hash)) &&
    new Set(value).size === value.length
  );
}

function isCanonicalSha256Base64(value: string): boolean {
  try {
    const decoded = atob(value);
    return decoded.length === 32 && btoa(decoded) === value;
  } catch {
    return false;
  }
}
