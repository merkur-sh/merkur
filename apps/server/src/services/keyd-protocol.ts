/**
 * The socket protocol to `merkur-keyd`, mirroring `apps/keyd/src/wire.rs`; the real-binary
 * test (`key-service.keyd.test.ts`) pins the two together.
 *
 * A frame is `u32le length || body`. A request body is `u8 op` and its fields, a response body
 * `u8 status` and its fields; a variable field is `u16le length || bytes`. Requests are
 * answered in order on their connection.
 */

export const MAX_FRAME_BYTES = 16 * 1024;

export const OP_PUBLIC_KEYS = 1;
export const OP_AUTH_START = 2;
export const OP_REGISTRATION_RESPONSE = 3;
export const OP_LOGIN_FINISH = 4;
export const OP_SIGN_CAPABILITY = 5;
export const OP_VAPID_JWT = 6;

export const STATUS_OK = 0;
export const STATUS_INVALID = 1;
export const STATUS_EXHAUSTED = 2;
export const STATUS_REFUSED = 3;
export const STATUS_UNAVAILABLE = 4;
// 5 is keyd failing internally; the client reads it, like any status it does not name, as that.

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder('utf-8', { fatal: true });

export type RequestField = Uint8Array;

/** A text field: its UTF-8 bytes, which keyd reads as `str`. */
export function textField(value: string): RequestField {
  return TEXT_ENCODER.encode(value);
}

/** One framed request. */
export function encodeRequest(op: number, encoded: readonly RequestField[]): Uint8Array {
  const bodyLength = 1 + encoded.reduce((total, field) => total + 2 + field.byteLength, 0);
  if (bodyLength > MAX_FRAME_BYTES) throw new RangeError('keyd request exceeds the frame bound');
  const frame = new Uint8Array(4 + bodyLength);
  const view = new DataView(frame.buffer);
  view.setUint32(0, bodyLength, true);
  frame[4] = op;
  let offset = 5;
  for (const field of encoded) {
    if (field.byteLength > 0xffff) throw new RangeError('keyd field exceeds a u16 length');
    view.setUint16(offset, field.byteLength, true);
    frame.set(field, offset + 2);
    offset += 2 + field.byteLength;
  }
  return frame;
}

/** A response body: its status, then its fields in order. */
export interface ResponseReader {
  readonly status: number;
  bytes(): Uint8Array;
  text(): string;
  u8(): number;
  u32(): number;
  u64(): number;
  /** Throws unless every byte was read. */
  end(): void;
}

export function readResponse(body: Uint8Array): ResponseReader {
  if (body.byteLength === 0) throw new RangeError('empty keyd response');
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  let offset = 1;
  const bytes = (): Uint8Array => {
    const length = view.getUint16(offset, true);
    const start = offset + 2;
    if (start + length > body.byteLength) throw new RangeError('truncated keyd field');
    offset = start + length;
    return body.slice(start, start + length);
  };
  return {
    status: body[0] ?? 0,
    bytes,
    text: () => TEXT_DECODER.decode(bytes()),
    u8: () => {
      const value = view.getUint8(offset);
      offset += 1;
      return value;
    },
    u32: () => {
      const value = view.getUint32(offset, true);
      offset += 4;
      return value;
    },
    u64: () => {
      const value = view.getBigUint64(offset, true);
      offset += 8;
      return Number(value);
    },
    end: () => {
      if (offset !== body.byteLength) throw new RangeError('trailing keyd response bytes');
    },
  };
}

/**
 * Splits complete frames off the front of `buffered`, returning their bodies and what is left.
 * A length past the bound means the stream is out of step and cannot be read further.
 */
export function takeFrames(buffered: Uint8Array) {
  const bodies: Uint8Array[] = [];
  let offset = 0;
  while (buffered.byteLength - offset >= 4) {
    const length = new DataView(buffered.buffer, buffered.byteOffset + offset, 4).getUint32(
      0,
      true,
    );
    if (length === 0 || length > MAX_FRAME_BYTES) throw new RangeError('keyd frame out of bounds');
    if (buffered.byteLength - offset - 4 < length) break;
    bodies.push(buffered.slice(offset + 4, offset + 4 + length));
    offset += 4 + length;
  }
  return { bodies, rest: buffered.slice(offset) };
}
