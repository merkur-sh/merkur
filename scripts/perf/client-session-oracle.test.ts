import { expect, test } from 'bun:test';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  CLIENT_SESSION_ORACLE_MANIFEST,
  clientSessionOracleExecutable,
  clientSessionOracleManifest,
  retainClientSessionOracle,
} from './client-session-oracle';

test('Cargo-prepared evidence binds exact source and binary bytes, including untracked inputs', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'merkur-oracle-proof-'));
  try {
    for (const directory of ['.cargo', 'apps', 'packages/client/src', 'target/rust'])
      mkdirSync(path.join(root, directory), { recursive: true });
    for (const file of [
      'Cargo.toml',
      'Cargo.lock',
      'rust-toolchain.toml',
      'packages/client/Cargo.toml',
    ])
      writeFileSync(path.join(root, file), file);
    const source = path.join(root, 'packages/client/src/oracle.rs');
    writeFileSync(source, 'original Rust bytes');
    const executable = path.join(root, 'target/rust/oracle');
    writeFileSync(executable, 'original executable bytes');
    const original = retainClientSessionOracle(root, executable);
    const manifest = clientSessionOracleManifest(root, original);
    writeFileSync(path.join(root, CLIENT_SESSION_ORACLE_MANIFEST), JSON.stringify(manifest));
    expect(clientSessionOracleExecutable(root)).toBe(original);
    const before = statSync(source);
    writeFileSync(source, 'modified Rust bytes');
    utimesSync(source, before.atime, before.mtime);
    expect(() => clientSessionOracleExecutable(root)).toThrow('oracle evidence changed');
    writeFileSync(source, 'original Rust bytes');
    writeFileSync(path.join(root, 'packages/client/src/untracked.rs'), 'untracked included source');
    expect(() => clientSessionOracleExecutable(root)).toThrow('oracle evidence changed');
    rmSync(path.join(root, 'packages/client/src/untracked.rs'));
    chmodSync(original, 0o755);
    writeFileSync(original, 'replacement executable bytes');
    expect(() => clientSessionOracleExecutable(root)).toThrow('oracle evidence changed');
    expect(() => retainClientSessionOracle(root, executable)).toThrow(
      'differ from compiler artifact',
    );
    writeFileSync(executable, 'second compiler artifact');
    const retained = retainClientSessionOracle(root, executable);
    const retainedManifest = clientSessionOracleManifest(root, retained);
    writeFileSync(
      path.join(root, CLIENT_SESSION_ORACLE_MANIFEST),
      JSON.stringify(retainedManifest),
    );
    writeFileSync(executable, 'Cargo test replaced its public output');
    expect(clientSessionOracleExecutable(root)).toBe(retained);
    expect(retained).not.toBe(executable);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
