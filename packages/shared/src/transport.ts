export const TRANSPORT_HEARTBEAT_INTERVAL_MS = 2_000;

export const TRANSPORT_MAX_INBOUND_MESSAGE_BYTES = 64 * 1024;

export const DISCONNECT_REASON = {
  authTimeout: 'auth-timeout',
  authFailed: 'auth-failed',
  authNoPassword: 'auth-no-password',
  protocolDecodeFailed: 'protocol-decode-failed',
  ptyQueueOverflow: 'pty-queue-overflow',
  controlQueueOverflow: 'control-queue-overflow',
  invalidStateTransition: 'invalid-state-transition',
  edgeFailed: 'edge-failed',
  sessionTimeout: 'session-timeout',
} as const;

/**
 * Whether input the browser has already accepted may be replayed after a
 * disconnect with this reason.
 *
 * Unacked input survives every disconnect by default — the daemon's PTY is
 * still alive and the `session_ready` sequence makes replay exactly-once. Two
 * reasons reset it: an auth failure, because the session identity is gone and
 * replaying would deliver keystrokes typed under one identity into another;
 * and a queue overflow, because replaying a full outbox re-overflows at once.
 *
 * Lives here rather than in the transport worker because BOTH realms need it.
 * The worker governs the outbox with it, and main governs the never-admitted
 * keystroke buffer with it — and if the two ever disagreed, the buffer would
 * replay exactly the input the outbox was reset to discard.
 */
export function shouldPreserveInputOnDisconnect(reason: string): boolean {
  return (
    reason !== DISCONNECT_REASON.authFailed &&
    reason !== DISCONNECT_REASON.ptyQueueOverflow &&
    reason !== DISCONNECT_REASON.controlQueueOverflow
  );
}

/**
 * Display datagrams the browser's WebTransport receive queue may hold.
 *
 * This is one end of a two-ended number, and the daemon owns the other: a
 * display flush is bounded by the carrier's free QUIC datagram send buffer
 * (`DATAGRAM_SEND_BUFFER_BYTES`, 64 KiB), so the largest burst that can reach a
 * browser is roughly 55 datagrams at the current payload cap. The depth here
 * must stay comfortably above that, or a redraw arrives at a queue with no room
 * and the tail is dropped by the browser before any Merkur code sees it.
 *
 * It was 32, which is BELOW the burst the daemon can legally emit. Production
 * showed the consequence exactly: runs of 3 to 16 consecutive display sequences
 * missing, always inside a large multi-datagram redraw and never between small
 * ones — a queue filling and dropping until it drained, not random path loss.
 *
 * Depth is the memory/admission bound, not a staleness timer. No inbound
 * `incomingMaxAge` cutoff is installed: each row independently rejects an older
 * sequence, whereas an elapsed-time cutoff would discard still-needed rows.
 *
 * This is a request, not a guarantee — the queue-limit setters are an optional
 * browser capability. The browser reads back what it actually got and reports
 * it in its transport hint (`receiveQueueDatagrams`), and the daemon bounds a
 * flush by THAT. This constant is the default the daemon uses before the first
 * hint arrives, and when a browser exposes no readable depth.
 */
export const DISPLAY_DATAGRAM_RECEIVE_QUEUE_DEPTH = 256;

export const TRANSPORT_CHANNEL_ID = {
  signaling: 0x00,
  pty: 0x01,
  ctrl: 0x02,
  displayDatagram: 0x03,
  displayCommit: 0x04,
  displayAck: 0x05,
  dataHandshake: 0x06,
  graphicsContent: 0x07,
} as const;

export const EDGE_ROUTING_PREFACE_VERSION = 8;

export const DATA_HANDSHAKE_VERSION = 1;
export const DATA_HANDSHAKE_NONCE_BYTES = 16;
export const DATA_HANDSHAKE_KIND = {
  hello: 1,
  ack: 3,
} as const;
export const DATA_HANDSHAKE_PAYLOAD_BYTES = 2 + DATA_HANDSHAKE_NONCE_BYTES;

export type TransportKind = 'webtransport' | 'edgeWebTransport';

export type TransportPathLabel = 'direct' | 'relay';

export type LogicalChannel = 'pty' | 'ctrl' | 'displayDatagram' | 'displayCommit' | 'displayAck';

export const LOGICAL_CHANNELS: readonly LogicalChannel[] = [
  'pty',
  'ctrl',
  'displayDatagram',
  'displayCommit',
  'displayAck',
] as const;

export const LOGICAL_CHANNEL_TO_ID: Record<LogicalChannel, number> = {
  pty: TRANSPORT_CHANNEL_ID.pty,
  ctrl: TRANSPORT_CHANNEL_ID.ctrl,
  displayDatagram: TRANSPORT_CHANNEL_ID.displayDatagram,
  displayCommit: TRANSPORT_CHANNEL_ID.displayCommit,
  displayAck: TRANSPORT_CHANNEL_ID.displayAck,
};
