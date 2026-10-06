import { describe, expect, test } from 'bun:test';

import {
  aggregateMetrics,
  compareProfileReports,
  findVarianceViolations,
  isProfileReport,
  PERF_METRIC_PREFIX,
  PERF_REPORT_SCHEMA_VERSION,
  type PerfMetric,
  type ProfileReport,
  type ProfileRun,
  parsePerfMetrics,
  runProfileCommand,
  summarizeSamples,
} from './harness';

const LOWER_METRIC: PerfMetric = {
  name: 'latency',
  value: 10,
  unit: 'ms',
  direction: 'lower',
  percentile: 0.95,
};

describe('performance harness statistics', () => {
  test('uses nearest-rank percentiles without the off-by-one tail bias', () => {
    const summary = summarizeSamples(Array.from({ length: 100 }, (_, index) => index + 1));

    expect(summary.median).toBe(50);
    expect(summary.p90).toBe(90);
    expect(summary.p95).toBe(95);
    expect(summary.p99).toBe(99);
  });

  test('rejects empty and non-finite sample sets', () => {
    expect(() => summarizeSamples([])).toThrow('empty sample');
    expect(() => summarizeSamples([1, Number.NaN])).toThrow('finite');
  });

  test('does not hide variance when a varying signal has a zero mean', () => {
    const summary = summarizeSamples([-1, 1]);

    expect(summary.mean).toBe(0);
    expect(summary.standardDeviation).toBe(1);
    expect(summary.coefficientOfVariation).toBe(Number.MAX_VALUE);
  });

  test('parses only explicitly framed metrics', () => {
    const output = [
      'ordinary benchmark output',
      `${PERF_METRIC_PREFIX}${JSON.stringify(LOWER_METRIC)}`,
      '',
    ].join('\n');

    expect(parsePerfMetrics(output)).toEqual([LOWER_METRIC]);
  });

  test('rejects duplicate metrics from one run', () => {
    expect(() => aggregateMetrics([run([LOWER_METRIC, LOWER_METRIC])])).toThrow('duplicate metric');
  });

  test('rejects missing or inconsistent metrics between repetitions', () => {
    const throughput: PerfMetric = {
      name: 'throughput',
      value: 100,
      unit: 'ops/s',
      direction: 'higher',
      sampleSize: 10,
    };

    expect(() => aggregateMetrics([run([LOWER_METRIC, throughput]), run([LOWER_METRIC])])).toThrow(
      'inconsistent metrics',
    );
    expect(() =>
      aggregateMetrics([run([throughput]), run([{ ...throughput, direction: 'lower' as const }])]),
    ).toThrow('metadata');
  });

  test('detects lower-is-better and higher-is-better regressions', () => {
    const baseline = report([
      metricSummary(LOWER_METRIC, 10),
      metricSummary({ name: 'throughput', value: 100, unit: 'ops/s', direction: 'higher' }, 100),
    ]);
    const current = report([
      metricSummary({ ...LOWER_METRIC, value: 12 }, 12),
      metricSummary({ name: 'throughput', value: 80, unit: 'ops/s', direction: 'higher' }, 80),
    ]);

    const comparisons = compareProfileReports(current, baseline, 0.1);
    const internalComparisons = comparisons.filter(
      (comparison) => comparison.metric === LOWER_METRIC.name || comparison.metric === 'throughput',
    );

    expect(comparisons).toHaveLength(5);
    expect(internalComparisons).toHaveLength(2);
    expect(internalComparisons.every((comparison) => comparison.regression)).toBe(true);
    expect(
      comparisons
        .filter((comparison) => comparison.metric.startsWith('process-'))
        .every((comparison) => !comparison.regression),
    ).toBe(true);
  });

  test('gates process wall, CPU, and maximum RSS regressions', () => {
    const baseline = report([]);
    const baselineWorkload = baseline.workloads[0];
    if (baselineWorkload === undefined) throw new Error('baseline workload missing');
    const baselineRun = baselineWorkload.runs[0];
    if (baselineRun === undefined) throw new Error('baseline run missing');
    const currentRun = {
      ...baselineRun,
      wallMs: 1.2,
      cpuUserMs: 1.3,
      cpuSystemMs: 0,
      maxRssBytes: 1.4,
    };
    const current: ProfileReport = {
      ...baseline,
      workloads: [
        {
          ...baselineWorkload,
          runs: [currentRun],
          wallMs: summarizeSamples([1.2]),
          cpuMs: summarizeSamples([1.3]),
          maxRssBytes: summarizeSamples([1.4]),
        },
      ],
    };

    const comparisons = compareProfileReports(current, baseline, 0.1);

    expect(comparisons.map((comparison) => comparison.metric)).toEqual([
      'process-wall-p50',
      'process-cpu-p50',
      'process-max-rss',
    ]);
    expect(comparisons.every((comparison) => comparison.regression)).toBe(true);
  });

  test('keeps diagnostic process measurements out of regression and variance gates', () => {
    const baseline = report([]);
    const baselineWorkload = baseline.workloads[0];
    if (baselineWorkload === undefined) throw new Error('baseline workload missing');
    const runs = [
      { ...run([]), wallMs: 1, cpuUserMs: 1, maxRssBytes: 1 },
      { ...run([]), wallMs: 100, cpuUserMs: 100, maxRssBytes: 100 },
    ];
    const diagnostic: ProfileReport = {
      ...baseline,
      workloads: [
        {
          ...baselineWorkload,
          processMetrics: 'diagnostic',
          repetitions: 2,
          runs,
          wallMs: summarizeSamples(runs.map((item) => item.wallMs)),
          cpuMs: summarizeSamples(runs.map((item) => item.cpuUserMs + item.cpuSystemMs)),
          maxRssBytes: summarizeSamples(runs.map((item) => item.maxRssBytes)),
        },
      ],
    };

    expect(compareProfileReports(diagnostic, diagnostic, 0)).toEqual([]);
    expect(findVarianceViolations(diagnostic, 0)).toEqual([]);
  });

  test('requires matching valid process metric policies', () => {
    const gated = report([]);
    const gatedWorkload = gated.workloads[0];
    if (gatedWorkload === undefined) throw new Error('gated workload missing');
    const diagnostic: ProfileReport = {
      ...gated,
      workloads: [{ ...gatedWorkload, processMetrics: 'diagnostic' }],
    };

    expect(isProfileReport(diagnostic)).toBe(true);
    expect(
      isProfileReport({
        ...gated,
        workloads: [{ ...gatedWorkload, processMetrics: 'invalid' }],
      }),
    ).toBe(false);
    expect(() => compareProfileReports(diagnostic, gated, 0.1)).toThrow(
      'process metric policy changed',
    );
  });

  test('preserves improvement and regression direction around a zero baseline', () => {
    const baseline = report([
      metricSummary({ name: 'signed', value: 0, unit: 'score', direction: 'higher' }, 0),
    ]);
    const improved = report([
      metricSummary({ name: 'signed', value: 1, unit: 'score', direction: 'higher' }, 1),
    ]);
    const regressed = report([
      metricSummary({ name: 'signed', value: -1, unit: 'score', direction: 'higher' }, -1),
    ]);

    expect(
      compareProfileReports(improved, baseline, 0.1).find(
        (comparison) => comparison.metric === 'signed',
      )?.regression,
    ).toBe(false);
    expect(
      compareProfileReports(regressed, baseline, 0.1).find(
        (comparison) => comparison.metric === 'signed',
      )?.regression,
    ).toBe(true);
  });

  test('refuses to compare reports captured on different hardware', () => {
    const baseline = report([]);
    const current: ProfileReport = {
      ...baseline,
      platform: { ...baseline.platform, cpuModel: 'different CPU' },
    };

    expect(() => compareProfileReports(current, baseline, 0.1)).toThrow(
      'different hardware/platforms',
    );
  });

  test('requires exact workload and metric identity sets in both directions', () => {
    const baseline = report([metricSummary(LOWER_METRIC, 10)]);
    const workload = baseline.workloads[0];
    if (workload === undefined) throw new Error('workload missing');
    const baselineMetric = workload.metrics[0];
    if (baselineMetric === undefined) throw new Error('metric missing');
    const extraWorkload = {
      ...workload,
      service: 'extra',
    };
    const extraMetric = metricSummary(
      { name: 'extra', value: 1, unit: 'ops', direction: 'higher' },
      1,
    );
    const runWithExtra = run([LOWER_METRIC, extraMetric]);
    const workloadWithExtra = {
      ...workload,
      runs: [runWithExtra],
      metrics: [baselineMetric, extraMetric],
    };

    expect(() =>
      compareProfileReports(
        { ...baseline, workloads: [...baseline.workloads, extraWorkload] },
        baseline,
        0.1,
      ),
    ).toThrow('workload sets differ');
    expect(() =>
      compareProfileReports({ ...baseline, workloads: [workloadWithExtra] }, baseline, 0.1),
    ).toThrow('metric sets differ');
  });

  test('refuses incomplete or semantically different baseline comparisons', () => {
    const baseline = report([metricSummary(LOWER_METRIC, 10)]);
    const baselineWorkload = baseline.workloads[0];
    if (baselineWorkload === undefined) throw new Error('baseline workload missing');

    expect(() => compareProfileReports({ ...baseline, mode: 'different' }, baseline, 0.1)).toThrow(
      'different modes',
    );
    expect(() =>
      compareProfileReports(
        { ...baseline, platform: { ...baseline.platform, bun: 'different' } },
        baseline,
        0.1,
      ),
    ).toThrow('different hardware/platforms');
    expect(() => compareProfileReports({ ...baseline, workloads: [] }, baseline, 0.1)).toThrow(
      'workload sets differ',
    );
    expect(() =>
      compareProfileReports(
        {
          ...baseline,
          workloads: [
            {
              ...baselineWorkload,
              runs: baselineWorkload.runs.map((item) => ({ ...item, metrics: [] })),
              metrics: [],
            },
          ],
        },
        baseline,
        0.1,
      ),
    ).toThrow('metric sets differ');
    expect(() =>
      compareProfileReports(
        {
          ...baseline,
          workloads: [{ ...baselineWorkload, fidelity: 'model' }],
        },
        baseline,
        0.1,
      ),
    ).toThrow('fidelity changed');
    expect(() =>
      compareProfileReports(
        {
          ...baseline,
          workloads: [{ ...baselineWorkload, command: ['different'] }],
        },
        baseline,
        0.1,
      ),
    ).toThrow('command changed');
    expect(() =>
      compareProfileReports(
        {
          ...baseline,
          workloads: [
            {
              ...baselineWorkload,
              environmentOverrides: { BENCH_SIZE: 'different' },
            },
          ],
        },
        baseline,
        0.1,
      ),
    ).toThrow('environment changed');
    const metric = baselineWorkload.metrics[0];
    if (metric === undefined) throw new Error('baseline metric missing');
    expect(() =>
      compareProfileReports(
        {
          ...baseline,
          workloads: [
            {
              ...baselineWorkload,
              runs: baselineWorkload.runs.map((item) => ({
                ...item,
                metrics: item.metrics.map((runMetric) => ({
                  ...runMetric,
                  sampleSize: 99,
                })),
              })),
              metrics: [{ ...metric, sampleSize: 99 }],
            },
          ],
        },
        baseline,
        0.1,
      ),
    ).toThrow('sample size changed');
    expect(() =>
      compareProfileReports(
        {
          ...baseline,
          workloads: [{ ...baselineWorkload, warmups: baselineWorkload.warmups + 1 }],
        },
        baseline,
        0.1,
      ),
    ).toThrow('sampling configuration changed');
    expect(() =>
      compareProfileReports(
        baseline,
        {
          ...baseline,
          workloads: [{ ...baselineWorkload, errors: ['failed'], passed: false }],
        },
        0.1,
      ),
    ).toThrow('failed baseline workload');
    expect(() =>
      compareProfileReports(
        {
          ...baseline,
          workloads: [{ ...baselineWorkload, errors: ['failed'], passed: false }],
        },
        baseline,
        0.1,
      ),
    ).toThrow('failed current workload');
  });

  test('rejects incomplete or internally inconsistent baseline reports', () => {
    const valid = report([metricSummary(LOWER_METRIC, 10)]);
    const workload = valid.workloads[0];
    if (workload === undefined) throw new Error('workload missing');
    expect(isProfileReport(valid)).toBe(true);
    expect(
      isProfileReport({
        ...valid,
        platform: { os: 'test', arch: 'test', bun: 'test' },
      }),
    ).toBe(false);
    expect(
      isProfileReport({
        ...valid,
        workloads: [
          {
            ...workload,
            wallMs: { ...workload.wallMs, median: workload.wallMs.median + 1 },
          },
        ],
      }),
    ).toBe(false);
    const metric = workload.metrics[0];
    if (metric === undefined) throw new Error('metric missing');
    expect(
      isProfileReport({
        ...valid,
        workloads: [
          {
            ...workload,
            metrics: [{ ...metric, summary: { ...metric.summary, count: 99 } }],
          },
        ],
      }),
    ).toBe(false);
    expect(
      isProfileReport({
        ...valid,
        workloads: [{ ...workload, passed: false }],
      }),
    ).toBe(false);
    const metricWithInvalidSummary = {
      ...metric,
      summary: { ...metric.summary, median: metric.summary.median + 1 },
    };
    expect(
      isProfileReport({
        ...valid,
        workloads: [
          {
            ...workload,
            metrics: [metricWithInvalidSummary],
            errors: ['failed warmup'],
            passed: false,
          },
        ],
      }),
    ).toBe(false);
  });

  test('strict variance includes process wall, CPU, and RSS signals', () => {
    const valid = report([]);
    const workload = valid.workloads[0];
    if (workload === undefined) throw new Error('workload missing');
    const runs = [
      { ...run([]), wallMs: 1, cpuUserMs: 1, maxRssBytes: 1 },
      { ...run([]), wallMs: 10, cpuUserMs: 10, maxRssBytes: 10 },
    ];
    const repeated: ProfileReport = {
      ...valid,
      workloads: [
        {
          ...workload,
          repetitions: 2,
          runs,
          wallMs: summarizeSamples(runs.map((item) => item.wallMs)),
          cpuMs: summarizeSamples(runs.map((item) => item.cpuUserMs + item.cpuSystemMs)),
          maxRssBytes: summarizeSamples(runs.map((item) => item.maxRssBytes)),
        },
      ],
    };

    expect(findVarianceViolations(repeated, 0.1).map((item) => item.metric)).toEqual([
      'process-wall',
      'process-cpu',
      'process-max-rss',
    ]);
  });

  test('profiles a subprocess and normalizes native resource counters', async () => {
    const framedMetric = `${PERF_METRIC_PREFIX}${JSON.stringify(LOWER_METRIC)}\n`;
    const result = await runProfileCommand({
      command: ['bun', '-e', `process.stdout.write(${JSON.stringify(framedMetric)})`],
      cwd: import.meta.dir,
      timeoutMs: 5_000,
    });

    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.cpuUserMs).toBeGreaterThanOrEqual(0);
    expect(result.maxRssBytes).toBeGreaterThan(0);
    expect(result.metrics).toEqual([LOWER_METRIC]);
    expect(result.error).toBeNull();
  });

  test('keeps command output when a structured metric parser fails', async () => {
    const output = `${PERF_METRIC_PREFIX}{not-json}\n`;
    const result = await runProfileCommand({
      command: ['bun', '-e', `process.stdout.write(${JSON.stringify(output)})`],
      cwd: import.meta.dir,
      timeoutMs: 5_000,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(output);
    expect(result.metrics).toEqual([]);
    expect(result.error).toContain('metric parser failed');
  });

  test('times out a wedged command and drains bounded output without deadlocking', async () => {
    const timedOut = await runProfileCommand({
      command: ['bun', '-e', 'await Bun.sleep(60_000)'],
      cwd: import.meta.dir,
      timeoutMs: 25,
    });
    expect(timedOut.timedOut).toBe(true);
    expect(timedOut.exitCode).not.toBe(0);

    const bounded = await runProfileCommand({
      command: [
        'bun',
        '-e',
        [
          'const stdoutChunk = "o".repeat(1024);',
          'const stderrChunk = "e".repeat(1024);',
          'for (let index = 0; index < 8192; index += 1) process.stdout.write(stdoutChunk);',
          'for (let index = 0; index < 8192; index += 1) process.stderr.write(stderrChunk)',
        ].join(''),
      ],
      cwd: import.meta.dir,
      timeoutMs: 5_000,
      outputLimitBytes: 128,
    });
    expect(bounded.exitCode).toBe(0);
    expect(bounded.stdout).toContain('[output truncated after 128 bytes]');
    expect(bounded.stderr).toContain('[output truncated after 128 bytes]');
    expect(bounded.stdout.length).toBeLessThan(256);
    expect(bounded.stderr.length).toBeLessThan(256);

    if (process.platform !== 'win32') {
      const orphanedPipe = await runProfileCommand({
        command: [
          'bun',
          '-e',
          'const child = Bun.spawn(["bun", "-e", "await Bun.sleep(60000)"], { stdout: "inherit" }); child.unref()',
        ],
        cwd: import.meta.dir,
        timeoutMs: 5_000,
      });
      expect(orphanedPipe.exitCode).toBe(0);
      expect(orphanedPipe.timedOut).toBe(false);
      expect(orphanedPipe.wallMs).toBeLessThan(1_000);

      const ignoresTermination = await runProfileCommand({
        command: [
          'bun',
          '-e',
          [
            'const child = Bun.spawn(',
            '["bun", "-e", "process.on(\\"SIGTERM\\", () => {}); await Bun.sleep(60000)"],',
            '{ stdout: "inherit" });',
            'child.unref(); await Bun.sleep(100)',
          ].join(''),
        ],
        cwd: import.meta.dir,
        timeoutMs: 5_000,
      });
      expect(ignoresTermination.exitCode).toBe(0);
      expect(ignoresTermination.timedOut).toBe(false);
      expect(ignoresTermination.wallMs).toBeGreaterThanOrEqual(900);
      expect(ignoresTermination.wallMs).toBeLessThan(2_500);
    }
  });

  test('fails finitely when a new-session descendant escapes group cleanup with a pipe', async () => {
    if (process.platform === 'win32') return;

    const escaped = await runProfileCommand({
      command: [
        'bun',
        '-e',
        [
          'const child = Bun.spawn(',
          '["bun", "-e", "await Bun.sleep(60000)"],',
          '{ stdout: "inherit", stderr: "inherit", detached: true });',
          'process.stdout.write(String(child.pid) + "\\n"); child.unref()',
        ].join(''),
      ],
      cwd: import.meta.dir,
      timeoutMs: 5_000,
    });
    const escapedPid = Number(
      escaped.stdout.split(/\r?\n/).find((line) => /^\d+$/.test(line.trim())),
    );
    try {
      expect(escaped.exitCode).toBe(0);
      expect(escaped.timedOut).toBe(false);
      expect(escaped.error).toContain('output did not close');
      expect(escaped.stdout).toContain('[output drain aborted after child exit]');
      expect(escaped.wallMs).toBeLessThan(3_000);
    } finally {
      if (Number.isSafeInteger(escapedPid) && escapedPid > 0) {
        try {
          process.kill(-escapedPid, 'SIGKILL');
        } catch {
          try {
            process.kill(escapedPid, 'SIGKILL');
          } catch {
            // The child may observe the closed pipe and exit before cleanup.
          }
        }
      }
    }
  });
});

function run(metrics: readonly PerfMetric[]): ProfileRun {
  return {
    wallMs: 1,
    cpuUserMs: 1,
    cpuSystemMs: 0,
    maxRssBytes: 1,
    exitCode: 0,
    signalCode: null,
    timedOut: false,
    stdout: '',
    stderr: '',
    metrics,
    error: null,
  };
}

function metricSummary(metric: PerfMetric, median: number) {
  return {
    ...metric,
    samples: [median],
    summary: summarizeSamples([median]),
  };
}

function report(metrics: ReturnType<typeof metricSummary>[]): ProfileReport {
  return {
    schemaVersion: PERF_REPORT_SCHEMA_VERSION,
    generatedAt: '2026-01-01T00:00:00.000Z',
    mode: 'test',
    revision: null,
    dirty: null,
    environmentPolicy: 'sanitized-v1',
    platform: {
      os: 'test',
      osRelease: 'test',
      osVersion: 'test',
      arch: 'test',
      bun: 'test',
      cpuModel: 'test',
      logicalCpuCount: 1,
      totalMemoryBytes: 1,
      rustc: 'test',
      cargo: 'test',
      llvm: 'test',
      rustHost: 'test',
    },
    workloads: [
      {
        service: 'web',
        name: 'hot-path',
        fidelity: 'component',
        processMetrics: 'gated',
        command: ['test'],
        environmentOverrides: {},
        repetitions: 1,
        warmups: 0,
        timeoutMs: 1,
        runs: [run(metrics)],
        wallMs: summarizeSamples([1]),
        cpuMs: summarizeSamples([1]),
        maxRssBytes: summarizeSamples([1]),
        metrics,
        errors: [],
        passed: true,
      },
    ],
  };
}
