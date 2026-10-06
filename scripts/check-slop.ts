/**
 * The anti-slop ratchet: `lint-baselines/anti-slop.json` pins, per file and per rule, how many
 * findings of the anti-slop rules the committed code carries. A count only goes down. There are
 * two sets of rules. The Biome rules are GritQL plugins (`tools/biome/slop/`, listed by
 * `biome.slop.json`), run over script files by the same Biome that lints and formats the tree.
 * The comment rules (`scripts/comment-rules.ts`, each named `comment-…`) read the comments of
 * script files and of Rust files.
 *
 *   bun run check:slop                   the working tree against the baseline (gates, CI, Stop hook)
 *   bun run check:slop --staged          the files in the index against the index's baseline (pre-commit)
 *   bun run check:slop --tighten         lower or drop entries to today's counts; never raises or adds one
 *   bun run check:slop --write-baseline  write the whole baseline from this tree; for adoption only,
 *                                        refused while a baseline exists
 *
 * A file or rule the baseline does not name is allowed no finding, so new code is held to every
 * rule. A count above its entry fails with each finding and the rule's own message, which is the
 * repair instruction. A count below its entry, or an entry for a file that is gone, fails too
 * until `--tighten` lowers it, so the baseline never drifts above the code. The comparison and
 * its verdicts are `scripts/lint-ratchet.ts`.
 *
 * This script, not Biome, decides which files are measured: the files Git tracks or does not
 * ignore, less the generated and vendored trees. The script files among them (`isLinted`) get
 * both sets of rules, the Rust files the comment rules alone (`isMeasured`). Biome is handed
 * exactly the script files and must report having linted that many. Anything it cannot answer
 * (a rule file that does not compile, a file it could not parse, a count that differs, output
 * that is not its report), and a file whose comments cannot be read, fails as unverified, never
 * as a pass.
 *
 * A Biome rule sees one file at a time, so a file's Biome findings are a function of its bytes
 * and the rule set. They are kept in `test-results/verification/slop-cache.json` under both,
 * and a run lints only the files whose bytes it has not seen under these rules;
 * `MERKUR_GATE_CACHE=0` lints every file. The comment rules read every file on every run.
 *
 * Only this gate runs the Biome rules, so no comment has a reason to switch one off: a
 * `biome-ignore` comment that names `lint` as a whole or the plugin category fails in every mode
 * and is never baselined. Biome reports only the suppressions that hid nothing, so the gate reads the
 * comments of the files itself.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Option, Schema } from 'effect';

import { partiallyStaged } from './check-ratchet';
import { isRustSource, measureFile, scriptComments } from './comment-rules';
import { digestFiles } from './content-digest';
import {
  conclude,
  type Failures,
  type Finding,
  judge,
  type Measurement,
  main,
  order,
  parseBaseline,
  type RatchetGate,
  runTree,
  selectMode,
  type TreeMode,
  UnverifiedError,
} from './lint-ratchet';
import { runTestProcess } from './test-process';
import { cacheEnabled } from './verification-cache';

const ROOT = path.resolve(import.meta.dir, '..');

export const BIOME_CONFIG = 'biome.slop.json';

export const RULE_SOURCES = 'tools/biome/slop/';

export const GATE: RatchetGate = {
  name: 'check:slop',
  baseline: 'lint-baselines/anti-slop.json',
  counted: 'findings',
  rules: `Each Biome rule is stated at the head of its file in ${RULE_SOURCES}, each comment rule in scripts/comment-rules.ts.`,
};

const CACHE_FILE = 'test-results/verification/slop-cache.json';

/** A cold run on a loaded machine takes most of a minute; a hung one is not waited out. */
const BIOME_TIMEOUT_MS = 600_000;

const SCRIPT_FILE = /\.(?:[cm]?ts|[cm]?js|tsx|jsx)$/;

/** Installed dependencies and build outputs, wherever they sit. */
const EXCLUDED_DIRECTORIES = new Set(['node_modules', 'dist', 'target', 'pkg']);

/** Agent harness configuration, runtime data, test vectors and vendored trees. */
const EXCLUDED_TREES = [
  '.claude/',
  '.agents/',
  'apps/server/data/',
  'packages/shared/test-vectors/',
  'packages/term-wasm/vendor/',
];

const VENDORED_CRATE = /^packages\/[^/]+-patch\//;

/** Generated source. */
const EXCLUDED_FILES = new Set(['apps/server/src/db/generated-types.ts']);

/** What one Biome run found, and how many files it linted to find it. */
export interface LintReport {
  readonly findings: readonly Finding[];
  readonly fileCount: number;
}

/** A comment that switches the rules off, at the line the directive is on. */
export interface Suppression {
  readonly file: string;
  readonly line: number;
}

/** The findings of one file, valid for exactly the bytes that digest to `digest`. */
export interface CachedFile {
  readonly digest: string;
  readonly findings: readonly Finding[];
}

/** Per-file findings under one rule set; `rules` digests Biome, its configuration and this script. */
export interface SlopCache {
  readonly rules: string;
  readonly files: ReadonlyMap<string, CachedFile>;
}

/** What one read of a run's files gave. */
export interface Reading {
  /** The digest of each script file: the files Biome is handed, and no other. */
  readonly digests: Map<string, string>;
  readonly suppressions: Suppression[];
  /** The findings of the comment rules, in script and Rust files alike. */
  readonly comments: Finding[];
}

type Mode = TreeMode | 'staged';

const BiomeReport = Schema.fromJsonString(
  Schema.Struct({
    summary: Schema.Struct({
      changed: Schema.Int,
      unchanged: Schema.Int,
      skipped: Schema.Int,
      diagnosticsNotPrinted: Schema.Int,
    }),
    diagnostics: Schema.Array(
      Schema.Struct({
        category: Schema.String,
        message: Schema.String,
        location: Schema.Struct({
          path: Schema.String,
          start: Schema.Struct({ line: Schema.Int, column: Schema.Int }),
        }),
      }),
    ),
  }),
);

/** A rule's diagnostic opens with its own name: `[no-runtime-typeof] …`. */
const RULE_MESSAGE = /^\[([a-z-]+)\] (.+)$/s;

/** Every suppression Biome honours, for a line, a range or a whole file, starts with this word. */
const DIRECTIVE = /biome-ignore[a-z-]*([^\n]*)/g;

const FindingJson = Schema.Struct({
  file: Schema.String,
  rule: Schema.String,
  line: Schema.Int,
  column: Schema.Int,
  message: Schema.String,
});

const CacheJson = Schema.fromJsonString(
  Schema.Struct({
    rules: Schema.String,
    files: Schema.Record(
      Schema.String,
      Schema.Struct({ digest: Schema.String, findings: Schema.Array(FindingJson) }),
    ),
  }),
);

const ConfigJson = Schema.fromJsonString(Schema.Struct({ plugins: Schema.Array(Schema.String) }));

/** Whether a repo-relative path lies outside the installed, built, vendored, harness and data trees. */
function isFirstParty(file: string): boolean {
  if (VENDORED_CRATE.test(file) || EXCLUDED_TREES.some((tree) => file.startsWith(tree))) {
    return false;
  }

  return !file.split('/').some((segment) => EXCLUDED_DIRECTORIES.has(segment));
}

/** Whether Biome is handed this repo-relative path: a script file outside the excluded trees. */
export function isLinted(file: string): boolean {
  return SCRIPT_FILE.test(file) && !EXCLUDED_FILES.has(file) && isFirstParty(file);
}

/**
 * Whether the gate answers for this repo-relative path: a script file, which both sets of rules
 * read, or a Rust file outside the excluded trees, which the comment rules read.
 */
export function isMeasured(file: string): boolean {
  return isLinted(file) || (isRustSource(file) && isFirstParty(file));
}

/** The rule files a Biome configuration lists, as repo-relative paths in the order it lists them. */
export function parsePlugins(text: string): string[] {
  const config = Option.getOrNull(Schema.decodeOption(ConfigJson)(text));

  if (config === null) throw new UnverifiedError(`${BIOME_CONFIG} does not list its plugins`);

  return config.plugins.map((plugin) => plugin.replace(/^\.\//, ''));
}

/** `tools/biome/slop/no-runtime-typeof.grit` is the rule `no-runtime-typeof`. */
export function ruleName(plugin: string): string {
  return path.basename(plugin, '.grit');
}

/**
 * Biome's JSON report as findings, each named by the rule file that raised it. A diagnostic that
 * is not a rule's (a file Biome could not parse or read, a suppression it could not read) or a
 * diagnostic Biome held back makes the count unknown, not zero.
 */
export function parseReport(text: string, rules: ReadonlySet<string>): LintReport {
  const report = Option.getOrNull(Schema.decodeOption(BiomeReport)(text));

  if (report === null) throw new UnverifiedError('biome wrote no JSON report');

  const { summary } = report;

  if (summary.diagnosticsNotPrinted > 0 || summary.skipped > 0) {
    throw new UnverifiedError(
      `biome held back ${summary.diagnosticsNotPrinted} diagnostics and skipped ${summary.skipped} files`,
    );
  }

  const findings: Finding[] = [];

  for (const diagnostic of report.diagnostics) {
    const file = diagnostic.location.path.replace(/^\.\//, '').split(path.sep).join('/');
    const named = RULE_MESSAGE.exec(diagnostic.message);
    const rule = named?.[1];
    const message = named?.[2];

    if (diagnostic.category !== 'plugin' || rule === undefined || message === undefined) {
      throw new UnverifiedError(
        `biome could not lint ${file}: ${diagnostic.category}: ${diagnostic.message}`,
      );
    }

    if (!rules.has(rule)) throw new UnverifiedError(`${file}: no rule file is named ${rule}`);

    const { line, column } = diagnostic.location.start;
    findings.push({ file, rule, line, column, message });
  }

  return { findings, fileCount: summary.changed + summary.unchanged };
}

/** Whether what follows `biome-ignore` on its line switches the plugin rules off. */
function suppressesRules(rest: string): boolean {
  const colon = rest.indexOf(':');
  const categories = colon === -1 ? rest : rest.slice(0, colon);

  return categories
    .split(/\s+/)
    .some(
      (category) =>
        category === 'lint' || category.startsWith('lint/plugin') || category.startsWith('lint('),
    );
}

/**
 * The comments of one source file that switch the rules off: a `biome-ignore`, `-all`, `-start`
 * or `-end` whose categories name `lint` as a whole or the plugin category. A suppression of a
 * named built-in rule (`lint/suspicious/noConsole`) leaves the plugins on and is not one. The
 * test is wider than Biome's own reading of the comment, never narrower; a string, a template or
 * JSX text holding the same words is not a comment and does not count.
 */
export function findSuppressions(file: string, source: string): Suppression[] {
  // The parse is paid only by a file that holds the word at all.
  if (!source.includes('biome-ignore')) return [];

  const suppressions: Suppression[] = [];

  for (const comment of scriptComments(file, source)) {
    for (const match of comment.value.matchAll(DIRECTIVE)) {
      if (!suppressesRules(match[1] ?? '')) continue;

      // A comment's text starts after its two-character opener.
      const offset = comment.start + 2 + match.index;
      suppressions.push({ file, line: source.slice(0, offset).split('\n').length });
    }
  }

  return suppressions;
}

/** The cache file's text as a cache, or an empty one when it holds another rule set or nothing readable. */
export function parseCache(text: string, rules: string): SlopCache {
  const cache = Option.getOrNull(Schema.decodeOption(CacheJson)(text));

  if (cache === null || cache.rules !== rules) return { rules, files: new Map() };

  return { rules, files: new Map(Object.entries(cache.files)) };
}

export function formatCache(cache: SlopCache): string {
  const files = [...cache.files].sort(([left], [right]) => order(left, right));

  return `${JSON.stringify({ rules: cache.rules, files: Object.fromEntries(files) })}\n`;
}

/** The findings of the files whose bytes the cache has seen, and the files it has not. */
export interface CacheSplit {
  readonly known: Finding[];
  readonly pending: string[];
}

export function splitByCache(digests: ReadonlyMap<string, string>, cache: SlopCache): CacheSplit {
  const known: Finding[] = [];
  const pending: string[] = [];

  for (const [file, digest] of digests) {
    const cached = cache.files.get(file);

    if (cached === undefined || cached.digest !== digest) pending.push(file);
    else known.push(...cached.findings);
  }

  return { known, pending };
}

/**
 * The cache after a run: the linted files carry their fresh findings, and a run over the whole
 * tree drops every file it did not answer for, so a deleted file leaves no entry behind.
 */
export function mergeCache(
  cache: SlopCache,
  digests: ReadonlyMap<string, string>,
  linted: readonly string[],
  fresh: readonly Finding[],
  wholeTree: boolean,
): SlopCache {
  const files = new Map<string, CachedFile>();
  const found = Map.groupBy(fresh, (finding) => finding.file);

  for (const [file, cached] of cache.files) {
    if (!wholeTree || digests.has(file)) files.set(file, cached);
  }

  for (const file of linted) {
    const digest = digests.get(file);

    if (digest !== undefined) files.set(file, { digest, findings: found.get(file) ?? [] });
  }

  return { rules: cache.rules, files };
}

/** The FAIL section for suppression comments, empty when there is none. */
export function renderSuppressions(suppressions: readonly Suppression[]): string {
  if (suppressions.length === 0) return '';

  const lines = [...suppressions]
    .sort((left, right) => order(left.file, right.file) || left.line - right.line)
    .map(
      (suppression) =>
        `  ${suppression.file}:${suppression.line} — suppression comments are not allowed; fix the finding\n`,
    );

  return `FAIL  suppression comments:\n${lines.join('')}`;
}

/** The suppression comments as what a run fails on beside its baseline, and counts in its summary. */
export function suppressionFailures(suppressions: readonly Suppression[]): Failures {
  const count = suppressions.length;

  return {
    sections: renderSuppressions(suppressions),
    clause: count === 0 ? '' : `, ${count} suppression comments`,
  };
}

function write(text: string): void {
  process.stdout.write(text);
}

async function git(args: readonly string[]): Promise<string> {
  const result = await runTestProcess(['git', ...args], { cwd: ROOT });

  if (result.exitCode !== 0) {
    throw new UnverifiedError(`git ${args.join(' ')} failed: ${result.stderr.trim()}`);
  }

  return result.stdout;
}

async function gitFiles(args: readonly string[]): Promise<string[]> {
  const output = await git([...args, '-z']);

  return output.split('\0').filter((file) => file !== '');
}

function onDisk(file: string): boolean {
  return existsSync(path.join(ROOT, file));
}

/**
 * Biome's own executable for this platform. The `biome` launcher beside it is a Node script that
 * exits 0 with no output when the executable dies on a rule file, which reads as a clean run.
 */
export function biomeBinary(): string {
  try {
    const launcher = path.dirname(Bun.resolveSync('@biomejs/biome/package.json', ROOT));

    return Bun.resolveSync(`@biomejs/cli-${process.platform}-${process.arch}/biome`, launcher);
  } catch {
    throw new UnverifiedError(
      'the Biome executable for this platform does not resolve from this tree',
    );
  }
}

/**
 * One Biome run of the rules over exactly `files`, paths relative to `root`. The report goes to
 * a file of this run's own, so its absence means Biome did not get as far as linting: a rule
 * file that is missing or does not compile ends the run with the same exit code as a finding.
 */
export async function lintFiles(
  biome: string,
  root: string,
  files: readonly string[],
): Promise<Finding[]> {
  const plugins = parsePlugins(readFileSync(path.join(ROOT, BIOME_CONFIG), 'utf8'));
  const scratch = mkdtempSync(path.join(tmpdir(), 'check-slop-'));
  const output = path.join(scratch, 'report.json');

  try {
    const run = await runTestProcess(
      [
        biome,
        'lint',
        `--config-path=${path.join(ROOT, BIOME_CONFIG)}`,
        '--only=plugin',
        '--max-diagnostics=none',
        '--reporter=json',
        `--reporter-file=${output}`,
        ...files,
      ],
      { cwd: root, timeout: BIOME_TIMEOUT_MS },
    );

    if (!existsSync(output)) {
      throw new UnverifiedError(
        `biome exited ${run.exitCode} without a report: ${run.stderr.trim()}`,
      );
    }

    const report = parseReport(readFileSync(output, 'utf8'), new Set(plugins.map(ruleName)));

    if (report.fileCount !== files.length) {
      throw new UnverifiedError(
        `biome linted ${report.fileCount} of the ${files.length} files it was given`,
      );
    }

    return [...report.findings];
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** Everything a file's findings depend on besides its own bytes. */
async function ruleSetDigest(biome: string): Promise<string> {
  const version = await runTestProcess([biome, '--version']);

  if (version.exitCode !== 0) {
    throw new UnverifiedError(`biome --version exited ${version.exitCode}`);
  }

  const plugins = parsePlugins(readFileSync(path.join(ROOT, BIOME_CONFIG), 'utf8'));
  const inputs = digestFiles(ROOT, [BIOME_CONFIG, 'scripts/check-slop.ts', ...plugins]);

  return Bun.CryptoHasher.hash('sha256', `${version.stdout}\0${inputs}`, 'hex');
}

function readBytes(root: string, file: string): Buffer {
  try {
    return readFileSync(path.join(root, file));
  } catch {
    throw new UnverifiedError(`${file} changed during the run; run again`);
  }
}

function digestOf(bytes: Buffer): string {
  return Bun.CryptoHasher.hash('sha256', bytes, 'hex');
}

/**
 * One read of each of `files`, paths relative to `root`. Every file goes to the comment rules. A
 * script file is also digested and scanned for suppression comments: `digests` names exactly
 * the files Biome is handed.
 */
export function readFiles(root: string, files: readonly string[]): Reading {
  const digests = new Map<string, string>();
  const suppressions: Suppression[] = [];
  const comments: Finding[] = [];

  for (const file of files) {
    const bytes = readBytes(root, file);
    const text = bytes.toString('utf8');
    comments.push(...measureFile(file, text));

    if (!isLinted(file)) continue;

    digests.set(file, digestOf(bytes));
    suppressions.push(...findSuppressions(file, text));
  }

  return { digests, suppressions, comments };
}

function readCacheFile(rules: string): SlopCache {
  if (!cacheEnabled() || !onDisk(CACHE_FILE)) return { rules, files: new Map() };

  return parseCache(readFileSync(path.join(ROOT, CACHE_FILE), 'utf8'), rules);
}

/** Written beside its final name and renamed over it, so a concurrent run reads a whole file. */
function writeCacheFile(cache: SlopCache): void {
  if (!cacheEnabled()) return;

  const file = path.join(ROOT, CACHE_FILE);
  const draft = `${file}.${process.pid}`;
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(draft, formatCache(cache));
  renameSync(draft, file);
}

/**
 * The findings and suppression comments of `files`. The comment rules read every file on every
 * run. Biome lints only the script files whose bytes the cache has not seen under this rule set,
 * and a file that changed while it ran is no answer.
 */
async function measure(files: readonly string[], wholeTree: boolean): Promise<Measurement> {
  const biome = biomeBinary();
  const cache = readCacheFile(await ruleSetDigest(biome));
  const { digests, suppressions, comments } = readFiles(ROOT, files);
  const { known, pending } = splitByCache(digests, cache);
  const fresh = pending.length > 0 ? await lintFiles(biome, ROOT, pending) : [];

  for (const file of pending) {
    if (digestOf(readBytes(ROOT, file)) !== digests.get(file)) {
      throw new UnverifiedError(`${file} changed during the run; run again`);
    }
  }

  const next = mergeCache(cache, digests, pending, fresh, wholeTree);

  if (pending.length > 0 || next.files.size !== cache.files.size) writeCacheFile(next);

  return {
    findings: [...known, ...fresh, ...comments],
    failures: suppressionFailures(suppressions),
  };
}

/** Every file the gate answers for: tracked or not ignored, on disk, and measured. */
async function treeFiles(): Promise<string[]> {
  const listed = await gitFiles(['ls-files', '--cached', '--others', '--exclude-standard']);

  return [...new Set(listed)].filter((file) => isMeasured(file) && onDisk(file)).sort(order);
}

async function measureTree(): Promise<Measurement> {
  return measure(await treeFiles(), true);
}

/**
 * The commit's own files against the baseline the commit carries. A staged file with unstaged
 * edits is refused, as the ratchet refuses it: the tree Biome reads would not be the commit.
 */
async function checkStaged(): Promise<number> {
  const staged = await gitFiles(['diff', '--cached', '--name-only', '--no-renames', 'HEAD']);

  if (staged.length === 0) {
    write('check:slop: nothing staged\n');

    return 0;
  }

  const unstaged = await gitFiles(['diff', '--name-only', '--no-renames']);
  const partial = partiallyStaged(staged, unstaged);

  if (partial.length > 0) {
    write('FAIL  staged files with unstaged edits (stage the whole file, or stash the rest):\n');
    write(partial.map((file) => `  ${file}\n`).join(''));

    return 1;
  }

  const present = staged.filter((file) => isMeasured(file) && onDisk(file));
  const measured = await measure(present, false);
  const baseline = parseBaseline(GATE, await git(['show', `:${GATE.baseline}`]));
  const files = new Set(staged);
  const scope = { inScope: (file: string) => files.has(file), exists: onDisk };

  return conclude(judge(GATE, 'staged files', measured, baseline, scope));
}

async function run(mode: Mode): Promise<number> {
  if (mode === 'staged') return checkStaged();

  return conclude(await runTree(GATE, ROOT, mode, measureTree));
}

const MODES = new Map<string, Mode>([
  ['--staged', 'staged'],
  ['--tighten', 'tighten'],
  ['--write-baseline', 'write-baseline'],
]);

if (import.meta.main) {
  await main(GATE, () => run(selectMode(process.argv.slice(2), MODES, 'check')));
}
