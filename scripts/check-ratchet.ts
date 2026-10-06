/**
 * The ratchet: a change may not add dead code, an exact clone or a complexity hotspot, and no
 * existing hotspot may grow.
 *
 *   bun run check:ratchet               the working tree against HEAD (gates, Stop hook)
 *   bun run check:ratchet --staged      the staged diff against HEAD (pre-commit)
 *   bun run check:ratchet --base <ref>  the checkout against an older commit (CI)
 *   bun run check:ratchet --tighten     lower the ceilings to today's values; never raises one
 *   bun run check:ratchet --init        write the ceilings file when there is none
 *
 * `fallow audit` attributes each finding to the change or to its base. Its complexity identity
 * is path plus function name, so a hotspot that grows from 617 to 700 stays "inherited" there;
 * `fallow-baselines/complexity-ceilings.json` pins every hotspot's exact values instead, and a
 * ceiling that is looser than the code fails too, so the file never drifts above the code. The
 * file describes committed code, and each run holds the files it changed to it (`ceilingScope`).
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
  return readFallowReport(label, exitCode, child.signalCode ?? null, stdout);
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

interface Options {
  readonly mode: 'check' | 'staged' | 'tighten' | 'init';
  readonly base: string;
}

function parseOptions(argv: readonly string[]): Options {
  let mode: Options['mode'] = 'check';
  let base = 'HEAD';
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--staged') mode = 'staged';
    else if (argument === '--tighten') mode = 'tighten';
    else if (argument === '--init') mode = 'init';
    else if (argument === '--base' && argv[index + 1] !== undefined) {
      base = argv[index + 1] ?? base;
      index += 1;
    } else throw new RatchetError(`unknown argument ${argument}; see the header of this script`);
  }
  return { mode, base };
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

async function run(options: Options): Promise<number> {
  if (options.mode === 'init' || options.mode === 'tighten') {
    const current = hotspotsOf(await fallow('fallow health', ['health']));
    if (options.mode === 'init') {
      if (existsSync(path.join(ROOT, CEILINGS_FILE))) {
        throw new RatchetError(`${CEILINGS_FILE} exists; use --tighten`);
      }
      writeCeilingsFile(Object.fromEntries(current));
    } else {
      writeCeilingsFile(tightenCeilings(current, readCeilingsFile()));
    }
    write(`check:ratchet: wrote ${CEILINGS_FILE}\n`);
    return 0;
  }

  const base = git(['rev-parse', '--verify', `${options.base}^{commit}`]).trim();
  const staged = options.mode === 'staged';
  const changed = staged
    ? gitFiles(['diff', '--cached', '--name-only', '--no-renames', base])
    : [
        ...gitFiles(['diff', '--name-only', '--no-renames', base]),
        ...gitFiles(['ls-files', '--others', '--exclude-standard']),
      ];
  if (changed.length === 0) {
    write(`check:ratchet: nothing ${staged ? 'staged' : 'changed'} against ${base.slice(0, 10)}\n`);
    return 0;
  }
  let diffArgs: string[] = [];
  let scratch: string | null = null;
  if (staged) {
    const partial = partiallyStaged(changed, gitFiles(['diff', '--name-only', '--no-renames']));
    if (partial.length > 0) {
      section(
        'FAIL  staged files with unstaged edits (stage the whole file, or stash the rest):',
        partial,
      );
      return 1;
    }
    scratch = mkdtempSync(path.join(tmpdir(), 'check-ratchet-'));
    const diffFile = path.join(scratch, 'staged.diff');
    writeFileSync(diffFile, git(['diff', '--cached', '-U0', '--no-renames', base]));
    diffArgs = ['--diff-file', diffFile];
  }

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
    return reportRatchetAnalysis({ root: ROOT, base, changed, staged, exact, semantic, health });
  } finally {
    if (scratch !== null) rmSync(scratch, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  let code: number;
  try {
    code = await run(parseOptions(process.argv.slice(2)));
  } catch (error) {
    if (!(error instanceof RatchetError)) throw error;
    write(`check:ratchet: unverified: ${error.message}\n`);
    code = 1;
  }
  process.exit(code);
}
