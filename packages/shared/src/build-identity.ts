// Signatures and digests run in the `merkur-e2e` WebAssembly build; the realm
// must have instantiated it (Bun: `@merkur/shared/e2e-wasm-bun`, browser:
// `loadE2eWasmModule()`).
import { e2eWasm } from './e2e-wasm-runtime';

const encoder = new TextEncoder();

export const BUILD_PROOFS = {
  web: {
    manifest: 'merkur-web-release.json',
    signature: 'merkur-web-release.sig',
    context: 'merkur-web-release-manifest',
  },
  deployment: {
    manifest: 'merkur-deployment-release.json',
    signature: 'merkur-deployment-release.sig',
    context: 'merkur-deployment-release-manifest',
  },
} as const;

export function encodeBuildMarker(buildId: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(buildId)) {
    throw new Error('invalid build ID');
  }
  return `${JSON.stringify({ buildId })}\n`;
}

interface ManifestFile {
  readonly path: string;
  readonly size: number;
  readonly sha512: string;
}

/** Verifies signed artifact identity, not remote execution or browser first-load integrity. */
export function verifyBuildIdentity(value: unknown, publicKeyPin: string, expectedBuildId: string) {
  if (!isRecord(value)) throw new Error('invalid build identity');
  const publicKey = decodeBase64Url(publicKeyPin, 2_592);
  const server = verifyProof(value.server, publicKey, BUILD_PROOFS.deployment.context);
  const client = verifyProof(value.client, publicKey, BUILD_PROOFS.web.context);
  if (server.commit !== client.commit) throw new Error('server and client commits differ');
  requireFile(server.files, `web/${BUILD_PROOFS.web.manifest}`, client.manifest);
  requireFile(server.files, `web/${BUILD_PROOFS.web.signature}`, client.signature);
  const marker = encodeBuildMarker(expectedBuildId);
  requireFile(client.files, 'merkur-build.json', marker);
  requireFile(server.files, 'web/merkur-build.json', marker);
  const digest = bytesToHex(
    e2eWasm().sha256(
      encoder.encode(
        `merkur-build-verification\n${JSON.stringify([server.signature, client.signature])}`,
      ),
    ),
  ).slice(0, 32);
  return {
    verificationId: `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20)}`,
    commit: client.commit,
    serverSignature: server.signature,
    clientSignature: client.signature,
  };
}

function verifyProof(value: unknown, publicKey: Uint8Array, context: string) {
  if (
    !isRecord(value) ||
    typeof value.manifest !== 'string' ||
    typeof value.signature !== 'string'
  ) {
    throw new Error('invalid signed build proof');
  }
  const bytes = encoder.encode(value.manifest);
  if (
    !e2eWasm().mlDsa87Verify(
      publicKey,
      encoder.encode(context),
      bytes,
      decodeBase64Url(value.signature, 4_627),
    )
  )
    throw new Error('invalid build signature');
  const parsed: unknown = JSON.parse(value.manifest);
  if (
    !isRecord(parsed) ||
    typeof parsed.commit !== 'string' ||
    !/^[0-9a-f]{40}$/.test(parsed.commit) ||
    !Array.isArray(parsed.files)
  ) {
    throw new Error('invalid build manifest');
  }
  const files: ManifestFile[] = [];
  let previous = '';
  for (const file of parsed.files) {
    if (
      !isRecord(file) ||
      typeof file.path !== 'string' ||
      file.path <= previous ||
      file.path.includes('\\') ||
      file.path.split('/').some((part) => part === '' || part === '.' || part === '..') ||
      typeof file.size !== 'number' ||
      !Number.isSafeInteger(file.size) ||
      file.size < 0 ||
      typeof file.sha512 !== 'string' ||
      !/^[0-9a-f]{128}$/.test(file.sha512)
    ) {
      throw new Error('invalid build file');
    }
    files.push({ path: file.path, size: file.size, sha512: file.sha512 });
    previous = file.path;
  }
  if (`${JSON.stringify({ commit: parsed.commit, files })}\n` !== value.manifest) {
    throw new Error('noncanonical build manifest');
  }
  return { commit: parsed.commit, files, manifest: value.manifest, signature: value.signature };
}

function requireFile(files: readonly ManifestFile[], name: string, content: string): void {
  const bytes = encoder.encode(content);
  const file = files.find((candidate) => candidate.path === name);
  if (file?.size !== bytes.length || file.sha512 !== bytesToHex(e2eWasm().sha512(bytes))) {
    throw new Error('signed build does not match the loaded application');
  }
}

function decodeBase64Url(value: string, length: number): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('invalid build signature encoding');
  const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/'));
  if (
    binary.length !== length ||
    btoa(binary).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_') !== value
  ) {
    throw new Error('noncanonical build signature encoding');
  }
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function bytesToHex(bytes: Uint8Array): string {
  let hex = '';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
