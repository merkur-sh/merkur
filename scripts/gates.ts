/**
 * The gates a change earns.
 *
 * `bazel test //...` is every unit test and static gate, and Bazel runs only the ones whose
 * inputs changed: the rest it answers from its cache. What it cannot run comes from `RULES`
 * (`gate-policy.ts`): the dependency audit, and the browser, container and proof suites that
 * take minutes, which a run names and `--all` runs.
 *
 *   bun run gates                 print the gates for the working tree's changes
 *   bun run gates --run           run them
 *   bun run gates --run --all     run them, then the minutes-long suites
 *   bun run gates --base <ref>    also count the commits since <ref>
 *   bun run gates --files a,b     these files instead of the working tree's changes
 */

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Schema } from 'effect';
import { parseSync } from 'oxc-parser';

import { gatePathMatches, RULES, ruleMatches } from './gate-policy';

const ROOT = path.resolve(import.meta.dir, '..');
const isString = Schema.is(Schema.String);

export type Command = readonly string[];

export interface GatePlan {
  readonly files: readonly string[];
  /** Every changed file matched a no-gate row (docs, agent harness), or nothing changed. */
  readonly docsOnly: boolean;
  readonly commands: readonly Command[];
  /** Script names that take minutes; printed for the operator, run only with `--all`. */
  readonly deferred: readonly Command[];
  readonly reasons: readonly string[];
}

/** Each E2E spec or Playwright configuration, by path glob, with the suites that run it. */
export type E2eOwners = ReadonlyMap<string, readonly Command[]>;

function normalize(file: string): string {
  return file.replace(/^\.\//, '').split(path.sep).join('/');
}

function key(command: Command): string {
  return JSON.stringify(command);
}

/** Select the gates for a set of changed files. Pure: the E2E owners come in as an argument. */
export function selectGates(changed: readonly string[], e2eOwners: E2eOwners): GatePlan {
  const files = [...new Set(changed.map(normalize))].sort();
  const deferred = new Map<string, Command>();
  const addDeferred = (command: Command) => deferred.set(key(command), command);
  const reasons: string[] = [];
  let audit = false;
  let gated = false;
  for (const file of files) {
    let prose = false;
    for (const rule of RULES) {
      if (!ruleMatches(rule, file)) continue;
      const { effects } = rule;
      if (effects.noGate) {
        prose = true;
        continue;
      }
      reasons.push(`${file} → ${rule.name}`);
      audit ||= effects.audit === true;
      for (const script of effects.deferred ?? []) addDeferred(['bun', 'run', script]);
      if (effects.e2e) {
        const owners = [...e2eOwners].flatMap(([pattern, commands]) =>
          gatePathMatches(pattern, file) ? commands : [],
        );
        if (owners.length === 0) throw new Error(`No E2E owner registered for ${file}`);
        for (const command of owners) addDeferred(command);
      }
    }
    gated ||= !prose;
  }
  // The transport harness's latency phase is `test:e2e:latency`.
  if (deferred.has(key(['bun', 'run', 'test:e2e:transport'])))
    deferred.delete(key(['bun', 'run', 'test:e2e:latency']));
  const commands: Command[] = [];
  if (gated) {
    commands.push(['bazel', 'test', '//...']);
    if (audit)
      commands.push(['bun', 'run', 'check:audit'], ['bun', 'run', 'check:js-dependency-policy']);
  } else if (files.length > 0) {
    commands.push(['bazel', 'test', '//:check_docs']);
  }
  return {
    files,
    docsOnly: !gated,
    commands,
    deferred: [...deferred.values()].sort((a, b) => a.join(' ').localeCompare(b.join(' '))),
    reasons,
  };
}

export function renderPlan(plan: GatePlan, all = false): string {
  if (plan.files.length === 0) return 'no gate: nothing changed\n';
  const lines = [
    plan.docsOnly
      ? '# docs-only change'
      : `# ${plan.files.length} changed file${plan.files.length === 1 ? '' : 's'}`,
    ...plan.commands.map((command) => command.join(' ')),
  ];
  if (plan.deferred.length > 0) {
    lines.push(all ? '# then (minutes)' : '# then, by hand (minutes)');
    for (const command of plan.deferred) lines.push(command.join(' '));
  }
  if (plan.reasons.length > 0)
    lines.push('# selection reasons', ...plan.reasons.map((reason) => `# ${reason}`));
  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------------------
// CLI

interface CliOptions {
  readonly run: boolean;
  readonly all: boolean;
  readonly base: string | undefined;
  readonly files: readonly string[] | undefined;
}

class UsageError extends Error {}

const USAGE = 'usage: bun run gates [--run] [--all] [--base <ref>] [--files a,b]\n';

function flagValue(argv: readonly string[], index: number, flag: string, what: string): string {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) throw new UsageError(`${flag} needs ${what}`);
  return value;
}

export function parseArgs(argv: readonly string[]): CliOptions {
  let run = false;
  let all = false;
  let base: string | undefined;
  let files: string[] | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--run') run = true;
    else if (arg === '--all') all = true;
    else if (arg === '--base') {
      base = flagValue(argv, index, arg, 'a git ref');
      index += 1;
    } else if (arg === '--files') {
      const value = flagValue(argv, index, arg, 'a comma-separated list');
      files = [...(files ?? []), ...value.split(',').filter((entry) => entry.length > 0)];
      index += 1;
    } else throw new UsageError(`unknown argument: ${arg}`);
  }
  return { run, all, base, files };
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
export function playwrightPatterns(source: string) {
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
      if (property.key.type === 'Identifier' && property.key.name === name) return property.value;
      if (property.key.type === 'Literal' && property.key.value === name) return property.value;
    }
    throw new Error(`Playwright config must declare ${name}`);
  };
  const directory = field('testDir');
  const testDir = directory.type === 'Literal' ? directory.value : undefined;
  if (!isString(testDir)) throw new Error('Playwright testDir must be a literal');
  const match = field('testMatch');
  const values = match.type === 'ArrayExpression' ? match.elements : [match];
  return {
    testDir,
    testMatch: values.map((value) => {
      const pattern = value?.type === 'Literal' ? value.value : undefined;
      if (!isString(pattern))
        throw new Error('Playwright testMatch must contain literal glob strings');
      return pattern;
    }),
  };
}

const CONFIG_SCRIPTS = new Map([
  ['playwright.config.mjs', 'test:e2e'],
  ['playwright.email.config.mjs', 'test:e2e:email'],
  ['playwright.burst.config.mjs', 'test:e2e:burst'],
  ['playwright.edge.config.mjs', 'test:e2e:transport'],
  ['playwright.edge-topology.config.mjs', 'test:e2e:edge-topology'],
  ['playwright.edge-cloud.config.mjs', 'test:e2e:cloud'],
  ['playwright.edge-probe.config.mjs', 'test:e2e:edge-probe'],
  ['playwright.site.config.mjs', 'test:e2e:site'],
  ['scripts/natlab/playwright.native.config.mjs', 'test:natlab'],
]);

/** The specs a calibrated suite runs instead of their configuration's own. */
const SPEC_SUITES = new Map([
  ['carrier-rebind.e2e.ts', 'test:e2e:rebind'],
  ['tui-rebind.e2e.ts', 'test:e2e:rebind'],
  ['edge-handshake-reorder.e2e.ts', 'test:e2e:transport:reorder'],
]);

/** The suite that runs one spec of `script`'s configuration. */
function specOwner(script: string, spec: string, defaultTransport: readonly string[]): Command {
  const owner = SPEC_SUITES.get(spec) ?? script;
  // The default transport harness runs an explicit subset of its config. Specs outside its two
  // phases need an explicit filter or they never run.
  return owner === 'test:e2e:transport' &&
    !defaultTransport.includes(spec.replace(/\.e2e\.ts$/, ''))
    ? ['bun', 'run', owner, '--', spec]
    : ['bun', 'run', owner];
}

function addOwner(owners: Map<string, Command[]>, pattern: string, command: Command): void {
  const commands = owners.get(pattern) ?? [];
  if (!commands.some((existing) => key(existing) === key(command))) commands.push(command);
  owners.set(pattern, commands);
}

export async function e2eOwners(root: string = ROOT): Promise<E2eOwners> {
  const { readE2eSpecInputs } = await import('./generate-docs');
  const inputs = readE2eSpecInputs(root);
  const defaultTransport = [...inputs.latencySpecs, ...inputs.functionalSpecs];
  const owners = new Map<string, Command[]>();
  for (const config of inputs.configs) {
    const script = CONFIG_SCRIPTS.get(config.file);
    if (script === undefined) throw new Error(`No verification entry point for ${config.file}`);
    addOwner(owners, config.file, ['bun', 'run', script]);
    const value = playwrightPatterns(readFileSync(path.join(root, config.file), 'utf8'));
    for (const pattern of value.testMatch) {
      const directory = path.dirname(path.join(root, config.file));
      const file = path.join(path.relative(root, path.resolve(directory, value.testDir)), pattern);
      const command = specOwner(script, path.basename(pattern), defaultTransport);
      addOwner(owners, config.file, command);
      addOwner(owners, file, command);
    }
  }
  // A spec the transport harness runs needs no cloud run beside it.
  for (const [file, commands] of owners) {
    if (commands.some((command) => command[2] === 'test:e2e:transport'))
      owners.set(
        file,
        commands.filter((command) => command[2] !== 'test:e2e:cloud'),
      );
  }
  return owners;
}

async function execute(command: Command): Promise<number> {
  const [executable, ...args] = command;
  if (executable === undefined) throw new Error('empty gate command');
  process.stdout.write(`[start] ${command.join(' ')}\n`);
  const child = spawn(executable === 'bun' ? process.execPath : executable, args, {
    cwd: ROOT,
    stdio: 'inherit',
  });
  return await new Promise<number>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => resolve(code ?? 1));
  });
}

if (import.meta.main) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const plan = selectGates(options.files ?? changedFiles(options.base), await e2eOwners());
    process.stdout.write(renderPlan(plan, options.all));
    if (options.run) {
      for (const command of [...plan.commands, ...(options.all ? plan.deferred : [])]) {
        const code = await execute(command);
        if (code !== 0) {
          process.exitCode = code;
          break;
        }
      }
    }
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    process.stderr.write(`${error.message}\n${USAGE}`);
    process.exitCode = 2;
  }
}
