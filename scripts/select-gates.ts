import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseSync } from 'oxc-parser';

import { gatePathMatches as matches, RULES, ruleMatches, STATIC_GATES } from './gate-policy';

export type { Rule } from './gate-policy';
export { RULES, ruleGlobs, ruleMatches } from './gate-policy';

import {
  PROTOCOL_CRATES,
  PROTOCOL_DATAPLANE_FILTERS,
  PROTOCOL_DATAPLANE_SKIPS,
  PROTOCOL_SCAN,
  PROTOCOL_TESTS,
} from './protocol-gates';
import { discoverTests, testCommand, testDependents } from './test-inventory';
import type { TestPartition } from './verification-cache';

const ROOT = path.resolve(import.meta.dir, '..');

/** Shared plan for gates, verify, unit tests and protocol checks.
 * RULES also generates the README gate table. Builds and provenance
 * precede static checks and the single Cargo / isolated Bun lanes.
 */
export interface GateDeps {
  readonly testFiles: readonly string[];
  readonly unitOwners: ReadonlyMap<string, readonly string[]>;
  readonly e2eOwners: ReadonlyMap<string, readonly Command[]>;
  /** Test file → its import closure, the input set the verification cache keys on. */
  readonly testClosures: ReadonlyMap<string, readonly string[]>;
}

export type Command = readonly string[];

export interface GatePlan {
  readonly files: readonly string[];
  /**
   * Every changed file matched a no-gate row (docs, agent harness), or nothing changed.
   * Prose still earns `check:docs`, so `static` is that one gate when files changed.
   */
  readonly docsOnly: boolean;
  /** Generated artifacts that must be rebuilt before anything below runs. */
  readonly builds: readonly Command[];
  readonly preflight: readonly Command[];
  readonly reasons: readonly string[];
  readonly static: readonly Command[];
  readonly cargo: readonly Command[];
  readonly bun: readonly Command[];
  /** The bun lane's test files, named so the result cache can drop the proven ones. */
  readonly tests: readonly string[];
  /**
   * Changed files the bun lane answers for. A file here that no test closure names is one
   * the cache cannot reason about, so it discards every cached result for the run.
   */
  readonly bunInputs: readonly string[];
  /** Script names that take minutes; printed for the operator, run only with `--all`. */
  readonly deferred: readonly Command[];
}

/**
 * The dataplane tests that run the separately built image helper. A dataplane test run never
 * builds another package's binary, so they stay `#[ignore]`d in every other lane and live in
 * `real_helper` modules; `build:image-worker` precedes this lane in the same profile and
 * target directory, and Cargo's own freshness check rebuilds a changed helper there.
 */
const DATAPLANE = 'apps/daemon/dataplane';
const WASM_CIPHER_TESTS = 'test:wasm-cipher';

export const REAL_HELPER_LANE: Command = [
  'cargo',
  'test',
  '--locked',
  '-p',
  'merkur-dataplane',
  '--',
  '--ignored',
  'real_helper::',
];

/**
 * Libtest filters for the dataplane, derived from the changed module paths.
 *
 * A directory module (`src/display/send.rs`) selects its whole subtree (`display::`): the
 * tests for a scheduler change usually sit in a sibling module. A root-level file selects
 * by bare name (`edge_tunnel`), which also catches the `edge_tunnel_congestion_tests`
 * sibling. `main.rs`, the manifest and the build script select the whole crate.
 */
export function dataplaneTestFilters(files: readonly string[]): readonly string[] {
  const filters = new Set<string>();
  for (const file of files) {
    if (!file.startsWith(`${DATAPLANE}/`)) continue;
    const inside = file.slice(`${DATAPLANE}/`.length);
    if (!inside.startsWith('src/')) return [];
    const segments = inside.slice('src/'.length).split('/');
    const first = segments[0];
    if (first === undefined) return [];
    if (segments.length === 1) {
      if (first === 'main.rs' || first === 'lib.rs') return [];
      filters.add(first.replace(/\.rs$/, ''));
    } else {
      filters.add(`${first}::`);
    }
  }
  return [...filters].sort();
}

function normalize(file: string): string {
  return file.replace(/^\.\//, '').split(path.sep).join('/');
}

function dedupe<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

/**
 * Select and batch the gates for a set of changed files. Pure: every filesystem and
 * process question is asked through `deps`, so the fixture tests never touch git.
 */
export function selectGates(changed: readonly string[], deps: GateDeps): GatePlan {
  const files = dedupe(changed.map(normalize)).sort();
  const builds = new Set<string>();
  const directories = new Set<string>();
  const tests = new Set<string>();
  const crates = new Set<string>();
  const cargoScripts = new Set<string>();
  const bunInputs = new Set<string>();
  const deferred = new Map<string, Command>();
  const addDeferred = (command: Command) => deferred.set(JSON.stringify(command), command);
  const reasons: string[] = [];
  let rustLint = false;
  let realHelper = false;
  let protocol = false;
  let audit = false;
  let gated = false;
  for (const file of files) {
    let prose = false;
    let matched = false;
    for (const rule of RULES) {
      if (!ruleMatches(rule, file)) continue;
      const effects = rule.effects;
      if (effects.noGate) {
        prose = true;
        continue;
      }
      matched = true;
      reasons.push(`${file} → ${rule.name}`);
      // The rows whose coverage is a Bun test run: their changed files are what the result
      // cache must account for, either through a closure or by invalidating.
      if (
        effects.bunTestDir !== undefined ||
        effects.bunTestFiles !== undefined ||
        effects.allUnit === true
      )
        bunInputs.add(file);
      for (const build of effects.builds ?? []) builds.add(build);
      if (effects.allUnit) {
        for (const test of deps.testFiles) {
          tests.add(test);
          reasons.push(`${test} ← ${file} (${rule.name})`);
        }
      }
      if (effects.bunTestDir !== undefined) {
        // Runtime imports cannot see tests that inspect source text. Keep the owning
        // suite, and add cross-workspace consumers from the compiler's import graph.
        if (deps.testFiles.includes(file)) tests.add(file);
        else directories.add(effects.bunTestDir);
        for (const test of deps.unitOwners.get(file) ?? []) {
          tests.add(test);
          reasons.push(`${test} ← ${file} (compiler import closure)`);
        }
      }
      for (const test of effects.bunTestFiles ?? []) {
        tests.add(test);
        reasons.push(`${test} ← ${file} (${rule.name})`);
      }
      for (const crate of effects.crates ?? []) crates.add(crate);
      for (const script of effects.cargoScripts ?? []) cargoScripts.add(script);
      for (const script of effects.deferred ?? []) addDeferred(['bun', 'run', script]);
      if (effects.e2e) {
        const owners = [...deps.e2eOwners].flatMap(([pattern, scripts]) =>
          matches(pattern, file) ? scripts : [],
        );
        if (owners.length === 0) throw new Error(`No E2E owner registered for ${file}`);
        for (const command of owners) addDeferred(command);
      }
      rustLint ||= effects.rustLint === true;
      realHelper ||= effects.realHelper === true;
      protocol ||= effects.protocol === true;
      audit ||= effects.audit === true;
    }
    gated ||= matched || !prose;
  }
  for (const test of deps.testFiles) {
    for (const dir of directories) {
      if (!test.startsWith(`${dir}/`)) continue;
      tests.add(test);
      reasons.push(`${test} ← owning suite ${dir}`);
    }
  }
  if (deferred.has(JSON.stringify(['bun', 'run', 'test:e2e:transport'])))
    deferred.delete(JSON.stringify(['bun', 'run', 'test:e2e:latency']));
  // build:wasm already builds e2e-wasm.
  if (builds.has('build:wasm')) builds.delete('build:e2e-wasm');
  return assemblePlan({
    files,
    builds: [...builds],
    tests: [...tests],
    bunInputs: [...bunInputs].sort(),
    crates: [...crates],
    cargoScripts: [...cargoScripts].sort(),
    clientOracle: [...tests].some((test) =>
      deps.testClosures.get(test)?.includes('scripts/perf/client-session-fixture.ts'),
    ),
    staticGates: gated ? STATIC_GATES : files.length > 0 ? ['check:docs'] : [],
    rustLint,
    realHelper,
    protocol,
    audit,
    deferred: [...deferred.values()].sort((a, b) => a.join(' ').localeCompare(b.join(' '))),
    reasons,
    docsOnly: !gated,
  });
}

interface PlanSelection {
  readonly files: readonly string[];
  readonly builds: readonly string[];
  readonly tests: readonly string[];
  readonly bunInputs?: readonly string[];
  readonly crates: readonly string[];
  readonly cargoScripts: readonly string[];
  readonly staticGates: readonly string[];
  readonly rustLint: boolean;
  readonly realHelper: boolean;
  readonly clientOracle: boolean;
  readonly protocol: boolean;
  readonly audit: boolean;
  readonly deferred: readonly Command[];
  readonly reasons: readonly string[];
  readonly docsOnly: boolean;
}

function assemblePlan(selection: PlanSelection): GatePlan {
  const tests = new Set(selection.tests);
  const reasons = [...selection.reasons];
  const preflight: Command[] = [];
  const cargo: Command[] = [];
  if (selection.rustLint) cargo.push(['bun', 'run', 'rust:lint'], ['bun', 'run', 'rust:deps']);
  const wholeCrates = new Set(selection.crates.filter((crate) => crate !== 'merkur-dataplane'));
  const filters = selection.crates.includes('merkur-dataplane')
    ? dataplaneTestFilters(selection.files)
    : undefined;
  if (selection.protocol) {
    for (const test of PROTOCOL_TESTS) {
      tests.add(test);
      reasons.push(`${test} ← protocol contract`);
    }
    tests.add(PROTOCOL_SCAN);
    for (const crate of PROTOCOL_CRATES) wholeCrates.add(crate);
    preflight.push(['bun', 'run', 'scripts/check-wasm-artifacts.ts']);
  }
  if (tests.delete(PROTOCOL_SCAN)) preflight.unshift(testCommand([PROTOCOL_SCAN]));
  // Protocol expansion always includes the authenticated session fixture,
  // after selection has inspected the owning-suite import closures.
  if (selection.clientOracle || selection.protocol)
    preflight.push(['bun', 'run', 'scripts/prepare-client-session-oracle.ts']);
  if (filters?.length === 0) wholeCrates.add('merkur-dataplane');
  if (wholeCrates.size > 0)
    cargo.push([
      'cargo',
      'test',
      '--locked',
      ...[...wholeCrates].sort().flatMap((crate) => ['-p', crate]),
    ]);
  if (!wholeCrates.has('merkur-dataplane') && (filters !== undefined || selection.protocol)) {
    cargo.push([
      'cargo',
      'test',
      '--locked',
      '-p',
      'merkur-dataplane',
      '--',
      ...dedupe([...(filters ?? []), ...(selection.protocol ? PROTOCOL_DATAPLANE_FILTERS : [])]),
      ...(selection.protocol ? PROTOCOL_DATAPLANE_SKIPS.flatMap((test) => ['--skip', test]) : []),
    ]);
  }
  if (selection.realHelper) cargo.push(REAL_HELPER_LANE);
  for (const script of selection.cargoScripts) cargo.push(['bun', 'run', script]);
  const bun: Command[] = tests.size > 0 ? [testCommand([...tests])] : [];
  if (selection.audit) bun.push(['bun', 'run', 'check:audit']);
  return {
    files: selection.files,
    docsOnly: selection.docsOnly,
    builds: selection.builds.map((script) => ['bun', 'run', script]),
    preflight,
    static: selection.staticGates.map((script) => ['bun', 'run', script]),
    cargo,
    bun,
    tests: [...tests].sort(),
    bunInputs: selection.bunInputs ?? [],
    deferred: selection.deferred,
    reasons: dedupe(reasons),
  };
}

export function verificationPlan(
  mode: 'unit' | 'protocol' | 'verify',
  testFiles: readonly string[],
): GatePlan {
  return assemblePlan({
    files: [],
    // Full verification also proves the decoded-image paths, which only the helper runs.
    builds: mode === 'verify' ? ['build:image-worker'] : [],
    tests: mode === 'protocol' ? [] : testFiles,
    crates: [],
    // The browser cipher is protocol crypto that only a wasm32 run reaches.
    cargoScripts: mode === 'unit' ? [] : [WASM_CIPHER_TESTS],
    staticGates: mode === 'verify' ? STATIC_GATES : [],
    rustLint: false,
    realHelper: mode === 'verify',
    clientOracle: mode !== 'protocol',
    protocol: mode !== 'unit',
    audit: mode === 'verify',
    deferred: [],
    docsOnly: false,
    reasons: [`${mode}: complete owned test inventory and shared protocol prerequisites`],
  });
}

/**
 * Every workspace crate's tests and doctests through the cargo lane: one build, then the
 * test binaries side by side. `members` comes from `cargo metadata`, so a new crate joins
 * without an edit here.
 */
export function rustWorkspacePlan(members: readonly string[]): GatePlan {
  if (members.length === 0) throw new Error('Refusing an empty Rust workspace');
  return assemblePlan({
    files: [],
    builds: [],
    tests: [],
    crates: members,
    cargoScripts: [],
    staticGates: [],
    rustLint: false,
    realHelper: false,
    clientOracle: false,
    protocol: false,
    audit: false,
    deferred: [],
    docsOnly: false,
    reasons: ['rust: every workspace crate'],
  });
}

/**
 * The bun lane with its test command narrowed to the tests that still have to run. An empty
 * `fresh` drops the command outright: `bun test` with no files would run the whole repo.
 */
export function cachedBunLane(plan: GatePlan, fresh: readonly string[]): readonly Command[] {
  const rest = plan.bun.filter((command) => !(command[0] === 'bun' && command[1] === 'test'));
  return fresh.length > 0 ? [testCommand(fresh), ...rest] : rest;
}

export function renderPlan(
  plan: GatePlan,
  options: {
    readonly all?: boolean;
    /** What the result cache already proves, so a print-only run answers "am I verified?". */
    readonly cache?: TestPartition;
  } = {},
): string {
  if (plan.docsOnly) {
    if (plan.static.length === 0) return 'no gate: nothing changed\n';
    return `# docs-only change\n${plan.static.map((command) => command.join(' ')).join('\n')}\n`;
  }
  const lines: string[] = [
    `# ${plan.files.length} changed file${plan.files.length === 1 ? '' : 's'}`,
  ];
  const section = (title: string, commands: readonly Command[]): void => {
    if (commands.length === 0) return;
    lines.push(title);
    for (const command of commands) lines.push(command.join(' '));
  };
  section('# builds (first)', plan.builds);
  section('# preflight', plan.preflight);
  section('# static (always)', plan.static);
  section(
    '# cargo lane (one shared test build; per-package filters; Cargo-owned doctests)',
    plan.cargo,
  );
  const cache = options.cache;
  if (cache !== undefined && plan.tests.length > 0) {
    lines.push(
      `# bun lane (may overlap cargo): ${cache.fresh.length} of ${plan.tests.length} test files; ${cache.cached.length} already green for these inputs`,
    );
    if (cache.unclaimed.length > 0) {
      lines.push(
        `# cache dropped: ${cache.unclaimed.length} changed file(s) no test closure names (${cache.unclaimed.slice(0, 3).join(', ')})`,
      );
    }
    for (const command of cachedBunLane(plan, cache.fresh)) lines.push(command.join(' '));
  } else section('# bun lane (may overlap cargo)', plan.bun);
  if (plan.deferred.length > 0) {
    lines.push(options.all === true ? '# then (minutes)' : '# then, by hand (minutes)');
    for (const command of plan.deferred) lines.push(command.join(' '));
  }
  lines.push('# selection reasons', ...plan.reasons.map((reason) => `# ${reason}`));
  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------------------
// CLI

interface CliOptions {
  readonly run: boolean;
  readonly all: boolean;
  /** Ignore the result cache: every selected test runs, whatever it already proved. */
  readonly force: boolean;
  readonly base: string | undefined;
  readonly files: readonly string[] | undefined;
}

class UsageError extends Error {}

const USAGE = 'usage: bun run gates [--run] [--all] [--force] [--base <ref>] [--files a,b]\n';

export function parseArgs(argv: readonly string[]): CliOptions {
  let run = false;
  let all = false;
  let force = false;
  let base: string | undefined;
  let files: string[] | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case '--run':
        run = true;
        break;
      case '--all':
        all = true;
        break;
      case '--force':
        force = true;
        break;
      case '--base': {
        const value = argv[index + 1];
        if (value === undefined || value.startsWith('--')) {
          throw new UsageError('--base needs a git ref');
        }
        base = value;
        index += 1;
        break;
      }
      case '--files': {
        const value = argv[index + 1];
        if (value === undefined || value.startsWith('--')) {
          throw new UsageError('--files needs a comma-separated list');
        }
        files = [...(files ?? []), ...value.split(',').filter((entry) => entry.length > 0)];
        index += 1;
        break;
      }
      default:
        throw new UsageError(`unknown argument: ${arg}`);
    }
  }
  return { run, all, force, base, files };
}

function git(args: readonly string[]): string {
  const proc = Bun.spawnSync(['git', ...args], {
    cwd: ROOT,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (proc.exitCode !== 0) {
    throw new UsageError(`git ${args.join(' ')} failed:\n${proc.stderr.toString().trim()}`);
  }
  return proc.stdout.toString();
}

export function changedFiles(base: string | undefined, runGit = git): string[] {
  const files = new Set<string>();
  const status = runGit(['status', '--porcelain', '-z', '--untracked-files=all']).split('\0');
  for (let index = 0; index < status.length; index++) {
    const entry = status[index];
    if (entry === undefined || entry.length < 4) continue;
    files.add(entry.slice(3));
    if (entry.slice(0, 2).includes('R') || entry.slice(0, 2).includes('C')) {
      const source = status[++index];
      if (source !== undefined) files.add(source);
    }
  }
  if (base !== undefined) {
    const mergeBase = runGit(['merge-base', base, 'HEAD']).trim();
    for (const file of runGit([
      'diff',
      '--name-only',
      '-z',
      '--no-renames',
      `${mergeBase}..HEAD`,
    ]).split('\0')) {
      if (file !== '') files.add(file);
    }
  }
  return [...files].sort();
}

/** Read exact literal config fields without executing environment-dependent setup. */
export function playwrightPatterns(source: string): { testDir: string; testMatch: string[] } {
  const parsed = parseSync('playwright.config.mjs', source);
  if (parsed.errors.length > 0) throw new Error('Cannot parse Playwright config');
  const exported = parsed.program.body.find((node) => node.type === 'ExportDefaultDeclaration');
  if (exported === undefined || exported.declaration.type !== 'CallExpression')
    throw new Error('Playwright config must export a defineConfig call');
  const options = exported.declaration.arguments[0];
  if (options?.type !== 'ObjectExpression')
    throw new Error('Playwright config must declare literal options');
  const field = (name: string) => {
    for (const property of options.properties) {
      if (property.type !== 'Property' || property.computed) continue;
      const key =
        property.key.type === 'Identifier'
          ? property.key.name
          : property.key.type === 'Literal'
            ? property.key.value
            : undefined;
      if (key === name) return property.value;
    }
    throw new Error(`Playwright config must declare ${name}`);
  };
  const directory = field('testDir');
  if (directory.type !== 'Literal' || typeof directory.value !== 'string')
    throw new Error('Playwright testDir must be a literal');
  const match = field('testMatch');
  const values = match.type === 'ArrayExpression' ? match.elements : [match];
  return {
    testDir: directory.value,
    testMatch: values.map((value) => {
      if (value?.type !== 'Literal' || typeof value.value !== 'string')
        throw new Error('Playwright testMatch must contain literal glob strings');
      return value.value;
    }),
  };
}

export async function gateDependencies(root: string = ROOT): Promise<GateDeps> {
  const { readE2eSpecInputs } = await import('./generate-docs');
  const inputs = readE2eSpecInputs(root);
  const scripts: Record<string, string> = {
    'playwright.config.mjs': 'test:e2e',
    'playwright.email.config.mjs': 'test:e2e:email',
    'playwright.burst.config.mjs': 'test:e2e:burst',
    'playwright.edge.config.mjs': 'test:e2e:transport',
    'playwright.edge-topology.config.mjs': 'test:e2e:edge-topology',
    'playwright.edge-cloud.config.mjs': 'test:e2e:cloud',
    'playwright.edge-probe.config.mjs': 'test:e2e:edge-probe',
    'playwright.site.config.mjs': 'test:e2e:site',
  };
  const e2eOwners = new Map<string, Command[]>();
  for (const config of inputs.configs) {
    const script = scripts[config.file];
    if (script === undefined) throw new Error(`No verification entry point for ${config.file}`);
    const configCommands: Command[] = [['bun', 'run', script]];
    e2eOwners.set(config.file, configCommands);
    const value = playwrightPatterns(readFileSync(path.join(root, config.file), 'utf8'));
    const patterns = value.testMatch;
    for (const pattern of patterns) {
      if (typeof pattern !== 'string')
        throw new Error(`${config.file} needs string testMatch patterns`);
      const file = path.join(path.relative(root, path.resolve(root, value.testDir)), pattern);
      const spec = path.basename(pattern);
      const owner =
        spec === 'carrier-rebind.e2e.ts' || spec === 'tui-rebind.e2e.ts'
          ? 'test:e2e:rebind'
          : spec === 'edge-handshake-reorder.e2e.ts'
            ? 'test:e2e:transport:reorder'
            : script;
      const command: Command = ['bun', 'run', owner];
      // The default transport harness runs an explicit subset of its config.
      // Specs outside its two phases need an explicit filter or they never run.
      const inDefaultTransport = [...inputs.latencySpecs, ...inputs.functionalSpecs].includes(
        spec.replace(/\.e2e\.ts$/, ''),
      );
      const selected =
        owner === 'test:e2e:transport' && !inDefaultTransport ? [...command, '--', spec] : command;
      if (!configCommands.some((value) => JSON.stringify(value) === JSON.stringify(selected)))
        configCommands.push(selected);
      const owners = e2eOwners.get(file) ?? [];
      if (!owners.some((value) => JSON.stringify(value) === JSON.stringify(selected)))
        owners.push(selected);
      e2eOwners.set(file, owners);
    }
  }
  for (const [file, owners] of e2eOwners) {
    if (owners.some((command) => command[2] === 'test:e2e:transport')) {
      e2eOwners.set(
        file,
        owners.filter((command) => command[2] !== 'test:e2e:cloud'),
      );
    }
  }
  const testFiles = discoverTests(root);
  const graph = testDependents(root, testFiles);
  return { testFiles, e2eOwners, unitOwners: graph.owners, testClosures: graph.closures };
}

if (import.meta.main) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.force) process.env.MERKUR_GATE_CACHE = '0';
    const files = options.files ?? changedFiles(options.base);
    const deps = await gateDependencies();
    const plan = selectGates(files, deps);
    // Computed once and handed to the executor: a print-only run answers "is this diff
    // already verified?" for the same cost as printing the plan.
    const { planPartition } = await import('./verification-cache');
    const cache = planPartition(ROOT, plan, deps);
    process.stdout.write(renderPlan(plan, { all: options.all, cache }));
    if (options.run) {
      const { executePlan } = await import('./verification-executor');
      const failure = await executePlan(plan, options.all, cache);
      if (failure !== 0) process.exitCode = failure;
    }
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`${error.message}\n${USAGE}`);
      process.exitCode = 2;
    } else {
      throw error;
    }
  }
}
