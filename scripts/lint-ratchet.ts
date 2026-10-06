/**
 * The engine of the lint ratchets, `check:slop` and `rust:lint`. A gate
 * measures findings, each a rule broken at a place in a file, and this module holds it to a
 * committed baseline that pins, per file and per rule, how many the code carries. A count only
 * goes down.
 *
 * A file or rule the baseline does not name is allowed no finding. A count above its entry fails
 * with each finding and its message, which is the repair instruction. A count below its entry,
 * or an entry for a file that is gone, fails too until the gate's `--tighten` lowers it, so the
 * baseline never drifts above the code. `--write-baseline` writes the whole baseline once, for
 * adoption, and is refused while the file exists.
 *
 * The verdicts are pure: `judge`, `tighten` and `adopt` return what a run prints and exits with,
 * and `runTree` is those three over a baseline file on disk. What a gate cannot answer it throws
 * as an `UnverifiedError`; `main` reports it as unverified, never as a pass.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Option, Schema } from 'effect';

/** What tells one gate's output from another's. */
export interface RatchetGate {
  /** The package script, which opens every line the gate prints: `check:slop`. */
  readonly name: string;
  /** The baseline file, repo-relative. */
  readonly baseline: string;
  /** What the summary calls the findings the baseline counts. */
  readonly counted: string;
  /** The sentence that says where each rule is stated. */
  readonly rules: string;
}

/** One breach of a rule, addressed the way an editor opens it. */
export interface Finding {
  readonly file: string;
  readonly rule: string;
  readonly line: number;
  readonly column: number;
  readonly message: string;
}

/** Findings per rule, per repo-relative posix path. A zero count is never stored. */
export type RatchetCounts = ReadonlyMap<string, ReadonlyMap<string, number>>;

export interface RatchetViolation {
  readonly file: string;
  readonly rule: string;
  readonly kind: 'raised' | 'loose' | 'gone';
  readonly allowed: number;
  readonly found: number;
}

/** The files a run answers for, and which of them are still on disk. */
export interface RatchetScope {
  readonly inScope: (file: string) => boolean;
  readonly exists: (file: string) => boolean;
}

/** What a gate fails on its own account, which no baseline entry can allow. */
export interface Failures {
  /** The FAIL sections, empty when there is nothing. */
  readonly sections: string;
  /** What the summary says of them, with its leading comma; empty when there is nothing. */
  readonly clause: string;
}

/** What one run of a gate measured. */
export interface Measurement {
  readonly findings: readonly Finding[];
  readonly failures: Failures;
}

/** What a run prints and exits with. */
export interface Verdict {
  readonly output: string;
  readonly code: number;
}

/** A verdict that comes with the baseline to write before it is printed. */
export interface Rewrite extends Verdict {
  readonly counts: Map<string, Map<string, number>>;
}

/** The modes of a run over the whole tree. */
export type TreeMode = 'check' | 'tighten' | 'write-baseline';

/** A run that could not answer. */
export class UnverifiedError extends Error {}

export const NO_FAILURES: Failures = { sections: '', clause: '' };

/** `{ file: { rule: count } }` with positive counts: the entries of a baseline file. */
export const BaselineEntries = Schema.Record(
  Schema.String,
  Schema.Record(Schema.String, Schema.Int.check(Schema.isGreaterThan(0))),
);

export type BaselineEntries = typeof BaselineEntries.Type;

const BaselineJson = Schema.fromJsonString(BaselineEntries);

export function order(left: string, right: string): number {
  if (left < right) return -1;

  return left > right ? 1 : 0;
}

/** Why `--write-baseline` will not run, as the line to print, or null when no baseline exists. */
export function adoptionRefusal(gate: RatchetGate, baselineExists: boolean): string | null {
  return baselineExists
    ? `${gate.name}: refused: ${gate.baseline}: a baseline exists; lower it with --tighten. Re-adoption means deleting the file first\n`
    : null;
}

export function foldFindings(findings: readonly Finding[]): Map<string, Map<string, number>> {
  const counts = new Map<string, Map<string, number>>();

  for (const finding of findings) {
    const rules = counts.get(finding.file) ?? new Map<string, number>();
    rules.set(finding.rule, (rules.get(finding.rule) ?? 0) + 1);
    counts.set(finding.file, rules);
  }

  return counts;
}

export function countsOf(entries: BaselineEntries): Map<string, Map<string, number>> {
  const counts = new Map<string, Map<string, number>>();

  for (const [file, rules] of Object.entries(entries)) {
    counts.set(file, new Map(Object.entries(rules)));
  }

  return counts;
}

/** Files and rules in code-unit order, with no zero count and no file left without a rule. */
export function entriesOf(counts: RatchetCounts): BaselineEntries {
  const files = [...counts.keys()].sort(order).flatMap((file) => {
    const rules = counts.get(file) ?? new Map<string, number>();

    const entries = [...rules.keys()].sort(order).flatMap((rule) => {
      const count = rules.get(rule) ?? 0;

      return count > 0 ? [[rule, count] as const] : [];
    });

    return entries.length > 0 ? [[file, Object.fromEntries(entries)] as const] : [];
  });

  return Object.fromEntries(files);
}

export function parseBaseline(gate: RatchetGate, text: string): Map<string, Map<string, number>> {
  const entries = Option.getOrNull(Schema.decodeOption(BaselineJson)(text));

  if (entries === null) {
    throw new UnverifiedError(
      `${gate.baseline} is not { file: { rule: count } } with positive counts`,
    );
  }

  return countsOf(entries);
}

/** One key order, two-space JSON, one trailing newline: what Biome keeps. */
export function formatBaseline(counts: RatchetCounts): string {
  return `${JSON.stringify(entriesOf(counts), null, 2)}\n`;
}

/** Today's counts measured against the baseline, limited to the files the scope accepts. */
export function compareCounts(
  current: RatchetCounts,
  baseline: RatchetCounts,
  scope: RatchetScope,
): RatchetViolation[] {
  const violations: RatchetViolation[] = [];

  for (const [file, rules] of current) {
    if (!scope.inScope(file)) continue;

    for (const [rule, found] of rules) {
      const allowed = baseline.get(file)?.get(rule) ?? 0;

      if (found > allowed) violations.push({ file, rule, kind: 'raised', allowed, found });
      else if (found < allowed) violations.push({ file, rule, kind: 'loose', allowed, found });
    }
  }

  for (const [file, rules] of baseline) {
    if (!scope.inScope(file)) continue;

    const kind = scope.exists(file) ? 'loose' : 'gone';

    for (const [rule, allowed] of rules) {
      if (current.get(file)?.has(rule) === true) continue;

      violations.push({ file, rule, kind, allowed, found: 0 });
    }
  }

  return violations.sort(
    (left, right) => order(left.file, right.file) || order(left.rule, right.rule),
  );
}

/** Lower every entry to today's count and drop the ones with no finding left. Never adds or raises. */
export function tightenCounts(
  current: RatchetCounts,
  baseline: RatchetCounts,
): Map<string, Map<string, number>> {
  const next = new Map<string, Map<string, number>>();

  for (const [file, rules] of baseline) {
    const kept = new Map<string, number>();

    for (const [rule, allowed] of rules) {
      const found = current.get(file)?.get(rule) ?? 0;

      if (found > 0) kept.set(rule, Math.min(allowed, found));
    }

    if (kept.size > 0) next.set(file, kept);
  }

  return next;
}

function describe(violation: RatchetViolation): string {
  return `${violation.file}  ${violation.rule}  allowed ${violation.allowed}, found ${violation.found}`;
}

/** `file:line:column rule — message`, the line a finding above the baseline is printed as. */
function address(finding: Finding): string {
  return `${finding.file}:${finding.line}:${finding.column} ${finding.rule} — ${finding.message}`;
}

/** The FAIL sections of a run, empty when nothing is violated. */
export function renderViolations(
  gate: RatchetGate,
  violations: readonly RatchetViolation[],
  findings: readonly Finding[],
): string {
  const raised: string[] = [];
  const slack: string[] = [];

  for (const violation of violations) {
    if (violation.kind !== 'raised') {
      slack.push(`  ${violation.kind.padEnd(5)}  ${describe(violation)}`);
      continue;
    }

    raised.push(`  ${describe(violation)}`);

    const located = findings
      .filter((finding) => finding.file === violation.file && finding.rule === violation.rule)
      .sort((left, right) => left.line - right.line || left.column - right.column);

    for (const finding of located) raised.push(`    ${address(finding)}`);
  }

  const sections: string[] = [];

  if (raised.length > 0) {
    sections.push(
      `FAIL  findings above the baseline (${gate.baseline}):`,
      ...raised,
      `  The baseline is never raised: a finding is fixed by changing the code. ${gate.rules}`,
    );
  }

  if (slack.length > 0) {
    sections.push(
      `FAIL  baseline above the code; run \`bun run ${gate.name} --tighten\`:`,
      ...slack,
    );
  }

  return sections.map((line) => `${line}\n`).join('');
}

/** `N findings in M files, baseline B` over the files the scope accepts. */
export function summarize(
  gate: RatchetGate,
  current: RatchetCounts,
  baseline: RatchetCounts,
  inScope: (file: string) => boolean,
): string {
  let findings = 0;
  let files = 0;
  let allowed = 0;

  for (const [file, rules] of current) {
    if (!inScope(file)) continue;

    files += 1;

    for (const count of rules.values()) findings += count;
  }

  for (const [file, rules] of baseline) {
    if (!inScope(file)) continue;

    for (const count of rules.values()) allowed += count;
  }

  return `${findings} ${gate.counted} in ${files} files, baseline ${allowed}`;
}

/** A check: the measurement of `subject` against the baseline, over the files the scope accepts. */
export function judge(
  gate: RatchetGate,
  subject: string,
  measured: Measurement,
  baseline: RatchetCounts,
  scope: RatchetScope,
): Verdict {
  const { findings, failures } = measured;
  const current = foldFindings(findings);
  const violations = compareCounts(current, baseline, scope);
  const failed = violations.length > 0 || failures.sections !== '';
  const summary = `${summarize(gate, current, baseline, scope.inScope)}${failures.clause}`;

  return {
    code: failed ? 1 : 0,
    output: [
      `${gate.name}: ${subject} against ${gate.baseline}\n`,
      renderViolations(gate, violations, findings),
      failures.sections,
      `${gate.name}: ${failed ? 'FAIL' : 'pass'} (${summary})\n`,
    ].join(''),
  };
}

/** `--tighten`: the lowered baseline, and a failure for every entry it would have had to raise or add. */
export function tighten(
  gate: RatchetGate,
  measured: Measurement,
  baseline: RatchetCounts,
  exists: (file: string) => boolean,
): Rewrite {
  const { findings, failures } = measured;
  const current = foldFindings(findings);
  const everything = { inScope: () => true, exists };
  const slack = compareCounts(current, baseline, everything);
  const lowered = slack.filter((violation) => violation.kind !== 'raised').length;
  const counts = tightenCounts(current, baseline);
  const wrote = `${gate.name}: wrote ${gate.baseline} (${lowered} entries lowered or removed)\n`;

  // After tightening only the entries it refused to raise or add are left.
  const refused = compareCounts(current, counts, everything);

  if (refused.length === 0 && failures.sections === '') return { counts, code: 0, output: wrote };

  const summary = `${summarize(gate, current, counts, everything.inScope)}${failures.clause}`;

  return {
    counts,
    code: 1,
    output: [
      wrote,
      renderViolations(gate, refused, findings),
      failures.sections,
      `${gate.name}: FAIL (--tighten never raises or adds an entry; ${summary})\n`,
    ].join(''),
  };
}

/** `--write-baseline`: the whole baseline from one measurement. A gate's own failures are never part of it. */
export function adopt(gate: RatchetGate, measured: Measurement): Rewrite {
  const { findings, failures } = measured;
  const counts = foldFindings(findings);
  const summary = `${summarize(gate, counts, counts, () => true)}${failures.clause}`;

  return {
    counts,
    code: failures.sections === '' ? 0 : 1,
    output: `${gate.name}: wrote ${gate.baseline} (${summary})\n${failures.sections}`,
  };
}

export function readBaselineFile(root: string, gate: RatchetGate): string {
  const file = path.join(root, gate.baseline);

  if (!existsSync(file)) {
    throw new UnverifiedError(`${gate.baseline} is missing; run --write-baseline`);
  }

  return readFileSync(file, 'utf8');
}

export function writeBaselineFile(root: string, gate: RatchetGate, text: string): void {
  const file = path.join(root, gate.baseline);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
}

/** Prints a verdict and returns its exit code. */
export function conclude(verdict: Verdict): number {
  process.stdout.write(verdict.output);

  return verdict.code;
}

/**
 * One run over the whole tree of a gate whose baseline file holds the entries alone, with the
 * baseline written before the verdict is returned. `measure` is the gate's own work, and it is
 * not asked for when `--write-baseline` is refused.
 */
export async function runTree(
  gate: RatchetGate,
  root: string,
  mode: TreeMode,
  measure: () => Promise<Measurement>,
): Promise<Verdict> {
  const exists = (file: string): boolean => existsSync(path.join(root, file));

  if (mode === 'write-baseline') {
    const refusal = adoptionRefusal(gate, exists(gate.baseline));

    if (refusal !== null) return { output: refusal, code: 1 };

    const adopted = adopt(gate, await measure());
    writeBaselineFile(root, gate, formatBaseline(adopted.counts));

    return adopted;
  }

  const measured = await measure();
  const baseline = parseBaseline(gate, readBaselineFile(root, gate));

  if (mode === 'tighten') {
    const tightened = tighten(gate, measured, baseline, exists);
    writeBaselineFile(root, gate, formatBaseline(tightened.counts));

    return tightened;
  }

  return judge(gate, 'working tree', measured, baseline, { inScope: () => true, exists });
}

/** The one mode the arguments select, `fallback` when there is none. */
export function selectMode<Mode>(
  argv: readonly string[],
  modes: ReadonlyMap<string, Mode>,
  fallback: Mode,
): Mode {
  let mode = fallback;

  for (const argument of argv) {
    const selected = modes.get(argument);

    if (selected === undefined) {
      throw new UnverifiedError(`unknown argument ${argument}; see the header of this script`);
    }

    mode = selected;
  }

  return mode;
}

/** Runs a gate to its exit code. A run that could not answer exits 1 as unverified. */
export async function main(gate: RatchetGate, run: () => Promise<number>): Promise<never> {
  let code: number;

  try {
    code = await run();
  } catch (error) {
    if (!(error instanceof UnverifiedError)) throw error;

    process.stdout.write(`${gate.name}: unverified: ${error.message}\n`);
    code = 1;
  }

  process.exit(code);
}
