import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { cargoTestBuild, cargoTestExecutions } from './verification-cargo';

test('one feature-unified build retains whole-crate, filtered and ignored selections plus doctests', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'merkur-cargo-plan-'));
  const commands = [
    ['bun', 'run', 'rust:lint'],
    ['cargo', 'test', '--locked', '-p', 'library', '-p', 'edge'],
    [
      'cargo',
      'test',
      '--locked',
      '-p',
      'daemon',
      '--',
      'session::',
      '--skip',
      'live_edge_roundtrip',
    ],
    ['cargo', 'test', '--locked', '-p', 'daemon', '--', '--ignored', 'real_helper::'],
  ];
  try {
    const messages = ['library', 'edge', 'daemon'].map((name) => {
      const directory = path.join(root, name);
      mkdirSync(directory);
      writeFileSync(
        path.join(directory, 'Cargo.toml'),
        `[package]\nname = "${name}"\nversion = "0.1.0"\n`,
      );
      return {
        reason: 'compiler-artifact',
        manifest_path: path.join(directory, 'Cargo.toml'),
        profile: { test: true },
        target: { doctest: name === 'library' },
        filenames: [path.join(root, 'target/debug/deps', name)],
        executable: path.join(root, 'target/debug/deps', name),
      };
    });
    const output = [...messages, { reason: 'build-finished', success: true }]
      .map((message) => JSON.stringify(message))
      .join('\n');
    expect(cargoTestBuild(commands)).toEqual([
      'cargo',
      'test',
      '--locked',
      '--no-run',
      '--message-format=json',
      '-p',
      'daemon',
      '-p',
      'edge',
      '-p',
      'library',
    ]);
    const executions = cargoTestExecutions(output, commands, root, { TEST_MARKER: 'retained' });
    expect([...executions.values()].flat().map((task) => task.command)).toEqual([
      [path.join(root, 'target/debug/deps/library')],
      [path.join(root, 'target/debug/deps/edge')],
      ['cargo', 'test', '--locked', '--doc', '-p', 'daemon', '-p', 'edge', '-p', 'library'],
      [path.join(root, 'target/debug/deps/daemon'), 'session::', '--skip', 'live_edge_roundtrip'],
      [path.join(root, 'target/debug/deps/daemon'), '--ignored', 'real_helper::'],
    ]);
    const daemon = [...executions.values()]
      .flat()
      .find((task) => task.command.includes('session::'));
    expect(daemon?.cwd).toBe(path.join(root, 'daemon'));
    expect(daemon?.environment.CARGO_MANIFEST_DIR).toBe(path.join(root, 'daemon'));
    expect(daemon?.environment.TEST_MARKER).toBe('retained');
    expect(() =>
      cargoTestExecutions(output.replace('"success":true', '"success":false'), commands, root, {}),
    ).toThrow('completed build');
    expect(() =>
      cargoTestExecutions(output, [['cargo', 'test', '-p', 'missing']], root, {}),
    ).toThrow('no test executables');
    expect(() => cargoTestBuild([['cargo', 'test', '--workspace']])).toThrow('Unsupported');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
