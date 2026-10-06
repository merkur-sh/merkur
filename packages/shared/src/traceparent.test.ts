import { describe, expect, test } from 'bun:test';

import { formatTraceparent, mintTraceparent, parseTraceparent } from './traceparent';

/**
 * The W3C trace-context specification's own example value.
 *
 * `apps/edge/src/register.rs` pins its formatter to this exact string in
 * `renders_the_w3c_specification_example`. Pinning the parser to it here makes
 * the pair a matched producer/verifier, the same discipline the STUN ticket
 * uses: nothing at runtime detects drift between the two implementations, so
 * the vector is the contract.
 */
const SPECIFICATION_EXAMPLE = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';
const SPECIFICATION_TRACE_ID = '0af7651916cd43dd8448eb211c80319c';
const SPECIFICATION_SPAN_ID = 'b7ad6b7169203331';

describe('parseTraceparent', () => {
  test('parses the W3C specification example', () => {
    const parent = parseTraceparent(SPECIFICATION_EXAMPLE);

    expect(parent).toEqual({
      traceId: SPECIFICATION_TRACE_ID,
      spanId: SPECIFICATION_SPAN_ID,
      sampled: true,
    });
  });

  test('reads the sampled bit from the flags', () => {
    const unsampled = SPECIFICATION_EXAMPLE.replace(/-01$/, '-00');
    expect(parseTraceparent(unsampled)?.sampled).toBe(false);
  });

  test('ignores vendor flags above the sampled bit', () => {
    // The edge masks everything except `SAMPLED` when formatting; a peer that
    // does not must still be read correctly rather than rejected.
    const vendorFlags = SPECIFICATION_EXAMPLE.replace(/-01$/, '-ff');
    expect(parseTraceparent(vendorFlags)?.sampled).toBe(true);
  });

  test.each([
    ['absent', undefined],
    ['null', null],
    ['empty', ''],
    ['a future version', '01-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01'],
    ['an all-zero trace id', '00-00000000000000000000000000000000-b7ad6b7169203331-01'],
    ['an all-zero span id', '00-0af7651916cd43dd8448eb211c80319c-0000000000000000-01'],
    ['a short trace id', '00-0af7651916cd43dd8448eb211c8031-b7ad6b7169203331-01'],
    ['uppercase hex', '00-0AF7651916CD43DD8448EB211C80319C-b7ad6b7169203331-01'],
    ['a missing field', '00-0af7651916cd43dd8448eb211c80319c-01'],
    ['trailing junk', `${SPECIFICATION_EXAMPLE}-extra`],
  ])('rejects %s', (_label, header) => {
    expect(parseTraceparent(header)).toBeNull();
  });

  /**
   * Trace context is diagnostic. A request must never fail because something
   * upstream sent a malformed header — it simply roots its own trace, which is
   * what an entry point does with no context at all.
   */
  test('a malformed header yields no parent rather than throwing', () => {
    expect(() => parseTraceparent('not-a-traceparent')).not.toThrow();
    expect(parseTraceparent('not-a-traceparent')).toBeNull();
  });

  test('formats back to the specification example', () => {
    expect(
      formatTraceparent({
        traceId: SPECIFICATION_TRACE_ID,
        spanId: SPECIFICATION_SPAN_ID,
        sampled: true,
      }),
    ).toBe(SPECIFICATION_EXAMPLE);
  });

  test('an unsampled context renders zero flags', () => {
    expect(
      formatTraceparent({
        traceId: SPECIFICATION_TRACE_ID,
        spanId: SPECIFICATION_SPAN_ID,
        sampled: false,
      }),
    ).toBe(SPECIFICATION_EXAMPLE.replace(/-01$/, '-00'));
  });

  test('minted values round-trip and differ per call', () => {
    const first = mintTraceparent();
    const second = mintTraceparent();
    expect(first).not.toBe(second);
    expect(parseTraceparent(first)?.sampled).toBe(true);
    // Per request, never per session: one id for a whole tab is the shape that
    // once fused 66,005 records into a single unreadable trace.
    expect(parseTraceparent(first)?.traceId).not.toBe(parseTraceparent(second)?.traceId);
  });
});
