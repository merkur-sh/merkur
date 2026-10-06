import {
  isIpAddress,
  type SignalingWebTransportCandidate,
  type SignalingWebTransportNatSignature,
  type WebTransportCandidateKind,
  type WebTransportNatType,
} from '@merkur/shared';

/**
 * The direct candidate that last won for one daemon on one network. A network
 * is the address the edge observed on the browser's signaling connection, so
 * returning to a network finds the path that worked there and nowhere else.
 */
export interface PersistedWtPath {
  readonly key: string;
  readonly daemonId: string;
  readonly address: string;
  readonly certHash: string;
  readonly candidate: SignalingWebTransportCandidate;
  readonly nat: SignalingWebTransportNatSignature;
  readonly mtime: number;
}

export function wtPathKey(daemonId: string, address: string): string {
  return `${daemonId}|${address}`;
}

const PATH_KEYS = ['key', 'daemonId', 'address', 'certHash', 'candidate', 'nat', 'mtime'] as const;
const CANDIDATE_KEYS = ['addr', 'port', 'kind', 'scope'] as const;
const NAT_KEYS = ['publicIp', 'natType', 'hairpin', 'natFiltering'] as const;
const CANDIDATE_KINDS: ReadonlySet<string> = new Set<WebTransportCandidateKind>([
  'srflx',
  'nat_map',
  'host4',
  'host6',
  'loopback',
]);
const NAT_TYPES: ReadonlySet<string> = new Set<WebTransportNatType>([
  'endpoint_independent',
  'endpoint_dependent',
  'none',
]);
export function parsePersistedWtPath(
  value: unknown,
  expectedDaemonId: string,
  expectedAddress: string,
): PersistedWtPath | null {
  if (
    !isExactRecord(value, PATH_KEYS) ||
    value.daemonId !== expectedDaemonId ||
    value.address !== expectedAddress ||
    value.key !== wtPathKey(expectedDaemonId, expectedAddress)
  ) {
    return null;
  }
  if (
    expectedDaemonId.length === 0 ||
    expectedDaemonId.length > 256 ||
    expectedDaemonId.trim() !== expectedDaemonId ||
    !isIpAddress(expectedAddress) ||
    typeof value.certHash !== 'string' ||
    !isCanonicalSha256Base64(value.certHash) ||
    typeof value.mtime !== 'number' ||
    !Number.isSafeInteger(value.mtime) ||
    value.mtime <= 0
  ) {
    return null;
  }

  const candidate = parseCandidate(value.candidate);
  const nat = parseNat(value.nat);
  if (candidate === null || nat === null) return null;

  return {
    key: wtPathKey(expectedDaemonId, expectedAddress),
    daemonId: expectedDaemonId,
    address: expectedAddress,
    certHash: value.certHash,
    candidate,
    nat,
    mtime: value.mtime,
  };
}

function parseCandidate(value: unknown): SignalingWebTransportCandidate | null {
  if (!isExactRecord(value, CANDIDATE_KEYS)) return null;
  if (
    !isIpAddress(value.addr) ||
    typeof value.port !== 'number' ||
    !Number.isSafeInteger(value.port) ||
    value.port < 1 ||
    value.port > 65_535 ||
    typeof value.kind !== 'string' ||
    !CANDIDATE_KINDS.has(value.kind) ||
    (value.scope !== 'public' && value.scope !== 'local')
  ) {
    return null;
  }
  return {
    addr: value.addr,
    port: value.port,
    kind: value.kind as WebTransportCandidateKind,
    scope: value.scope,
  };
}

function parseNat(value: unknown): SignalingWebTransportNatSignature | null {
  if (!isExactRecord(value, NAT_KEYS)) return null;
  if (
    (value.publicIp !== null && !isIpAddress(value.publicIp)) ||
    typeof value.natType !== 'string' ||
    !NAT_TYPES.has(value.natType) ||
    typeof value.hairpin !== 'boolean'
  ) {
    return null;
  }
  const natFiltering = value.natFiltering;
  if (
    natFiltering !== 'endpoint_independent' &&
    natFiltering !== 'port_independent' &&
    natFiltering !== 'port_dependent' &&
    natFiltering !== 'unknown'
  )
    return null;
  return {
    publicIp: value.publicIp,
    natFiltering,
    natType: value.natType as WebTransportNatType,
    hairpin: value.hairpin,
  };
}

function isExactRecord(
  value: unknown,
  expectedKeys: readonly string[],
): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return (
    keys.length === expectedKeys.length && expectedKeys.every((key) => Object.hasOwn(value, key))
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
