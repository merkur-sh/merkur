import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { DISPLAY_PROTOCOL_VERSION } from './display-stream';
import {
  DISPLAY_WIRE_FIXED_HEADER_BYTES,
  DISPLAY_WIRE_MAX_UNCHUNKED_HEADER_BYTES,
  DISPLAY_WIRE_PRESENT_CHUNK,
  DISPLAY_WIRE_PRESENT_CLOSURE,
  DISPLAY_WIRE_PRESENT_ECHO_HORIZON,
  DISPLAY_WIRE_PRESENT_PREDECESSOR,
  encodeDisplayWireFrame,
  readDisplayWireIdentity,
} from './display-wire';
import type { SynchronousByteSource } from './transport-provider';

interface WireVectorCase {
  readonly name: string;
  readonly staged: string;
  readonly wire: string;
  readonly generation: number;
  readonly seq: number;
  readonly frameId: number;
  readonly chunkIndex: number;
  readonly chunkCount: number;
}

// Written by `merkur_codec::wire::tests::write_wire_vector`, which the Rust
// encoder is asserted against too: one set of bytes pins both languages.
// SAFETY: that writer emits exactly this shape, and the Rust test fails when
// the committed file differs from what it would write.
const VECTOR = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../test-vectors/display-wire.json', import.meta.url)),
    'utf8',
  ),
) as {
  readonly version: number;
  readonly maxUnchunkedHeaderBytes: number;
  readonly cases: readonly WireVectorCase[];
};

const RUST_WIRE_SOURCE = readFileSync(
  fileURLToPath(new URL('../../merkur-codec/src/wire.rs', import.meta.url)),
  'utf8',
);

function fromHex(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function source(bytes: Uint8Array): SynchronousByteSource {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    byteLength: bytes.byteLength,
    getUint8: (offset) => view.getUint8(offset),
    getUint16BE: (offset) => view.getUint16(offset),
    getUint32BE: (offset) => view.getUint32(offset),
    copyTo: (destination, destinationOffset = 0) => destination.set(bytes, destinationOffset),
    copy: () => bytes.slice(),
  };
}

function rustConst(symbol: string): number {
  const match = new RegExp(`pub const ${symbol}: u8 = 1 << (\\d+);`).exec(RUST_WIRE_SOURCE);
  const fixed = new RegExp(`pub const ${symbol}: usize = (\\d+);`).exec(RUST_WIRE_SOURCE);
  if (match?.[1] !== undefined) return 1 << Number(match[1]);
  if (fixed?.[1] !== undefined) return Number(fixed[1]);
  throw new Error(`missing Rust constant ${symbol}`);
}

describe('display wire header mirror', () => {
  test('constants match merkur_codec::wire', () => {
    expect(VECTOR.version).toBe(DISPLAY_PROTOCOL_VERSION);
    expect(DISPLAY_WIRE_MAX_UNCHUNKED_HEADER_BYTES).toBe(VECTOR.maxUnchunkedHeaderBytes);
    expect(DISPLAY_WIRE_FIXED_HEADER_BYTES).toBe(rustConst('WIRE_FIXED_HEADER_BYTES'));
    expect(DISPLAY_WIRE_PRESENT_CLOSURE).toBe(rustConst('WIRE_PRESENT_CLOSURE'));
    expect(DISPLAY_WIRE_PRESENT_ECHO_HORIZON).toBe(rustConst('WIRE_PRESENT_ECHO_HORIZON'));
    expect(DISPLAY_WIRE_PRESENT_CHUNK).toBe(rustConst('WIRE_PRESENT_CHUNK'));
    expect(DISPLAY_WIRE_PRESENT_PREDECESSOR).toBe(rustConst('WIRE_PRESENT_PREDECESSOR'));
  });

  test('encodes every vector case byte for byte as the Rust encoder does', () => {
    expect(VECTOR.cases.length).toBeGreaterThan(0);
    for (const vector of VECTOR.cases) {
      expect(toHex(encodeDisplayWireFrame(fromHex(vector.staged)))).toBe(vector.wire);
    }
  });

  test('reads every vector case back to its identity', () => {
    for (const vector of VECTOR.cases) {
      expect(readDisplayWireIdentity(source(fromHex(vector.wire)))).toEqual({
        generation: vector.generation,
        seq: vector.seq,
        frameId: vector.frameId,
        chunkIndex: vector.chunkIndex,
        chunkCount: vector.chunkCount,
      });
    }
  });

  test('refuses another version and a truncated header', () => {
    const wire = fromHex(VECTOR.cases[0]?.wire ?? '');
    const other = wire.slice();
    other[1] = DISPLAY_PROTOCOL_VERSION - 1;
    expect(readDisplayWireIdentity(source(other))).toBeNull();
    expect(
      readDisplayWireIdentity(source(wire.subarray(0, DISPLAY_WIRE_FIXED_HEADER_BYTES - 1))),
    ).toBeNull();
  });
});
