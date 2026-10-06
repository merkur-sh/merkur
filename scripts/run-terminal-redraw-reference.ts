import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { gunzipSync } from 'node:zlib';
import {
  analyzeReferenceRedrawContent,
  summarizeReferenceRedrawContent,
} from '../tests/e2e/fixtures/reference-redraw-content';
import { assertReferenceRenderContent } from '../tests/e2e/fixtures/reference-render-content';
import {
  analyzeReferenceRedrawTrace,
  normalizeReferenceTerminalEvents,
  type ReferenceRedrawWindow,
  summarizeReferenceRedrawSamples,
  TERMINAL_REDRAW_REFERENCE_RAW_SCHEMA_VERSION,
  TERMINAL_REDRAW_REFERENCE_SCHEMA_VERSION,
} from '../tests/e2e/fixtures/terminal-redraw-reference';

const ROOT = path.resolve(import.meta.dir, '..');
const DEFAULT_SEED = 0x4d45_5243;

const PROFILES = {
  fast: { targetRttMs: 50, baseDelayUs: 12_500, jitterRadiusUs: 1_250 },
  typical: { targetRttMs: 120, baseDelayUs: 30_000, jitterRadiusUs: 3_750 },
  difficult: { targetRttMs: 200, baseDelayUs: 50_000, jitterRadiusUs: 7_500 },
} as const;

type ProfileName = keyof typeof PROFILES;

interface Options {
  readonly profiles: readonly ProfileName[];
  readonly samples: number;
  readonly seed: number;
  readonly outputDirectory: string;
}

function main(): void {
  const options = parseOptions(process.argv.slice(2));
  mkdirSync(options.outputDirectory, { recursive: true });
  const sourceCommit = git(['rev-parse', '--short=12', 'HEAD']).toString('utf8').trim();
  const sourceIdentity = workingSourceIdentity();

  for (const profileName of options.profiles) {
    const profile = PROFILES[profileName];
    const output = path.join(
      options.outputDirectory,
      `merkur-redraw-reference-${sourceCommit}-${profileName}-clean-seed${options.seed}-n${options.samples}.json`,
    );
    const result = spawnSync(
      'bun',
      ['run', 'scripts/run-edge-harness.ts', 'terminal-redraw-reference.e2e.ts', '--workers=1'],
      {
        cwd: ROOT,
        stdio: 'inherit',
        env: {
          ...process.env,
          FORCE_EDGE: '1',
          EDGE_NETWORK_PROFILE: profileName,
          EDGE_NETWORK_DATAGRAM_LOSS_PERCENT: '0',
          EDGE_NETWORK_REORDER: 'none',
          EDGE_NETWORK_SCENARIO: 'steady',
          EDGE_NETWORK_SEED: String(options.seed),
          // The detached 565acd4a runner consumes this deterministic proxy
          // contract. Current Merkur ignores these names and consumes the
          // EDGE_NETWORK_* contract above.
          BASELINE_PROFILE: profileName,
          BASELINE_TARGET_RTT_MS: String(profile.targetRttMs),
          BASELINE_BASE_DELAY_US: String(profile.baseDelayUs),
          BASELINE_JITTER_RADIUS_US: String(profile.jitterRadiusUs),
          BASELINE_DATAGRAM_LOSS_PERCENT: '0',
          BASELINE_REORDER: 'none',
          BASELINE_SCENARIO: 'steady',
          BASELINE_SEED: String(options.seed),
          REFERENCE_REDRAW_PROFILE: profileName,
          REFERENCE_REDRAW_TARGET_RTT_MS: String(profile.targetRttMs),
          REFERENCE_REDRAW_BASE_DELAY_US: String(profile.baseDelayUs),
          REFERENCE_REDRAW_JITTER_RADIUS_US: String(profile.jitterRadiusUs),
          REFERENCE_REDRAW_DATAGRAM_LOSS_PERCENT: '0',
          REFERENCE_REDRAW_REORDER: 'none',
          REFERENCE_REDRAW_SCENARIO: 'steady',
          REFERENCE_REDRAW_SEED: String(options.seed),
          REFERENCE_REDRAW_SAMPLE_COUNT: String(options.samples),
          REFERENCE_REDRAW_OUTPUT: output,
        },
      },
    );
    if (result.error !== undefined) throw result.error;
    if (result.status !== 0) {
      throw new Error(`redraw reference ${profileName} exited ${result.status ?? 'by signal'}`);
    }
    validateArtifact(output, profileName, options.samples, options.seed);
    if (workingSourceIdentity() !== sourceIdentity) {
      throw new Error('source checkout changed during the redraw reference run');
    }
    process.stdout.write(`${output}\n`);
  }
}

function parseOptions(args: readonly string[]): Options {
  let requestedProfile = 'all';
  let samples = 100;
  let seed = DEFAULT_SEED;
  let outputDirectory = '/tmp';
  for (const arg of args) {
    if (arg.startsWith('--profile=')) requestedProfile = arg.slice('--profile='.length);
    else if (arg.startsWith('--samples=')) samples = Number(arg.slice('--samples='.length));
    else if (arg.startsWith('--seed=')) seed = Number(arg.slice('--seed='.length));
    else if (arg.startsWith('--output-dir=')) {
      outputDirectory = path.resolve(arg.slice('--output-dir='.length));
    } else {
      throw new Error(`unknown redraw reference argument: ${arg}`);
    }
  }
  if (requestedProfile !== 'all' && !isProfileName(requestedProfile)) {
    throw new Error('--profile must be fast, typical, difficult, or all');
  }
  if (!Number.isSafeInteger(samples) || samples <= 0 || samples > 500) {
    throw new Error('--samples must be an integer in [1, 500]');
  }
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffff_ffff) {
    throw new Error('--seed must be an unsigned 32-bit integer');
  }
  return {
    profiles:
      requestedProfile === 'all' ? (Object.keys(PROFILES) as ProfileName[]) : [requestedProfile],
    samples,
    seed,
    outputDirectory,
  };
}

export function validateArtifact(
  output: string,
  profile: ProfileName,
  samples: number,
  seed: number,
): void {
  const parsed: unknown = JSON.parse(readFileSync(output, 'utf8'));
  if (
    !isRecord(parsed) ||
    parsed.schemaVersion !== TERMINAL_REDRAW_REFERENCE_SCHEMA_VERSION ||
    parsed.metricContractVersion !== 3
  ) {
    throw new Error(`${output} is not a current redraw reference artifact`);
  }
  if (parsed.profile !== profile || parsed.sampleCount !== samples) {
    throw new Error(`${output} does not describe the requested profile/sample population`);
  }
  if (
    !isRecord(parsed.impairment) ||
    parsed.impairment.seed !== seed ||
    parsed.targetRttMs !== PROFILES[profile].targetRttMs ||
    parsed.impairment.baseDelayUsPerLeg !== PROFILES[profile].baseDelayUs ||
    parsed.impairment.jitterRadiusUsPerLeg !== PROFILES[profile].jitterRadiusUs ||
    parsed.impairment.datagramLossPercent !== 0 ||
    parsed.impairment.reorder !== 'none' ||
    parsed.impairment.scenario !== 'steady'
  ) {
    throw new Error(`${output} does not describe the requested deterministic seed`);
  }
  if (!isRecord(parsed.rawTrace) || typeof parsed.rawTrace.path !== 'string') {
    throw new Error(`${output} has no retained raw common-event trace`);
  }
  if (!existsSync(parsed.rawTrace.path)) {
    throw new Error(`${output} raw common-event trace is missing: ${parsed.rawTrace.path}`);
  }
  const rawBytes = readFileSync(parsed.rawTrace.path);
  if (createHash('sha256').update(rawBytes).digest('hex') !== parsed.rawTrace.sha256)
    throw new Error(`${output} raw trace checksum mismatch`);
  const expanded = gunzipSync(rawBytes);
  if (
    parsed.rawTrace.compression !== 'gzip' ||
    parsed.rawTrace.compressedBytes !== rawBytes.length ||
    parsed.rawTrace.uncompressedBytes !== expanded.length ||
    parsed.rawTrace.telemetryRecordsLost !== 0
  )
    throw new Error(`${output} inconsistent raw byte/loss accounting`);
  const raw: unknown = JSON.parse(expanded.toString('utf8'));
  if (
    !isRecord(raw) ||
    raw.schemaVersion !== TERMINAL_REDRAW_REFERENCE_RAW_SCHEMA_VERSION ||
    !Array.isArray(raw.windows) ||
    !Array.isArray(raw.events) ||
    !Array.isArray(raw.contentObservations) ||
    !raw.windows.every(isReferenceRedrawWindow)
  )
    throw new Error(`${output} malformed raw trace`);
  if (
    parsed.rawTrace.commonEventCount !== raw.events.length ||
    !isRecord(raw.telemetryWorkerStats) ||
    raw.telemetryWorkerStats.recordsLost !== 0
  )
    throw new Error(`${output} inconsistent raw event/loss accounting`);
  // The analyzer validates every window's index and timestamp bounds before
  // joining, and normalization validates every required event field.
  const replayed = analyzeReferenceRedrawTrace(
    raw.windows,
    normalizeReferenceTerminalEvents(raw.events),
  );
  if (!isDeepStrictEqual(replayed, parsed.samples) || replayed.length !== samples)
    throw new Error(`${output} raw trace replay differs from the retained samples`);
  const observations = raw.contentObservations.map((value) => {
    assertReferenceRenderContent(value);
    return value;
  });
  const contentReplayed = analyzeReferenceRedrawContent(
    replayed,
    normalizeReferenceTerminalEvents(raw.events),
    observations,
  );
  if (!isDeepStrictEqual(contentReplayed, parsed.contentSamples))
    throw new Error(`${output} raw content replay differs from the retained samples`);
  if (
    !isDeepStrictEqual(summarizeReferenceRedrawSamples(replayed), parsed.summary) ||
    !isDeepStrictEqual(summarizeReferenceRedrawContent(contentReplayed), parsed.contentSummary)
  )
    throw new Error(`${output} raw replay differs from the retained headline distributions`);
}

function workingSourceIdentity(): string {
  const hash = createHash('sha256');
  hash.update(git(['rev-parse', 'HEAD']));
  hash.update(git(['status', '--porcelain=v1']));
  hash.update(git(['diff', '--binary', 'HEAD']));
  for (const file of [
    'scripts/run-terminal-redraw-reference.ts',
    'tests/e2e/terminal-redraw-reference.e2e.ts',
    'tests/e2e/fixtures/terminal-redraw-reference.ts',
    'tests/e2e/fixtures/reference-render-content.ts',
    'tests/e2e/fixtures/reference-redraw-content.ts',
  ])
    hash.update(readFileSync(path.join(ROOT, file)));
  return hash.digest('hex');
}

function git(args: readonly string[]): Buffer {
  return execFileSync('git', args, { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 });
}

function isProfileName(value: string): value is ProfileName {
  return Object.hasOwn(PROFILES, value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isReferenceRedrawWindow(value: unknown): value is ReferenceRedrawWindow {
  return (
    isRecord(value) &&
    Number.isSafeInteger(value.index) &&
    typeof value.readyMarker === 'string' &&
    typeof value.finalMarker === 'string' &&
    typeof value.openedAtMs === 'number' &&
    Number.isFinite(value.openedAtMs) &&
    typeof value.triggerDispatchCompletedAtMs === 'number' &&
    Number.isFinite(value.triggerDispatchCompletedAtMs) &&
    typeof value.closedAtMs === 'number' &&
    Number.isFinite(value.closedAtMs)
  );
}

if (import.meta.main) main();
