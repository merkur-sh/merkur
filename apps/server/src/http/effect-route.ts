import { Effect } from 'effect';
import { ElysiaStatus } from 'elysia';

const FAILURE_EVENT_SUFFIX = '_failed';

import { spanAttributes } from '@merkur/shared';
import { errorLogContext, type Logger, logWithLoggerEffect } from '../logger';
import { inboundTraceParent } from '../observability/traceparent';
import type { ServerRuntimeContext } from '../runtime';

/**
 * Structural shape of anything `status(code, body)` returns.
 *
 * Deliberately not `ElysiaStatus<number, unknown, number>`: that
 * class declares its code parameter invariant (`const in out`), so a concrete
 * `status(409, …)` would not be assignable to it. Matching structurally keeps
 * the literal code on the mapper's inferred return type, which is what lets
 * Elysia check it against the route's declared `response` map.
 */
export interface MappedHttpError {
  readonly status: number;
  readonly response: unknown;
}

export type RunServerProgram = <A, E, R extends ServerRuntimeContext>(
  program: Effect.Effect<A, E, R>,
  options?: Effect.RunOptions,
) => Promise<A>;

/**
 * `request` is required, not optional, and that is the point.
 *
 * The route span's parent used to be read from OpenTelemetry's ambient context,
 * which is what let a finished span from an unrelated fiber adopt a request.
 * Taking the request means the parent is derived from data the caller holds,
 * and making it required means `tsc` enumerates every call site rather than
 * leaving some on a silent default.
 */
interface InboundRouteOptions {
  readonly logger: Logger;
  readonly eventName: string;
  readonly request: Request;
  readonly signal?: AbortSignal;
}

export interface RunRouteEffectOptions<E, Mapped extends MappedHttpError>
  extends InboundRouteOptions {
  mapError?(error: E): Mapped | null;
}

export type RunRouteEffectOptionsWithoutMapping = InboundRouteOptions;

export interface RunLoggedEffectOptions<A, E> extends InboundRouteOptions {
  recover?(error: E): Effect.Effect<A> | null;
}

/**
 * Span options for an inbound HTTP request.
 *
 * The parent comes from the request's own `traceparent` header or nowhere at
 * all; there is no ambient fallback, so a request with no inbound context roots
 * its own trace, which is what an entry point should do.
 */
function inboundHttpSpanOptions(request: Request) {
  const parent = inboundTraceParent(request);
  return {
    kind: 'server' as const,
    ...(parent === undefined ? {} : { parent }),
    attributes: spanAttributes({
      'http.request.method': request.method,
      'url.path': requestPath(request),
    }),
  };
}

/**
 * Path only. `url.full` and `url.query` carry credentials in query parameters
 * often enough that the old export-time sanitizer stripped both; not building
 * them is strictly better than deleting them afterwards.
 */
function requestPath(request: Request): string {
  const start = request.url.indexOf('/', request.url.indexOf('//') + 2);
  if (start === -1) {
    return '/';
  }
  const query = request.url.indexOf('?', start);
  return query === -1 ? request.url.slice(start) : request.url.slice(start, query);
}

const DEFAULT_SUCCESS_STATUS = 200;

/**
 * The status a successful handler actually returned.
 *
 * Elysia's `status(code, body)` and `redirect()` both produce a non-200 success,
 * so assuming 200 would mis-record every created resource and every redirect.
 * Anything else is a plain body, which Elysia serves as 200.
 */
function successStatusCode(value: unknown): number {
  if (value instanceof Response || value instanceof ElysiaStatus) {
    return value.status;
  }
  return DEFAULT_SUCCESS_STATUS;
}

export function runRouteEffect<A, E, R extends ServerRuntimeContext>(
  runServerProgram: RunServerProgram,
  program: Effect.Effect<A, E, R>,
  options: RunRouteEffectOptionsWithoutMapping,
): Promise<A>;

export function runRouteEffect<
  A,
  E,
  R extends ServerRuntimeContext,
  Mapped extends MappedHttpError,
>(
  runServerProgram: RunServerProgram,
  program: Effect.Effect<A, E, R>,
  options: RunRouteEffectOptions<E, Mapped> & {
    readonly mapError: (error: E) => Mapped | null;
  },
): Promise<A | Mapped>;

export async function runRouteEffect<
  A,
  E,
  R extends ServerRuntimeContext,
  Mapped extends MappedHttpError,
>(
  runServerProgram: RunServerProgram,
  program: Effect.Effect<A, E, R>,
  options: RunRouteEffectOptions<E, Mapped>,
): Promise<A | Mapped> {
  return runServerProgram(
    program.pipe(
      Effect.tap((value: unknown) =>
        Effect.annotateCurrentSpan(
          spanAttributes({
            'http.response.status_code': successStatusCode(value),
            'merkur.outcome': 'success',
          }),
        ),
      ),
      Effect.catch((error: E) => {
        const mapped = options.mapError?.(error) ?? null;
        if (mapped !== null) {
          return Effect.annotateCurrentSpan(
            spanAttributes({
              'http.response.status_code': mapped.status,
              'merkur.outcome': 'mapped_error',
            }),
          ).pipe(Effect.as(mapped));
        }

        return logWithLoggerEffect(
          options.logger,
          'error',
          options.eventName,
          errorLogContext(error),
        ).pipe(
          Effect.andThen(
            Effect.annotateCurrentSpan(
              spanAttributes({
                'error.type': errorType(error),
                'merkur.outcome': 'failure',
              }),
            ),
          ),
          Effect.andThen(Effect.fail(error)),
        );
      }),
      Effect.onInterrupt(() =>
        Effect.annotateCurrentSpan(
          spanAttributes({
            'merkur.outcome': 'cancelled',
          }),
        ),
      ),
      Effect.withSpan(operationName(options.eventName), inboundHttpSpanOptions(options.request)),
    ),
    { signal: options.signal },
  );
}

export function loggedEffect<A, E, R extends ServerRuntimeContext>(
  program: Effect.Effect<A, E, R>,
  options: RunLoggedEffectOptions<A, E>,
): Effect.Effect<A, E, R> {
  return program.pipe(
    Effect.tap((value: unknown) =>
      Effect.annotateCurrentSpan(
        spanAttributes({
          'http.response.status_code': successStatusCode(value),
          'merkur.outcome': 'success',
        }),
      ),
    ),
    Effect.catch((error: E) => {
      const recovered = options.recover?.(error) ?? null;
      if (recovered !== null) {
        return Effect.annotateCurrentSpan(
          spanAttributes({
            'error.type': errorType(error),
            'merkur.outcome': 'recovered',
          }),
        ).pipe(Effect.andThen(recovered));
      }

      return logWithLoggerEffect(
        options.logger,
        'error',
        options.eventName,
        errorLogContext(error),
      ).pipe(
        Effect.andThen(
          Effect.annotateCurrentSpan(
            spanAttributes({
              'error.type': errorType(error),
              'merkur.outcome': 'failure',
            }),
          ),
        ),
        Effect.andThen(Effect.fail(error)),
      );
    }),
    Effect.onInterrupt(() =>
      Effect.annotateCurrentSpan(
        spanAttributes({
          'merkur.outcome': 'cancelled',
        }),
      ),
    ),
    Effect.withSpan(operationName(options.eventName), inboundHttpSpanOptions(options.request)),
  );
}

export function runLoggedEffect<A, E, R extends ServerRuntimeContext>(
  runServerProgram: RunServerProgram,
  program: Effect.Effect<A, E, R>,
  options: RunLoggedEffectOptions<A, E>,
): Promise<A> {
  return runServerProgram(loggedEffect(program, options), { signal: options.signal });
}

function errorType(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

/**
 * Span name for a route, derived from its failure log event.
 *
 * `eventName` names the log record written when the route fails, so every one
 * of them ends in `_failed`. Using it verbatim as the span name made a healthy
 * request render as `edge_register_failed` in the trace view, which reads as an
 * outage at a glance. The log event keeps its exact name — it is a searchable
 * contract — while the span is named after the operation.
 */
function operationName(eventName: string): string {
  return eventName.endsWith(FAILURE_EVENT_SUFFIX)
    ? eventName.slice(0, -FAILURE_EVENT_SUFFIX.length)
    : eventName;
}
