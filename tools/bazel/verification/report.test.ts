import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { captureGitContext } from './git-context';
import { verificationReport } from './report';
import { manifestFromInventory } from './snapshot';

const configured = { label: '//test:unit', configuration: { id: 'config' } };
const buildEvents = [
  { id: { started: {} }, started: { uuid: 'current', buildToolVersion: '9.2.0' } },
  { id: { targetCompleted: configured }, completed: { success: true } },
  {
    id: { testResult: { ...configured, run: 1, shard: 1, attempt: 1 } },
    testResult: { status: 'PASSED' },
  },
  { id: { testSummary: configured }, testSummary: { overallStatus: 'PASSED', totalRunCount: 1 } },
  {
    id: { buildFinished: {} },
    finished: { exitCode: { code: 0, name: 'SUCCESS' } },
    lastMessage: true,
  },
]
  .map((event) => JSON.stringify(event))
  .join('\n');
const root = mkdtempSync(path.join(tmpdir(), 'merkur-report-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
writeFileSync(path.join(root, 'input.ts'), 'captured input');
const head = 'a'.repeat(40);
const git = captureGitContext(
  (args) => {
    if (args[0] === 'rev-parse') return `${head}\n`;
    if (args.includes('-v')) return 'H input.ts\0';
    if (args.includes('--stage')) return `100644 ${head} 0\tinput.ts\0`;
    return '';
  },
  head,
  head,
);
const snapshot = manifestFromInventory(root, ['input.ts'], head);
const input = {
  invocation: 'current',
  expectedBuildToolVersion: '9.2.0',
  platform: 'macos_arm64',
  snapshot,
  current: snapshot,
  buildEvents,
  required: [{ label: '//test:unit', kind: 'test', fresh: false } as const],
  processExitCode: 0,
  pendingLiveChecks: [] as readonly string[],
  context: { git, currentGit: git, configuredDigest: 'b'.repeat(64), admittedUntracked: [] },
};

test('snapshot pass remains distinct from changed current tree and pending live coverage', () => {
  expect(verificationReport(input).currentAccepted).toBe(true);
  const current = manifestFromInventory(root, [], head);
  const raced = verificationReport({ ...input, current });
  expect(raced.snapshotAccepted).toBe(true);
  expect(raced.currentAccepted).toBe(false);
  expect(raced.changedInputs).toEqual(['input.ts']);
  const deferred = verificationReport({ ...input, pendingLiveChecks: ['//live:transport'] });
  expect(deferred.snapshotAccepted).toBe(true);
  expect(deferred.currentAccepted).toBe(false);
});

test('wrong Git identity, erased graph identity and corrupt context cannot become green', () => {
  for (const context of [
    { ...input.context, configuredDigest: '' },
    { ...input.context, git: { ...git, digest: 'corrupt' } },
  ])
    expect(verificationReport({ ...input, context }).snapshotAccepted).toBe(false);
  expect(
    verificationReport({ ...input, snapshot: { ...snapshot, commit: 'c'.repeat(40) } })
      .snapshotAccepted,
  ).toBe(false);
});

test('old-invocation replay and interrupted process cannot accept current verification', () => {
  expect(verificationReport({ ...input, invocation: 'next' }).snapshotAccepted).toBe(false);
  expect(verificationReport({ ...input, processExitCode: null }).snapshotAccepted).toBe(false);
  expect(verificationReport({ ...input, processExitCode: 1 }).snapshotAccepted).toBe(false);
  expect(verificationReport({ ...input, expectedBuildToolVersion: '8.8.1' }).snapshotAccepted).toBe(
    false,
  );
});

test('empty or duplicated required target inventory cannot become green', () => {
  expect(verificationReport({ ...input, required: [] }).snapshotAccepted).toBe(false);
  expect(
    verificationReport({ ...input, required: [...input.required, ...input.required] })
      .snapshotAccepted,
  ).toBe(false);
});

test('malformed evidence reports pending inventory without exposing its payload', () => {
  const report = verificationReport({ ...input, buildEvents: '{"secret":"sensitive' });
  expect(report.snapshotAccepted).toBe(false);
  expect(report.events.checks[0]?.status).toBe('pending');
  expect(JSON.stringify(report)).not.toContain('sensitive');
});

test('corrupt manifest digests and duplicate source records cannot become green', () => {
  for (const current of [
    { ...snapshot, digest: 'corrupt' },
    { ...snapshot, inputs: [...snapshot.inputs, ...snapshot.inputs] },
  ])
    expect(verificationReport({ ...input, current }).currentAccepted).toBe(false);
  expect(
    verificationReport({ ...input, snapshot: { ...snapshot, digest: 'corrupt' } }).snapshotAccepted,
  ).toBe(false);
});
