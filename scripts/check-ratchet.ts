/**
 * The ratchet: the tree may not gain dead code, an exact clone or a complexity hotspot, and no
 * existing hotspot may grow.
 *
 *   bun run check:ratchet               the whole tree against the baselines (`//:check_ratchet`)
 *   bun run check:ratchet --staged      the staged diff against HEAD (pre-commit)
 *   bun run check:ratchet --tighten     lower the baselines to today's tree; never adds or raises
 *   bun run check:ratchet --init        write the baselines when there are none
 *
 * The whole-tree run needs no history, so it is a cached Bazel test: dead code is held to
 * `fallow-baselines/dead-code.json`, which fallow matches by name, and exact clones to
 * `fallow-baselines/dupes.json`, each file's count of clone instances, which holds whatever
 * moves inside or around a clone. An entry the tree no longer needs fails as loose. Complexity is held to
 * `fallow-baselines/complexity-ceilings.json`, which pins every hotspot's exact values: a
 * hotspot that grows from 617 to 700 fails, and so does a ceiling looser than the code, so the
 * file never drifts above it. The staged run is `fallow audit`, which attributes each finding to
 * the change or to HEAD, and holds the files the change touched to their ceilings.
 *
 * Renamed-identifier clones (`.fallowrc.semantic.json`) print as review notes and never fail:
 * parallel code with one shape is sometimes the right design. Anything fallow cannot answer (a
 * timeout, a crash, output that is not JSON) fails as unverified, never as a pass.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '..');
const FALLOW = path.join(ROOT, 'node_modules', '.bin', 'fallow');
export const CEILINGS_FILE = 'fallow-baselines/complexity-ceilings.json';
export const DEAD_CODE_BASELINE = 'fallow-baselines/dead-code.json';
export const DUPES_BASELINE = 'fallow-baselines/dupes.json';
const FALLOW_CONFIG = '.fallowrc.json';
const SEMANTIC_CONFIG = '.fallowrc.semantic.json';
const FALLOW_TIMEOUT_MS = 60_000;

export interface Ceiling {
  readonly cyclomatic: number;
  readonly cognitive: number;
}

export type Ceilings = Readonly<Record<string, Ceiling>>;

export interface CeilingViolation {
  readonly key: string;
  readonly kind: 'new' | 'grew' | 'loose' | 'gone';
  readonly detail: string;
}

type Report = Readonly<Record<string, unknown>>;

class RatchetError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function numberField(record: Readonly<Record<string, unknown>>, key: string): number | null {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function stringField(record: Readonly<Record<string, unknown>>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' ? value : null;
}

/** fallow exits 1 when it has findings; any other exit, or output that is not a JSON object, is no answer. */
export function readFallowReport(
  label: string,
  exitCode: number | null,
  signal: string | null,
  stdout: string,
): Report {
  if (exitCode !== 0 && exitCode !== 1) {
    throw new RatchetError(
      signal === null ? `${label} exited ${exitCode}` : `${label} was killed by ${signal}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new RatchetError(`${label} printed no JSON`);
  }
  if (!isRecord(parsed)) throw new RatchetError(`${label} printed no JSON object`);
  return parsed;
}

function ceilingKey(file: string, name: string): string {
  return `${file}::${name}`;
}

function fileOf(key: string): string {
  return key.slice(0, key.indexOf('::'));
}

/**
 * Every function above either health threshold, keyed `path::name`. Functions sharing a name in
 * one file share a key and keep the larger values.
 */
export function hotspotsOf(health: Report): Map<string, Ceiling> {
  const summary = isRecord(health.summary) ? health.summary : {};
  const maxCyclomatic = numberField(summary, 'max_cyclomatic_threshold');
  const maxCognitive = numberField(summary, 'max_cognitive_threshold');
  if (maxCyclomatic === null || maxCognitive === null) {
    throw new RatchetError('fallow health reported no complexity thresholds');
  }
  const hotspots = new Map<string, Ceiling>();
  for (const finding of records(health.findings)) {
    const file = stringField(finding, 'path');
    const name = stringField(finding, 'name');
    const cyclomatic = numberField(finding, 'cyclomatic');
    const cognitive = numberField(finding, 'cognitive');
    if (file === null || name === null || cyclomatic === null || cognitive === null) {
      throw new RatchetError('fallow health reported a finding without path, name or metrics');
    }
    if (cyclomatic <= maxCyclomatic && cognitive <= maxCognitive) continue;
    const key = ceilingKey(file, name);
    const previous = hotspots.get(key);
    hotspots.set(
      key,
      previous === undefined
        ? { cyclomatic, cognitive }
        : {
            cyclomatic: Math.max(previous.cyclomatic, cyclomatic),
            cognitive: Math.max(previous.cognitive, cognitive),
          },
    );
  }
  return hotspots;
}

export function parseCeilings(text: string): Ceilings {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new RatchetError(`${CEILINGS_FILE} is not JSON`);
  }
  if (!isRecord(parsed)) throw new RatchetError(`${CEILINGS_FILE} is not a JSON object`);
  const ceilings: Record<string, Ceiling> = {};
  for (const [key, value] of Object.entries(parsed)) {
    const cyclomatic = isRecord(value) ? numberField(value, 'cyclomatic') : null;
    const cognitive = isRecord(value) ? numberField(value, 'cognitive') : null;
    if (!key.includes('::') || cyclomatic === null || cognitive === null) {
      throw new RatchetError(`${CEILINGS_FILE}: "${key}" is not a path::name ceiling`);
    }
    ceilings[key] = { cyclomatic, cognitive };
  }
  return ceilings;
}

export function formatCeilings(ceilings: Ceilings): string {
  const sorted = Object.fromEntries(
    Object.entries(ceilings).sort(([left], [right]) => left.localeCompare(right)),
  );
  return `${JSON.stringify(sorted, null, 2)}\n`;
}

function metrics(value: Ceiling): string {
  return `cyclomatic ${value.cyclomatic}, cognitive ${value.cognitive}`;
}

/** Hotspots measured against their ceilings, limited to files `inScope` accepts. */
export function compareCeilings(
  current: ReadonlyMap<string, Ceiling>,
  ceilings: Ceilings,
  inScope: (file: string) => boolean,
): CeilingViolation[] {
  const violations: CeilingViolation[] = [];
  for (const [key, value] of current) {
    if (!inScope(fileOf(key))) continue;
    const ceiling = ceilings[key];
    if (ceiling === undefined) {
      violations.push({ key, kind: 'new', detail: metrics(value) });
    } else if (value.cyclomatic > ceiling.cyclomatic || value.cognitive > ceiling.cognitive) {
      violations.push({ key, kind: 'grew', detail: `${metrics(ceiling)} → ${metrics(value)}` });
    } else if (value.cyclomatic < ceiling.cyclomatic || value.cognitive < ceiling.cognitive) {
      violations.push({ key, kind: 'loose', detail: `${metrics(ceiling)} → ${metrics(value)}` });
    }
  }
  for (const [key, ceiling] of Object.entries(ceilings)) {
    if (!current.has(key) && inScope(fileOf(key))) {
      violations.push({ key, kind: 'gone', detail: `was ${metrics(ceiling)}` });
    }
  }
  return violations.sort((left, right) => left.key.localeCompare(right.key));
}

/** Lower every ceiling to today's value and drop the ones whose function is gone. Never adds or raises. */
export function tightenCeilings(
  current: ReadonlyMap<string, Ceiling>,
  ceilings: Ceilings,
): Ceilings {
  const next: Record<string, Ceiling> = {};
  for (const [key, ceiling] of Object.entries(ceilings)) {
    const value = current.get(key);
    if (value === undefined) continue;
    next[key] = {
      cyclomatic: Math.min(ceiling.cyclomatic, value.cyclomatic),
      cognitive: Math.min(ceiling.cognitive, value.cognitive),
    };
  }
  return next;
}

/**
 * The files whose hotspots a run holds to their ceilings. A function's metrics change only when
 * its file does, so a run measures the files it changed; editing the ceilings or the thresholds
 * re-measures everything. A staged run never widens: every file outside the index is the working
 * tree, not the commit, so only staged files are measured exactly.
 */
export function ceilingScope(
  changed: readonly string[],
  staged: boolean,
): (file: string) => boolean {
  const files = new Set(changed);
  if (!staged && (files.has(CEILINGS_FILE) || files.has(FALLOW_CONFIG))) return () => true;
  return (file) => files.has(file);
}

/**
 * Staged files that also carry unstaged edits: the tree fallow reads is not the commit. Prose is
 * exempt because fallow never reads it, and sessions routinely share a file like `AGENTS.md`.
 */
export function partiallyStaged(staged: readonly string[], unstaged: readonly string[]): string[] {
  const edited = new Set(unstaged);
  return staged.filter((file) => edited.has(file) && !file.endsWith('.md')).sort();
}

interface Span {
  readonly file: string;
  readonly start: number;
  readonly end: number;
}

function cloneSpans(group: Readonly<Record<string, unknown>>): Span[] {
  const spans: Span[] = [];
  for (const instance of records(group.instances)) {
    const file = stringField(instance, 'file');
    const start = numberField(instance, 'start_line');
    const end = numberField(instance, 'end_line');
    if (file !== null && start !== null && end !== null) spans.push({ file, start, end });
  }
  return spans;
}

function introducedCloneGroups(report: Report): Record<string, unknown>[] {
  const duplication = isRecord(report.duplication) ? report.duplication : {};
  return records(duplication.clone_groups).filter((group) => group.introduced === true);
}

function describeClone(group: Readonly<Record<string, unknown>>): string {
  const lines = numberField(group, 'line_count');
  const spans = cloneSpans(group).map((span) => `${span.file}:${span.start}-${span.end}`);
  return `clone${lines === null ? '' : ` (${lines} lines)`}: ${spans.join(', ')}`;
}

function describeFinding(item: Readonly<Record<string, unknown>>): string {
  const file = stringField(item, 'path');
  const line = numberField(item, 'line');
  const files = Array.isArray(item.files)
    ? item.files.filter((entry) => typeof entry === 'string')
    : [];
  const subject =
    ['export_name', 'member_name', 'name', 'specifier', 'package_name']
      .map((key) => stringField(item, key))
      .find((value) => value !== null) ?? '';
  const where = file === null ? files.join(' → ') : line === null ? file : `${file}:${line}`;
  return [where, subject].filter((part) => part !== '').join(' ');
}

/** The findings `fallow audit` attributes to the change itself. */
export function introducedFindings(report: Report): string[] {
  const lines: string[] = [];
  const deadCode = isRecord(report.dead_code) ? report.dead_code : {};
  for (const [category, items] of Object.entries(deadCode)) {
    for (const item of records(items)) {
      if (item.introduced === true) lines.push(`${category}: ${describeFinding(item)}`);
    }
  }
  const complexity = isRecord(report.complexity) ? report.complexity : {};
  for (const finding of records(complexity.findings)) {
    if (finding.introduced !== true) continue;
    const cyclomatic = numberField(finding, 'cyclomatic');
    const cognitive = numberField(finding, 'cognitive');
    lines.push(
      `complexity: ${describeFinding(finding)} (cyclomatic ${cyclomatic}, cognitive ${cognitive})`,
    );
  }
  for (const finding of records(complexity.styling_findings)) {
    if (finding.introduced === true) lines.push(`styling: ${describeFinding(finding)}`);
  }
  for (const group of introducedCloneGroups(report)) lines.push(describeClone(group));
  return lines;
}

function overlaps(left: Span, right: Span): boolean {
  return left.file === right.file && left.start <= right.end && right.start <= left.end;
}

/** Renamed-identifier clones the change introduced, minus those the exact audit already fails. */
export function renamedCloneNotes(semantic: Report, exact: Report): string[] {
  const exactSpans = introducedCloneGroups(exact).flatMap(cloneSpans);
  return introducedCloneGroups(semantic)
    .filter(
      (group) =>
        !cloneSpans(group).some((span) =>
          exactSpans.some((exactSpan) => overlaps(span, exactSpan)),
        ),
    )
    .map(describeClone);
}

function git(args: readonly string[]): string {
  const result = Bun.spawnSync(['git', ...args], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) {
    throw new RatchetError(`git ${args.join(' ')} failed: ${result.stderr.toString().trim()}`);
  }
  return result.stdout.toString();
}

function gitFiles(args: readonly string[]): string[] {
  return git([...args, '-z'])
    .split('\0')
    .filter((file) => file !== '');
}

/** The analyses are independent processes, so a run starts all of them before awaiting any. */
async function fallow(label: string, args: readonly string[]): Promise<Report> {
  const child = Bun.spawn([FALLOW, ...args, '--format', 'json', '--quiet'], {
    cwd: ROOT,
    env: { ...process.env, RUST_LOG: 'error' },
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: FALLOW_TIMEOUT_MS,
  });
  const [stdout, , exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  // Bun types the signal as its name or its number.
  const signalCode = child.signalCode === null ? null : String(child.signalCode);
  return readFallowReport(label, exitCode, signalCode, stdout);
}

function readCeilingsFile(root = ROOT): Ceilings {
  const file = path.join(root, CEILINGS_FILE);
  if (!existsSync(file)) throw new RatchetError(`${CEILINGS_FILE} is missing; run --init`);
  return parseCeilings(readFileSync(file, 'utf8'));
}

function writeCeilingsFile(ceilings: Ceilings): void {
  const file = path.join(ROOT, CEILINGS_FILE);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, formatCeilings(ceilings));
}

type Mode = 'check' | 'staged' | 'tighten' | 'init';

function parseMode(argv: readonly string[]): Mode {
  const modes = new Map<string, Mode>([
    ['--staged', 'staged'],
    ['--tighten', 'tighten'],
    ['--init', 'init'],
  ]);
  const [argument, ...rest] = argv;
  if (argument === undefined) return 'check';
  const mode = modes.get(argument);
  if (mode === undefined || rest.length > 0)
    throw new RatchetError(`unknown arguments ${argv.join(' ')}; see the header of this script`);
  return mode;
}

function write(text: string): void {
  process.stdout.write(text);
}

function section(title: string, lines: readonly string[]): void {
  write(`${title}\n${lines.map((line) => `  ${line}`).join('\n')}\n`);
}

export interface RatchetAnalysis {
  readonly label: string;
  readonly args: readonly string[];
}

/** Preserve every audit and ceiling policy for a declared source/Git/tool adapter. */
export function runRatchetAnalysis(options: {
  readonly root: string;
  readonly base: string;
  readonly changed: readonly string[];
  readonly staged: boolean;
  readonly diffArgs: readonly string[];
  /** Answers every analysis, in order; the adapter decides which of them may overlap. */
  readonly fallow: (analyses: readonly RatchetAnalysis[]) => readonly Report[];
}): number {
  const { base, changed, staged, diffArgs, fallow } = options;
  if (changed.length === 0) {
    write(`check:ratchet: nothing ${staged ? 'staged' : 'changed'} against ${base.slice(0, 10)}\n`);
    return 0;
  }
  const [exact, semantic, health] = fallow([
    { label: 'fallow audit', args: ['audit', '--base', base, ...diffArgs] },
    {
      label: 'fallow audit (semantic)',
      args: ['audit', '--config', SEMANTIC_CONFIG, '--base', base, ...diffArgs],
    },
    { label: 'fallow health', args: ['health'] },
  ]);
  if (exact === undefined || semantic === undefined || health === undefined)
    throw new RatchetError('fallow answered fewer analyses than were asked');
  return reportRatchetAnalysis({ ...options, exact, semantic, health });
}

function reportRatchetAnalysis(options: {
  readonly root: string;
  readonly base: string;
  readonly changed: readonly string[];
  readonly staged: boolean;
  readonly exact: Report;
  readonly semantic: Report;
  readonly health: Report;
}): number {
  const { base, changed, staged, exact, semantic, health } = options;
  const inScope = ceilingScope(changed, staged);
  const current = hotspotsOf(health);
  const violations = compareCeilings(current, readCeilingsFile(options.root), inScope);
  const verdict = stringField(exact, 'verdict');
  if (verdict !== 'pass' && verdict !== 'warn' && verdict !== 'fail')
    throw new RatchetError(`fallow audit returned verdict ${String(verdict)}`);
  write(`check:ratchet: ${staged ? 'staged diff' : 'working tree'} against ${base.slice(0, 10)}\n`);
  const findings = introducedFindings(exact);
  if (verdict === 'fail') section('FAIL  introduced by this change (fallow audit):', findings);
  else if (findings.length > 0)
    section('WARN  introduced by this change (fallow audit):', findings);
  if (violations.length > 0)
    section(
      `FAIL  complexity ceilings (${CEILINGS_FILE}); simplify, or run \`bun run check:ratchet --tighten\` for loose/gone:`,
      violations.map((violation) => `${violation.kind}  ${violation.key}  ${violation.detail}`),
    );
  const notes = renamedCloneNotes(semantic, exact);
  if (notes.length > 0)
    section('NOTE  renamed-identifier clones introduced (review; not a gate):', notes);
  const failed = verdict === 'fail' || violations.length > 0;
  write(`check:ratchet: ${failed ? 'FAIL' : 'pass'} (${current.size} hotspots checked)\n`);
  return failed ? 1 : 0;
}

/** Dead code and exact clones the baselines do not hold, and dead-code entries the tree lost. */
/** Dead code the dead-code baseline does not hold, and the entries the tree no longer has. */
export function deadCodeFindings(deadCode: Report) {
  const added: string[] = [];
  for (const [category, items] of Object.entries(deadCode)) {
    if (category === 'next_steps' || category === 'workspace_diagnostics') continue;
    for (const item of records(items)) added.push(`${category}: ${describeFinding(item)}`);
  }
  const baseline = isRecord(deadCode.baseline) ? deadCode.baseline : {};
  const entries = numberField(baseline, 'entries');
  const matched = numberField(baseline, 'matched');
  if (entries === null || matched === null)
    throw new RatchetError('fallow dead-code reported no baseline match');
  return { added, loose: entries - matched };
}

/**
 * Exact-clone instances by file. A count holds whatever moves inside or around a clone; a file
 * gains one only by gaining a clone.
 */
export function cloneCounts(dupes: Report): Map<string, number> {
  const counts = new Map<string, number>();
  for (const group of records(dupes.clone_groups))
    for (const span of cloneSpans(group)) counts.set(span.file, (counts.get(span.file) ?? 0) + 1);
  return counts;
}

export function parseCloneCounts(text: string): Map<string, number> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new RatchetError(`${DUPES_BASELINE} is not JSON`);
  }
  if (!isRecord(parsed)) throw new RatchetError(`${DUPES_BASELINE} is not a JSON object`);
  const counts = new Map<string, number>();
  for (const file of Object.keys(parsed)) {
    const count = numberField(parsed, file);
    if (count === null || !Number.isSafeInteger(count) || count <= 0)
      throw new RatchetError(`${DUPES_BASELINE}: "${file}" is not a positive clone count`);
    counts.set(file, count);
  }
  return counts;
}

export function formatCloneCounts(counts: ReadonlyMap<string, number>): string {
  return `${JSON.stringify(Object.fromEntries([...counts].sort(([a], [b]) => a.localeCompare(b))), null, 2)}\n`;
}

/** Files holding more clone instances than the baseline allows, and fewer. */
export function compareCloneCounts(
  current: ReadonlyMap<string, number>,
  baseline: ReadonlyMap<string, number>,
  dupes: Report,
) {
  const grown = new Set<string>();
  for (const [file, count] of current) if (count > (baseline.get(file) ?? 0)) grown.add(file);
  const added: string[] = [];
  for (const group of records(dupes.clone_groups))
    if (cloneSpans(group).some((span) => grown.has(span.file))) added.push(describeClone(group));
  const loose: string[] = [];
  for (const [file, count] of baseline) {
    const found = current.get(file) ?? 0;
    if (found < count) loose.push(`${file}: allowed ${count}, found ${found}`);
  }
  return { added, loose };
}

function readCloneCounts(): Map<string, number> {
  const file = path.join(ROOT, DUPES_BASELINE);
  if (!existsSync(file)) throw new RatchetError(`${DUPES_BASELINE} is missing; run --init`);
  return parseCloneCounts(readFileSync(file, 'utf8'));
}

async function checkTree(): Promise<number> {
  const [deadCode, dupes, health] = await Promise.all([
    fallow('fallow dead-code', ['dead-code', '--baseline', DEAD_CODE_BASELINE]),
    fallow('fallow dupes', ['dupes']),
    fallow('fallow health', ['health']),
  ]);
  const dead = deadCodeFindings(deadCode);
  const clones = compareCloneCounts(cloneCounts(dupes), readCloneCounts(), dupes);
  const current = hotspotsOf(health);
  const violations = compareCeilings(current, readCeilingsFile(), () => true);
  write('check:ratchet: the tree against fallow-baselines/\n');
  if (dead.added.length > 0) section(`FAIL  dead code not in ${DEAD_CODE_BASELINE}:`, dead.added);
  if (clones.added.length > 0)
    section(`FAIL  exact clones beyond ${DUPES_BASELINE}:`, clones.added);
  const tighten = 'run `bun run check:ratchet --tighten`';
  if (dead.loose > 0)
    write(`FAIL  ${dead.loose} ${DEAD_CODE_BASELINE} entries the tree no longer has; ${tighten}\n`);
  if (clones.loose.length > 0)
    section(
      `FAIL  ${DUPES_BASELINE} allows more clones than the tree has; ${tighten}:`,
      clones.loose,
    );
  if (violations.length > 0)
    section(
      `FAIL  complexity ceilings (${CEILINGS_FILE}); simplify, or ${tighten} for loose/gone:`,
      violations.map((violation) => `${violation.kind}  ${violation.key}  ${violation.detail}`),
    );
  const failed =
    dead.added.length > 0 ||
    clones.added.length > 0 ||
    dead.loose > 0 ||
    clones.loose.length > 0 ||
    violations.length > 0;
  write(`check:ratchet: ${failed ? 'FAIL' : 'pass'} (${current.size} hotspots checked)\n`);
  return failed ? 1 : 0;
}

/**
 * Rewrite the baselines from today's tree. It only lowers them: it refuses while the tree has
 * a finding the baselines do not hold, so a rewrite drops entries and never adds one.
 */
async function writeBaselines(mode: 'tighten' | 'init'): Promise<number> {
  const [health, dupes] = await Promise.all([
    fallow('fallow health', ['health']).then(hotspotsOf),
    fallow('fallow dupes', ['dupes']),
  ]);
  const counts = cloneCounts(dupes);
  if (mode === 'init') {
    for (const file of [CEILINGS_FILE, DEAD_CODE_BASELINE, DUPES_BASELINE]) {
      if (existsSync(path.join(ROOT, file)))
        throw new RatchetError(`${file} exists; use --tighten`);
    }
    writeCeilingsFile(Object.fromEntries(health));
  } else {
    const dead = deadCodeFindings(
      await fallow('fallow dead-code', ['dead-code', '--baseline', DEAD_CODE_BASELINE]),
    );
    const clones = compareCloneCounts(counts, readCloneCounts(), dupes);
    const added = [...dead.added, ...clones.added];
    if (added.length > 0) {
      section('FAIL  not in the baselines, so they stay as they are:', added);
      return 1;
    }
    writeCeilingsFile(tightenCeilings(health, readCeilingsFile()));
  }
  mkdirSync(path.join(ROOT, 'fallow-baselines'), { recursive: true });
  writeFileSync(path.join(ROOT, DUPES_BASELINE), formatCloneCounts(counts));
  await fallow('fallow dead-code', ['dead-code', '--save-baseline', DEAD_CODE_BASELINE]);
  write(`check:ratchet: wrote ${CEILINGS_FILE}, ${DEAD_CODE_BASELINE} and ${DUPES_BASELINE}\n`);
  return 0;
}

async function checkStaged(): Promise<number> {
  const base = git(['rev-parse', '--verify', 'HEAD^{commit}']).trim();
  const changed = gitFiles(['diff', '--cached', '--name-only', '--no-renames', base]);
  if (changed.length === 0) {
    write(`check:ratchet: nothing staged against ${base.slice(0, 10)}\n`);
    return 0;
  }
  const partial = partiallyStaged(changed, gitFiles(['diff', '--name-only', '--no-renames']));
  if (partial.length > 0) {
    section(
      'FAIL  staged files with unstaged edits (stage the whole file, or stash the rest):',
      partial,
    );
    return 1;
  }
  const scratch = mkdtempSync(path.join(tmpdir(), 'check-ratchet-'));
  const diffFile = path.join(scratch, 'staged.diff');
  writeFileSync(diffFile, git(['diff', '--cached', '-U0', '--no-renames', base]));
  const diffArgs = ['--diff-file', diffFile];
  try {
    const [exact, semantic, health] = await Promise.all([
      fallow('fallow audit', ['audit', '--base', base, ...diffArgs]),
      fallow('fallow audit (semantic)', [
        'audit',
        '--config',
        SEMANTIC_CONFIG,
        '--base',
        base,
        ...diffArgs,
      ]),
      fallow('fallow health', ['health']),
    ]);
    return reportRatchetAnalysis({
      root: ROOT,
      base,
      changed,
      staged: true,
      exact,
      semantic,
      health,
    });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

async function run(mode: Mode): Promise<number> {
  if (mode === 'check') return await checkTree();
  if (mode === 'staged') return await checkStaged();
  return await writeBaselines(mode);
}

if (import.meta.main) {
  let code: number;
  try {
    code = await run(parseMode(process.argv.slice(2)));
  } catch (error) {
    if (!(error instanceof RatchetError)) throw error;
    write(`check:ratchet: unverified: ${error.message}\n`);
    code = 1;
  }
  process.exit(code);
}
