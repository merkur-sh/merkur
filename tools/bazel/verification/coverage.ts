import {
  gatePathMatches,
  RULES,
  type RuleEffects,
  ruleMatches,
} from '../../../scripts/gate-policy';
import type { RequiredCheck } from './events';
import { BAZEL_STATIC_GATES } from './static-gates';

export interface SourceTest {
  readonly file: string;
  readonly check: RequiredCheck;
  /** First-party source inputs from the configured Bazel action graph. */
  readonly inputs: readonly string[];
}

export interface CoverageCatalog {
  readonly tests: readonly SourceTest[];
  /** Complete owning suites from the engine's validated source-test inventory, including empty ones. */
  readonly suites: ReadonlyMap<string, readonly string[]>;
  readonly operations: ReadonlyMap<string, readonly RequiredCheck[]>;
  readonly crates: ReadonlyMap<string, readonly RequiredCheck[]>;
  readonly browserOwners: ReadonlyMap<string, readonly string[]>;
}

export interface CoveragePlan {
  readonly files: readonly string[];
  readonly docsOnly: boolean;
  readonly required: readonly RequiredCheck[];
  readonly deferred: readonly string[];
  readonly pendingDeferred: readonly string[];
  readonly reasons: readonly string[];
  readonly staticOperations: readonly {
    readonly name: string;
    readonly checks: readonly RequiredCheck[];
  }[];
}

function sourcePath(value: string): string {
  if (
    value === '' ||
    value.includes('\\') ||
    value.includes('\0') ||
    value.split('/').some((part) => part === '' || part === '.' || part === '..')
  ) {
    throw new Error(`Invalid coverage source path: ${JSON.stringify(value)}`);
  }
  return value;
}

function sourceTests(catalog: CoverageCatalog): Map<string, SourceTest> {
  const tests = new Map<string, SourceTest>();
  for (const test of catalog.tests) {
    sourcePath(test.file);
    for (const input of test.inputs) sourcePath(input);
    if (tests.has(test.file)) throw new Error(`Duplicate source test: ${test.file}`);
    if (test.check.kind !== 'test')
      throw new Error(`Source test is not an engine test: ${test.file}`);
    tests.set(test.file, test);
  }
  for (const [directory, files] of catalog.suites) {
    sourcePath(directory);
    if (new Set(files).size !== files.length)
      throw new Error(`Duplicate owning suite: ${directory}`);
    for (const file of files) {
      if (!file.startsWith(`${directory}/`) || !tests.has(file)) {
        throw new Error(`Invalid owning suite inventory: ${directory}`);
      }
    }
    const actual = catalog.tests
      .filter((test) => test.file.startsWith(`${directory}/`))
      .map((test) => test.file)
      .sort();
    if (JSON.stringify([...files].sort()) !== JSON.stringify(actual)) {
      throw new Error(`Incomplete owning suite inventory: ${directory}`);
    }
  }
  return tests;
}

/** Select engine targets from the shared domain rules, without executing or caching results. */
export function coveragePlan(
  changed: readonly string[],
  catalog: CoverageCatalog,
  includeDeferred: boolean,
): CoveragePlan {
  const files = [...new Set(changed.map(sourcePath))].sort();
  const tests = sourceTests(catalog);
  const required = new Map<string, RequiredCheck>();
  const deferred = new Set<string>();
  const reasons = new Set<string>();
  const staticOperations: { name: string; checks: readonly RequiredCheck[] }[] = [];
  let gated = false;
  function add(checks: readonly RequiredCheck[], reason: string): void {
    if (checks.length === 0) throw new Error(`Empty coverage operation: ${reason}`);
    for (const check of checks) {
      if (
        !/^\/\/[^:\s]*:[^:\s]+$/.test(check.label) ||
        !['test', 'build'].includes(check.kind) ||
        typeof check.fresh !== 'boolean'
      ) {
        throw new Error(`Invalid coverage target: ${JSON.stringify(check)}`);
      }
      const previous = required.get(check.label);
      if (previous !== undefined && previous.kind !== check.kind) {
        throw new Error(`Conflicting coverage target kinds: ${check.label}`);
      }
      required.set(check.label, { ...check, fresh: check.fresh || previous?.fresh === true });
      reasons.add(`${check.label} ← ${reason}`);
    }
  }
  function operation(name: string, reason: string): void {
    const checks = catalog.operations.get(name);
    if (checks === undefined) throw new Error(`No Bazel coverage registered for ${name}`);
    add(checks, reason);
  }
  function selectEffects(effects: RuleEffects, file: string, reason: string): void {
    for (const build of effects.builds ?? []) operation(build, reason);
    for (const crate of effects.crates ?? []) {
      const checks = catalog.crates.get(crate);
      if (checks === undefined) throw new Error(`No Bazel suite registered for ${crate}`);
      add(checks, reason);
    }
    if (effects.rustLint) {
      operation('rust:lint', reason);
      operation('rust:deps', reason);
    }
    if (effects.realHelper) operation('test:real-helper', reason);
    if (effects.protocol) operation('check:protocol', reason);
    if (effects.audit) operation('check:audit', reason);
    for (const name of effects.cargoScripts ?? []) operation(name, reason);
    if (effects.allUnit) {
      if (tests.size === 0) throw new Error('Complete source test inventory is empty');
      for (const test of tests.values()) add([test.check], reason);
    }
    if (effects.bunTestDir !== undefined) {
      if (!catalog.suites.has(effects.bunTestDir)) {
        throw new Error(`No complete owning suite registered for ${effects.bunTestDir}`);
      }
      for (const test of tests.values()) {
        if (
          test.file === file ||
          (!tests.has(file) && test.file.startsWith(`${effects.bunTestDir}/`)) ||
          test.inputs.includes(file)
        ) {
          add([test.check], reason);
        }
      }
    }
    for (const name of effects.bunTestFiles ?? []) {
      const test = tests.get(name);
      if (test === undefined) throw new Error(`Missing required source test: ${name}`);
      add([test.check], reason);
    }
    for (const name of effects.deferred ?? []) deferred.add(name);
    if (effects.e2e) {
      const owners = [...catalog.browserOwners].flatMap(([pattern, names]) =>
        gatePathMatches(pattern, file) ? names : [],
      );
      if (owners.length === 0) throw new Error(`No browser owner registered for ${file}`);
      for (const owner of owners) deferred.add(owner);
    }
  }
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
      const reason = `${file} (${rule.name})`;
      selectEffects(effects, file, reason);
    }
    // Action inputs also cover consumers outside the owning suite and paths with no domain row.
    for (const test of tests.values()) {
      if (test.inputs.includes(file)) add([test.check], `${file} (Bazel action input)`);
    }
    gated ||= matched || !prose;
  }
  if (deferred.has('test:e2e:transport')) deferred.delete('test:e2e:latency');
  for (const name of BAZEL_STATIC_GATES) {
    operation(name, 'required static policy');
    const checks = catalog.operations.get(name);
    if (checks === undefined) throw new Error(`No Bazel coverage registered for ${name}`);
    staticOperations.push({ name, checks });
  }
  if (includeDeferred) {
    for (const name of deferred) operation(name, 'required extended coverage');
  }
  return {
    files,
    docsOnly: !gated,
    required: [...required.values()].sort((a, b) =>
      a.label < b.label ? -1 : a.label > b.label ? 1 : 0,
    ),
    deferred: [...deferred].sort(),
    pendingDeferred: includeDeferred ? [] : [...deferred].sort(),
    reasons: [...reasons].sort(),
    staticOperations,
  };
}

/**
 * Execute the complete configured source-test inventory through the controller. Every
 * admitted plan carries the eight static policies, so unit verification runs them too.
 */
export function unitCoverage(catalog: CoverageCatalog): CoveragePlan {
  const tests = sourceTests(catalog);
  if (tests.size === 0)
    throw new Error('Unit verification requires the complete configured source-test inventory');
  const required = new Map<string, RequiredCheck>();
  function add(check: RequiredCheck): void {
    const previous = required.get(check.label);
    if (previous !== undefined && previous.kind !== check.kind)
      throw new Error(`Conflicting coverage target kinds: ${check.label}`);
    required.set(check.label, { ...check, fresh: check.fresh || previous?.fresh === true });
  }
  for (const test of tests.values()) add(test.check);
  const staticOperations = BAZEL_STATIC_GATES.map((name) => {
    const checks = catalog.operations.get(name);
    if (checks === undefined || checks.length === 0)
      throw new Error(`No Bazel coverage registered for ${name}`);
    for (const check of checks) add(check);
    return { name, checks };
  });
  return {
    files: [],
    docsOnly: false,
    required: [...required.values()].sort((left, right) => left.label.localeCompare(right.label)),
    deferred: [],
    pendingDeferred: [],
    reasons: ['Complete configured source-test inventory', 'Required static policies'],
    staticOperations,
  };
}
