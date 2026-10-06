import { readFileSync } from 'node:fs';
import path from 'node:path';
import { BUILD_PROOFS, verifyBuildIdentity } from '@merkur/shared/build-identity';

/** Called once before the HTTP listener opens. Docker has already verified every artifact byte. */
export function readSignedBuildIdentity(directory: string, buildId: string, publicKeyPin: string) {
  const readProof = (root: string, names: { manifest: string; signature: string }) => ({
    manifest: readFileSync(path.join(root, names.manifest), 'utf8'),
    signature: readFileSync(path.join(root, names.signature), 'utf8'),
  });
  const identity = {
    server: readProof(directory, BUILD_PROOFS.deployment),
    client: readProof(path.join(directory, 'web'), BUILD_PROOFS.web),
  };
  verifyBuildIdentity(identity, publicKeyPin, buildId);
  return identity;
}
