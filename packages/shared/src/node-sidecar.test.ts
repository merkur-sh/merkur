import { describe, expect, test } from 'bun:test';
import { PassThrough } from 'node:stream';

import {
  createSidecarFrame,
  createSidecarHeader,
  createSidecarProcessEnvironment,
  isSidecarInputWritable,
  MAX_SIDECAR_PAYLOAD_BYTES,
  processFramedSidecarChunk,
  SidecarFrameReader,
  SidecarPayloadTooLargeError,
  writeSidecarCommand,
} from './node-sidecar';

describe('sidecar process logging', () => {
  test('uses a bounded service default while preserving an explicit operator filter', () => {
    expect(createSidecarProcessEnvironment('warn,merkur_dataplane=info', {})).toEqual({
      RUST_LOG: 'warn,merkur_dataplane=info',
    });
    expect(
      createSidecarProcessEnvironment('warn,merkur_dataplane=info', {
        RUST_LOG: 'trace',
        SENTINEL: 'preserved',
      }),
    ).toEqual({
      RUST_LOG: 'trace',
      SENTINEL: 'preserved',
    });
  });
});

describe('sidecar payload cap', () => {
  test('cap equals the Rust dataplane MAX_PAYLOAD_BYTES (512 KiB)', () => {
    expect(MAX_SIDECAR_PAYLOAD_BYTES).toBe(512 * 1024);
  });

  test('writeSidecarCommand throws before writing when the payload exceeds the cap', () => {
    const stream = new PassThrough();
    let written = 0;
    stream.on('data', (chunk: Buffer) => {
      written += chunk.byteLength;
    });

    // A payload whose UTF-8 JSON encoding blows past the cap.
    const oversized = { blob: 'x'.repeat(MAX_SIDECAR_PAYLOAD_BYTES + 1) };

    expect(() => writeSidecarCommand(stream, 0x01, oversized)).toThrow(SidecarPayloadTooLargeError);
    // Nothing may reach the stream — a half-written frame would desync framing.
    expect(written).toBe(0);
  });

  test('writeSidecarCommand writes a framed command within the cap', () => {
    const stream = new PassThrough();
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });

    writeSidecarCommand(stream, 0x07, { hello: 'world' });

    expect(chunks).toHaveLength(1);
    const flat = Buffer.concat(chunks);
    expect(flat[0]).toBe(0x07);
    const payloadLen =
      ((flat[1] ?? 0) << 24) | ((flat[2] ?? 0) << 16) | ((flat[3] ?? 0) << 8) | (flat[4] ?? 0);
    expect(payloadLen).toBe(flat.byteLength - 5);
  });

  test('writeSidecarCommand sizes multibyte JSON exactly', () => {
    const stream = new PassThrough();
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });

    const payload = { text: 'Zażółć 🐙' };
    writeSidecarCommand(stream, 0x07, payload);

    const frames: Array<{ kind: number; payload: Uint8Array }> = [];
    const reader = new SidecarFrameReader();
    reader.push(Buffer.concat(chunks));
    reader.processFrames((kind, framePayload) => {
      frames.push({ kind, payload: framePayload });
    });
    expect(frames).toHaveLength(1);
    expect(frames[0]?.kind).toBe(0x07);
    expect(JSON.parse(new TextDecoder().decode(frames[0]?.payload))).toEqual(payload);
  });

  test('rejects a missing, destroyed, or ended sidecar stdin', () => {
    expect(isSidecarInputWritable(null)).toBe(false);

    const destroyed = new PassThrough();
    destroyed.destroy();
    expect(isSidecarInputWritable({ stdin: destroyed })).toBe(false);

    const ended = new PassThrough();
    ended.end();
    expect(isSidecarInputWritable({ stdin: ended })).toBe(false);
  });

  test('accepts a live sidecar stdin that still takes writes', () => {
    const stream = new PassThrough();
    let written = 0;
    stream.on('data', (chunk: Buffer) => {
      written += chunk.byteLength;
    });

    expect(isSidecarInputWritable({ stdin: stream })).toBe(true);
    writeSidecarCommand(stream, 0x01, { ready: true });
    expect(written).toBeGreaterThan(5);
  });
});

describe('SidecarFrameReader', () => {
  test('parses a well-formed frame', () => {
    const reader = new SidecarFrameReader();
    const payload = new Uint8Array([1, 2, 3]);
    reader.push(createSidecarHeader(0x09, payload.byteLength));
    reader.push(payload);

    const frames: Array<{ kind: number; payload: Uint8Array }> = [];
    reader.processFrames((kind, framePayload) => {
      frames.push({ kind, payload: framePayload });
    });

    expect(frames).toHaveLength(1);
    expect(frames[0]?.kind).toBe(0x09);
    expect(Array.from(frames[0]?.payload ?? [])).toEqual([1, 2, 3]);
  });

  test('preserves order across a deeply fragmented compacted queue', () => {
    const reader = new SidecarFrameReader();
    const expected = Array.from({ length: 256 }, (_, index) => index & 0xff);
    for (const value of expected) {
      const frame = createSidecarFrame(0x09, Uint8Array.of(value));
      for (const byte of frame) reader.push(Uint8Array.of(byte));
    }

    const actual: number[] = [];
    reader.processFrames((kind, payload) => {
      expect(kind).toBe(0x09);
      actual.push(payload[0] ?? -1);
    });

    expect(actual).toEqual(expected);
  });

  test('rejects a bogus oversized declared length instead of buffering unboundedly', () => {
    const reader = new SidecarFrameReader();
    // Header declaring a 1 GiB payload — a stale/corrupt dataplane symptom.
    reader.push(createSidecarHeader(0x01, MAX_SIDECAR_PAYLOAD_BYTES + 1));
    // Enough trailing bytes to clear the header, but not the fabricated length.
    reader.push(new Uint8Array(8));

    expect(() =>
      reader.processFrames(() => {
        throw new Error('handler must not run for an oversized frame');
      }),
    ).toThrow(SidecarPayloadTooLargeError);
  });

  test('routes malformed framed output to supervision and clears the poisoned prefix', () => {
    const reader = new SidecarFrameReader();
    const errors: unknown[] = [];

    processFramedSidecarChunk(
      reader,
      createSidecarHeader(0x01, MAX_SIDECAR_PAYLOAD_BYTES + 1),
      () => {
        throw new Error('handler must not run for an oversized frame');
      },
      (error) => {
        errors.push(error);
      },
    );

    const frames: number[] = [];
    processFramedSidecarChunk(
      reader,
      createSidecarHeader(0x09),
      (kind) => {
        frames.push(kind);
      },
      (error) => {
        errors.push(error);
      },
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(SidecarPayloadTooLargeError);
    expect(frames).toEqual([0x09]);
  });
});
