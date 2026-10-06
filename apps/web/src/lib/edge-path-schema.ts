/**
 * Shape of a cached edge coordinate, and the exact guard that admits one.
 *
 * The entry is public data — the replica URL and the certificate hashes the
 * server publishes to every browser it sends there — so a poisoned record buys
 * an attacker nothing: adoption requires equality with the coordinates the
 * server actually issued for the session, and a speculative carrier never
 * writes a routing preface or the session id. The worst outcome is one dialled
 * connection that expires unused.
 */
export interface PersistedEdgePath {
  readonly daemonId: string;
  readonly edgeWtUrl: string;
  /**
   * The whole accepted hash set, not just the active one.
   *
   * The edge pre-publishes old and new hashes across a rotation and re-registers
   * (see the rotation note in docs/transport.md), so pinning a single hash would
   * make every cached entry miss for the length of a rotation — exactly when the
   * dial is least likely to be re-warmed by a later success.
   */
  readonly certHashes: readonly string[];
  readonly mtime: number;
}

const EDGE_PATH_KEYS = ['daemonId', 'edgeWtUrl', 'certHashes', 'mtime'] as const;

/** Bounds the stored array; the server's own offer is far smaller than this. */
const MAX_CERT_HASHES = 8;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Exact parse: unknown or missing keys reject the whole record rather than
 * being tolerated. A stale shape must be discarded and re-learned, never
 * partially adopted.
 */
export function parsePersistedEdgePath(
  value: unknown,
  expectedDaemonId: string,
): PersistedEdgePath | null {
  if (!isRecord(value)) return null;
  const keys = Object.keys(value);
  if (keys.length !== EDGE_PATH_KEYS.length) return null;
  for (const key of EDGE_PATH_KEYS) {
    if (!Object.hasOwn(value, key)) return null;
  }

  const { daemonId, edgeWtUrl, certHashes, mtime } = value;
  if (typeof daemonId !== 'string' || daemonId !== expectedDaemonId) return null;
  if (typeof edgeWtUrl !== 'string' || edgeWtUrl.length === 0) return null;
  // Only an https origin can ever be dialled, and refusing anything else here
  // keeps a corrupted record from becoming a request to somewhere else.
  if (!edgeWtUrl.startsWith('https://')) return null;
  if (!Array.isArray(certHashes) || certHashes.length === 0) return null;
  if (certHashes.length > MAX_CERT_HASHES) return null;
  if (!certHashes.every((hash) => typeof hash === 'string' && hash.length > 0)) return null;
  if (typeof mtime !== 'number' || !Number.isFinite(mtime)) return null;

  return {
    daemonId,
    edgeWtUrl,
    certHashes: certHashes as readonly string[],
    mtime,
  };
}
