import '../packages/shared/src/e2e-wasm-bun';
import path from 'node:path';

import {
  deriveReleaseSigningKey,
  encodeReleasePublicKey,
} from '../packages/shared/src/release-signature';
import { readReleaseSigningSeed } from './release-seed';

const seedFileIndex = process.argv.indexOf('--seed-file');
const seedFileArgument = seedFileIndex === -1 ? undefined : process.argv[seedFileIndex + 1];
if (seedFileArgument === undefined || seedFileArgument.length === 0) {
  throw new Error('usage: derive-release-public-key --seed-file PATH');
}

const seed = await readReleaseSigningSeed(path.resolve(seedFileArgument));
const key = deriveReleaseSigningKey(seed);
try {
  process.stdout.write(`${encodeReleasePublicKey(key.publicKey)}\n`);
} finally {
  seed.fill(0);
  key.free();
}
