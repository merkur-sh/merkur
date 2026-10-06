import { describe, expect, test } from 'bun:test';
import {
  DISPLAY_CHUNK_COUNT_OFFSET,
  DISPLAY_DATAGRAM_HEADER_BODY_LENGTH_OFFSET,
  DISPLAY_FEC_HEADER_BYTES,
  DISPLAY_FRAME_ID_OFFSET,
  DISPLAY_GENERATION_OFFSET,
  DISPLAY_PATCH_BODY_HEADER_BYTES,
  DISPLAY_PATCH_FLAG_RESET,
  DISPLAY_PATCH_FLAGS_OFFSET,
  DISPLAY_PROTOCOL_VERSION,
  DISPLAY_SEQUENCE_OFFSET,
  DISPLAY_STREAM_HEADER_BYTES,
  DISPLAY_VERSION_OFFSET,
  MESSAGE_TYPE_DISPLAY_FEC_REPAIR,
  MESSAGE_TYPE_DISPLAY_PATCH,
  type SynchronousByteSource,
  type TransportKind,
  writeU32BE,
} from '@merkur/shared';
import { emitTransportBrowserDisplayIo } from './browser-display-ingress';
import { decodePerfEvent } from './perf-event-codec';
import { createPerfRingBuffer, createPerfRingReader, createPerfRingWriter } from './perf-ring';
import { createPerfStringResolver, createPerfStringTableBuffer } from './perf-string-table';
import type { BrowserDisplayIngressRoute, TerminalPerfEvent } from './terminal-latency';

function writeU16BE(target: Uint8Array, offset: number, value: number): void {
  target[offset] = (value >>> 8) & 0xff;
  target[offset + 1] = value & 0xff;
}

function displayFrame(snapshot: boolean): Uint8Array {
  const frame = new Uint8Array(DISPLAY_STREAM_HEADER_BYTES + DISPLAY_PATCH_BODY_HEADER_BYTES);
  frame[0] = MESSAGE_TYPE_DISPLAY_PATCH;
  writeU32BE(
    frame,
    DISPLAY_DATAGRAM_HEADER_BODY_LENGTH_OFFSET,
    frame.byteLength - DISPLAY_STREAM_HEADER_BYTES,
  );
  writeU32BE(frame, DISPLAY_SEQUENCE_OFFSET, 11);
  writeU32BE(frame, DISPLAY_GENERATION_OFFSET, 12);
  frame[DISPLAY_VERSION_OFFSET] = DISPLAY_PROTOCOL_VERSION;
  frame[DISPLAY_PATCH_FLAGS_OFFSET] = snapshot ? DISPLAY_PATCH_FLAG_RESET : 0;
  writeU32BE(frame, DISPLAY_FRAME_ID_OFFSET, 13);
  writeU16BE(frame, DISPLAY_CHUNK_COUNT_OFFSET, 1);
  return frame;
}

function fecRepair(): Uint8Array {
  const shardSize = 4;
  const repair = new Uint8Array(DISPLAY_FEC_HEADER_BYTES + shardSize);
  repair[0] = MESSAGE_TYPE_DISPLAY_FEC_REPAIR;
  writeU16BE(repair, 2, shardSize);
  writeU32BE(repair, 4, 21);
  repair[8] = 2;
  repair[9] = 1;
  writeU16BE(repair, 10, shardSize);
  writeU32BE(repair, 12, 22);
  return repair;
}

function revocableSource(bytes: Uint8Array): {
  readonly source: SynchronousByteSource;
  revoke(): void;
} {
  let active = true;
  const check = (): void => {
    if (!active) throw new Error('revoked');
  };
  return {
    source: {
      byteLength: bytes.byteLength,
      getUint8(offset): number {
        check();
        return bytes[offset] ?? 0;
      },
      getUint16BE(offset): number {
        check();
        return ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0);
      },
      getUint32BE(offset): number {
        check();
        return (
          ((bytes[offset] ?? 0) * 0x100_0000 +
            ((bytes[offset + 1] ?? 0) << 16) +
            ((bytes[offset + 2] ?? 0) << 8) +
            (bytes[offset + 3] ?? 0)) >>>
          0
        );
      },
      copyTo(): void {
        throw new Error('ingress accounting must not copy');
      },
      copy(): Uint8Array {
        throw new Error('ingress accounting must not copy');
      },
    },
    revoke(): void {
      active = false;
    },
  };
}

function emit(
  payload: Uint8Array,
  via: TransportKind,
  allowLarge: boolean,
  admitted = true,
): Extract<TerminalPerfEvent, { kind: 'browser_display_io' }> | null {
  const ring = createPerfRingBuffer(1);
  const writer = createPerfRingWriter(ring);
  const source = revocableSource(payload);
  expect(
    emitTransportBrowserDisplayIo(
      writer,
      1,
      source.source,
      via,
      allowLarge,
      admitted,
      1,
      payload.byteLength,
      0,
      0,
      0,
    ),
  ).toBe(true);
  source.revoke();
  const decoded: (TerminalPerfEvent | null)[] = [];
  createPerfRingReader(ring).drain((record) =>
    decoded.push(decodePerfEvent(record, createPerfStringResolver(createPerfStringTableBuffer()))),
  );
  const event = decoded[0];
  return event?.kind === 'browser_display_io' ? event : null;
}

const ROUTES = [
  ['webtransport', false, 'direct-datagram'],
  ['webtransport', true, 'direct-reliable'],
  ['edgeWebTransport', false, 'relay-datagram'],
  ['edgeWebTransport', true, 'relay-reliable'],
] as const satisfies readonly (readonly [TransportKind, boolean, BrowserDisplayIngressRoute])[];

describe('browser display ingress accounting producer', () => {
  test('retains exact callback ownership for deltas, snapshots, and FEC on every lane', () => {
    for (const payload of [displayFrame(false), displayFrame(true), fecRepair()]) {
      for (const [via, allowLarge, ingressRoute] of ROUTES) {
        expect(emit(payload, via, allowLarge)).toMatchObject({
          stage:
            payload[0] === MESSAGE_TYPE_DISPLAY_FEC_REPAIR
              ? 'transport_fec_ingress'
              : 'transport_ingress',
          ingressRoute,
          admitted: true,
          payloadByteLength: payload.byteLength,
        });
      }
    }
  });

  test('records the exact refused route and never retains or copies revoked plaintext', () => {
    expect(emit(displayFrame(true), 'edgeWebTransport', true, false)).toMatchObject({
      ingressRoute: 'relay-reliable',
      admitted: false,
    });
  });

  test('rejects malformed display and FEC payloads without publishing a record', () => {
    for (const payload of [
      Uint8Array.of(MESSAGE_TYPE_DISPLAY_PATCH),
      fecRepair().subarray(0, 15),
    ]) {
      const ring = createPerfRingBuffer(1);
      const writer = createPerfRingWriter(ring);
      const source = revocableSource(payload);
      expect(
        emitTransportBrowserDisplayIo(
          writer,
          1,
          source.source,
          'webtransport',
          false,
          true,
          0,
          0,
          0,
          0,
          0,
        ),
      ).toBe(false);
      expect(writer.writtenCount).toBe(0);
      source.revoke();
    }
  });
});
