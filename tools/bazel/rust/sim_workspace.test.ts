import { expect, test } from 'bun:test';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { absoluteCargoPaths, table } from '../../../scripts/generated-cargo-workspace';
import { prepareSimulatorWorkspace, SIMULATOR_RUST_FLAGS } from './sim_workspace';

test('genuine original simulator recipe retains lock, dependencies, lints, patches and every harness', async () => {
  const root = path.resolve(import.meta.dir, '../../..');
  const output = await mkdtemp(path.join(tmpdir(), 'merkur-sim-workspace-control-'));
  const source = path.join(root, 'tools/sim');
  const originalLock = await readFile(path.join(source, 'Cargo.lock'));
  const productionLock = await readFile(path.join(root, 'Cargo.lock'));
  try {
    await prepareSimulatorWorkspace(root, output);
    const original = table(
      absoluteCargoPaths(
        Bun.TOML.parse(await readFile(path.join(source, 'manifest.toml'), 'utf8')),
        source,
      ),
    );
    const actual = table(
      Bun.TOML.parse(await readFile(path.join(output, 'merkur-sim/Cargo.toml'), 'utf8')),
    );
    expect(actual.dependencies).toEqual(original.dependencies);
    expect(actual.lib).toEqual(original.lib);
    expect(actual.lints).toEqual(original.lints);
    expect(actual.package).toEqual({
      ...table(original.package),
      autotests: false,
      build: path.join(source, 'build.rs'),
    });
    expect(actual.test).toEqual(
      (await readdir(path.join(source, 'tests')))
        .filter((name) => name.endsWith('.rs'))
        .sort()
        .map((name) => ({ name: name.slice(0, -3), path: path.join(source, 'tests', name) })),
    );
    const production = table(Bun.TOML.parse(await readFile(path.join(root, 'Cargo.toml'), 'utf8')));
    const workspace = table(
      Bun.TOML.parse(await readFile(path.join(output, 'Cargo.toml'), 'utf8')),
    );
    expect(workspace).toEqual({
      workspace: {
        resolver: '3',
        members: ['merkur-sim'],
        lints: table(production.workspace).lints,
      },
      patch: absoluteCargoPaths(production.patch, root),
    });
    expect(await readFile(path.join(output, 'Cargo.lock'))).toEqual(originalLock);
    expect(await readFile(path.join(source, 'Cargo.lock'))).toEqual(originalLock);
    expect(await readFile(path.join(root, 'Cargo.lock'))).toEqual(productionLock);
    expect(SIMULATOR_RUST_FLAGS).toEqual(['--cfg', 'merkur_sim', '--cfg', 'tokio_unstable']);
    expect(
      (await readFile(path.join(source, 'build.rs'), 'utf8')).includes(
        'cargo::rustc-link-arg=-Wl,--export-dynamic-symbol=getrandom',
      ),
    ).toBe(true);
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});
