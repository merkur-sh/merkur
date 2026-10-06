export type WebTransportCandidateKind = 'srflx' | 'nat_map' | 'host4' | 'host6' | 'loopback';

/**
 * Whether dialing a candidate leaves the local network, as the daemon's
 * address classifier decides it. `local` covers private, shared-address
 * (CGNAT), unique-local, link-local and loopback addresses: exactly the targets
 * a browser's local network access permission gates.
 */
export type WebTransportCandidateScope = 'public' | 'local';

export interface SignalingWebTransportCandidate {
  readonly addr: string;
  readonly port: number;
  readonly kind: WebTransportCandidateKind;
  readonly scope: WebTransportCandidateScope;
}

export type WebTransportNatType = 'endpoint_independent' | 'endpoint_dependent' | 'none';

/**
 * RFC 5780 filtering verdict for the daemon's live socket.
 *
 * `port_dependent` is the one negative value: the daemon sends no punch under
 * it, because only the browser's exact source port passes such a filter and no
 * API exposes that port before the dial. It never suppresses a candidate.
 */
export type WebTransportNatFiltering =
  | 'endpoint_independent'
  | 'port_independent'
  | 'port_dependent'
  | 'unknown';

export interface SignalingWebTransportNatSignature {
  readonly publicIp: string | null;
  readonly natType: WebTransportNatType;
  readonly natFiltering: WebTransportNatFiltering;
  readonly hairpin: boolean;
}

/**
 * Why a direct WebTransport candidate failed to connect.
 *
 * Shared rather than browser-local because the server re-validates it as a
 * closed set before it reaches a metric label — an open string there would be
 * an unbounded-cardinality surface fed by untrusted client input.
 */
export type WebTransportErrorClass =
  | 'tls_mismatch'
  | 'ice_failed'
  | 'timeout'
  | 'refused'
  | 'closed_during_connect'
  | 'other';

/**
 * What became of one offered candidate in one upgrade attempt.
 *
 * The whole point of this union is that it separates the six ways a candidate
 * can fail to carry traffic, which a flat set of error classes could not:
 *
 * - `not_dialled` — the race ended before this candidate's stagger timer fired,
 *   so nothing was learned about it. NOT the same as `no_settle`, and merging
 *   the two re-creates the ambiguity this exists to remove.
 * - `no_settle` — dialled, and the QUIC handshake never settled either way
 *   before the race deadline. This is the signature of a filtered or
 *   black-holed path, and it is the single most diagnostic value here: it used
 *   to be unrecordable, because a pending attempt was neither `ready` nor
 *   `failed` and was dropped at finalize.
 * - `refused` / `tls_rejected` / `closed_during_connect` / `other` — the
 *   handshake settled as a failure, classified from the browser's error.
 * - `ready_lost_race` — connected fine; another candidate simply measured
 *   faster. Evidence the path works, not that it failed.
 * - `ready_upgrade_failed` — connected, then Merkur's own authenticated
 *   admission failed. A Merkur bug, not a network verdict.
 * - `won` — carried traffic.
 */
export type WebTransportCandidateDisposition =
  | 'not_dialled'
  | 'no_settle'
  | 'refused'
  | 'tls_rejected'
  | 'closed_during_connect'
  | 'other'
  | 'ready_lost_race'
  | 'ready_upgrade_failed'
  | 'won';

/** Leg of the authenticated direct-upgrade handshake that failed. */
export type WebTransportAdmissionStage =
  | 'channels'
  | 'init_write'
  | 'challenge'
  | 'proof_sign'
  | 'proof_write'
  | 'ack';

/** How that leg failed. */
export type WebTransportAdmissionReason = 'timeout' | 'invalid' | 'closed' | 'crypto';

/**
 * Whether the direct upgrade ended up carrying traffic.
 *
 * `lost` is a path that WAS established and then died. Without it, `selected`
 * counts adoptions rather than surviving paths, and a path that dies seconds
 * later is indistinguishable from one that carried the whole session.
 */
export type WebTransportUpgradeOutcome = 'selected' | 'failed' | 'lost';

/**
 * Ceiling on candidates in one manifest, and therefore in one upgrade report.
 *
 * A correct daemon emits at most one srflx and one lease plus three host
 * candidates per address family, so eight. The ceiling stays at ten: it is a
 * bound on what a parser will accept, not a restatement of what the daemon
 * emits, and holding it above the emitter is what keeps a future candidate kind
 * from silently disabling the direct path. Shared because two independent
 * parsers bound themselves by it — the browser rejects an over-sized manifest
 * whole rather than truncating it, and the server bounds the report array it
 * becomes.
 */
export const MAX_WEBTRANSPORT_OFFER_CANDIDATES = 10;

/** One offered candidate and what became of it. */
export interface BrowserUpgradeCandidateReport {
  readonly kind: WebTransportCandidateKind;
  readonly disposition: WebTransportCandidateDisposition;
}

/**
 * One direct-upgrade attempt, as reported by the browser.
 *
 * Every field is a member of a closed union (or a small bounded integer) and
 * there are no addresses, ports, or durations — see the privacy contract on the
 * server's matching body. Shared because this shape crosses three boundaries:
 * the transport worker builds it, the main thread posts it, and the server
 * re-validates it into metric labels.
 *
 * `candidates` replaced a pair of independently de-duplicated sets
 * (`candidateKinds` and `failureClasses`) that could not be joined: a kind and a
 * failure appeared in the same report with nothing relating them, so "srflx was
 * offered 225 times and won 0" was the most specific statement the fleet could
 * make, and it could not separate a NAT problem from a firewall problem from a
 * Merkur bug.
 */
export interface BrowserUpgradeReport {
  readonly outcome: WebTransportUpgradeOutcome;
  readonly natType: WebTransportNatType;
  readonly natFiltering: WebTransportNatFiltering;
  readonly winnerKind: WebTransportCandidateKind | 'none';
  /**
   * Every report is new evidence: a race dials only endpoints this network has
   * not tried (`DirectDialAdmission`), and a race that dialed nothing sends no
   * report, so a failing session does not repeat itself into the population.
   */
  readonly candidates: readonly BrowserUpgradeCandidateReport[];
  /** Set only for `ready_upgrade_failed`; `none` otherwise. */
  readonly admissionStage: WebTransportAdmissionStage | 'none';
  readonly admissionReason: WebTransportAdmissionReason | 'none';
}

/** Whether a punch was queued for a manifest's punched candidates. */
export type WebTransportPunchState = 'pending' | 'none';

/**
 * What became of a manifest's punch. `dispatched` means the datagrams left;
 * `refused` and `expired` mean none will; `superseded` means a newer manifest
 * or carrier replaced the one it served.
 */
export type WebTransportPunchOutcome = 'dispatched' | 'refused' | 'superseded' | 'expired';

/**
 * The daemon's whole direct-path candidate set for one browser.
 *
 * `browserAddress` is the address the edge validated on the browser's
 * committed signaling connection: the one the manifest was built for and its
 * punch aimed at. `generation` orders a daemon's manifests, and a punch outcome
 * names the generation it belongs to.
 */
export interface SignalingWebTransportManifestMessage {
  readonly type: 'webtransport_manifest';
  readonly from: string;
  readonly generation: number;
  readonly certHash: string;
  readonly candidates: readonly SignalingWebTransportCandidate[];
  readonly nat: SignalingWebTransportNatSignature;
  readonly browserAddress: string;
  readonly punch: WebTransportPunchState;
}

/** The outcome of the punch a `pending` manifest promised. */
export interface SignalingWebTransportPunchMessage {
  readonly type: 'webtransport_punch';
  readonly generation: number;
  readonly outcome: WebTransportPunchOutcome;
}

export type SignalingInboundMessage =
  | SignalingWebTransportManifestMessage
  | SignalingWebTransportPunchMessage;
