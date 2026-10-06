/** Paired percentile difference with a deterministic percentile-bootstrap interval.
 * Keep raw observations and pairing order: missing endpoints are errors, never zeroes.
 * The caller declares its acceptance budget before collecting either arm.
 */
export function pairedTail(control: readonly number[], treatment: readonly number[]) {
  if (
    control.length < 20 ||
    control.length !== treatment.length ||
    [...control, ...treatment].some((value) => !Number.isFinite(value) || value < 0)
  ) {
    throw new Error('paired tails require at least 20 complete, finite, nonnegative pairs');
  }
  const quantile = (values: number[], rank: number) => {
    values.sort((a, b) => a - b);
    const result = values[Math.ceil(values.length * rank) - 1];
    if (result === undefined) throw new Error('empty quantile');
    return result;
  };
  let state = 0x4b4750;
  const differences: number[] = [];
  for (let trial = 0; trial < 8192; trial++) {
    const a: number[] = [];
    const b: number[] = [];
    for (let pair = 0; pair < control.length; pair++) {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      const index = (state >>> 0) % control.length;
      const left = control[index];
      const right = treatment[index];
      if (left === undefined || right === undefined) throw new Error('missing pair');
      a.push(left);
      b.push(right);
    }
    differences.push(quantile(b, 0.95) - quantile(a, 0.95));
  }
  const controlP95 = quantile([...control], 0.95);
  const treatmentP95 = quantile([...treatment], 0.95);
  return {
    pairs: control.length,
    controlP95,
    treatmentP95,
    difference: treatmentP95 - controlP95,
    lower95: quantile(differences, 0.025),
    upper95: quantile(differences, 0.975),
  };
}

/**
 * The largest population the exact sign test below accepts: the impaired
 * graphics typing cap, which bounds its lossy pairs.
 */
export const SIGN_TEST_MAX_PAIRS = 920;

/**
 * Distribution-free upper confidence bound for the median paired difference.
 *
 * `bound` is the `k`-th smallest difference (1-based) for the least `k` with
 * P(Binomial(n, 1/2) <= k - 1) >= `confidence`: whatever the distribution, its
 * median lies above that order statistic with probability at most
 * 1 - `confidence`. The binomial CDF and its comparison with `confidence` are
 * exact integer arithmetic, so no rounding can move `k`.
 */
export function signTestMedianUpper(
  differences: readonly number[],
  confidence = 0.95,
): { readonly n: number; readonly k: number; readonly bound: number } {
  const n = differences.length;
  if (
    n < 1 ||
    n > SIGN_TEST_MAX_PAIRS ||
    differences.some((value) => !Number.isFinite(value)) ||
    !(confidence > 0 && confidence < 1)
  ) {
    throw new Error(
      `a sign test needs 1 to ${SIGN_TEST_MAX_PAIRS} finite differences and a confidence in (0, 1)`,
    );
  }
  // Every finite double is exactly an integer over a power of two.
  let numerator = confidence;
  let denominator = 1n;
  while (!Number.isInteger(numerator)) {
    numerator *= 2;
    denominator *= 2n;
  }
  const required = BigInt(numerator) * 2n ** BigInt(n);
  let coefficient = 1n;
  let cumulative = 0n;
  for (let k = 1; k <= n; k++) {
    cumulative += coefficient;
    if (cumulative * denominator >= required) {
      const bound = [...differences].sort((a, b) => a - b)[k - 1];
      if (bound === undefined) throw new Error('missing order statistic');
      return { n, k, bound };
    }
    coefficient = (coefficient * BigInt(n - k + 1)) / BigInt(k);
  }
  throw new Error(`a sign test over ${n} pairs cannot reach ${confidence} confidence`);
}
