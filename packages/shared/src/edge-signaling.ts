import { TRANSPORT_CHANNEL_ID } from './transport';

/**
 * Edge signaling contract.
 *
 * Signaling rides the same anycast edge WebTransport carrier as terminal data
 * (`apps/web/src/session/connect-webtransport-edge.ts`,
 * `apps/daemon/dataplane/src/edge_tunnel.rs`). Only the carrier changes. Current
 * message shapes include hybrid `session_auth`, `session_ready`, `noise_*`,
 * `webtransport_manifest`/`punch`, `network_change`, and `conn2_confirmed`.
 *
 * This module is the single source of truth for the channel byte and the
 * channel-0x00 routing rule so the browser provider, the daemon tunnel framing,
 * and any test vectors stay in lockstep. It owns NO transport: it is constants
 * plus the public lifecycle surface the browser edge-signaling implementation
 * must expose.
 */

/**
 * The plaintext-signaling channel byte.
 *
 * FRAMING — signaling owns one persistent reliable uni stream in each
 * direction, exactly like every other reliable logical channel. Its stream is
 * `[1-byte channelId = 0x00]` once, followed by repeated
 * `[u32 BE len][jsonUtf8Bytes]` records. The channel byte therefore costs one
 * byte per carrier generation rather than one byte per signaling message.
 *
 * Signaling is reliable-lane ONLY. It is never sent on the datagram lane (the
 * Noise handshake and auth must not be reordered or dropped), so channel `0x00`
 * never appears in a datagram.
 */
export const EDGE_SIGNALING_CHANNEL_ID: number = TRANSPORT_CHANNEL_ID.signaling;

/**
 * Channel-0x00 routing rule, identical on the browser provider and the daemon
 * tunnel:
 *
 *  - channel `0x00` payload is PLAINTEXT signaling JSON. It BYPASSES the E2E
 *    open/seal path entirely (no Noise) and is routed straight to the signaling
 *    lifecycle. The handshake that bootstraps the Noise session cannot itself
 *    be Noise-sealed.
 *  - channels `0x01`+ remain E2E-sealed terminal data, opened/sealed unchanged.
 *
 * Use this guard at the demux point on both ends to split the two paths.
 */
export function isEdgeSignalingChannel(channelId: number): boolean {
  return channelId === EDGE_SIGNALING_CHANNEL_ID;
}

/** Status the edge signaling lifecycle reports to its owner. */
export type SignalingStatus = 'connected' | 'reconnecting';

/**
 * The public surface the browser edge-signaling lifecycle MUST expose so
 * `transport-worker.ts` owns only session orchestration. Implemented in
 * `apps/web/src/session/edge-signaling.ts`.
 */
export interface EdgeSignalingLifecycle {
  /** Recover this owner until hybrid authentication and Noise establish readiness. */
  connect(daemonId: string): Promise<void>;
  /**
   * Publish that the carrier's authenticated PQ bootstrap + Noise exchange completed. A
   * connected status before this boundary would wake terminal traffic onto an
   * unauthenticated replacement connection.
   */
  markAuthenticated(): void;
  /** Send a plaintext signaling JSON object on channel 0x00 (reliable lane). */
  send(payload: object): void;
  isConnected(): boolean;
  /**
   * Start one non-displacing authenticated candidate on the retained lineage.
   * Incumbent progress may retire it until its final flight is sent; only an
   * authenticated successor commit can publish it. A cold speculative dial
   * with no retained lineage stays unseated.
   */
  warmStandby(reason: string): boolean;
  /** Whether a dialled, unseated replacement carrier is currently held. */
  hasStandby(): boolean;
  /**
   * Retire a speculative carrier/dial when the incumbent proves progress.
   * A carrier already adopted by recovery belongs to that recovery instead.
   * Returns whether anything was retired.
   */
  onIncumbentProgress(): boolean;
  /** Wake backoff or start one authenticated candidate; never displace an attempt. */
  connectivityHint(reason: string): void;
  /** End the current authentication on its own protocol failure. */
  failAuthentication(reason: string): void;
  /**
   * Close the live carrier. Recoverable session loss may retain cache state
   * keyed to the requested daemon so the next connect can resume server-free;
   * terminal/new-lineage teardown discards it by default.
   */
  close(options?: { readonly preserveSessionState?: boolean }): void;
}
