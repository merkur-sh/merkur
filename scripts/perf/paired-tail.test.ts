import { expect, test } from 'bun:test';
import { pairedTail, SIGN_TEST_MAX_PAIRS, signTestMedianUpper } from './paired-tail';

test('paired resampling preserves exact identity and additive effects', () => {
  const control = Array.from({ length: 100 }, (_, index) => (index % 19) ** 2);
  expect(pairedTail(control, control)).toMatchObject({ difference: 0, lower95: 0, upper95: 0 });
  expect(
    pairedTail(
      control,
      control.map((value) => value + 7),
    ),
  ).toMatchObject({
    difference: 7,
    lower95: 7,
    upper95: 7,
  });
  expect(pairedTail(control, control)).toEqual(pairedTail(control, control));
});

test('tail changes cannot disappear behind an unchanged median', () => {
  const control = new Array<number>(100).fill(1);
  const treatment = control.map((value, index) => (index >= 80 ? 100 : value));
  expect(pairedTail(control, treatment)).toMatchObject({
    controlP95: 1,
    treatmentP95: 100,
    difference: 99,
    lower95: 99,
    upper95: 99,
  });
});

test('incomplete or nonfinite populations cannot qualify', () => {
  const complete = new Array<number>(100).fill(1);
  for (const invalid of [
    [],
    complete.slice(1),
    complete.map(() => Number.NaN),
    complete.map(() => -1),
  ]) {
    expect(() => pairedTail(complete, invalid)).toThrow();
  }
});

/** P(Binomial(n, 1/2) <= k - 1) from exact coefficients, independently of the implementation. */
function binomialCoverage(n: number, k: number): number {
  let coefficient = 1n;
  let cumulative = 0n;
  for (let j = 0; j < k; j++) {
    cumulative += coefficient;
    coefficient = (coefficient * BigInt(n - j)) / BigInt(j + 1);
  }
  return Number((cumulative * 1_000_000n) / 2n ** BigInt(n)) / 1_000_000;
}

test('sign test bound is the exact binomial order statistic of the sorted differences', () => {
  const ascending = (n: number) => Array.from({ length: n }, (_, index) => index * 0.5);
  expect(signTestMedianUpper(ascending(44))).toEqual({ n: 44, k: 28, bound: 13.5 });
  expect(signTestMedianUpper(ascending(78).reverse())).toEqual({ n: 78, k: 47, bound: 23 });
  expect(binomialCoverage(44, 28)).toBeCloseTo(0.9519, 4);
  expect(binomialCoverage(78, 47)).toBeCloseTo(0.9556, 4);
});

test('sign test k is the least order statistic reaching the confidence', () => {
  for (const n of [5, 44, 78, 220, SIGN_TEST_MAX_PAIRS]) {
    const { k } = signTestMedianUpper(new Array<number>(n).fill(0));
    expect(binomialCoverage(n, k)).toBeGreaterThanOrEqual(0.95);
    expect(binomialCoverage(n, k - 1)).toBeLessThan(0.95);
  }
});

test('sign test refuses populations it cannot bound', () => {
  for (const invalid of [
    [],
    [1, 2, 3, 4],
    new Array<number>(SIGN_TEST_MAX_PAIRS + 1).fill(0),
    [Number.NaN, 1, 2, 3, 4, 5],
  ]) {
    expect(() => signTestMedianUpper(invalid)).toThrow();
  }
  expect(() => signTestMedianUpper([1, 2, 3], 1)).toThrow();
});
