import { describe, expect, test } from 'bun:test';
import { Effect, Layer, Option, Tracer } from 'effect';
import { FetchHttpClient } from 'effect/unstable/http';
import { OtlpExporter, OtlpSerialization, OtlpTracer } from 'effect/unstable/observability';

import { makeTailSamplingTracer, type TailSamplingDecision } from './tail-sampling-tracer';

/**
 * A stand-in for Effect's OTLP tracer that carries the same `export` own-property contract.
 * Used for the policy tests; the contract itself is pinned against the real tracer below.
 */
function recordingInner(): { tracer: Tracer.Tracer; exported: string[] } {
  const exported: string[] = [];
  const tracer = Tracer.make({
    span(options) {
      const span = new Tracer.NativeSpan({
        name: options.name,
        parent: options.root ? Option.none<Tracer.AnySpan>() : options.parent,
        annotations: options.annotations,
        links: options.links,
        startTime: options.startTime,
        kind: options.kind,
        sampled: options.sampled,
      });
      Object.assign(span, {
        export: (finished: Tracer.Span) => {
          if (finished.sampled) exported.push(finished.name);
        },
      });
      const proto = Object.getPrototypeOf(span) as { end: Tracer.Span['end'] };
      const originalEnd = proto.end.bind(span);
      Object.assign(span, {
        end(endTime: bigint, exit: Parameters<Tracer.Span['end']>[1]) {
          originalEnd(endTime, exit);
          (span as unknown as { export: (s: Tracer.Span) => void }).export(span);
        },
      });
      return span;
    },
  });
  return { tracer, exported };
}

function run<A, E>(program: Effect.Effect<A, E, never>, tracer: Tracer.Tracer): Promise<A> {
  return Effect.runPromise(program.pipe(Effect.provideService(Tracer.Tracer, tracer)));
}

interface Harness {
  readonly tracer: Tracer.Tracer;
  readonly exported: string[];
  readonly decisions: TailSamplingDecision[];
}

function harness(options: { ratio: number; slowThresholdMs?: number }): Harness {
  const { tracer: inner, exported } = recordingInner();
  const decisions: TailSamplingDecision[] = [];
  const tracer = makeTailSamplingTracer(inner, {
    slowThresholdMs: options.slowThresholdMs ?? 1_000,
    ratio: options.ratio,
    random: () => 0.5,
    onDecision: (decision) => decisions.push(decision),
  });
  return { tracer, exported, decisions };
}

describe('tail sampling policy', () => {
  test('an unremarkable trace below the ratio is dropped whole', async () => {
    const { tracer, exported, decisions } = harness({ ratio: 0 });

    await run(
      Effect.void.pipe(Effect.withSpan('redis.operation'), Effect.withSpan('session_request')),
      tracer,
    );

    expect(decisions).toEqual(['dropped_ratio']);
    expect(exported).toEqual([]);
  });

  test('an unremarkable trace above the ratio is kept whole', async () => {
    const { tracer, exported, decisions } = harness({ ratio: 1 });

    await run(
      Effect.void.pipe(Effect.withSpan('redis.operation'), Effect.withSpan('session_request')),
      tracer,
    );

    expect(decisions).toEqual(['kept_ratio']);
    expect(exported.sort()).toEqual(['redis.operation', 'session_request']);
  });

  /**
   * The point of the whole exercise: a failure is kept even when the ratio would have
   * dropped it. Head sampling cannot do this, because the failure has not happened yet when
   * the decision is made.
   */
  test('a failure is kept even at ratio zero', async () => {
    const { tracer, exported, decisions } = harness({ ratio: 0 });

    await run(
      Effect.fail('boom').pipe(
        Effect.withSpan('inner'),
        Effect.withSpan('session_request'),
        Effect.result,
      ),
      tracer,
    );

    expect(decisions).toEqual(['kept_error']);
    expect(exported).toContain('session_request');
  });

  test('a slow root is kept even at ratio zero', async () => {
    const { tracer, decisions } = harness({ ratio: 0, slowThresholdMs: 0 });

    await run(Effect.void.pipe(Effect.withSpan('session_request')), tracer);

    expect(decisions).toEqual(['kept_slow']);
  });

  /**
   * The daemon exports unconditionally through its own tracer, so a trace it contributed to
   * must survive here or its span arrives orphaned under a parent that was never exported.
   */
  test('a trace that reached a daemon is kept even at ratio zero', async () => {
    const { tracer, exported, decisions } = harness({ ratio: 0 });

    await run(
      Effect.void.pipe(
        Effect.withSpan('daemon-control.delivery'),
        Effect.withSpan('session_request'),
      ),
      tracer,
    );

    expect(decisions).toEqual(['kept_daemon']);
    expect(exported).toContain('daemon-control.delivery');
  });

  /**
   * Levels are tiers, not drops. A `Debug` span is buffered rather than discarded at
   * creation, so a kept trace arrives with its full breakdown and a dropped one costs
   * nothing.
   */
  test('Debug children ship with a kept trace and vanish with a dropped one', async () => {
    const kept = harness({ ratio: 1 });
    await run(
      Effect.void.pipe(
        Effect.withSpan('redis.operation', { level: 'Debug' }),
        Effect.withSpan('session_request'),
        Effect.provideService(Tracer.MinimumTraceLevel, 'Info'),
      ),
      kept.tracer,
    );
    expect(kept.exported).toContain('redis.operation');

    const dropped = harness({ ratio: 0 });
    await run(
      Effect.void.pipe(
        Effect.withSpan('redis.operation', { level: 'Debug' }),
        Effect.withSpan('session_request'),
        Effect.provideService(Tracer.MinimumTraceLevel, 'Info'),
      ),
      dropped.tracer,
    );
    expect(dropped.exported).toEqual([]);
  });

  /**
   * An upstream service that exports its own spans has already decided. Overriding it would
   * leave the two halves of one trace disagreeing.
   */
  test('an upstream refusal is honoured rather than re-decided', async () => {
    const { tracer, exported, decisions } = harness({ ratio: 1 });
    const refused = Tracer.externalSpan({
      traceId: '0af7651916cd43dd8448eb211c80319c',
      spanId: 'b7ad6b7169203331',
      sampled: false,
    });

    await run(Effect.void.pipe(Effect.withSpan('edge_register', { parent: refused })), tracer);

    expect(exported).toEqual([]);
    expect(decisions).toEqual([]);
  });

  test('each request is decided independently', async () => {
    const { tracer, decisions } = harness({ ratio: 0 });

    await run(Effect.void.pipe(Effect.withSpan('session_request')), tracer);
    await run(Effect.fail('boom').pipe(Effect.withSpan('session_request'), Effect.result), tracer);

    expect(decisions).toEqual(['dropped_ratio', 'kept_error']);
  });
});

/**
 * Pins the one assumption this design makes about Effect's internals: that an OTLP span
 * carries its exporter callback as an own, writable property, and that re-invoking it after
 * `end()` serializes the finished span with its original ids.
 *
 * If a future Effect release changes that shape, this fails loudly here rather than silently
 * exporting every span forever in production.
 */
describe('conformance with Effect OtlpTracer', () => {
  test('an OTLP span exposes a writable export hook, and deferring it works', async () => {
    const bodies: string[] = [];
    const fakeHttp = Layer.succeed(FetchHttpClient.Fetch, ((
      _url: string,
      init?: { body?: unknown },
    ) => {
      const body = init?.body;
      bodies.push(body instanceof Uint8Array ? new TextDecoder().decode(body) : String(body));
      return Promise.resolve(new Response('', { status: 200 }));
    }) as unknown as typeof globalThis.fetch);

    const program = Effect.gen(function* () {
      const inner = yield* OtlpTracer.make({
        url: 'http://localhost:1/v1/traces',
        resource: { serviceName: 'conformance' },
        exportInterval: '10 millis',
      });

      const decisions: TailSamplingDecision[] = [];
      const tracer = makeTailSamplingTracer(inner, {
        slowThresholdMs: 1_000,
        ratio: 1,
        random: () => 0,
        onDecision: (decision) => decisions.push(decision),
      });

      yield* Effect.void.pipe(
        Effect.withSpan('probe.child'),
        Effect.withSpan('probe.root'),
        Effect.provideService(Tracer.Tracer, tracer),
      );

      yield* Effect.sleep('40 millis');
      expect(decisions).toEqual(['kept_ratio']);
    });

    await Effect.runPromise(
      Effect.scoped(program).pipe(
        Effect.provide(OtlpExporter.layerFlusher),
        Effect.provide(OtlpSerialization.layerJson),
        Effect.provide(FetchHttpClient.layer),
        Effect.provide(fakeHttp),
      ),
    );

    expect(bodies).toHaveLength(1);
    const spans = JSON.parse(bodies[0] ?? '{}').resourceSpans?.[0]?.scopeSpans?.[0]?.spans ?? [];
    expect(spans).toHaveLength(2);

    // Effect's own ids, parent links intact — nothing was fabricated or re-created.
    const [first, second] = spans as Array<{
      name: string;
      traceId: string;
      spanId: string;
      parentSpanId?: string;
    }>;
    expect(first?.traceId).toBe(second?.traceId ?? '');
    const root = spans.find((s: { name: string }) => s.name === 'probe.root');
    const child = spans.find((s: { name: string }) => s.name === 'probe.child');
    expect(child?.parentSpanId).toBe(root?.spanId);
  });
});
