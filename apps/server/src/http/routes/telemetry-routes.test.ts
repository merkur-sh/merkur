import { describe, expect, spyOn, test } from 'bun:test';
import {
  daemonHttpProofHeaders,
  deriveSessionAuthorizationKeyPair,
  signDaemonProof,
} from '@merkur/auth';
import { BROWSER_ERROR_KINDS, BROWSER_ERROR_SOURCES } from '@merkur/shared';
import { Effect, Layer, ManagedRuntime, Metric, Redacted } from 'effect';

import { type ServerConfig, ServerConfigService } from '../../config';
import { createLogger } from '../../logger';
import {
  browserInputAckRttP50Ms,
  browserInputAckRttP95Ms,
  browserLinkRttP50Ms,
  browserLinkRttP95Ms,
  browserPerfIngestFrequency,
  daemonReportedPingOutcomeFrequency,
} from '../../observability/metrics';
import type { runServerProgram } from '../../runtime';
import { RateLimitServiceTag } from '../../services/rate-limit-service';

import { ApiModels } from '../api-models';
import { DAEMON_TEST_SEED, daemonAuthFixture } from '../daemon-auth-fixture';
import { TELEMETRY_SPAN_ATTRIBUTE_KEYS, telemetryRoutesPlugin } from './telemetry-routes';

/**
 * Fields that must never appear in a telemetry request body.
 *
 * The rule is stronger than "do not log an identifier": every telemetry field is
 * a bounded number, so there is no field a keystroke could fit in even from a
 * modified client. Per-keystroke timestamps and inter-keystroke deltas are called
 * out explicitly because keystroke timing is a genuine side channel for
 * inferring typed content, whereas heartbeat-window counts and percentile buckets do not expose those gaps.
 */
const FORBIDDEN_BODY_FIELDS = [
  'userId',
  'user_id',
  'sessionId',
  'session_id',
  'deviceId',
  'device_id',
  'daemonId',
  'daemon_id',
  'clientIp',
  'client_ip',
  'userAgent',
  'user_agent',
  'url',
  'inputSeq',
  'displaySeq',
  'byteLength',
  'samples',
  'timestamps',
  'keystrokes',
];

/** Bodies whose every field must be a bounded integer. */
const TELEMETRY_BODIES = {
  DaemonPerfReportBody: ApiModels.DaemonPerfReportBody,
  BrowserLinkReportBody: ApiModels.BrowserLinkReportBody,
} as const;

/**
 * Every telemetry body, including the upgrade report, which carries closed
 * unions rather than numbers and so is structurally asserted separately below.
 * The forbidden-field rule applies to all of them without exception.
 */
const ALL_TELEMETRY_BODIES = {
  ...TELEMETRY_BODIES,
  BrowserUpgradeReportBody: ApiModels.BrowserUpgradeReportBody,
} as const;

describe('telemetry request schemas', () => {
  test('every telemetry field is a bounded integer that cannot carry free text', () => {
    // Elysia compiles `t.Integer()` into an `anyOf` with a numeric-string
    // coercion branch, hoisting the bounds to the top level. Assert on the
    // branches so a plain `t.String()` slipping in would fail here: a free-text
    // field is exactly what makes exfiltration possible.
    interface Branch {
      readonly type?: string;
      readonly format?: string;
    }
    interface FieldSchema {
      readonly maximum?: number;
      readonly minimum?: number;
      readonly type?: string;
      readonly anyOf?: readonly Branch[];
    }

    for (const [name, schema] of Object.entries(TELEMETRY_BODIES)) {
      const properties = schema.properties as Record<string, FieldSchema>;
      expect(Object.keys(properties).length).toBeGreaterThan(0);

      for (const [field, definition] of Object.entries(properties)) {
        const label = `${name}.${field}`;

        // An unbounded number is a denial-of-service surface on the metric
        // registry and makes the resulting histograms meaningless.
        expect(`${label} maximum:${typeof definition.maximum}`).toBe(`${label} maximum:number`);
        expect(`${label} minimum:${definition.minimum}`).toBe(`${label} minimum:0`);

        const branches = definition.anyOf ?? [{ type: definition.type }];
        for (const branch of branches) {
          const integerLike =
            branch.type === 'integer' || (branch.type === 'string' && branch.format === 'integer');
          expect(`${label} branch ${branch.type}/${branch.format}:${integerLike}`).toBe(
            `${label} branch ${branch.type}/${branch.format}:true`,
          );
        }
      }
    }
  });

  test('telemetry schemas reject unknown fields', () => {
    for (const schema of Object.values(TELEMETRY_BODIES)) {
      expect(schema).toHaveProperty('additionalProperties', false);
    }
  });

  test('no telemetry field can carry an identifier or terminal content', () => {
    for (const [name, schema] of Object.entries(ALL_TELEMETRY_BODIES)) {
      const fields = Object.keys(schema.properties as Record<string, unknown>);
      for (const forbidden of FORBIDDEN_BODY_FIELDS) {
        expect(`${name}:${fields.includes(forbidden)}`).toBe(`${name}:false`);
      }
    }
  });
});

/**
 * The upgrade report carries closed unions and exactly one bounded ordinal. Its
 * whole privacy argument is that no field can hold free text or a measurement,
 * so it is asserted structurally rather than by the bounded-integer rule above:
 * a plain `t.String()` slipping into this body would carry a candidate address,
 * which is the daemon operator's network topology, and a bare number would
 * carry a handshake duration, which measures the user's network.
 */
describe('browser upgrade report schema', () => {
  interface Literal {
    readonly const?: string;
    readonly type?: string;
  }
  interface UnionSchema {
    readonly anyOf?: readonly Literal[];
    readonly type?: string;
    readonly maxItems?: number;
    readonly uniqueItems?: boolean;
    readonly minimum?: number;
    readonly maximum?: number;
    readonly items?: UnionSchema & { readonly properties?: Record<string, UnionSchema> };
  }

  const properties = ApiModels.BrowserUpgradeReportBody.properties as Record<string, UnionSchema>;

  test('every scalar field is a closed union of string literals', () => {
    for (const field of ['outcome', 'natType', 'winnerKind', 'admissionStage', 'admissionReason']) {
      const definition = properties[field];
      const branches = definition?.anyOf ?? [];
      expect(`${field} branches:${branches.length > 0}`).toBe(`${field} branches:true`);
      for (const branch of branches) {
        expect(`${field} const:${typeof branch.const}`).toBe(`${field} const:string`);
      }
    }
  });

  test('the candidate array is capped and both its fields are closed unions', () => {
    const definition = properties.candidates;
    expect(`candidates type:${definition?.type}`).toBe('candidates type:array');
    // An uncapped array is an unbounded loop over metric updates driven by
    // untrusted input.
    expect(`candidates maxItems:${typeof definition?.maxItems}`).toBe('candidates maxItems:number');
    // Deliberately NOT uniqueItems: two candidates of the same kind with
    // different dispositions is the normal case and the whole point of
    // reporting them together, so de-duplicating would destroy the signal.
    expect(`candidates uniqueItems:${definition?.uniqueItems}`).toBe(
      'candidates uniqueItems:undefined',
    );

    const memberProperties = definition?.items?.properties ?? {};
    for (const field of ['kind', 'disposition']) {
      const branches = memberProperties[field]?.anyOf ?? [];
      expect(`${field} branches:${branches.length > 0}`).toBe(`${field} branches:true`);
      for (const branch of branches) {
        expect(`${field} const:${typeof branch.const}`).toBe(`${field} const:string`);
      }
    }
  });

  test('no field is numeric: a number would be a measurement', () => {
    const numeric = Object.entries(properties)
      .filter(
        ([, schema]) =>
          schema.type === 'integer' ||
          schema.type === 'number' ||
          typeof schema.minimum === 'number' ||
          typeof schema.maximum === 'number',
      )
      .map(([field]) => field);
    expect(`numeric fields:${numeric.join(',')}`).toBe('numeric fields:');
  });

  test('no field can carry an address, port, or duration', () => {
    const fields = Object.keys(properties);
    for (const forbidden of [
      'addr',
      'address',
      'ip',
      'port',
      'handshakeMs',
      'durationMs',
      'rttMs',
    ]) {
      expect(`upgrade:${fields.includes(forbidden)}`).toBe(`upgrade:false`);
    }
    // The per-candidate members are the new surface and get the same rule.
    const memberFields = Object.keys(properties.candidates?.items?.properties ?? {});
    expect(`candidate fields:${memberFields.sort().join(',')}`).toBe(
      'candidate fields:disposition,kind',
    );
  });
});

describe('telemetry span attributes', () => {
  test('the allow-list carries no user identifier', () => {
    // Deliberate: the server already knows the user from the authenticated
    // cookie, so repeating it inside a telemetry span only creates a join key in
    // a payload that also travels through logs. This is a considered departure
    // from the session routes — if this assertion is ever "fixed", read the
    // comment on TELEMETRY_SPAN_ATTRIBUTE_KEYS first.
    expect(TELEMETRY_SPAN_ATTRIBUTE_KEYS).not.toContain('merkur.user_id');
    expect(TELEMETRY_SPAN_ATTRIBUTE_KEYS).not.toContain('merkur.session_id');
    expect(TELEMETRY_SPAN_ATTRIBUTE_KEYS).not.toContain('client.address');
  });

  /**
   * `merkur.<measure>` for report fields, `merkur.<entity>.<field>` for
   * identity. The dotted form exists so an identity key means the same thing on
   * the server, the daemon and the edge: they were once split between
   * `merkur.daemon_id` and `merkur.daemon.id`, which silently failed to join.
   */
  test('every allow-listed attribute is merkur-namespaced and snake_case', () => {
    for (const key of TELEMETRY_SPAN_ATTRIBUTE_KEYS) {
      expect(`${key}:${/^merkur\.[a-z0-9_]+(\.[a-z0-9_]+)?$/.test(key)}`).toBe(`${key}:true`);
    }
  });

  test('the allow-list has no duplicates', () => {
    expect(new Set(TELEMETRY_SPAN_ATTRIBUTE_KEYS).size).toBe(TELEMETRY_SPAN_ATTRIBUTE_KEYS.length);
  });
});

/**
 * The failure-report body is the one telemetry surface that exists to speak when a session
 * is broken, so it is also the one most tempting to widen with "just the message". These
 * assertions are what stop that: a message or a stack would carry terminal bytes off the
 * machine, and no amount of diagnostic value justifies it.
 */
describe('browser error report body', () => {
  const properties = ApiModels.BrowserErrorReportBody.properties as Record<string, unknown>;

  test('carries exactly source, kind and count', () => {
    expect(Object.keys(properties).sort()).toEqual(['count', 'kind', 'source']);
  });

  test('has no free-text field', () => {
    for (const [name, schema] of Object.entries(properties)) {
      const shape = schema as { type?: string; anyOf?: unknown[] };
      // Either a bounded number or a closed union of literals — never a bare string.
      const isClosedUnion = Array.isArray(shape.anyOf);
      const isNumber = shape.type === 'integer' || shape.type === 'number';
      expect(`${name}:${isClosedUnion || isNumber}`).toBe(`${name}:true`);
    }
  });

  test.each(['message', 'stack', 'stackTrace', 'error', 'detail', 'reason', 'name'])(
    'has no %s field',
    (field) => {
      expect(Object.keys(properties)).not.toContain(field);
    },
  );

  test('rejects additional properties, so a modified client cannot smuggle one', () => {
    expect(ApiModels.BrowserErrorReportBody).toHaveProperty('additionalProperties', false);
  });

  test('source and kind are closed unions, not open strings', () => {
    const source = properties.source as { anyOf?: Array<{ const?: string }> };
    const kind = properties.kind as { anyOf?: Array<{ const?: string }> };
    for (const member of [...(source.anyOf ?? []), ...(kind.anyOf ?? [])]) {
      expect(typeof member.const).toBe('string');
    }
  });

  /**
   * The browser holds its own copy of this vocabulary, and nothing at runtime
   * detects drift between the two: a value the union below does not list is
   * refused with a 422 and the report is dropped, which is exactly the silence
   * the whole surface exists to break. So both sides are pinned to one list —
   * the same discipline the STUN ticket's two implementations follow.
   */
  test('the unions match the contract the browser reports against', () => {
    const source = properties.source as { anyOf?: Array<{ const?: string }> };
    const kind = properties.kind as { anyOf?: Array<{ const?: string }> };
    expect(source.anyOf?.map((member) => member.const)).toEqual([...BROWSER_ERROR_SOURCES]);
    expect(kind.anyOf?.map((member) => member.const)).toEqual([...BROWSER_ERROR_KINDS]);
  });
});

test('perf ingest decompresses gzip exactly and refuses malformed or oversized expansion', async () => {
  const forwarded: string[] = [];
  const ingestFetch = spyOn(globalThis, 'fetch').mockImplementation(
    Object.assign(
      async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const request = new Request(input, init);
        expect(new URL(request.url).hostname).toBe('perf-sink.example');
        forwarded.push(await request.text());
        return new Response(null, { status: 204 });
      },
      { preconnect: () => {} },
    ),
  );
  const config: ServerConfig = {
    host: '127.0.0.1',
    port: 0,
    dbUrl: ':memory:',
    dbAuthToken: undefined,
    redisUrl: Redacted.make('redis://127.0.0.1:6379'),
    publicOrigin: 'https://merkur.test',
    website: undefined,
    accessTokenHmacKey: new Uint8Array(64),
    jwtIssuer: 'merkur',
    jwtAudience: 'merkur-clients',
    tokenHmacSecret: Redacted.make('x'.repeat(32)),
    authAllowRegistration: true,
    authIdentity: 'username',
    emailDelivery: undefined,
    trustedProxyHops: 1,
    sessionTokenSigningKey: deriveSessionAuthorizationKeyPair(new Uint8Array(32)).signingKey,
    sessionTokenVerifyKeyB64: 'A'.repeat(3_456),
    sessionTokenTtlMs: 60_000,
    webPush: undefined,
    edgeRegistrationKeys: new Map(),
    opaqueServerSetup: Redacted.make(Buffer.alloc(128).toString('base64url')),
    opaqueServerPublicKey: Buffer.alloc(32).toString('base64url'),
    stunTicketKey: new Uint8Array(32),
    edgeAttachTicketKey: new Uint8Array(64).fill(11),
    stunServers: [],
    boxHostStunObservers: [],
    boxHost: undefined,

    telemetry: {
      axiomToken: Redacted.make('test-token'),
      axiomDataset: 'traces',
      axiomMetricsDataset: 'metrics',
      axiomPerfDataset: 'perf',
      axiomEndpoint: 'https://perf-sink.example',
      environment: 'test',
    },
    traceLevel: 'Info',
    traceSampleRatio: 1,
    traceSlowThresholdMs: 1_000,
  };
  let allowed = true;
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(
      Layer.succeed(ServerConfigService, config),
      Layer.succeed(RateLimitServiceTag, {
        consume: () =>
          Effect.succeed(allowed ? { allowed: true } : { allowed: false, retryAfterMs: 1_000 }),
      }),
      Layer.succeed(Metric.MetricRegistry, new Map()),
      Layer.succeed(Metric.CurrentMetricAttributes, { test: crypto.randomUUID() }),
    ),
  );
  const app = telemetryRoutesPlugin({
    runServerProgram: runtime.runPromise as typeof runServerProgram,
    authorizeRequest: async () => ({
      userId: 'test',
      delegationId: 'test',
      delegationExpiresAt: 0,
    }),
    logger: createLogger('telemetry-ingest-test'),
  });
  const compress = (body: string | Uint8Array<ArrayBuffer>) =>
    new Response(
      new Blob([body]).stream().pipeThrough(new CompressionStream('gzip')),
    ).arrayBuffer();
  const post = (body: BodyInit, encoding = 'gzip') =>
    app.handle(
      new Request('http://localhost/api/telemetry/perf', {
        method: 'POST',
        headers: { 'content-type': 'application/x-ndjson', 'content-encoding': encoding },
        body,
      }),
    );
  const rows =
    '{"kind":"input_sent","at_ms":1,"input_seq":1}\n{"kind":"input_ack","at_ms":2,"input_seq":1}';
  try {
    const compressed = await compress(rows);
    expect((await post(compressed)).status).toBe(204);
    expect(forwarded).toEqual([rows]);
    for (const body of [
      rows,
      compressed.slice(0, compressed.byteLength - 4),
      await compress('x'.repeat(4 * 1024 * 1024 + 1)),
      await compress('{}\n'.repeat(1_001)),
    ]) {
      expect((await post(body)).status).toBe(204);
    }
    expect((await post(rows, 'identity')).status).toBe(204);
    // Rows retain their original bytes after validation: a body that is not UTF-8 is
    // refused rather than forwarded with replacement characters.
    const rejectedInvalid = async () =>
      (await runtime.runPromise(Metric.value(browserPerfIngestFrequency))).occurrences.get(
        'rejected_invalid',
      ) ?? 0;
    const rejectedBefore = await rejectedInvalid();
    const notUtf8 = await compress(new Uint8Array([0x7b, 0x7d, 0x0a, 0x7b, 0xff, 0x7d]));
    expect((await post(notUtf8)).status).toBe(204);
    expect(await rejectedInvalid()).toBe(rejectedBefore + 1);
    expect(forwarded).toEqual([rows]);
    // Blank lines are not rows: the row cap counts only non-empty lines.
    const blankSeparated = `\n${'{"label":"é"}\n\n'.repeat(1_000)}`;
    expect((await post(await compress(blankSeparated))).status).toBe(204);
    expect(forwarded).toEqual([rows, blankSeparated]);
    const recoveryRow = JSON.stringify({
      kind: 'recovery_outcome',
      at_ms: 1,
      owner_id: 'owner',
      attempt_id: 1,
      carrier_id: 0,
      issuance_id: 'issuance',
      merkur_session_id: '',
      recovery_trigger: 'initial',
      recovery_phase: 'issuance_requested',
      recovery_end_reason: 'issuance_failed',
      cancellation_initiator: 'attempt',
      duration_ms: 20,
      capability_remaining_ms: 0,
      retry_index: 0,
      backoff_delay_ms: 0,
      handshake_admission_ms: 0,
      signaling_outcome: 'not_started',
      interactive_outcome: 'not_started',
      bulk_outcome: 'not_started',
    });
    expect((await post(await compress(recoveryRow))).status).toBe(204);
    expect(forwarded.at(-1)).toBe(recoveryRow);
    forwarded.pop();
    const invalidRecovery = recoveryRow.replace('issuance_failed', 'arbitrary text');
    const rejectedRecoveryBefore = await rejectedInvalid();
    expect((await post(await compress(invalidRecovery))).status).toBe(204);
    expect(await rejectedInvalid()).toBe(rejectedRecoveryBefore + 1);
    allowed = false;
    expect((await post(compressed)).status).toBe(204);
    expect(forwarded).toEqual([rows, blankSeparated]);
  } finally {
    await runtime.dispose();
    ingestFetch.mockRestore();
  }
});

test('link ingest excludes absent RTTs while retaining measured report summaries', async () => {
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(
      Layer.succeed(RateLimitServiceTag, { consume: () => Effect.succeed({ allowed: true }) }),
      Layer.succeed(Metric.MetricRegistry, new Map()),
      Layer.succeed(Metric.CurrentMetricAttributes, { test: crypto.randomUUID() }),
    ),
  );
  // This route only needs the rate limiter; other server services stay unprovided
  // so an unexpected dependency fails the test.
  const app = telemetryRoutesPlugin({
    runServerProgram: runtime.runPromise as typeof runServerProgram,
    authorizeRequest: async () => ({
      userId: 'test',
      delegationId: 'test',
      delegationExpiresAt: 0,
    }),
    logger: createLogger('telemetry-ingest-test'),
  });
  const histograms = [
    browserLinkRttP50Ms,
    browserLinkRttP95Ms,
    browserInputAckRttP50Ms,
    browserInputAckRttP95Ms,
  ];
  const base = Object.fromEntries(
    Object.keys(ApiModels.BrowserLinkReportBody.properties).map((key) => [key, 0]),
  );
  const post = async (values: Record<string, number>) => {
    const response = await app.handle(
      new Request('http://localhost/api/telemetry/link', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...base,
          windowMs: 2_000,
          sampleCount: 1,
          stateReady: 1,
          ...values,
        }),
      }),
    );
    expect(response.status).toBe(204);
  };
  const counts = () =>
    runtime.runPromise(
      Effect.forEach(histograms, (metric) =>
        Metric.value(metric).pipe(Effect.map((state) => state.count)),
      ),
    );
  try {
    await post({});
    expect(await counts()).toEqual([0, 0, 0, 0]);
    await post({ rttP50Ms: 40, rttP95Ms: 80 });
    expect(await counts()).toEqual([1, 1, 0, 0]);
    await post({ inputAckP50Ms: 20, inputAckP95Ms: 50 });
    expect(await counts()).toEqual([1, 1, 1, 1]);
    await post({
      sampleCount: 0,
      rttP50Ms: 40,
      rttP95Ms: 80,
      inputAckP50Ms: 20,
      inputAckP95Ms: 50,
    });
    expect(await counts()).toEqual([1, 1, 1, 1]);
    const sums = await runtime.runPromise(
      Effect.forEach(histograms, (metric) =>
        Metric.value(metric).pipe(Effect.map((state) => state.sum)),
      ),
    );
    expect(sums).toEqual([40, 80, 20, 50]);
  } finally {
    await runtime.dispose();
  }
});

/** Posts signed daemon perf reports through the production route; returns the status. */
function daemonPerfPoster() {
  const origin = 'https://merkur.test';
  const url = `${origin}/api/daemon/perf`;
  const fixture = daemonAuthFixture({ origin });
  const app = telemetryRoutesPlugin({
    runServerProgram: fixture.runProgram,
    authorizeRequest: async () => null,
    logger: fixture.logger,
  });
  const base = Object.fromEntries(
    Object.keys(ApiModels.DaemonPerfReportBody.properties).map((key) => [key, 0]),
  );
  return async (values: Record<string, number>) => {
    const body = JSON.stringify({ ...base, windowMs: 60_000, ...values });
    const headers = await daemonHttpProofHeaders(
      'daemon-1',
      async (transcript) => signDaemonProof(DAEMON_TEST_SEED, 'http', transcript),
      'POST',
      url,
      'application/json',
      new TextEncoder().encode(body),
      Date.now(),
    );
    const response = await app.handle(
      new Request(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body,
      }),
    );
    return response.status;
  };
}

test('daemon perf report refuses a ping-outcome count above its bound before any metric work', async () => {
  const post = daemonPerfPoster();
  for (const field of [
    'controlPingPonged',
    'controlPingTimeout',
    'controlPingSendFailed',
    'controlPingSuspended',
  ]) {
    expect(`${field}:${await post({ [field]: 10_001 })}`).toBe(`${field}:422`);
    expect(`${field}:${await post({ [field]: 10_000 })}`).toBe(`${field}:204`);
  }
});

test('daemon perf report records every ping outcome without an effect per occurrence', async () => {
  const post = daemonPerfPoster();
  const occurrences = async () =>
    new Map(
      (await Effect.runPromise(Metric.value(daemonReportedPingOutcomeFrequency))).occurrences,
    );
  const update = spyOn(Metric, 'update');
  try {
    const before = await occurrences();
    expect(await post({ controlPingPonged: 1 })).toBe(204);
    const updatesPerReport = update.mock.calls.length;
    update.mockClear();
    expect(
      await post({
        controlPingPonged: 30,
        controlPingTimeout: 2,
        controlPingSendFailed: 1,
        controlPingSuspended: 3,
      }),
    ).toBe(204);
    // The Metric.update count per report does not grow with the occurrence counts.
    expect(update.mock.calls.length).toBe(updatesPerReport);
    const after = await occurrences();
    expect(
      ['pong', 'timeout', 'send_failed', 'suspended'].map(
        (label) => (after.get(label) ?? 0) - (before.get(label) ?? 0),
      ),
    ).toEqual([31, 2, 1, 3]);
  } finally {
    update.mockRestore();
  }
});
