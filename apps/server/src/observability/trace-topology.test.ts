import { describe, expect, test } from 'bun:test';
import { Effect, Option, Tracer } from 'effect';
import { status } from 'elysia';
import type { RunServerProgram } from '../http/effect-route';
import { runRouteEffect } from '../http/effect-route';
import { createLogger } from '../logger';

/**
 * Trace topology, asserted rather than argued.
 *
 * Every case here corresponds to a production incident. All three had the same
 * cause — two context-propagation systems bridged through a global mutable
 * "current span" pointer — and none was visible to `check:types`, `check:lint`
 * or any test. They were found by reading trace cardinality in the backend
 * weeks later. Now they fail here instead.
 */

interface CollectedSpan {
  readonly name: string;
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId: string | undefined;
  readonly sampled: boolean;
  readonly attributes: ReadonlyMap<string, unknown>;
}

/**
 * A tracer that records what it was asked to create.
 *
 * `Tracer.make` takes a `context` hook, which is the only mechanism by which a
 * tracer publishes into a foreign global context. Omitting it here mirrors the
 * production tracer: nothing ambient is written, so nothing ambient can leak
 * between the cases below.
 */
function collectingTracer(): { tracer: Tracer.Tracer; spans: CollectedSpan[] } {
  const spans: CollectedSpan[] = [];
  const tracer = Tracer.make({
    span(options) {
      // `root` is honoured here rather than by the caller: Effect passes both
      // the resolved parent and the flag, leaving the decision to the tracer.
      const parent = options.root ? Option.none<Tracer.AnySpan>() : options.parent;
      const span = new Tracer.NativeSpan({
        name: options.name,
        parent,
        annotations: options.annotations,
        links: options.links,
        startTime: options.startTime,
        kind: options.kind,
        sampled: options.sampled,
      });
      spans.push({
        name: span.name,
        traceId: span.traceId,
        spanId: span.spanId,
        parentSpanId: Option.getOrUndefined(parent)?.spanId,
        sampled: span.sampled,
        attributes: span.attributes,
      });
      return span;
    },
  });
  return { tracer, spans };
}

/**
 * The route runner must provide the tracer: `runRouteEffect` opens its span
 * inside the program it hands to `runServerProgram`, so a tracer supplied
 * outside that call would never be seen by the span it is meant to observe.
 */
function tracingRunner(tracer: Tracer.Tracer): RunServerProgram {
  return ((program: Effect.Effect<unknown, unknown, never>) =>
    Effect.runPromise(
      program.pipe(Effect.provideService(Tracer.Tracer, tracer)),
    )) as RunServerProgram;
}

const SPECIFICATION_TRACE_ID = '0af7651916cd43dd8448eb211c80319c';
const SPECIFICATION_SPAN_ID = 'b7ad6b7169203331';
const TRACEPARENT = `00-${SPECIFICATION_TRACE_ID}-${SPECIFICATION_SPAN_ID}-01`;

function route(request: Request, tracer: Tracer.Tracer): Promise<string> {
  return runRouteEffect(tracingRunner(tracer), Effect.succeed('ok'), {
    eventName: 'session_request_failed',
    logger: createLogger('trace-topology-test'),
    request,
  });
}

function withTracer(tracer: Tracer.Tracer) {
  return <A, E>(program: Effect.Effect<A, E, never>) =>
    program.pipe(Effect.provideService(Tracer.Tracer, tracer));
}

describe('inbound HTTP trace topology', () => {
  test('records Elysia success and mapped failure status codes', async () => {
    const { tracer, spans } = collectingTracer();
    const options = {
      eventName: 'status_probe_failed',
      logger: createLogger('trace-topology-test'),
      request: new Request('http://localhost/api/status-probe'),
    };
    await runRouteEffect(tracingRunner(tracer), Effect.succeed(status(201, { ok: true })), options);
    await runRouteEffect(tracingRunner(tracer), Effect.fail('conflict'), {
      ...options,
      mapError: () => status(409, { error: 'conflict' }),
    });
    await runRouteEffect(tracingRunner(tracer), Effect.succeed({ status: 418 }), options);
    expect(spans.map((span) => span.attributes.get('http.response.status_code'))).toEqual([
      201, 409, 200,
    ]);
    expect(spans.map((span) => span.attributes.get('merkur.outcome'))).toEqual([
      'success',
      'mapped_error',
      'success',
    ]);
  });
  /**
   * The incident: Bun hands every request callback the async context captured
   * when the listener was bound, so one finished span became the parent of 272
   * requests across unrelated routes. Independent requests must be independent
   * traces.
   */
  test('consecutive requests with no inbound context get distinct traces', async () => {
    const { tracer, spans } = collectingTracer();

    await route(new Request('http://localhost/api/sessions/request'), tracer);
    await route(new Request('http://localhost/api/sessions/request'), tracer);

    const traceIds = new Set(spans.map((span) => span.traceId));
    expect(spans).toHaveLength(2);
    expect(traceIds.size).toBe(2);
    for (const span of spans) {
      expect(span.parentSpanId).toBeUndefined();
    }
  });

  test('a request carrying traceparent joins that trace', async () => {
    const { tracer, spans } = collectingTracer();
    const request = new Request('http://localhost/api/sessions/request', {
      headers: { traceparent: TRACEPARENT },
    });

    await route(request, tracer);

    expect(spans).toHaveLength(1);
    expect(spans[0]?.traceId).toBe(SPECIFICATION_TRACE_ID);
    expect(spans[0]?.parentSpanId).toBe(SPECIFICATION_SPAN_ID);
  });

  test('the span is named after the operation, not the failure event', async () => {
    const { tracer, spans } = collectingTracer();

    await route(new Request('http://localhost/api/x'), tracer);

    // A healthy request must not surface as `session_request_failed` in a trace.
    expect(spans[0]?.name).toBe('session_request');
  });
});

describe('span sampling', () => {
  /**
   * `redis.operation` wraps every Redis command and the health routes span
   * every platform poll. Both are declared `Debug` so the default `TRACE_LEVEL`
   * of `Info` drops them; lowering the threshold turns them back on.
   */
  test('a Debug span is not sampled at the default threshold', async () => {
    const { tracer, spans } = collectingTracer();

    await Effect.runPromise(
      Effect.succeed('ok').pipe(
        Effect.withSpan('redis.operation', { level: 'Debug' }),
        Effect.withSpan('session_request'),
        withTracer(tracer),
        Effect.provideService(Tracer.MinimumTraceLevel, 'Info'),
      ),
    );

    expect(spans.find((span) => span.name === 'session_request')?.sampled).toBe(true);
    expect(spans.find((span) => span.name === 'redis.operation')?.sampled).toBe(false);
  });

  test('lowering the threshold samples Debug spans', async () => {
    const { tracer, spans } = collectingTracer();

    await Effect.runPromise(
      Effect.succeed('ok').pipe(
        Effect.withSpan('redis.operation', { level: 'Debug' }),
        withTracer(tracer),
        Effect.provideService(Tracer.MinimumTraceLevel, 'Debug'),
      ),
    );

    expect(spans[0]?.sampled).toBe(true);
  });

  /**
   * An unsampled parent forces its descendants unsampled. That is what keeps a
   * dropped `redis.operation` from being an isolated hole in a trace: nothing
   * hangs beneath it.
   */
  test('descendants of an unsampled span are unsampled', async () => {
    const { tracer, spans } = collectingTracer();

    await Effect.runPromise(
      Effect.succeed('ok').pipe(
        Effect.withSpan('inner'),
        Effect.withSpan('outer', { level: 'Debug' }),
        withTracer(tracer),
        Effect.provideService(Tracer.MinimumTraceLevel, 'Info'),
      ),
    );

    expect(spans.every((span) => !span.sampled)).toBe(true);
  });
});

describe('background loop spans', () => {
  /**
   * The incident: a span wrapping a never-returning effect stayed open, never
   * exported, and adopted every later span — 66,005 records in one trace over
   * 12.7 hours. Background work roots per iteration instead, which is what
   * `{ root: true }` guarantees even if a parent is somehow in scope.
   */
  test('a rooted span starts its own trace even under a parent', async () => {
    const { tracer, spans } = collectingTracer();

    await Effect.runPromise(
      Effect.succeed('ok').pipe(
        Effect.withSpan('server.health.refresh', { root: true }),
        Effect.withSpan('ambient.caller'),
        withTracer(tracer),
      ),
    );

    const refresh = spans.find((span) => span.name === 'server.health.refresh');
    const caller = spans.find((span) => span.name === 'ambient.caller');
    expect(refresh?.parentSpanId).toBeUndefined();
    expect(refresh?.traceId).not.toBe(caller?.traceId);
  });
});
