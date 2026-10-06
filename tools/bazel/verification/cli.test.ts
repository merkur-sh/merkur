import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { verificationArguments } from './cli';

test('CLI rejects mutable identities, staged certification, conflicting selection and ambiguous admission', () => {
  for (const args of [
    ['--base', 'main'],
    ['--candidate', 'abc'],
    ['--staged', '--all'],
    ['--staged', '--changed'],
    ['--staged', '--base', 'a'.repeat(40)],
    ['--staged', '--admit-file', '/tmp/index.json'],
    ['--changed', '--all'],
    ['--changed', '--changed'],
    ['--force', '--force'],
    ['--native-platforms'],
    ['--native-platforms', '--all'],
    ['--executor-policy-file', '/tmp/policy.json'],
    ['--qualify-execution'],
    ['--assurance-event', 'push'],
    ['--assurance-event', 'push', '--all'],
    ['--assurance-event', 'push', '--ci-report-file', '/tmp/a'],
    ['--assurance-event', 'release', '--all', '--ci-report-file', '/tmp/a'],
    ['--unsigned-output-directory', '/tmp/unsigned'],
    ['--unsigned', '--all', '--ci-report-file', '/tmp/a'],
    ['--unsigned'],
    ['--unsigned', '--all'],
    ['--unsigned', '--all', '--ci-report-file', '/tmp/a', '--unsigned'],
    ['--unsigned', '--staged', '--ci-report-file', '/tmp/a'],
    ['--base'],
    ['--admit-file', 'relative.json'],
    ['--ledger-client', 'relative'],
    ['--credential-file', 'relative'],
    ['--credential-file', '/tmp/a', '--credential-file', '/tmp/b'],
    ['--ledger-client', '/tmp/a', '--ledger-client', '/tmp/b'],
    ['--report-file', 'relative.json'],
    ['--ci-report-file', 'relative.json'],
    ['--ci-report-file', '/tmp/a', '--ci-report-file', '/tmp/b'],
    ['--ci-report-file', '/tmp/a', '--report-file', '/tmp/sub/../a'],
    ['--ci-report-file', '/tmp/a', '--expected-context-file', '/tmp/sub/../a'],
    ['--report-file', '/tmp/a', '--report-file', '/tmp/b'],
    ['--expected-context-file', 'relative.json'],
    ['--expected-context-file', '/tmp/a', '--expected-context-file', '/tmp/b'],
    ['--expected-context-file', '/tmp/a', '--report-file', '/tmp/sub/../a'],
  ])
    expect(() => verificationArguments(args)).toThrow();
  expect(
    verificationArguments([
      '--all',
      '--native-platforms',
      '--executor-policy-file',
      '/tmp/policy.json',
    ]).nativePlatforms,
  ).toBe(true);
  expect(verificationArguments(['--staged']).staged).toBe(true);
  expect(
    verificationArguments([
      '--all',
      '--unsigned',
      '--ci-report-file',
      '/tmp/a',
      '--unsigned-output-directory',
      '/tmp/unsigned',
    ]).unsigned,
  ).toBe(true);
  expect(
    verificationArguments(['--changed', '--base', 'a'.repeat(40), '--candidate', 'b'.repeat(40)]),
  ).toEqual({
    all: false,
    force: false,
    help: false,
    base: 'a'.repeat(40),
    candidate: 'b'.repeat(40),
  });
});

test('CI assurance selection preserves each supported event in the complete controller batch', () => {
  for (const event of ['pull_request', 'push', 'schedule', 'workflow_dispatch']) {
    const options = verificationArguments([
      '--all',
      '--force',
      '--assurance-event',
      event,
      '--ci-report-file',
      '/tmp/assurance-ci.json',
    ]);
    expect(options.all).toBe(true);
    expect(options.force).toBe(true);
    expect(options.assuranceEvent).toBe(event);
    expect(options.ciReportFile).toBe('/tmp/assurance-ci.json');
  }
});

test('missing ledger authority refuses before any Git or engine process and preserves a caller report', () => {
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'merkur-verification-cli-control-'));
  const evidence: string[] = [];
  try {
    const reportFile = path.join(scratch, 'result.json');
    const ciReportFile = path.join(scratch, 'ci-result.json');
    const expectedContextFile = path.join(scratch, 'expected-context.json');
    function invoke(): ReturnType<typeof Bun.spawnSync> {
      return Bun.spawnSync(
        [
          process.execPath,
          '--no-install',
          '--no-env-file',
          `--config=${process.env.MERKUR_BUN_TEST_CONFIG}`,
          path.join(import.meta.dir, 'cli.ts'),
          '--force',
          '--report-file',
          reportFile,
          '--ci-report-file',
          ciReportFile,
          '--expected-context-file',
          expectedContextFile,
        ],
        {
          cwd: scratch,
          env: {
            HOME: scratch,
            PATH: scratch,
            TMPDIR: scratch,
            BUILD_WORKSPACE_DIRECTORY: import.meta.dir,
            MERKUR_VERIFICATION_BAZEL: path.join(scratch, 'missing-bazel'),
            MERKUR_VERIFICATION_BAZEL_ACQUISITION: path.join(scratch, 'missing-acquisition'),
            MERKUR_VERIFICATION_GIT: path.join(scratch, 'missing-git'),
            MERKUR_BAZEL_RUNFILES_ROOT: scratch,
            MERKUR_BAZEL_NATIVE_SDK_PREFIX: scratch,
          },
          stdout: 'pipe',
          stderr: 'pipe',
        },
      );
    }
    const result = invoke();
    expect(result.exitCode).toBe(1);
    const report = JSON.parse(readFileSync(reportFile, 'utf8'));
    expect(report.currentAccepted).toBe(false);
    expect(report.snapshotAccepted).toBe(false);
    expect(report.phase).toBe('blocked');
    expect(report.problem).toContain('authoritative bare ledger client');
    expect(report.evidence).toBeUndefined();
    const ci = JSON.parse(readFileSync(ciReportFile, 'utf8'));
    expect(ci.admitted).toBe(false);
    expect(ci.result.problem).toContain('authoritative bare ledger client');
    expect(ci.expectations).toBeUndefined();
    expect(ci.reports).toBeUndefined();
    const expected = JSON.parse(readFileSync(expectedContextFile, 'utf8'));
    expect(expected.phase).toBe('blocked');
    expect(expected.expectations).toEqual([]);
    expect(expected.problem).toContain('authoritative bare ledger client');
    evidence.push(report.evidenceDirectory);
    writeFileSync(reportFile, 'caller-owned\n');
    expect(invoke().exitCode).not.toBe(0);
    expect(readFileSync(reportFile, 'utf8')).toBe('caller-owned\n');
  } finally {
    for (const directory of evidence) rmSync(directory, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('the unit entry point accepts only its configured inventory selection and explicit controller arguments', () => {
  const options = verificationArguments([
    '--unit',
    '--force',
    '--ledger-client',
    '/tmp/authority.git',
    '--credential-file',
    '/tmp/backend',
    '--report-file',
    '/tmp/report',
  ]);
  expect(options.unit).toBe(true);
  expect(options.all).toBe(false);
  expect(options.force).toBe(true);
  expect(options.ledgerClient).toBe('/tmp/authority.git');
  expect(options.credentialFile).toBe('/tmp/backend');
  for (const args of [
    ['--unit'],
    ['--all'],
    ['--changed'],
    ['--staged'],
    ['--unsigned'],
    ['--native-platforms'],
    ['--extended-suites'],
    ['--extended-suite', 'test:natlab'],
    ['--assurance-event', 'push'],
  ])
    expect(() => verificationArguments(['--unit', ...args])).toThrow();
});
