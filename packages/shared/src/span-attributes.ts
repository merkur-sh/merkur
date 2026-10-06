/**
 * The complete set of span attributes Merkur may set, as types.
 *
 * # Why this is a type and not a lint rule
 *
 * This replaces `SensitiveSpanAttributeProcessor`, an export-time deny-list that stripped
 * `client.address`, `url.full`, `url.query`, `user_agent.original`, request/response bodies,
 * cookies and captured headers from finished spans. Every one of those keys was set by
 * `@elysiajs/opentelemetry`, never by Merkur's own code, so when that plugin was removed the
 * deny-list had nothing left to deny.
 *
 * Deleting a security control needs a stronger replacement, not merely a different one. A
 * static scan over source text was the first attempt; this is the real one. An unknown key
 * fails to typecheck, a computed key cannot be written at all, and — the thing no scanner
 * could ever do — **the value type is checked too**. Nothing previously stopped
 * `merkur.window_ms` being a string, or an outcome being a typo.
 *
 * Adding a key here **is** the review. Before doing it, check that the value cannot carry
 * terminal content, a credential, a request body, or an end user's network address.
 *
 * `scripts/check-span-attributes.ts` now has one job: make sure nobody bypasses this module
 * by calling `Effect.annotateCurrentSpan` or writing a bare `attributes:` literal.
 */

/**
 * One declaration, from which both the types and the key list are derived.
 *
 * A bare `'string' | 'number' | 'boolean'` names a primitive; a readonly tuple of string
 * literals names a closed union, which is how an enum-shaped attribute stops accepting a
 * typo.
 */
const SPAN_ATTRIBUTE_SPEC = {
  // OpenTelemetry semantic conventions.
  'db.operation.name': [
    'Redis.commands',
    'Redis.script-load',
    'Redis.publish',
    'Redis.subscribe',
    'Redis.unsubscribe',
  ],
  'db.system': ['redis'],
  'error.type': 'string',
  'http.request.method': 'string',
  'http.response.status_code': 'number',
  'url.path': 'string',

  /**
   * An OTLP *resource* attribute rather than a span attribute. Declared so the deployment
   * environment name is reviewed alongside everything else; a configured environment label
   * is not sensitive.
   */
  'deployment.environment.name': 'string',
  // Resource identity, once per server process; never a per-request metric label.
  'service.instance.id': 'string',

  // Request outcome.
  'merkur.outcome': ['success', 'mapped_error', 'failure', 'cancelled', 'recovered'],

  // Identity. High cardinality by design: traces are the high-cardinality store, which is
  // exactly why these must never become metric labels.
  'merkur.claim.seq': 'number',
  'merkur.command.id': 'string',
  'merkur.command.type': 'string',
  'merkur.connection.id': 'string',
  'merkur.daemon.id': 'string',
  'merkur.message.type': 'string',
  'merkur.owner.instance_id': 'string',
  'merkur.presence.id': 'string',
  'merkur.requester.instance_id': 'string',
  'merkur.session.id': 'string',

  // Daemon performance reports. Bounded numbers; the bodies they come from are allow-listed
  // at the schema in `telemetry-routes.ts`.
  'merkur.control_reconnects': 'number',
  'merkur.dataplane_ready': 'number',
  'merkur.direct_display_datagrams_received': 'number',
  'merkur.direct_display_datagrams_recovered_by_fec': 'number',
  'merkur.direct_display_datagrams_declared_lost': 'number',
  'merkur.direct_display_datagrams_outcome_unknown': 'number',
  'merkur.edge_display_datagrams_received': 'number',
  'merkur.edge_display_datagrams_recovered_by_fec': 'number',
  'merkur.edge_display_datagrams_declared_lost': 'number',
  'merkur.edge_display_datagrams_outcome_unknown': 'number',
  'merkur.direct_wt_admitted': 'number',
  'merkur.direct_wt_incoming_expected': 'number',
  'merkur.direct_wt_incoming_unexpected': 'number',
  'merkur.fec_repairs_refused': 'number',
  'merkur.fec_repairs_sent': 'number',
  'merkur.nat_keepalives_sent': 'number',
  'merkur.nat_punch_bursts_sent': 'number',
  'merkur.nat_punch_refused_not_global': 'number',
  'merkur.nat_punch_refused_rate_limited': 'number',
  'merkur.nat_side_channel_send_failures': 'number',
  'merkur.ping_rtt_max_ms': 'number',
  'merkur.ping_rtt_p50_ms': 'number',
  'merkur.ping_rtt_p95_ms': 'number',
  'merkur.resync_rows_requested': 'number',
  'merkur.row_resends_identical': 'number',
  'merkur.row_versions_sent': 'number',
  'merkur.row_versions_superseded_unapplied': 'number',
  'merkur.rows_declared_lost': 'number',
  'merkur.suspension_gap_ms_max': 'number',
  'merkur.window_ms': 'number',

  // Browser failure reports. Closed unions on the wire, validated by `ApiModels` before
  // they reach a span.
  'merkur.error_kind': 'string',
  'merkur.error_source': 'string',

  /**
   * Device-events streams this replica holds open for the account opening one,
   * counting the new stream. A stream is only ended by its client going away,
   * and an intermediary can hold a request open long after the browser is gone,
   * so this is the number that says whether they are accumulating.
   */
  'merkur.device_events_streams_open': 'number',

  // Browser link reports.
  'merkur.degraded_samples': 'number',
  'merkur.input_ack_p50_ms': 'number',
  'merkur.rtt_max_ms': 'number',
  'merkur.rtt_p50_ms': 'number',
  'merkur.rtt_p95_ms': 'number',
  'merkur.sample_count': 'number',
  'merkur.session_quality': ['good', 'degraded', 'bad'],

  // Browser direct-upgrade reports. Closed unions on the wire, validated by `ApiModels`
  // before they reach a span; kept as strings here rather than duplicating those unions in
  // a second place that could drift from the schema.
  'merkur.upgrade_admission_reason': 'string',
  'merkur.upgrade_admission_stage': 'string',
  'merkur.upgrade_nat_filtering': [
    'endpoint_independent',
    'port_independent',
    'port_dependent',
    'unknown',
  ],
  'merkur.upgrade_wt_reachability': ['verified_unfamiliar_ip', 'verified_familiar_ip', 'unknown'],
  'merkur.upgrade_nat_type': 'string',
  'merkur.upgrade_outcome': 'string',
  'merkur.upgrade_sessions_opened': 'number',
  'merkur.upgrade_winner_kind': 'string',

  // Carrier-rebind outcomes, relayed from the Rust dataplane over IPC. The
  // outcome vocabulary is closed and validated against `REBIND_OUTCOMES` in
  // `dataplane-client.ts` before it reaches a span; kept as a string here for
  // the same reason as the upgrade reports above — a second copy of the union
  // is a second place to drift from the Rust `RebindRefusal::metric_key`.
  'merkur.rebind_outcome': 'string',
  'merkur.rebind_generation': 'number',
  'merkur.rebind_attempt_ms': 'number',

  // Per-window carrier-rebind tallies on the daemon perf report. Separate from
  // the per-attempt outcome above: these survive the emitter's rate bound, so
  // they carry the rate when the per-attempt detail was dropped.
  'merkur.rebind_requests': 'number',
  'merkur.rebind_accepted': 'number',
  'merkur.rebind_refused': 'number',
  'merkur.rebind_committed': 'number',
  'merkur.rebind_envelopes_rejected': 'number',
  'merkur.rebind_events_suppressed': 'number',
} as const satisfies Record<string, SpanAttributeKind>;

/**
 * Span attributes set by the Rust edge, which cannot share a TypeScript type.
 *
 * Declared here so `check:span-attributes` can assert the Rust `tracing` span fields are a
 * subset of a reviewed set — the same "one vector, two implementations" discipline the STUN
 * ticket and `traceparent` already use, because nothing at runtime detects drift between
 * two implementations of a contract.
 */
export const EDGE_SPAN_ATTRIBUTE_KEYS: readonly string[] = [
  'merkur.session.id',
  'merkur.peer.role',
  'edge_id',
  'accepting_new_sessions',
  'outcome',
];

type SpanAttributeKind = 'string' | 'number' | 'boolean' | readonly string[];

type ValueOf<TKind> = TKind extends 'string'
  ? string
  : TKind extends 'number'
    ? number
    : TKind extends 'boolean'
      ? boolean
      : TKind extends readonly (infer TMember)[]
        ? TMember
        : never;

/** Every attribute Merkur may set, with the value type each one accepts. */
export type MerkurSpanAttributes = {
  readonly [K in keyof typeof SPAN_ATTRIBUTE_SPEC]: ValueOf<(typeof SPAN_ATTRIBUTE_SPEC)[K]>;
};

export type SpanAttributeKey = keyof MerkurSpanAttributes;

/**
 * A partial set of attributes.
 *
 * Object-literal excess-property checking is what does the work: an unknown key on a literal
 * passed here is a compile error, and a computed key cannot be expressed at all.
 */
export type SpanAttributeInput = Partial<MerkurSpanAttributes>;

/**
 * Derived, never hand-maintained. The gate and the Rust cross-check both read this, so there
 * is no second list to drift from the types.
 */
export const SPAN_ATTRIBUTE_KEYS: readonly SpanAttributeKey[] = Object.keys(
  SPAN_ATTRIBUTE_SPEC,
) as SpanAttributeKey[];

/**
 * Widen typed attributes to what a tracer takes.
 *
 * The cast is the boundary between a checked map and Effect's `Record<string, unknown>`; it
 * widens a value that has already been proven, which is the opposite of asserting one that
 * has not.
 */
export function spanAttributes(attributes: SpanAttributeInput): Record<string, unknown> {
  return attributes as Record<string, unknown>;
}
