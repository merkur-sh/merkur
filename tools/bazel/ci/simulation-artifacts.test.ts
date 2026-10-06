import { expect, test } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { simulationArtifactsMain, stageSimulationArtifacts } from './simulation-artifacts';

function fixture() {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'simulation CI retention ')));
  const temporaryRoot = path.join(root, 'owned temporary');
  const evidenceDirectory = path.join(temporaryRoot, 'merkur-verification-original');
  const diagnosticRoot = path.join(evidenceDirectory, 'simulation-host');
  const member =
    'target-%2F%2Ftools%2Fsim%3Atest/configuration-native/run-1-shard-1-attempt-1/simulation/scenarios.log';
  const outputRoot = path.join(root, 'upload');
  const reportFile = path.join(root, 'controller.json');
  mkdirSync(path.dirname(path.join(diagnosticRoot, member)), { recursive: true });
  writeFileSync(path.join(diagnosticRoot, member), 'original stdout\noriginal stderr\n');
  const report = {
    currentAccepted: true,
    evidenceDirectory,
    simulationDiagnostics: [{ root: diagnosticRoot, files: [member], problems: [] as string[] }],
  };
  const publish = () => writeFileSync(reportFile, JSON.stringify(report));
  const run = () => {
    publish();
    return stageSimulationArtifacts({ reportFile, temporaryRoot, outputRoot });
  };
  return {
    root,
    temporaryRoot,
    evidenceDirectory,
    diagnosticRoot,
    member,
    outputRoot,
    reportFile,
    report,
    publish,
    run,
    close: () => rmSync(root, { recursive: true, force: true }),
  };
}

for (const phase of ['success', 'failure', 'cancel'] as const) {
  test(`diagnostic helper CLI retains reported ${phase} Files after original storage cleanup`, async () => {
    const config = process.env.MERKUR_BUN_TEST_CONFIG;
    if (config === undefined) throw new Error('Declared neutral Bun configuration is required');
    const setup = fixture();
    try {
      setup.report.currentAccepted = phase === 'success';
      if (phase !== 'success')
        setup.report.simulationDiagnostics[0]?.problems.push(`Original ${phase} run`);
      setup.publish();
      writeFileSync(path.join(setup.diagnosticRoot, 'unreported.log'), 'do not copy');
      const child = Bun.spawn(
        [
          process.execPath,
          '--no-install',
          '--no-env-file',
          `--config=${config}`,
          fileURLToPath(new URL('./simulation-artifacts.ts', import.meta.url)),
          '--report-file',
          setup.reportFile,
          '--temporary-root',
          setup.temporaryRoot,
          '--output-directory',
          setup.outputRoot,
        ],
        { env: { PATH: '', HOME: setup.root, TMPDIR: setup.root }, stdout: 'pipe', stderr: 'pipe' },
      );
      const [status, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(status).toBe(0);
      expect(stderr).toBe('');
      expect(stdout).toBe(`${setup.outputRoot}\n`);
      rmSync(setup.temporaryRoot, { recursive: true });
      const file = path.join(setup.outputRoot, 'simulation-host', setup.member);
      expect(readFileSync(file, 'utf8')).toBe('original stdout\noriginal stderr\n');
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(readdirSync(path.join(setup.outputRoot, 'simulation-host'))).toEqual([
        'target-%2F%2Ftools%2Fsim%3Atest',
      ]);
      expect(JSON.parse(readFileSync(setup.reportFile, 'utf8')).currentAccepted).toBe(
        phase === 'success',
      );
    } finally {
      setup.close();
    }
  });
}

test('all reported native roots preserve separate namespaces and empty diagnostics emit no invented File', async () => {
  const setup = fixture();
  try {
    const root = path.join(setup.evidenceDirectory, 'simulation-linux-x86_64');
    mkdirSync(path.dirname(path.join(root, setup.member)), { recursive: true });
    writeFileSync(path.join(root, setup.member), 'other native original');
    setup.report.simulationDiagnostics.push({ root, files: [setup.member], problems: [] });
    const files = await setup.run();
    expect(files).toHaveLength(2);
    expect(readFileSync(files[1] ?? '', 'utf8')).toBe('other native original');
    expect(Object.isFrozen(files)).toBe(true);
    rmSync(setup.outputRoot, { recursive: true });
    setup.report.simulationDiagnostics = [];
    expect(await setup.run()).toEqual([]);
    expect(readdirSync(setup.outputRoot)).toEqual([]);
  } finally {
    setup.close();
  }
});

for (const kind of [
  'traversal',
  'absolute',
  'control',
  'foreign-root',
  'foreign-evidence',
  'duplicate-root',
  'duplicate-file',
  'unknown-field',
  'directory',
  'file-alias',
  'parent-alias',
  'report-alias',
] as const) {
  test(`reported ${kind} refuses without archiving foreign Files`, async () => {
    const setup = fixture();
    try {
      const row = setup.report.simulationDiagnostics[0];
      if (row === undefined) throw new Error('Missing fixture diagnostic row');
      const foreign = path.join(setup.root, 'foreign');
      writeFileSync(foreign, 'preserve foreign bytes');
      if (kind === 'traversal') row.files = ['../../../../foreign'];
      else if (kind === 'absolute') row.files = [foreign];
      else if (kind === 'control') row.files = ['log\nforeign'];
      else if (kind === 'foreign-root') row.root = setup.root;
      else if (kind === 'foreign-evidence') setup.report.evidenceDirectory = setup.root;
      else if (kind === 'duplicate-root') setup.report.simulationDiagnostics.push({ ...row });
      else if (kind === 'duplicate-file') row.files.push(setup.member);
      else if (kind === 'unknown-field') Object.assign(row, { accepted: true });
      else if (kind === 'directory') {
        row.files = ['directory'];
        mkdirSync(path.join(setup.diagnosticRoot, 'directory'));
      } else if (kind === 'file-alias') {
        row.files = ['alias'];
        symlinkSync(foreign, path.join(setup.diagnosticRoot, 'alias'));
      } else if (kind === 'parent-alias') {
        row.files = ['parent/foreign'];
        symlinkSync(setup.root, path.join(setup.diagnosticRoot, 'parent'));
      }
      setup.publish();
      if (kind === 'report-alias') {
        const original = path.join(setup.root, 'original-report');
        writeFileSync(original, readFileSync(setup.reportFile));
        rmSync(setup.reportFile);
        symlinkSync(original, setup.reportFile);
      }
      await expect(
        stageSimulationArtifacts({
          reportFile: setup.reportFile,
          temporaryRoot: setup.temporaryRoot,
          outputRoot: setup.outputRoot,
        }),
      ).rejects.toThrow();
      expect(readFileSync(foreign, 'utf8')).toBe('preserve foreign bytes');
    } finally {
      setup.close();
    }
  });
}

test('missing reported File retires only earlier owned copies; source diagnostics and report are preserved', async () => {
  const setup = fixture();
  try {
    setup.report.simulationDiagnostics[0]?.files.push('missing.log');
    await expect(setup.run()).rejects.toThrow();
    expect(readdirSync(setup.outputRoot)).toEqual([]);
    expect(readFileSync(path.join(setup.diagnosticRoot, setup.member), 'utf8')).toContain(
      'original stdout',
    );
    expect(readFileSync(setup.reportFile, 'utf8')).toContain('simulationDiagnostics');
  } finally {
    setup.close();
  }
});

test('existing upload namespace and owned-temporary output cannot be overwritten or lost at cleanup', async () => {
  const setup = fixture();
  try {
    mkdirSync(setup.outputRoot);
    writeFileSync(path.join(setup.outputRoot, 'foreign'), 'preserve');
    await expect(setup.run()).rejects.toThrow();
    expect(readFileSync(path.join(setup.outputRoot, 'foreign'), 'utf8')).toBe('preserve');
    await expect(
      stageSimulationArtifacts({
        reportFile: setup.reportFile,
        temporaryRoot: setup.temporaryRoot,
        outputRoot: path.join(setup.temporaryRoot, 'unsafe-upload'),
      }),
    ).rejects.toThrow('survive');
  } finally {
    setup.close();
  }
});

test('malformed report inventory and ambiguous helper arguments refuse', async () => {
  const setup = fixture();
  try {
    for (const report of [
      {},
      { ...setup.report, simulationDiagnostics: {} },
      {
        ...setup.report,
        simulationDiagnostics: [{ root: setup.diagnosticRoot, files: [], problems: [true] }],
      },
    ]) {
      writeFileSync(setup.reportFile, JSON.stringify(report));
      await expect(
        stageSimulationArtifacts({
          reportFile: setup.reportFile,
          temporaryRoot: setup.temporaryRoot,
          outputRoot: setup.outputRoot,
        }),
      ).rejects.toThrow();
    }
    for (const args of [
      [],
      ['--report-file'],
      ['--unknown', '/tmp/a'],
      ['--report-file', '/tmp/a', '--report-file', '/tmp/b'],
    ])
      await expect(simulationArtifactsMain(args)).rejects.toThrow();
  } finally {
    setup.close();
  }
});

for (const name of [
  'bazel-assurance',
  'bazel-ci',
  'bazel-extended-ci',
  'bazel-release',
  'bazel-native-qualification',
  'bazel-dependency-audit',
]) {
  test(`${name} archives only the declared helper copies before storage cleanup`, () => {
    const source = readFileSync(
      new URL(`../../../.github/workflows/${name}.yml.in`, import.meta.url),
      'utf8',
    );
    const value = Bun.YAML.parse(source) as {
      jobs: Record<string, { steps?: Record<string, unknown>[] }>;
    };
    for (const job of Object.values(value.jobs)) {
      const steps = job.steps ?? [];
      const cleanup = steps.findIndex((step) => step.name === 'Retire the owned Bazel storage');
      if (cleanup === -1) continue;
      const copy = steps.findIndex((step) => step.id === 'simulation-artifacts');
      const upload = steps.findIndex(
        (step) => step.name === 'Retain reported original simulation attempt Files',
      );
      expect(copy).toBeGreaterThanOrEqual(0);
      expect(upload).toBeGreaterThan(copy);
      expect(cleanup).toBeGreaterThan(upload);
      const consumer = steps[copy];
      if (consumer === undefined) throw new Error('Missing concrete helper step');
      expect(consumer.if).toBe('always()');
      expect(String(consumer.run)).toContain('//tools/bazel/ci:simulation_artifacts --');
      expect(String(consumer.run)).toContain(
        '--report-file "$report" --temporary-root "$TMPDIR" --output-directory "$archive"',
      );
      expect(String(consumer.run)).toContain(
        '--ignore_all_rc_files --output_user_root="$BAZEL_OUTPUT_USER_ROOT"',
      );
      expect(String(consumer.run)).toContain(
        `TMPDIR="\${TMPDIR:?Missing owned Bazel temporary storage}"`,
      );
      const artifact = steps[upload];
      const contract = artifact?.with as Record<string, unknown>;
      expect(artifact?.if).toBe("always() && steps.simulation-artifacts.outputs.directory != ''");
      expect(contract.path).toBe(`\${{ steps.simulation-artifacts.outputs.directory }}`);
      expect(contract['if-no-files-found']).toBe('error');
      expect(contract['retention-days']).toBe(14);
    }
  });
}

test('a lexically external parent alias into owned TMPDIR refuses before cleanup can remove copies', async () => {
  const setup = fixture();
  try {
    setup.publish();
    const alias = path.join(setup.root, 'lexically external');
    symlinkSync(setup.temporaryRoot, alias);
    await expect(
      stageSimulationArtifacts({
        reportFile: setup.reportFile,
        temporaryRoot: setup.temporaryRoot,
        outputRoot: path.join(alias, 'fresh-upload'),
      }),
    ).rejects.toThrow('survive');
    expect(realpathSync(alias)).toBe(setup.temporaryRoot);
    expect(readFileSync(path.join(setup.diagnosticRoot, setup.member), 'utf8')).toContain(
      'original stdout',
    );
    expect(readdirSync(setup.temporaryRoot)).toEqual(['merkur-verification-original']);
  } finally {
    setup.close();
  }
});

test('a caller parent alias outside owned TMPDIR returns the actual surviving physical namespace', async () => {
  const setup = fixture();
  try {
    setup.publish();
    const parent = path.join(setup.root, 'physical upload parent');
    const alias = path.join(setup.root, 'caller upload parent');
    mkdirSync(parent);
    symlinkSync(parent, alias);
    const files = await stageSimulationArtifacts({
      reportFile: setup.reportFile,
      temporaryRoot: setup.temporaryRoot,
      outputRoot: path.join(alias, 'fresh-upload'),
    });
    const retained = path.join(parent, 'fresh-upload', 'simulation-host', setup.member);
    expect(files).toEqual([retained]);
    expect(realpathSync(alias)).toBe(parent);
    rmSync(setup.temporaryRoot, { recursive: true });
    expect(readFileSync(retained, 'utf8')).toContain('original stdout');
  } finally {
    setup.close();
  }
});
