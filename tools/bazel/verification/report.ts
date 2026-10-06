import { admitSourceInputs } from './admission';
import { type EventReport, type RequiredCheck, readBuildEvents } from './events';
import { type GitContext, validGitContext } from './git-context';
import { sanitizeBuildEvents } from './sanitize';
import { changedInputs, type SourceManifest, validSourceManifest } from './snapshot';

export interface VerificationReport {
  readonly invocation: string;
  readonly expectedBuildToolVersion: string;
  readonly platform: string;
  readonly source: SourceManifest;
  readonly currentSourceDigest: string;
  readonly changedInputs: readonly string[];
  readonly events: EventReport;
  readonly snapshotAccepted: boolean;
  readonly currentAccepted: boolean;
  readonly pendingLiveChecks: readonly string[];
  readonly problems: readonly string[];
}

export interface VerificationEvidence {
  readonly invocation: string;
  readonly expectedBuildToolVersion: string;
  readonly platform: string;
  readonly snapshot: SourceManifest;
  readonly current: SourceManifest;
  readonly buildEvents: string;
  readonly required: readonly RequiredCheck[];
  readonly processExitCode: number | null;
  readonly pendingLiveChecks: readonly string[];
  readonly context: {
    readonly git: GitContext;
    readonly currentGit: GitContext;
    readonly configuredDigest: string;
    readonly admittedUntracked: readonly string[];
  };
}

function sourceAdmission(
  input: VerificationEvidence,
  problems: string[],
  pending: Set<string>,
): { readonly gitValid: boolean; readonly currentGitValid: boolean } {
  const context = input.context;
  const gitValid = validGitContext(context?.git);
  const currentGitValid = validGitContext(context?.currentGit);
  if (
    !gitValid ||
    !currentGitValid ||
    typeof context?.configuredDigest !== 'string' ||
    !/^[a-f0-9]{64}$/.test(context.configuredDigest)
  )
    problems.push('Verification lacks valid captured Git and configured graph identities');
  if (gitValid && input.snapshot.commit !== context.git.head)
    problems.push('Captured source belongs to another Git identity');
  if (currentGitValid && input.current.commit !== context.currentGit.head)
    problems.push('Current source belongs to another Git identity');
  try {
    admitSourceInputs(input.snapshot, context.git, context.admittedUntracked);
  } catch {
    problems.push('Reconstructed captured source admission did not complete');
  }
  try {
    admitSourceInputs(input.current, context.currentGit, context.admittedUntracked);
  } catch {
    pending.add('Current source admission did not complete');
  }
  return { gitValid, currentGitValid };
}

function invocationProblems(
  input: VerificationEvidence,
  events: EventReport,
  problems: string[],
): void {
  if (input.snapshot.root !== input.current.root)
    problems.push('Current source belongs to another workspace');
  if (events.invocation !== input.invocation)
    problems.push('Build events belong to another invocation');
  if (events.buildToolVersion !== input.expectedBuildToolVersion)
    problems.push('Build events do not match the pinned build tool');
  if (input.processExitCode === null || input.processExitCode !== events.exitCode) {
    problems.push('Bazel process and event exit status do not agree');
  }
  if (input.required.length === 0) problems.push('Verification inventory is empty');
  if (new Set(input.required.map((check) => check.label)).size !== input.required.length) {
    problems.push('Verification inventory contains duplicate targets');
  }
}

/** The engine owns test results; this report describes one invocation and its current-tree limits. */
export function verificationReport(input: VerificationEvidence): VerificationReport {
  let events: EventReport;
  try {
    events = readBuildEvents(sanitizeBuildEvents(input.buildEvents), input.required);
  } catch {
    events = readBuildEvents('', input.required);
  }
  const problems = [...events.problems];
  const pending = new Set(input.pendingLiveChecks);
  const snapshotValid = validSourceManifest(input.snapshot);
  const currentValid = validSourceManifest(input.current);
  if (!snapshotValid) problems.push('Captured source manifest is invalid');
  if (!currentValid) problems.push('Current source manifest is invalid');
  const { gitValid, currentGitValid } = sourceAdmission(input, problems, pending);
  invocationProblems(input, events, problems);
  const context = input.context;
  const changed = snapshotValid && currentValid ? changedInputs(input.snapshot, input.current) : [];
  const snapshotAccepted =
    problems.length === 0 &&
    events.complete &&
    events.exitCode === 0 &&
    events.checks.every((check) => check.status === 'passed');
  return {
    invocation: input.invocation,
    expectedBuildToolVersion: input.expectedBuildToolVersion,
    platform: input.platform,
    source: input.snapshot,
    currentSourceDigest: input.current.digest,
    changedInputs: changed,
    events,
    snapshotAccepted,
    currentAccepted:
      snapshotAccepted &&
      changed.length === 0 &&
      pending.size === 0 &&
      gitValid &&
      currentGitValid &&
      context.git.digest === context.currentGit.digest,
    pendingLiveChecks: [...pending].sort(),
    problems,
  };
}
