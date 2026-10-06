import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Command } from './select-gates';

interface Selection {
  readonly command: Command;
  readonly packages: readonly string[];
  readonly args: readonly string[];
}

export function cargoTestSelection(command: Command): Selection | undefined {
  if (command[0] !== 'cargo' || command[1] !== 'test') return undefined;
  const packages: string[] = [];
  for (let i = 2; i < command.length; i++) {
    const arg = command[i];
    if (arg === '--') {
      if (packages.length === 0) throw new Error('Cargo test selection needs explicit packages');
      return { command, packages, args: command.slice(i + 1) };
    }
    if (arg === '--locked') continue;
    const name = command[i + 1];
    if (arg === '-p' && name !== undefined) {
      packages.push(name);
      i++;
      continue;
    }
    throw new Error(`Unsupported planned Cargo argument: ${arg}`);
  }
  if (packages.length === 0) throw new Error('Cargo test selection needs explicit packages');
  return { command, packages, args: [] };
}

export function cargoTestBuild(commands: readonly Command[]): Command | undefined {
  const packages = [
    ...new Set(commands.flatMap((command) => cargoTestSelection(command)?.packages ?? [])),
  ].sort();
  if (packages.length === 0) return undefined;
  return [
    'cargo',
    'test',
    '--locked',
    '--no-run',
    '--message-format=json',
    ...packages.flatMap((name) => ['-p', name]),
  ];
}

interface Artifact {
  readonly package: string;
  readonly cwd: string;
  readonly executable: string;
}

export interface CargoExecution {
  readonly command: Command;
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Executables come only from this successful Cargo build, never a target-directory glob. */
export function cargoTestExecutions(
  stdout: string,
  commands: readonly Command[],
  root: string,
  environment: NodeJS.ProcessEnv,
): Map<Command, CargoExecution[]> {
  const artifacts: Artifact[] = [];
  const libraryDirectories = new Set<string>();
  const docPackages = new Set<string>();
  const packageNames = new Map<string, string>();
  let finished = false;
  for (const line of stdout.split('\n')) {
    if (!line.startsWith('{')) continue;
    const message: unknown = JSON.parse(line);
    if (!object(message)) throw new Error('Invalid Cargo build message');
    if (message.reason === 'build-finished') finished = message.success === true;
    if (message.reason === 'build-script-executed' && Array.isArray(message.linked_paths)) {
      for (const directory of message.linked_paths) {
        if (typeof directory !== 'string') throw new Error('Invalid Cargo linked path');
        // Cargo emits [KIND=]PATH for native search paths.
        libraryDirectories.add(directory.slice(directory.indexOf('=') + 1));
      }
    }
    if (message.reason !== 'compiler-artifact') continue;
    if (
      !object(message.target) ||
      !object(message.profile) ||
      typeof message.manifest_path !== 'string'
    )
      throw new Error('Incomplete Cargo artifact');
    let name = packageNames.get(message.manifest_path);
    if (name === undefined) {
      const manifest = Bun.TOML.parse(readFileSync(message.manifest_path, 'utf8'));
      if (
        !object(manifest) ||
        !object(manifest.package) ||
        typeof manifest.package.name !== 'string'
      )
        throw new Error(`Missing package name: ${message.manifest_path}`);
      name = manifest.package.name;
      packageNames.set(message.manifest_path, name);
    }
    if (message.target.doctest === true) docPackages.add(name);
    if (Array.isArray(message.filenames)) {
      for (const file of message.filenames)
        if (typeof file === 'string') libraryDirectories.add(path.dirname(file));
    }
    if (message.profile.test === true && typeof message.executable === 'string') {
      artifacts.push({
        package: name,
        cwd: path.dirname(message.manifest_path),
        executable: message.executable,
      });
    }
  }
  if (!finished) throw new Error('Cargo did not report a successful completed build');
  const loader =
    process.platform === 'darwin'
      ? 'DYLD_FALLBACK_LIBRARY_PATH'
      : process.platform === 'win32'
        ? 'PATH'
        : 'LD_LIBRARY_PATH';
  const runtimeEnvironment = {
    ...environment,
    [loader]: [...libraryDirectories, ...(environment[loader]?.split(path.delimiter) ?? [])].join(
      path.delimiter,
    ),
  };
  const selections = commands.flatMap((command) => {
    const selection = cargoTestSelection(command);
    return selection === undefined ? [] : [selection];
  });
  const allPackages = [...new Set(selections.flatMap((selection) => selection.packages))].sort();
  const result = new Map<Command, CargoExecution[]>();
  for (const selection of selections) {
    const tasks: CargoExecution[] = [];
    for (const name of selection.packages) {
      const binaries = artifacts.filter((artifact) => artifact.package === name);
      if (binaries.length === 0) throw new Error(`Cargo emitted no test executables for ${name}`);
      for (const binary of binaries)
        tasks.push({
          command: [binary.executable, ...selection.args],
          cwd: binary.cwd,
          environment: { ...runtimeEnvironment, CARGO_MANIFEST_DIR: binary.cwd },
        });
    }
    result.set(selection.command, tasks);
  }
  // Keep rustdoc under Cargo, with the same package union so features stay unified.
  // The planner only filters the dataplane, whose library declares `doctest = false`;
  // library selections are whole-crate.
  const docs = selections.filter((selection) =>
    selection.packages.some((name) => docPackages.has(name)),
  );
  if (docs.some((selection) => selection.args.length > 0))
    throw new Error('Filtered library doctests need explicit planning');
  const owner = docs[0];
  if (owner !== undefined)
    result.get(owner.command)?.push({
      command: [
        'cargo',
        'test',
        '--locked',
        '--doc',
        ...allPackages.flatMap((name) => ['-p', name]),
      ],
      cwd: root,
      environment,
    });
  return result;
}
