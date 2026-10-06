import { createHash } from 'node:crypto';
import { RULES } from '../../../scripts/gate-policy';
import { testSourcePaths } from './action-inputs';
import type { SourceTest } from './coverage';

export interface SourceInventory {
  readonly tests: readonly SourceTest[];
  readonly suites: ReadonlyMap<string, readonly string[]>;
  readonly digest: string;
}

export const SOURCE_TEST_QUERY =
  'kind(bun_test, set(//apps/... //packages/... //scripts/... //tests/...))';

export interface EngineQueryResult {
  readonly expression: string;
  readonly format: 'streamed_jsonproto' | 'jsonproto';
  readonly buildToolVersion: string;
  readonly exitCode: number;
  readonly stdout: string;
}

interface SourceRule {
  readonly label: string;
  readonly file: string;
  readonly tags: readonly string[];
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function strings(value: unknown): readonly string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new Error('Bazel source inventory attribute is not a string list');
  }
  return value;
}

function sourceRule(value: unknown): SourceRule {
  if (!record(value) || value.type !== 'RULE' || !record(value.rule)) {
    throw new Error('Bazel source inventory contains a non-rule target');
  }
  const rule = value.rule;
  if (
    rule.ruleClass !== 'bun_test' ||
    typeof rule.name !== 'string' ||
    !/^\/\/[^:\s]*:[^:\s]+$/.test(rule.name) ||
    !Array.isArray(rule.attribute)
  ) {
    throw new Error('Bazel source inventory has an invalid Bun test rule');
  }
  const attributes = new Map<string, Record<string, unknown>>();
  for (const attribute of rule.attribute) {
    if (!record(attribute) || typeof attribute.name !== 'string') {
      throw new Error('Bazel source inventory contains an invalid attribute');
    }
    if (attributes.has(attribute.name)) throw new Error('Duplicate source inventory attribute');
    attributes.set(attribute.name, attribute);
  }
  const files = strings(attributes.get('test_files')?.stringListValue);
  const tags = strings(attributes.get('tags')?.stringListValue ?? []);
  const file = files[0]?.replace(/^\.\//, '');
  if (
    files.length !== 1 ||
    file === undefined ||
    file === '' ||
    file.includes('\\') ||
    file.includes('\0') ||
    file.split('/').some((part) => part === '' || part === '.' || part === '..')
  ) {
    throw new Error('Each Bazel Bun target must own exactly one canonical source test');
  }
  return { label: rule.name, file, tags: [...new Set(tags)].sort() };
}

/**
 * Combine the complete application source-test query with a full,
 * matching configured `aquery deps(set(...)) --output=jsonproto`. The engine
 * supplies both test membership and transitive generated-artifact consumers.
 */
export function sourceInventory(
  query: EngineQueryResult,
  actions: EngineQueryResult,
): SourceInventory {
  if (
    query.expression !== SOURCE_TEST_QUERY ||
    query.format !== 'streamed_jsonproto' ||
    actions.format !== 'jsonproto' ||
    query.exitCode !== 0 ||
    actions.exitCode !== 0 ||
    query.buildToolVersion !== '9.2.0' ||
    actions.buildToolVersion !== '9.2.0'
  ) {
    throw new Error('Incomplete or mismatched pinned-engine inventory capture');
  }
  const rows = query.stdout
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => sourceRule(JSON.parse(line)));
  rows.sort((left, right) => (left.label < right.label ? -1 : left.label > right.label ? 1 : 0));
  if (
    rows.length === 0 ||
    new Set(rows.map((row) => row.label)).size !== rows.length ||
    new Set(rows.map((row) => row.file)).size !== rows.length
  ) {
    throw new Error('Bazel source inventory is empty or contains duplicate tests');
  }
  const expression = `deps(set(${rows.map((row) => row.label).join(' ')}))`;
  if (actions.expression !== expression) {
    throw new Error('Configured action query does not cover the complete source-test inventory');
  }
  const sources = testSourcePaths(
    actions.stdout,
    rows.map((row) => row.label),
  );
  const tests = rows.map((row): SourceTest => {
    const inputs = sources.get(row.label);
    if (inputs === undefined || !inputs.includes(row.file)) {
      throw new Error(`Configured test does not read its claimed source file: ${row.label}`);
    }
    // A pass is reusable for the same inputs and test epoch. The launcher materializes only a
    // test's declared files, so a pass cannot rest on a repository file outside its action
    // inputs; the targets keep `no-remote-cache`, so a pass is read only where it was produced.
    return { file: row.file, check: { label: row.label, kind: 'test', fresh: false }, inputs };
  });
  const directories = [
    ...new Set(
      RULES.flatMap((rule) =>
        rule.effects.bunTestDir === undefined ? [] : [rule.effects.bunTestDir],
      ),
    ),
  ].sort();
  const suites = new Map(
    directories.map((directory) => [
      directory,
      tests
        .filter((test) => test.file.startsWith(`${directory}/`))
        .map((test) => test.file)
        .sort(),
    ]),
  );
  const digest = createHash('sha256')
    .update(
      JSON.stringify({
        rules: rows,
        tests,
        suites: [...suites],
      }),
    )
    .digest('hex');
  return { tests, suites, digest };
}
