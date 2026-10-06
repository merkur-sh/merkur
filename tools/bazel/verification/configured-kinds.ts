import type { EngineQueryResult } from './engine-catalog';
import type { RequiredCheck } from './events';

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function checkSetExpression(required: readonly RequiredCheck[]): string {
  if (
    required.length === 0 ||
    new Set(required.map((check) => check.label)).size !== required.length ||
    required.some((check) => !/^\/\/[^:\s]*:[^:\s]+$/.test(check.label))
  )
    throw new Error('Configured check inventory is empty, duplicated or malformed');
  return `set(${required
    .map((check) => check.label)
    .sort()
    .join(' ')})`;
}

/** A dependency can also appear in exec transitions; only top-level instances are requested. */
export function configuredCheckExpression(required: readonly RequiredCheck[]): string {
  return `config(${checkSetExpression(required)}, target)`;
}

interface ConfiguredRule {
  readonly checksum: string;
  readonly ruleClass: string;
}

function targets(
  query: EngineQueryResult,
  expression: string,
): ReadonlyMap<string, ConfiguredRule> {
  if (
    query.expression !== expression ||
    query.format !== 'jsonproto' ||
    query.buildToolVersion !== '9.2.0' ||
    query.exitCode !== 0
  )
    throw new Error('Configured kind query is incomplete or belongs to another selection');
  const value: unknown = JSON.parse(query.stdout);
  if (!record(value) || !Array.isArray(value.results) || !Array.isArray(value.configurations))
    throw new Error('Configured kind query lacks target and configuration tables');
  const configurations = new Map<number, string>();
  for (const entry of value.configurations) {
    if (
      !record(entry) ||
      typeof entry.id !== 'number' ||
      !Number.isSafeInteger(entry.id) ||
      entry.id < 1 ||
      typeof entry.checksum !== 'string' ||
      !/^[a-f0-9]{64}$/.test(entry.checksum) ||
      configurations.has(entry.id)
    )
      throw new Error('Configured kind query has ambiguous configuration identities');
    configurations.set(entry.id, entry.checksum);
  }
  const result = new Map<string, ConfiguredRule>();
  for (const entry of value.results) {
    if (
      !record(entry) ||
      !record(entry.target) ||
      entry.target.type !== 'RULE' ||
      !record(entry.target.rule) ||
      typeof entry.target.rule.name !== 'string' ||
      typeof entry.target.rule.ruleClass !== 'string' ||
      entry.target.rule.ruleClass === '' ||
      !/^\/\/[^:\s]*:[^:\s]+$/.test(entry.target.rule.name) ||
      typeof entry.configurationId !== 'number' ||
      !record(entry.configuration) ||
      configurations.get(entry.configurationId) !== entry.configuration.checksum ||
      typeof entry.configuration.checksum !== 'string' ||
      result.has(entry.target.rule.name)
    )
      throw new Error('Configured target kind is absent, duplicated or ambiguous');
    result.set(entry.target.rule.name, {
      checksum: entry.configuration.checksum,
      ruleClass: entry.target.rule.ruleClass,
    });
  }
  return result;
}

/** Bazel's tests() predicate supplies test membership; executable filenames cannot. */
export function configuredCheckKinds(
  required: readonly RequiredCheck[],
  all: EngineQueryResult,
  tests: EngineQueryResult,
): ReadonlyMap<string, string> {
  const expression = configuredCheckExpression(required);
  const configured = targets(all, expression);
  const testTargets = targets(tests, `tests(${expression})`);
  if (configured.size !== required.length)
    throw new Error('Configured target query omitted or added required checks');
  for (const check of required) {
    const configuration = configured.get(check.label);
    const test = testTargets.get(check.label);
    if (
      configuration === undefined ||
      !['test', 'build'].includes(check.kind) ||
      typeof check.fresh !== 'boolean' ||
      (check.kind === 'test'
        ? test?.checksum !== configuration.checksum || test.ruleClass !== configuration.ruleClass
        : testTargets.has(check.label))
    )
      throw new Error(
        `Configured engine target has the wrong kind or configuration: ${check.label}`,
      );
  }
  if ([...testTargets.keys()].some((label) => !configured.has(label)))
    throw new Error('Configured test predicate expanded undeclared checks');
  return new Map([...configured].map(([label, rule]) => [label, rule.checksum]));
}
