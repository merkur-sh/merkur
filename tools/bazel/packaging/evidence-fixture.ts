import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { manifestFromInventory } from '../verification/snapshot';
import type { reconstructProducerVerification } from './shipping-evidence';

export async function verificationFixture(
  run: (
    evidence: Record<string, unknown>,
    context: Parameters<typeof reconstructProducerVerification>[1],
    root: string,
  ) => void | Promise<void>,
): Promise<void> {
  const root = mkdtempSync(path.join(os.tmpdir(), 'shipping-evidence-'));
  try {
    writeFileSync(path.join(root, 'producer.ts'), 'declared fixture bytes');
    const commit = 'a'.repeat(40);
    const source = manifestFromInventory(root, ['producer.ts'], commit);
    const invocation = '11111111-1111-4111-8111-111111111111';
    const required = [
      { label: '//scripts:release_verifier', kind: 'build', fresh: false },
    ] as const;
    const outputPath = 'bazel-out/native/bin/verify.bin';
    mkdirSync(path.join(root, 'bazel-out/native/bin'), { recursive: true });
    const output = Buffer.from('actual declared fixture output');
    writeFileSync(path.join(root, outputPath), output);
    const digest = createHash('sha256').update(output).digest('hex');
    const events = [
      { id: { started: {} }, started: { uuid: invocation, buildToolVersion: '9.2.0' } },
      {
        id: { namedSet: { id: 'outputs' } },
        namedSetOfFiles: {
          files: [
            {
              name: 'verify.bin',
              pathPrefix: ['bazel-out', 'native', 'bin'],
              digest,
              length: String(output.length),
            },
          ],
        },
      },
      {
        id: { targetCompleted: { label: required[0].label, configuration: { id: 'fixture' } } },
        completed: {
          success: true,
          outputGroup: [{ name: 'default', fileSets: [{ id: 'outputs' }] }],
        },
      },
      {
        id: { buildFinished: {} },
        finished: { exitCode: { code: 0, name: 'SUCCESS' } },
        lastMessage: true,
      },
    ]
      .map((event) => JSON.stringify(event))
      .join('\n');
    const evidence = {
      invocation,
      expectedBuildToolVersion: '9.2.0',
      platform: 'macos_arm64',
      snapshot: source,
      current: source,
      buildEvents: events,
      required,
      processExitCode: 0,
      pendingLiveChecks: [],
    };
    const gitFacts = {
      base: commit,
      candidate: commit,
      head: commit,
      baseTree: 'b'.repeat(40),
      candidateTree: 'b'.repeat(40),
      index: [{ path: 'producer.ts', mode: '100644', object: 'c'.repeat(40) }],
      untracked: [],
      committed: [],
      staged: [],
      unstaged: [],
      changed: [],
    };
    const git = {
      ...gitFacts,
      digest: createHash('sha256').update(JSON.stringify(gitFacts)).digest('hex'),
    };
    const configuredDigest = 'd'.repeat(64);
    Object.assign(evidence, {
      context: { git, currentGit: git, configuredDigest, admittedUntracked: [] },
    });
    const context = {
      platform: 'macos_arm64',
      commit,
      sourceDigest: source.digest,
      required,
      invocation,
      base: commit,
      candidate: commit,
      gitDigest: git.digest,
      configuredDigest,
      admittedUntracked: [],
    };
    await run(evidence, context, root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
