import { expect, test } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { openOwnedDirectory } from '../bun/owned-files';
import { retainSimulationOutputs, type SimulationOutputSelection } from './simulation-outputs';

const invocation = 'b827d3fe-cd69-4c13-8b54-2cb234804a63';
const selection: SimulationOutputSelection = {
  label: '//tools/sim:test_sweep',
  configuration: 'configured-native-test',
  mode: 'sweep',
};
const sweepMembers = [
  'simulation/sweep.log',
  'simulation/regressions.json',
  'simulation/sweep-failures.json',
];

function fixture() {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'simulation diagnostics ')));
  const executionRoot = path.join(root, 'execution');
  const outputRoot = path.join(root, 'retained');
  mkdirSync(executionRoot);
  mkdirSync(outputRoot);
  const directory = openOwnedDirectory(outputRoot);
  const files = sweepMembers.map((member, index) => {
    // The physical File need not resemble its logical BEP output name.
    const file = path.join(executionRoot, `original output ${index}`);
    writeFileSync(file, `${member}: original bytes\n`);
    return { name: `test.outputs/${member}`, uri: pathToFileURL(file).href };
  });
  const started = {
    id: { started: {} },
    started: { uuid: invocation, buildToolVersion: '9.2.0' },
  };
  const result = (outputs: readonly unknown[] = files, extra: Record<string, unknown> = {}) => ({
    id: {
      testResult: {
        label: selection.label,
        configuration: { id: selection.configuration },
        run: 1,
        shard: 1,
        attempt: 1,
        ...extra,
      },
    },
    testResult: { status: 'FAILED', testActionOutput: outputs },
  });
  const events = (...rows: readonly unknown[]) => rows.map((row) => JSON.stringify(row)).join('\n');
  const run = (
    rows = [started, result()],
    overrides: Partial<Parameters<typeof retainSimulationOutputs>[0]> = {},
  ) =>
    retainSimulationOutputs({
      events: events(...rows),
      invocation,
      executionRoot,
      outputRoot,
      directory,
      selections: [selection],
      assertCurrent: () => {},
      ...overrides,
    });
  return {
    root,
    executionRoot,
    outputRoot,
    directory,
    files,
    started,
    result,
    events,
    run,
    close() {
      directory.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('failed TestRunner outputs retain exact original bytes without inventing File digests', async () => {
  const setup = fixture();
  try {
    const retained = await setup.run();
    expect(retained.problems).toEqual([]);
    expect(retained.files).toHaveLength(3);
    for (const [index, file] of retained.files.entries())
      expect(readFileSync(path.join(setup.outputRoot, file), 'utf8')).toBe(
        `${sweepMembers[index]}: original bytes\n`,
      );
    expect(retained).not.toHaveProperty('admitted');
    expect(retained).not.toHaveProperty('currentAccepted');
    expect(Object.isFrozen(retained.files)).toBe(true);
  } finally {
    setup.close();
  }
});

test('every retry and run retains a distinct original attempt namespace', async () => {
  const setup = fixture();
  try {
    const retained = await setup.run([
      setup.started,
      setup.result(),
      setup.result(setup.files, { attempt: 2 }),
      setup.result(setup.files, { run: 2 }),
    ]);
    expect(retained.problems).toEqual([]);
    expect(retained.files).toHaveLength(9);
    expect(new Set(retained.files).size).toBe(9);
    expect(retained.files.some((file) => file.includes('run-1-shard-1-attempt-2'))).toBe(true);
    expect(retained.files.some((file) => file.includes('run-2-shard-1-attempt-1'))).toBe(true);
  } finally {
    setup.close();
  }
});

test('a cancelled partial stream keeps available logs and reports missing sweep diagnostics', async () => {
  const setup = fixture();
  try {
    const retained = await setup.run([], {
      events: `${setup.events(setup.started, setup.result(setup.files.slice(0, 1)))}\n{"id":`,
    });
    expect(retained.files).toHaveLength(1);
    expect(retained.problems).toHaveLength(3);
    expect(retained.problems.join('\n')).toContain('incomplete or invalid build event');
    expect(retained.problems.join('\n')).toContain(
      'missing simulation output simulation/regressions.json',
    );
    expect(retained.problems.join('\n')).toContain(
      'missing simulation output simulation/sweep-failures.json',
    );
  } finally {
    setup.close();
  }
});

for (const kind of ['invocation', 'configuration', 'duplicate', 'attempt'] as const) {
  test(`ambiguous ${kind} refuses before any diagnostic File publication`, async () => {
    const setup = fixture();
    try {
      const rows = [setup.started, setup.result()];
      const overrides = kind === 'invocation' ? { invocation: 'another-invocation' } : {};
      if (kind === 'configuration')
        rows[1] = setup.result(setup.files, { configuration: { id: 'foreign' } });
      else if (kind === 'attempt') rows[1] = setup.result(setup.files, { attempt: 0 });
      else if (kind === 'duplicate') rows.push(setup.result());
      await expect(setup.run(rows, overrides)).rejects.toThrow();
      expect(() => setup.directory.readExisting('simulation/scenarios.log')).toThrow();
      setup.directory.verifyCreated(setup.outputRoot);
    } finally {
      setup.close();
    }
  });
}

test('replay retains scenario output and optional original regression input without requiring a sweep', async () => {
  const setup = fixture();
  try {
    const first = setup.files[0];
    if (first === undefined) throw new Error('Fixture File is absent');
    const retained = await setup.run(
      [setup.started, setup.result([{ ...first, name: 'test.outputs/simulation/scenarios.log' }])],
      { selections: [{ ...selection, mode: 'replay' }] },
    );
    expect(retained.problems).toEqual([]);
    expect(retained.files).toHaveLength(1);
    expect(retained.files[0]?.endsWith('/simulation/scenarios.log')).toBe(true);
  } finally {
    setup.close();
  }
});

for (const kind of [
  'remote',
  'outside',
  'symlink',
  'digest',
  'contents',
  'duplicate',
  'zip',
] as const) {
  test(`the actual File boundary refuses ${kind} simulation output and keeps other diagnostics`, async () => {
    const setup = fixture();
    try {
      const original = setup.files[0];
      if (original === undefined) throw new Error('Fixture File is absent');
      let first: Record<string, unknown> = { ...original };
      let outputs: Record<string, unknown>[] = [first, ...setup.files.slice(1)];
      if (kind === 'remote') first.uri = 'bytestream://remote.buildbuddy.io/blobs/digest/10';
      else if (kind === 'outside') {
        const outside = path.join(setup.root, 'outside');
        writeFileSync(outside, 'foreign bytes');
        first.uri = pathToFileURL(outside).href;
      } else if (kind === 'symlink') {
        const file = path.join(setup.executionRoot, 'alias');
        symlinkSync(path.join(setup.executionRoot, 'original output 0'), file);
        first.uri = pathToFileURL(file).href;
      } else if (kind === 'digest') first.digest = 'f'.repeat(64);
      else if (kind === 'contents')
        first.contents = Buffer.from('foreign bytes').toString('base64');
      else if (kind === 'duplicate') outputs.push({ ...original });
      else {
        first = { name: 'test.outputs__outputs.zip', uri: original.uri };
        outputs = [first, ...setup.files.slice(1)];
      }
      const retained = await setup.run([setup.started, setup.result(outputs)]);
      expect(retained.files).toHaveLength(2);
      expect(retained.problems.length).toBeGreaterThan(0);
      expect(retained.files.every((file) => !file.endsWith('/simulation/sweep.log'))).toBe(true);
    } finally {
      setup.close();
    }
  });
}

test('an unstarted selected test reports absent diagnostics rather than reading a guessed output path', async () => {
  const setup = fixture();
  try {
    const retained = await setup.run([setup.started]);
    expect(retained.files).toEqual([]);
    expect(retained.problems).toEqual([
      `${selection.label}: the selected simulation test has no reported attempt`,
    ]);
  } finally {
    setup.close();
  }
});

test('caller context changes stop retention without erasing already retained failed-run diagnostics', async () => {
  const setup = fixture();
  try {
    let calls = 0;
    await expect(
      setup.run(undefined, {
        assertCurrent: () => {
          if (++calls > 3) throw new Error('Original command context changed');
        },
      }),
    ).rejects.toThrow('Original command context changed');
    const member =
      `target-${encodeURIComponent(selection.label)}/` +
      `configuration-${selection.configuration}/run-1-shard-1-attempt-1/simulation/sweep.log`;
    expect(readFileSync(path.join(setup.outputRoot, member), 'utf8')).toContain('original bytes');
  } finally {
    setup.close();
  }
});

test('retained output root replacement is caught before the caller receives diagnostic custody', async () => {
  const setup = fixture();
  try {
    let calls = 0;
    await expect(
      setup.run(undefined, {
        assertCurrent: () => {
          if (++calls !== 8) return;
          renameSync(setup.outputRoot, path.join(setup.root, 'original retained'));
          mkdirSync(setup.outputRoot);
          writeFileSync(path.join(setup.outputRoot, 'foreign'), 'preserve foreign File');
        },
      }),
    ).rejects.toThrow('Owned publication root namespace changed');
    expect(readFileSync(path.join(setup.outputRoot, 'foreign'), 'utf8')).toBe(
      'preserve foreign File',
    );
  } finally {
    setup.close();
  }
});
