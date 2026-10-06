import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { Glob } from 'bun';
import { type Config, ConfigProvider, Effect } from 'effect';
import { serverEnvironment } from '../packages/config/src/server-environment';

import { REAL_HELPER_LANE, RULES, type Rule, ruleGlobs } from './select-gates';

const ROOT = path.resolve(import.meta.dir, '..');

/**
 * Generated documentation blocks.
 *
 * The e2e suite table in `docs/processes.md` is a pure function of four things the repo
 * already owns — each `playwright*.config.mjs`'s `testMatch`, the root `package.json`'s
 * `test:e2e*` scripts, the harness's serial and parallel spec lists, and the `.e2e.ts`
 * literals the other driver scripts name — so it is rendered from them and spliced between
 * `<!-- generated:e2e-specs -->` markers. A hand-written copy drifted twice in one year.
 *
 * The verify skill's gate-selection table is rendered from `RULES` in `select-gates.ts`
 * between `<!-- generated:gate-rules -->` markers, so the table an agent reads and the data
 * `bun run gates` matches against are one thing.
 *
 * `check:docs` re-renders every block and compares, so a block can only be edited by
 * editing its inputs. `bun scripts/generate-docs.ts` writes them; `--check` prints the
 * stale ones and exits 1.
 */

export const E2E_BLOCK_NAME = 'e2e-specs';
export const GATE_BLOCK_NAME = 'gate-rules';
const HARNESS_SCRIPT = 'scripts/run-edge-harness.ts';
const PLAYWRIGHT_CONFIG = /playwright[\w.-]*\.config\.mjs/;
const SPEC_LITERAL = /\b([a-z0-9-]+)\.e2e\.ts\b/g;
const ENV_ASSIGNMENT = /^([A-Z][A-Z0-9_]*)=(\S*)$/;

export interface PlaywrightConfigSpecs {
  readonly file: string;
  readonly specs: readonly string[];
}

export interface DriverScriptSpecs {
  readonly file: string;
  readonly specs: readonly string[];
}

export interface E2eSpecInputs {
  /** Every `playwright*.config.mjs` and the spec names its `testMatch` admits. */
  readonly configs: readonly PlaywrightConfigSpecs[];
  /** Root `package.json` scripts named `test:e2e*`, in declaration order. */
  readonly scripts: ReadonlyArray<readonly [name: string, command: string]>;
  /** `LATENCY_SPECS` in the edge harness: run serially first. */
  readonly latencySpecs: readonly string[];
  /** `FUNCTIONAL_SPECS` in the edge harness: run in parallel afterwards. */
  readonly functionalSpecs: readonly string[];
  /** Scripts under `scripts/` that name a spec literal, and which specs. */
  readonly drivers: readonly DriverScriptSpecs[];
  /** Every `tests/e2e/*.e2e.ts`, by spec name. */
  readonly allSpecs: readonly string[];
}

export interface E2eTableRow {
  readonly command: string;
  readonly config: string;
  readonly profile: string;
  readonly specs: readonly string[];
  readonly phase: string;
}

function specNames(text: string): string[] {
  const names = new Set<string>();
  for (const match of text.matchAll(SPEC_LITERAL)) {
    if (match[1] !== undefined) names.add(match[1]);
  }
  return [...names].sort();
}

/** The spec names a `testMatch` admits, from the config's source text. */
export function parsePlaywrightTestMatch(source: string): string[] {
  const start = source.indexOf('testMatch');
  if (start === -1) return [];
  const open = source.indexOf(':', start);
  const rest = source.slice(open + 1);
  const end = rest.startsWith(' [') || rest.startsWith('[') ? rest.indexOf(']') : rest.indexOf(',');
  return specNames(rest.slice(0, end === -1 ? rest.length : end));
}

/** A named spec-list constant (`const NAME = [...]`) in a harness script. */
export function parseSpecListConstant(source: string, name: string): string[] {
  const match = new RegExp(`const ${name} = \\[([^\\]]*)\\]`).exec(source);
  return match?.[1] === undefined ? [] : specNames(match[1]);
}

function parseCommand(command: string): {
  env: ReadonlyArray<readonly [string, string]>;
  words: string[];
} {
  const words = command.trim().split(/\s+/);
  const env: Array<readonly [string, string]> = [];
  while (words.length > 0) {
    const head = words[0];
    const assignment = head === undefined ? null : ENV_ASSIGNMENT.exec(head);
    if (assignment === null || assignment[1] === undefined || assignment[2] === undefined) break;
    env.push([assignment[1], assignment[2]]);
    words.shift();
  }
  return { env, words };
}

function profileOf(env: ReadonlyArray<readonly [string, string]>): string {
  const parts: string[] = [];
  for (const [key, value] of env) {
    if (
      !key.startsWith('EDGE_NETWORK_') &&
      key !== 'FORCE_EDGE' &&
      key !== 'DIRECT_NETWORK_PROFILE'
    ) {
      continue;
    }
    switch (key) {
      case 'EDGE_NETWORK_PROFILE':
        parts.push(`\`${value}\``);
        break;
      case 'EDGE_NETWORK_DATAGRAM_LOSS_PERCENT':
        parts.push(`${value}% loss`);
        break;
      case 'EDGE_NETWORK_REORDER':
        parts.push(`${value} reorder`);
        break;
      case 'EDGE_NETWORK_SCENARIO':
        parts.push(`\`${value}\` scenario`);
        break;
      default:
        parts.push(`\`${key}=${value}\``);
    }
  }
  return parts.length === 0 ? 'default' : parts.join(', ');
}

function configOfCommand(
  words: readonly string[],
  readSource: (file: string) => string | undefined,
): string {
  const flag = words.indexOf('-c');
  const explicit = flag === -1 ? undefined : words[flag + 1];
  if (explicit !== undefined) return explicit;
  const script = words.find((word) => word.startsWith('scripts/') && word.endsWith('.ts'));
  if (script !== undefined) {
    const source = readSource(script);
    const mentioned = source === undefined ? null : PLAYWRIGHT_CONFIG.exec(source);
    if (mentioned !== null) return mentioned[0];
    return `(${script})`;
  }
  return 'playwright.config.mjs';
}

/**
 * The rows of the table, one per `test:e2e*` script.
 *
 * `readSource` resolves a driver script named in a command so its Playwright config can be
 * read off it; it is injected so the renderer stays a pure function of text.
 */
export function e2eTableRows(
  inputs: E2eSpecInputs,
  readSource: (file: string) => string | undefined,
): E2eTableRow[] {
  const rows: E2eTableRow[] = [];
  for (const [name, command] of inputs.scripts) {
    const { env, words } = parseCommand(command);
    const config = configOfCommand(words, readSource);
    const filtered = specNames(words.filter((word) => word.endsWith('.e2e.ts')).join(' '));
    const workersOne = words.includes('--workers=1');
    const isHarness = words.includes(HARNESS_SCRIPT);
    const configSpecs = inputs.configs.find((entry) => entry.file === config)?.specs ?? [];

    let specs: readonly string[];
    let phase: string;
    if (isHarness && filtered.length === 0) {
      specs = [...new Set([...inputs.latencySpecs, ...inputs.functionalSpecs])].sort();
      phase =
        `serial \`--workers=1\`: ${inputs.latencySpecs.map((spec) => `\`${spec}\``).join(', ')}; ` +
        `then ${inputs.functionalSpecs.length} functional specs in parallel`;
    } else if (filtered.length > 0) {
      specs = filtered;
      phase = workersOne ? 'one Playwright run, `--workers=1`' : 'one Playwright run';
    } else {
      specs = configSpecs;
      phase = 'one Playwright run';
    }
    rows.push({ command: name, config, profile: profileOf(env), specs, phase });
  }
  return rows;
}

function specCell(specs: readonly string[]): string {
  return specs.length === 0 ? '—' : specs.map((spec) => `\`${spec}\``).join(', ');
}

/** The whole generated block: the table and its two trailing bullets. */
export function renderE2eSpecTable(
  inputs: E2eSpecInputs,
  readSource: (file: string) => string | undefined,
): string {
  const rows = e2eTableRows(inputs, readSource);
  const lines = [
    '| Command | Config | Profile | Specs | Phase |',
    '| --- | --- | --- | --- | --- |',
  ];
  for (const row of rows) {
    lines.push(
      `| \`${row.command}\` | \`${row.config}\` | ${row.profile} | ${specCell(row.specs)} | ${row.phase} |`,
    );
  }

  const reachable = new Set<string>();
  for (const row of rows) {
    for (const spec of row.specs) reachable.add(spec);
  }
  const inAnyConfig = new Set<string>();
  for (const config of inputs.configs) {
    for (const spec of config.specs) inAnyConfig.add(spec);
  }
  const driversOf = (spec: string): string => {
    const files = inputs.drivers
      .filter((driver) => driver.specs.includes(spec))
      .map((driver) => `\`${driver.file}\``);
    return files.length === 0 ? 'no script drives it' : `driven by ${files.join(', ')}`;
  };

  const filterOnly = [...inAnyConfig].filter((spec) => !reachable.has(spec)).sort();
  const configless = inputs.allSpecs.filter((spec) => !inAnyConfig.has(spec)).sort();

  lines.push('');
  lines.push(
    filterOnly.length === 0
      ? '- Every spec in a config is reached by a `test:e2e*` script.'
      : `- Reachable only by an explicit filter (pass the spec name to the harness): ${filterOnly
          .map((spec) => {
            const configs = inputs.configs
              .filter((config) => config.specs.includes(spec))
              .map((config) => `\`${config.file}\``)
              .join(', ');
            return `\`${spec}\` (${configs}; ${driversOf(spec)})`;
          })
          .join('; ')}.`,
  );
  lines.push(
    configless.length === 0
      ? '- Every spec under `tests/e2e` belongs to a config.'
      : `- In no config, so no \`test:e2e*\` script can select them: ${configless
          .map((spec) => `\`${spec}\` (${driversOf(spec)})`)
          .join('; ')}.`,
  );
  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------------------------------
// Gate-selection table

function code(text: string): string {
  return `\`${text}\``;
}

/** The `Changed` cell: every glob, a group by its label, then the exclusions. */
export function gateRuleChangedCell(rule: Rule): string {
  const parts = rule.globs.map((entry) => (typeof entry === 'string' ? code(entry) : entry.label));
  const exclude = rule.exclude ?? [];
  const excluded = exclude.length === 0 ? '' : ` (except ${exclude.map(code).join(', ')})`;
  return `${parts.join(', ')}${excluded}`;
}

/**
 * The `Also run` cell, in the order `bun run gates` phases the plan: builds first, the
 * cargo lane, the bun lane, then the minutes-long gates it prints for the operator. The
 * static gates are implied by every row and stated once above the table.
 */
export function gateRuleAlsoRunCell(rule: Rule): string {
  const effects = rule.effects;
  if (effects.noGate) return `${code('check:docs')} only`;
  const parts: string[] = [];
  if (effects.builds !== undefined) {
    parts.push(`first ${effects.builds.map(code).join(', then ')}`);
  }
  if (effects.rustLint) parts.push(code('rust:lint'));
  if (effects.crates !== undefined) {
    const command = `cargo test --locked ${effects.crates.map((crate) => `-p ${crate}`).join(' ')}`;
    const filtered = effects.crates.length === 1 && effects.crates[0] === 'merkur-dataplane';
    parts.push(filtered ? `${code(command)} filtered to the changed modules` : code(command));
  }
  if (effects.realHelper) parts.push(code(REAL_HELPER_LANE.join(' ')));
  for (const script of effects.cargoScripts ?? []) parts.push(code(script));
  if (effects.protocol) parts.push(code('check:protocol'));
  if (effects.bunTestDir !== undefined)
    parts.push(`isolated source tests under ${code(effects.bunTestDir)}`);
  for (const file of effects.bunTestFiles ?? []) parts.push(`isolated ${code(file)}`);
  if (effects.allUnit) parts.push('complete isolated source inventory');
  if (effects.e2e) parts.push('owning Playwright suite(s)');
  if (effects.audit) parts.push(code('check:audit'));
  if (effects.deferred !== undefined) {
    const deferred = effects.deferred.map(code).join(', ');
    parts.push(parts.length === 0 ? `by hand: ${deferred}` : `then, by hand: ${deferred}`);
  }
  return parts.join('; ');
}

/** One row per rule, in `RULES` order, which is also the order `bun run gates` matches. */
export function renderGateRulesTable(rules: readonly Rule[]): string {
  const lines = ['| Changed | Also run | Why |', '| --- | --- | --- |'];
  for (const rule of rules) {
    if (ruleGlobs(rule).length === 0) throw new Error(`gate rule ${rule.name} has no globs`);
    lines.push(
      `| ${gateRuleChangedCell(rule)} | ${gateRuleAlsoRunCell(rule)} | ${rule.note ?? ''} |`,
    );
  }
  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------------------------------
// Blocks

export interface GeneratedBlock {
  /** The prose file holding the markers, repository-relative. */
  readonly file: string;
  readonly name: string;
  /** How a violation names the block. */
  readonly label: string;
  readonly render: (root: string) => string;
}

export function generatedMarkers(name: string): { open: string; close: string } {
  if (name === 'server-env')
    return { open: '# generated:server-env', close: '# /generated:server-env' };
  return { open: `<!-- generated:${name} -->`, close: `<!-- /generated:${name} -->` };
}

/** Evaluate the real Config values, rather than inferring their behavior from source strings. */
export function currentServerEnvironmentKeys(): Map<
  string,
  { required: boolean; defaultValue?: string }
> {
  const provider = ConfigProvider.fromUnknown({});
  const fields = new Map<string, { required: boolean; defaultValue?: string }>();
  for (const [name, field] of Object.entries(serverEnvironment)) {
    const config: Config.Config<unknown> = field.config;
    const result = Effect.runSync(Effect.result(config.parse(provider)));
    const required = result._tag === 'Failure';
    if (required !== field.required)
      throw new Error(`${name}: catalog required metadata disagrees with Config`);
    const value = result._tag === 'Success' ? result.success : undefined;
    const defaultValue =
      typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
        ? String(value)
        : undefined;
    fields.set(name, {
      required,
      ...(defaultValue === undefined || defaultValue === '' ? {} : { defaultValue }),
    });
  }
  return fields;
}

function environmentNotes(
  name: string,
  notes: string,
  defaults: ReadonlyMap<string, { defaultValue?: string }>,
): string {
  const value = defaults.get(name)?.defaultValue;
  return value === undefined ? notes : `${notes} Default: \`${value}\`.`;
}

function renderServerEnvironment(): string {
  const defaults = currentServerEnvironmentKeys();
  return [
    '| Variable | Required | Notes |',
    '| --- | --- | --- |',
    ...Object.entries(serverEnvironment).map(
      ([name, field]) =>
        `| \`${name}\` | ${field.requirement} | ${environmentNotes(name, field.notes, defaults)} |`,
    ),
  ].join('\n');
}

function renderServerEnvExample(): string {
  const defaults = currentServerEnvironmentKeys();
  return Object.entries(serverEnvironment)
    .map(([name, field]) => {
      const notes = environmentNotes(name, field.notes, defaults)
        .replaceAll('`', '')
        .replaceAll('**', '');
      return `# ${notes}\n${field.required || field.example !== '' ? '' : '# '}${name}=${field.example}\n`;
    })
    .join('\n');
}

/**
 * Replace the text between a block's markers with `block`, keeping the markers.
 *
 * Returns `undefined` when either marker is missing or they are out of order, so a caller
 * can report "markers absent" rather than silently appending.
 */
export function replaceGenerated(
  document: string,
  name: string,
  block: string,
): string | undefined {
  const { open, close } = generatedMarkers(name);
  const start = document.indexOf(open);
  if (start === -1) return undefined;
  const end = document.indexOf(close, start + open.length);
  if (end === -1) return undefined;
  const body = block.endsWith('\n') ? block : `${block}\n`;
  return `${document.slice(0, start + open.length)}\n${body}${document.slice(end)}`;
}

function readOptional(file: string): string | undefined {
  try {
    return readFileSync(path.join(ROOT, file), 'utf8');
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function e2eScriptsOf(packageJsonText: string): Array<readonly [string, string]> {
  const parsed: unknown = JSON.parse(packageJsonText);
  const scripts = isRecord(parsed) && isRecord(parsed.scripts) ? parsed.scripts : {};
  const entries: Array<readonly [string, string]> = [];
  for (const [name, command] of Object.entries(scripts)) {
    if (name.startsWith('test:e2e') && typeof command === 'string') entries.push([name, command]);
  }
  return entries;
}

/** Collect the generator's inputs from the checkout. */
export function readE2eSpecInputs(root: string = ROOT): E2eSpecInputs {
  const configs: PlaywrightConfigSpecs[] = [];
  for (const file of new Glob('playwright*.config.mjs').scanSync({ cwd: root })) {
    configs.push({
      file,
      specs: parsePlaywrightTestMatch(readFileSync(path.join(root, file), 'utf8')),
    });
  }
  configs.sort((left, right) => left.file.localeCompare(right.file));

  const harness = readFileSync(path.join(root, HARNESS_SCRIPT), 'utf8');
  const drivers: DriverScriptSpecs[] = [];
  for (const relative of new Glob('**/*.ts').scanSync({ cwd: path.join(root, 'scripts') })) {
    if (relative.endsWith('.test.ts') || relative.includes('node_modules')) continue;
    const file = `scripts/${relative}`;
    const specs = specNames(readFileSync(path.join(root, file), 'utf8'));
    if (specs.length > 0) drivers.push({ file, specs });
  }
  drivers.sort((left, right) => left.file.localeCompare(right.file));

  const allSpecs = specNames(
    [...new Glob('*.e2e.ts').scanSync({ cwd: path.join(root, 'tests/e2e') })].join(' '),
  );

  return {
    configs,
    scripts: e2eScriptsOf(readFileSync(path.join(root, 'package.json'), 'utf8')),
    latencySpecs: parseSpecListConstant(harness, 'LATENCY_SPECS'),
    functionalSpecs: parseSpecListConstant(harness, 'FUNCTIONAL_SPECS'),
    drivers,
    allSpecs,
  };
}

/** The e2e block as it should read for the current checkout. */
export function renderCurrentE2eBlock(root: string = ROOT): string {
  return renderE2eSpecTable(readE2eSpecInputs(root), (file) => {
    try {
      return readFileSync(path.join(root, file), 'utf8');
    } catch {
      return undefined;
    }
  });
}

/** Every generated block, its host file, and how to render it for a checkout. */
export const GENERATED_BLOCKS: readonly GeneratedBlock[] = [
  {
    file: 'README.md',
    name: 'server-environment',
    label: 'server environment table',
    render: renderServerEnvironment,
  },
  {
    file: 'apps/server/.env.example',
    name: 'server-env',
    label: 'server environment template',
    render: renderServerEnvExample,
  },
  {
    file: 'docs/processes.md',
    name: E2E_BLOCK_NAME,
    label: 'e2e suite table',
    render: renderCurrentE2eBlock,
  },
  {
    file: '.claude/skills/verify/SKILL.md',
    name: GATE_BLOCK_NAME,
    label: 'verify skill gate table',
    render: () => renderGateRulesTable(RULES),
  },
];

if (import.meta.main) {
  const check = process.argv.includes('--check');
  let failed = false;
  for (const block of GENERATED_BLOCKS) {
    const current = readOptional(block.file) ?? '';
    const rendered = block.render(ROOT);
    const next = replaceGenerated(current, block.name, rendered);
    if (next === undefined) {
      const { open, close } = generatedMarkers(block.name);
      process.stderr.write(
        `${block.file} has no ${open} … ${close} block; add the markers where the ${block.label} belongs.\n\nRendered block:\n\n${rendered}`,
      );
      failed = true;
    } else if (next === current) {
      process.stdout.write(`generate:docs: ${block.label} is current\n`);
    } else if (check) {
      process.stderr.write(`${block.label} is stale; run \`bun run generate:docs\`.\n\n`);
      process.stderr.write(`Rendered block:\n\n${rendered}`);
      failed = true;
    } else {
      writeFileSync(path.join(ROOT, block.file), next);
      process.stdout.write(`generate:docs: ${block.label} rewritten\n`);
    }
  }
  if (failed) process.exit(1);
}
