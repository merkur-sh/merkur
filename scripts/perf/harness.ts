export const PERF_METRIC_PREFIX = '@@merkur-perf ';
export const PERF_REPORT_SCHEMA_VERSION = 4;

export type MetricDirection = 'higher' | 'lower';
export type WorkloadFidelity = 'production' | 'component' | 'model' | 'verification';
export type ProcessMetricPolicy = 'gated' | 'diagnostic';

export interface PerfMetric {
  readonly name: string;
  readonly value: number;
  readonly unit: string;
  readonly direction: MetricDirection;
  readonly percentile?: number;
  readonly sampleSize?: number;
}

export interface SampleSummary {
  readonly count: number;
  readonly min: number;
  readonly max: number;
  readonly mean: number;
  readonly median: number;
  readonly p90: number;
  readonly p95: number;
  readonly p99: number;
  readonly standardDeviation: number;
  readonly coefficientOfVariation: number;
  readonly medianAbsoluteDeviation: number;
}

export interface MetricSummary extends PerfMetric {
  readonly samples: readonly number[];
  readonly summary: SampleSummary;
}

export interface ProfileRun {
  readonly wallMs: number;
  readonly cpuUserMs: number;
  readonly cpuSystemMs: number;
  readonly maxRssBytes: number;
  readonly exitCode: number;
  readonly signalCode: string | null;
  readonly timedOut: boolean;
  readonly stdout: string;
  readonly stderr: string;
  readonly metrics: readonly PerfMetric[];
  /** Harness/parser failure. Command failures remain represented by exitCode/signalCode. */
  readonly error: string | null;
}

export interface WorkloadReport {
  readonly service: string;
  readonly name: string;
  readonly fidelity: WorkloadFidelity;
  /** Whether outer process wall/CPU/RSS measurements participate in regression gates. */
  readonly processMetrics: ProcessMetricPolicy;
  readonly command: readonly string[];
  /** Explicit workload overrides only; inherited environment secrets are never recorded. */
  readonly environmentOverrides: Readonly<Record<string, string>>;
  readonly repetitions: number;
  readonly warmups: number;
  readonly timeoutMs: number;
  readonly runs: readonly ProfileRun[];
  readonly wallMs: SampleSummary;
  readonly cpuMs: SampleSummary;
  readonly maxRssBytes: SampleSummary;
  readonly metrics: readonly MetricSummary[];
  readonly errors: readonly string[];
  readonly passed: boolean;
}

export interface ProfileReport {
  readonly schemaVersion: number;
  readonly generatedAt: string;
  readonly mode: string;
  readonly revision: string | null;
  readonly dirty: boolean | null;
  readonly environmentPolicy: 'sanitized-v1';
  readonly platform: {
    readonly os: string;
    readonly osRelease: string;
    readonly osVersion: string;
    readonly arch: string;
    readonly bun: string;
    readonly cpuModel: string;
    readonly logicalCpuCount: number;
    readonly totalMemoryBytes: number;
    readonly rustc: string;
    readonly cargo: string;
    readonly llvm: string;
    readonly rustHost: string;
  };
  readonly workloads: readonly WorkloadReport[];
}

export interface MetricComparison {
  readonly service: string;
  readonly workload: string;
  readonly metric: string;
  readonly unit: string;
  readonly percentile?: number;
  readonly direction: MetricDirection;
  readonly baseline: number;
  readonly current: number;
  readonly changeRatio: number;
  readonly regression: boolean;
}

export interface VarianceViolation {
  readonly service: string;
  readonly workload: string;
  readonly metric: string;
  readonly coefficientOfVariation: number;
}

export interface CommandOptions {
  readonly command: readonly string[];
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly replaceEnvironment?: boolean;
  readonly timeoutMs: number;
  readonly outputLimitBytes?: number;
}

interface OutputCapture {
  readonly promise: Promise<string>;
  abort(): void;
}

const DEFAULT_OUTPUT_LIMIT_BYTES = 2 * 1024 * 1024;
const KILL_GRACE_MS = 1_000;
// A descendant can create a new process group/session and retain an inherited
// pipe after the command itself exits. Process-group signals cannot reach that
// escapee (and Windows has no equivalent group signal), so output draining
// needs its own finite deadline.
const OUTPUT_DRAIN_GRACE_MS = KILL_GRACE_MS + 1_000;
const OUTPUT_DRAIN_ABORTED_MARKER = '[output drain aborted after child exit]';

/** Exact integer environment knobs shared by the component benchmark drivers. */
export function perfEnvInteger(name: string, defaultValue: number, minimum = 1): number {
  const value = Number(process.env[name] ?? defaultValue);
  if (!Number.isSafeInteger(value) || value < minimum)
    throw new Error(`${name} must be an integer >= ${minimum}`);
  return value;
}

export function emitPerfMetric(metric: PerfMetric): void {
  validateMetric(metric);
  process.stdout.write(`${PERF_METRIC_PREFIX}${JSON.stringify(metric)}\n`);
}

export function parsePerfMetrics(output: string): PerfMetric[] {
  const metrics: PerfMetric[] = [];
  for (const line of output.split(/\r?\n/)) {
    if (!line.startsWith(PERF_METRIC_PREFIX)) continue;
    const payload = line.slice(PERF_METRIC_PREFIX.length);
    let value: unknown;
    try {
      value = JSON.parse(payload);
    } catch {
      throw new Error(`invalid performance metric JSON: ${payload}`);
    }
    if (!isPerfMetric(value)) {
      throw new Error(`invalid performance metric shape: ${payload}`);
    }
    metrics.push(value);
  }
  return metrics;
}

/** Nearest-rank percentile of unsorted samples; `ratio` in (0, 1]. */
export function percentile(samples: readonly number[], ratio: number): number {
  return nearestRank(
    [...samples].sort((left, right) => left - right),
    ratio,
  );
}

export function summarizeSamples(samples: readonly number[]): SampleSummary {
  if (samples.length === 0) {
    throw new Error('cannot summarize an empty sample set');
  }
  if (!samples.every(Number.isFinite)) {
    throw new Error('performance samples must all be finite');
  }

  const sorted = [...samples].sort((left, right) => left - right);
  const mean = sorted.reduce((sum, value) => sum + value, 0) / sorted.length;
  const variance = sorted.reduce((sum, value) => sum + (value - mean) ** 2, 0) / sorted.length;
  const standardDeviation = Math.sqrt(variance);
  const deviations = sorted.map((value) => Math.abs(value - nearestRank(sorted, 0.5)));
  // CV is undefined for a zero mean. Treat a varying zero-mean signal as
  // maximally noisy instead of reporting the dangerously reassuring value 0.
  const coefficientOfVariation =
    mean === 0
      ? standardDeviation === 0
        ? 0
        : Number.MAX_VALUE
      : Math.min(Number.MAX_VALUE, standardDeviation / Math.abs(mean));

  return {
    count: sorted.length,
    min: sorted[0] ?? 0,
    max: sorted[sorted.length - 1] ?? 0,
    mean,
    median: nearestRank(sorted, 0.5),
    p90: nearestRank(sorted, 0.9),
    p95: nearestRank(sorted, 0.95),
    p99: nearestRank(sorted, 0.99),
    standardDeviation,
    coefficientOfVariation,
    medianAbsoluteDeviation: nearestRank(
      deviations.sort((left, right) => left - right),
      0.5,
    ),
  };
}

export function aggregateMetrics(runs: readonly ProfileRun[]): MetricSummary[] {
  const groups = new Map<string, { template: PerfMetric; values: number[] }>();
  let expectedKeys: Set<string> | null = null;
  for (const [runIndex, run] of runs.entries()) {
    const seen = new Set<string>();
    for (const metric of run.metrics) {
      const key = metricKey(metric);
      if (seen.has(key)) {
        throw new Error(`workload emitted duplicate metric in one run: ${key}`);
      }
      seen.add(key);
      const group = groups.get(key);
      if (group === undefined) {
        groups.set(key, { template: metric, values: [metric.value] });
      } else {
        if (
          group.template.direction !== metric.direction ||
          group.template.sampleSize !== metric.sampleSize
        ) {
          throw new Error(`workload changed metric metadata between runs: ${key}`);
        }
        group.values.push(metric.value);
      }
    }
    if (expectedKeys === null) {
      expectedKeys = seen;
    } else if (!sameSet(expectedKeys, seen)) {
      // Keep the non-null branch in a local binding: TypeScript correctly
      // refuses to retain mutable-variable narrowing inside Array.filter's
      // callback.
      const establishedKeys = expectedKeys;
      const missing = [...establishedKeys].filter((key) => !seen.has(key));
      const unexpected = [...seen].filter((key) => !establishedKeys.has(key));
      throw new Error(
        `workload emitted inconsistent metrics in run ${runIndex + 1}: ` +
          `missing=${JSON.stringify(missing)}, unexpected=${JSON.stringify(unexpected)}`,
      );
    }
  }

  return [...groups.values()]
    .map(({ template, values }) => ({
      ...template,
      samples: values,
      summary: summarizeSamples(values),
    }))
    .sort((left, right) => metricKey(left).localeCompare(metricKey(right)));
}

export function compareProfileReports(
  current: ProfileReport,
  baseline: ProfileReport,
  allowedRegressionRatio: number,
): MetricComparison[] {
  if (!Number.isFinite(allowedRegressionRatio) || allowedRegressionRatio < 0) {
    throw new Error('allowed regression ratio must be a non-negative finite number');
  }
  if (!isProfileReport(baseline)) {
    throw new Error('cannot compare against an invalid or internally inconsistent baseline');
  }
  if (!isProfileReport(current)) {
    throw new Error('cannot compare an invalid or internally inconsistent current profile');
  }
  if (current.mode !== baseline.mode) {
    throw new Error(
      `cannot compare profiles captured in different modes: ${baseline.mode} -> ${current.mode}`,
    );
  }
  if (current.environmentPolicy !== baseline.environmentPolicy) {
    throw new Error(
      `cannot compare profiles with different environment policies: ` +
        `${baseline.environmentPolicy} -> ${current.environmentPolicy}`,
    );
  }
  const hardwareFields = [
    'os',
    'osRelease',
    'osVersion',
    'arch',
    'bun',
    'cpuModel',
    'logicalCpuCount',
    'totalMemoryBytes',
    'rustc',
    'cargo',
    'llvm',
    'rustHost',
  ] as const;
  for (const field of hardwareFields) {
    if (current.platform[field] !== baseline.platform[field]) {
      throw new Error(
        `cannot compare profiles from different hardware/platforms: ${field} ` +
          `${JSON.stringify(baseline.platform[field])} -> ` +
          `${JSON.stringify(current.platform[field])}`,
      );
    }
  }
  const baselineMetrics = new Map<string, MetricSummary>();
  for (const workload of baseline.workloads) {
    for (const metric of workload.metrics) {
      baselineMetrics.set(reportMetricKey(workload.service, workload.name, metric), metric);
    }
  }
  const baselineWorkloads = new Map(
    baseline.workloads.map((workload) => [
      reportWorkloadKey(workload.service, workload.name),
      workload,
    ]),
  );
  if (baselineWorkloads.size !== baseline.workloads.length) {
    throw new Error('baseline profile contains duplicate workload identities');
  }
  const failedBaseline = baseline.workloads.find((workload) => !workload.passed);
  if (failedBaseline !== undefined) {
    throw new Error(
      `cannot compare against a failed baseline workload: ` +
        `${failedBaseline.service}/${failedBaseline.name}`,
    );
  }
  const failedCurrent = current.workloads.find((workload) => !workload.passed);
  if (failedCurrent !== undefined) {
    throw new Error(
      `cannot compare a failed current workload: ${failedCurrent.service}/${failedCurrent.name}`,
    );
  }
  const currentWorkloads = new Map(
    current.workloads.map((workload) => [
      reportWorkloadKey(workload.service, workload.name),
      workload,
    ]),
  );
  if (currentWorkloads.size !== current.workloads.length) {
    throw new Error('current profile contains duplicate workload identities');
  }
  if (currentWorkloads.size !== baselineWorkloads.size) {
    const unexpected = [...currentWorkloads.keys()]
      .filter((key) => !baselineWorkloads.has(key))
      .map(formatWorkloadKey);
    const missing = [...baselineWorkloads.keys()]
      .filter((key) => !currentWorkloads.has(key))
      .map(formatWorkloadKey);
    throw new Error(
      `profile workload sets differ: missing=${JSON.stringify(missing)}, ` +
        `unexpected=${JSON.stringify(unexpected)}`,
    );
  }
  for (const [key, baselineWorkload] of baselineWorkloads) {
    const currentWorkload = currentWorkloads.get(key);
    if (currentWorkload === undefined) {
      throw new Error(
        `current profile is missing baseline workload: ` +
          `${baselineWorkload.service}/${baselineWorkload.name}`,
      );
    }
    if (currentWorkload.fidelity !== baselineWorkload.fidelity) {
      throw new Error(
        `workload fidelity changed between baseline and current report: ` +
          `${baselineWorkload.service}/${baselineWorkload.name}`,
      );
    }
    if (currentWorkload.processMetrics !== baselineWorkload.processMetrics) {
      throw new Error(
        `workload process metric policy changed between baseline and current report: ` +
          `${baselineWorkload.service}/${baselineWorkload.name}`,
      );
    }
    if (!sameArray(currentWorkload.command, baselineWorkload.command)) {
      throw new Error(
        `workload command changed between baseline and current report: ` +
          `${baselineWorkload.service}/${baselineWorkload.name}`,
      );
    }
    if (
      !sameStringRecord(currentWorkload.environmentOverrides, baselineWorkload.environmentOverrides)
    ) {
      throw new Error(
        `workload environment changed between baseline and current report: ` +
          `${baselineWorkload.service}/${baselineWorkload.name}`,
      );
    }
    if (
      currentWorkload.repetitions !== baselineWorkload.repetitions ||
      currentWorkload.warmups !== baselineWorkload.warmups ||
      currentWorkload.timeoutMs !== baselineWorkload.timeoutMs
    ) {
      throw new Error(
        `workload sampling configuration changed between baseline and current report: ` +
          `${baselineWorkload.service}/${baselineWorkload.name}`,
      );
    }
    const currentMetricKeys = new Set(
      currentWorkload.metrics.map((metric) =>
        reportMetricKey(currentWorkload.service, currentWorkload.name, metric),
      ),
    );
    const baselineMetricKeys = new Set(
      baselineWorkload.metrics.map((metric) =>
        reportMetricKey(baselineWorkload.service, baselineWorkload.name, metric),
      ),
    );
    if (currentMetricKeys.size !== baselineMetricKeys.size) {
      const unexpected = currentWorkload.metrics
        .filter(
          (metric) =>
            !baselineMetricKeys.has(
              reportMetricKey(currentWorkload.service, currentWorkload.name, metric),
            ),
        )
        .map((metric) => metric.name);
      const missing = baselineWorkload.metrics
        .filter(
          (metric) =>
            !currentMetricKeys.has(
              reportMetricKey(baselineWorkload.service, baselineWorkload.name, metric),
            ),
        )
        .map((metric) => metric.name);
      throw new Error(
        `profile metric sets differ for ${baselineWorkload.service}/${baselineWorkload.name}: ` +
          `missing=${JSON.stringify(missing)}, unexpected=${JSON.stringify(unexpected)}`,
      );
    }
    for (const baselineMetric of baselineWorkload.metrics) {
      const metricKey = reportMetricKey(
        baselineWorkload.service,
        baselineWorkload.name,
        baselineMetric,
      );
      if (!currentMetricKeys.has(metricKey)) {
        throw new Error(
          `current profile is missing baseline metric: ` +
            `${baselineWorkload.service}/${baselineWorkload.name}/${baselineMetric.name}`,
        );
      }
    }
  }

  const comparisons: MetricComparison[] = [];
  for (const workload of current.workloads) {
    const baselineWorkload = baselineWorkloads.get(
      reportWorkloadKey(workload.service, workload.name),
    );
    if (baselineWorkload !== undefined && workload.processMetrics === 'gated') {
      appendProcessComparison(
        comparisons,
        workload,
        'process-wall-p50',
        'ms',
        workload.wallMs.median,
        baselineWorkload.wallMs.median,
        allowedRegressionRatio,
      );
      appendProcessComparison(
        comparisons,
        workload,
        'process-cpu-p50',
        'ms',
        workload.cpuMs.median,
        baselineWorkload.cpuMs.median,
        allowedRegressionRatio,
      );
      appendProcessComparison(
        comparisons,
        workload,
        'process-max-rss',
        'bytes',
        workload.maxRssBytes.max,
        baselineWorkload.maxRssBytes.max,
        allowedRegressionRatio,
      );
    }
    for (const metric of workload.metrics) {
      const baselineMetric = baselineMetrics.get(
        reportMetricKey(workload.service, workload.name, metric),
      );
      if (baselineMetric === undefined) continue;
      if (baselineMetric.direction !== metric.direction) {
        throw new Error(
          `metric direction changed between baseline and current report: ` +
            `${workload.service}/${workload.name}/${metric.name}`,
        );
      }
      if (baselineMetric.sampleSize !== metric.sampleSize) {
        throw new Error(
          `metric sample size changed between baseline and current report: ` +
            `${workload.service}/${workload.name}/${metric.name}`,
        );
      }
      const baselineValue = baselineMetric.summary.median;
      const currentValue = metric.summary.median;
      const changeRatio = changeRatioFromBaseline(currentValue, baselineValue);
      comparisons.push({
        service: workload.service,
        workload: workload.name,
        metric: metric.name,
        unit: metric.unit,
        percentile: metric.percentile,
        direction: metric.direction,
        baseline: baselineValue,
        current: currentValue,
        changeRatio,
        regression:
          metric.direction === 'lower'
            ? changeRatio > allowedRegressionRatio
            : changeRatio < -allowedRegressionRatio,
      });
    }
  }
  return comparisons;
}

export function findVarianceViolations(
  report: ProfileReport,
  maximumCoefficientOfVariation: number,
): VarianceViolation[] {
  if (!Number.isFinite(maximumCoefficientOfVariation) || maximumCoefficientOfVariation < 0) {
    throw new Error('variance limit must be a non-negative finite number');
  }
  const violations: VarianceViolation[] = [];
  for (const workload of report.workloads) {
    const processSummaries: readonly [string, SampleSummary][] =
      workload.processMetrics === 'gated'
        ? [
            ['process-wall', workload.wallMs],
            ['process-cpu', workload.cpuMs],
            ['process-max-rss', workload.maxRssBytes],
          ]
        : [];
    const summaries: readonly [string, SampleSummary][] = [
      ...processSummaries,
      ...workload.metrics.map((metric): [string, SampleSummary] => [metric.name, metric.summary]),
    ];
    for (const [metric, summary] of summaries) {
      if (summary.count > 1 && summary.coefficientOfVariation > maximumCoefficientOfVariation) {
        violations.push({
          service: workload.service,
          workload: workload.name,
          metric,
          coefficientOfVariation: summary.coefficientOfVariation,
        });
      }
    }
  }
  return violations;
}

function appendProcessComparison(
  comparisons: MetricComparison[],
  workload: WorkloadReport,
  metric: string,
  unit: string,
  current: number,
  baseline: number,
  allowedRegressionRatio: number,
): void {
  // A zero process counter means the runtime/platform could not report it;
  // treating a later nonzero observation as +infinity would be a false gate.
  if (!(baseline > 0) || !Number.isFinite(current)) return;
  const changeRatio = changeRatioFromBaseline(current, baseline);
  comparisons.push({
    service: workload.service,
    workload: workload.name,
    metric,
    unit,
    direction: 'lower',
    baseline,
    current,
    changeRatio,
    regression: changeRatio > allowedRegressionRatio,
  });
}

function changeRatioFromBaseline(current: number, baseline: number): number {
  return baseline === 0
    ? current === 0
      ? 0
      : current > 0
        ? Number.POSITIVE_INFINITY
        : Number.NEGATIVE_INFINITY
    : (current - baseline) / Math.abs(baseline);
}

export async function runProfileCommand(options: CommandOptions): Promise<ProfileRun> {
  const command = [...options.command];
  if (command.length === 0) throw new Error('profile command cannot be empty');
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new Error('profile timeout must be a positive finite number');
  }
  if (
    options.outputLimitBytes !== undefined &&
    (!Number.isSafeInteger(options.outputLimitBytes) || options.outputLimitBytes <= 0)
  ) {
    throw new Error('profile output limit must be a positive safe integer');
  }
  const startedAt = performance.now();
  let timedOut = false;
  let outputDrainTimedOut = false;
  const subprocess = Bun.spawn(command, {
    cwd: options.cwd,
    // A timed-out benchmark often owns compiler/test grandchildren. Give it a
    // process group so timeout cleanup cannot leave those workers running and
    // contaminating every workload that follows.
    detached: process.platform !== 'win32',
    env:
      options.replaceEnvironment === true
        ? (options.env ?? {})
        : options.env === undefined
          ? process.env
          : { ...process.env, ...options.env },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const stdoutCapture = captureOutput(
    subprocess.stdout,
    options.outputLimitBytes ?? DEFAULT_OUTPUT_LIMIT_BYTES,
  );
  const stderrCapture = captureOutput(
    subprocess.stderr,
    options.outputLimitBytes ?? DEFAULT_OUTPUT_LIMIT_BYTES,
  );
  let forceKillTimer: ReturnType<typeof setTimeout> | null = null;
  const timeout = setTimeout(() => {
    timedOut = true;
    signalSubprocessTree(subprocess, 'SIGTERM');
    forceKillTimer = setTimeout(() => {
      // The direct child can exit while a grandchild in the detached process
      // group ignores SIGTERM and keeps stdout/stderr open. Always target the
      // group: checking only the direct child's exit code leaves the output
      // drain wedged forever in that case.
      signalSubprocessTree(subprocess, 'SIGKILL');
    }, KILL_GRACE_MS);
  }, options.timeoutMs);

  const exitCode = await subprocess.exited;
  clearTimeout(timeout);
  if (process.platform !== 'win32') {
    // A command that exits while leaving a detached grandchild holding stdout
    // open would otherwise wedge the drain forever after the main timeout had
    // already been cleared.
    signalSubprocessTree(subprocess, 'SIGTERM');
    forceKillTimer ??= setTimeout(() => {
      signalSubprocessTree(subprocess, 'SIGKILL');
    }, KILL_GRACE_MS);
  }
  const outputDrainTimer = setTimeout(() => {
    outputDrainTimedOut = true;
    signalSubprocessTree(subprocess, 'SIGKILL');
    stdoutCapture.abort();
    stderrCapture.abort();
  }, OUTPUT_DRAIN_GRACE_MS);
  const [stdout, stderr] = await Promise.all([stdoutCapture.promise, stderrCapture.promise]);
  clearTimeout(outputDrainTimer);
  if (forceKillTimer !== null) clearTimeout(forceKillTimer);
  const usage = subprocess.resourceUsage();

  let metrics: PerfMetric[] = [];
  const errors: string[] = [];
  if (outputDrainTimedOut) {
    errors.push(
      `subprocess output did not close within ${OUTPUT_DRAIN_GRACE_MS}ms after child exit`,
    );
  }
  try {
    metrics = parsePerfMetrics(stdout);
  } catch (cause) {
    errors.push(`structured metric parser failed: ${errorMessage(cause)}`);
  }

  return {
    wallMs: performance.now() - startedAt,
    cpuUserMs: resourceNumber(usage?.cpuTime.user) / 1_000,
    cpuSystemMs: resourceNumber(usage?.cpuTime.system) / 1_000,
    maxRssBytes: resourceNumber(usage?.maxRSS),
    exitCode,
    signalCode: subprocess.signalCode,
    timedOut,
    stdout,
    stderr,
    metrics,
    error: errors.length === 0 ? null : errors.join('; '),
  };
}

function signalSubprocessTree(
  subprocess: Pick<Bun.Subprocess, 'exitCode' | 'kill' | 'pid'>,
  signal: NodeJS.Signals,
): void {
  if (process.platform !== 'win32') {
    try {
      process.kill(-subprocess.pid, signal);
      return;
    } catch {
      // The child may have exited between the timer and signal. Fall through
      // to Bun's direct signal, which is safe and keeps Windows supported.
    }
  }
  // Do not hand an exited child's numeric PID back to the OS: it may already
  // have been reused by an unrelated process. Bun's direct kill is needed only
  // while the tracked child is still alive.
  if (subprocess.exitCode !== null) return;
  try {
    subprocess.kill(signal);
  } catch {
    // Exit won the race.
  }
}

function resourceNumber(value: number | bigint | undefined): number {
  if (typeof value === 'bigint') return Number(value);
  return value ?? 0;
}

export function isProfileReport(value: unknown): value is ProfileReport {
  if (!isRecord(value)) return false;
  const platform = value.platform;
  return (
    value.schemaVersion === PERF_REPORT_SCHEMA_VERSION &&
    typeof value.generatedAt === 'string' &&
    typeof value.mode === 'string' &&
    (value.revision === null || typeof value.revision === 'string') &&
    (value.dirty === null || typeof value.dirty === 'boolean') &&
    value.environmentPolicy === 'sanitized-v1' &&
    isRecord(platform) &&
    typeof platform.os === 'string' &&
    typeof platform.osRelease === 'string' &&
    typeof platform.osVersion === 'string' &&
    typeof platform.arch === 'string' &&
    typeof platform.bun === 'string' &&
    typeof platform.cpuModel === 'string' &&
    isPositiveSafeInteger(platform.logicalCpuCount) &&
    typeof platform.totalMemoryBytes === 'number' &&
    Number.isFinite(platform.totalMemoryBytes) &&
    platform.totalMemoryBytes > 0 &&
    typeof platform.rustc === 'string' &&
    typeof platform.cargo === 'string' &&
    typeof platform.llvm === 'string' &&
    typeof platform.rustHost === 'string' &&
    Array.isArray(value.workloads) &&
    value.workloads.every(isWorkloadReport) &&
    uniqueBy(value.workloads, (workload) => reportWorkloadKey(workload.service, workload.name))
  );
}

function isWorkloadReport(value: unknown): value is WorkloadReport {
  if (!isRecord(value)) return false;
  if (
    !(
      typeof value.service === 'string' &&
      typeof value.name === 'string' &&
      isWorkloadFidelity(value.fidelity) &&
      isProcessMetricPolicy(value.processMetrics) &&
      Array.isArray(value.command) &&
      value.command.length > 0 &&
      value.command.every((part) => typeof part === 'string') &&
      isStringRecord(value.environmentOverrides) &&
      isPositiveSafeInteger(value.repetitions) &&
      isNonNegativeSafeInteger(value.warmups) &&
      typeof value.timeoutMs === 'number' &&
      Number.isFinite(value.timeoutMs) &&
      value.timeoutMs > 0 &&
      Array.isArray(value.runs) &&
      value.runs.every(isProfileRun) &&
      value.runs.length === value.repetitions &&
      isSampleSummary(value.wallMs) &&
      value.wallMs.count === value.runs.length &&
      isSampleSummary(value.cpuMs) &&
      value.cpuMs.count === value.runs.length &&
      isSampleSummary(value.maxRssBytes) &&
      value.maxRssBytes.count === value.runs.length &&
      Array.isArray(value.metrics) &&
      value.metrics.every(isMetricSummary) &&
      Array.isArray(value.errors) &&
      value.errors.every((error) => typeof error === 'string' && error.length > 0) &&
      typeof value.passed === 'boolean' &&
      value.passed === (value.errors.length === 0 && value.runs.every(profileRunPassed))
    )
  ) {
    return false;
  }

  if (
    !sampleSummaryEquals(
      value.wallMs,
      value.runs.map((run) => run.wallMs),
    ) ||
    !sampleSummaryEquals(
      value.cpuMs,
      value.runs.map((run) => run.cpuUserMs + run.cpuSystemMs),
    ) ||
    !sampleSummaryEquals(
      value.maxRssBytes,
      value.runs.map((run) => run.maxRssBytes),
    )
  ) {
    return false;
  }

  // Successful reports are baseline-eligible, so every aggregate and metric
  // identity must be exactly reproducible from the raw runs. Failed reports
  // may intentionally omit aggregates after a parser/metadata failure.
  if (value.errors.length > 0) {
    return uniqueBy(value.metrics, metricKey);
  }
  let expectedMetrics: MetricSummary[];
  try {
    expectedMetrics = aggregateMetrics(value.runs);
  } catch {
    return false;
  }
  return metricSummarySetsEqual(value.metrics, expectedMetrics);
}

function isMetricSummary(value: unknown): value is MetricSummary {
  if (!isRecord(value)) return false;
  const summary = value.summary;
  return (
    isPerfMetric(value) &&
    Array.isArray(value.samples) &&
    value.samples.length > 0 &&
    value.samples.every((sample) => typeof sample === 'number' && Number.isFinite(sample)) &&
    isSampleSummary(summary) &&
    summary.count === value.samples.length &&
    sampleSummaryEquals(summary, value.samples)
  );
}

function isProfileRun(value: unknown): value is ProfileRun {
  if (!isRecord(value)) return false;
  return (
    isNonNegativeFiniteNumber(value.wallMs) &&
    isNonNegativeFiniteNumber(value.cpuUserMs) &&
    isNonNegativeFiniteNumber(value.cpuSystemMs) &&
    isNonNegativeFiniteNumber(value.maxRssBytes) &&
    typeof value.exitCode === 'number' &&
    Number.isInteger(value.exitCode) &&
    (value.signalCode === null || typeof value.signalCode === 'string') &&
    typeof value.timedOut === 'boolean' &&
    typeof value.stdout === 'string' &&
    typeof value.stderr === 'string' &&
    Array.isArray(value.metrics) &&
    value.metrics.every(isPerfMetric) &&
    uniqueBy(value.metrics, metricKey) &&
    (value.error === null || (typeof value.error === 'string' && value.error.length > 0))
  );
}

function isSampleSummary(value: unknown): value is SampleSummary {
  if (!isRecord(value)) return false;
  return [
    'count',
    'min',
    'max',
    'mean',
    'median',
    'p90',
    'p95',
    'p99',
    'standardDeviation',
    'coefficientOfVariation',
    'medianAbsoluteDeviation',
  ].every((key) => typeof value[key] === 'number' && Number.isFinite(value[key]));
}

function validateMetric(metric: PerfMetric): void {
  if (!isPerfMetric(metric)) {
    throw new Error(`invalid performance metric: ${JSON.stringify(metric)}`);
  }
}

function isPerfMetric(value: unknown): value is PerfMetric {
  if (!isRecord(value)) return false;
  return (
    typeof value.name === 'string' &&
    value.name.length > 0 &&
    typeof value.value === 'number' &&
    Number.isFinite(value.value) &&
    typeof value.unit === 'string' &&
    value.unit.length > 0 &&
    (value.direction === 'higher' || value.direction === 'lower') &&
    (value.percentile === undefined ||
      (typeof value.percentile === 'number' &&
        Number.isFinite(value.percentile) &&
        value.percentile > 0 &&
        value.percentile <= 1)) &&
    (value.sampleSize === undefined ||
      (typeof value.sampleSize === 'number' &&
        Number.isSafeInteger(value.sampleSize) &&
        value.sampleSize > 0))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isWorkloadFidelity(value: unknown): value is WorkloadFidelity {
  return (
    value === 'production' || value === 'component' || value === 'model' || value === 'verification'
  );
}

function isProcessMetricPolicy(value: unknown): value is ProcessMetricPolicy {
  return value === 'gated' || value === 'diagnostic';
}

function sameSet(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  if (left.size !== right.size) return false;
  for (const value of left) {
    if (!right.has(value)) return false;
  }
  return true;
}

function sameArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameStringRecord(
  left: Readonly<Record<string, string>>,
  right: Readonly<Record<string, string>>,
): boolean {
  const leftEntries = Object.entries(left).sort(([leftKey], [rightKey]) =>
    leftKey.localeCompare(rightKey),
  );
  const rightEntries = Object.entries(right).sort(([leftKey], [rightKey]) =>
    leftKey.localeCompare(rightKey),
  );
  return (
    leftEntries.length === rightEntries.length &&
    leftEntries.every(
      ([key, value], index) =>
        key === rightEntries[index]?.[0] && value === rightEntries[index]?.[1],
    )
  );
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((item) => typeof item === 'string');
}

function nearestRank(sorted: readonly number[], ratio: number): number {
  const index = Math.max(0, Math.ceil(sorted.length * ratio) - 1);
  return sorted[Math.min(sorted.length - 1, index)] ?? 0;
}

function metricKey(metric: Pick<PerfMetric, 'name' | 'unit' | 'percentile'>): string {
  return `${metric.name}\u0000${metric.unit}\u0000${metric.percentile ?? ''}`;
}

function reportMetricKey(
  service: string,
  workload: string,
  metric: Pick<PerfMetric, 'name' | 'unit' | 'percentile'>,
): string {
  return `${service}\u0000${workload}\u0000${metricKey(metric)}`;
}

function reportWorkloadKey(service: string, workload: string): string {
  return `${service}\u0000${workload}`;
}

function formatWorkloadKey(key: string): string {
  return key.replace('\u0000', '/');
}

function profileRunPassed(run: ProfileRun): boolean {
  return run.exitCode === 0 && run.signalCode === null && !run.timedOut && run.error === null;
}

function sampleSummaryEquals(summary: SampleSummary, samples: readonly number[]): boolean {
  if (samples.length === 0) return false;
  const expected = summarizeSamples(samples);
  return (
    summary.count === expected.count &&
    summary.min === expected.min &&
    summary.max === expected.max &&
    summary.mean === expected.mean &&
    summary.median === expected.median &&
    summary.p90 === expected.p90 &&
    summary.p95 === expected.p95 &&
    summary.p99 === expected.p99 &&
    summary.standardDeviation === expected.standardDeviation &&
    summary.coefficientOfVariation === expected.coefficientOfVariation &&
    summary.medianAbsoluteDeviation === expected.medianAbsoluteDeviation
  );
}

function metricSummarySetsEqual(
  actual: readonly MetricSummary[],
  expected: readonly MetricSummary[],
): boolean {
  if (actual.length !== expected.length) return false;
  const expectedByKey = new Map(expected.map((metric) => [metricKey(metric), metric]));
  if (expectedByKey.size !== expected.length) return false;
  for (const metric of actual) {
    const expectedMetric = expectedByKey.get(metricKey(metric));
    if (
      expectedMetric === undefined ||
      metric.name !== expectedMetric.name ||
      metric.value !== expectedMetric.value ||
      metric.unit !== expectedMetric.unit ||
      metric.direction !== expectedMetric.direction ||
      metric.percentile !== expectedMetric.percentile ||
      metric.sampleSize !== expectedMetric.sampleSize ||
      !sameNumberArray(metric.samples, expectedMetric.samples) ||
      !sampleSummaryEquals(metric.summary, metric.samples)
    ) {
      return false;
    }
  }
  return true;
}

function sameNumberArray(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function uniqueBy<T>(values: readonly T[], key: (value: T) => string): boolean {
  const keys = new Set(values.map(key));
  return keys.size === values.length;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function captureOutput(stream: ReadableStream<Uint8Array>, limitBytes: number): OutputCapture {
  const reader = stream.getReader();
  // Store bytes in one fixed-capacity buffer. Besides enforcing the byte cap,
  // this prevents adversarial tiny writes from creating O(chunk-count) strings
  // or abort callbacks in the harness itself.
  const retainedOutput = new Uint8Array(limitBytes);
  let retainedBytes = 0;
  let truncated = false;
  let aborted = false;
  let settled = false;
  let resolveCapture = (_value: string): void => {};
  let rejectCapture = (_error: unknown): void => {};
  const promise = new Promise<string>((resolve, reject) => {
    resolveCapture = resolve;
    rejectCapture = reject;
  });

  const finish = (value: string): void => {
    if (settled) return;
    settled = true;
    resolveCapture(value);
  };
  const fail = (error: unknown): void => {
    if (settled) return;
    settled = true;
    rejectCapture(error);
  };
  const render = (includeAbortMarker: boolean): string => {
    let output = new TextDecoder().decode(retainedOutput.subarray(0, retainedBytes));
    if (truncated) output += `\n[output truncated after ${limitBytes} bytes]\n`;
    if (includeAbortMarker) output += `\n${OUTPUT_DRAIN_ABORTED_MARKER}\n`;
    return output;
  };

  void (async () => {
    try {
      while (true) {
        const next = await reader.read();
        if (aborted) return;
        if (next.done) break;
        if (retainedBytes < limitBytes) {
          const retained = next.value.subarray(0, limitBytes - retainedBytes);
          retainedOutput.set(retained, retainedBytes);
          retainedBytes += retained.byteLength;
          if (retained.byteLength < next.value.byteLength) truncated = true;
        } else {
          truncated = true;
        }
      }
      finish(render(false));
    } catch (error) {
      if (!aborted) fail(error);
    }
  })();

  return {
    promise,
    abort(): void {
      if (settled) return;
      aborted = true;
      // Resolve the capture independently, then request best-effort stream
      // cancellation. Even a broken cancellation implementation cannot wedge
      // the harness or retain one callback per discarded output chunk.
      finish(render(true));
      void reader.cancel(OUTPUT_DRAIN_ABORTED_MARKER).catch(() => {});
    },
  };
}
