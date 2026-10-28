// The frames the profile-guided terminal trains on (`//tools/bazel/wasm/term-wasm:profile`),
// written as one stream for `term-wasm-pgo.ts` to replay:
//
//   term-wasm-pgo-stream.ts <display-fixture> <stream out>
//
// The stream is its own build output, so a `display-fixture` rebuild that codes the same MZ
// bytes leaves it, and the training and every profile-guided crate after it, unchanged.

import { writeFileSync } from 'node:fs';
import { writeU32BE } from '../packages/shared/src/binary';
import {
  DISPLAY_COMPRESSED_LENGTH_OFFSET,
  DISPLAY_COMPRESSED_PAYLOAD_OFFSET,
  DISPLAY_DATAGRAM_HEADER_BODY_LENGTH_OFFSET,
  DISPLAY_HEADER_FLAG_COMPRESSED_MZ,
  DISPLAY_PATCH_FLAGS_OFFSET,
  DISPLAY_ROWS_OFFSET,
  DISPLAY_SEQUENCE_OFFSET,
  DISPLAY_STREAM_HEADER_BYTES,
} from '../packages/shared/src/display-stream';
import { ingressFixture } from './term-wasm-ingress-fixture';

const COLS = 120;

const [displayFixture, output] = process.argv.slice(2);
if (displayFixture === undefined || output === undefined)
  throw new Error('usage: term-wasm-pgo-stream.ts <display-fixture> <stream>');
writeFileSync(output, trainingStream(displayFixture));

/**
 * The ingress benchmark's frames (plain and styled rows, 1 to 256 dirty rows, eight
 * content phases), each followed by its `display-fixture`-coded MZ twin, behind one
 * snapshot per grid height. Each frame is a record: its byte length (u32), columns and
 * rows (u16 each, little-endian) and a snapshot flag (u8), then the frame.
 */
function trainingStream(displayFixture: string): Uint8Array {
  const parts: Uint8Array[] = [];
  const push = (frame: Uint8Array, rows: number, snapshot: boolean) => {
    const record = new Uint8Array(9);
    const view = new DataView(record.buffer);
    view.setUint32(0, frame.byteLength, true);
    view.setUint16(4, COLS, true);
    view.setUint16(6, rows, true);
    record[8] = snapshot ? 1 : 0;
    parts.push(record, frame);
  };
  for (const rows of [36, 256]) {
    const snapshot = ingressFixture(COLS, rows, Math.min(rows, 36), 0, false);
    snapshot[DISPLAY_PATCH_FLAGS_OFFSET] = 1;
    push(snapshot, rows, true);
    for (const styled of [false, true]) {
      for (const dirty of rows === 36 ? [1, 8, 36] : [64, 256]) {
        for (let phase = 0; phase < 8; phase++) {
          const frame = ingressFixture(COLS, rows, dirty, phase, styled, 0, phase);
          writeU32BE(frame, DISPLAY_SEQUENCE_OFFSET, 1);
          push(frame, rows, false);
          push(compressed(displayFixture, frame), rows, false);
        }
      }
    }
  }
  const stream = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    stream.set(part, offset);
    offset += part.byteLength;
  }
  return stream;
}

/** The same frame with its row region MZ-coded, as the daemon sends it. */
function compressed(displayFixture: string, frame: Uint8Array): Uint8Array {
  const rows = frame.subarray(DISPLAY_ROWS_OFFSET);
  const result = Bun.spawnSync([displayFixture], {
    stdin: rows,
    stdout: 'pipe',
    stderr: 'inherit',
  });
  if (result.exitCode !== 0) throw new Error('display-fixture failed');
  const payload = new Uint8Array(result.stdout);
  const wire = new Uint8Array(DISPLAY_COMPRESSED_PAYLOAD_OFFSET + payload.byteLength);
  wire.set(frame.subarray(0, DISPLAY_ROWS_OFFSET));
  wire[1] = (wire[1] ?? 0) | DISPLAY_HEADER_FLAG_COMPRESSED_MZ;
  writeU32BE(
    wire,
    DISPLAY_DATAGRAM_HEADER_BODY_LENGTH_OFFSET,
    wire.byteLength - DISPLAY_STREAM_HEADER_BYTES,
  );
  writeU32BE(wire, DISPLAY_COMPRESSED_LENGTH_OFFSET, rows.byteLength);
  wire.set(payload, DISPLAY_COMPRESSED_PAYLOAD_OFFSET);
  return wire;
}
