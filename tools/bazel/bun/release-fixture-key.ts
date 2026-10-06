import '../../../packages/shared/src/e2e-wasm-bun';
import { writeFileSync } from 'node:fs';
import {
  deriveReleaseSigningKey,
  encodeReleasePublicKey,
} from '../../../packages/shared/src/release-signature';

const output = process.argv[2];
if (output === undefined) throw new Error('Qualification fixture requires its public-key output');
const key = deriveReleaseSigningKey(new Uint8Array(32).fill(43));
try {
  writeFileSync(output, encodeReleasePublicKey(key.publicKey));
} finally {
  key.free();
}
