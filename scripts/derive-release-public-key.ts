import '../packages/shared/src/e2e-wasm-bun';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import {
  deriveReleaseSigningKey,
  encodeReleasePublicKey,
} from '../packages/shared/src/release-signature';

const seedFileIndex = process.argv.indexOf('--seed-file');
const seedFileArgument = seedFileIndex === -1 ? undefined : process.argv[seedFileIndex + 1];
if (seedFileArgument === undefined || seedFileArgument.length === 0) {
  throw new Error('usage: derive-release-public-key --seed-file PATH');
}
const seedFile = path.resolve(seedFileArgument);
const metadata = await stat(seedFile);
if (!metadata.isFile() || metadata.size !== 32) {
  throw new Error('release signing seed file must be exactly 32 raw bytes');
}
if (process.platform !== 'win32' && (metadata.mode & 0o077) !== 0) {
  throw new Error('release signing seed file must not be accessible by group or other users');
}

const seed = await readFile(seedFile);
const key = deriveReleaseSigningKey(seed);
try {
  process.stdout.write(`${encodeReleasePublicKey(key.publicKey)}\n`);
} finally {
  seed.fill(0);
  key.free();
}
