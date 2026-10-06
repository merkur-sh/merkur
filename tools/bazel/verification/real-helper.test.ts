import { expect, test } from 'bun:test';
import {
  realHelperCases,
  realHelperInputs,
  realHelperInventory,
  verifyRealHelperRun,
} from './real-helper';

function listing(names: readonly string[] = realHelperCases) {
  return `${names.map((name) => `${name}: test`).join('\n')}\n\n${names.length} tests, 0 benchmarks\n`;
}

function report(names: readonly string[] = realHelperCases) {
  return [
    `running ${names.length} tests`,
    ...names.map((name) => `test ${name} ... ok`),
    `test result: ok. ${names.length} passed; 0 failed; 0 ignored; 0 measured; 100 filtered out; finished in 1.00s`,
  ].join('\n');
}

test('original inventory includes both authenticated native broker tests', () => {
  const inventory = realHelperInventory(listing());
  expect(inventory).toEqual(realHelperCases);
  expect(
    inventory.filter((name) => name.includes('graphics::native::tests::real_helper::')),
  ).toHaveLength(2);
  expect(() => verifyRealHelperRun(report(), 0)).not.toThrow();
});

test('coherently omitted authenticated fixture cannot become a passing lane', () => {
  const shortened = realHelperCases.slice(0, -1);
  expect(() => realHelperInventory(listing(shortened))).toThrow('incomplete');
  expect(() => verifyRealHelperRun(report(shortened), 0)).toThrow('incomplete');
});

test('duplicates, foreign cases and benchmark substitutions refuse', () => {
  const first = realHelperCases[0];
  if (first === undefined) throw new Error('Original fixture inventory is empty');
  expect(() => realHelperInventory(listing([...realHelperCases.slice(0, -1), first]))).toThrow(
    'duplicated',
  );
  expect(() =>
    realHelperInventory(listing([...realHelperCases.slice(0, -1), 'foreign::real_helper::ok'])),
  ).toThrow('Unexpected');
  expect(() => realHelperInventory(listing().replace(': test', ': benchmark'))).toThrow(
    'Malformed',
  );
});

test('each case, process exit and sole complete summary must independently pass', () => {
  expect(() => verifyRealHelperRun(report(), 37)).toThrow('exited 37');
  expect(() => verifyRealHelperRun(report().replace('... ok', '... FAILED'), 0)).toThrow(
    'did not pass',
  );
  expect(() => verifyRealHelperRun(report().replace('0 ignored', '1 ignored'), 0)).toThrow(
    'summary',
  );
  expect(() => verifyRealHelperRun(report().replace('0 failed', '1 failed'), 0)).toThrow('summary');
  expect(() => verifyRealHelperRun(report().split('\n').slice(0, -1).join('\n'), 0)).toThrow(
    'summary',
  );
  expect(() => verifyRealHelperRun(`${report()}\n${report()}`, 0)).toThrow('duplicated');
});

test('status-only or unrelated successful Rust test output refuses', () => {
  expect(() => verifyRealHelperRun('SUCCESS', 0)).toThrow('incomplete');
  expect(() =>
    verifyRealHelperRun(
      'test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 24 filtered out;',
      0,
    ),
  ).toThrow('incomplete');
  expect(() => realHelperInventory('')).toThrow('incomplete');
  expect(() => realHelperInventory(listing().replace('24 tests', '1 tests'))).toThrow('summary');
  expect(() => realHelperInventory(`${listing()}24 tests, 0 benchmarks\n`)).toThrow('summary');
});

test('only exact engine inputs and native target paths are accepted', () => {
  const native = `${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-${process.platform === 'darwin' ? 'apple-darwin' : 'unknown-linux-gnu'}`;
  const input = { harness: '_main/harness', worker: '_main/worker', target: native };
  expect(realHelperInputs(input)).toEqual({ harness: input.harness, worker: input.worker });
  for (const path of [
    '/outside',
    '../outside',
    '_main/../outside',
    '_main//file',
    '_main/./file',
    '_main\\file',
    '_main/\0file',
  ]) {
    expect(() => realHelperInputs({ ...input, harness: path })).toThrow('declared');
  }
  expect(() => realHelperInputs({ ...input, worker: input.harness })).toThrow('distinct');
  expect(() => realHelperInputs({ ...input, target: 'wasm32-unknown-unknown' })).toThrow('native');
  expect(() => realHelperInputs({ ...input, cargo: '/ambient/cargo' })).toThrow('declared');
  expect(() => realHelperInputs(null)).toThrow('object');
});
