import { existsSync, mkdtempSync, readFileSync, renameSync, rmdirSync } from 'node:fs';
import path from 'node:path';
import {
  CLIENT_SESSION_ORACLE_MANIFEST,
  clientSessionOracleArtifact,
  clientSessionOracleExecutable,
} from '../../../scripts/perf/client-session-oracle';
import { readEngineArtifact, targetArtifacts } from '../verification/artifacts';
import { BazelVerificationEngine } from '../verification/bazel-engine';
import type { DeclaredEngineTools } from '../verification/engine-process';
import { readBuildEvents } from '../verification/events';
import { openOwnedDirectory } from './owned-files';

export const CLIENT_SESSION_ORACLE_PRODUCER = '//tools/bazel/bun:client_session_oracle';
const outputGroups = ['oracle_manifest', 'oracle_binary'] as const;

/** Consume only the actual completed package action's two original output Files. */
export async function publishClientSessionOracle(options: {
  root: string;
  executionRoot: string;
  events: string;
  exitCode: number | null;
}): Promise<string> {
  const report = readBuildEvents(options.events, [
    { label: CLIENT_SESSION_ORACLE_PRODUCER, kind: 'build', fresh: false },
  ]);
  const check = report.checks[0];
  if (
    options.exitCode !== 0 ||
    report.exitCode !== 0 ||
    !report.complete ||
    report.buildToolVersion !== '9.2.0' ||
    report.problems.length !== 0 ||
    check?.status !== 'passed' ||
    check.configuration === null
  )
    throw new Error(
      `Oracle preparation requires its complete pinned-engine package build: engine exit ${options.exitCode}, reported exit ${report.exitCode}, ${report.complete ? 'complete' : 'incomplete'} events, check ${check?.status ?? 'absent'}${report.problems.map((problem) => `; ${problem}`).join('')}`,
    );
  const configuration = check.configuration;
  const files = outputGroups.map((group) => {
    const artifacts = targetArtifacts(options.events, {
      label: CLIENT_SESSION_ORACLE_PRODUCER,
      configuration,
      group,
    });
    const artifact = artifacts[0];
    if (artifacts.length !== 1 || artifact === undefined)
      throw new Error('Oracle package output group requires exactly one original File');
    return artifact;
  });
  const manifestFile = files[0];
  const binaryFile = files[1];
  if (
    manifestFile === undefined ||
    binaryFile === undefined ||
    manifestFile.path === binaryFile.path
  )
    throw new Error('Oracle package requires distinct manifest and executable Files');
  const manifestBytes = await readEngineArtifact(options.executionRoot, manifestFile);
  const bytes = await readEngineArtifact(options.executionRoot, binaryFile);
  const manifest: unknown = JSON.parse(manifestBytes.toString());
  const executable = clientSessionOracleArtifact(options.root, manifest, bytes);
  const relative = path.relative(options.root, executable).split(path.sep).join('/');
  const owned = openOwnedDirectory(options.root);
  let temporary: string | undefined;
  try {
    owned.directory(path.posix.dirname(relative));
    if (existsSync(executable)) {
      if (!owned.readExisting(relative).bytes.equals(bytes))
        throw new Error('Retained oracle differs from its actual configured executable');
      owned.verifyExisting(relative);
    } else {
      owned.write(relative, bytes, 0o555);
      owned.sync(relative);
    }
    owned.directory(path.posix.dirname(CLIENT_SESSION_ORACLE_MANIFEST));
    temporary = mkdtempSync(path.join(options.root, 'target/rust/.oracle-publication-'));
    const publication = openOwnedDirectory(temporary);
    let published = false;
    try {
      publication.write('manifest.json', manifestBytes, 0o644);
      publication.sync('manifest.json');
      clientSessionOracleArtifact(options.root, manifest, bytes);
      publication.verify('manifest.json');
      renameSync(
        path.join(temporary, 'manifest.json'),
        path.join(options.root, CLIENT_SESSION_ORACLE_MANIFEST),
      );
      published = true;
      if (
        !readFileSync(path.join(options.root, CLIENT_SESSION_ORACLE_MANIFEST)).equals(manifestBytes)
      )
        throw new Error('Oracle manifest publication differs from its original package File');
      return clientSessionOracleExecutable(options.root);
    } finally {
      try {
        if (!published) publication.removeCreated();
      } finally {
        publication.close();
      }
    }
  } finally {
    owned.close();
    if (temporary !== undefined) rmdirSync(temporary);
  }
}

/** Cacheable package construction uses the same declared engine transport as development. */
export async function prepareClientSessionOracle(options: {
  root: string;
  directory: string;
  tools: DeclaredEngineTools;
  signal: AbortSignal;
  admittedUntracked: readonly string[];
}): Promise<string> {
  const engine = new BazelVerificationEngine({ ...options, all: false });
  try {
    await engine.initialize();
    return await publishClientSessionOracle({
      root: options.root,
      ...(await engine.buildArtifacts([CLIENT_SESSION_ORACLE_PRODUCER], outputGroups)),
    });
  } finally {
    await engine.close();
  }
}
