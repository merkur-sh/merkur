import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runConcurrently } from './concurrent-commands';

function script(source: string): readonly string[] {
  return [process.execPath, '--no-install', '--no-env-file', '-e', source];
}

/** Announces itself, then ends only once its peer has announced itself too. */
function meets(own: string, peer: string): readonly string[] {
  return script(
    `const { existsSync, writeFileSync } = require('node:fs');
     writeFileSync(process.env.MEETING + '/${own}', '');
     while (!existsSync(process.env.MEETING + '/${peer}')) await Bun.sleep(5);
     process.stdout.write('${own} met ${peer}');`,
  );
}

/** Refuses to run while its lane's other command holds the marker, and holds it for a moment. */
function alone(name: string): readonly string[] {
  return script(
    `const { mkdirSync, rmdirSync } = require('node:fs');
     mkdirSync(process.env.MEETING + '/held');
     await Bun.sleep(50);
     rmdirSync(process.env.MEETING + '/held');
     process.stdout.write('${name} ran alone');`,
  );
}

test('lanes that need each other alive all end, answered in the order asked', () => {
  const meeting = mkdtempSync(path.join(os.tmpdir(), 'concurrent-commands-'));
  try {
    const results = runConcurrently({
      lanes: [[meets('first', 'second')], [meets('second', 'first')]],
      cwd: meeting,
      environment: { MEETING: meeting },
      timeoutMs: 30_000,
    });
    expect(results).toEqual([
      [{ exitCode: 0, signalCode: null, stdout: 'first met second', stderr: '' }],
      [{ exitCode: 0, signalCode: null, stdout: 'second met first', stderr: '' }],
    ]);
  } finally {
    rmSync(meeting, { recursive: true });
  }
});

test('the commands of one lane never overlap', () => {
  const meeting = mkdtempSync(path.join(os.tmpdir(), 'concurrent-commands-'));
  try {
    const results = runConcurrently({
      lanes: [[alone('first'), alone('second'), alone('third')]],
      cwd: meeting,
      environment: { MEETING: meeting },
      timeoutMs: 30_000,
    });
    expect(results).toEqual([
      ['first', 'second', 'third'].map((name) => ({
        exitCode: 0,
        signalCode: null,
        stdout: `${name} ran alone`,
        stderr: '',
      })),
    ]);
  } finally {
    rmSync(meeting, { recursive: true });
  }
});

test('each command keeps its own exit, output and deadline', () => {
  const results = runConcurrently({
    lanes: [
      [script(`process.stdout.write('refused'); process.stderr.write('why'); process.exit(3);`)],
      [script(`await Bun.sleep(60_000);`)],
      [
        script(
          `process.stdout.write(process.cwd() === process.env.EXPECTED ? 'here' : 'elsewhere');`,
        ),
      ],
    ],
    cwd: realpathSync(os.tmpdir()),
    environment: { EXPECTED: realpathSync(os.tmpdir()) },
    timeoutMs: 500,
  });
  expect(results[0]).toEqual([{ exitCode: 3, signalCode: null, stdout: 'refused', stderr: 'why' }]);
  expect(results[1]?.[0]?.exitCode).toBeNull();
  expect(results[1]?.[0]?.signalCode).toBe('SIGTERM');
  expect(results[2]).toEqual([{ exitCode: 0, signalCode: null, stdout: 'here', stderr: '' }]);
});

test('a malformed request is refused before anything runs', () => {
  for (const lanes of [[[[]]], [[]]])
    expect(() =>
      runConcurrently({ lanes, cwd: os.tmpdir(), environment: {}, timeoutMs: 1_000 }),
    ).toThrow('exact request');
});
