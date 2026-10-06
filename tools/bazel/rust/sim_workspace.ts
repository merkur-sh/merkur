/** Original simulator workspace recipe, separated from tool execution. */
import { copyFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  absoluteCargoPaths,
  manifestText,
  table,
} from '../../../scripts/generated-cargo-workspace';

export const SIMULATOR_RUST_FLAGS = ['--cfg', 'merkur_sim', '--cfg', 'tokio_unstable'];

export async function prepareSimulatorWorkspace(root: string, workspace: string): Promise<void> {
  const source = path.join(root, 'tools/sim');
  const production = table(Bun.TOML.parse(await readFile(path.join(root, 'Cargo.toml'), 'utf8')));
  const crate = table(
    absoluteCargoPaths(
      Bun.TOML.parse(await readFile(path.join(source, 'manifest.toml'), 'utf8')),
      source,
    ),
  );
  crate.package = {
    ...table(crate.package),
    autotests: false,
    build: path.join(source, 'build.rs'),
  };
  crate.test = (await readdir(path.join(source, 'tests')))
    .filter((name) => name.endsWith('.rs'))
    .sort()
    .map((name) => ({ name: name.slice(0, -3), path: path.join(source, 'tests', name) }));
  await mkdir(path.join(workspace, 'merkur-sim'), { recursive: true });
  await writeFile(
    path.join(workspace, 'Cargo.toml'),
    manifestText({
      workspace: {
        resolver: '3',
        members: ['merkur-sim'],
        lints: table(production.workspace).lints,
      },
      patch: absoluteCargoPaths(production.patch, root),
    }),
  );
  await writeFile(path.join(workspace, 'merkur-sim/Cargo.toml'), manifestText(crate));
  await copyFile(path.join(source, 'Cargo.lock'), path.join(workspace, 'Cargo.lock'));
}

if (import.meta.main) {
  const [root, workspace] = process.argv.slice(2);
  if (
    root === undefined ||
    workspace === undefined ||
    !path.isAbsolute(root) ||
    !path.isAbsolute(workspace)
  ) {
    throw new Error(
      'Simulator preparation requires absolute declared source and owned workspace directories',
    );
  }
  await prepareSimulatorWorkspace(root, workspace);
}
