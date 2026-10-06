import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { openOwnedDirectory } from '../bun/owned-files';
import { BazelVerificationEngine } from './bazel-engine';
import { DeclaredEngineProcess } from './engine-process';
import { readBuildEvents } from './events';
import type { GitContext } from './git-context';
import { manifestFromInventory } from './snapshot';

// Synthetic command I/O and BEP exercise the public adapter's lifecycle. No Bazel,
// authenticated executor, native simulation, or fresh test admission is established.
const invocation = 'ed749ffe-d0b5-44d7-81a5-d291d1a21b45';
const label = '//tools/sim:test_sweep';
const configuration = 'synthetic-configured-simulation';
const members = [
  'simulation/sweep.log',
  'simulation/regressions.json',
  'simulation/sweep-failures.json',
];

function fixture() {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'engine simulation retention ')));
  const sourceRoot = path.join(root, 'source');
  const privateRoot = path.join(root, 'private-engine');
  const executionRoot = path.join(privateRoot, 'execution');
  const retainedRoot = path.join(root, 'retained');
  const sdk = path.join(root, 'sdk');
  for (const directory of [sourceRoot, executionRoot, retainedRoot, path.join(sdk, 'ssl')])
    mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(sdk, 'ssl', 'cert.pem'), 'synthetic constructor CA fixture\n');
  writeFileSync(path.join(sourceRoot, 'declared-source.txt'), 'original selected source\n');
  const directory = openOwnedDirectory(retainedRoot);
  const engine = new BazelVerificationEngine({
    signal: new AbortController().signal,
    root: sourceRoot,
    directory: privateRoot,
    tools: {
      bazel: path.join(root, 'declared-bazel'),
      acquisition: path.join(root, 'declared-acquisition.json'),
      git: path.join(sdk, 'bin', 'git'),
      credentialHelper: path.join(root, 'declared-credential-helper'),
      credentialFile: path.join(root, 'unread-private-credential-file'),
      runfiles: root,
      sdkEnvironment: { MERKUR_BAZEL_NATIVE_SDK_PREFIX: sdk },
    },
    admittedUntracked: [],
    all: false,
    diagnostics: { root: retainedRoot, directory },
  });
  const process = Reflect.get(engine, 'process');
  if (!(process instanceof DeclaredEngineProcess))
    throw new Error('Control must use the genuine constructed process instance');
  const required = [{ label, kind: 'test' as const, fresh: true }];
  const head = 'a'.repeat(40);
  const git: GitContext = {
    base: head,
    candidate: head,
    head,
    baseTree: head,
    candidateTree: head,
    index: [],
    untracked: [],
    committed: [],
    staged: [],
    unstaged: [],
    changed: [],
    digest: 'b'.repeat(64),
  };
  const request = {
    root: sourceRoot,
    invocation,
    required,
    git,
    source: manifestFromInventory(sourceRoot, ['declared-source.txt'], head),
  };
  expect(Reflect.set(engine, 'configurations', new Map([[label, configuration]]))).toBe(true);
  expect(
    Reflect.set(engine, 'simulationSelections', [{ label, configuration, mode: 'sweep' }]),
  ).toBe(true);
  const files = members.map((member, index) => {
    const file = path.join(executionRoot, `original output ${index}`);
    const bytes = Buffer.from(`${member}: original binary bytes\0\xff\n`);
    writeFileSync(file, bytes);
    return {
      member,
      file,
      bytes,
      bep: { name: `test.outputs/${member}`, uri: pathToFileURL(file).href },
    };
  });
  const started = {
    id: { started: {} },
    started: { uuid: invocation, buildToolVersion: '9.2.0' },
  };
  const attempt = (
    outputs: readonly unknown[] = files.map((file) => file.bep),
    status = 'PASSED',
  ) => ({
    id: {
      testResult: { label, configuration: { id: configuration }, run: 1, shard: 1, attempt: 1 },
    },
    testResult: { status, cachedLocally: false, testActionOutput: outputs },
  });
  const completed = {
    id: { targetCompleted: { label, configuration: { id: configuration } } },
    completed: { success: true },
  };
  const events = (rows: readonly unknown[]) => rows.map((row) => JSON.stringify(row)).join('\n');
  const complete = (outputs?: readonly unknown[], status = 'PASSED') =>
    events([
      started,
      completed,
      attempt(outputs, status),
      {
        id: { testSummary: { label, configuration: { id: configuration } } },
        testSummary: { overallStatus: status, totalRunCount: 1, totalNumCached: 0 },
      },
      {
        id: { buildFinished: {} },
        finished: { exitCode: { code: status === 'PASSED' ? 0 : 1 } },
        lastMessage: true,
      },
    ]);
  const calls: string[] = [];
  let testArgs: readonly string[] = [];
  let onTest = () => {
    writeFileSync(path.join(privateRoot, `${invocation}.bep.json`), complete());
    return { exitCode: 0, stdout: '', stderr: '' };
  };
  Object.defineProperty(process, 'run', {
    value: async (cwd: string, command: string, args: readonly string[]) => {
      expect(cwd).toBe(sourceRoot);
      calls.push(command);
      if (command === 'info') {
        expect(args[0]).toBe('execution_root');
        return { exitCode: 0, stdout: `${executionRoot}\n`, stderr: '' };
      }
      expect(command).toBe('test');
      expect(calls).toEqual(['info', 'test']);
      testArgs = [...args];
      return onTest();
    },
  });
  Object.defineProperty(process, 'close', {
    value: async () => {
      calls.push('close');
      // Model the private engine tree's cleanup using actual filesystem removal.
      // The retained owned output is an independent sibling outside that tree.
      rmSync(privateRoot, { recursive: true });
    },
  });
  function assertRetained(expected = files) {
    const diagnostics = engine.simulationDiagnostics();
    expect(diagnostics.root).toBe(retainedRoot);
    expect(diagnostics.files).toHaveLength(expected.length);
    for (const file of expected) {
      const relative = diagnostics.files.find((value) => value.endsWith(`/${file.member}`));
      if (relative === undefined) throw new Error('Expected original diagnostic not retained');
      expect(readFileSync(path.join(retainedRoot, relative))).toEqual(file.bytes);
    }
    directory.verifyCreated(retainedRoot);
  }
  return {
    engine,
    request,
    files,
    sourceRoot,
    executionRoot,
    privateRoot,
    retainedRoot,
    calls,
    started,
    completed,
    attempt,
    complete,
    events,
    setCommand(command: typeof onTest) {
      onTest = command;
    },
    writeEvents(text: string) {
      writeFileSync(path.join(privateRoot, `${invocation}.bep.json`), text);
    },
    assertRetained,
    args: () => testArgs,
    dispose() {
      directory.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('public execute retains successful original outputs before close and captures execution root before test', async () => {
  const setup = fixture();
  try {
    const result = await setup.engine.execute(setup.request);
    expect(result.exitCode).toBe(0);
    expect(readBuildEvents(result.events, setup.request.required).complete).toBe(true);
    expect(setup.args()).toContain('--nozip_undeclared_test_outputs');
    expect(setup.args()).toContain(`--invocation_id=${invocation}`);
    setup.assertRetained();
    await setup.engine.close();
    expect(setup.calls).toEqual(['info', 'test', 'close']);
    setup.assertRetained();
  } finally {
    setup.dispose();
  }
});

test('failed test diagnostics survive a malformed report before parser/configuration refusal', async () => {
  const setup = fixture();
  try {
    setup.setCommand(() => {
      setup.writeEvents(
        setup.events([
          setup.started,
          setup.completed,
          setup.completed,
          setup.attempt(undefined, 'FAILED'),
        ]),
      );
      return { exitCode: 1, stdout: '', stderr: '' };
    });
    const result = await setup.engine.execute(setup.request);
    const parsed = readBuildEvents(result.events, setup.request.required);
    expect(result.exitCode).toBe(1);
    expect(parsed.complete).toBe(false);
    expect(parsed.problems.some((problem) => problem.includes('Duplicate BEP event'))).toBe(true);
    setup.assertRetained();
    await setup.engine.close();
    setup.assertRetained();
  } finally {
    setup.dispose();
  }
});

test('malformed configured build result refuses only after original diagnostics are retained', async () => {
  const setup = fixture();
  try {
    setup.setCommand(() => {
      const foreignCompleted = {
        ...setup.completed,
        id: { targetCompleted: { label, configuration: { id: 'foreign-configured-result' } } },
      };
      setup.writeEvents(setup.events([setup.started, foreignCompleted, setup.attempt()]));
      return { exitCode: 1, stdout: '', stderr: '' };
    });
    await expect(setup.engine.execute(setup.request)).rejects.toThrow(
      'Executed check differs from planned target configuration',
    );
    setup.assertRetained();
    await setup.engine.close();
    setup.assertRetained();
  } finally {
    setup.dispose();
  }
});

test('cancellation after partial BEP retains all available ordinary Files and preserves both failures', async () => {
  const setup = fixture();
  const cancellation = new DOMException('synthetic command cancellation', 'AbortError');
  try {
    setup.setCommand(() => {
      const available = setup.files.slice(0, 1).map((file) => file.bep);
      setup.writeEvents(`${setup.events([setup.started, setup.attempt(available)])}\n{`);
      throw cancellation;
    });
    let failure: unknown;
    try {
      await setup.engine.execute(setup.request);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(AggregateError);
    if (!(failure instanceof AggregateError))
      throw new Error('Expected execution and retention failure');
    expect(failure.errors[0]).toBe(cancellation);
    expect(String(failure.errors[1])).toContain('Simulation diagnostics incomplete');
    expect(
      setup.engine
        .simulationDiagnostics()
        .problems.some((problem) => problem.includes('missing simulation output')),
    ).toBe(true);
    setup.assertRetained(setup.files.slice(0, 1));
    await setup.engine.close();
    setup.assertRetained(setup.files.slice(0, 1));
  } finally {
    setup.dispose();
  }
});

test('cancellation with complete diagnostic Files rethrows the original cancellation after retention', async () => {
  const setup = fixture();
  const cancellation = new DOMException('synthetic command cancellation', 'AbortError');
  try {
    setup.setCommand(() => {
      setup.writeEvents(setup.events([setup.started, setup.attempt()]));
      throw cancellation;
    });
    await expect(setup.engine.execute(setup.request)).rejects.toBe(cancellation);
    setup.assertRetained();
    await setup.engine.close();
    setup.assertRetained();
  } finally {
    setup.dispose();
  }
});

test('missing mandatory simulation File refuses process-zero fresh success and keeps known outputs', async () => {
  const setup = fixture();
  try {
    setup.setCommand(() => {
      setup.writeEvents(setup.complete(setup.files.slice(0, 2).map((file) => file.bep)));
      return { exitCode: 0, stdout: '', stderr: '' };
    });
    await expect(setup.engine.execute(setup.request)).rejects.toThrow('missing simulation output');
    expect(
      setup.engine.pending.some((problem) => problem.includes('missing simulation output')),
    ).toBe(true);
    setup.assertRetained(setup.files.slice(0, 2));
  } finally {
    setup.dispose();
  }
});

test('substituted output File digest refuses fresh success and retains unaffected original Files', async () => {
  const setup = fixture();
  try {
    setup.setCommand(() => {
      setup.writeEvents(
        setup.complete(
          setup.files.map((file, index) =>
            index === 0 ? { ...file.bep, digest: '0'.repeat(64) } : file.bep,
          ),
        ),
      );
      return { exitCode: 0, stdout: '', stderr: '' };
    });
    await expect(setup.engine.execute(setup.request)).rejects.toThrow('producing File facts');
    setup.assertRetained(setup.files.slice(1));
  } finally {
    setup.dispose();
  }
});

test('foreign physical output outside captured execution root refuses and never exports foreign bytes', async () => {
  const setup = fixture();
  try {
    const foreign = path.join(setup.sourceRoot, 'outside-output');
    writeFileSync(foreign, 'foreign ordinary File');
    setup.setCommand(() => {
      setup.writeEvents(
        setup.complete(
          setup.files.map((file, index) =>
            index === 0 ? { ...file.bep, uri: pathToFileURL(foreign).href } : file.bep,
          ),
        ),
      );
      return { exitCode: 0, stdout: '', stderr: '' };
    });
    await expect(setup.engine.execute(setup.request)).rejects.toThrow(
      'escapes its materialized execution root',
    );
    expect(readFileSync(foreign, 'utf8')).toBe('foreign ordinary File');
    setup.assertRetained(setup.files.slice(1));
  } finally {
    setup.dispose();
  }
});

test('changed admitted source refuses before execution-root capture or test dispatch', async () => {
  const setup = fixture();
  try {
    writeFileSync(path.join(setup.sourceRoot, 'declared-source.txt'), 'changed original source');
    await expect(setup.engine.execute(setup.request)).rejects.toThrow(
      'Frozen execution source differs',
    );
    expect(setup.calls).toEqual([]);
    expect(setup.engine.simulationDiagnostics().files).toEqual([]);
  } finally {
    setup.dispose();
  }
});
