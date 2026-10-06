import { describe, expect, test } from 'bun:test';
import type { NativePerfTraceRecord } from '../../../packages/shared/src/native-perf-trace';
import type { ProxyRelayStatus } from '../../../scripts/edge-network-stats';
import { daemonLegPackets, proxyWindowCounts } from './relay-keystroke-packets';

function relay(
  admissionSeq: number,
  role: 'daemon' | 'browser',
  upSeen: number,
  downSeen: number,
  competitor = false,
): ProxyRelayStatus {
  return {
    admissionSeq,
    listener: { role, competitor },
    upstreamPort: 50_000 + admissionSeq,
    upSeen,
    downSeen,
    downDropped: 0,
    downReordered: 0,
    pending: 0,
    upMaxInFlight: 0,
    downMaxInFlight: 0,
    bottleneckDrops: 0,
  };
}

let ordinal = 0;
function datagram(
  phase: number,
  connection: number,
  packetPlusOne: number,
  channelPlusOne: number,
  tag = 0,
  atUs = 0,
) {
  ordinal += 1;
  const fields = new Array<number>(16).fill(0);
  fields[0] = phase;
  fields[1] = connection;
  fields[2] = packetPlusOne;
  fields[5] = tag;
  fields[9] = channelPlusOne;
  return {
    ordinal,
    owner: 1,
    at_us: atUs,
    kind: 'quic_datagram',
    fields,
  } satisfies NativePerfTraceRecord;
}

describe('relay keystroke packet census', () => {
  test('proxy relays sum per role and a competing flow is not counted', () => {
    const counts = proxyWindowCounts({
      relays: [
        relay(1, 'daemon', 10, 4),
        relay(2, 'browser', 7, 12),
        relay(3, 'browser', 1, 2),
        relay(4, 'browser', 900, 900, true),
      ],
    });
    expect(counts.daemon).toEqual({ up: 10, down: 4 });
    expect(counts.browser).toEqual({ up: 8, down: 14 });
    expect(counts.relays.map((entry) => entry.admissionSeq)).toEqual([1, 2, 3]);
  });

  test('daemon datagrams group by connection and packet, and only packetized records count', () => {
    const pty = 0x01 + 1;
    const ctrl = 0x02 + 1;
    const display = 0x03 + 1;
    const summary = daemonLegPackets([
      // An input ACK and the header-only frame built into one packet.
      datagram(0, 1, 0, pty),
      datagram(1, 1, 8, pty),
      datagram(1, 1, 8, display),
      // A pong alone, then an ACK alone on the next packet.
      datagram(1, 1, 9, ctrl),
      datagram(1, 1, 10, pty),
      // The same packet number on another connection is another packet.
      datagram(1, 2, 8, display),
      // Acknowledgement and loss outcomes are not packet construction.
      datagram(2, 1, 8, pty),
      datagram(3, 1, 10, pty),
    ]);
    expect(summary.packets).toBe(4);
    expect(summary.datagrams).toBe(5);
    expect(summary.compositions).toEqual({
      'displayDatagram+pty': 1,
      ctrl: 1,
      pty: 1,
      displayDatagram: 1,
    });
    expect(summary.inputAckDatagrams).toBe(2);
    expect(summary.inputAckWithDisplay).toBe(1);
  });

  test("an input ACK's residence pairs its queued and packetized records by connection and tag", () => {
    const pty = 0x01 + 1;
    const display = 0x03 + 1;
    const summary = daemonLegPackets([
      datagram(0, 1, 0, pty, 11, 100),
      datagram(0, 1, 0, display, 12, 105),
      // The same tag on another connection is another datagram.
      datagram(0, 2, 0, pty, 11, 500),
      datagram(1, 1, 8, pty, 11, 140),
      datagram(1, 1, 8, display, 12, 140),
      datagram(0, 1, 0, pty, 13, 1_000),
      datagram(1, 1, 9, pty, 13, 1_010),
      // Packetized with no queued record in the capture: counted, not timed.
      datagram(1, 1, 10, pty, 14, 2_000),
    ]);
    expect(summary.inputAckDatagrams).toBe(3);
    expect(summary.inputAckQueuedToPacketizedUs).toEqual({ count: 2, p50: 10, p95: 40, max: 40 });
    expect(daemonLegPackets([]).inputAckQueuedToPacketizedUs).toBeNull();
  });
});
