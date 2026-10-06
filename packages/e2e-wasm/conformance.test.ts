import {
  deriveSoftwareDaemonP256PublicKey,
  signSoftwareDaemonP256Proof,
} from '../auth/src/daemon-proof';
// Wire conformance for the browser E2E binding.
//
// The binding compiles the same `merkur-e2e` source the daemon links, so there
// is exactly one implementation of the protocol and the committed interop
// vectors describe the wire format rather than reconciling two codebases. The
// native side pins that format in
// `merkur_e2e::tests::snow_reproduces_committed_vector`.
//
// What this file covers is everything that is specific to the BROWSER build and
// therefore invisible to the native tests: wasm32 codegen, the reused-buffer
// boundary (including growth, which detaches every view of linear memory), and
// the lane and prologue mapping the binding re-exports.

import { beforeAll, describe, expect, test } from 'bun:test';
import { createHash, createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ml_dsa87 } from '@noble/post-quantum/ml-dsa.js';
import { ml_kem1024 } from '@noble/post-quantum/ml-kem.js';
import { LOGICAL_CHANNELS } from '../shared/src/transport';
import * as e2eWasm from './pkg/e2e_wasm.js';

const REPO_ROOT = path.resolve(import.meta.dir, '../..');
const PSK = new Uint8Array(32).map((_, index) => (index * 7 + 13) & 0xff);
const PROLOGUE = new TextEncoder().encode('merkur-conformance-prologue');
const DAEMON_SIGNATURE_CONTEXT = new TextEncoder().encode('merkur-session-ready');
const FRAME_OVERHEAD = 24;

let wasmMemory: WebAssembly.Memory;
let committedNoiseVector: {
  readonly protocol: string;
  readonly handshake: { readonly handshake_hash_hex: string };
};

beforeAll(async () => {
  committedNoiseVector = JSON.parse(
    await readFile(path.join(REPO_ROOT, 'packages/shared/test-vectors/noise-xxpsk3.json'), 'utf8'),
  ) as typeof committedNoiseVector;
  wasmMemory = e2eWasm.initSync({
    module: new Uint8Array(
      await readFile(path.join(REPO_ROOT, 'packages/e2e-wasm/pkg/e2e_wasm_bg.wasm')),
    ),
  }).memory;
});

describe('e2e-wasm wire conformance', () => {
  test('content chunks survive reorder, unrelated traffic and WASM growth; epoch retirement revokes them', () => {
    const { initiator, responder } = establishPair();
    const descriptor = contentDescriptor(16_384 * 2 + 7, 1, 2);
    const sender = responder.content_sender(descriptor);
    const header = sender.header();
    initiator.content_expect_range(descriptor);
    views(initiator, header.length).input.set(header);
    const receiver = initiator.content_receiver(header.length);
    const sealChunk = (payload: Uint8Array): Uint8Array => {
      new Uint8Array(wasmMemory.buffer, sender.input_ptr, sender.capacity).set(payload);
      const length = sender.seal_next(payload.length);
      expect(length).toBe(payload.length + 20);
      return new Uint8Array(wasmMemory.buffer, sender.output_ptr, length).slice();
    };
    const openChunk = (record: Uint8Array): number => {
      new Uint8Array(wasmMemory.buffer, receiver.input_ptr, receiver.capacity).set(record);
      return receiver.open_chunk(record.length);
    };
    try {
      expect(sender.seal_next(1)).toBe(-1);
      const first = sealChunk(fill(16_384));
      const last = sealChunk(fill(7));
      const pointers = [
        sender.input_ptr,
        sender.output_ptr,
        receiver.input_ptr,
        receiver.output_ptr,
      ];
      // Another owner grows shared linear memory; these owners keep their offsets.
      responder.reserve(2 * 1024 * 1024);
      expect([
        sender.input_ptr,
        sender.output_ptr,
        receiver.input_ptr,
        receiver.output_ptr,
      ]).toEqual(pointers);
      const memoryBytes = wasmMemory.buffer.byteLength;
      expect(openChunk(last)).toBe(7);
      expect(new Uint8Array(wasmMemory.buffer, receiver.output_ptr, 7)).toEqual(fill(7));
      const corrupt = first.slice();
      corrupt[20] = (corrupt[20] ?? 0) ^ 1;
      expect(openChunk(corrupt)).toBe(-1);
      expect(
        new Uint8Array(wasmMemory.buffer, receiver.output_ptr, 16_384).every((byte) => byte === 0),
      ).toBe(true);
      expect(openChunk(first)).toBe(16_384);
      expect(new Uint8Array(wasmMemory.buffer, receiver.output_ptr, 16_384)).toEqual(fill(16_384));
      expect(openChunk(last)).toBe(-2);
      const corruptDuplicate = last.slice();
      corruptDuplicate[5] = (corruptDuplicate[5] ?? 0) ^ 1;
      expect(openChunk(corruptDuplicate)).toBe(-1);
      expect(wasmMemory.buffer.byteLength).toBe(memoryBytes);
      for (let i = 0; i < 1100; i += 1) {
        expect(open(initiator, 'ctrl', false, seal(responder, 'ctrl', false, fill(1)))).toEqual(
          fill(1),
        );
      }
      expect(openChunk(last)).toBe(-2);
      views(initiator, header.length).input.set(header);
      expect(() => initiator.content_receiver(header.length)).toThrow();
      expect(receiver.open_chunk(receiver.capacity + 1)).toBe(-1);
      initiator.free();
      responder.free();
      expect(openChunk(last)).toBe(-1);
      expect(sender.seal_next(7)).toBe(-1);
    } finally {
      sender.free();
      receiver.free();
    }
  });

  test('content headers bind the expected request and cap all retained WASM owners', () => {
    const { initiator, responder } = establishPair();
    const descriptor = contentDescriptor(1, 0, 1);
    const senders: e2eWasm.E2eContentSender[] = [];
    const receivers: e2eWasm.E2eContentReceiver[] = [];
    try {
      for (let i = 0; i < 32; i += 1) {
        new DataView(descriptor.buffer).setBigUint64(0, BigInt(i + 1));
        const sender = responder.content_sender(descriptor);
        senders.push(sender);
        const header = sender.header();
        views(initiator, header.length).input.set(header);
        expect(() => initiator.content_receiver(header.length)).toThrow();
        initiator.content_expect_whole(BigInt(i + 1), descriptor.subarray(8, 40), 1);
        const receiver = initiator.content_receiver(header.length);
        expect(receiver.descriptor()).toEqual(descriptor);
        receivers.push(receiver);
      }
      expect(() => responder.content_sender(descriptor)).toThrow();
      senders.pop()?.free();
      new DataView(descriptor.buffer).setBigUint64(0, 33n);
      initiator.content_expect_range(descriptor);
      const extra = responder.content_sender(descriptor);
      senders.push(extra);
      const header = extra.header();
      views(initiator, header.length).input.set(header);
      expect(() => initiator.content_receiver(header.length)).toThrow();
      receivers.pop()?.free();
      receivers.push(initiator.content_receiver(header.length));
    } finally {
      for (const owner of senders) owner.free();
      for (const owner of receivers) owner.free();
      initiator.free();
      responder.free();
    }
  });

  test('fresh content headers require a live bounded request and cancellation cannot revive its ID', () => {
    const { initiator, responder } = establishPair();
    const descriptor = contentDescriptor(37, 0, 1);
    const sender = responder.content_sender(descriptor);
    try {
      const header = sender.header();
      views(initiator, header.length).input.set(header);
      expect(() => initiator.content_receiver(header.length)).toThrow();
      const source = descriptor.slice(8, 40);
      const wrongSource = source.map((byte) => byte ^ 1);
      initiator.content_expect_whole(17n, wrongSource, 37);
      expect(() => initiator.content_receiver(header.length)).toThrow();
      expect(initiator.content_cancel_request(17n)).toBe(true);
      expect(initiator.content_cancel_request(17n)).toBe(false);
      expect(() => initiator.content_expect_whole(17n, source, 37)).toThrow();
      expect(() => initiator.content_receiver(header.length)).toThrow();
      for (let id = 18n; id < 50n; id += 1n) {
        initiator.content_expect_whole(id, source, 37);
      }
      expect(() => initiator.content_expect_whole(50n, source, 37)).toThrow();
      expect(initiator.content_cancel_request(18n)).toBe(true);
      initiator.content_expect_whole(50n, source, 37);
      new DataView(descriptor.buffer).setBigUint64(0, 50n);
      const liveSender = responder.content_sender(descriptor);
      try {
        const liveHeader = liveSender.header();
        const corrupt = liveHeader.slice();
        corrupt[8] = (corrupt[8] ?? 0) ^ 1;
        views(initiator, corrupt.length).input.set(corrupt);
        expect(() => initiator.content_receiver(corrupt.length)).toThrow();
        views(initiator, liveHeader.length).input.set(liveHeader);
        expect(() => initiator.content_receiver(liveHeader.length - 1)).toThrow();
        const receiver = initiator.content_receiver(liveHeader.length);
        expect(receiver.descriptor()).toEqual(descriptor);
        receiver.free();
        expect(initiator.content_cancel_request(50n)).toBe(false);
        expect(() => initiator.content_receiver(liveHeader.length)).toThrow();
      } finally {
        liveSender.free();
      }
    } finally {
      sender.free();
      initiator.free();
      responder.free();
    }
  });

  test('jumbo display records authenticate before advancing replay across buffer growth', () => {
    const { initiator, responder } = establishPair();
    try {
      for (const size of [65_520, 2 * 1024 * 1024]) {
        const payload = fill(size);
        const wire = seal(responder, 'displayCommit', false, payload);
        const corrupt = wire.slice();
        const middle = Math.floor(corrupt.length / 2);
        corrupt[middle] = (corrupt[middle] ?? 0) ^ 1;
        expect(open(initiator, 'displayCommit', false, corrupt)).toBeNull();
        expect(open(initiator, 'displayCommit', true, wire)).toBeNull();
        expect(open(initiator, 'displayCommit', false, wire)).toEqual(payload);
        expect(open(initiator, 'displayCommit', false, wire)).toBeNull();
        const reply = seal(initiator, 'displayCommit', false, payload);
        expect(open(responder, 'displayCommit', false, reply)).toEqual(payload);
      }
    } finally {
      initiator.free();
      responder.free();
    }
  });

  test('every channel and lane round trips at every frame size', () => {
    const { initiator, responder } = establishPair();
    for (const channel of LOGICAL_CHANNELS) {
      for (const datagram of [false, true]) {
        // 0 and 1 bytes catch off-by-ones in the framing prefix; 16384 forces a
        // reserve past the initial capacity, which moves both buffers.
        for (const size of [0, 1, 32, 1024, 8192, 16384]) {
          const payload = fill(size);
          const framed = seal(initiator, channel, datagram, payload);
          expect(framed.byteLength).toBe(size + FRAME_OVERHEAD);
          expect(Array.from(open(responder, channel, datagram, framed) ?? [])).toEqual(
            Array.from(payload),
          );
          // And the reverse direction, which uses the other transport key.
          const back = seal(responder, channel, datagram, payload);
          expect(Array.from(open(initiator, channel, datagram, back) ?? [])).toEqual(
            Array.from(payload),
          );
        }
      }
    }
  });

  test('a lane tolerates reorder and then rejects every duplicate', () => {
    const { initiator, responder } = establishPair();
    const frames = Array.from({ length: 8 }, (_, index) =>
      seal(initiator, 'pty', true, fill(16 + index)),
    );
    // A frame fanned over a second transport routinely arrives behind a later
    // one and must still open.
    for (const index of [5, 0, 7, 2, 1, 6, 3, 4]) {
      const frame = frames[index] ?? new Uint8Array();
      expect(open(responder, 'pty', true, frame)).not.toBeNull();
    }
    for (const frame of frames) {
      expect(open(responder, 'pty', true, frame)).toBeNull();
    }
  });

  test('a tampered frame is rejected without disturbing the lane', () => {
    const { initiator, responder } = establishPair();
    const good = seal(initiator, 'ctrl', false, fill(64));
    const tampered = Uint8Array.from(good);
    const last = tampered.length - 1;
    tampered[last] = (tampered[last] ?? 0) ^ 0xff;
    expect(open(responder, 'ctrl', false, tampered)).toBeNull();
    // The window only advances on a successful open, so the genuine frame
    // carrying the same counter must still be accepted afterwards.
    expect(open(responder, 'ctrl', false, good)).not.toBeNull();
  });

  test('stream and datagram sub-lanes are independent', () => {
    const { initiator, responder } = establishPair();
    const streamFrame = seal(initiator, 'pty', false, fill(48));
    const datagramFrame = seal(initiator, 'pty', true, fill(48));
    // Identical counters on different sub-lanes; opening one must not consume
    // the other's window slot, and neither may open on the wrong sub-lane.
    expect(open(responder, 'pty', true, streamFrame)).toBeNull();
    expect(open(responder, 'pty', false, streamFrame)).not.toBeNull();
    expect(open(responder, 'pty', true, datagramFrame)).not.toBeNull();
  });

  test('the prologue matches the byte string the native build pins', () => {
    // The same inputs and hex asserted by
    // merkur_e2e::tests::derive_prologue_matches_shared_hex.
    expect(
      hex(e2eWasm.derive_prologue('sess-123', 'daemon-xyz', new Uint8Array(64).fill(0x42))),
    ).toBe(
      '6d65726b75722d7472616e73706f72742d7071' +
        '0000000000000008736573732d313233' +
        '000000000000000a6461656d6f6e2d78797a' +
        '4242424242424242424242424242424242424242424242424242424242424242' +
        '4242424242424242424242424242424242424242424242424242424242424242',
    );
  });

  test('the committed Noise vector pins the SHA-512 hard cut', () => {
    expect(committedNoiseVector.protocol).toBe('Noise_XXpsk3_25519_ChaChaPoly_SHA512');
    expect(committedNoiseVector.handshake.handshake_hash_hex).toHaveLength(128);
  });

  test('PQ bootstrap and signed transcript boundary are fixed and one-shot', () => {
    const firstSeed = new Uint8Array(64).fill(0x11);
    const secondSeed = new Uint8Array(64).fill(0x11);
    const first = new e2eWasm.SessionClientBootstrap(firstSeed);
    const second = new e2eWasm.SessionClientBootstrap(secondSeed);
    expect(firstSeed.every((byte) => byte === 0)).toBeTrue();
    expect(secondSeed.every((byte) => byte === 0)).toBeTrue();
    expect(first.encapsulationKey.byteLength).toBe(1568);
    expect(Array.from(first.encapsulationKey)).toEqual(Array.from(second.encapsulationKey));

    const clientNonce = new Uint8Array(32).fill(0x22);
    const request = e2eWasm.buildSessionRequestTranscript(
      new TextEncoder().encode('signed.session.token'),
      'session-from-server',
      'browser-node',
      'daemon-node',
      clientNonce,
      first.encapsulationKey,
    );
    const requestOtherSession = e2eWasm.buildSessionRequestTranscript(
      new TextEncoder().encode('signed.session.token'),
      'session-other',
      'browser-node',
      'daemon-node',
      clientNonce,
      first.encapsulationKey,
    );
    expect(hex(request)).not.toBe(hex(requestOtherSession));

    const encapsulated = ml_kem1024.encapsulate(
      first.encapsulationKey,
      new Uint8Array(32).fill(0x44),
    );
    const delegationProof = e2eWasm.buildSessionDelegationProofTranscript(
      request,
      new TextEncoder().encode('{"delegationId":"browser-delegation"}'),
    );
    const delegationAuthorizationDigest = e2eWasm.computeSessionDelegationAuthorizationDigest(
      delegationProof,
      new Uint8Array(4_627).fill(0x33),
    );
    expect(delegationAuthorizationDigest.byteLength).toBe(64);
    const prologue = e2eWasm.derive_prologue(
      'session-from-server',
      'daemon-node',
      e2eWasm.hashSessionRequestTranscript(request),
    );
    const start = e2eWasm.E2ePendingHandshake.start(staticKey(), prologue);
    const pending = start.takeHandshake();
    const responderStart = e2eWasm.E2eResponderStart.start(staticKey(), prologue, start.msg1);
    const noiseMsg2 = responderStart.msg2;
    const response = e2eWasm.buildSessionResponseTranscript(
      request,
      delegationAuthorizationDigest,
      new Uint8Array(32).fill(0x55),
      encapsulated.cipherText,
      17,
      noiseMsg2,
    );
    expect(e2eWasm.hashSessionResponseTranscript(response).byteLength).toBe(64);

    const daemonIdentity = ml_dsa87.keygen(new Uint8Array(32).fill(0x66));
    const signature = ml_dsa87.sign(response, daemonIdentity.secretKey, {
      context: DAEMON_SIGNATURE_CONTEXT,
      extraEntropy: new Uint8Array(32).fill(0x77),
    });
    const p256Key = deriveSoftwareDaemonP256PublicKey(new Uint8Array(32).fill(0x66));
    const p256Signature = signSoftwareDaemonP256Proof(
      new Uint8Array(32).fill(0x66),
      DAEMON_SIGNATURE_CONTEXT,
      response,
    );
    const order = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
    const highS = Uint8Array.from(p256Signature);
    const scalar = BigInt(`0x${Buffer.from(highS.subarray(32)).toString('hex')}`);
    highS.set(Buffer.from((order - scalar).toString(16).padStart(64, '0'), 'hex'), 32);
    const wrongP256 = Uint8Array.from(p256Signature);
    wrongP256[0] = (wrongP256[0] ?? 0) ^ 1;
    for (const [mldsa, p256] of [
      [new Uint8Array(), p256Signature],
      [signature, new Uint8Array()],
      [new Uint8Array(4627), p256Signature],
      [signature, wrongP256],
      [signature, highS],
    ]) {
      const rejected = new e2eWasm.SessionClientBootstrap(new Uint8Array(64).fill(0x11));
      expect(() =>
        rejected.complete(
          encapsulated.cipherText,
          daemonIdentity.publicKey,
          p256Key,
          mldsa ?? new Uint8Array(),
          p256 ?? new Uint8Array(),
          response,
          pending,
          noiseMsg2,
        ),
      ).toThrow();
      rejected.free();
    }
    const firstOutput = first.complete(
      encapsulated.cipherText,
      daemonIdentity.publicKey,
      p256Key,
      signature,
      p256Signature,
      response,
      pending,
      noiseMsg2,
    );
    // Only the two carrier-scoped secrets cross the boundary. The combiner's
    // third output — the carrier-rebind chaining secret — stays inside Wasm
    // behind a RebindKeeper, because it is the one secret that outlives a
    // carrier and it must never become a JavaScript byte array.
    const secrets = firstOutput.transportSecrets;
    expect(secrets.byteLength).toBe(64);
    expect(hex(secrets.subarray(0, 32))).not.toBe(hex(secrets.subarray(32)));
    const keeper = firstOutput.takeRebindKeeper();
    expect(keeper.counter).toBe(0n);
    expect(() =>
      first.complete(
        encapsulated.cipherText,
        daemonIdentity.publicKey,
        p256Key,
        signature,
        p256Signature,
        response,
        pending,
        noiseMsg2,
      ),
    ).toThrow();

    const responder = responderStart.installPsk(secrets.subarray(0, 32));
    responder.read_message(firstOutput.msg3);
    expect(responder.is_complete()).toBeTrue();
    const handshake = firstOutput.takeHandshake();
    expect(handshake.is_complete()).toBeTrue();
    handshake.free();
    responder.free();
    responderStart.free();
    pending.free();
    start.free();
    firstOutput.free();
    second.free();
    keeper.free();
    daemonIdentity.secretKey.fill(0);
    encapsulated.sharedSecret.fill(0);
    secrets.fill(0);
  });

  test('PQ Wasm boundary rejects every wrong fixed length', () => {
    expect(() => new e2eWasm.SessionClientBootstrap(new Uint8Array(63))).toThrow();
    const bootstrap = new e2eWasm.SessionClientBootstrap(new Uint8Array(64).fill(1));
    expect(() =>
      e2eWasm.buildSessionRequestTranscript(
        new Uint8Array([1]),
        'session',
        'browser',
        'daemon',
        new Uint8Array(31),
        bootstrap.encapsulationKey,
      ),
    ).toThrow();
    expect(
      e2eWasm.computeSessionRequestCommitment(new Uint8Array(32), bootstrap.encapsulationKey)
        .byteLength,
    ).toBe(64);
    const request = e2eWasm.buildSessionRequestTranscript(
      new Uint8Array([1]),
      'session',
      'browser',
      'daemon',
      new Uint8Array(32),
      bootstrap.encapsulationKey,
    );
    const proof = e2eWasm.buildSessionDelegationProofTranscript(request, new Uint8Array([1]));
    expect(() =>
      e2eWasm.computeSessionDelegationAuthorizationDigest(proof, new Uint8Array(4_626)),
    ).toThrow();
    expect(() =>
      e2eWasm.buildSessionResponseTranscript(
        request,
        new Uint8Array(63),
        new Uint8Array(32),
        new Uint8Array(1_568),
        0,
        new Uint8Array(96),
      ),
    ).toThrow();
    expect(() => e2eWasm.computeDaemonIdentityKeyHash(new Uint8Array(2_591))).toThrow();
  });

  test('the lane mapping matches LOGICAL_CHANNELS ordering', () => {
    // Wire channel ids are 1-based in the order LOGICAL_CHANNELS declares.
    for (const [index] of LOGICAL_CHANNELS.entries()) {
      expect(e2eWasm.lane_for_channel(index + 1)).toBe(index);
    }
    expect(e2eWasm.lane_for_channel(0)).toBe(-1);
    expect(e2eWasm.lane_for_channel(LOGICAL_CHANNELS.length + 1)).toBe(-1);
  });

  test('a static keypair is 32 bytes of private key followed by 32 of public', () => {
    const pair = e2eWasm.generate_static_keypair();
    expect(pair.byteLength).toBe(64);
    expect(Array.from(pair.subarray(0, 32))).not.toEqual(Array.from(pair.subarray(32)));
  });

  test('a mismatched PSK fails the handshake closed', () => {
    const otherPsk = new Uint8Array(32).fill(9);
    const initiator = new e2eWasm.E2eHandshake(staticKey(), PSK, PROLOGUE);
    const responder = e2eWasm.E2eHandshake.newResponder(staticKey(), otherPsk, PROLOGUE);
    responder.read_message(initiator.write_message());
    initiator.read_message(responder.write_message());
    // psk3 mixes the PSK at the final message, so the mismatch surfaces there.
    expect(() => responder.read_message(initiator.write_message())).toThrow();
  });

  test('a consumed handshake cannot yield a second transport', () => {
    const { initiatorHandshake } = establishPair();
    // A second transport would restart the nonce schedule under the same key.
    expect(() => initiatorHandshake.into_transport(1024)).toThrow();
  });
});

// The Wasm build is the only ML-DSA-87 implementation in TypeScript: browser,
// server and daemon CLI sign and verify through it. noble is kept here, and
// only here, as an independent FIPS 204 oracle, so a libcrux change that
// silently altered key expansion or the hedged signature would fail this
// rather than re-key every stored user root.
describe('e2e-wasm ML-DSA-87 against an independent FIPS 204 implementation', () => {
  const encoder = new TextEncoder();
  const context = encoder.encode('merkur-browser-delegation');

  test('key expansion and hedged signatures are byte-identical to noble', () => {
    for (let index = 0; index < 8; index += 1) {
      const seed = new Uint8Array(32).map((_, byte) => (byte * 31 + index * 7) & 0xff);
      const randomness = new Uint8Array(32).fill(0x90 + index);
      const message = encoder.encode(`merkur-conformance-message-${index}`);
      const key = e2eWasm.MlDsa87SigningKey.fromSeed(seed);
      const oracle = ml_dsa87.keygen(seed);
      try {
        expect(key.publicKey).toEqual(oracle.publicKey);
        const signature = key.sign(context, message, randomness);
        expect(signature).toEqual(
          ml_dsa87.sign(message, oracle.secretKey, { context, extraEntropy: randomness }),
        );
        expect(ml_dsa87.verify(signature, message, oracle.publicKey, { context })).toBe(true);
        expect(e2eWasm.mlDsa87Verify(oracle.publicKey, context, message, signature)).toBe(true);
      } finally {
        key.free();
        oracle.secretKey.fill(0);
      }
      // The seed is copied into Wasm, never consumed: the vault re-derives it.
      expect(seed.some((byte) => byte !== 0)).toBe(true);
    }
  });

  test('verification binds context, message, signature and exact lengths', () => {
    const key = e2eWasm.MlDsa87SigningKey.fromSeed(new Uint8Array(32).fill(0x31));
    try {
      const publicKey = key.publicKey;
      const message = encoder.encode('payload');
      const signature = key.sign(context, message, new Uint8Array(32).fill(0x32));
      expect(e2eWasm.mlDsa87Verify(publicKey, context, message, signature)).toBe(true);
      expect(
        e2eWasm.mlDsa87Verify(
          publicKey,
          encoder.encode('merkur-daemon-binding'),
          message,
          signature,
        ),
      ).toBe(false);
      expect(e2eWasm.mlDsa87Verify(publicKey, context, encoder.encode('payloaD'), signature)).toBe(
        false,
      );
      const flipped = signature.slice();
      flipped[100] = (flipped[100] ?? 0) ^ 1;
      expect(e2eWasm.mlDsa87Verify(publicKey, context, message, flipped)).toBe(false);
      expect(e2eWasm.mlDsa87Verify(publicKey, context, message, signature.subarray(1))).toBe(false);
      expect(e2eWasm.mlDsa87Verify(publicKey.subarray(1), context, message, signature)).toBe(false);
      expect(() => key.sign(context, message, new Uint8Array(31))).toThrow();
      expect(() => key.sign(new Uint8Array(256), message, new Uint8Array(32))).toThrow();
      expect(() => e2eWasm.MlDsa87SigningKey.fromSeed(new Uint8Array(31))).toThrow();
    } finally {
      key.free();
    }
  });

  test('digests and the link-approval MAC match node:crypto', () => {
    const message = encoder.encode('merkur-digest-conformance');
    const key = new Uint8Array(32).fill(0x5c);
    expect(Buffer.from(e2eWasm.sha256(message)).toString('hex')).toBe(
      createHash('sha256').update(message).digest('hex'),
    );
    expect(Buffer.from(e2eWasm.sha512(message)).toString('hex')).toBe(
      createHash('sha512').update(message).digest('hex'),
    );
    expect(Buffer.from(e2eWasm.hmacSha512(key, message)).toString('hex')).toBe(
      createHmac('sha512', key).update(message).digest('hex'),
    );
  });
});

interface Pair {
  readonly initiator: e2eWasm.E2eTransport;
  readonly responder: e2eWasm.E2eTransport;
  readonly initiatorHandshake: e2eWasm.E2eHandshake;
}

function establishPair(): Pair {
  const initiatorHandshake = new e2eWasm.E2eHandshake(staticKey(), PSK, PROLOGUE);
  const responderHandshake = e2eWasm.E2eHandshake.newResponder(staticKey(), PSK, PROLOGUE);
  responderHandshake.read_message(initiatorHandshake.write_message());
  initiatorHandshake.read_message(responderHandshake.write_message());
  responderHandshake.read_message(initiatorHandshake.write_message());
  if (!initiatorHandshake.is_complete() || !responderHandshake.is_complete()) {
    throw new Error('conformance handshake did not complete');
  }
  return {
    initiator: initiatorHandshake.into_transport(8192),
    responder: responderHandshake.into_transport(8192),
    initiatorHandshake,
  };
}

function staticKey(): Uint8Array {
  return e2eWasm.generate_static_keypair().subarray(0, 32);
}

function contentDescriptor(bytes: number, first: number, count: number): Uint8Array {
  const descriptor = new Uint8Array(84);
  const view = new DataView(descriptor.buffer);
  view.setBigUint64(0, 17n);
  descriptor.fill(0x33, 8, 40);
  descriptor.fill(0x44, 40, 72);
  view.setUint32(72, bytes);
  view.setUint32(76, first);
  view.setUint32(80, count);
  return descriptor;
}

// Views are rebuilt per call here rather than cached: `reserve` moves the
// buffers and memory growth detaches every view, and a test has no reason to
// optimize that away.
function views(
  transport: e2eWasm.E2eTransport,
  bytes: number,
): { input: Uint8Array; output: Uint8Array } {
  if (bytes > transport.capacity) transport.reserve(bytes);
  const size = transport.capacity + FRAME_OVERHEAD;
  return {
    input: new Uint8Array(wasmMemory.buffer, transport.input_ptr, size),
    output: new Uint8Array(wasmMemory.buffer, transport.output_ptr, size),
  };
}

function seal(
  transport: e2eWasm.E2eTransport,
  channel: (typeof LOGICAL_CHANNELS)[number],
  datagram: boolean,
  payload: Uint8Array,
): Uint8Array {
  const view = views(transport, payload.byteLength);
  view.input.set(payload);
  return view.output.slice(0, transport.seal(laneOf(channel), datagram, payload.byteLength));
}

function open(
  transport: e2eWasm.E2eTransport,
  channel: (typeof LOGICAL_CHANNELS)[number],
  datagram: boolean,
  framed: Uint8Array,
): Uint8Array | null {
  const view = views(transport, framed.byteLength);
  view.input.set(framed);
  const length = transport.open(laneOf(channel), datagram, framed.byteLength);
  return length < 0 ? null : view.output.slice(0, length);
}

function laneOf(channel: (typeof LOGICAL_CHANNELS)[number]): number {
  return LOGICAL_CHANNELS.indexOf(channel);
}

function fill(size: number): Uint8Array {
  return new Uint8Array(size).map((_, index) => (index * 31 + size) & 0xff);
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
