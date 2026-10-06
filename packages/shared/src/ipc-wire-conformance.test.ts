import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const DAEMON_CLIENT_SOURCE = readSource('../../../apps/daemon/src/services/dataplane-client.ts');
const DAEMON_COMMAND_SOURCE = readSource('../../../apps/daemon/dataplane/src/ipc/commands.rs');
const DAEMON_EVENT_SOURCE = readSource('../../../apps/daemon/dataplane/src/ipc/events.rs');
const PERF_TRACE_SOURCE = readSource('../../../apps/daemon/dataplane/src/perf_trace.rs');
const PERF_TRACE_VALIDATOR_SOURCE = readSource('./native-perf-trace.ts');
const DAEMON_PORTMAP_SOURCE = readSource(
  '../../../apps/daemon/dataplane/src/webtransport/portmap/mod.rs',
);
const DAEMON_REBIND_SOURCE = readSource(
  '../../../apps/daemon/dataplane/src/session/rebind_flow.rs',
);

const DAEMON_COMMAND_GOLDEN = {
  CMD_CONFIGURE: 0x01,
  CMD_UPDATE_REVOCATION: 0x08,
  CMD_START_SESSION: 0x09,
  CMD_CANCEL_SESSION: 0x0a,
  CMD_REVOKE_DELEGATION: 0x0b,
  CMD_UPDATE_STUN: 0x0c,
  CMD_CAPTURE_TRANSPORT_STATS: 0x0d,
  CMD_CAPTURE_PERF_TRACE: 0x0e,
  CMD_SHUTDOWN: 0x0f,
  CMD_SIGN_DAEMON_PROOF: 0x10,
  CMD_UPDATE_EDGE_ADMISSION: 0x11,
} as const;

const DAEMON_EVENT_GOLDEN = {
  EVT_PTY_READY: 0x82,
  EVT_PTY_CLOSED: 0x83,
  EVT_BELL: 0x85,
  EVT_PEER_DISCONNECTED: 0x88,
  EVT_ERROR: 0x8a,
  EVT_NETWORK_PATH_CHANGED: 0x8c,
  EVT_WEBTRANSPORT_READY: 0x8d,
  EVT_PEER_AUTHENTICATED: 0x8e,
  EVT_COMMAND_ACK: 0x8f,
  // Deliberately outside the 0x82..=0x8f lifecycle band: the first
  // observational event kind, and the only droppable one.
  EVT_TRANSPORT_STATS: 0x90,
  // Also observational, but emitted per event rather than sampled: one
  // completed port-mapping cycle, carrying a closed-set outcome label.
  EVT_NAT_MAPPING_OUTCOME: 0x91,
  // One carrier-rebind attempt outcome. Observational, droppable, and
  // additionally rate-bounded at the emitter because an `unknown_peer` refusal
  // is drivable by anyone holding the rendezvous id.
  EVT_SESSION_REBIND: 0x92,
  EVT_PERF_TRACE: 0x93,
  EVT_DAEMON_PROOF: 0x94,
} as const;

/**
 * The rebind outcome vocabulary, as the TypeScript validator sees it.
 *
 * `handleSessionRebind` rejects an outcome outside this set, and the caller
 * treats a rejected payload as a FATAL protocol error — so a label the Rust
 * side can emit but this set omits does not degrade to a missing metric, it
 * kills the dataplane on the first rebind. The Rust half is pinned by
 * `the_outcome_vocabulary_is_closed` in `session/rebind_flow.rs`; this asserts
 * the two halves are the same list.
 */
const REBIND_OUTCOME_GOLDEN = [
  'accepted',
  'accepted_held',
  'accepted_replay',
  'attempt_expired',
  'bad_proof',
  'committed',
  'control_link_stale',
  'crypto:answer_transcript',
  'crypto:combiner',
  'crypto:encaps_randomness',
  'crypto:encapsulation',
  'crypto:hybrid_combiner',
  'crypto:identity',
  'crypto:msg1_bind',
  'crypto:nonce',
  'crypto:prologue_digest',
  'crypto:psk_install',
  'crypto:request_digest',
  'crypto:request_transcript',
  'crypto:responder_prepare',
  'crypto:response_mac',
  'crypto:response_transcript',
  'envelope_rejected',
  'forged_generation',
  'generation_budget_exhausted',
  'lineage_expired',
  'not_rebinding',
  'peer_mismatch',
  'response_flushed',
  'session_mismatch',
  'stale_generation',
  'unknown_peer',
];

/**
 * The `session_rebind` event's exact key set.
 *
 * The Rust struct is `#[serde(deny_unknown_fields)]` with no `rename_all`, so a
 * TypeScript writer emitting a camelCase key would not produce a slightly wrong
 * payload — serde would reject the whole frame and the feature would be
 * silently dead while every TypeScript gate stayed green. Asserting the SET is
 * what catches that.
 */
const SESSION_REBIND_KEY_GOLDEN = [
  'attempt_ms',
  'events_suppressed',
  'generation',
  'outcome',
  'session_id',
];

describe('daemon dataplane IPC wire conformance', () => {
  test('TS command opcodes match the Rust command decoder and committed contract', () => {
    expect(readIntegerConstants(DAEMON_CLIENT_SOURCE, 'CMD')).toEqual(DAEMON_COMMAND_GOLDEN);
    expect(readIntegerConstants(DAEMON_COMMAND_SOURCE, 'CMD')).toEqual(DAEMON_COMMAND_GOLDEN);
  });

  test('TS event opcodes match the Rust event producer and committed contract', () => {
    expect(readIntegerConstants(DAEMON_CLIENT_SOURCE, 'EVT')).toEqual(DAEMON_EVENT_GOLDEN);
    expect(readIntegerConstants(DAEMON_EVENT_SOURCE, 'EVT')).toEqual(DAEMON_EVENT_GOLDEN);
  });

  test('the edge admission command is the exact key set the TS writer emits', () => {
    // `edgeAdmissionCommand` in the daemon writes these snake_case keys; serde
    // refuses the whole command on any other set.
    expect(readRustStructFields(DAEMON_COMMAND_SOURCE, 'UpdateEdgeAdmissionCmd')).toEqual([
      'edges',
      'ticket',
    ]);
    expect(readRustStructFields(DAEMON_COMMAND_SOURCE, 'EdgePinsCmd')).toEqual([
      'cert_hashes',
      'url',
    ]);
  });

  test('native trace command and flattened export keys match the closed consumer schema', () => {
    expect(readRustStructFields(DAEMON_COMMAND_SOURCE, 'CapturePerfTraceCmd')).toEqual([
      'command_id',
    ]);
    const fields = readRustStructFields(PERF_TRACE_SOURCE, "TraceChunk<'a>").filter(
      (field) => field !== 'owner',
    );
    fields.push(...readRustStructFields(PERF_TRACE_SOURCE, 'TraceOwner'));
    const literalKeys = (name: string): string[] => {
      const start = PERF_TRACE_VALIDATOR_SOURCE.indexOf(`const ${name} = [`);
      if (start < 0) throw new Error(`${name} not found`);
      const end = PERF_TRACE_VALIDATOR_SOURCE.indexOf('] as const;', start);
      if (end < 0) throw new Error(`${name} not terminated`);
      return [...PERF_TRACE_VALIDATOR_SOURCE.slice(start, end).matchAll(/'([^']+)'/g)]
        .map((match) => match[1] ?? '')
        .sort();
    };
    expect(fields.sort()).toEqual(literalKeys('CHUNK_KEYS'));
    expect(readRustStructFields(PERF_TRACE_SOURCE, 'TraceRecord')).toEqual(
      literalKeys('RECORD_KEYS'),
    );
  });

  test('the rebind outcome vocabulary is the same list on both sides', () => {
    expect(readStringSetMembers(DAEMON_CLIENT_SOURCE, 'REBIND_OUTCOMES')).toEqual(
      REBIND_OUTCOME_GOLDEN,
    );
    // The Rust producer, in three pieces because that is how it is written:
    // `metric_key` returns the plain refusals verbatim and `crypto:<stage>` for
    // the one payloaded variant, and the lifecycle ends are a separate array.
    const rustRefusals = readRustStringLiterals(
      DAEMON_REBIND_SOURCE,
      /=> "([a-z0-9_]+)"\.to_string\(\)/g,
    );
    const rustStages = readRustConstArray(DAEMON_REBIND_SOURCE, 'CRYPTO_STAGES');
    const rustLifecycle = readRustConstArray(DAEMON_REBIND_SOURCE, 'REBIND_LIFECYCLE_OUTCOMES');
    const rustAll = [
      ...rustRefusals,
      ...rustStages.map((stage) => `crypto:${stage}`),
      ...rustLifecycle,
    ].sort();
    expect(rustAll).toEqual(REBIND_OUTCOME_GOLDEN);
  });

  test('the port-mapping outcome vocabulary is the same list on both sides', () => {
    // A key the Rust side can emit but this set omits is not a dropped label:
    // `handleNatMappingOutcome` returns false and the caller treats the frame
    // as an invalid event payload.
    expect(readStringSetMembers(DAEMON_CLIENT_SOURCE, 'NAT_MAPPING_OUTCOMES')).toEqual(
      readRustConstArray(DAEMON_PORTMAP_SOURCE, 'METRIC_KEYS').sort(),
    );
  });

  test('the session_rebind event carries exactly the keys the Rust struct declares', () => {
    expect(readRustStructFields(DAEMON_EVENT_SOURCE, 'SessionRebindEvt')).toEqual(
      SESSION_REBIND_KEY_GOLDEN,
    );
    expect(readExactKeysCall(DAEMON_CLIENT_SOURCE, 'handleSessionRebind')).toEqual(
      SESSION_REBIND_KEY_GOLDEN,
    );
  });
});

/** Members of a `new Set([...])` of string literals, sorted. */
function readStringSetMembers(source: string, name: string): string[] {
  const start = source.indexOf(`const ${name} = new Set([`);
  if (start < 0) throw new Error(`${name} not found`);
  const end = source.indexOf(']);', start);
  if (end < 0) throw new Error(`${name} is not terminated`);
  return [...source.slice(start, end).matchAll(/'([^']+)'/g)].map((m) => m[1] ?? '').sort();
}

function readRustStringLiterals(source: string, pattern: RegExp): string[] {
  return [...source.matchAll(pattern)].map((m) => m[1] ?? '');
}

/** String members of a `const NAME: [&str; N] = [...];` array. */
function readRustConstArray(source: string, name: string): string[] {
  const start = source.indexOf(`const ${name}: [&str;`);
  if (start < 0) throw new Error(`${name} not found`);
  const end = source.indexOf('];', start);
  if (end < 0) throw new Error(`${name} is not terminated`);
  return [...source.slice(start, end).matchAll(/"([^"]+)"/g)].map((m) => m[1] ?? '');
}

/** Serde field names of a `#[derive(Serialize)] pub struct <name>`, sorted. */
function readRustStructFields(source: string, name: string): string[] {
  const start = source.indexOf(`pub struct ${name} {`);
  if (start < 0) throw new Error(`${name} not found`);
  const end = source.indexOf('\n}', start);
  if (end < 0) throw new Error(`${name} is not terminated`);
  return [...source.slice(start, end).matchAll(/^ {4}pub ([a-z0-9_]+):/gm)]
    .map((m) => m[1] ?? '')
    .sort();
}

/** The literal key list passed to `hasExactKeys` inside a named function. */
function readExactKeysCall(source: string, functionName: string): string[] {
  const start = source.indexOf(`function ${functionName}(`);
  if (start < 0) throw new Error(`${functionName} not found`);
  const call = source.indexOf('hasExactKeys(json, [', start);
  if (call < 0) throw new Error(`${functionName} does not call hasExactKeys`);
  const end = source.indexOf('])', call);
  return [...source.slice(call, end).matchAll(/'([^']+)'/g)].map((m) => m[1] ?? '').sort();
}

function readSource(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8');
}

function readIntegerConstants(source: string, prefix: 'CMD' | 'EVT') {
  const pattern = new RegExp(
    `^\\s*(?:export\\s+)?(?:pub\\s+)?const\\s+(${prefix}_[A-Z0-9_]+)(?:\\s*:\\s*[^=;]+)?\\s*=\\s*(0x[0-9A-Fa-f_]+|[0-9_]+)\\s*;`,
    'gm',
  );
  const entries: Array<readonly [string, number]> = [];
  for (const match of source.matchAll(pattern)) {
    const name = match[1];
    const rawValue = match[2];
    if (name === undefined || rawValue === undefined) {
      throw new Error(`invalid ${prefix} constant match`);
    }
    if (entries.some(([existing]) => existing === name)) {
      throw new Error(`duplicate ${prefix} constant ${name}`);
    }
    entries.push([name, Number(rawValue.replaceAll('_', ''))]);
  }
  if (entries.length === 0) {
    throw new Error(`no ${prefix} constants found`);
  }
  return Object.fromEntries(entries);
}

test('identity signing IPC carries the exact composite proof and sealed configuration', () => {
  expect(readRustStructFields(DAEMON_COMMAND_SOURCE, 'SignDaemonProofCmd')).toEqual([
    'command_id',
    'purpose',
    'transcript',
  ]);
  expect(readRustStructFields(DAEMON_EVENT_SOURCE, "DaemonProofEvt<'a>")).toEqual([
    'command_id',
    'p256_signature',
    'signature',
  ]);
  expect(readRustStructFields(DAEMON_COMMAND_SOURCE, 'ConfigureCmd')).toEqual([
    'daemon_binding',
    'daemon_id',
    'daemon_identity_seal',
    'revoked_delegations',
    'root_epoch',
    'server_origin',
    'session_token_verify_key',
    'user_root_public_key',
  ]);
});
