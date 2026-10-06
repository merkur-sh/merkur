/**
 * Fixed release-distribution contract shared by the offline signer, the
 * installer, and the daemon updater. The signature algorithm and key are
 * deliberately absent from the manifest: Merkur has one release trust
 * primitive.
 */

/**
 * Public GitHub releases. Daemons download straight from here with no token and
 * no API call; authenticity comes only from the pinned manifest signature, so
 * the host and every byte it serves are untrusted inputs.
 */
export const RELEASE_DOWNLOAD_BASE_URL = 'https://github.com/merkur-sh/merkur/releases';

export const RELEASE_MANIFEST_FILE = 'merkur-release.json';
export const RELEASE_MANIFEST_SIGNATURE_FILE = 'merkur-release.sig';
export const RELEASE_MLDSA87_CONTEXT = 'merkur-release-manifest';
export const RELEASE_MLDSA87_PUBLIC_KEY_BYTES = 2_592;
export const RELEASE_MLDSA87_SIGNATURE_BYTES = 4_627;
export const RELEASE_MANIFEST_MAX_BYTES = 4_096;
export const RELEASE_SIGNATURE_MAX_BYTES = 6_170;
export const RELEASE_ARTIFACT_MAX_BYTES = 1024 * 1024 * 1024;
export const RELEASE_BOOTSTRAP_MINIMUM_SEQUENCE = 1;
export const RELEASE_MANIFEST_MAX_FUTURE_MS = 30 * 24 * 60 * 60 * 1_000;

const RELEASE_VERSION_PATTERN = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const SHA512_HEX_PATTERN = /^[0-9a-f]{128}$/;
const TEXT_DECODER = new TextDecoder('utf-8', { fatal: true });
const TEXT_ENCODER = new TextEncoder();

export type ReleasePlatform = 'darwin-arm64' | 'darwin-x64' | 'linux-x64' | 'linux-arm64';

export const RELEASE_PLATFORMS: readonly ReleasePlatform[] = [
  'darwin-arm64',
  'darwin-x64',
  'linux-x64',
  'linux-arm64',
];

export const DAEMON_ARTIFACT_PREFIX = 'merkur-daemon-';

export interface ReleaseManifestArtifact {
  readonly name: string;
  readonly size: number;
  readonly sha512: string;
}

export interface ReleaseManifest {
  readonly sequence: number;
  readonly version: string;
  readonly expiresAt: number;
  readonly minimumSequence: number;
  readonly artifacts: readonly ReleaseManifestArtifact[];
}

export function currentReleasePlatform(): ReleasePlatform | null {
  const candidate = `${process.platform}-${process.arch}`;
  return (RELEASE_PLATFORMS as readonly string[]).includes(candidate)
    ? (candidate as ReleasePlatform)
    : null;
}

/** Monotonic security sequence embedded into every release daemon. */
export function merkurReleaseSequence(): number {
  const raw = process.env.MERKUR_RELEASE_SEQUENCE ?? '0';
  if (!/^(0|[1-9]\d*)$/.test(raw)) return 0;
  const sequence = Number(raw);
  return Number.isSafeInteger(sequence) ? sequence : 0;
}

/** Exact ML-DSA-87 public-key pin embedded by the release build. */
export function merkurReleasePublicKey(): string {
  return process.env.MERKUR_RELEASE_MLDSA87_PUBLIC_KEY ?? '';
}

export function daemonArtifactName(platform: ReleasePlatform): string {
  return `${DAEMON_ARTIFACT_PREFIX}${platform}.tar.gz`;
}

export function encodeReleaseManifest(manifest: ReleaseManifest): Uint8Array {
  const validated = validateReleaseManifest(manifest);
  return TEXT_ENCODER.encode(`${JSON.stringify(validated)}\n`);
}

export function parseCanonicalReleaseManifest(bytes: Uint8Array): ReleaseManifest {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > RELEASE_MANIFEST_MAX_BYTES) {
    throw new Error(`release manifest exceeds ${RELEASE_MANIFEST_MAX_BYTES} bytes`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(TEXT_DECODER.decode(bytes));
  } catch (cause) {
    throw new Error('release manifest is not valid UTF-8 JSON', { cause });
  }
  const manifest = validateReleaseManifest(parsed);
  const canonical = encodeReleaseManifest(manifest);
  if (!bytesEqual(bytes, canonical)) {
    throw new Error('release manifest bytes are not canonical');
  }
  return manifest;
}

export function releaseArtifact(
  manifest: ReleaseManifest,
  platform: ReleasePlatform,
): ReleaseManifestArtifact {
  const expectedName = daemonArtifactName(platform);
  const artifact = manifest.artifacts.find((candidate) => candidate.name === expectedName);
  if (artifact === undefined) {
    throw new Error(`release manifest does not contain ${expectedName}`);
  }
  return artifact;
}

function validateReleaseManifest(value: unknown): ReleaseManifest {
  if (!isRecord(value) || !hasExactKeys(value, MANIFEST_KEYS)) {
    throw new Error('release manifest must contain the exact canonical fields');
  }

  const sequence = requirePositiveSafeInteger(value.sequence, 'release sequence');
  const version = requireReleaseVersion(value.version);
  const expiresAt = requirePositiveSafeInteger(value.expiresAt, 'release expiry');
  const minimumSequence = requirePositiveSafeInteger(
    value.minimumSequence,
    'release minimum sequence',
  );
  if (minimumSequence < RELEASE_BOOTSTRAP_MINIMUM_SEQUENCE || minimumSequence > sequence) {
    throw new Error('release minimum sequence is outside the accepted range');
  }
  const rawArtifacts = value.artifacts;
  if (!Array.isArray(rawArtifacts) || rawArtifacts.length !== RELEASE_PLATFORMS.length) {
    throw new Error('release manifest must contain every supported platform exactly once');
  }

  const artifacts = RELEASE_PLATFORMS.map((platform, index) => {
    const candidate = rawArtifacts[index];
    if (!isRecord(candidate) || !hasExactKeys(candidate, ARTIFACT_KEYS)) {
      throw new Error('release artifact must contain the exact canonical fields');
    }
    const expectedName = daemonArtifactName(platform);
    if (candidate.name !== expectedName) {
      throw new Error(`release artifact ${index} must be named ${expectedName}`);
    }
    const size = requirePositiveSafeInteger(candidate.size, `${expectedName} size`);
    if (size > RELEASE_ARTIFACT_MAX_BYTES) {
      throw new Error(`${expectedName} exceeds the release artifact size limit`);
    }
    if (typeof candidate.sha512 !== 'string' || !SHA512_HEX_PATTERN.test(candidate.sha512)) {
      throw new Error(`${expectedName} must have a lowercase SHA-512 digest`);
    }
    return { name: expectedName, size, sha512: candidate.sha512 };
  });

  return { sequence, version, expiresAt, minimumSequence, artifacts };
}

const MANIFEST_KEYS = ['sequence', 'version', 'expiresAt', 'minimumSequence', 'artifacts'] as const;
const ARTIFACT_KEYS = ['name', 'size', 'sha512'] as const;

function requirePositiveSafeInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return value;
}

function requireReleaseVersion(value: unknown): string {
  if (typeof value !== 'string' || !RELEASE_VERSION_PATTERN.test(value)) {
    throw new Error('release version must be an exact vMAJOR.MINOR.PATCH tag');
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value);
  return (
    actual.length === expected.length &&
    expected.every((key, index) => actual[index] === key && Object.hasOwn(value, key))
  );
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

/**
 * The newest published release's copy of an asset. GitHub resolves `latest`
 * server-side, so this is how the updater learns the newest version: it reads
 * the version out of the latest manifest, then fetches the manifest and its
 * signature again by tag, as a pair that cannot straddle two releases.
 */
export function latestReleaseAssetUrl(assetName: string): string {
  return `${RELEASE_DOWNLOAD_BASE_URL}/latest/download/${encodeURIComponent(assetName)}`;
}

export function releaseAssetUrl(version: string, assetName: string): string {
  return `${RELEASE_DOWNLOAD_BASE_URL}/download/${encodeURIComponent(version)}/${encodeURIComponent(assetName)}`;
}
