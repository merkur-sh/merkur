import { expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { clientSessionOracleExecutable } from '../../../scripts/perf/client-session-oracle';
import { createOracleProofFixture } from '../../../scripts/perf/client-session-oracle-test-fixture';

test('native oracle manifest binds source facts, compiler context, producer and executable bytes', () => {
  const fixture = createOracleProofFixture();
  const { root, executable, manifest, sourceInputs, relative, retain } = fixture;
  try {
    expect(clientSessionOracleExecutable(root)).toBe(executable);
    writeFileSync(executable, 'changed native artifact');
    expect(() => clientSessionOracleExecutable(root)).toThrow('evidence changed');
    writeFileSync(executable, 'declared native artifact');
    writeFileSync(path.join(root, 'Cargo.lock'), 'changed source');
    expect(() => clientSessionOracleExecutable(root)).toThrow('source facts changed');
    writeFileSync(path.join(root, 'Cargo.lock'), 'Cargo.lock');
    manifest.command = ['cargo', 'build'];
    retain();
    expect(() => clientSessionOracleExecutable(root)).toThrow('evidence changed');
    manifest.command = ['bazel', 'build', '//tools/bazel/rust/native_protocol:u_selected-unit'];
    manifest.executable = executable;
    retain();
    expect(() => clientSessionOracleExecutable(root)).toThrow('evidence changed');
    manifest.executable = relative;
    manifest.configuredUnit = 'different-unit';
    retain();
    expect(() => clientSessionOracleExecutable(root)).toThrow('compiler root changed');
    manifest.configuredUnit = 'selected-unit';
    delete sourceInputs[
      'tools/bazel/rust/native_protocol/provenance/browser_session_oracle_native.json'
    ];
    retain();
    expect(() => clientSessionOracleExecutable(root)).toThrow('selected compiler context');
    expect(readFileSync(executable, 'utf8')).toBe('declared native artifact');
  } finally {
    fixture.close();
  }
});
