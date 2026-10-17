import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  currentWasmArtifactWorkspace,
  MEMBERS,
  WASM_HUBS,
  WASM_WORKSPACES,
  wasmArtifactDirectory,
  wasmArtifactHubs,
  wasmArtifactLockDrift,
  wasmArtifactMembersClosed,
} from './wasm-artifact-manifests';

const ROOT = path.resolve(import.meta.dir, '..');

// Cargo decides a module's members and their features when the script runs; what follows from
// the checkout's manifests alone is checked here, so an edit to one fails until it reruns.
test.each(WASM_WORKSPACES.map((spec) => [spec.name, spec] as const))(
  'the %s workspace is current with the crates it holds',
  (name, spec) => {
    const directory = path.join(ROOT, wasmArtifactDirectory(name));
    const workspace = currentWasmArtifactWorkspace(spec);
    expect(readFileSync(path.join(directory, 'Cargo.toml'), 'utf8')).toBe(workspace.root);
    for (const [member, text] of workspace.members)
      expect(readFileSync(path.join(directory, MEMBERS, member, 'Cargo.toml'), 'utf8')).toBe(text);
    expect(wasmArtifactMembersClosed(spec)).toEqual([]);
    expect(wasmArtifactLockDrift(spec)).toEqual([]);
  },
);

test('the hubs MODULE.bazel includes name every module workspace', () => {
  expect(readFileSync(path.join(ROOT, WASM_HUBS), 'utf8')).toBe(wasmArtifactHubs());
});
