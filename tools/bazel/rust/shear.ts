import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { TOML } from 'bun';

type RecordValue = Record<string, unknown>;
function record(value: unknown): RecordValue {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Expected a declared CargoShear object');
  }
  return value as RecordValue;
}
function text(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error('Expected nonempty text');
  return value;
}
function list(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error('Expected a declared CargoShear array');
  return value;
}
function sha(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
function member(value: unknown): string {
  const name = text(value);
  if (path.isAbsolute(name) || name.split('/').some((part) => ['', '.', '..'].includes(part))) {
    throw new Error('CargoShear input escapes the declared source tree');
  }
  return name;
}

const descriptorPath = process.argv[2];
const runfiles = process.argv[3];
if (!descriptorPath || !runfiles || process.argv.length !== 4) {
  throw new Error('Expected declared descriptor and runfiles root');
}
const descriptor = record(JSON.parse(readFileSync(descriptorPath, 'utf8')));
const sources = record(descriptor.sources);
const pieces = record(descriptor.pieces);
const authority = record(
  JSON.parse(readFileSync(path.join(runfiles, member(descriptor.authority)), 'utf8')),
);
if (
  JSON.stringify(authority.command) !==
  JSON.stringify(['metadata', '--offline', '--locked', '--all-features', '--format-version=1'])
) {
  throw new Error('CargoShear metadata has another resolver command');
}
const root = mkdtempSync(path.join(tmpdir(), 'merkur-shear-'));
try {
  for (const [logical, input] of Object.entries(sources)) {
    const destination = path.join(root, member(logical));
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(destination, readFileSync(path.join(runfiles, member(input))), {
      flag: 'wx',
      mode: 0o444,
    });
  }
  const rootManifest = record(TOML.parse(readFileSync(path.join(root, 'Cargo.toml'), 'utf8')));
  const workspace = record(rootManifest.workspace);
  const workspaceManifests = list(workspace.members).map((value) => {
    const directory = member(value);
    if (['?', '*', '['].some((character) => directory.includes(character)))
      throw new Error('Workspace membership needs Cargo glob expansion');
    return `${directory}/Cargo.toml`;
  });
  const packageManifests = new Set(workspaceManifests);
  for (const source of Object.values(record(rootManifest.patch ?? {}))) {
    for (const item of Object.values(record(source))) {
      const declaration = record(item);
      if (declaration.path !== undefined)
        packageManifests.add(`${member(declaration.path)}/Cargo.toml`);
    }
  }
  const inputHashes = record(authority.inputs);
  const required = [
    ...packageManifests,
    'Cargo.toml',
    'Cargo.lock',
    '.cargo/config.toml',
    'rust-toolchain.toml',
  ].sort();
  if (JSON.stringify(Object.keys(inputHashes).sort()) !== JSON.stringify(required)) {
    throw new Error('CargoShear metadata input membership differs from workspace declarations');
  }
  for (const [logical, expected] of Object.entries(inputHashes)) {
    if (sha(readFileSync(path.join(root, member(logical)))) !== text(expected)) {
      throw new Error(`Stale CargoShear resolution: ${logical}`);
    }
  }
  const parts = record(authority.parts);
  if (JSON.stringify(Object.keys(parts).sort()) !== JSON.stringify(Object.keys(pieces).sort())) {
    throw new Error('CargoShear metadata piece inventory differs');
  }
  const packages: unknown[] = [];
  let core: RecordValue | undefined;
  for (const name of Object.keys(pieces).sort()) {
    const bytes = readFileSync(path.join(runfiles, member(pieces[name])));
    if (sha(bytes) !== text(parts[name])) throw new Error('Changed CargoShear metadata piece');
    const value: unknown = JSON.parse(bytes.toString());
    if (name === 'core.json') core = record(value);
    else packages.push(...list(value));
  }
  if (!core) throw new Error('Missing CargoShear metadata core');
  const local = packages.map(record).filter((item) => item.source === null);
  const observed = local.map((item) => text(item.manifest_path).replace('@workspace@/', '')).sort();
  if (JSON.stringify(observed) !== JSON.stringify([...packageManifests].sort())) {
    throw new Error('CargoShear local metadata packages differ from declared manifests');
  }
  const expectedMembers = local
    .filter((item) =>
      workspaceManifests.includes(text(item.manifest_path).replace('@workspace@/', '')),
    )
    .map((item) => text(item.id))
    .sort();
  if (
    JSON.stringify(list(core.workspace_members).map(text).sort()) !==
    JSON.stringify(expectedMembers)
  ) {
    throw new Error('CargoShear workspace metadata member inventory differs');
  }
  // Upstream ignore::WalkBuilder only enables Git ignore files inside a repository.
  // This action owns an empty Git marker and the declared ignore files; no host Git state.
  mkdirSync(path.join(root, '.git'));
  const metadata = path.join(root, 'shear-metadata.json');
  const serialized = JSON.stringify({ ...core, packages })
    .replaceAll('@workspace@', root)
    .replaceAll('@registry@', path.join(root, 'registry'));
  writeFileSync(metadata, serialized, { flag: 'wx', mode: 0o444 });
  const result = Bun.spawnSync([path.join(runfiles, member(descriptor.analyzer)), metadata, root], {
    cwd: root,
    env: { PATH: '', HOME: root, LANG: 'C', LC_ALL: 'C' },
    stdin: 'ignore',
    stdout: 'inherit',
    stderr: 'inherit',
  });
  if (result.signalCode) throw new Error('CargoShear analyzer terminated by signal');
  process.exitCode = result.exitCode;
} finally {
  rmSync(root, { recursive: true, force: true });
}
