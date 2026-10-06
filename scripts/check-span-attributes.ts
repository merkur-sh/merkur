import { readFileSync } from 'node:fs';
import path from 'node:path';

import { EDGE_SPAN_ATTRIBUTE_KEYS, SPAN_ATTRIBUTE_KEYS } from '@merkur/shared';
import { Glob } from 'bun';

import { blankNonCode, lineOf } from './source-scan';

const ROOT = path.resolve(import.meta.dir, '..');

/**
 * Span attribute enforcement, after the allow-list moved into the type system.
 *
 * # What changed, and why this file shrank
 *
 * The reviewed set of attribute keys — and now their value types — lives in
 * `packages/shared/src/span-attributes.ts`. `tsc` rejects an unknown key on an object
 * literal, rejects a wrong value type, and cannot express a computed key at all. That is
 * strictly stronger than anything a scanner over source text can do, and it replaced a
 * hand-maintained key list here.
 *
 * So this gate has exactly one job left: **make sure nobody goes around the types.** Two
 * escape hatches exist, and both are banned:
 *
 * - `Effect.annotateCurrentSpan(...)` called with anything other than `spanAttributes(...)`
 * - a bare `attributes: { … }` literal in span options
 *
 * That is a far more robust thing to pattern-match than a key set: it is a fixed pair of
 * call shapes rather than an open vocabulary.
 *
 * The third job is one types cannot do at all: the Rust edge sets span fields through
 * `tracing` and cannot share a TypeScript type, so its field names are cross-checked
 * against `EDGE_SPAN_ATTRIBUTE_KEYS` — the same "one vector, two implementations"
 * discipline the STUN ticket and `traceparent` already use, because nothing at runtime
 * detects drift between two implementations of a contract.
 */

const TYPESCRIPT_ROOTS = ['apps/server/src', 'apps/daemon/src', 'packages'] as const;

const EDGE_ROOT = 'apps/edge/src';

/** The single sanctioned way to build a typed attribute set. */
const SANCTIONED_CALL = 'spanAttributes(';
const ANNOTATE_MARKER = 'annotateCurrentSpan(';
const ATTRIBUTES_MARKER = 'attributes:';

/**
 * Test files are exempt from the call-shape rules.
 *
 * A test constructs fake spans to prove a tracer renders them; those attributes reach no
 * exporter and no backend. The types still apply wherever a test imports the helper, and
 * production code has no exemption — which is where the control actually matters.
 */
const TEST_FILE = /\.test\.tsx?$/;

export interface SpanAttributeViolation {
  readonly file: string;
  readonly line: number;
  readonly detail: string;
  readonly reason: string;
}

export function findSpanAttributeViolations(
  file: string,
  source: string,
): SpanAttributeViolation[] {
  if (TEST_FILE.test(file)) {
    return [];
  }

  const code = blankNonCode(source);
  const violations: SpanAttributeViolation[] = [];

  // `annotateCurrentSpan(` must be followed by `spanAttributes(`. Whitespace and newlines
  // between them are normal — the formatter breaks these calls across lines.
  let annotate = code.indexOf(ANNOTATE_MARKER);
  while (annotate !== -1) {
    const argument = code.slice(annotate + ANNOTATE_MARKER.length).trimStart();
    if (!argument.startsWith(SANCTIONED_CALL)) {
      violations.push({
        file,
        line: lineOf(source, annotate),
        detail: 'annotateCurrentSpan',
        reason:
          'span attributes must go through spanAttributes() so their keys and values are typed',
      });
    }
    annotate = code.indexOf(ANNOTATE_MARKER, annotate + 1);
  }

  // `attributes:` in span options must be `spanAttributes(`, never a bare literal.
  //
  // Only an object *literal* is a violation. `attributes:` also appears in type positions
  // (`attributes: Record<string, unknown>`) and when forwarding an existing value
  // (`{ attributes: snapshot.attributes }` in the metric snapshot), neither of which is a
  // span attribute set being written by hand.
  let attributes = code.indexOf(ATTRIBUTES_MARKER);
  while (attributes !== -1) {
    const value = code.slice(attributes + ATTRIBUTES_MARKER.length).trimStart();
    if (value.startsWith('{') && !value.startsWith(SANCTIONED_CALL)) {
      violations.push({
        file,
        line: lineOf(source, attributes),
        detail: 'attributes:',
        reason: 'a bare attributes literal bypasses the typed span attribute map',
      });
    }
    attributes = code.indexOf(ATTRIBUTES_MARKER, attributes + 1);
  }

  return violations;
}

const RUST_SPAN_FIELD = /"?([A-Za-z_][\w.]*)"?\s*=\s*[%?]?[a-z_]/g;
const RUST_INSTRUMENT_FIELDS = /fields\(([^)]*)\)/g;
const RUST_SPAN_MACROS = ['info_span!', 'debug_span!', 'warn_span!', 'error_span!'] as const;

/**
 * Span field names set by the Rust edge, cross-checked against the shared spec.
 *
 * Scans `*_span!` macros and `#[tracing::instrument]` field lists. Over-collecting is safe:
 * an extra name only makes the gate stricter, and every name it finds must be reviewed.
 */
export function findEdgeSpanFieldViolations(
  file: string,
  source: string,
): SpanAttributeViolation[] {
  const allowed = new Set<string>(EDGE_SPAN_ATTRIBUTE_KEYS);
  const violations: SpanAttributeViolation[] = [];
  const seen = new Set<string>();

  const record = (name: string, offset: number): void => {
    if (allowed.has(name) || seen.has(name)) return;
    seen.add(name);
    violations.push({
      file,
      line: lineOf(source, offset),
      detail: name,
      reason: 'edge span field is not in EDGE_SPAN_ATTRIBUTE_KEYS in packages/shared',
    });
  };

  for (const macro of RUST_SPAN_MACROS) {
    let index = source.indexOf(macro);
    while (index !== -1) {
      const end = source.indexOf(');', index);
      const region = source.slice(index, end === -1 ? source.length : end);
      RUST_SPAN_FIELD.lastIndex = 0;
      let match = RUST_SPAN_FIELD.exec(region);
      while (match !== null) {
        if (match[1] !== undefined) record(match[1], index + match.index);
        match = RUST_SPAN_FIELD.exec(region);
      }
      index = source.indexOf(macro, index + 1);
    }
  }

  RUST_INSTRUMENT_FIELDS.lastIndex = 0;
  let instrument = RUST_INSTRUMENT_FIELDS.exec(source);
  while (instrument !== null) {
    for (const raw of (instrument[1] ?? '').split(',')) {
      const name = raw.split('=')[0]?.trim();
      if (name !== undefined && name.length > 0) record(name, instrument.index);
    }
    instrument = RUST_INSTRUMENT_FIELDS.exec(source);
  }

  return violations;
}

export function scanSpanAttributes(): SpanAttributeViolation[] {
  const violations: SpanAttributeViolation[] = [];

  const typescript = new Glob('**/*.{ts,tsx}');
  for (const root of TYPESCRIPT_ROOTS) {
    const absoluteRoot = path.join(ROOT, root);
    for (const relative of typescript.scanSync({ cwd: absoluteRoot, absolute: false })) {
      if (relative.includes('node_modules')) continue;
      const file = path.join(root, relative);
      violations.push(
        ...findSpanAttributeViolations(file, readFileSync(path.join(ROOT, file), 'utf8')),
      );
    }
  }

  const rust = new Glob('**/*.rs');
  const edgeRoot = path.join(ROOT, EDGE_ROOT);
  for (const relative of rust.scanSync({ cwd: edgeRoot, absolute: false })) {
    const file = path.join(EDGE_ROOT, relative);
    violations.push(
      ...findEdgeSpanFieldViolations(file, readFileSync(path.join(ROOT, file), 'utf8')),
    );
  }

  return violations;
}

if (import.meta.main) {
  const violations = scanSpanAttributes();
  if (violations.length > 0) {
    for (const violation of violations) {
      process.stdout.write(
        `${violation.file}:${violation.line} ${violation.detail} — ${violation.reason}\n`,
      );
    }
    process.stdout.write(`\n${violations.length} span attribute violation(s).\n`);
    process.exit(1);
  }
  process.stdout.write(
    `span attributes ok (${SPAN_ATTRIBUTE_KEYS.length} typed keys, ${EDGE_SPAN_ATTRIBUTE_KEYS.length} edge fields)\n`,
  );
}
