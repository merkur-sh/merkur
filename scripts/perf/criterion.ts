import type { PerfMetric } from './harness';

const TIME_LINE =
  /^\s*(.*?)\s*time:\s*\[\s*([0-9]+(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)\s*(ps|ns|µs|us|ms|s)\s+([0-9]+(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)\s*(ps|ns|µs|us|ms|s)\s+([0-9]+(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)\s*(ps|ns|µs|us|ms|s)\s*\]/u;
const BENCHMARKING_LINE = /^Benchmarking (.+?)(?:: (?:Warming up|Collecting|Analyzing).*)?$/;

const NANOSECONDS_PER_UNIT: Readonly<Record<string, number>> = {
  ps: 1e-3,
  ns: 1,
  µs: 1e3,
  us: 1e3,
  ms: 1e6,
  s: 1e9,
};

/**
 * Convert Criterion's confidence-interval point estimate into structured,
 * unit-normalized metrics consumed by the project regression gate.
 */
export function parseCriterionMetrics(output: string, sampleSize: number): PerfMetric[] {
  if (!Number.isSafeInteger(sampleSize) || sampleSize <= 0) {
    throw new Error('Criterion sample size must be a positive safe integer');
  }
  if (output.includes('[output truncated after ')) {
    throw new Error('Criterion output was truncated; the benchmark metric set may be incomplete');
  }

  const metrics: PerfMetric[] = [];
  const seen = new Set<string>();
  let activeBenchmark: string | null = null;
  let previousNonEmptyLine: { readonly text: string; readonly unindented: boolean } | null = null;
  for (const rawLine of output.split(/\r?\n/)) {
    const line = stripAnsi(rawLine);
    const benchmarking = line.match(BENCHMARKING_LINE);
    if (benchmarking?.[1] !== undefined) {
      activeBenchmark = benchmarking[1].trim();
    }

    const match = line.match(TIME_LINE);
    if (match === null) {
      if (line.trim().length > 0) {
        previousNonEmptyLine = {
          text: line.trim(),
          unindented: line.length === line.trimStart().length,
        };
      }
      continue;
    }
    const inlineName = match[1]?.trim() ?? '';
    // Criterion's non-TTY renderer prints the first estimate inline, but
    // commonly renders every later identity on its own unindented line:
    //
    //   group/function/value
    //                           time: [lower point upper]
    //
    // Progress lines are often written to stderr, so they are unavailable
    // when parsing stdout. The immediately preceding unindented line is the
    // only causally adjacent identity in that representation.
    const standaloneName =
      previousNonEmptyLine?.unindented === true &&
      isStandaloneBenchmarkIdentity(previousNonEmptyLine.text)
        ? previousNonEmptyLine.text
        : null;
    const benchmark = inlineName.length > 0 ? inlineName : (standaloneName ?? activeBenchmark);
    const lowerEstimate = Number(match[2]);
    const lowerUnit = match[3];
    const estimate = Number(match[4]);
    const unit = match[5];
    const upperEstimate = Number(match[6]);
    const upperUnit = match[7];
    if (
      benchmark === null ||
      benchmark.length === 0 ||
      lowerUnit === undefined ||
      unit === undefined ||
      upperUnit === undefined
    ) {
      throw new Error(`Criterion time estimate has no benchmark identity: ${rawLine}`);
    }
    const lowerMultiplier = NANOSECONDS_PER_UNIT[lowerUnit];
    const multiplier = NANOSECONDS_PER_UNIT[unit];
    const upperMultiplier = NANOSECONDS_PER_UNIT[upperUnit];
    if (
      lowerMultiplier === undefined ||
      multiplier === undefined ||
      upperMultiplier === undefined ||
      !Number.isFinite(lowerEstimate) ||
      !Number.isFinite(estimate) ||
      !Number.isFinite(upperEstimate)
    ) {
      throw new Error(`invalid Criterion time estimate: ${rawLine}`);
    }
    const lowerNs = lowerEstimate * lowerMultiplier;
    const estimateNs = estimate * multiplier;
    const upperNs = upperEstimate * upperMultiplier;
    if (
      !Number.isFinite(lowerNs) ||
      !Number.isFinite(estimateNs) ||
      !Number.isFinite(upperNs) ||
      lowerNs > estimateNs ||
      estimateNs > upperNs
    ) {
      throw new Error(`invalid Criterion confidence interval: ${rawLine}`);
    }
    const name = `criterion-time:${benchmark}`;
    if (seen.has(name)) {
      throw new Error(`Criterion emitted duplicate time estimate: ${benchmark}`);
    }
    seen.add(name);
    metrics.push({
      name,
      value: estimateNs,
      unit: 'ns/op',
      direction: 'lower',
      sampleSize,
    });
    activeBenchmark = benchmark;
    previousNonEmptyLine = {
      text: line.trim(),
      unindented: line.length === line.trimStart().length,
    };
  }
  return metrics;
}

function isStandaloneBenchmarkIdentity(value: string): boolean {
  return (
    value.length > 0 &&
    !value.includes('time:') &&
    !value.startsWith('Benchmarking ') &&
    !value.startsWith('Found ') &&
    !value.startsWith('Gnuplot ') &&
    !value.startsWith('Running ') &&
    !value.startsWith('Finished ')
  );
}

function stripAnsi(value: string): string {
  let result = '';
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) !== 0x1b || value[index + 1] !== '[') {
      result += value[index];
      continue;
    }
    let cursor = index + 2;
    while (cursor < value.length) {
      const code = value.charCodeAt(cursor);
      if (code >= 0x40 && code <= 0x7e) {
        index = cursor;
        break;
      }
      if (code < 0x20 || code > 0x3f) {
        // Not a CSI sequence after all; retain the escape byte.
        result += value[index];
        break;
      }
      cursor += 1;
    }
  }
  return result;
}
