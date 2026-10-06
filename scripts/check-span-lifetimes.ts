import { readFileSync } from 'node:fs';
import path from 'node:path';

import { Glob } from 'bun';

import { blankNonCode, lineOf } from './source-scan';

const ROOT = path.resolve(import.meta.dir, '..');

/**
 * Effect-using source roots. The browser is excluded on purpose: it exports no
 * OTLP telemetry and `check:latency-boundaries` already forbids Effect there.
 */
const DEFAULT_ROOTS = ['apps/server/src', 'apps/daemon/src'] as const;

/**
 * Combinators that make an effect run until it is interrupted rather than until
 * it finishes.
 *
 * `Effect.retry` is deliberately absent. A retried effect stops on its first
 * success, so a span around one is bounded in the happy path, and listing it
 * would flag every resilient call site in the repo.
 */
const UNBOUNDED_MARKERS = [
  'Effect.forever',
  'Effect.repeat(',
  'Schedule.forever',
  'waitForProcessSignal',
] as const;

const SPAN_MARKER = 'Effect.withSpan(';

export interface SpanLifetimeViolation {
  readonly file: string;
  readonly line: number;
  readonly span: string;
  readonly marker: string;
}

const OPENERS = '([{';
const CLOSERS = ')]}';

/** Forward-scan from an opening delimiter to its match. Returns the close index. */
function matchForward(code: string, open: number): number {
  let depth = 0;
  for (let index = open; index < code.length; index += 1) {
    const char = code[index] ?? '';
    if (OPENERS.includes(char)) depth += 1;
    else if (CLOSERS.includes(char)) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return code.length - 1;
}

/**
 * Backward-scan the expression a `.pipe(` is applied to.
 *
 * This is what catches a span wrapped around a program that never returns —
 * the marker lives in the *subject* (`Effect.gen(function* () { … })`), not in
 * the pipe's arguments, so scanning arguments alone misses it entirely. That
 * was the `server.runtime` shape.
 */
function subjectStart(code: string, dotIndex: number): number {
  let index = dotIndex - 1;
  let depth = 0;
  while (index >= 0) {
    const char = code[index] ?? '';
    if (CLOSERS.includes(char)) depth += 1;
    else if (OPENERS.includes(char)) {
      if (depth === 0) return index + 1;
      depth -= 1;
    } else if (depth === 0 && /[;\n]/.test(char)) {
      const before = code.slice(Math.max(0, index - 200), index);
      if (/[=>]\s*$/.test(before) || char === ';') return index + 1;
    }
    index -= 1;
  }
  return 0;
}

/**
 * Read the span name from the ORIGINAL source, not the blanked copy — string
 * contents are spaces there, so slicing the blanked text yields whitespace.
 * Delimiter matching still runs on the blanked copy, which is the whole point.
 */
function spanName(code: string, source: string, absoluteSpanIndex: number): string {
  const open = code.indexOf('(', absoluteSpanIndex);
  const close = matchForward(code, open);
  return (
    source
      .slice(open + 1, close)
      .split(',')[0]
      ?.trim() || '<dynamic>'
  );
}

/**
 * Report every `Effect.withSpan` composed with an effect that never returns.
 *
 * # Why this exists
 *
 * A span around a non-returning effect never ends, so it never exports. The
 * work it was meant to describe is simply absent from the backend, for the life
 * of the process.
 *
 * It was once worse than that. The tracer then in use published the current
 * span into OpenTelemetry's global context and never cleared it, so an
 * unbounded span also became the ambient parent of everything that followed:
 * a single trace id held 66,005 records across 45 distinct operations over 12.7
 * hours, including every inbound HTTP request, and traces had no root because
 * the root was still open. That second failure mode is gone — nothing publishes
 * into a global context any more — but the first is intrinsic, and neither
 * `check:types` nor `check:lint` nor any test can see it. It is visible only as
 * a hole in the backend, which is exactly the class of drift this repo already
 * gates for IPC key sets and profiling field names.
 *
 * The rule is syntactic and narrow on purpose: a `.pipe()` whose subject or
 * arguments contain an unbounded combinator must not also carry `Effect.withSpan`.
 * Wrap the repeated unit of work instead, and mark it `{ root: true }`.
 */
export function findSpanLifetimeViolations(
  roots: readonly string[] = DEFAULT_ROOTS,
): SpanLifetimeViolation[] {
  const violations: SpanLifetimeViolation[] = [];

  for (const root of roots) {
    const absoluteRoot = path.resolve(ROOT, root);
    for (const relativeFile of new Glob('**/*.ts').scanSync(absoluteRoot)) {
      if (relativeFile.includes('.test.')) continue;
      const file = path.join(absoluteRoot, relativeFile);
      const source = readFileSync(file, 'utf8');
      if (!source.includes(SPAN_MARKER)) continue;
      const code = blankNonCode(source);

      for (
        let cursor = code.indexOf('.pipe(');
        cursor !== -1;
        cursor = code.indexOf('.pipe(', cursor + 1)
      ) {
        const open = code.indexOf('(', cursor);
        const close = matchForward(code, open);
        const start = subjectStart(code, cursor);
        const region = code.slice(start, close + 1);
        const spanIndex = region.indexOf(SPAN_MARKER);
        if (spanIndex === -1) continue;
        const marker = UNBOUNDED_MARKERS.find((candidate) => region.includes(candidate));
        if (marker === undefined) continue;
        const absoluteSpanIndex = start + spanIndex;
        violations.push({
          file: path.relative(ROOT, file).split(path.sep).join('/'),
          line: lineOf(source, absoluteSpanIndex),
          span: spanName(code, source, absoluteSpanIndex),
          marker,
        });
      }
    }
  }

  return violations.sort((left, right) =>
    `${left.file}:${left.line}`.localeCompare(`${right.file}:${right.line}`),
  );
}

if (import.meta.main) {
  const violations = findSpanLifetimeViolations(
    process.argv.length > 2 ? process.argv.slice(2) : DEFAULT_ROOTS,
  );
  if (violations.length === 0) {
    process.stdout.write('span lifetimes: pass (no trace span wraps a non-returning effect)\n');
  } else {
    process.stderr.write(
      `${violations
        .map(
          (violation) =>
            `span lifetime violation: ${violation.span} at ${violation.file}:${violation.line}\n` +
            `  composed with ${violation.marker}, which never returns, so the span never ends and never exports.\n` +
            `  Wrap the repeated unit of work instead and mark it { root: true }.`,
        )
        .join('\n')}\n`,
    );
    process.exit(1);
  }
}
