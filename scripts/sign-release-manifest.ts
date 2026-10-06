import '../packages/shared/src/e2e-wasm-bun';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  daemonArtifactName,
  encodeReleaseManifest,
  RELEASE_MANIFEST_FILE,
  RELEASE_MANIFEST_MAX_FUTURE_MS,
  RELEASE_MANIFEST_SIGNATURE_FILE,
  RELEASE_PLATFORMS,
  type ReleaseManifest,
} from '../packages/shared/src/release';
import {
  decodeReleasePublicKey,
  deriveReleaseSigningKey,
  encodeReleasePublicKey,
  encodeReleaseSignature,
  signReleaseManifest,
} from '../packages/shared/src/release-signature';

interface SignArguments {
  readonly directory: string;
  readonly expiresAt: number;
  readonly minimumSequence: number;
  readonly seedFile: string;
  readonly sequence: number;
  readonly version: string;
}

const ARGUMENT_NAMES = new Set([
  '--directory',
  '--expires-at',
  '--minimum-sequence',
  '--seed-file',
  '--sequence',
  '--version',
]);

const args = parseArguments(process.argv.slice(2));
const signingTime = Date.now();
if (
  args.expiresAt <= signingTime ||
  args.expiresAt - signingTime > RELEASE_MANIFEST_MAX_FUTURE_MS
) {
  throw new Error('release expiry must be within the next 30 days');
}
const seed = await readSigningSeed(args.seedFile);
const entropy = randomBytes(32);
const key = deriveReleaseSigningKey(seed);
const publicKey = key.publicKey;
let pinnedPublicKey: Uint8Array | undefined;
let manifestBytes: Uint8Array | undefined;
let signature: Uint8Array | undefined;
let signatureFileBytes: Uint8Array | undefined;

try {
  pinnedPublicKey = decodeReleasePublicKey(requireEnvironment('MERKUR_RELEASE_MLDSA87_PUBLIC_KEY'));
  if (!timingSafeEqual(publicKey, pinnedPublicKey)) {
    throw new Error('offline signing seed does not match the release-build public-key pin');
  }

  const artifacts = [];
  for (const platform of RELEASE_PLATFORMS) {
    const name = daemonArtifactName(platform);
    const artifactPath = path.join(args.directory, name);
    const metadata = await stat(artifactPath);
    if (!metadata.isFile() || !Number.isSafeInteger(metadata.size) || metadata.size <= 0) {
      throw new Error(`${name} is not a non-empty regular file`);
    }
    artifacts.push({ name, size: metadata.size, sha512: await sha512File(artifactPath) });
  }

  const manifest: ReleaseManifest = {
    sequence: args.sequence,
    version: args.version,
    expiresAt: args.expiresAt,
    minimumSequence: args.minimumSequence,
    artifacts,
  };
  manifestBytes = encodeReleaseManifest(manifest);
  signature = signReleaseManifest(manifestBytes, key, entropy);
  signatureFileBytes = new TextEncoder().encode(encodeReleaseSignature(signature));
  await writeAtomic(path.join(args.directory, RELEASE_MANIFEST_FILE), manifestBytes);
  await writeAtomic(path.join(args.directory, RELEASE_MANIFEST_SIGNATURE_FILE), signatureFileBytes);
  process.stdout.write(
    `signed ${args.version} sequence ${args.sequence} with public key ${encodeReleasePublicKey(publicKey)}\n`,
  );
} finally {
  seed.fill(0);
  entropy.fill(0);
  key.free();
  publicKey.fill(0);
  pinnedPublicKey?.fill(0);
  manifestBytes?.fill(0);
  signature?.fill(0);
  signatureFileBytes?.fill(0);
}

function parseArguments(argv: readonly string[]): SignArguments {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (name === undefined || value === undefined || !ARGUMENT_NAMES.has(name)) {
      throw new Error(
        'usage: sign-release-manifest --version vX.Y.Z --sequence N --minimum-sequence N ' +
          '--expires-at UNIX_MS --seed-file PATH [--directory PATH]',
      );
    }
    if (values.has(name)) throw new Error(`duplicate argument ${name}`);
    values.set(name, value);
  }

  return {
    directory: path.resolve(values.get('--directory') ?? process.cwd()),
    expiresAt: parsePositiveInteger(values.get('--expires-at'), '--expires-at'),
    minimumSequence: parsePositiveInteger(values.get('--minimum-sequence'), '--minimum-sequence'),
    seedFile: path.resolve(requireArgument(values, '--seed-file')),
    sequence: parsePositiveInteger(values.get('--sequence'), '--sequence'),
    version: requireArgument(values, '--version'),
  };
}

function requireArgument(values: ReadonlyMap<string, string>, name: string): string {
  const value = values.get(name);
  if (value === undefined || value.length === 0) throw new Error(`missing ${name}`);
  return value;
}

function parsePositiveInteger(value: string | undefined, name: string): number {
  if (value === undefined || !/^[1-9]\d*$/.test(value)) {
    throw new Error(`${name} must be a positive integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${name} exceeds the safe-integer range`);
  return parsed;
}

async function readSigningSeed(seedFile: string): Promise<Buffer> {
  const metadata = await stat(seedFile);
  if (!metadata.isFile() || metadata.size !== 32) {
    throw new Error('release signing seed file must be exactly 32 raw bytes');
  }
  if (process.platform !== 'win32' && (metadata.mode & 0o077) !== 0) {
    throw new Error('release signing seed file must not be accessible by group or other users');
  }
  return readFile(seedFile);
}

async function sha512File(filePath: string): Promise<string> {
  const digest = createHash('sha512');
  for await (const chunk of createReadStream(filePath)) digest.update(chunk);
  return digest.digest('hex');
}

async function writeAtomic(target: string, bytes: Uint8Array): Promise<void> {
  const temporary = `${target}.new`;
  try {
    await stat(target);
    throw new Error(`refusing to replace existing signed release file ${target}`);
  } catch (cause) {
    if (!isNoEntryError(cause)) throw cause;
  }
  try {
    await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
    await rename(temporary, target);
  } catch (cause) {
    await rm(temporary, { force: true });
    throw cause;
  }
}

function requireEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

function isNoEntryError(value: unknown): boolean {
  return typeof value === 'object' && value !== null && 'code' in value && value.code === 'ENOENT';
}
