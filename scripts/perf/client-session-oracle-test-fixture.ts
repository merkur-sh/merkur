import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CLIENT_SESSION_ORACLE_MANIFEST } from './client-session-oracle';

export const oracleFactHash = (bytes: string | Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');

/** Minimal independent configured compiler inventory for consumer contract controls. */
export function createOracleProofFixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'merkur-native-oracle-proof-'));
  const source = 'packages/client/src/oracle.rs';
  const inventory = 'tools/bazel/rust/source_inputs.json';
  const descriptor =
    'tools/bazel/rust/native_protocol/provenance/browser_session_oracle_native.json';
  const files: Record<string, string> = {
    'Cargo.lock': 'Cargo.lock',
    'rust-toolchain.toml': 'rust-toolchain.toml',
    'packages/client/Cargo.toml': 'packages/client/Cargo.toml',
    'packages/client/BUILD.bazel': 'packages/client/BUILD.bazel',
    [source]: 'original Rust bytes',
    [inventory]: JSON.stringify({ sources: { [source]: oracleFactHash('original Rust bytes') } }),
    [descriptor]: '',
  };
  files[descriptor] = JSON.stringify({
    roots: ['selected-unit'],
    compiler_label: '//tools/bazel/rust/native_protocol:u_selected-unit',
    packages: { 'workspace:packages/client': {} },
    macro_inputs: { 'workspace:packages/client': [] },
    source_membership: Object.keys(files).sort(),
  });
  const sourceInputs: Record<string, string> = {};
  for (const file of Object.keys(files).sort()) {
    const bytes = files[file];
    if (bytes === undefined) throw new Error(`Missing declared fixture fact ${file}`);
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), bytes);
    sourceInputs[file] = oracleFactHash(bytes);
  }
  const sha256 = oracleFactHash('declared native artifact');
  const relative = `target/rust/client-session-oracle/${sha256}/browser_session_oracle`;
  const executable = path.join(root, relative);
  mkdirSync(path.dirname(executable), { recursive: true });
  writeFileSync(executable, 'declared native artifact');
  const manifest = {
    configuredUnit: 'selected-unit',
    source: oracleFactHash(JSON.stringify(Object.entries(sourceInputs))),
    sourceInputs,
    executable: relative,
    sha256,
    command: ['bazel', 'build', '//tools/bazel/rust/native_protocol:u_selected-unit'],
  };
  const manifestPath = path.join(root, CLIENT_SESSION_ORACLE_MANIFEST);
  const retain = () => writeFileSync(manifestPath, JSON.stringify(manifest));
  retain();
  return {
    root,
    source,
    sourceInputs,
    manifest,
    executable,
    relative,
    retain,
    sourceBytes: () => readFileSync(path.join(root, source)),
    close: () => rmSync(root, { recursive: true, force: true }),
  };
}
