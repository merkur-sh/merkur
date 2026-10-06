import { describe, expect, test } from 'bun:test';
import { Effect, Tracer } from 'effect';

import { currentTraceparent, inboundTraceParent, traceParentFrom } from './traceparent';

/**
 * The Effect adapter only. The wire format itself is owned by
 * `@merkur/shared` and pinned to the W3C example vector there, alongside the
 * Rust mirror in `apps/edge/src/register.rs`.
 */
const SPECIFICATION_TRACE_ID = '0af7651916cd43dd8448eb211c80319c';
const SPECIFICATION_SPAN_ID = 'b7ad6b7169203331';
const SPECIFICATION_EXAMPLE = `00-${SPECIFICATION_TRACE_ID}-${SPECIFICATION_SPAN_ID}-01`;

describe('inboundTraceParent', () => {
  test('reads the header off a request as an external span', () => {
    const request = new Request('http://localhost/api/edge/register', {
      headers: { traceparent: SPECIFICATION_EXAMPLE },
    });

    const parent = inboundTraceParent(request);
    expect(parent?._tag).toBe('ExternalSpan');
    expect(parent?.traceId).toBe(SPECIFICATION_TRACE_ID);
    expect(parent?.spanId).toBe(SPECIFICATION_SPAN_ID);
  });

  test('a request without the header has no parent', () => {
    expect(inboundTraceParent(new Request('http://localhost/api/version'))).toBeUndefined();
  });

  test('a malformed header has no parent rather than throwing', () => {
    const request = new Request('http://localhost/api/version', {
      headers: { traceparent: 'garbage' },
    });
    expect(inboundTraceParent(request)).toBeUndefined();
  });
});

describe('traceParentFrom', () => {
  test('the empty string carried by a command means no parent', () => {
    expect(traceParentFrom('')).toBeUndefined();
  });

  test('a valid value becomes an external span', () => {
    expect(traceParentFrom(SPECIFICATION_EXAMPLE)?.traceId).toBe(SPECIFICATION_TRACE_ID);
  });
});

describe('currentTraceparent', () => {
  test('renders the active span', async () => {
    const rendered = await Effect.runPromise(
      currentTraceparent.pipe(Effect.withSpan('session_request')),
    );

    expect(rendered).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
  });

  /**
   * Round-trips through the daemon's half of the hop: what the server formats
   * must be what a command parser accepts, or trace context silently stops at
   * the control link.
   */
  test('what it renders is parseable back into the same trace', async () => {
    const rendered = await Effect.runPromise(
      currentTraceparent.pipe(Effect.withSpan('session_request')),
    );

    expect(traceParentFrom(rendered)?.traceId).toBe(rendered.slice(3, 35));
  });

  test('an unsampled span renders zero flags so the daemon does not sample it', async () => {
    const rendered = await Effect.runPromise(
      currentTraceparent.pipe(
        Effect.withSpan('redis.operation', { level: 'Debug' }),
        Effect.provideService(Tracer.MinimumTraceLevel, 'Info'),
      ),
    );

    expect(rendered.endsWith('-00')).toBe(true);
  });

  test('no active span renders the empty string', async () => {
    expect(await Effect.runPromise(currentTraceparent)).toBe('');
  });
});
