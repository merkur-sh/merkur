import { generateKeyPairSync, type KeyObject, sign } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ml_kem1024 } from '@noble/post-quantum/ml-kem.js';
import * as e2eWasm from '../packages/e2e-wasm/pkg/e2e_wasm.js';
import { emitPerfMetric, summarizeSamples } from './perf/harness';

const DEFAULT_SAMPLES = 100;
const ML_KEM_KEYGEN_SEED_BYTES = 64;
const ML_KEM_ENCAPSULATION_KEY_BYTES = 1_568;
const ML_KEM_CIPHERTEXT_BYTES = 1_568;
const ML_KEM_ENCAPSULATION_RANDOM_BYTES = 32;
const ML_DSA_87_IDENTITY_SEED_BYTES = 32;
const ML_DSA_87_SIGNING_RANDOM_BYTES = 32;
const ML_DSA_87_PUBLIC_KEY_BYTES = 2_592;
const ML_DSA_87_SIGNATURE_BYTES = 4_627;
const SESSION_NONCE_BYTES = 32;
const SESSION_SECRETS_BYTES = 64;
const SESSION_RESPONSE_HASH_BYTES = 64;
const SESSION_DELEGATION_AUTHORIZATION_DIGEST_BYTES = 64;
const SESSION_SECRET_BYTES = 32;
const REPO_ROOT = path.resolve(import.meta.dir, '..');
const SESSION_TOKEN_BYTES = new TextEncoder().encode('benchmark-session-authorization');
const DAEMON_SIGNATURE_CONTEXT = new TextEncoder().encode('merkur-session-ready');
const samples = readSampleCount('BENCH_SAMPLES', process.env.BENCH_SAMPLES, DEFAULT_SAMPLES);

const wasmBytes = new Uint8Array(
  await readFile(path.join(REPO_ROOT, 'packages/e2e-wasm/pkg/e2e_wasm_bg.wasm')),
);
const moduleStartedAt = performance.now();
e2eWasm.initSync({ module: wasmBytes });
const moduleInitMs = performance.now() - moduleStartedAt;

const identitySeed = new Uint8Array(ML_DSA_87_IDENTITY_SEED_BYTES);
let daemonIdentity: e2eWasm.MlDsa87SigningKey | null = null;
let daemonPublicKey: Uint8Array = new Uint8Array();
let p256PublicKey: Uint8Array = new Uint8Array();
let p256PrivateKey: KeyObject | null = null;
try {
  crypto.getRandomValues(identitySeed);
  daemonIdentity = e2eWasm.MlDsa87SigningKey.fromSeed(identitySeed);
  daemonPublicKey = daemonIdentity.publicKey;
  identitySeed.fill(0);
  const p256Identity = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  p256PrivateKey = p256Identity.privateKey;
  const p256Jwk = p256Identity.publicKey.export({ format: 'jwk' });
  if (p256Jwk.x === undefined || p256Jwk.y === undefined)
    throw new Error('missing P-256 coordinates');
  p256PublicKey = Buffer.concat([
    Buffer.from([4]),
    Buffer.from(p256Jwk.x, 'base64url'),
    Buffer.from(p256Jwk.y, 'base64url'),
  ]);
  const timings: number[] = [];
  const coldStartedAt = performance.now();
  runSessionBootstrap(daemonIdentity);
  const coldDurationMs = performance.now() - coldStartedAt;

  for (let index = 0; index < samples; index += 1) {
    const startedAt = performance.now();
    runSessionBootstrap(daemonIdentity);
    timings.push(performance.now() - startedAt);
  }

  const summary = summarizeSamples(timings);
  emitPerfMetric({
    name: 'session-pq-wasm-module-init',
    value: moduleInitMs,
    unit: 'ms/init',
    direction: 'lower',
    sampleSize: 1,
  });
  emitPerfMetric({
    name: 'session-pq-bootstrap-cold',
    value: coldDurationMs,
    unit: 'ms/session',
    direction: 'lower',
    sampleSize: 1,
  });
  for (const [name, value, percentile] of [
    ['session-pq-bootstrap-p50', summary.median, 0.5],
    ['session-pq-bootstrap-p95', summary.p95, 0.95],
    ['session-pq-bootstrap-p99', summary.p99, 0.99],
  ] as const) {
    emitPerfMetric({
      name,
      value,
      unit: 'ms/session',
      direction: 'lower',
      percentile,
      sampleSize: samples,
    });
  }
  process.stdout.write(
    `PQ session startup: wasm-init=${moduleInitMs.toFixed(2)}ms ` +
      `cold=${coldDurationMs.toFixed(2)}ms steady-samples=${samples} ` +
      `p50=${summary.median.toFixed(2)}ms p95=${summary.p95.toFixed(2)}ms ` +
      `p99=${summary.p99.toFixed(2)}ms\n`,
  );
} finally {
  identitySeed.fill(0);
  daemonIdentity?.free();
  daemonPublicKey.fill(0);
  p256PublicKey.fill(0);
  p256PrivateKey = null;
}

function runSessionBootstrap(daemonIdentity: e2eWasm.MlDsa87SigningKey): void {
  const keygenSeed = new Uint8Array(ML_KEM_KEYGEN_SEED_BYTES);
  const clientNonce = new Uint8Array(SESSION_NONCE_BYTES);
  const daemonNonce = new Uint8Array(SESSION_NONCE_BYTES);
  const delegationAuthorizationDigest = new Uint8Array(
    SESSION_DELEGATION_AUTHORIZATION_DIGEST_BYTES,
  );
  const encapsulationRandomness = new Uint8Array(ML_KEM_ENCAPSULATION_RANDOM_BYTES);
  const signingRandomness = new Uint8Array(ML_DSA_87_SIGNING_RANDOM_BYTES);
  let bootstrap: e2eWasm.SessionClientBootstrap | null = null;
  let start: e2eWasm.E2ePendingStart | null = null;
  let pending: e2eWasm.E2ePendingHandshake | null = null;
  let responderStart: e2eWasm.E2eResponderStart | null = null;
  let bootstrapOutput: e2eWasm.SessionBootstrapOutput | null = null;
  let keeper: e2eWasm.RebindKeeper | null = null;
  let responder: e2eWasm.E2eHandshake | null = null;
  let initiator: e2eWasm.E2eHandshake | null = null;
  let browserStatic: Uint8Array | null = null;
  let daemonStatic: Uint8Array | null = null;
  let requestHash: Uint8Array | null = null;
  let prologue: Uint8Array | null = null;
  let msg1: Uint8Array | null = null;
  let noiseMsg2: Uint8Array | null = null;
  let msg3: Uint8Array | null = null;
  let p256Signature: Buffer | null = null;
  let encapsulationKey: Uint8Array | null = null;
  let requestTranscript: Uint8Array | null = null;
  let ciphertext: Uint8Array | null = null;
  let serverSharedSecret: Uint8Array | null = null;
  let responseTranscript: Uint8Array | null = null;
  let daemonSignature: Uint8Array | null = null;
  let responseTranscriptHash: Uint8Array | null = null;
  let sessionSecrets: Uint8Array | null = null;
  try {
    if (p256PrivateKey === null) throw new Error('missing P-256 identity');
    crypto.getRandomValues(keygenSeed);
    crypto.getRandomValues(clientNonce);
    crypto.getRandomValues(daemonNonce);
    crypto.getRandomValues(delegationAuthorizationDigest);
    crypto.getRandomValues(encapsulationRandomness);
    crypto.getRandomValues(signingRandomness);
    bootstrap = new e2eWasm.SessionClientBootstrap(keygenSeed);
    encapsulationKey = bootstrap.encapsulationKey;
    if (encapsulationKey.byteLength !== ML_KEM_ENCAPSULATION_KEY_BYTES) {
      throw new Error(`unexpected ML-KEM public key length: ${encapsulationKey.byteLength}`);
    }
    requestTranscript = e2eWasm.buildSessionRequestTranscript(
      SESSION_TOKEN_BYTES,
      'benchmark-session',
      'benchmark-browser',
      'benchmark-daemon',
      clientNonce,
      encapsulationKey,
    );
    requestHash = e2eWasm.hashSessionRequestTranscript(requestTranscript);
    prologue = e2eWasm.derive_prologue('benchmark-session', 'benchmark-daemon', requestHash);
    browserStatic = e2eWasm.generate_static_keypair();
    daemonStatic = e2eWasm.generate_static_keypair();
    start = e2eWasm.E2ePendingHandshake.start(browserStatic.subarray(0, 32), prologue);
    pending = start.takeHandshake();
    msg1 = start.msg1;
    responderStart = e2eWasm.E2eResponderStart.start(daemonStatic.subarray(0, 32), prologue, msg1);
    browserStatic.fill(0);
    daemonStatic.fill(0);
    browserStatic = null;
    daemonStatic = null;
    noiseMsg2 = responderStart.msg2;
    const encapsulated = ml_kem1024.encapsulate(encapsulationKey, encapsulationRandomness);
    ciphertext = encapsulated.cipherText;
    serverSharedSecret = encapsulated.sharedSecret;
    if (ciphertext.byteLength !== ML_KEM_CIPHERTEXT_BYTES) {
      throw new Error(`unexpected ML-KEM ciphertext length: ${ciphertext.byteLength}`);
    }
    responseTranscript = e2eWasm.buildSessionResponseTranscript(
      requestTranscript,
      delegationAuthorizationDigest,
      daemonNonce,
      ciphertext,
      1,
      noiseMsg2,
    );
    daemonSignature = daemonIdentity.sign(
      DAEMON_SIGNATURE_CONTEXT,
      responseTranscript,
      signingRandomness,
    );
    if (
      daemonPublicKey.byteLength !== ML_DSA_87_PUBLIC_KEY_BYTES ||
      daemonSignature.byteLength !== ML_DSA_87_SIGNATURE_BYTES
    ) {
      throw new Error('ML-DSA-87 identity or signature has an invalid length');
    }
    responseTranscriptHash = e2eWasm.hashSessionResponseTranscript(responseTranscript);
    // The combiner's third output — the carrier-rebind chaining secret — is
    // held inside Wasm and never returned, so this measures exactly the two
    // secrets that reach JavaScript.
    const length = Buffer.alloc(8);
    length.writeBigUInt64LE(BigInt(responseTranscript.length));
    p256Signature = sign(
      'sha256',
      Buffer.concat([DAEMON_SIGNATURE_CONTEXT, length, responseTranscript]),
      { key: p256PrivateKey, dsaEncoding: 'ieee-p1363' },
    );
    const order = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
    const s = BigInt(`0x${p256Signature.subarray(32).toString('hex')}`);
    if (s > order / 2n)
      Buffer.from((order - s).toString(16).padStart(64, '0'), 'hex').copy(p256Signature, 32);
    bootstrapOutput = bootstrap.complete(
      ciphertext,
      daemonPublicKey,
      p256PublicKey,
      daemonSignature,
      p256Signature,
      responseTranscript,
      pending,
      noiseMsg2,
    );
    sessionSecrets = bootstrapOutput.transportSecrets;
    keeper = bootstrapOutput.takeRebindKeeper();
    responder = responderStart.installPsk(sessionSecrets.subarray(0, 32));
    msg3 = bootstrapOutput.msg3;
    responder.read_message(msg3);
    initiator = bootstrapOutput.takeHandshake();
    if (!responder.is_complete() || !initiator.is_complete())
      throw new Error('incomplete authenticated handshake');
    if (
      responseTranscriptHash.byteLength !== SESSION_RESPONSE_HASH_BYTES ||
      sessionSecrets.byteLength !== SESSION_SECRETS_BYTES ||
      equalBytes(
        sessionSecrets.subarray(0, SESSION_SECRET_BYTES),
        sessionSecrets.subarray(SESSION_SECRET_BYTES),
      )
    ) {
      throw new Error('signed session response or independent secret derivation is invalid');
    }
  } finally {
    keygenSeed.fill(0);
    clientNonce.fill(0);
    daemonNonce.fill(0);
    delegationAuthorizationDigest.fill(0);
    encapsulationRandomness.fill(0);
    signingRandomness.fill(0);
    encapsulationKey?.fill(0);
    requestTranscript?.fill(0);
    ciphertext?.fill(0);
    serverSharedSecret?.fill(0);
    responseTranscript?.fill(0);
    daemonSignature?.fill(0);
    responseTranscriptHash?.fill(0);
    sessionSecrets?.fill(0);
    browserStatic?.fill(0);
    daemonStatic?.fill(0);
    requestHash?.fill(0);
    prologue?.fill(0);
    msg1?.fill(0);
    noiseMsg2?.fill(0);
    msg3?.fill(0);
    p256Signature?.fill(0);
    keeper?.free();
    responder?.free();
    initiator?.free();
    bootstrapOutput?.free();
    responderStart?.free();
    pending?.free();
    start?.free();
    bootstrap?.free();
  }
}

// Local on purpose: the shared helper's module reaches the e2e registry, which
// this benchmark must not load beside the module whose startup it measures.
function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

function readSampleCount(name: string, raw: string | undefined, fallback: number): number {
  const value = Number(raw ?? fallback);
  if (!Number.isSafeInteger(value) || value < 100) {
    throw new Error(`${name} must be a safe integer of at least 100 for p99`);
  }
  return value;
}
