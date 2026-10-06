/**
 * Browser-leg packet composition from a Chromium net log.
 *
 * `bun run scripts/analyze-quic-netlog.ts <netlog.json> <census-report.json>...`
 *
 * The packet census (`bench:relay-keystroke-packets`) writes the wall-clock
 * bounds of its windows; this reads the net log Chromium wrote for
 * the same run (`PW_E2E_NETLOG`, default capture mode, no payload bytes) and,
 * per window and direction, counts the QUIC packets of the edge sessions, the
 * ones that carried only an ACK, and the frame composition of each packet.
 * Datagrams and stream records whose sealed size matches exactly one fixed
 * Merkur message are named; everything else is labelled by its length.
 *
 * Grouping, pinned by a trimmed real capture in the test: Chromium logs each
 * frame it adds to a packet before that packet's `QUIC_SESSION_PACKET_SENT`,
 * and each frame it reads after the `QUIC_SESSION_PACKET_RECEIVED` that
 * delivered it. Timestamps are whole milliseconds and logging runs on the
 * network thread it observes, so a netlog run attributes; it does not time.
 */
import { readFileSync } from 'node:fs';
import {
  DISPLAY_ACK_PAYLOAD_BYTES,
  encode,
  encodeHeartbeatPingFrame,
  encodeHeartbeatPongFrame,
} from '../packages/protocol/src/index';
import {
  DISPLAY_PATCH_BODY_HEADER_BYTES,
  DISPLAY_STREAM_HEADER_BYTES,
} from '../packages/shared/src/display-stream';

/** Noise record overhead: the 8-byte counter and 16-byte tag (`docs/security.md`). */
const NOISE_RECORD_BYTES = 24;
/** Every edge session is WebTransport session 0, whose quarter-stream id is one byte. */
const QUARTER_STREAM_ID_BYTES = 1;
const CHANNEL_BYTES = 1;
/** A durable-lane record's `u32` length prefix. */
const RECORD_LENGTH_BYTES = 4;

const datagramBytes = (plaintext: number): number =>
  QUARTER_STREAM_ID_BYTES + CHANNEL_BYTES + NOISE_RECORD_BYTES + plaintext;
const recordBytes = (plaintext: number): number =>
  RECORD_LENGTH_BYTES + NOISE_RECORD_BYTES + plaintext;

const INPUT_ACK = encode({ kind: 'input_ack', seq: 1 }).byteLength;
const PING = encodeHeartbeatPingFrame(1n).byteLength;
const PONG = encodeHeartbeatPongFrame(1n, 1n).byteLength;
const HEADER_ONLY = DISPLAY_STREAM_HEADER_BYTES + DISPLAY_PATCH_BODY_HEADER_BYTES;

/** Fixed-size messages by DATAGRAM (QUIC MESSAGE frame) length. */
export const DATAGRAM_LABELS: ReadonlyMap<number, string> = new Map([
  [datagramBytes(INPUT_ACK), 'input_ack'],
  [datagramBytes(PING), 'ping'],
  [datagramBytes(PONG), 'pong'],
  [datagramBytes(DISPLAY_ACK_PAYLOAD_BYTES), 'display_ack'],
  [datagramBytes(HEADER_ONLY), 'header_only'],
]);

/** Fixed-size reliable records by STREAM frame length, when one frame is one record. */
export const RECORD_LABELS: ReadonlyMap<number, string> = new Map([
  [recordBytes(INPUT_ACK), 'input_ack_twin'],
  [recordBytes(PING), 'ping_record'],
  [recordBytes(PONG), 'pong_twin'],
  [recordBytes(RECORD_LENGTH_BYTES + DISPLAY_ACK_PAYLOAD_BYTES), 'display_ack_record'],
]);

interface NetlogFrame {
  readonly kind: string;
  readonly streamId?: number;
  readonly length?: number;
}

interface NetlogPacket {
  readonly session: number;
  readonly direction: 'up' | 'down';
  /** Wall-clock milliseconds. */
  readonly atMs: number;
  readonly frames: readonly NetlogFrame[];
}

interface RawEvent {
  readonly type: number;
  readonly time: string;
  readonly phase?: number;
  readonly source: { readonly id: number; readonly type: number };
  readonly params?: Record<string, unknown>;
}

const FRAME_EVENT = /^QUIC_SESSION_([A-Z0-9_]+)_FRAME_(SENT|RECEIVED)$/u;

/**
 * Parse the packets of every WebTransport session. Chromium's dedicated
 * WebTransport client logs its QUIC packets on a `WEB_TRANSPORT_CLIENT` source,
 * which is what separates the edge sessions from the browser's own background
 * QUIC traffic in the same log.
 */
export function parseNetlogPackets(text: string): NetlogPacket[] {
  const lines = text.split('\n');
  const head = lines[0] ?? '';
  const constantsPrefix = '{"constants":';
  if (!head.startsWith(constantsPrefix)) throw new Error('not a Chromium net log');
  const constants = JSON.parse(head.slice(constantsPrefix.length).replace(/,\s*$/u, '')) as {
    readonly logEventTypes: Record<string, number>;
    readonly logSourceType: Record<string, number>;
    readonly timeTickOffset: string | number;
  };
  const eventNames = new Map<number, string>();
  for (const [name, id] of Object.entries(constants.logEventTypes)) eventNames.set(id, name);
  const webTransportSource = constants.logSourceType.WEB_TRANSPORT_CLIENT;
  if (webTransportSource === undefined) throw new Error('net log names no WebTransport source');
  const tickOffset = Number(constants.timeTickOffset);

  const pendingSent = new Map<number, NetlogFrame[]>();
  const receiving = new Map<number, { atMs: number; frames: NetlogFrame[] }>();
  const packets: NetlogPacket[] = [];
  const finishReceived = (session: number): void => {
    const open = receiving.get(session);
    if (open === undefined) return;
    receiving.delete(session);
    packets.push({ session, direction: 'down', atMs: open.atMs, frames: open.frames });
  };

  for (const line of lines.slice(1)) {
    if (!line.startsWith('{')) continue;
    let event: RawEvent;
    try {
      event = JSON.parse(line.replace(/,\s*$/u, '')) as RawEvent;
    } catch {
      continue; // The run's last line can be cut off mid-event.
    }
    const name = eventNames.get(event.type);
    if (name === undefined || event.source.type !== webTransportSource) continue;
    const session = event.source.id;
    const atMs = Number(event.time) + tickOffset;
    if (name === 'QUIC_SESSION_PACKET_SENT') {
      packets.push({ session, direction: 'up', atMs, frames: pendingSent.get(session) ?? [] });
      pendingSent.delete(session);
      continue;
    }
    if (name === 'QUIC_SESSION_PACKET_RECEIVED') {
      finishReceived(session);
      receiving.set(session, { atMs, frames: [] });
      continue;
    }
    const match = FRAME_EVENT.exec(name);
    if (match === null) continue;
    const params = event.params ?? {};
    const frame: NetlogFrame = {
      kind: match[1] ?? 'UNKNOWN',
      ...(typeof params.stream_id === 'number' ? { streamId: params.stream_id } : {}),
      ...(typeof params.length === 'number'
        ? { length: params.length }
        : typeof params.message_length === 'number'
          ? { length: params.message_length }
          : {}),
    };
    if (match[2] === 'SENT') {
      const frames = pendingSent.get(session) ?? [];
      frames.push(frame);
      pendingSent.set(session, frames);
    } else {
      receiving.get(session)?.frames.push(frame);
    }
  }
  for (const session of [...receiving.keys()]) finishReceived(session);
  return packets.sort((a, b) => a.atMs - b.atMs);
}

/** One frame's label in a packet signature. Padding carries no information. */
function frameLabel(frame: NetlogFrame): string | null {
  switch (frame.kind) {
    case 'PADDING':
      return null;
    case 'ACK':
      return 'ack';
    case 'MESSAGE':
      return DATAGRAM_LABELS.get(frame.length ?? -1) ?? `dgram${frame.length ?? '?'}`;
    case 'STREAM': {
      const record = RECORD_LABELS.get(frame.length ?? -1);
      return `s${frame.streamId ?? '?'}:${record ?? frame.length ?? '?'}`;
    }
    default:
      return frame.kind.toLowerCase();
  }
}

interface DirectionSummary {
  readonly packets: number;
  readonly ackOnly: number;
  readonly frames: Readonly<Record<string, number>>;
  /** Sorted frame labels of one packet joined by `+`, to packet count, largest first. */
  readonly signatures: readonly (readonly [string, number])[];
}

export function summarizeDirection(packets: readonly NetlogPacket[]): DirectionSummary {
  const frames: Record<string, number> = {};
  const signatures = new Map<string, number>();
  let ackOnly = 0;
  for (const packet of packets) {
    const labels = packet.frames.flatMap((frame) => {
      const label = frameLabel(frame);
      return label === null ? [] : [label];
    });
    for (const frame of packet.frames) frames[frame.kind] = (frames[frame.kind] ?? 0) + 1;
    if (labels.length > 0 && labels.every((label) => label === 'ack')) ackOnly += 1;
    const signature = labels.sort().join('+') || '(padding)';
    signatures.set(signature, (signatures.get(signature) ?? 0) + 1);
  }
  return {
    packets: packets.length,
    ackOnly,
    frames,
    signatures: [...signatures.entries()].sort((a, b) => b[1] - a[1]),
  };
}

export interface KeystrokeCycles {
  /** Keystroke cycles that saw a display ACK leave. */
  readonly keys: number;
  /** Chromium ACK-only packets after the cycle's first display ACK, per key. */
  readonly loneAcksPerKey: number;
  /** Downstream ack-eliciting packets arriving after that display ACK, per key. */
  readonly lateDownstreamPerKey: number;
  /** What those late packets carried, per key, most frequent first. */
  readonly lateLabels: readonly (readonly [string, number])[];
}

/**
 * Per-keystroke attribution of what the browser acknowledges on its own.
 *
 * A cycle runs from one upstream input datagram to the next (every upstream
 * datagram that is not a display ACK is an input run). Chromium carries its
 * QUIC ACK on the first display ACK it sends after a frame lands, so anything
 * ack-eliciting that reaches it later in the cycle leaves its decimated
 * delayed-ACK timer to send a packet of its own. Those late arrivals, and the
 * lone ACKs they draw, are what this counts. Takes one session's packets.
 */
export function summarizeKeystrokeCycles(packets: readonly NetlogPacket[]): KeystrokeCycles {
  const labelled = packets.map((packet) => ({
    direction: packet.direction,
    labels: packet.frames.flatMap((frame) => {
      const label = frameLabel(frame);
      return label === null ? [] : [label];
    }),
    datagrams: packet.frames.filter((frame) => frame.kind === 'MESSAGE').map(frameLabel),
  }));
  const starts = labelled.flatMap((packet, index) =>
    packet.direction === 'up' && packet.datagrams.some((label) => label !== 'display_ack')
      ? [index]
      : [],
  );
  let keys = 0;
  let loneAcks = 0;
  let late = 0;
  const lateLabels = new Map<string, number>();
  for (let cycle = 0; cycle + 1 < starts.length; cycle += 1) {
    const packetsInCycle = labelled.slice(starts[cycle], starts[cycle + 1]);
    const displayAck = packetsInCycle.findIndex(
      (packet) => packet.direction === 'up' && packet.labels.includes('display_ack'),
    );
    if (displayAck < 0) continue;
    keys += 1;
    for (const packet of packetsInCycle.slice(displayAck + 1)) {
      const ackOnly = packet.labels.length > 0 && packet.labels.every((label) => label === 'ack');
      if (packet.direction === 'up') {
        if (ackOnly) loneAcks += 1;
        continue;
      }
      if (ackOnly) continue;
      late += 1;
      for (const label of new Set(packet.labels.filter((label) => label !== 'ack'))) {
        lateLabels.set(label, (lateLabels.get(label) ?? 0) + 1);
      }
    }
  }
  const perKey = (count: number) => (keys === 0 ? 0 : count / keys);
  return {
    keys,
    loneAcksPerKey: perKey(loneAcks),
    lateDownstreamPerKey: perKey(late),
    lateLabels: [...lateLabels.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([label, count]) => [label, perKey(count)] as const),
  };
}

interface CensusWindow {
  readonly name: string;
  readonly keys: number;
  readonly startedAtMs: number;
  readonly endedAtMs: number;
}

export function summarizeWindow(packets: readonly NetlogPacket[], window: CensusWindow) {
  const inside = packets.filter(
    (packet) => packet.atMs >= window.startedAtMs && packet.atMs < window.endedAtMs,
  );
  // One WebTransport session per edge connection: signaling, interactive, bulk.
  const sessions: Record<string, { up: number; down: number }> = {};
  for (const packet of inside) {
    const counts = sessions[packet.session] ?? { up: 0, down: 0 };
    counts[packet.direction] += 1;
    sessions[packet.session] = counts;
  }
  // The interactive session carries the keystrokes and is the busiest one.
  const interactive = Object.entries(sessions).sort(
    (a, b) => b[1].up + b[1].down - (a[1].up + a[1].down),
  )[0]?.[0];
  return {
    name: window.name,
    keys: window.keys,
    durationMs: window.endedAtMs - window.startedAtMs,
    sessions,
    up: summarizeDirection(inside.filter((packet) => packet.direction === 'up')),
    down: summarizeDirection(inside.filter((packet) => packet.direction === 'down')),
    keystrokeCycles:
      window.keys > 0 && interactive !== undefined
        ? summarizeKeystrokeCycles(
            inside.filter((packet) => String(packet.session) === interactive),
          )
        : null,
  };
}

function main(): void {
  const [netlogPath, ...reportPaths] = process.argv.slice(2);
  if (netlogPath === undefined || reportPaths.length === 0) {
    process.stderr.write(
      'usage: bun run scripts/analyze-quic-netlog.ts <netlog.json> <census-report.json>...\n',
    );
    process.exit(2);
  }
  const packets = parseNetlogPackets(readFileSync(netlogPath, 'utf8'));
  const results = reportPaths.map((reportPath) => {
    const report = JSON.parse(readFileSync(reportPath, 'utf8')) as {
      readonly arm: string;
      readonly windows: readonly CensusWindow[];
    };
    return { arm: report.arm, windows: report.windows.map((w) => summarizeWindow(packets, w)) };
  });
  process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
}

if (import.meta.main) main();
