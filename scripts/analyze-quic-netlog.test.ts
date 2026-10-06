import { describe, expect, test } from 'bun:test';
import {
  DATAGRAM_LABELS,
  parseNetlogPackets,
  RECORD_LABELS,
  summarizeDirection,
  summarizeKeystrokeCycles,
  summarizeWindow,
} from './analyze-quic-netlog';

const TYPES = {
  QUIC_SESSION_PACKET_SENT: 2,
  QUIC_SESSION_PACKET_RECEIVED: 3,
  QUIC_SESSION_STREAM_FRAME_SENT: 4,
  QUIC_SESSION_STREAM_FRAME_RECEIVED: 5,
  QUIC_SESSION_MESSAGE_FRAME_SENT: 6,
  QUIC_SESSION_MESSAGE_FRAME_RECEIVED: 7,
  QUIC_SESSION_ACK_FRAME_SENT: 8,
  QUIC_SESSION_ACK_FRAME_RECEIVED: 9,
  QUIC_SESSION_PADDING_FRAME_SENT: 10,
} as const;

function netlog(events: readonly object[]): string {
  const constants = {
    logEventTypes: TYPES,
    logSourceType: { QUIC_SESSION: 13, WEB_TRANSPORT_CLIENT: 58 },
    timeTickOffset: '1000',
  };
  return [
    `{"constants":${JSON.stringify(constants)},`,
    '"events": [',
    ...events.map((event) => `${JSON.stringify(event)},`),
    // A run killed mid-write leaves a partial last line.
    '{"params":{"stream_',
  ].join('\n');
}

/** Source 8 is the browser's own QUIC session; every other source is a WebTransport client. */
const event = (
  type: keyof typeof TYPES,
  time: number,
  source: number,
  params: Record<string, unknown> = {},
) => ({
  params,
  phase: 0,
  source: { id: source, type: source === 8 ? 13 : 58 },
  time: String(time),
  type: TYPES[type],
});

const inputAck = [...DATAGRAM_LABELS].find(([, label]) => label === 'input_ack')?.[0];
const headerOnly = [...DATAGRAM_LABELS].find(([, label]) => label === 'header_only')?.[0];
const ackTwin = [...RECORD_LABELS].find(([, label]) => label === 'input_ack_twin')?.[0];

describe('QUIC net log packet composition', () => {
  test('fixed Merkur message sizes stay distinct', () => {
    expect(new Set(DATAGRAM_LABELS.values()).size).toBe(DATAGRAM_LABELS.size);
    expect(inputAck).toBe(34);
    expect(ackTwin).toBe(36);
  });

  test('sent frames join the next sent packet and read frames join their received packet', () => {
    const packets = parseNetlogPackets(
      netlog([
        // Up: a stream record and an ACK, then the packet that carried them.
        event('QUIC_SESSION_STREAM_FRAME_SENT', 5, 7, { stream_id: 18, length: 40 }),
        event('QUIC_SESSION_ACK_FRAME_SENT', 5, 7),
        event('QUIC_SESSION_PADDING_FRAME_SENT', 5, 7),
        event('QUIC_SESSION_PACKET_SENT', 5, 7, { packet_number: 3, size: 90 }),
        // Down: one packet with the input ACK and the header-only frame.
        event('QUIC_SESSION_PACKET_RECEIVED', 6, 7, { size: 180 }),
        event('QUIC_SESSION_ACK_FRAME_RECEIVED', 6, 7),
        event('QUIC_SESSION_MESSAGE_FRAME_RECEIVED', 6, 7, { message_length: inputAck }),
        event('QUIC_SESSION_MESSAGE_FRAME_RECEIVED', 6, 7, { message_length: headerOnly }),
        // Down: an ACK-only packet, then one on a QUIC session that is not WebTransport.
        event('QUIC_SESSION_PACKET_RECEIVED', 9, 7, { size: 40 }),
        event('QUIC_SESSION_ACK_FRAME_RECEIVED', 9, 7),
        event('QUIC_SESSION_PACKET_RECEIVED', 9, 8, { size: 40 }),
        event('QUIC_SESSION_ACK_FRAME_RECEIVED', 9, 8),
      ]),
    );
    expect(packets.map((packet) => [packet.direction, packet.atMs, packet.frames.length])).toEqual([
      ['up', 1005, 3],
      ['down', 1006, 3],
      ['down', 1009, 1],
    ]);

    const window = summarizeWindow(packets, {
      name: 'keys',
      keys: 1,
      startedAtMs: 1000,
      endedAtMs: 1010,
    });
    expect(window.up.signatures).toEqual([['ack+s18:ping_record', 1]]);
    expect(window.down.packets).toBe(2);
    expect(window.down.ackOnly).toBe(1);
    expect(window.down.signatures).toEqual([
      ['ack+header_only+input_ack', 1],
      ['ack', 1],
    ]);
  });

  test('a window includes its start and excludes its end', () => {
    const packet = (atMs: number) =>
      ({ session: 7, direction: 'up', atMs, frames: [{ kind: 'ACK' }] }) as const;
    const window = summarizeWindow([packet(999), packet(1000), packet(1009), packet(1010)], {
      name: 'idle',
      keys: 0,
      startedAtMs: 1000,
      endedAtMs: 1010,
    });
    expect(window.up.packets).toBe(2);
    expect(window.up.ackOnly).toBe(2);
    expect(summarizeDirection([])).toEqual({ packets: 0, ackOnly: 0, frames: {}, signatures: [] });
  });
});

describe('keystroke cycle attribution', () => {
  const displayAck = [...DATAGRAM_LABELS].find(([, label]) => label === 'display_ack')?.[0];
  const pong = [...DATAGRAM_LABELS].find(([, label]) => label === 'pong')?.[0];
  const up = (atMs: number, ...frames: object[]) => ({
    session: 1,
    direction: 'up' as const,
    atMs,
    frames: frames as { kind: string; length?: number }[],
  });
  const down = (atMs: number, ...frames: object[]) => ({
    ...up(atMs, ...frames),
    direction: 'down' as const,
  });
  const input = { kind: 'MESSAGE', length: 53 };
  const dack = { kind: 'MESSAGE', length: displayAck };
  const ack = { kind: 'ACK' };

  test('counts what lands after the display ACK and the lone ACKs it draws', () => {
    const cycles = summarizeKeystrokeCycles([
      // Key 1: the pong trails the display ACK and Chromium ACKs it alone.
      up(0, input),
      down(25, { kind: 'MESSAGE', length: inputAck }, { kind: 'MESSAGE', length: headerOnly }),
      up(26, ack, dack),
      down(27, { kind: 'MESSAGE', length: pong }),
      up(35, ack),
      // Key 2: the pong precedes the frame; the display ACK covers everything.
      up(167, input),
      down(191, { kind: 'MESSAGE', length: pong }),
      down(192, { kind: 'MESSAGE', length: inputAck }, { kind: 'MESSAGE', length: headerOnly }),
      up(193, ack, dack),
      // The next key closes key 2's cycle.
      up(334, input),
    ]);
    expect(cycles.keys).toBe(2);
    expect(cycles.loneAcksPerKey).toBe(0.5);
    expect(cycles.lateDownstreamPerKey).toBe(0.5);
    expect(cycles.lateLabels).toEqual([['pong', 0.5]]);
  });
});
