import { expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { SIM_WORKSPACE } from './sim-workspace';

const ROOT = path.resolve(import.meta.dir, '..');

function lockedPackages(file: string): Set<string> {
  const text = readFileSync(path.join(ROOT, file), 'utf8');
  const packages = new Set<string>();
  for (const block of text.split('[[package]]').slice(1)) {
    const name = block.match(/^name = "([^"]+)"$/m)?.[1];
    const version = block.match(/^version = "([^"]+)"$/m)?.[1];
    if (name !== undefined && version !== undefined) packages.add(`${name} ${version}`);
  }
  return packages;
}

test("the hub's lock is the simulator's, with what its members lock besides", () => {
  const hub = lockedPackages(`${SIM_WORKSPACE}/Cargo.lock`);
  const simulator = lockedPackages('tools/sim/Cargo.lock');
  const release = lockedPackages('Cargo.lock');
  for (const entry of simulator) expect(hub.has(entry), entry).toBe(true);
  // A member locks its optional dependencies too; the release lock already pins each.
  for (const entry of hub) expect(simulator.has(entry) || release.has(entry), entry).toBe(true);
});

test('the hub reads every generated member and nothing else', () => {
  const members = readdirSync(path.join(ROOT, SIM_WORKSPACE, 'crates')).sort();
  const hub = readFileSync(path.join(ROOT, SIM_WORKSPACE, 'hub.MODULE.bazel'), 'utf8');
  const named = [...hub.matchAll(/crates\/([^/]+)\/Cargo\.toml/g)].map((match) => match[1]).sort();
  expect(named).toEqual(members);
});
