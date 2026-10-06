export interface PublicReleaseSettings {
  readonly version: string;
  readonly sequence: number;
  readonly releasePublicKey: string;
  readonly origin: string;
  readonly opaquePublicKey: string;
}

function canonicalKey(value: string, bytes: number): boolean {
  const decoded = Buffer.from(value, 'base64url');
  return decoded.byteLength === bytes && decoded.toString('base64url') === value;
}

/** Original signed release guards, shared by native, Bun and frontend producers. */
export function publicReleaseEnvironment(
  settings: PublicReleaseSettings,
): Readonly<Record<string, string>> {
  const { version, sequence, releasePublicKey, origin, opaquePublicKey } = settings;
  if (
    typeof version !== 'string' ||
    !version ||
    /[\r\n\0]/.test(version) ||
    !Number.isSafeInteger(sequence) ||
    sequence < 0
  )
    throw new Error(
      'Public release context requires a nonempty version and safe nonnegative sequence',
    );
  const release = /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(version);
  if (release && sequence === 0)
    throw new Error('A canonical release requires its reserved positive sequence');
  if (sequence === 0) return { MERKUR_VERSION: version };
  if (!release || typeof releasePublicKey !== 'string' || !canonicalKey(releasePublicKey, 2592))
    throw new Error('A signed release requires its canonical version and ML-DSA-87 public key');
  if (typeof origin !== 'string') throw new Error('Public release origin is missing');
  const url = new URL(origin);
  if (url.protocol !== 'https:' || url.origin !== origin)
    throw new Error('Public release origin must be a canonical HTTPS origin');
  if (typeof opaquePublicKey !== 'string' || !canonicalKey(opaquePublicKey, 32))
    throw new Error('Public release OPAQUE pin must be canonical32-byte base64url');
  return {
    MERKUR_VERSION: version,
    MERKUR_RELEASE_SEQUENCE: String(sequence),
    MERKUR_RELEASE_MLDSA87_PUBLIC_KEY: releasePublicKey,
    MERKUR_PUBLIC_ORIGIN: origin,
    MERKUR_OPAQUE_SERVER_PUBLIC_KEY: opaquePublicKey,
  };
}

if (import.meta.main) {
  const [input, output] = process.argv.slice(2);
  if (input === undefined || output === undefined)
    throw new Error('Public release context requires declared settings and environment output');
  const environment = publicReleaseEnvironment(await Bun.file(input).json());
  await Bun.write(
    output,
    Object.entries(environment)
      .map(([name, value]) => `${name}=${value}\n`)
      .join(''),
  );
}
