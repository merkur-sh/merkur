import { createHash } from 'node:crypto';
import { RULES } from '../../../scripts/gate-policy';
import type { CoverageCatalog } from './coverage';
import type { SourceInventory } from './engine-catalog';
import type { RequiredCheck } from './events';
import { BAZEL_STATIC_GATES } from './static-gates';

export interface SimulationOutputBinding {
  readonly label: string;
  readonly mode: 'replay' | 'sweep';
}

interface Binding {
  readonly name: string;
  readonly checks: readonly RequiredCheck[];
  readonly pending: readonly string[];
  readonly simulationOutputs?: readonly SimulationOutputBinding[];
}

interface BrowserOwner {
  readonly pattern: string;
  readonly operations: readonly string[];
}

export interface ConfiguredCoverage {
  readonly catalog: CoverageCatalog;
  readonly simulationOutputs: ReadonlyMap<string, readonly SimulationOutputBinding[]>;
  readonly pendingQualifications: readonly string[];
  readonly digest: string;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactFields(
  value: Record<string, unknown>,
  fields: readonly string[],
  optional: readonly string[] = [],
): void {
  if (
    fields.some((field) => !Object.hasOwn(value, field)) ||
    Object.keys(value).some((field) => !fields.includes(field) && !optional.includes(field))
  )
    throw new Error('Configured coverage descriptor has unexpected or missing fields');
}

function strings(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    !value.every((item) => typeof item === 'string' && item.trim() === item && item !== '') ||
    new Set(value).size !== value.length
  )
    throw new Error('Configured coverage strings are invalid or duplicated');
  return [...value].sort();
}

function bindings(value: unknown, operations = false): Binding[] {
  if (!Array.isArray(value)) throw new Error('Configured coverage bindings are absent');
  return value.map((entry): Binding => {
    if (!record(entry)) throw new Error('Configured coverage binding is not an object');
    exactFields(entry, ['name', 'checks', 'pending'], operations ? ['simulationOutputs'] : []);
    if (typeof entry.name !== 'string' || entry.name === '' || entry.name.trim() !== entry.name)
      throw new Error('Configured coverage binding has an invalid name');
    if (!Array.isArray(entry.checks)) throw new Error('Configured engine checks are absent');
    const checks = entry.checks.map((item): RequiredCheck => {
      if (!record(item)) throw new Error('Configured engine check is not an object');
      exactFields(item, ['label', 'kind', 'fresh']);
      if (
        typeof item.label !== 'string' ||
        !/^\/\/[^:\s]*:[^:\s]+$/.test(item.label) ||
        (item.kind !== 'test' && item.kind !== 'build') ||
        typeof item.fresh !== 'boolean'
      )
        throw new Error('Configured engine check is malformed');
      return { label: item.label, kind: item.kind, fresh: item.fresh };
    });
    if (new Set(checks.map((check) => check.label)).size !== checks.length)
      throw new Error('Configured coverage binding duplicates an engine check');
    let simulationOutputs: readonly SimulationOutputBinding[] | undefined;
    if (Object.hasOwn(entry, 'simulationOutputs')) {
      const mode =
        entry.name === 'test:sim'
          ? 'replay'
          : entry.name === 'test:sim:sweep'
            ? 'sweep'
            : undefined;
      if (mode === undefined || !Array.isArray(entry.simulationOutputs))
        throw new Error('Simulation output binding is absent or belongs to another operation');
      const emitters = entry.simulationOutputs.map((item): SimulationOutputBinding => {
        if (!record(item)) throw new Error('Simulation output binding is not an object');
        exactFields(item, ['label', 'mode']);
        if (
          typeof item.label !== 'string' ||
          item.mode !== mode ||
          !checks.some((check) => check.label === item.label && check.kind === 'test')
        )
          throw new Error('Simulation output emitter must bind the same operation test and mode');
        return { label: item.label, mode };
      });
      if (new Set(emitters.map((emitter) => emitter.label)).size !== emitters.length)
        throw new Error('Simulation output binding duplicates an emitter');
      simulationOutputs = Object.freeze(
        emitters
          .sort((left, right) => (left.label < right.label ? -1 : left.label > right.label ? 1 : 0))
          .map((emitter) => Object.freeze(emitter)),
      );
    }
    const pending = strings(entry.pending);
    if (checks.length === 0 && pending.length === 0)
      throw new Error('Missing configured engine checks need an explicit blocker');
    return {
      name: entry.name,
      checks: checks.sort((left, right) =>
        left.label < right.label ? -1 : left.label > right.label ? 1 : 0,
      ),
      pending,
      ...(simulationOutputs === undefined ? {} : { simulationOutputs }),
    };
  });
}

/** All obligations come from the same domain policy used to select changed work. */
export function coverageObligations(): {
  readonly operations: readonly string[];
  readonly crates: readonly string[];
} {
  const operations = new Set(BAZEL_STATIC_GATES);
  const crates = new Set<string>();
  for (const { effects } of RULES) {
    for (const name of effects.builds ?? []) operations.add(name);
    for (const name of effects.cargoScripts ?? []) operations.add(name);
    for (const name of effects.deferred ?? []) operations.add(name);
    for (const name of effects.crates ?? []) crates.add(name);
    if (effects.rustLint) {
      operations.add('rust:lint');
      operations.add('rust:deps');
    }
    if (effects.realHelper) operations.add('test:real-helper');
    if (effects.protocol) operations.add('check:protocol');
    if (effects.audit) operations.add('check:audit');
  }
  return { operations: [...operations].sort(), crates: [...crates].sort() };
}

/**
 * Merge owner manifests produced from configured Target attributes. The engine
 * adapter must read their declared output Files; caller-authored JSON is not an
 * execution or qualification receipt. A blocked binding stays blocked, and no
 * absent domain obligation can be hidden by a changed-path selection.
 */
export function configuredCoverageCatalog(
  inventory: SourceInventory,
  descriptors: readonly unknown[],
): ConfiguredCoverage {
  if (!/^[a-f0-9]{64}$/.test(inventory.digest) || descriptors.length === 0)
    throw new Error('Configured source inventory and owner descriptors are required');
  const operations = new Map<string, Binding>();
  const crates = new Map<string, Binding>();
  const browserOwners = new Map<string, readonly string[]>();
  const owners: BrowserOwner[] = [];
  const kinds = new Map<string, RequiredCheck['kind']>(
    inventory.tests.map((test) => [test.check.label, test.check.kind]),
  );
  function add(rows: readonly Binding[], destination: Map<string, Binding>): void {
    for (const row of rows) {
      if (destination.has(row.name))
        throw new Error(`Competing configured coverage owners: ${row.name}`);
      for (const check of row.checks) {
        const kind = kinds.get(check.label);
        if (kind !== undefined && kind !== check.kind)
          throw new Error(`Conflicting configured target kinds: ${check.label}`);
        kinds.set(check.label, check.kind);
      }
      destination.set(row.name, row);
    }
  }
  for (const value of descriptors) {
    if (!record(value)) throw new Error('Configured coverage owner is not an object');
    exactFields(value, ['operations', 'crates', 'browserOwners']);
    add(bindings(value.operations, true), operations);
    add(bindings(value.crates), crates);
    if (!Array.isArray(value.browserOwners)) throw new Error('Configured browser owners absent');
    for (const entry of value.browserOwners) {
      if (!record(entry)) throw new Error('Configured browser owner is not an object');
      exactFields(entry, ['pattern', 'operations']);
      if (
        typeof entry.pattern !== 'string' ||
        entry.pattern === '' ||
        entry.pattern.startsWith('/') ||
        entry.pattern.includes('\\') ||
        entry.pattern.includes('\0') ||
        entry.pattern.split('/').some((part) => part === '' || part === '.' || part === '..') ||
        browserOwners.has(entry.pattern)
      )
        throw new Error('Configured browser ownership is unsafe or ambiguous');
      const names = strings(entry.operations);
      if (names.length === 0) throw new Error('Configured browser owner has no operation');
      browserOwners.set(entry.pattern, names);
      owners.push({ pattern: entry.pattern, operations: names });
    }
  }
  const obligations = coverageObligations();
  for (const name of obligations.operations)
    if (!operations.has(name)) throw new Error(`Unregistered policy operation: ${name}`);
  for (const name of obligations.crates)
    if (!crates.has(name)) throw new Error(`Unregistered policy crate: ${name}`);
  for (const name of crates.keys())
    if (!obligations.crates.includes(name)) throw new Error(`Unexpected policy crate: ${name}`);
  const browserOperations = new Set(owners.flatMap((owner) => owner.operations));
  for (const name of browserOperations)
    if (!operations.has(name)) throw new Error(`Unregistered browser operation: ${name}`);
  if (browserOwners.size === 0) throw new Error('Configured browser ownership inventory is empty');
  const pendingQualifications = [...operations.values(), ...crates.values()].flatMap((row) =>
    row.pending.map((reason) => `${row.name}: ${reason}`),
  );
  const sorted = (rows: ReadonlyMap<string, Binding>): readonly Binding[] =>
    [...rows.values()].sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
    );
  const facts = {
    inventory: inventory.digest,
    operations: sorted(operations),
    crates: sorted(crates),
    browserOwners: owners.sort((left, right) =>
      left.pattern < right.pattern ? -1 : left.pattern > right.pattern ? 1 : 0,
    ),
  };
  const checks = (
    rows: ReadonlyMap<string, Binding>,
  ): ReadonlyMap<string, readonly RequiredCheck[]> =>
    new Map(
      [...rows]
        .filter(([, row]) => row.checks.length !== 0)
        .map(([name, row]) => [name, row.checks]),
    );
  return {
    catalog: {
      tests: inventory.tests,
      suites: inventory.suites,
      operations: checks(operations),
      crates: checks(crates),
      browserOwners,
    },
    simulationOutputs: new Map(
      [...operations].flatMap(([name, row]) =>
        row.simulationOutputs === undefined ? [] : [[name, row.simulationOutputs] as const],
      ),
    ),
    pendingQualifications: [...new Set(pendingQualifications)].sort(),
    digest: createHash('sha256').update(JSON.stringify(facts)).digest('hex'),
  };
}
