/**
 * `rust:lint`: one Clippy pass over the whole workspace, every target, with each finding sorted
 * into exactly one of three classes by its lint and its file (`classify`).
 *
 *   bun run rust:lint                   the workspace against the baseline (gates, CI)
 *   bun run rust:lint --tighten         lower or drop entries to today's counts; never raises or adds one
 *   bun run rust:lint --write-baseline  write the whole baseline from this tree; for adoption only,
 *                                       refused while a baseline exists
 *
 * Zero: a finding nothing allows. Every warning or error that is not a ratcheted lint is one,
 * in every member of the workspace, vendored members included: the compiler's own warnings,
 * Clippy's default lints, the lints of `[workspace.lints]` in `Cargo.toml`, and an `#[expect]`
 * whose lint no longer fires. So is a panic lint in a crate that parses bytes an attacker
 * controls (`PANIC_FREE`), in its tests as in the rest of it, and a timer call in a module on a
 * latency path: `clippy.toml` lists the calls, the workspace allows them, and each such module
 * denies them at the head of its file. Each is printed as the compiler rendered it, suggestion
 * included.
 *
 * Clippy lints the members of the workspace and nothing else, so a warning in any other package
 * (a `[patch]` crate that is not a member) is not a finding. `cargo metadata` names the members.
 *
 * Baseline: the ratcheted lints, which no manifest enables and this script hands to Clippy as
 * warnings. `lint-baselines/clippy.json` pins their findings per file and per lint under the
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
 * workspace; this script, not the compiler, is what fails. A finding is counted once however
 * many targets report it, at its primary span, or, when that span lies in a macro of another
 * crate, at the nearest place in this repository that expanded it.
 *
 * Code under `#[cfg(target_os = …)]` is linted only where it compiles, so the counts differ by
 * platform. The baseline records the host triple it was adopted on (`rustc -vV`) and is compared
 * only on that host. On any other host a run enforces the zero class, says in one line that the
 * baseline was not compared, and `--tighten` is refused.
 *
 * A stream that is not Cargo's build records, a build that did not finish, and a diagnostic with
 * no lint code or no place in this repository fail as unverified, never as a pass, after what the
 * compiler did report is printed.
 */
import { existsSync } from 'node:fs';
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
import { runTestProcess } from './test-process';

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
  /** Whether Cargo closed the stream by reporting a successful build. */
  readonly finished: boolean;
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
 * One line of `cargo --message-format=json`. Only a `compiler-message` carries `message`, and it
 * names the package it was compiled for.
 */
const BuildRecord = Schema.fromJsonString(
  Schema.Struct({
    reason: Schema.String,
    success: Schema.optionalKey(Schema.Boolean),
    package_id: Schema.optionalKey(Schema.String),
    message: Schema.optionalKey(
      Schema.Struct({
        level: Schema.String,
        message: Schema.String,
        rendered: Schema.String,
        code: Schema.NullOr(Schema.Struct({ code: Schema.String })),
        spans: Schema.Array(Span),
      }),
    ),
  }),
);

const MetadataJson = Schema.fromJsonString(
  Schema.Struct({ workspace_members: Schema.Array(Schema.String) }),
);

const METADATA_COMMAND = [
  'cargo',
  'metadata',
  '--no-deps',
  '--format-version',
  '1',
  '--manifest-path',
  'Cargo.toml',
];

const BaselineJson = Schema.fromJsonString(
  Schema.Struct({ host: Schema.String, files: BaselineEntries }),
);

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

/** The Clippy invocation: every target of every member, and each ratcheted lint as a warning. */
export function clippyCommand(): string[] {
  return [
    'cargo',
    'clippy',
    '--manifest-path',
    'Cargo.toml',
    '--workspace',
    '--locked',
    '--all-targets',
    '--target-dir',
    'target/clippy',
    '--message-format=json',
    '--',
    '--cap-lints',
    'warn',
    ...RATCHETED_LINTS.flatMap((lint) => ['-W', lint]),
  ];
}

/** A span's file as a repo-relative posix path, or null when it lies outside the repository. */
function repoFile(name: string, root: string): string | null {
  const relative = path.relative(root, path.resolve(root, name));

  if (relative.startsWith('..') || path.isAbsolute(relative)) return null;

  return relative.split(path.sep).join('/');
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

/** The package ids `cargo metadata` gives as the members of the workspace. */
export function workspaceMembers(metadata: string): Set<string> {
  const decoded = Option.getOrNull(Schema.decodeOption(MetadataJson)(metadata));

  if (decoded === null || decoded.workspace_members.length === 0) {
    throw new UnverifiedError('`cargo metadata` names no workspace member');
  }

  return new Set(decoded.workspace_members);
}

/**
 * The stdout of the Clippy run as findings. `--all-targets` compiles a library once for itself
 * and once for its tests, and both report the same diagnostic: a finding is one lint at one
 * place. A warning in a package that is not one of `members` is not read; an error there stops
 * the build and is. A line that is not a build record makes the stream unreadable.
 */
export function readClippy(text: string, root: string, members: ReadonlySet<string>): ClippyRun {
  const findings = new Map<string, ClippyFinding>();
  const unplaced: string[] = [];
  let finished = false;

  for (const line of text.split('\n')) {
    if (line === '') continue;

    const record = Option.getOrNull(Schema.decodeOption(BuildRecord)(line));

    if (record === null) {
      throw new UnverifiedError(`cargo wrote a line that is not a build record: ${line}`);
    }

    if (record.reason === 'build-finished') finished = record.success === true;

    if (record.reason !== 'compiler-message') continue;

    const { message: diagnostic, package_id: owner } = record;

    if (diagnostic === undefined || owner === undefined) {
      throw new UnverifiedError(
        `cargo wrote a compiler message with no message or no package: ${line}`,
      );
    }

    if (diagnostic.level === 'warning' && !members.has(owner)) continue;

    const { message, rendered } = diagnostic;
    const rule = diagnostic.code?.code;
    const primary = diagnostic.spans.find((span) => span.is_primary);
    const placed = primary === undefined ? null : place(primary, root);

    if (rule === undefined || placed === null) {
      unplaced.push(rendered);
      continue;
    }

    const key = `${rule}\0${placed.file}\0${placed.line}\0${placed.column}`;

    if (!findings.has(key)) findings.set(key, { ...placed, rule, message, rendered });
  }

  return { findings: [...findings.values()], unplaced, finished };
}

/** Why a run is no answer, or null when the build finished and every diagnostic was read. */
export function unverifiedReason(run: ClippyRun, exitCode: number): string | null {
  if (!run.finished || exitCode !== 0) {
    return `cargo clippy exited ${exitCode} without reporting a finished build`;
  }

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

/** The `host:` line of `rustc -vV`: the target triple this toolchain compiles for. */
export function hostTriple(version: string): string {
  const host = /^host: (\S+)$/m.exec(version)?.[1];

  if (host === undefined) throw new UnverifiedError('`rustc -vV` names no host');

  return host;
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

/** The environment of the pinned toolchain: `rust-toolchain.toml` decides, not the caller's shell. */
function toolchainEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  delete environment.RUSTUP_TOOLCHAIN;

  return environment;
}

/** What a toolchain command that answers at once wrote to stdout. */
async function ask(command: readonly string[]): Promise<string> {
  const answer = await runTestProcess(command, { cwd: ROOT, env: toolchainEnvironment() });

  if (answer.exitCode !== 0) {
    throw new UnverifiedError(
      `${command.join(' ')} exited ${answer.exitCode}: ${answer.stderr.trim()}`,
    );
  }

  return answer.stdout;
}

/**
 * One Clippy run: the baseline class as its findings, the zero class as what fails it outright.
 * Cargo's progress goes straight to the terminal; its build records are read whole. What an
 * unverified run did report is printed before the run is given up, so a compile error is seen
 * and not only counted.
 */
async function measure(): Promise<Measurement> {
  const members = workspaceMembers(await ask(METADATA_COMMAND));

  const child = Bun.spawn(clippyCommand(), {
    cwd: ROOT,
    env: toolchainEnvironment(),
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'inherit',
  });

  const [stdout, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  const run = readClippy(stdout, ROOT, members);
  const classes = sortFindings(run.findings);
  const failures = zeroFailures(classes.zero);
  const reason = unverifiedReason(run, exitCode);

  if (reason !== null) {
    process.stdout.write(`${failures.sections}${renderUnplaced(run.unplaced)}`);

    throw new UnverifiedError(reason);
  }

  return { findings: classes.baselined, failures };
}

async function run(mode: TreeMode): Promise<number> {
  const here = hostTriple(await ask(['rustc', '-vV']));

  if (mode === 'write-baseline') {
    const refusal = adoptionRefusal(GATE, onDisk(GATE.baseline));

    if (refusal !== null) return conclude({ output: refusal, code: 1 });

    const adopted = adopt(GATE, await measure());
    writeBaselineFile(ROOT, GATE, formatClippyBaseline(here, adopted.counts));

    return conclude(adopted);
  }

  const baseline = parseClippyBaseline(readBaselineFile(ROOT, GATE));

  const refusal = mode === 'tighten' ? tightenRefusal(baseline.host, here) : null;

  if (refusal !== null) return conclude({ output: refusal, code: 1 });

  const measured = await measure();

  if (baseline.host !== here)
    return conclude(judgeElsewhere(baseline.host, here, measured.failures));

  if (mode === 'tighten') {
    const tightened = tighten(GATE, measured, baseline.counts, onDisk);
    writeBaselineFile(ROOT, GATE, formatClippyBaseline(here, tightened.counts));

    return conclude(tightened);
  }

  const everything = { inScope: () => true, exists: onDisk };

  return conclude(judge(GATE, 'workspace', measured, baseline.counts, everything));
}

const MODES = new Map<string, TreeMode>([
  ['--tighten', 'tighten'],
  ['--write-baseline', 'write-baseline'],
]);

if (import.meta.main) {
  await main(GATE, () => run(selectMode(process.argv.slice(2), MODES, 'check')));
}
