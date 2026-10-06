import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  graphicsLongArguments,
  graphicsLongCases,
  graphicsLongFilter,
  graphicsLongInventory,
  verifyGraphicsLongRun,
} from './graphics-long';

function listing(names: readonly string[]) {
  return `${names.map((name) => `${name}: test`).join('\n')}\n\n${names.length} tests, 0 benchmarks\n`;
}

function report(names: readonly string[]) {
  return [
    ...names.map((name) => `test ${name} ... ok`),
    `test result: ok. ${names.length} passed; 0 failed; 0 ignored; 0 measured; 200 filtered out; finished in 1.00s`,
  ].join('\n');
}

test('long lane preserves original ignored filter, both named tests and default concurrency', () => {
  expect(graphicsLongArguments).toEqual(['--ignored', 'display::graphics_convergence::long::']);
  expect(graphicsLongFilter).toBe('display::graphics_convergence::long::');
  expect(graphicsLongInventory(listing(graphicsLongCases), 'lib')).toEqual(graphicsLongCases);
  expect(() => verifyGraphicsLongRun(report(graphicsLongCases), 0, 'lib')).not.toThrow();
});

test('omitting, duplicating or substituting either long test refuses', () => {
  const first = graphicsLongCases[0];
  if (first === undefined) throw new Error('Original long inventory is empty');
  for (const names of [
    graphicsLongCases.slice(0, 1),
    [first, first],
    [first, 'foreign::long::green'],
  ]) {
    expect(() => graphicsLongInventory(listing(names), 'lib')).toThrow();
    expect(() => verifyGraphicsLongRun(report(names), 0, 'lib')).toThrow();
  }
});

test('failed native execution, ignored cases and incomplete output remain failures', () => {
  expect(() => verifyGraphicsLongRun(report(graphicsLongCases), 23, 'lib')).toThrow('exited 23');
  expect(() =>
    verifyGraphicsLongRun(report(graphicsLongCases).replace('... ok', '... FAILED'), 0, 'lib'),
  ).toThrow('did not pass');
  expect(() =>
    verifyGraphicsLongRun(report(graphicsLongCases).replace('0 ignored', '1 ignored'), 0, 'lib'),
  ).toThrow('summary');
  expect(() => verifyGraphicsLongRun('SUCCESS', 0, 'lib')).toThrow('incomplete');
  expect(() =>
    graphicsLongInventory(`${listing(graphicsLongCases)}2 tests, 0 benchmarks\n`, 'lib'),
  ).toThrow('summary');
});

test('original empty Bin remains executed and cannot authorize an empty Lib', () => {
  expect(graphicsLongInventory(listing([]), 'bin')).toEqual([]);
  expect(() => verifyGraphicsLongRun(report([]), 0, 'bin')).not.toThrow();
  expect(() => verifyGraphicsLongRun(report([]), 17, 'bin')).toThrow('exited 17');
  expect(() => graphicsLongInventory(listing([]), 'lib')).toThrow('incomplete');
  expect(() => verifyGraphicsLongRun(report([]), 0, 'lib')).toThrow('incomplete');
  expect(() => graphicsLongInventory(listing(graphicsLongCases), 'bin')).toThrow('incomplete');
  expect(() => graphicsLongInventory(listing(graphicsLongCases), 'foreign')).toThrow('role');
});

test('original source retains 64 seeds, 160 operations, both drivers and sibling worker lookup', () => {
  const convergence = process.env.MERKUR_GRAPHICS_LONG_SOURCE;
  const graphics = process.env.MERKUR_GRAPHICS_WORKER_LOOKUP;
  const bin = process.env.MERKUR_GRAPHICS_BIN_SOURCE;
  if (convergence === undefined || graphics === undefined || bin === undefined)
    throw new Error('Original declared graphics source Files required');
  const source = readFileSync(convergence, 'utf8');
  expect(source).toContain('converge_across_seeds(Driver::Projection, &many_seeds(64), 160);');
  expect(source).toContain('converge_across_seeds(Driver::Kitty, &many_seeds(64), 160);');
  const lookup = readFileSync(graphics, 'utf8');
  expect(lookup).toContain('.and_then(std::path::Path::parent)');
  expect(lookup).toContain('.join("merkur-image-worker")');
  expect(readFileSync(bin, 'utf8')).toBe(
    '//! The `merkur-dataplane` process. The dataplane itself is the library, which the\n//! network simulator links too.\n\nfn main() {\n    merkur_dataplane::main();\n}\n',
  );
});
