import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  DISPLAY_BASE_SEQ_OFFSET,
  DISPLAY_CHUNK_COUNT_OFFSET,
  DISPLAY_CHUNK_INDEX_OFFSET,
  DISPLAY_CLOSURE_DIGEST_OFFSET,
  DISPLAY_COLUMNS_OFFSET,
  DISPLAY_DATAGRAM_HEADER_BODY_LENGTH_OFFSET,
  DISPLAY_DATAGRAM_HEADER_FLAGS_OFFSET,
  DISPLAY_DEMAND_SERIAL_OFFSET,
  DISPLAY_DICT_COMPRESSED_PAYLOAD_OFFSET,
  DISPLAY_ECHO_HORIZON_OFFSET,
  DISPLAY_FEC_HEADER_BYTES,
  DISPLAY_FEC_MAX_DATA_SHARDS,
  DISPLAY_FEC_MAX_RECOVERY_SHARDS,
  DISPLAY_FRAME_ID_OFFSET,
  DISPLAY_GENERATION_OFFSET,
  DISPLAY_GRID_ROWS_OFFSET,
  DISPLAY_HEADER_FLAG_COMPRESSED_ZSTD,
  DISPLAY_HEADER_FLAG_COMPRESSED_ZSTD_DICT,
  DISPLAY_HEADER_FLAG_FEC_PROTECTED,
  DISPLAY_MESSAGE_TYPE_OFFSET,
  DISPLAY_PATCH_BODY_HEADER_BYTES,
  DISPLAY_PATCH_FLAG_DEMAND_AWAITS_GRANT,
  DISPLAY_PATCH_FLAG_DEMAND_LIMITED,
  DISPLAY_PATCH_FLAG_DEMAND_PROMPT,
  DISPLAY_PATCH_FLAG_MEMORY_ONLY,
  DISPLAY_PATCH_FLAG_PRESENTATION_COHERENT,
  DISPLAY_PATCH_FLAG_PRESENTATION_END,
  DISPLAY_PATCH_FLAG_RESET,
  DISPLAY_PATCH_FLAGS_OFFSET,
  DISPLAY_PRESENTATION_ID_OFFSET,
  DISPLAY_PRESENTATION_MEMBER_COUNT_OFFSET,
  DISPLAY_PRESENTATION_MEMBER_INDEX_OFFSET,
  DISPLAY_PROTOCOL_VERSION,
  DISPLAY_ROW_CELL_COUNT_MASK,
  DISPLAY_ROW_COUNT_OFFSET,
  DISPLAY_ROW_FLAG_WRAPPED,
  DISPLAY_ROW_PREDECESSOR_PRESENTATION_ID_OFFSET,
  DISPLAY_ROW_PREFIX_BYTES,
  DISPLAY_ROWS_OFFSET,
  DISPLAY_SCROLL_SERIAL_OFFSET,
  DISPLAY_SEQUENCE_OFFSET,
  DISPLAY_STREAM_HEADER_BYTES,
  DISPLAY_VERSION_OFFSET,
  MAX_DISPLAY_FRAME_BYTES,
  MESSAGE_TYPE_DISPLAY_FEC_REPAIR,
  MESSAGE_TYPE_DISPLAY_PATCH,
} from './display-stream';

// The codec's constants are split across its modules, so the authority is the
// concatenation rather than any one file. `stream.rs` owns the datagram header
// offsets; `lib.rs` owns the body layout and message types.
const RUST_CODEC_SOURCE = [
  readFileSync(fileURLToPath(new URL('../../merkur-codec/src/lib.rs', import.meta.url)), 'utf8'),
  readFileSync(fileURLToPath(new URL('../../merkur-codec/src/stream.rs', import.meta.url)), 'utf8'),
].join('\n');
const RUST_ENCODER_SOURCE = readFileSync(
  fileURLToPath(new URL('../../../apps/daemon/dataplane/src/display/encoder.rs', import.meta.url)),
  'utf8',
);
const RUST_COMPRESSOR_SOURCE = readFileSync(
  fileURLToPath(
    new URL('../../../apps/daemon/dataplane/src/display/compressor.rs', import.meta.url),
  ),
  'utf8',
);
const RUST_FEC_SOURCE = readFileSync(
  fileURLToPath(new URL('../../../apps/daemon/dataplane/src/display/fec.rs', import.meta.url)),
  'utf8',
);
const RUST_POLICY_SOURCE = readFileSync(
  fileURLToPath(new URL('../../../apps/daemon/dataplane/src/display/policy.rs', import.meta.url)),
  'utf8',
);
const RUST_DATAPLANE_SOURCE = readFileSync(
  fileURLToPath(new URL('../../../apps/daemon/dataplane/src/main.rs', import.meta.url)),
  'utf8',
);

describe('display stream wire conformance', () => {
  test('layout matches the live merkur-codec Rust authority', () => {
    expect(DISPLAY_PROTOCOL_VERSION).toBe(readRustConst('VERSION'));
    expect(DISPLAY_PATCH_FLAG_MEMORY_ONLY).toBe(readRustConst('PATCH_FLAG_MEMORY_ONLY'));
    expect(DISPLAY_STREAM_HEADER_BYTES).toBe(readRustConst('STREAM_HEADER_BYTES'));
    expect(MAX_DISPLAY_FRAME_BYTES).toBe(readRustConst('MAX_DISPLAY_FRAME_BYTES'));
    expect(DISPLAY_PATCH_BODY_HEADER_BYTES).toBe(readRustConst('FRAME_HEADER_BODY_BYTES'));
    expect(DISPLAY_ROW_PREFIX_BYTES).toBe(readRustConst('ROW_PREFIX_BYTES'));
    expect(DISPLAY_ROW_CELL_COUNT_MASK).toBe(readRustConst('ROW_CELL_COUNT_MASK'));
    expect(DISPLAY_ROW_FLAG_WRAPPED).toBe(readRustConst('ROW_FLAG_WRAPPED'));
    expect(DISPLAY_DATAGRAM_HEADER_FLAGS_OFFSET).toBe(readRustConst('DISPLAY_HEADER_FLAGS_OFFSET'));
    expect(DISPLAY_DATAGRAM_HEADER_BODY_LENGTH_OFFSET).toBe(
      readRustConst('DISPLAY_HEADER_BODY_LENGTH_OFFSET'),
    );
    expect(DISPLAY_MESSAGE_TYPE_OFFSET).toBe(readRustConst('DISPLAY_MSG_TYPE_OFFSET'));
    expect(DISPLAY_SEQUENCE_OFFSET).toBe(readRustConst('DISPLAY_SEQ_OFFSET'));
    expect(DISPLAY_GENERATION_OFFSET).toBe(readRustConst('DISPLAY_GENERATION_OFFSET'));
    expect(DISPLAY_VERSION_OFFSET).toBe(readRustConst('DISPLAY_VERSION_OFFSET'));
    expect(DISPLAY_HEADER_FLAG_COMPRESSED_ZSTD).toBe(
      readRustConst('DISPLAY_HEADER_FLAG_COMPRESSED_ZSTD'),
    );
    expect(DISPLAY_HEADER_FLAG_FEC_PROTECTED).toBe(
      readRustConst('DISPLAY_HEADER_FLAG_FEC_PROTECTED'),
    );
    expect(DISPLAY_HEADER_FLAG_COMPRESSED_ZSTD_DICT).toBe(
      readRustConst('DISPLAY_HEADER_FLAG_COMPRESSED_ZSTD_DICT'),
    );
    expect(DISPLAY_DICT_COMPRESSED_PAYLOAD_OFFSET).toBe(
      readRustConst('DISPLAY_DICT_COMPRESSED_PAYLOAD_OFFSET'),
    );
    expect(DISPLAY_FEC_HEADER_BYTES).toBe(readRustConst('DISPLAY_FEC_HEADER_BYTES'));
    expect(DISPLAY_FEC_MAX_DATA_SHARDS).toBe(
      readRustNumericConst(RUST_POLICY_SOURCE, 'FEC_GROUP_MAX_SIZE'),
    );
    expect(DISPLAY_FEC_MAX_RECOVERY_SHARDS).toBe(
      readRustNumericConst(RUST_POLICY_SOURCE, 'FEC_RECOVERY_SHARD_COUNT'),
    );
    expect(MESSAGE_TYPE_DISPLAY_PATCH).toBe(readRustConst('MSG_TYPE_DISPLAY_PATCH'));
    expect(MESSAGE_TYPE_DISPLAY_FEC_REPAIR).toBe(readRustConst('MSG_TYPE_DISPLAY_FEC_REPAIR'));
    // Pinned against Rust rather than against literals. These four offsets used
    // to live privately in the daemon encoder, so asserting them against
    // repeated arithmetic here only proved this file agreed with itself.
    expect(DISPLAY_FRAME_ID_OFFSET).toBe(readRustConst('DISPLAY_FRAME_ID_OFFSET'));
    expect(DISPLAY_COLUMNS_OFFSET).toBe(DISPLAY_PATCH_FLAGS_OFFSET + 1);
    expect(DISPLAY_GRID_ROWS_OFFSET).toBe(DISPLAY_COLUMNS_OFFSET + 2);
    expect(DISPLAY_PRESENTATION_ID_OFFSET).toBe(readRustConst('DISPLAY_PRESENTATION_ID_OFFSET'));
    expect(DISPLAY_PRESENTATION_MEMBER_INDEX_OFFSET).toBe(
      readRustConst('DISPLAY_PRESENTATION_MEMBER_INDEX_OFFSET'),
    );
    expect(DISPLAY_PRESENTATION_MEMBER_COUNT_OFFSET).toBe(
      readRustConst('DISPLAY_PRESENTATION_MEMBER_COUNT_OFFSET'),
    );
    expect(DISPLAY_ROW_PREDECESSOR_PRESENTATION_ID_OFFSET).toBe(
      readRustConst('DISPLAY_ROW_PREDECESSOR_PRESENTATION_ID_OFFSET'),
    );
    expect(DISPLAY_CHUNK_INDEX_OFFSET).toBe(readRustConst('DISPLAY_CHUNK_INDEX_OFFSET'));
    expect(DISPLAY_CHUNK_COUNT_OFFSET).toBe(readRustConst('DISPLAY_CHUNK_COUNT_OFFSET'));
    expect(DISPLAY_ROW_COUNT_OFFSET).toBe(readRustConst('DISPLAY_ROW_COUNT_OFFSET'));
    expect(DISPLAY_BASE_SEQ_OFFSET).toBe(readRustConst('DISPLAY_BASE_SEQ_OFFSET'));
    expect(DISPLAY_PATCH_FLAG_RESET).toBe(readRustConst('PATCH_FLAG_RESET'));
    expect(DISPLAY_PATCH_FLAG_PRESENTATION_COHERENT).toBe(
      readRustConst('PATCH_FLAG_PRESENTATION_COHERENT'),
    );
    expect(DISPLAY_PATCH_FLAG_PRESENTATION_END).toBe(readRustConst('PATCH_FLAG_PRESENTATION_END'));
    expect(DISPLAY_PATCH_FLAG_DEMAND_LIMITED).toBe(readRustConst('PATCH_FLAG_DEMAND_LIMITED'));
    expect(DISPLAY_PATCH_FLAG_DEMAND_PROMPT).toBe(readRustConst('PATCH_FLAG_DEMAND_PROMPT'));
    expect(DISPLAY_PATCH_FLAG_DEMAND_AWAITS_GRANT).toBe(
      readRustConst('PATCH_FLAG_DEMAND_AWAITS_GRANT'),
    );
    expect(DISPLAY_DEMAND_SERIAL_OFFSET).toBe(readRustConst('DISPLAY_DEMAND_SERIAL_OFFSET'));
    expect(DISPLAY_CLOSURE_DIGEST_OFFSET).toBe(readRustConst('DISPLAY_CLOSURE_DIGEST_OFFSET'));
    expect(DISPLAY_SCROLL_SERIAL_OFFSET).toBe(readRustConst('DISPLAY_SCROLL_SERIAL_OFFSET'));
    expect(DISPLAY_ECHO_HORIZON_OFFSET).toBe(readRustConst('DISPLAY_ECHO_HORIZON_OFFSET'));
    expect(DISPLAY_ROWS_OFFSET).toBe(DISPLAY_STREAM_HEADER_BYTES + DISPLAY_PATCH_BODY_HEADER_BYTES);
  });

  test('the patch body header ends with the scroll serial and then the echo horizon', () => {
    expect(DISPLAY_PROTOCOL_VERSION).toBe(32);
    expect(DISPLAY_PATCH_BODY_HEADER_BYTES).toBe(55);
    expect(DISPLAY_DEMAND_SERIAL_OFFSET).toBe(DISPLAY_ROW_PREDECESSOR_PRESENTATION_ID_OFFSET + 4);
    expect(DISPLAY_CLOSURE_DIGEST_OFFSET).toBe(DISPLAY_DEMAND_SERIAL_OFFSET + 4);
    expect(DISPLAY_SCROLL_SERIAL_OFFSET).toBe(DISPLAY_CLOSURE_DIGEST_OFFSET + 8);
    expect(DISPLAY_ECHO_HORIZON_OFFSET).toBe(DISPLAY_SCROLL_SERIAL_OFFSET + 4);
    expect(DISPLAY_ECHO_HORIZON_OFFSET + 4).toBe(DISPLAY_ROWS_OFFSET);
    expect(DISPLAY_PATCH_FLAG_DEMAND_LIMITED).toBe(1 << 4);
    expect(DISPLAY_PATCH_FLAG_DEMAND_PROMPT).toBe(1 << 5);
    expect(DISPLAY_PATCH_FLAG_DEMAND_AWAITS_GRANT).toBe(1 << 7);
  });

  test('daemon encoder and compressor import the codec authority', () => {
    expect(RUST_ENCODER_SOURCE).not.toMatch(/const\s+MSG_TYPE_DISPLAY_PATCH/);
    expect(RUST_COMPRESSOR_SOURCE).not.toMatch(
      /const\s+(?:STREAM_HEADER_BYTES|MSG_TYPE_DISPLAY_PATCH|DISPLAY_HEADER_FLAG_COMPRESSED_ZSTD)/,
    );
    expect(RUST_FEC_SOURCE).not.toMatch(/const\s+FEC_HEADER_BYTES/);
    expect(RUST_DATAPLANE_SOURCE).not.toMatch(/const\s+DISPLAY_HEADER_FLAG_FEC_PROTECTED/);
  });
});

function readRustConst(symbol: string): number {
  const match = new RegExp(`pub\\s+const\\s+${symbol}\\s*:\\s*[^=]+\\s*=\\s*([^;]+)\\s*;`).exec(
    RUST_CODEC_SOURCE,
  );
  if (match?.[1] === undefined) throw new Error(`missing Rust constant ${symbol}`);
  return evaluateRustConstExpression(match[1].trim());
}

function evaluateRustConstExpression(expression: string): number {
  const numeric = /^(?:0x[0-9A-Fa-f_]+|[0-9_]+)$/.exec(expression);
  if (numeric !== null) return Number(expression.replaceAll('_', ''));

  const identifier = /^([A-Z][A-Z0-9_]*)$/.exec(expression);
  if (identifier?.[1] !== undefined) return readRustConst(identifier[1]);

  // Either operand may itself be a constant, so recurse rather than requiring
  // the right-hand side to be a literal.
  const add = /^([A-Z][A-Z0-9_]*|[0-9_]+)\s*\+\s*(.+)$/.exec(expression);
  if (add?.[1] !== undefined && add[2] !== undefined) {
    return evaluateRustConstExpression(add[1].trim()) + evaluateRustConstExpression(add[2].trim());
  }

  const shift = /^([0-9_]+)\s*<<\s*([0-9_]+)$/.exec(expression);
  if (shift?.[1] !== undefined && shift[2] !== undefined) {
    return Number(shift[1].replaceAll('_', '')) << Number(shift[2].replaceAll('_', ''));
  }
  throw new Error(`unsupported Rust constant expression: ${expression}`);
}

function readRustNumericConst(source: string, symbol: string): number {
  const match = new RegExp(
    `pub\\s+const\\s+${symbol}\\s*:\\s*[^=]+\\s*=\\s*(0x[0-9A-Fa-f_]+|[0-9_]+)\\s*;`,
  ).exec(source);
  if (match?.[1] === undefined) throw new Error(`missing Rust constant ${symbol}`);
  return Number(match[1].replaceAll('_', ''));
}
