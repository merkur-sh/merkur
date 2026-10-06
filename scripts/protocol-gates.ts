// Shared by selected gates, protocol verification, and the full verification plan.
export const PROTOCOL_SCAN = 'scripts/current-protocol-hard-cut.test.ts';
export const PROTOCOL_TESTS = [
  'scripts/term-wasm-current-glue.test.ts',
  'scripts/term-wasm-provenance.test.ts',
  'packages/protocol/src/wire-conformance.test.ts',
  'packages/auth/src/session-authorization.test.ts',
  'packages/daemon-control-protocol/src/index.test.ts',
  'packages/shared/src/display-stream.test.ts',
  'packages/shared/src/edge-webtransport.test.ts',
  'packages/shared/src/ipc-wire-conformance.test.ts',
  'packages/shared/src/transport.test.ts',
  'packages/config/src/reconnect-policy.test.ts',
  'packages/e2e-wasm/conformance.test.ts',
  'apps/server/src/http/routes/edge-routes.test.ts',
  'apps/server/src/http/routes/session-routes.test.ts',
  'apps/server/src/services/edge-registry-service.test.ts',
  'apps/web/src/transport/client-carrier.test.ts',
  'scripts/perf/client-session-fixture.test.ts',
  'apps/web/src/terminal-worker-display-owner.test.ts',
  'apps/web/src/session/session-response.test.ts',
  'packages/shared/src/terminal.test.ts',
];

// libtest accepts several filters and runs them on its own thread pool, so the
// whole dataplane selection is one build and one run. `live_edge_roundtrip` needs
// a live edge; it is skipped by name, which is independent of which filters select
// it, so the skip applies to the run rather than to one filter.
export const PROTOCOL_DATAPLANE_FILTERS = [
  'auth::tests',
  'identity_seal::',
  'ipc::commands::',
  'args_tests::',
  // Carrier rebind: the replay fence, the generation counter, and the commit
  // point are the security-critical half of the reconnect path.
  'session::rebind_flow::tests',
  'network::protocol::tests',
  'network::peer::tests',
  'edge_tunnel::tests',
  'session::auth_flow::tests',
  'wt_upgrade::tests',
  'e2e_dispatch_tests',
  'auth_on_signaling_tests',
];
export const PROTOCOL_DATAPLANE_SKIPS = ['live_edge_roundtrip'];
export const PROTOCOL_CRATES = [
  'merkur-e2e',
  'merkur-edge',
  'merkur-client',
  'merkur-client-native',
  'merkur-wire',
];
