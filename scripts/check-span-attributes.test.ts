import { expect, test } from 'bun:test';

import {
  findEdgeSpanFieldViolations,
  findSpanAttributeViolations,
  scanSpanAttributes,
} from './check-span-attributes';

test('the repository goes around the typed attribute map nowhere', () => {
  expect(scanSpanAttributes()).toEqual([]);
});

test('a bare attributes literal is refused', () => {
  const source = `
    program.pipe(
      Effect.withSpan('demo', {
        attributes: { 'merkur.daemon.id': id },
      }),
    );
  `;

  const violations = findSpanAttributeViolations('demo.ts', source);
  expect(violations).toHaveLength(1);
  expect(violations[0]?.reason).toContain('bypasses the typed span attribute map');
});

test('annotateCurrentSpan without spanAttributes is refused', () => {
  const source = `Effect.annotateCurrentSpan({ 'merkur.outcome': 'success' });`;

  const violations = findSpanAttributeViolations('demo.ts', source);
  expect(violations).toHaveLength(1);
  expect(violations[0]?.reason).toContain('typed');
});

test('the sanctioned shapes pass, including when the formatter breaks the line', () => {
  const inline = `Effect.annotateCurrentSpan(spanAttributes({ 'merkur.outcome': 'success' }));`;
  expect(findSpanAttributeViolations('demo.ts', inline)).toEqual([]);

  const wrapped = `
    Effect.annotateCurrentSpan(
      spanAttributes({
        'merkur.outcome': 'success',
      }),
    );
  `;
  expect(findSpanAttributeViolations('demo.ts', wrapped)).toEqual([]);

  const options = `Effect.withSpan('demo', { attributes: spanAttributes({ 'db.system': 'redis' }) })`;
  expect(findSpanAttributeViolations('demo.ts', options)).toEqual([]);
});

/**
 * `attributes:` is a common property name. Only a hand-written object literal is a bypass;
 * a type position or a forwarded value is not.
 */
test('attributes in a type position or forwarded from a value is not a violation', () => {
  const typePosition = `interface Span { attributes: Record<string, unknown>; }`;
  expect(findSpanAttributeViolations('demo.ts', typePosition)).toEqual([]);

  const forwarded = `emit({ attributes: snapshot.attributes });`;
  expect(findSpanAttributeViolations('demo.ts', forwarded)).toEqual([]);
});

test('a key named only in a comment or a string is not a call site', () => {
  const source = `
    // Never write Effect.annotateCurrentSpan({ 'client.address': ip }) here.
    const advice = "attributes: { 'url.full': url }";
  `;
  expect(findSpanAttributeViolations('demo.ts', source)).toEqual([]);
});

test('test files are exempt, production files are not', () => {
  const source = `Effect.annotateCurrentSpan({ 'merkur.outcome': 'success' });`;
  expect(findSpanAttributeViolations('demo.test.ts', source)).toEqual([]);
  expect(findSpanAttributeViolations('demo.ts', source)).toHaveLength(1);
});

/**
 * The Rust edge cannot share the TypeScript type, so its span fields are cross-checked.
 * This is the drift nothing at runtime would detect.
 */
test('an unreviewed edge span field is refused', () => {
  const source = `
    let session_span = info_span!(
        "edge.session.splice",
        "merkur.session.id" = %preface.session_id,
        "merkur.invented" = %something,
    );
  `;

  const violations = findEdgeSpanFieldViolations('relay.rs', source);
  expect(violations).toHaveLength(1);
  expect(violations[0]?.detail).toBe('merkur.invented');
});

test('reviewed edge span fields pass, from both macro and instrument forms', () => {
  const macro = `
    let session_span = info_span!(
        "edge.session.splice",
        "merkur.session.id" = %preface.session_id,
        "merkur.peer.role" = ?preface.role,
    );
  `;
  expect(findEdgeSpanFieldViolations('relay.rs', macro)).toEqual([]);

  const instrument = `
    #[tracing::instrument(
        name = "edge.register.publish",
        skip_all,
        fields(edge_id = %self.edge_id, accepting_new_sessions, outcome)
    )]
  `;
  expect(findEdgeSpanFieldViolations('register.rs', instrument)).toEqual([]);
});
