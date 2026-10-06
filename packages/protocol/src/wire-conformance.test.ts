import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  DISPLAY_ACK_PAYLOAD_BYTES,
  encode,
  encodeHeartbeatPingFrame,
  encodeHeartbeatPongFrame,
  MESSAGE_TYPE_DISPLAY_HASH_DIGEST,
  MESSAGE_TYPE_DISPLAY_RECEIVER_PROFILE,
  MESSAGE_TYPE_DISPLAY_REPAIR_END,
  MESSAGE_TYPE_EDITOR_ANCHOR,
  MESSAGE_TYPE_HEARTBEAT_PING,
  MESSAGE_TYPE_HEARTBEAT_PONG,
  MESSAGE_TYPE_INPUT_ACK,
  MESSAGE_TYPE_INPUT_ROUTING,
  MESSAGE_TYPE_PERF_ENABLE,
  MESSAGE_TYPE_PERF_GRID_CONVERGENCE_REQUEST,
  MESSAGE_TYPE_TRANSPORT_HINT,
} from './index';

const RUST_PROTOCOL_SOURCE = readFileSync(
  fileURLToPath(new URL('../../merkur-wire/src/protocol.rs', import.meta.url)),
  'utf8',
);

/**
 * CROSS-LANGUAGE WIRE CONFORMANCE (golden-value table).
 *
 * The frames this package encodes, and the opcodes the browser's tests build
 * frames with, are wire facts the Rust side owns in
 * `packages/merkur-wire/src/protocol.rs`. Drift is silent: a frame encoded with
 * the wrong opcode simply vanishes on the wire. This test reads the Rust source
 * and compares every opcode this package exports against the corresponding Rust
 * constant, and pins each encoder's exact bytes. The channel-ID and lane-order
 * half of the table lives in packages/shared/src/transport.test.ts.
 */
describe('wire conformance: message-type opcodes', () => {
  // Each entry: [TS constant, Rust symbol in merkur-wire's protocol.rs].
  const MESSAGE_TYPE_GOLDEN: ReadonlyArray<readonly [number, string]> = [
    [MESSAGE_TYPE_HEARTBEAT_PING, 'MSG_TYPE_HEARTBEAT_PING'],
    [MESSAGE_TYPE_HEARTBEAT_PONG, 'MSG_TYPE_HEARTBEAT_PONG'],
    [MESSAGE_TYPE_TRANSPORT_HINT, 'MSG_TYPE_TRANSPORT_HINT'],
    [MESSAGE_TYPE_INPUT_ACK, 'MSG_TYPE_INPUT_ACK'],
    [MESSAGE_TYPE_DISPLAY_HASH_DIGEST, 'MSG_TYPE_DISPLAY_HASH_DIGEST'],
    [MESSAGE_TYPE_DISPLAY_REPAIR_END, 'MSG_TYPE_DISPLAY_REPAIR_END'],
    [MESSAGE_TYPE_EDITOR_ANCHOR, 'MSG_TYPE_EDITOR_ANCHOR'],
    [MESSAGE_TYPE_INPUT_ROUTING, 'MSG_TYPE_INPUT_ROUTING'],
    [MESSAGE_TYPE_PERF_ENABLE, 'MSG_TYPE_PERF_ENABLE'],
    [MESSAGE_TYPE_PERF_GRID_CONVERGENCE_REQUEST, 'MSG_TYPE_PERF_GRID_CONVERGENCE_REQUEST'],
    [MESSAGE_TYPE_DISPLAY_RECEIVER_PROFILE, 'MSG_TYPE_DISPLAY_RECEIVER_PROFILE'],
  ];

  test.each(MESSAGE_TYPE_GOLDEN)('%s matches merkur-wire protocol.rs::%s', (actual, rustSymbol) => {
    expect(actual).toBe(readRustNumericConst(RUST_PROTOCOL_SOURCE, rustSymbol));
  });

  test('opcode assignments are unique (no two message types collide)', () => {
    const opcodes = MESSAGE_TYPE_GOLDEN.map(([value]) => value);
    expect(new Set(opcodes).size).toBe(opcodes.length);
  });
});

describe('wire conformance: encoded frames', () => {
  test('perf_enable encodes a canonical toggle and non-zero observation epoch', () => {
    const on = new Uint8Array(
      encode({ kind: 'perf_enable', enabled: true, observationEpoch: 0x0102_0304 }),
    );
    expect([...on]).toEqual([MESSAGE_TYPE_PERF_ENABLE, 0, 0, 5, 1, 1, 2, 3, 4]);
    expect(
      new Uint8Array(encode({ kind: 'perf_enable', enabled: false, observationEpoch: 9 }))[4],
    ).toBe(0);
    expect(() => encode({ kind: 'perf_enable', enabled: true, observationEpoch: 0 })).toThrow();
  });

  test('grid convergence request byte-matches the Rust contract', () => {
    const request = (observationEpoch: number, probeId: number) =>
      encode({ kind: 'perf_grid_convergence_request', observationEpoch, probeId });
    expect([...new Uint8Array(request(7, 9))]).toEqual([
      MESSAGE_TYPE_PERF_GRID_CONVERGENCE_REQUEST,
      0,
      0,
      8,
      0,
      0,
      0,
      7,
      0,
      0,
      0,
      9,
    ]);
    expect(() => request(0, 9)).toThrow();
    expect(() => request(7, 0)).toThrow();
  });

  test('transport_hint: an 11-byte body that ends in the measured presentation period', () => {
    // The depth is what bounds a display flush on the daemon side, so its
    // offset is load-bearing: reading the wrong two bytes would silently clamp
    // every redraw (or fail to clamp one that needed it).
    const frame = new Uint8Array(
      encode({
        kind: 'transport_hint',
        profile: 1,
        chunkBytes: 32768,
        snapshotBytes: 4194304,
        receiveQueueDatagrams: 256,
        presentationPeriodUs: 8_333,
      }),
    );
    // [type][len x3][profile][chunk x2][snapshot x4][queue depth x2][period x2]
    expect([...frame]).toEqual([
      MESSAGE_TYPE_TRANSPORT_HINT,
      0,
      0,
      11,
      1,
      0x80,
      0x00,
      0x00,
      0x40,
      0x00,
      0x00,
      0x01,
      0x00,
      0x20,
      0x8d,
    ]);
    const rust = readFileSync(
      new URL('../../../apps/daemon/dataplane/src/lib.rs', import.meta.url),
      'utf8',
    );
    expect(rust).toContain('const TRANSPORT_HINT_PAYLOAD_BYTES: usize = 11;');
  });

  test('display_receiver_profile: a 13-byte header, then 20 bytes per bucket', () => {
    const frame = new Uint8Array(
      encode({
        kind: 'display_receiver_profile',
        sampleRevision: 7,
        ageMs: 12,
        serviceDebtUs: 345,
        buckets: [
          {
            dictionaryClass: 1,
            sizeClass: 4,
            ratioClass: 0,
            sampleCount: 32,
            wireRatioPpm: 125_000,
            meanUs: 6,
            varianceUs2: 4,
            upperUs: 10,
          },
        ],
      }),
    );
    expect([...frame]).toEqual([
      MESSAGE_TYPE_DISPLAY_RECEIVER_PROFILE,
      0,
      0,
      33,
      ...[0, 0, 0, 7],
      ...[0, 0, 0, 12],
      ...[0, 0, 0x01, 0x59],
      1,
      ...[1, 4, 0, 32],
      ...[0, 0x01, 0xe8, 0x48],
      ...[0, 0, 0, 6],
      ...[0, 0, 0, 4],
      ...[0, 0, 0, 10],
    ]);
    const tooMany = Array.from({ length: 49 }, () => ({
      dictionaryClass: 0,
      sizeClass: 0,
      ratioClass: 0,
      sampleCount: 0,
      wireRatioPpm: 0,
      meanUs: 0,
      varianceUs2: 0,
      upperUs: 0,
    }));
    expect(() =>
      encode({
        kind: 'display_receiver_profile',
        sampleRevision: 1,
        ageMs: 0,
        serviceDebtUs: 0,
        buckets: tooMany,
      }),
    ).toThrow('too many buckets');
  });

  test('input_ack carries the sequence big-endian', () => {
    expect([...new Uint8Array(encode({ kind: 'input_ack', seq: 0x0102_0304 }))]).toEqual([
      MESSAGE_TYPE_INPUT_ACK,
      0,
      0,
      4,
      1,
      2,
      3,
      4,
    ]);
  });

  test('heartbeats carry big-endian u64 clocks and refuse values outside u64', () => {
    expect([...new Uint8Array(encodeHeartbeatPingFrame(0x0102_0304_0506_0708n))]).toEqual([
      MESSAGE_TYPE_HEARTBEAT_PING,
      0,
      0,
      8,
      1,
      2,
      3,
      4,
      5,
      6,
      7,
      8,
    ]);
    expect([...new Uint8Array(encodeHeartbeatPongFrame(1n, 2n))]).toEqual([
      MESSAGE_TYPE_HEARTBEAT_PONG,
      0,
      0,
      16,
      ...[0, 0, 0, 0, 0, 0, 0, 1],
      ...[0, 0, 0, 0, 0, 0, 0, 2],
    ]);
    for (const timestamp of [-1n, 0x1_0000_0000_0000_0000n]) {
      expect(() => encodeHeartbeatPingFrame(timestamp)).toThrow('timestamp must be a uint64');
      expect(() => encodeHeartbeatPongFrame(timestamp, 0n)).toThrow('timestamp must be a uint64');
    }
  });

  test('the display_ack body length matches the daemon that gates on it', () => {
    // The daemon drops a body of any other length outright, so a grant appended
    // on one side only silences every ACK rather than misreading one. A
    // narrower browser mask does not fail either: it reads as loss, and the
    // daemon re-sends rows the browser already has.
    expect(DISPLAY_ACK_PAYLOAD_BYTES).toBe(44);
    expect(RUST_PROTOCOL_SOURCE).toContain('pub const DISPLAY_ACK_MASK_WORDS: usize = 4;');
    expect(RUST_PROTOCOL_SOURCE).toContain(
      'pub const DISPLAY_ACK_PAYLOAD_BYTES: usize = 4 * (3 + 2 * DISPLAY_ACK_MASK_WORDS);',
    );
  });
});

describe('wire conformance: header field offsets/sizes', () => {
  test('proto header is 4 bytes, matching merkur-wire protocol.rs::PROTO_HEADER_BYTES', () => {
    // A heartbeat ping is the header plus one u64, which pins the header length.
    expect(encodeHeartbeatPingFrame(1n).byteLength - 8).toBe(
      readRustNumericConst(RUST_PROTOCOL_SOURCE, 'PROTO_HEADER_BYTES'),
    );
  });
});

function readRustNumericConst(source: string, symbol: string): number {
  const match = new RegExp(
    `(?:pub\\s+)?const\\s+${symbol}\\s*:\\s*[^=]+\\s*=\\s*([^;]+)\\s*;`,
  ).exec(source);
  if (match?.[1] === undefined) throw new Error(`missing Rust constant ${symbol}`);
  const expression = match[1].trim();

  const numeric = /^(?:0x[0-9A-Fa-f_]+|[0-9_]+)$/.exec(expression);
  if (numeric !== null) return Number(expression.replaceAll('_', ''));
  throw new Error(`unsupported Rust constant expression for ${symbol}: ${expression}`);
}
