import { expect, test } from 'bun:test';
import { configuredCheckExpression, configuredCheckKinds } from './configured-kinds';
import type { EngineQueryResult } from './engine-catalog';
import type { RequiredCheck } from './events';

const required: readonly RequiredCheck[] = [
  { label: '//test:runner', kind: 'test', fresh: true },
  { label: '//build:executable', kind: 'build', fresh: false },
];
const checksum = 'a'.repeat(64);

function query(
  labels: readonly string[],
  tests = false,
  configuration = checksum,
): EngineQueryResult {
  const expression = configuredCheckExpression(required);
  return {
    expression: tests ? `tests(${expression})` : expression,
    format: 'jsonproto',
    buildToolVersion: '9.2.0',
    exitCode: 0,
    stdout: JSON.stringify({
      configurations: [{ id: 1, checksum: configuration }],
      results: labels.map((name) => ({
        target: {
          type: 'RULE',
          rule: { name, ruleClass: name === '//test:runner' ? 'bun_test' : 'genrule' },
        },
        configurationId: 1,
        configuration: { checksum: configuration },
      })),
    }),
  };
}

test('test membership comes from the configured engine predicate, independent of executability', () => {
  expect([
    ...configuredCheckKinds(
      required,
      query(required.map((row) => row.label)),
      query(['//test:runner'], true),
    ),
  ]).toEqual([
    ['//test:runner', checksum],
    ['//build:executable', checksum],
  ]);
});

test('non-test executables, omissions, extra tests and another configuration cannot satisfy coverage', () => {
  const all = query(required.map((row) => row.label));
  for (const tests of [
    query([], true),
    query(['//build:executable'], true),
    query(['//test:runner', '//other:test'], true),
    query(['//test:runner'], true, 'b'.repeat(64)),
  ])
    expect(() => configuredCheckKinds(required, all, tests)).toThrow();
  expect(() =>
    configuredCheckKinds(required, query(['//test:runner']), query(['//test:runner'], true)),
  ).toThrow('omitted');
  expect(() =>
    configuredCheckKinds(required, { ...all, exitCode: 1 }, query(['//test:runner'], true)),
  ).toThrow('incomplete');
  expect(() =>
    configuredCheckKinds(
      required,
      { ...all, stdout: all.stdout.replace('"configurationId":1', '"configurationId":true') },
      query(['//test:runner'], true),
    ),
  ).toThrow('ambiguous');
  const predicate = query(['//test:runner'], true);
  expect(() =>
    configuredCheckKinds(required, all, {
      ...predicate,
      stdout: predicate.stdout.replace('bun_test', 'genrule'),
    }),
  ).toThrow('wrong kind');
  expect(() =>
    configuredCheckKinds(
      required,
      { ...all, stdout: all.stdout.replace('"ruleClass":"bun_test"', '"ruleClass":false') },
      predicate,
    ),
  ).toThrow('ambiguous');
});
