import { hasExactKeys, isRecord } from '@merkur/shared';

export const SESSION_START_BENCHMARK_SCHEMA_VERSION = 1 as const;
export const SESSION_START_BENCHMARK_NAME = 'server-session-start-ack' as const;
export const SESSION_START_MEASUREMENT_BOUNDARY =
  'server-session-start-dispatch-to-delivery-confirmation' as const;

const ARTIFACT_KEYS = [
  'schemaVersion',
  'benchmark',
  'measurementBoundary',
  'implementation',
  'confirmationSemantics',
  'harnessTopology',
  'environment',
  'iterations',
  'warmupIterations',
  'meanMs',
  'p50Ms',
  'p95Ms',
  'p99Ms',
] as const;
const ENVIRONMENT_KEYS = [
  'platform',
  'osRelease',
  'architecture',
  'cpuModel',
  'logicalCpuCount',
  'bunVersion',
  'coordinationServerVersion',
] as const;

export type SessionStartConfirmationSemantics =
  | 'daemon-command-ack'
  | 'pre-cut-bridge-delivery-receipt';
export type SessionStartHarnessTopology =
  | 'bounded-in-process-control-socket'
  | 'pre-cut-sidecar-relay';

export interface SessionStartBenchmarkEnvironment {
  readonly platform: string;
  readonly osRelease: string;
  readonly architecture: string;
  readonly cpuModel: string;
  readonly logicalCpuCount: number;
  readonly bunVersion: string;
  readonly coordinationServerVersion: string;
}

export interface SessionStartBenchmarkArtifact {
  readonly schemaVersion: typeof SESSION_START_BENCHMARK_SCHEMA_VERSION;
  readonly benchmark: typeof SESSION_START_BENCHMARK_NAME;
  readonly measurementBoundary: typeof SESSION_START_MEASUREMENT_BOUNDARY;
  readonly implementation: string;
  readonly confirmationSemantics: SessionStartConfirmationSemantics;
  readonly harnessTopology: SessionStartHarnessTopology;
  readonly environment: SessionStartBenchmarkEnvironment;
  readonly iterations: number;
  readonly warmupIterations: number;
  readonly meanMs: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly p99Ms: number;
}

export interface SessionStartBenchmarkComparison {
  readonly baselineImplementation: string;
  readonly candidateImplementation: string;
  readonly baselineConfirmationSemantics: SessionStartConfirmationSemantics;
  readonly candidateConfirmationSemantics: SessionStartConfirmationSemantics;
  readonly baselineHarnessTopology: SessionStartHarnessTopology;
  readonly candidateHarnessTopology: SessionStartHarnessTopology;
  readonly likeForLikeTopology: boolean;
  readonly p50ChangePercent: number;
  readonly p95ChangePercent: number;
  readonly p99ChangePercent: number;
}

/**
 * Reads the exact artifact line from captured benchmark stdout. Other output
 * (including structured perf metrics and the human summary) is ignored.
 */
export function parseSessionStartBenchmarkArtifactOutput(
  output: string,
): SessionStartBenchmarkArtifact | null {
  const lines = output.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim();
    if (line === undefined || line.length === 0 || line[0] !== '{') continue;
    try {
      const parsed: unknown = JSON.parse(line);
      const artifact = parseSessionStartBenchmarkArtifact(parsed);
      if (artifact !== null) return artifact;
    } catch {
      // Captured stdout can contain unrelated non-JSON lines.
    }
  }
  return null;
}

export function compareSessionStartBenchmarkArtifacts(
  baseline: SessionStartBenchmarkArtifact,
  candidate: SessionStartBenchmarkArtifact,
): SessionStartBenchmarkComparison {
  assertComparableArtifacts(baseline, candidate);
  return {
    baselineImplementation: baseline.implementation,
    candidateImplementation: candidate.implementation,
    baselineConfirmationSemantics: baseline.confirmationSemantics,
    candidateConfirmationSemantics: candidate.confirmationSemantics,
    baselineHarnessTopology: baseline.harnessTopology,
    candidateHarnessTopology: candidate.harnessTopology,
    likeForLikeTopology:
      baseline.harnessTopology === candidate.harnessTopology &&
      baseline.confirmationSemantics === candidate.confirmationSemantics,
    p50ChangePercent: percentChange(baseline.p50Ms, candidate.p50Ms),
    p95ChangePercent: percentChange(baseline.p95Ms, candidate.p95Ms),
    p99ChangePercent: percentChange(baseline.p99Ms, candidate.p99Ms),
  };
}

export function sessionStartRegressionPercentiles(
  comparison: SessionStartBenchmarkComparison,
  allowedRegressionPercent: number,
): string[] {
  if (!Number.isFinite(allowedRegressionPercent) || allowedRegressionPercent < 0) {
    throw new Error('allowed session-start regression must be a non-negative finite percentage');
  }
  const changes: ReadonlyArray<readonly [string, number]> = [
    ['p50', comparison.p50ChangePercent],
    ['p95', comparison.p95ChangePercent],
    ['p99', comparison.p99ChangePercent],
  ];
  return changes.filter((entry) => entry[1] > allowedRegressionPercent).map((entry) => entry[0]);
}

export function parseCoordinationServerVersion(info: unknown): string {
  if (typeof info !== 'string') {
    throw new Error('Dragonfly INFO returned a non-string response');
  }
  const dragonflyVersion = readInfoField(info, 'dragonfly_version');
  const redisVersion = readInfoField(info, 'redis_version');
  if (dragonflyVersion === null && redisVersion === null) {
    throw new Error('Dragonfly INFO did not include a server version');
  }
  return [
    dragonflyVersion === null ? null : `dragonfly=${dragonflyVersion}`,
    redisVersion === null ? null : `redis=${redisVersion}`,
  ]
    .filter((value): value is string => value !== null)
    .join(';');
}

function parseSessionStartBenchmarkArtifact(value: unknown): SessionStartBenchmarkArtifact | null {
  if (!isRecord(value) || !hasExactKeys(value, ARTIFACT_KEYS)) return null;
  const environment = parseEnvironment(value.environment);
  if (
    value.schemaVersion !== SESSION_START_BENCHMARK_SCHEMA_VERSION ||
    value.benchmark !== SESSION_START_BENCHMARK_NAME ||
    value.measurementBoundary !== SESSION_START_MEASUREMENT_BOUNDARY ||
    typeof value.implementation !== 'string' ||
    value.implementation.length === 0 ||
    value.implementation.length > 128 ||
    !isConfirmationSemantics(value.confirmationSemantics) ||
    !isHarnessTopology(value.harnessTopology) ||
    environment === null ||
    !isPositiveSafeInteger(value.iterations) ||
    !isNonNegativeSafeInteger(value.warmupIterations) ||
    !isPositiveFinite(value.meanMs) ||
    !isPositiveFinite(value.p50Ms) ||
    !isPositiveFinite(value.p95Ms) ||
    !isPositiveFinite(value.p99Ms) ||
    value.p50Ms > value.p95Ms ||
    value.p95Ms > value.p99Ms
  ) {
    return null;
  }
  return {
    schemaVersion: SESSION_START_BENCHMARK_SCHEMA_VERSION,
    benchmark: SESSION_START_BENCHMARK_NAME,
    measurementBoundary: SESSION_START_MEASUREMENT_BOUNDARY,
    implementation: value.implementation,
    confirmationSemantics: value.confirmationSemantics,
    harnessTopology: value.harnessTopology,
    environment,
    iterations: value.iterations,
    warmupIterations: value.warmupIterations,
    meanMs: value.meanMs,
    p50Ms: value.p50Ms,
    p95Ms: value.p95Ms,
    p99Ms: value.p99Ms,
  };
}

function parseEnvironment(value: unknown): SessionStartBenchmarkEnvironment | null {
  if (!isRecord(value) || !hasExactKeys(value, ENVIRONMENT_KEYS)) return null;
  if (
    !isBoundedString(value.platform) ||
    !isBoundedString(value.osRelease) ||
    !isBoundedString(value.architecture) ||
    !isBoundedString(value.cpuModel) ||
    !isPositiveSafeInteger(value.logicalCpuCount) ||
    !isBoundedString(value.bunVersion) ||
    !isBoundedString(value.coordinationServerVersion)
  ) {
    return null;
  }
  return {
    platform: value.platform,
    osRelease: value.osRelease,
    architecture: value.architecture,
    cpuModel: value.cpuModel,
    logicalCpuCount: value.logicalCpuCount,
    bunVersion: value.bunVersion,
    coordinationServerVersion: value.coordinationServerVersion,
  };
}

function assertComparableArtifacts(
  baseline: SessionStartBenchmarkArtifact,
  candidate: SessionStartBenchmarkArtifact,
): void {
  if (
    baseline.iterations !== candidate.iterations ||
    baseline.warmupIterations !== candidate.warmupIterations
  ) {
    throw new Error('session-start artifacts use different iteration or warm-up counts');
  }
  for (const field of ENVIRONMENT_KEYS) {
    if (baseline.environment[field] !== candidate.environment[field]) {
      throw new Error(`session-start artifact environment differs at ${field}`);
    }
  }
}

function percentChange(baseline: number, candidate: number): number {
  return ((candidate - baseline) / baseline) * 100;
}

function readInfoField(info: string, name: string): string | null {
  const prefix = `${name}:`;
  for (const line of info.split(/\r?\n/)) {
    if (!line.startsWith(prefix)) continue;
    const value = line.slice(prefix.length);
    return value.length > 0 && value.length <= 128 ? value : null;
  }
  return null;
}

function isConfirmationSemantics(value: unknown): value is SessionStartConfirmationSemantics {
  return value === 'daemon-command-ack' || value === 'pre-cut-bridge-delivery-receipt';
}

function isHarnessTopology(value: unknown): value is SessionStartHarnessTopology {
  return value === 'bounded-in-process-control-socket' || value === 'pre-cut-sidecar-relay';
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function isBoundedString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256;
}
