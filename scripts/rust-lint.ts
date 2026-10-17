/**
 * `rust:lint`: Clippy over every first-party Rust target, each finding sorted into exactly one of
 * three classes by its lint and its file (`classify`).
 *
 *   bazel test //:rust_lint                          the workspace against the baseline (CI)
 *   bazel run //:rust_lint -- --tighten              lower or drop entries to today's counts; never
 *                                                    raises or adds one
 *   bazel run //:rust_lint -- --write-baseline       write the whole baseline from this tree; for
 *                                                    adoption only, refused while a baseline exists
 *
 * Bazel runs Clippy as an aspect on every first-party target, a test's included, through
 * `//tools/bazel/rust:clippy.bzl`: per crate, cached like any other action, and in the
 * configuration the target builds in. A test that builds with merkur-e2e's `testing` feature is
 * linted with it. Each package's `:clippy_diagnostics` holds its targets' rustc JSON diagnostics,
 * and `//:clippy_diagnostics` names every package's in one manifest, with the flags Clippy ran
 * with; this script reads exactly those files.
 *
 * Zero: a finding nothing allows. Every warning or error that is not a ratcheted lint is one,
 * in every first-party crate, the vendored members included: the compiler's own warnings,
 * Clippy's default lints, the lints of `[workspace.lints]` in `Cargo.toml`, and an `#[expect]`
 * whose lint no longer fires. So is a panic lint in a crate that parses bytes an attacker
 * controls (`PANIC_FREE`), in its tests as in the rest of it, and a timer call in a module on a
 * latency path: `clippy.toml` lists the calls, the workspace allows them, and each such module
 * denies them at the head of its file. Each is printed as the compiler rendered it, suggestion
 * included.
 *
 * Bazel lints the first-party targets and nothing else, so a `[patch]` crate that crate_universe
 * builds is never read.
 *
 * Baseline: the ratcheted lints, which no Cargo manifest enables and `.bazelrc` hands to Clippy
 * as warnings, exactly `RATCHETED_LINTS`, which the manifest's flags must equal. `lint-baselines/clippy.json` pins their findings per file and per lint under the
 * rules of `scripts/lint-ratchet.ts`: a file or lint it does not name is allowed nothing, a count
 * above its entry fails with each finding, and a count below it fails until `--tighten`. The
 * `WHOLE_TREE` lints count in every first-party file, the panic lints in the crates of
 * `PANIC_RATCHETED`.
 *
 * Ignored: a ratcheted lint in a vendored crate (`packages/*-patch/`), a timer call there (a
 * vendored crate does not take the workspace's lint levels), and a panic lint outside the
 * panic-free and the panic-ratcheted crates.
 *
 * Clippy runs with `--cap-lints warn`, so no lint stops a crate and one run reports the whole
 * workspace; this script, not the compiler, is what fails. A crate that does not compile fails
 * the build before this script runs. A finding is counted once however
 * many targets report it, at its primary span, or, when that span lies in a macro of another
 * crate, at the nearest place in this repository that expanded it.
 *
 * Code under `#[cfg(target_os = …)]` is linted only where it compiles, so the counts differ by
 * platform. The baseline records the host triple it was adopted on and is compared only on that
 * host. On any other host a run enforces the zero class, says in one line that the baseline was
 * not compared, and `--tighten` is refused.
 *
 * A manifest line it does not define, a diagnostics file that is not rustc's JSON, and a
 * diagnostic with no lint code or no place in this repository fail as unverified, never as a pass, after what the
 * compiler did report is printed. rustc closes each file with a count of its warnings, which is
 * read as that count and nothing else.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { Option, Schema } from 'effect';

import {
  adopt,
  adoptionRefusal,
  BaselineEntries,
  conclude,
  countsOf,
  entriesOf,
  type Failures,
  type Finding,
  judge,
  type Measurement,
  main,
  NO_FAILURES,
  order,
  type RatchetCounts,
  type RatchetGate,
  readBaselineFile,
  selectMode,
  type TreeMode,
  tighten,
  UnverifiedError,
  type Verdict,
  writeBaselineFile,
} from './lint-ratchet';

const ROOT = path.resolve(import.meta.dir, '..');

const GATE: RatchetGate = {
  name: 'rust:lint',
  baseline: 'lint-baselines/clippy.json',
  counted: 'baselined findings',
  rules: '`cargo clippy --explain <lint>` states each lint.',
};

/** Lints counted in every first-party file. */
const WHOLE_TREE: ReadonlySet<string> = new Set([
  'clippy::map_err_ignore',
  'clippy::let_underscore_must_use',
  'clippy::unwrap_in_result',
  'clippy::panic',
  'clippy::cast_possible_truncation',
  'clippy::cast_sign_loss',
  'clippy::cast_possible_wrap',
  'clippy::too_many_lines',
  // `.ok();` drops the error of a `Result` and says nothing about it.
  'clippy::unused_result_ok',
  // `_ =>` over an enum takes every variant added later without a decision.
  'clippy::wildcard_enum_match_arm',
]);

/** The panic lints: the forms of panic the panic-free crates deny. */
const PANIC_LINTS: ReadonlySet<string> = new Set([
  'clippy::indexing_slicing',
  'clippy::unwrap_used',
  'clippy::expect_used',
  'clippy::panic',
  'clippy::unreachable',
  'clippy::string_slice',
  'clippy::unwrap_in_result',
  'clippy::get_unwrap',
]);

/** The crates that parse bytes an attacker controls; their `lib.rs` denies the panic lints. */
const PANIC_FREE = [
  'packages/merkur-wire/',
  'packages/merkur-stun-protocol/',
  'packages/merkur-edge-protocol/',
];

/** The crates whose panic lints the baseline counts. */
const PANIC_RATCHETED = [
  'packages/merkur-codec/',
  'packages/merkur-fec/',
  'packages/merkur-e2e/',
  'apps/stun/',
  'apps/edge/',
];

const VENDORED_CRATE = /^packages\/[^/]+-patch\//;

/** The lint that reports a call `clippy.toml` lists: the timer calls. */
const TIMER_LINT = 'clippy::disallowed_methods';

/** Each ratcheted lint once, in the order Clippy is handed them. */
export const RATCHETED_LINTS: readonly string[] = [
  ...new Set([...WHOLE_TREE, ...PANIC_LINTS]),
].sort(order);

const ZERO_RULE =
  'A compiler warning, a default or workspace Clippy lint, a panic lint in a panic-free crate and a timer call on a latency path have no baseline: fix the code, or expect the lint where it fires with `#[expect(lint, reason = "…")]`.';

export type LintClass = 'zero' | 'baseline' | 'ignored';

/** A finding with the compiler's own rendering of it, which carries the suggestion. */
export interface ClippyFinding extends Finding {
  readonly rendered: string;
}

/** The findings of one run by class; an ignored finding is in neither list. */
export interface Classes {
  readonly zero: readonly ClippyFinding[];
  readonly baselined: readonly ClippyFinding[];
}

/** What one Clippy run reported. */
export interface ClippyRun {
  /** Each located diagnostic once, however many targets reported it. */
  readonly findings: readonly ClippyFinding[];
  /** Diagnostics with no lint code or no place in this repository, as the compiler rendered them. */
  readonly unplaced: readonly string[];
}

/** The baseline's counts and the host they were measured on. */
export interface ClippyBaseline {
  readonly host: string;
  readonly counts: Map<string, Map<string, number>>;
}

interface SpanJson {
  readonly file_name: string;
  readonly line_start: number;
  readonly column_start: number;
  readonly is_primary: boolean;
  readonly expansion: ExpansionJson | null;
}

/** The macro call a span was expanded from; `span` is the call site. */
interface ExpansionJson {
  readonly span: SpanJson;
}

const Span: Schema.Codec<SpanJson> = Schema.Struct({
  file_name: Schema.String,
  line_start: Schema.Int,
  column_start: Schema.Int,
  is_primary: Schema.Boolean,
  expansion: Schema.NullOr(
    Schema.Struct({ span: Schema.suspend((): Schema.Codec<SpanJson> => Span) }),
  ),
});

/**
 * One line of rustc's `--error-format=json`. A `diagnostic` carries the rest; an `artifact` names
 * a file rustc wrote and is passed over.
 */
const RustcRecord = Schema.fromJsonString(
  Schema.Struct({
    $message_type: Schema.String,
    level: Schema.optionalKey(Schema.String),
    message: Schema.optionalKey(Schema.String),
    rendered: Schema.optionalKey(Schema.NullOr(Schema.String)),
    code: Schema.optionalKey(Schema.NullOr(Schema.Struct({ code: Schema.String }))),
    spans: Schema.optionalKey(Schema.Array(Span)),
  }),
);

const BaselineJson = Schema.fromJsonString(
  Schema.Struct({ host: Schema.String, files: BaselineEntries }),
);

/** rustc's closing count of the warnings it emitted for one crate. */
const WARNING_COUNT = /^(\d+) warnings? emitted$/;

/** The one class of a finding, from its lint code and its repo-relative file. */
export function classify(code: string, file: string): LintClass {
  const panic = PANIC_LINTS.has(code);
  const wholeTree = WHOLE_TREE.has(code);

  // First-party code reports a timer only where a module denies it; a vendored crate reports
  // every one, at Clippy's default level.
  if (code === TIMER_LINT) return VENDORED_CRATE.test(file) ? 'ignored' : 'zero';

  if (!panic && !wholeTree) return 'zero';

  if (VENDORED_CRATE.test(file)) return 'ignored';

  if (panic && PANIC_FREE.some((crate) => file.startsWith(crate))) return 'zero';

  if (wholeTree) return 'baseline';

  return PANIC_RATCHETED.some((crate) => file.startsWith(crate)) ? 'baseline' : 'ignored';
}

export function sortFindings(findings: readonly ClippyFinding[]): Classes {
  const zero: ClippyFinding[] = [];
  const baselined: ClippyFinding[] = [];

  for (const finding of findings) {
    const lintClass = classify(finding.rule, finding.file);

    if (lintClass === 'zero') zero.push(finding);
    else if (lintClass === 'baseline') baselined.push(finding);
  }

  return { zero, baselined };
}

/** What Clippy must run with: each ratcheted lint as a warning, and nothing else. */
export const CLIPPY_FLAGS: readonly string[] = RATCHETED_LINTS.map((lint) => `-W${lint}`);

/** What `//:clippy_diagnostics` writes: the flags Clippy ran with and every diagnostics file. */
export interface ClippyManifest {
  readonly flags: readonly string[];
  readonly files: readonly string[];
}

const MANIFEST_LINE = /^(flag|file) (.+)$/;

/**
 * The manifest's `flag` and `file` lines, its files by their path in the checkout. A line of
 * another kind makes the run no answer, and so does any flag set but `CLIPPY_FLAGS`: `.bazelrc`
 * hands Clippy the ratcheted lints, and one missing there would read as every file fixed.
 */
export function readManifest(text: string): ClippyManifest {
  const flags: string[] = [];
  const files: string[] = [];

  for (const line of text.split('\n')) {
    if (line === '') continue;

    const match = line.match(MANIFEST_LINE);

    if (match?.[1] === undefined || match[2] === undefined) {
      throw new UnverifiedError(`the Clippy manifest holds a line it does not define: ${line}`);
    }

    (match[1] === 'flag' ? flags : files).push(match[2]);
  }

  const missing = CLIPPY_FLAGS.filter((flag) => !flags.includes(flag));
  const extra = flags.filter((flag) => !CLIPPY_FLAGS.includes(flag));

  if (missing.length > 0 || extra.length > 0) {
    throw new UnverifiedError(
      `Clippy ran with flags other than the ratchet's (missing: ${missing.join(' ') || 'none'}; extra: ${extra.join(' ') || 'none'}); .bazelrc passes exactly RATCHETED_LINTS`,
    );
  }

  if (files.length === 0) throw new UnverifiedError('the Clippy manifest names no diagnostics');

  return { flags, files: [...files].sort(order) };
}

/**
 * A span's file as a repo-relative posix path, or null when it lies outside the repository: in
 * an external repository, a Bazel output or the toolchain's sources.
 */
function repoFile(name: string, root: string): string | null {
  const relative = path.relative(root, path.resolve(root, name)).split(path.sep).join('/');

  if (relative.startsWith('..') || path.isAbsolute(relative)) return null;

  if (relative.startsWith('external/') || relative.startsWith('bazel-out/')) return null;

  return relative;
}

/**
 * Where a diagnostic is: its span, or, when the span lies in a macro of another crate, the
 * nearest call site in this repository. Null when no site of the expansion is in the repository.
 */
function place(span: SpanJson, root: string): Pick<Finding, 'file' | 'line' | 'column'> | null {
  for (let at: SpanJson | undefined = span; at !== undefined; at = at.expansion?.span) {
    const file = repoFile(at.file_name, root);

    if (file !== null) return { file, line: at.line_start, column: at.column_start };
  }

  return null;
}

/**
 * The diagnostics files as findings. A library and its test target both report the same
 * diagnostic: a finding is one lint at one place. A line that is not rustc's JSON makes the run
 * unreadable. rustc's closing count of a file's warnings is that count, and is passed over only
 * when it equals the warnings the file reported before it.
 */
export function readClippy(texts: readonly string[], root: string): ClippyRun {
  const findings = new Map<string, ClippyFinding>();
  const unplaced: string[] = [];

  for (const text of texts) {
    let warnings = 0;

    for (const line of text.split('\n')) {
      if (line === '') continue;

      const record = Option.getOrNull(Schema.decodeOption(RustcRecord)(line));

      if (record === null) {
        throw new UnverifiedError(`rustc wrote a line that is not a diagnostic: ${line}`);
      }

      if (record.$message_type !== 'diagnostic') continue;

      const { level, message, spans } = record;

      if (level === undefined || message === undefined || spans === undefined) {
        throw new UnverifiedError(
          `rustc wrote a diagnostic with no level, message or spans: ${line}`,
        );
      }

      // rustc colours `rendered` for a terminal.
      const rendered = Bun.stripANSI(record.rendered ?? message);
      const rule = record.code?.code;
      const count = WARNING_COUNT.exec(message)?.[1];

      if (rule === undefined && spans.length === 0 && count === String(warnings)) continue;

      if (level === 'warning') warnings += 1;

      const primary = spans.find((span) => span.is_primary);
      const placed = primary === undefined ? null : place(primary, root);

      if (rule === undefined || placed === null) {
        unplaced.push(rendered);
        continue;
      }

      const key = `${rule}\0${placed.file}\0${placed.line}\0${placed.column}`;

      if (!findings.has(key)) findings.set(key, { ...placed, rule, message, rendered });
    }
  }

  return { findings: [...findings.values()], unplaced };
}

/** Why a run is no answer, or null when the build finished and every diagnostic was read. */
export function unverifiedReason(run: ClippyRun): string | null {
  if (run.unplaced.length === 0) return null;

  return `${run.unplaced.length} compiler messages carry no lint code or no place in this repository`;
}

/** The compiler's rendering of one diagnostic, set in under the line that heads it. */
function inset(rendered: string): string {
  return rendered
    .trimEnd()
    .split('\n')
    .map((line) => (line === '' ? '\n' : `    ${line}\n`))
    .join('');
}

/** The FAIL section for the diagnostics that could not be counted, empty when there is none. */
export function renderUnplaced(unplaced: readonly string[]): string {
  if (unplaced.length === 0) return '';

  return `FAIL  compiler messages with no lint code or no place in this repository:\n${unplaced.map(inset).join('')}`;
}

/**
 * The zero class as what a run fails on beside its baseline, and counts in its summary: each
 * finding under one line that places it, as the compiler rendered it.
 */
export function zeroFailures(zero: readonly ClippyFinding[]): Failures {
  if (zero.length === 0) return NO_FAILURES;

  const blocks = [...zero]
    .sort(
      (left, right) =>
        order(left.file, right.file) ||
        left.line - right.line ||
        left.column - right.column ||
        order(left.rule, right.rule),
    )
    .map(
      (finding) =>
        `  ${finding.file}:${finding.line}:${finding.column} ${finding.rule}\n${inset(finding.rendered)}`,
    );

  return {
    sections: `FAIL  findings no baseline allows:\n${blocks.join('')}  ${ZERO_RULE}\n`,
    clause: `, ${zero.length} findings no baseline allows`,
  };
}

/** A check on a host the baseline was not measured on: the zero class alone. */
export function judgeElsewhere(baselineHost: string, host: string, failures: Failures): Verdict {
  const failed = failures.sections !== '';
  const verdict = failed ? `FAIL (zero class only${failures.clause})` : 'pass (zero class only)';

  return {
    code: failed ? 1 : 0,
    output: [
      `rust:lint: ${GATE.baseline} is for ${baselineHost} and this host is ${host}: the baseline was not compared\n`,
      failures.sections,
      `rust:lint: ${verdict}\n`,
    ].join(''),
  };
}

/** Why `--tighten` will not run, as the line to print, or null on the host the baseline is for. */
export function tightenRefusal(baselineHost: string, host: string): string | null {
  return baselineHost === host
    ? null
    : `rust:lint: refused: ${GATE.baseline} is for ${baselineHost} and this host is ${host}; --tighten runs on the host the baseline is for\n`;
}

/** The Rust triple Bazel builds for on this host, which is the platform Clippy lints. */
export function hostTriple(platform: string, arch: string): string {
  const os = { darwin: 'apple-darwin', linux: 'unknown-linux-gnu' }[platform];
  const cpu = { arm64: 'aarch64', x64: 'x86_64' }[arch];

  if (os === undefined || cpu === undefined) {
    throw new UnverifiedError(`no Rust target for ${platform} on ${arch}`);
  }

  return `${cpu}-${os}`;
}

export function parseClippyBaseline(text: string): ClippyBaseline {
  const baseline = Option.getOrNull(Schema.decodeOption(BaselineJson)(text));

  if (baseline === null) {
    throw new UnverifiedError(
      `${GATE.baseline} is not { host, files: { file: { lint: count } } } with positive counts`,
    );
  }

  return { host: baseline.host, counts: countsOf(baseline.files) };
}

/** The host, then the entries in one key order; two-space JSON, one trailing newline: what Biome keeps. */
export function formatClippyBaseline(host: string, counts: RatchetCounts): string {
  return `${JSON.stringify({ host, files: entriesOf(counts) }, null, 2)}\n`;
}

function onDisk(file: string): boolean {
  return existsSync(path.join(ROOT, file));
}

/**
 * Where a rewritten baseline goes: the working tree `bazel run` names. The test reads a copy of
 * the tree, which a write would not reach.
 */
function workingTree(): string {
  const tree = process.env.BUILD_WORKSPACE_DIRECTORY;

  if (tree === undefined) {
    throw new UnverifiedError('a baseline is rewritten through `bazel run //:rust_lint -- <mode>`');
  }

  return tree;
}

/**
 * One Clippy run, as the manifest names its diagnostics: the baseline class as its findings, the
 * zero class as what fails it outright. What an unverified run did report is printed before the
 * run is given up, so a stray message is seen and not only counted.
 */
function measure(manifestFile: string): Measurement {
  const manifest = readManifest(readFileSync(path.join(ROOT, manifestFile), 'utf8'));
  const run = readClippy(
    manifest.files.map((file) => readFileSync(path.join(ROOT, file), 'utf8')),
    ROOT,
  );
  const classes = sortFindings(run.findings);
  const failures = zeroFailures(classes.zero);
  const reason = unverifiedReason(run);

  if (reason !== null) {
    process.stdout.write(`${failures.sections}${renderUnplaced(run.unplaced)}`);

    throw new UnverifiedError(reason);
  }

  return { findings: classes.baselined, failures };
}

function run(mode: TreeMode, manifestFile: string): number {
  const here = hostTriple(process.platform, process.arch);

  if (mode === 'write-baseline') {
    const refusal = adoptionRefusal(GATE, onDisk(GATE.baseline));

    if (refusal !== null) return conclude({ output: refusal, code: 1 });

    const adopted = adopt(GATE, measure(manifestFile));
    writeBaselineFile(workingTree(), GATE, formatClippyBaseline(here, adopted.counts));

    return conclude(adopted);
  }

  const baseline = parseClippyBaseline(readBaselineFile(ROOT, GATE));

  const refusal = mode === 'tighten' ? tightenRefusal(baseline.host, here) : null;

  if (refusal !== null) return conclude({ output: refusal, code: 1 });

  const measured = measure(manifestFile);

  if (baseline.host !== here)
    return conclude(judgeElsewhere(baseline.host, here, measured.failures));

  if (mode === 'tighten') {
    const tightened = tighten(GATE, measured, baseline.counts, onDisk);
    writeBaselineFile(workingTree(), GATE, formatClippyBaseline(here, tightened.counts));

    return conclude(tightened);
  }

  const everything = { inScope: () => true, exists: onDisk };

  return conclude(judge(GATE, 'workspace', measured, baseline.counts, everything));
}

const MODES = new Map<string, TreeMode>([
  ['--tighten', 'tighten'],
  ['--write-baseline', 'write-baseline'],
]);

const MANIFEST_ARGUMENT = '--diagnostics=';

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const manifestFile = argv.find((argument) => argument.startsWith(MANIFEST_ARGUMENT));
  const modes = argv.filter((argument) => argument !== manifestFile);

  await main(GATE, async () => {
    if (manifestFile === undefined) {
      throw new UnverifiedError(
        'rust:lint runs as `bazel test //:rust_lint`, which names its manifest',
      );
    }

    return run(selectMode(modes, MODES, 'check'), manifestFile.slice(MANIFEST_ARGUMENT.length));
  });
}
