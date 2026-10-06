import { expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { appendRegressions, readFailures, runSweep, sweepRange } from './sim_runner';

test('CLI retains failed seeds and regressions under an original source path containing spaces', async () => {
  const config = process.env.MERKUR_BUN_TEST_CONFIG;
  if (config === undefined) throw new Error('Declared neutral Bun configuration is required');
  const root = await mkdtemp(path.join(tmpdir(), 'merkur sim CLI control '));
  const runner = path.join(root, 'tools/bazel/rust/sim_runner.ts');
  const original = path.join(root, 'tools/sim/regressions.json');
  const harness = path.join(root, 'controlled-sweep');
  const output = path.join(root, 'retained outputs');
  try {
    await mkdir(path.dirname(runner), { recursive: true });
    await mkdir(path.dirname(original), { recursive: true });
    await writeFile(runner, await readFile(new URL('./sim_runner.ts', import.meta.url)));
    await writeFile(original, '[]\n');
    // This executable models only the original zero-exit sweep output contract.
    // It is never a configured simulator input or native qualification evidence.
    await writeFile(
      harness,
      `#!${process.execPath}\nconst file = process.env.MERKUR_SIM_SWEEP_FAILURES;\nif (!file) throw new Error('Missing sweep output');\nawait Bun.write(file, JSON.stringify([{seed:7000,failure:'original assertion\\ntrace'}]));\n`,
    );
    await chmod(harness, 0o700);
    const child = Bun.spawn(
      [
        process.execPath,
        '--no-install',
        '--no-env-file',
        `--config=${config}`,
        runner,
        'sweep',
        '1',
        '7000',
      ],
      {
        cwd: root,
        env: {
          PATH: '',
          HOME: root,
          TMPDIR: root,
          MERKUR_BUN_TEST_CONFIG: config,
          MERKUR_SIM_BINARY: harness,
          TEST_UNDECLARED_OUTPUTS_DIR: output,
        },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    const [exit, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(exit).toBe(1);
    expect(stdout).toContain('sweeping seeds 7000..7001');
    expect(stderr).toContain('1 of 1 seeds failed; recorded in declared regressions.json output');
    expect(stderr).not.toContain('ENOENT');
    expect(await readFile(original, 'utf8')).toBe('[]\n');
    expect(
      JSON.parse(await readFile(path.join(output, 'simulation/sweep-failures.json'), 'utf8')),
    ).toEqual([{ seed: 7000, failure: 'original assertion\ntrace' }]);
    const regressions = JSON.parse(
      await readFile(path.join(output, 'simulation/regressions.json'), 'utf8'),
    );
    expect(regressions[0]?.seed).toBe(7000);
    expect(regressions[0]?.failure).toBe('original assertion');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const mode of ['test', 'sweep'] as const) {
  for (const outcome of ['success', 'failure', 'cancel'] as const) {
    test(`CLI ${mode} retains both output streams and available ${outcome} artifacts`, async () => {
      const config = process.env.MERKUR_BUN_TEST_CONFIG;
      if (config === undefined) throw new Error('Declared neutral Bun configuration is required');
      const root = await mkdtemp(path.join(tmpdir(), 'merkur sim retention control '));
      const runner = path.join(root, 'tools/bazel/rust/sim_runner.ts');
      const original = path.join(root, 'tools/sim/regressions.json');
      const output = path.join(root, 'outputs');
      const harness = path.join(root, 'controlled-harness');
      const stdoutBytes = '\u0001'.repeat(172032);
      const stderrBytes = '\u0002'.repeat(172032);
      try {
        await mkdir(path.dirname(runner), { recursive: true });
        await mkdir(path.dirname(original), { recursive: true });
        await writeFile(runner, await readFile(new URL('./sim_runner.ts', import.meta.url)));
        await writeFile(original, '[]\n');
        const finish =
          outcome === 'cancel'
            ? `process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000); await Bun.write(Bun.stdout, 'READY\\n');`
            : mode === 'sweep'
              ? `await Bun.write(process.env.MERKUR_SIM_SWEEP_FAILURES, ${JSON.stringify(outcome === 'success' ? '[]' : '[{"seed":7000,"failure":"original seeded assertion"}]')});`
              : `process.exitCode = ${outcome === 'success' ? 0 : 17};`;
        // Controlled executable output only; this does not stand in for a native simulator graph.
        await writeFile(
          harness,
          `#!${process.execPath}\nawait Bun.write(Bun.stdout, ${JSON.stringify(stdoutBytes)});\nawait Bun.write(Bun.stderr, ${JSON.stringify(stderrBytes)});\n${finish}\n`,
        );
        await chmod(harness, 0o700);
        const child = Bun.spawn(
          [
            process.execPath,
            '--no-install',
            '--no-env-file',
            `--config=${config}`,
            runner,
            mode,
            ...(mode === 'sweep' ? ['1', '7000'] : []),
          ],
          {
            cwd: root,
            env: {
              PATH: '',
              HOME: root,
              TMPDIR: root,
              MERKUR_BUN_TEST_CONFIG: config,
              MERKUR_SIM_BINARY: harness,
              TEST_UNDECLARED_OUTPUTS_DIR: output,
            },
            stdout: 'pipe',
            stderr: 'pipe',
          },
        );
        const readStdout = async () => {
          let text = '';
          const decoder = new TextDecoder();
          for await (const chunk of child.stdout) {
            text += decoder.decode(chunk, { stream: true });
            if (outcome === 'cancel' && text.includes('READY\n')) child.kill('SIGTERM');
          }
          return text + decoder.decode();
        };
        const [exit, stdout, stderr] = await Promise.all([
          child.exited,
          readStdout(),
          new Response(child.stderr).text(),
        ]);
        expect(exit).toBe(outcome === 'success' ? 0 : 1);
        expect(stdout).toContain(stdoutBytes);
        expect(stderr).toContain(stderrBytes);
        const directory = path.join(output, 'simulation');
        const log = await readFile(
          path.join(directory, mode === 'test' ? 'scenarios.log' : 'sweep.log'),
          'utf8',
        );
        // Both pumps may interleave: count every unique fixture byte, not contiguous chunks.
        expect(log.split('\u0001').length - 1).toBe(stdoutBytes.length);
        expect(log.split('\u0002').length - 1).toBe(stderrBytes.length);
        expect(await readFile(original, 'utf8')).toBe('[]\n');
        if (mode === 'sweep') {
          const regressions = JSON.parse(
            await readFile(path.join(directory, 'regressions.json'), 'utf8'),
          );
          expect(regressions).toEqual(
            outcome === 'failure'
              ? [
                  {
                    seed: 7000,
                    failure: 'original seeded assertion',
                    found: new Date().toISOString().slice(0, 10),
                  },
                ]
              : [],
          );
          if (outcome !== 'cancel') {
            expect(
              JSON.parse(await readFile(path.join(directory, 'sweep-failures.json'), 'utf8')),
            ).toEqual(
              outcome === 'success' ? [] : [{ seed: 7000, failure: 'original seeded assertion' }],
            );
          } else {
            expect(log).toContain('READY\n');
            await expect(readFile(path.join(directory, 'sweep-failures.json'))).rejects.toThrow();
          }
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
}

test('original sweep range and exact failure identities', () => {
  expect(sweepRange('200', '7000')).toEqual({ start: 7000, count: 200 });
  for (const [count, start] of [
    ['0', '1'],
    ['2.5', '0'],
    ['2', '-1'],
    ['2', '9007199254740991'],
  ]) {
    expect(() => sweepRange(count ?? '', start ?? '')).toThrow();
  }
  expect(readFailures('[{"seed":7000,"failure":"assertion"}]', 7000, 200)).toEqual([
    { seed: 7000, failure: 'assertion' },
  ]);
  for (const raw of [
    '{}',
    '[{"seed":6999,"failure":"x"}]',
    '[{"seed":7200,"failure":"x"}]',
    '[{"seed":7000,"failure":1}]',
    '[{"seed":7000,"failure":"x"},{"seed":7000,"failure":"x"}]',
  ]) {
    expect(() => readFailures(raw, 7000, 200)).toThrow();
  }
});

test('original regressions are preserved, deduplicated and sorted', () => {
  const original = '[{"seed":9,"failure":"original","found":"2026-10-01"}]';
  expect(
    JSON.parse(
      appendRegressions(
        original,
        [
          { seed: 9, failure: 'replacement' },
          { seed: 7, failure: 'new\ntrace' },
        ],
        '2026-10-03',
      ),
    ),
  ).toEqual([
    { seed: 7, failure: 'new', found: '2026-10-03' },
    { seed: 9, failure: 'original', found: '2026-10-01' },
  ]);
});

test('a successful Rust exit with failed seeds is a failed sweep and never mutates source', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'merkur-sim-control-'));
  const source = path.join(root, 'original-regressions.json');
  await writeFile(source, '[]\n');
  try {
    await expect(
      runSweep({
        start: 7000,
        count: 200,
        output: path.join(root, 'outputs'),
        regressions: source,
        environment: { ORIGINAL: 'retained' },
        execute: async (args, environment) => {
          expect(args).toEqual([
            'sweep',
            '--ignored',
            '--exact',
            '--test-threads=1',
            '--nocapture',
          ]);
          expect(environment.MERKUR_SIM_SWEEP).toBe('7000,200');
          expect(environment.ORIGINAL).toBe('retained');
          const file = environment.MERKUR_SIM_SWEEP_FAILURES;
          if (file === undefined) throw new Error('Missing original failure file');
          await writeFile(file, '[{"seed":7012,"failure":"original assertion\\ntrace"}]');
        },
      }),
    ).rejects.toThrow('1 of 200 seeds failed');
    expect(await readFile(source, 'utf8')).toBe('[]\n');
    expect(
      JSON.parse(await readFile(path.join(root, 'outputs/simulation/regressions.json'), 'utf8'))[0]
        ?.seed,
    ).toBe(7012);
    expect(
      JSON.parse(
        await readFile(path.join(root, 'outputs/simulation/sweep-failures.json'), 'utf8'),
      )[0]?.failure,
    ).toBe('original assertion\ntrace');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('missing failure output cannot turn an interrupted or empty sweep into a pass', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'merkur-sim-control-'));
  const source = path.join(root, 'original-regressions.json');
  await writeFile(source, '[]\n');
  try {
    await expect(
      runSweep({
        start: 0,
        count: 1,
        output: path.join(root, 'outputs'),
        regressions: source,
        environment: {},
        execute: async () => {},
      }),
    ).rejects.toThrow();
    await expect(
      readFile(path.join(root, 'outputs/simulation/sweep-failures.json')),
    ).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('all successful original seeds retain the empty failure artifact', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'merkur-sim-control-'));
  const source = path.join(root, 'original-regressions.json');
  await writeFile(source, '[]\n');
  try {
    await runSweep({
      start: 0,
      count: 1,
      output: path.join(root, 'outputs'),
      regressions: source,
      environment: {},
      execute: async (_args, environment) => {
        const file = environment.MERKUR_SIM_SWEEP_FAILURES;
        if (file === undefined) throw new Error('Missing original failure file');
        await writeFile(file, '[]');
      },
    });
    expect(await readFile(path.join(root, 'outputs/simulation/sweep-failures.json'), 'utf8')).toBe(
      '[]',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
