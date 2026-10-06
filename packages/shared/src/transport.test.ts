import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  DATA_HANDSHAKE_KIND,
  DATA_HANDSHAKE_NONCE_BYTES,
  DATA_HANDSHAKE_PAYLOAD_BYTES,
  DATA_HANDSHAKE_VERSION,
  EDGE_ROUTING_PREFACE_VERSION,
  LOGICAL_CHANNEL_TO_ID,
  LOGICAL_CHANNELS,
  TRANSPORT_CHANNEL_ID,
  type TransportKind,
} from './transport';

const RUST_PROTOCOL_SOURCE = readFileSync(
  fileURLToPath(new URL('../../merkur-wire/src/protocol.rs', import.meta.url)),
  'utf8',
);
const RUST_E2E_SOURCE = readFileSync(
  fileURLToPath(new URL('../../merkur-e2e/src/lib.rs', import.meta.url)),
  'utf8',
);
const RUST_EDGE_PROTOCOL_SOURCE = readFileSync(
  fileURLToPath(new URL('../../merkur-edge-protocol/src/lib.rs', import.meta.url)),
  'utf8',
);

describe('transport kinds', () => {
  test('edgeWebTransport is an assignable TransportKind', () => {
    const kind: TransportKind = 'edgeWebTransport';
    expect(kind).toBe('edgeWebTransport');
  });
});

describe('transport display lanes', () => {
  test('assigns datagram and commit channels explicitly', () => {
    expect(LOGICAL_CHANNEL_TO_ID.displayDatagram).toBe(0x03);
    expect(LOGICAL_CHANNEL_TO_ID.displayCommit).toBe(0x04);
  });
});

/**
 * CROSS-LANGUAGE WIRE CONFORMANCE — channel IDs and lane ordering.
 *
 * Companion to packages/protocol/src/wire-conformance.test.ts (which pins the
 * MESSAGE_TYPE_* opcodes and proto-header offsets). These two files together
 * pin every shared wire constant to its literal value alongside the exact Rust
 * symbol it must equal, so a renumber on either side fails CI. This half lives
 * here because the per-package composite tsconfig forbids importing
 * @merkur/shared from packages/protocol, and channel IDs are a transport
 * concept owned by this module. Modeled on the pinned Noise interop vectors in
 * ./noise.test.ts.
 *
 * Authoritative Rust sources:
 *   - packages/merkur-wire/src/protocol.rs              (CHANNEL_* constants)
 *   - packages/merkur-e2e/src/lib.rs::lane_for_channel (lane ordering)
 */
describe('wire conformance: channel IDs (packages/merkur-wire/src/protocol.rs)', () => {
  const CHANNEL_GOLDEN: ReadonlyArray<readonly [number, string, string]> = [
    [TRANSPORT_CHANNEL_ID.signaling, 'CHANNEL_SIGNALING', RUST_PROTOCOL_SOURCE],
    [TRANSPORT_CHANNEL_ID.pty, 'CHANNEL_PTY', RUST_PROTOCOL_SOURCE],
    [TRANSPORT_CHANNEL_ID.ctrl, 'CHANNEL_CTRL', RUST_PROTOCOL_SOURCE],
    [TRANSPORT_CHANNEL_ID.displayDatagram, 'CHANNEL_DISPLAY_DATAGRAM', RUST_PROTOCOL_SOURCE],
    [TRANSPORT_CHANNEL_ID.displayCommit, 'CHANNEL_DISPLAY_COMMIT', RUST_PROTOCOL_SOURCE],
    [TRANSPORT_CHANNEL_ID.displayAck, 'CHANNEL_DISPLAY_ACK', RUST_PROTOCOL_SOURCE],
    [TRANSPORT_CHANNEL_ID.dataHandshake, 'CHANNEL_DATA_HELLO', RUST_PROTOCOL_SOURCE],
  ];

  test.each(CHANNEL_GOLDEN)('%s matches Rust %s', (actual, rustSymbol, rustSource) => {
    expect(actual).toBe(readRustNumericConst(rustSource, rustSymbol));
  });

  test('channel IDs are unique', () => {
    const ids = CHANNEL_GOLDEN.map(([value]) => value);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('the signaling channel is local to the terminal transport protocol', () => {
    expect(readRustNumericConst(RUST_PROTOCOL_SOURCE, 'CHANNEL_SIGNALING')).toBe(
      TRANSPORT_CHANNEL_ID.signaling,
    );
  });
});

describe('wire conformance: edge handshakes', () => {
  test('routing-preface version matches the edge contract the Rust peers share', () => {
    expect(EDGE_ROUTING_PREFACE_VERSION).toBe(
      readRustNumericConst(RUST_EDGE_PROTOCOL_SOURCE, 'PREFACE_VERSION'),
    );
  });

  test('bulk-handshake schema matches the daemon', () => {
    expect(DATA_HANDSHAKE_VERSION).toBe(
      readRustNumericConst(RUST_PROTOCOL_SOURCE, 'DATA_HANDSHAKE_VERSION'),
    );
    expect(DATA_HANDSHAKE_NONCE_BYTES).toBe(
      readRustNumericConst(RUST_PROTOCOL_SOURCE, 'DATA_HANDSHAKE_NONCE_BYTES'),
    );
    expect(DATA_HANDSHAKE_PAYLOAD_BYTES).toBe(DATA_HANDSHAKE_NONCE_BYTES + 2);
    expect(DATA_HANDSHAKE_KIND.hello as number).toBe(
      readRustEnumVariant(RUST_PROTOCOL_SOURCE, 'DataHandshakeKind', 'Hello'),
    );
    expect(DATA_HANDSHAKE_KIND.ack as number).toBe(
      readRustEnumVariant(RUST_PROTOCOL_SOURCE, 'DataHandshakeKind', 'Ack'),
    );
  });
});

describe('wire conformance: lane ordering (packages/merkur-e2e/src/lib.rs::lane_for_channel)', () => {
  // The browser derives per-channel AEAD lanes from the LOGICAL_CHANNELS array
  // order; the daemon hard-codes the same mapping in lane_for_channel. A mismatch
  // silently corrupts every nonce, so pin the ordering explicitly. Signaling
  // (0x00) has no lane on either side.
  const LANE_GOLDEN: ReadonlyArray<readonly [(typeof LOGICAL_CHANNELS)[number], number, number]> = [
    // [logical channel, expected lane index, expected transport channel id]
    ['pty', 0, 0x01],
    ['ctrl', 1, 0x02],
    ['displayDatagram', 2, 0x03],
    ['displayCommit', 3, 0x04],
    ['displayAck', 4, 0x05],
  ];

  test('LOGICAL_CHANNELS matches the daemon lane_for_channel ordering', () => {
    expect(LOGICAL_CHANNELS).toEqual(LANE_GOLDEN.map(([channel]) => channel));
    expect(readRustNumericConst(RUST_E2E_SOURCE, 'LANE_COUNT')).toBe(LOGICAL_CHANNELS.length);
  });

  test.each(LANE_GOLDEN)(
    '%s occupies lane %d with its transport channel id',
    (channel, lane, channelId) => {
      expect(LOGICAL_CHANNELS.indexOf(channel)).toBe(lane);
      expect(LOGICAL_CHANNEL_TO_ID[channel]).toBe(channelId);
      expect(RUST_E2E_SOURCE).toMatch(
        new RegExp(`0x${channelId.toString(16).padStart(2, '0')}\\s*=>\\s*Some\\(${lane}\\)`),
      );
    },
  );
});

function readRustNumericConst(source: string, symbol: string): number {
  const match = new RegExp(
    `(?:pub\\s+)?const\\s+${symbol}\\s*:\\s*[^=]+\\s*=\\s*(0x[0-9A-Fa-f_]+|[0-9_]+)\\s*;`,
  ).exec(source);
  if (match?.[1] === undefined) throw new Error(`missing Rust constant ${symbol}`);
  return Number(match[1].replaceAll('_', ''));
}

function readRustEnumVariant(source: string, enumName: string, variant: string): number {
  const enumBody = new RegExp(`enum\\s+${enumName}\\s*\\{([\\s\\S]*?)\\}`).exec(source)?.[1];
  if (enumBody === undefined) throw new Error(`missing Rust enum ${enumName}`);
  const match = new RegExp(`\\b${variant}\\s*=\\s*([0-9_]+)\\s*,`).exec(enumBody);
  if (match?.[1] === undefined)
    throw new Error(`missing Rust enum variant ${enumName}::${variant}`);
  return Number(match[1].replaceAll('_', ''));
}
