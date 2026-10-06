import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  createBunProfileCapturePlan,
  createSanitizedProfileEnvironment,
  type ProfileOptions,
  profileWorkloads,
  validateWorkloadSpecs,
  type WorkloadSpec,
} from './profile-project';
import { runTestProcess } from './test-process';

describe('project profile workload registry', () => {
  test('lists a valid registry with Criterion parsing only on Rust benchmarks', async () => {
    const { exitCode, stdout, stderr } = await runTestProcess(
      ['bun', 'run', 'scripts/profile-project.ts', '--mode=full', '--list'],
      { cwd: new URL('..', import.meta.url).pathname },
    );

    expect(exitCode, stderr).toBe(0);
    expect(stdout).toContain('web/session-crypto-startup\tbenchmark\tframed-or-none');
    expect(stdout).toContain('web/wasm-font-initialization\tbenchmark\tframed-or-none');
    expect(stdout).toContain('web/wasm-font-style-upgrade\tbenchmark\tframed-or-none');
    expect(stdout).toContain('web/webgpu-renderer-initialization\tbenchmark\tframed-or-none');
    expect(stdout).toContain('web/webgpu-renderer-render\tbenchmark\tframed-or-none');
    expect(stdout).toContain('web/terminal-row-layout-component\tbenchmark\tframed-or-none');
    expect(stdout).not.toContain('web/gpu-fence-scheduler\tbenchmark\tframed-or-none');
    expect(stdout).toContain('web/display-ack-ring\tbenchmark\tframed-or-none');
    expect(stdout).toContain('web/browser-display-production-pipeline\tbenchmark\tframed-or-none');
    expect(stdout).toContain('web/terminal-render-readers\tbenchmark\tframed-or-none');
    expect(stdout).toContain('web/terminal-wasm-multichunk-apply\tbenchmark\tframed-or-none');
    expect(stdout).toContain('dataplane/display-production-pipeline\tbenchmark\tframed-or-none');
    expect(stdout).toContain('dataplane/edge-reliable-ingress\tbenchmark\tframed-or-none');
    expect(stdout).toContain('dataplane/edge-reliable-writer\tbenchmark\tframed-or-none');
    expect(stdout).toContain(
      'server/session-issuance-redis-transitions\tbenchmark\tframed-or-none',
    );
    expect(stdout).toContain('server/auth-continue-rate-limit\tbenchmark\tframed-or-none');
    expect(stdout).toContain('web/sse-incremental-parser\tbenchmark\tframed-or-none');
    expect(stdout).toContain('system/terminal-startup-e2e\tverification\tframed-or-none');
    expect(stdout).toContain('rust-libraries/terminal-codec\tbenchmark\tcriterion');
    expect(stdout).toContain('tooling/performance-harness-tests\tverification\tframed-or-none');
    expect(stdout).toContain('rust-libraries/tests\tverification\tframed-or-none');
    expect(stdout).not.toContain('rust-libraries/tests\tverification\tcriterion');
    expect(stdout).not.toContain('display-gap-scheduler');
    expect(stdout).toContain(
      'web/startup-font-assets\tbenchmark\tframed-or-none\trepetitions=1\twarmups=0',
    );
  });

  test('soak repeats Criterion and Rust verification workloads', async () => {
    const { exitCode, stdout, stderr } = await runTestProcess(
      ['bun', 'run', 'scripts/profile-project.ts', '--mode=soak', '--list'],
      { cwd: new URL('..', import.meta.url).pathname },
    );

    expect(exitCode, stderr).toBe(0);
    expect(stdout).toContain(
      'dataplane/display-zstd\tbenchmark\tcriterion\trepetitions=20\twarmups=0',
    );
    expect(stdout).toContain(
      'dataplane/edge-reliable-ingress\tbenchmark\tframed-or-none\trepetitions=20\twarmups=2',
    );
    expect(stdout).toContain(
      'rust-libraries/tests\tverification\tframed-or-none\trepetitions=3\twarmups=0',
    );
  });

  test('selects exact workloads with repeatable workload options', async () => {
    const { exitCode, stdout, stderr } = await runTestProcess(
      [
        'bun',
        'run',
        'scripts/profile-project.ts',
        '--mode=full',
        '--list',
        '--workload=web/display-ack-ring',
        '--workload=rust-libraries/terminal-codec',
      ],
      { cwd: new URL('..', import.meta.url).pathname },
    );

    expect(exitCode, stderr).toBe(0);
    expect(stdout.trim().split('\n')).toHaveLength(2);
    expect(stdout).toContain('web/display-ack-ring\tbenchmark\tframed-or-none');
    expect(stdout).toContain('rust-libraries/terminal-codec\tbenchmark\tcriterion');
    expect(stdout).not.toContain('web/session-crypto-startup');
  });

  test('rejects malformed, duplicate, and mode-incompatible workload selectors', async () => {
    const run = (...args: string[]) =>
      runTestProcess(['bun', 'run', 'scripts/profile-project.ts', '--list', ...args], {
        cwd: new URL('..', import.meta.url).pathname,
      });

    const malformed = await run('--workload=missing-separator');
    expect(malformed.exitCode).toBe(1);
    expect(malformed.stderr).toContain('invalid profile workload selector');

    const duplicate = await run(
      '--workload=web/display-ack-ring',
      '--workload=web/display-ack-ring',
    );
    expect(duplicate.exitCode).toBe(1);
    expect(duplicate.stderr).toContain('duplicate profile workload selector');

    const unavailable = await run('--mode=micro', '--workload=rust-libraries/terminal-codec');
    expect(unavailable.exitCode).toBe(1);
    expect(unavailable.stderr).toContain('unavailable in micro mode');
  });

  test('rejects Cargo package selectors whose value is another option', () => {
    const malformed: WorkloadSpec = {
      service: 'rust-libraries',
      name: 'malformed-package-list',
      fidelity: 'verification',
      kind: 'verification',
      command: ['cargo', 'test', '-p', 'merkur-codec', '-p', '-p', 'merkur-fec'],
      timeoutMs: 5_000,
    };

    expect(() => validateWorkloadSpecs([malformed])).toThrow(
      'Cargo package selector is missing its value',
    );
  });

  test('validates only Cargo package selectors before the benchmark argument separator', () => {
    const criterionArgument: WorkloadSpec = {
      service: 'rust-libraries',
      name: 'criterion-argument',
      fidelity: 'verification',
      kind: 'verification',
      command: ['cargo', 'test', '--locked', '-p', 'merkur-codec', '--', '-p', '--not-cargo'],
      timeoutMs: 5_000,
    };
    const emptyLongSelector: WorkloadSpec = {
      ...criterionArgument,
      name: 'empty-long-selector',
      command: ['cargo', 'test', '--package='],
    };

    expect(() => validateWorkloadSpecs([criterionArgument])).not.toThrow();
    expect(() => validateWorkloadSpecs([emptyLongSelector])).toThrow(
      'Cargo package selector is missing its value',
    );
  });

  test('rejects invalid commands, sampling, and colliding profiler artifact names', () => {
    const base: WorkloadSpec = {
      service: 'web',
      name: 'valid',
      fidelity: 'component',
      kind: 'benchmark',
      command: ['bun', '-e', 'void 0'],
      timeoutMs: 5_000,
    };

    expect(() => validateWorkloadSpecs([{ ...base, command: [] }])).toThrow('empty command');
    expect(() => validateWorkloadSpecs([{ ...base, timeoutMs: 0 }])).toThrow('invalid timeout');
    expect(() =>
      validateWorkloadSpecs([{ ...base, command: ['bun', 'run', 'scripts/bench-deleted.ts'] }]),
    ).toThrow('script is missing');
    expect(() =>
      validateWorkloadSpecs([
        { ...base, processMetrics: 'invalid' as WorkloadSpec['processMetrics'] },
      ]),
    ).toThrow('invalid process metric policy');
    expect(() => validateWorkloadSpecs([{ ...base, repetitions: 0 }])).toThrow(
      'invalid repetitions',
    );
    expect(() =>
      validateWorkloadSpecs([
        { ...base, service: 'web/a', name: 'worker' },
        { ...base, service: 'web-a', name: 'worker' },
      ]),
    ).toThrow('profiler artifact name collision');
  });

  test('sanitizes inherited benchmark/compiler knobs and records explicit overrides', () => {
    const cargoHome = mkdtempSync(path.join(tmpdir(), 'merkur-profile-cargo-'));
    const cargoBin = path.join(cargoHome, 'bin');
    mkdirSync(cargoBin);
    writeFileSync(path.join(cargoBin, process.platform === 'win32' ? 'cargo.exe' : 'cargo'), '');
    try {
      const environment = createSanitizedProfileEnvironment(
        { BENCH_ITERATIONS: '100' },
        {
          PATH: '/bin',
          CARGO_HOME: cargoHome,
          SECRET_TOKEN: 'preserved-but-never-reported',
          BENCH_ITERATIONS: '1',
          BENCH_SIZE: '999',
          RUSTFLAGS: '-Ctarget-cpu=native',
          CARGO_PROFILE_RELEASE_LTO: 'true',
          RUSTUP_TOOLCHAIN: 'nightly',
        },
      );

      expect(environment.PATH).toBe(`${cargoBin}${path.delimiter}/bin`);
      expect(
        createSanitizedProfileEnvironment(
          {},
          { PATH: '/bin', CARGO_HOME: path.join(cargoHome, 'absent') },
        ).PATH,
      ).toBe('/bin');
      expect(environment.SECRET_TOKEN).toBe('preserved-but-never-reported');
      expect(environment.BENCH_ITERATIONS).toBe('100');
      expect(environment.BENCH_SIZE).toBeUndefined();
      expect(environment.RUSTFLAGS).toBeUndefined();
      expect(environment.CARGO_PROFILE_RELEASE_LTO).toBeUndefined();
      expect(environment.RUSTUP_TOOLCHAIN).toBeUndefined();
    } finally {
      rmSync(cargoHome, { recursive: true, force: true });
    }
  });

  test('records parser failure and continues to later workloads in a partial report', async () => {
    const malformed: WorkloadSpec = {
      service: 'test',
      name: 'malformed-metric',
      fidelity: 'component',
      kind: 'benchmark',
      command: ['bun', '-e', 'console.log("@@merkur-perf {bad}")'],
      timeoutMs: 5_000,
      requireMetrics: true,
    };
    const metricLine =
      '@@merkur-perf ' +
      JSON.stringify({
        name: 'valid',
        value: 1,
        unit: 'ops/s',
        direction: 'higher',
      });
    const valid: WorkloadSpec = {
      service: 'test',
      name: 'valid-metric',
      fidelity: 'component',
      kind: 'benchmark',
      command: ['bun', '-e', `console.log(${JSON.stringify(metricLine)})`],
      timeoutMs: 5_000,
      requireMetrics: true,
    };
    const options: ProfileOptions = {
      mode: 'micro',
      workloadSelectors: [],
      repetitions: 2,
      warmups: 0,
      verificationRepetitions: 1,
      outputPath: path.join(import.meta.dir, 'unused-profile.json'),
      baselinePath: null,
      allowedRegressionRatio: 0.1,
      varianceLimit: 0.1,
      strictVariance: false,
      cpuProfile: false,
      heapProfile: false,
      list: false,
    };

    const reports = await profileWorkloads([malformed, valid], options);
    const report = reports[0];
    const laterReport = reports[1];
    if (report === undefined || laterReport === undefined) {
      throw new Error('expected both workload reports');
    }

    expect(report.runs).toHaveLength(2);
    expect(report.runs.every((run) => run.error?.includes('parser failed'))).toBe(true);
    expect(report.errors.length).toBeGreaterThanOrEqual(2);
    expect(report.metrics).toEqual([]);
    expect(report.passed).toBe(false);
    expect(laterReport.passed).toBe(true);
    expect(laterReport.metrics.map((metric) => metric.name)).toEqual(['valid']);
  });

  test('uses cwd-relative Bun profiler directories and exact non-duplicated suffixes', () => {
    const plan = createBunProfileCapturePlan(
      'web',
      'worker',
      path.join(import.meta.dir, '..', 'test-results', 'profile', 'latest.json'),
      true,
      true,
    );

    expect(path.isAbsolute(plan.directoryArgument)).toBe(false);
    expect(plan.flags).toContain('--cpu-prof-name=web-worker');
    expect(plan.flags).not.toContain('--cpu-prof-name=web-worker.cpuprofile');
    expect(plan.expectedArtifactPaths.map((item) => path.basename(item))).toEqual([
      'web-worker.cpuprofile',
      'web-worker.md',
      'web-worker.heapsnapshot',
    ]);
    expect(plan.expectedArtifactPaths.some((item) => item.includes('.cpuprofile.cpuprofile'))).toBe(
      false,
    );
    expect(plan.cleanupArtifactPaths).toEqual(plan.expectedArtifactPaths);
  });
});
