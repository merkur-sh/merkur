import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { decodeNativeTrace, NativeTraceDecodeError } from './mtrace';

/** The capture `merkur-trace`'s file test writes byte for byte. */
const FIXTURE = readFileSync(
  path.join(import.meta.dir, '../../merkur-trace/testdata/capture.mtrace'),
);

describe('decodeNativeTrace', () => {
  test('reads the pinned capture exactly', () => {
    const capture = decodeNativeTrace(FIXTURE);
    expect(capture).toEqual({
      owner: 7,
      peerId: 'peer-a',
      sessionId: 'session-12345678',
      observationEpoch: 3,
      dropped: 1,
      stale: 2,
      discontinuous: false,
      clock: 'mach-uptime-raw',
      originAnchorNs: 235_904_375_849_958n,
      clockErrorNs: 84,
      pid: 4_242,
      records: [
        {
          ordinal: 11,
          owner: 7,
          at_us: 1,
          kind: 'display_member',
          fields: [1, 2, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2 ** 53 - 1],
        },
        { ordinal: 12, owner: 7, at_us: 2, kind: 'quic_datagram', fields: Array(16).fill(0) },
      ],
      spans: [
        { thread: 1_001, name: 'display.flush', phase: 'begin', atNs: 1_000, arg: 0 },
        { thread: 1_001, name: 'display.flush', phase: 'end', atNs: 4_000, arg: 0 },
        { thread: 1_002, name: 'channel.hop', phase: 'mark', atNs: 2_500, arg: 640 },
      ],
    });
  });

  test('rejects a truncated capture, trailing bytes and a foreign file', () => {
    expect(() => decodeNativeTrace(FIXTURE.subarray(0, FIXTURE.length - 8))).toThrow(
      NativeTraceDecodeError,
    );
    const padded = new Uint8Array(FIXTURE.length + 8);
    padded.set(FIXTURE);
    expect(() => decodeNativeTrace(padded)).toThrow('trailing bytes');
    expect(() => decodeNativeTrace(new TextEncoder().encode('NOTTRACE'))).toThrow(
      'not a native trace capture',
    );
  });

  test('rejects an unsafe integer rather than rounding it', () => {
    const bytes = new Uint8Array(FIXTURE);
    // From the end: three 4-word spans and their count, one 19-word evidence record, then
    // the first record's last field.
    const lastField = bytes.length - (1 + 3 * 4) * 8 - 19 * 8 - 8;
    new DataView(bytes.buffer).setBigUint64(lastField, 2n ** 53n, true);
    expect(() => decodeNativeTrace(bytes)).toThrow('not a safe integer');
  });
});
