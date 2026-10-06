import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runTestProcess } from './test-process';
import { runVerificationCommand, stageTestTimings } from './verification-executor';

test('a run copies only the per-file durations Bun accepts, and Bun updates that copy', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'merkur-executor-timings-'));
  try {
    const published = path.join(root, 'test-timings.json');
    const run = path.join(root, 'run');
    mkdirSync(run);
    expect(existsSync(stageTestTimings(run, published))).toBe(false);
    for (const unusable of [
      '{"version":1,"files":{"a.test.ts":',
      '{}',
      '{"version":2,"files":{"a.test.ts":5}}',
      '{"version":1,"files":{"a.test.ts":"5"}}',
    ]) {
      writeFileSync(published, unusable);
      expect(existsSync(stageTestTimings(run, published))).toBe(false);
    }
    writeFileSync(
      path.join(root, 'a.test.ts'),
      "import {test} from 'bun:test';\ntest('a', () => {});\n",
    );
    writeFileSync(published, JSON.stringify({ version: 1, files: { 'a.test.ts': 5 } }));
    const staged = stageTestTimings(run, published);
    expect(readFileSync(staged, 'utf8')).toBe(readFileSync(published, 'utf8'));
    const result = await runTestProcess(
      [process.execPath, 'test', `--timings=${staged}`, '--update-timings', './a.test.ts'],
      { cwd: root },
    );
    expect(result.exitCode, result.stderr).toBe(0);
    const updated: unknown = JSON.parse(readFileSync(staged, 'utf8'));
    expect(updated).toMatchObject({ version: 1, files: { 'a.test.ts': expect.any(Number) } });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a piped verification child can spawn parallel test workers and nested subprocesses', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'merkur-executor-'));
  try {
    const file = path.join(root, 'spawn.test.ts');
    writeFileSync(
      file,
      `import {test,expect} from 'bun:test';\ntest('nested spawn',async()=>{const p=Bun.spawn([process.execPath,'-e','process.stdout.write("child-ok")'],{stdin:'ignore',stdout:'pipe',stderr:'pipe'});expect(await p.exited).toBe(0);expect(await new Response(p.stdout).text()).toBe('child-ok');});`,
    );
    const log = path.join(root, 'run.log');
    const result = await runVerificationCommand(['bun', 'test', '--parallel=2', file], log);
    expect(result.exitCode).toBe(0);
    expect(readFileSync(log, 'utf8')).toContain('1 pass');
    expect(readFileSync(log, 'utf8')).not.toContain('EBADF');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('failed child exit and diagnostic output remain visible in the task result', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'merkur-executor-'));
  try {
    const log = path.join(root, 'failure.log');
    const result = await runVerificationCommand(
      ['bun', '-e', 'process.stderr.write("owned-failure\\n");process.exit(7)'],
      log,
    );
    expect(result.exitCode).toBe(7);
    expect(readFileSync(log, 'utf8')).toContain('owned-failure');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a failed task is streamed before a stalled sibling; cancellation leaves later checks outstanding', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'merkur-executor-progress-'));
  const script = path.join(root, 'plan.ts');
  const executor = path.join(import.meta.dir, 'verification-executor.ts');
  const plan = {
    files: [],
    docsOnly: false,
    builds: [],
    preflight: [],
    reasons: [],
    static: [
      ['bun', '-e', 'process.stderr.write("early-failure\\n");process.exit(7)'],
      [
        'bun',
        '-e',
        'process.on("SIGTERM",()=>process.exit(0));process.stdout.write("sibling-ready\\n");setInterval(()=>{},1000)',
      ],
    ],
    cargo: [],
    bun: [['bun', '-e', 'process.stdout.write("MUST-NOT-START\\n")']],
    tests: [],
    bunInputs: [],
    deferred: [['bun', 'run', 'test:e2e']],
  };
  writeFileSync(
    script,
    `import {executePlan} from ${JSON.stringify(executor)}; process.exitCode = await executePlan(${JSON.stringify(plan)}, true);`,
  );
  const child = Bun.spawn([process.execPath, script], {
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const errors = new Response(child.stderr).text();
  let output = '';
  let interrupted = false;
  try {
    for await (const chunk of child.stdout) {
      output += new TextDecoder().decode(chunk);
      if (
        !interrupted &&
        output.includes('[FAIL]') &&
        output.split('\n').includes('sibling-ready')
      ) {
        interrupted = true;
        child.kill('SIGTERM');
      }
    }
    expect(interrupted).toBe(true);
    expect(await child.exited).toBe(130);
    expect(await errors).toContain('early-failure');
    // The label contains the source string; the executable's own output would be a bare line.
    expect(output.split('\n')).not.toContain('MUST-NOT-START');
    expect(output).toContain('[pending required] bun run test:e2e');
    expect(output).toContain('[verification] FAILED');
  } finally {
    if (child.exitCode === null) child.kill('SIGTERM');
    await child.exited;
    rmSync(root, { recursive: true, force: true });
  }
});

test('test files already green for their inputs never reach a worker', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'merkur-executor-cache-'));
  const script = path.join(root, 'plan.ts');
  const executor = path.join(import.meta.dir, 'verification-executor.ts');
  const plan = {
    files: ['apps/web/src/view.ts'],
    docsOnly: false,
    builds: [],
    preflight: [],
    reasons: [],
    static: [],
    cargo: [],
    // Shaped like a real bun lane: the cache narrows this command, it does not skip lanes.
    bun: [['bun', 'test', '--parallel=4', './proven.test.ts']],
    tests: ['proven.test.ts'],
    bunInputs: ['apps/web/src/view.ts'],
    deferred: [],
  };
  try {
    writeFileSync(
      script,
      `import {executePlan} from ${JSON.stringify(executor)};
       const cache = {fresh: [], cached: ['proven.test.ts'], keys: new Map(), unclaimed: []};
       process.exitCode = await executePlan(${JSON.stringify(plan)}, false, cache);`,
    );
    const { exitCode, stdout } = await runTestProcess([process.execPath, script]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('[cache] 1 test file already green for these inputs; 0 to run');
    // The lane is gone, not merely passing: no worker was started for a proven file.
    expect(stdout).not.toContain('proven.test.ts');
    const directory = /— (.+)\/report\.json/.exec(stdout)?.[1];
    if (directory === undefined) throw new Error(`No report path in:\n${stdout}`);
    const report = JSON.parse(readFileSync(path.join(directory, 'report.json'), 'utf8'));
    expect(report.cache).toEqual({
      cached: ['proven.test.ts'],
      fresh: [],
      unclaimed: [],
      proven: [],
    });
    expect(report.results).toEqual([]);
    expect(report.complete).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
