import type { NativePerfTraceRecord } from '../../../packages/shared/src/native-perf-trace';
import { TRANSPORT_CHANNEL_ID } from '../../../packages/shared/src/transport';
import type { ProxyImpairmentStats } from '../../../scripts/edge-network-stats';

/**
 * Packet census for a relay-pinned typing session: how many QUIC packets cross
 * each leg per keystroke, and which datagrams the daemon already packs together.
 *
 * Two sources, each exact for its own leg. The delay proxy counts every UDP
 * packet it forwards for each relay (one relay is one QUIC connection), so it
 * gives packet totals for the browser and daemon legs without touching either
 * endpoint. The daemon's native trace records the QUIC packet number every
 * datagram it sends was built into, with its Merkur channel, so it shows which
 * datagrams shared a packet on the daemon-to-edge leg. The browser leg's packet
 * composition comes from Chromium's net log (`scripts/analyze-quic-netlog.ts`).
 */

export const RELAY_PACKETS_REPORT_SCHEMA = 1;

interface RelayPacketCounts {
  readonly up: number;
  readonly down: number;
}

interface RelayWindowRelay extends RelayPacketCounts {
  readonly admissionSeq: number;
  readonly role: 'daemon' | 'browser';
  readonly upstreamPort: number;
}

export interface RelayPacketWindow {
  readonly name: string;
  readonly keys: number;
  /** Wall-clock `Date.now()`, the clock Chromium's net log converts to. */
  readonly startedAtMs: number;
  readonly endedAtMs: number;
  readonly browser: RelayPacketCounts;
  readonly daemon: RelayPacketCounts;
  readonly relays: readonly RelayWindowRelay[];
}

/** Packets each live relay forwarded since the proxy's last reset. */
export function proxyWindowCounts(
  stats: Pick<ProxyImpairmentStats, 'relays'>,
): Pick<RelayPacketWindow, 'browser' | 'daemon' | 'relays'> {
  const relays = stats.relays
    .filter((relay) => !relay.listener.competitor)
    .map((relay) => ({
      admissionSeq: relay.admissionSeq,
      role: relay.listener.role,
      upstreamPort: relay.upstreamPort,
      up: relay.upSeen,
      down: relay.downSeen,
    }));
  const sum = (role: 'daemon' | 'browser'): RelayPacketCounts =>
    relays
      .filter((relay) => relay.role === role)
      .reduce((total, relay) => ({ up: total.up + relay.up, down: total.down + relay.down }), {
        up: 0,
        down: 0,
      });
  return { browser: sum('browser'), daemon: sum('daemon'), relays };
}

const CHANNEL_NAMES = new Map<number, string>(
  Object.entries(TRANSPORT_CHANNEL_ID).map(([name, id]) => [id, name]),
);

export interface DaemonLegPackets {
  /** Distinct `connection:packet` pairs that carried at least one datagram. */
  readonly packets: number;
  readonly datagrams: number;
  /** Sorted channel names of one packet's datagrams, joined by `+`, to packet count. */
  readonly compositions: Readonly<Record<string, number>>;
  /** Datagrams on the pty channel: the daemon sends only input ACKs there. */
  readonly inputAckDatagrams: number;
  /** Of those, the ones whose packet also carried a display datagram. */
  readonly inputAckWithDisplay: number;
  /**
   * Microseconds from each input ACK's queue admission to its packet's
   * construction, nearest rank; null when no ACK's two records were captured.
   */
  readonly inputAckQueuedToPacketizedUs: {
    readonly count: number;
    readonly p50: number;
    readonly p95: number;
    readonly max: number;
  } | null;
}

/**
 * Group the daemon's packetized datagrams by the QUIC packet they were built
 * into. `quic_datagram` fields: 0 phase (0 = queued, 1 = packetized),
 * 1 connection, 2 packet+1, 5-8 the sealed AEAD tag, 9 channel+1 (zero when the
 * payload was too short to name one). A datagram's queued and packetized
 * records share its connection and tag.
 */
export function daemonLegPackets(records: readonly NativePerfTraceRecord[]): DaemonLegPackets {
  const packets = new Map<string, number[]>();
  const ackQueuedAt = new Map<string, number>();
  const ackResidenceUs: number[] = [];
  let datagrams = 0;
  for (const record of records) {
    if (record.kind !== 'quic_datagram') continue;
    const phase = record.fields[0];
    const identity = `${record.fields[1] ?? 0}:${record.fields.slice(5, 9).join('.')}`;
    const inputAck = (record.fields[9] ?? 0) - 1 === TRANSPORT_CHANNEL_ID.pty;
    if (phase === 0 && inputAck) ackQueuedAt.set(identity, record.at_us);
    if (phase !== 1) continue;
    const packet = record.fields[2] ?? 0;
    if (packet === 0) continue;
    const queuedAt = inputAck ? ackQueuedAt.get(identity) : undefined;
    if (queuedAt !== undefined) ackResidenceUs.push(record.at_us - queuedAt);
    const key = `${record.fields[1] ?? 0}:${packet}`;
    const channels = packets.get(key) ?? [];
    channels.push((record.fields[9] ?? 0) - 1);
    packets.set(key, channels);
    datagrams += 1;
  }
  const compositions: Record<string, number> = {};
  let inputAckDatagrams = 0;
  let inputAckWithDisplay = 0;
  for (const channels of packets.values()) {
    const signature = channels
      .map((channel) => CHANNEL_NAMES.get(channel) ?? `channel${channel}`)
      .sort()
      .join('+');
    compositions[signature] = (compositions[signature] ?? 0) + 1;
    const acks = channels.filter((channel) => channel === TRANSPORT_CHANNEL_ID.pty).length;
    inputAckDatagrams += acks;
    if (channels.includes(TRANSPORT_CHANNEL_ID.displayDatagram)) inputAckWithDisplay += acks;
  }
  ackResidenceUs.sort((a, b) => a - b);
  const rank = (quantile: number) =>
    ackResidenceUs[Math.max(0, Math.ceil(ackResidenceUs.length * quantile) - 1)] ?? 0;
  return {
    packets: packets.size,
    datagrams,
    compositions,
    inputAckDatagrams,
    inputAckWithDisplay,
    inputAckQueuedToPacketizedUs:
      ackResidenceUs.length === 0
        ? null
        : { count: ackResidenceUs.length, p50: rank(0.5), p95: rank(0.95), max: rank(1) },
  };
}
