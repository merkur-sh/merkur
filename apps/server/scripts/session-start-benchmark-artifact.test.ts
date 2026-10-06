import { describe, expect, test } from 'bun:test';

import {
  compareSessionStartBenchmarkArtifacts,
  parseCoordinationServerVersion,
  parseSessionStartBenchmarkArtifactOutput,
  SESSION_START_BENCHMARK_NAME,
  SESSION_START_BENCHMARK_SCHEMA_VERSION,
  SESSION_START_MEASUREMENT_BOUNDARY,
  type SessionStartBenchmarkArtifact,
  sessionStartRegressionPercentiles,
} from './session-start-benchmark-artifact';

describe('session-start benchmark artifacts', () => {
  test('extracts an exact artifact from captured benchmark output', () => {
    const artifact = createArtifact('pre-cut-control', 1, 2, 3);
    const output = [
      '@@merkur-perf {"name":"ignored"}',
      JSON.stringify(artifact),
      'human summary',
    ].join('\n');

    expect(parseSessionStartBenchmarkArtifactOutput(output)).toEqual(artifact);
  });

  test('rejects a different measurement boundary or surplus fields', () => {
    const artifact = createArtifact('pre-cut-control', 1, 2, 3);
    expect(
      parseSessionStartBenchmarkArtifactOutput(
        JSON.stringify({ ...artifact, measurementBoundary: 'websocket-write-only' }),
      ),
    ).toBeNull();
    expect(
      parseSessionStartBenchmarkArtifactOutput(
        JSON.stringify({ ...artifact, transportConnectionId: 'not-portable' }),
      ),
    ).toBeNull();
  });

  test('reports candidate percentile changes relative to the archived baseline', () => {
    const baseline = createArtifact('pre-cut-control', 2, 4, 5);
    const candidate = createArtifact('authenticated-wss-v1', 1, 5, 6);

    expect(compareSessionStartBenchmarkArtifacts(baseline, candidate)).toEqual({
      baselineImplementation: 'pre-cut-control',
      candidateImplementation: 'authenticated-wss-v1',
      baselineConfirmationSemantics: 'pre-cut-bridge-delivery-receipt',
      candidateConfirmationSemantics: 'daemon-command-ack',
      baselineHarnessTopology: 'pre-cut-sidecar-relay',
      candidateHarnessTopology: 'bounded-in-process-control-socket',
      likeForLikeTopology: false,
      p50ChangePercent: -50,
      p95ChangePercent: 25,
      p99ChangePercent: 20,
    });
  });

  test('rejects comparison across different sample configurations or machines', () => {
    const baseline = createArtifact('pre-cut-control', 2, 4, 5);
    const differentSamples = {
      ...createArtifact('authenticated-wss-v1', 1, 5, 6),
      iterations: 999,
    };
    expect(() => compareSessionStartBenchmarkArtifacts(baseline, differentSamples)).toThrow(
      'different iteration or warm-up counts',
    );

    const differentMachine = {
      ...createArtifact('authenticated-wss-v1', 1, 5, 6),
      environment: {
        ...baseline.environment,
        cpuModel: 'different',
      },
    };
    expect(() => compareSessionStartBenchmarkArtifacts(baseline, differentMachine)).toThrow(
      'environment differs at cpuModel',
    );
  });

  test('identifies percentile regressions beyond the configured gate', () => {
    const comparison = compareSessionStartBenchmarkArtifacts(
      createArtifact('pre-cut-control', 2, 4, 5),
      createArtifact('authenticated-wss-v1', 1, 5, 6),
    );
    expect(sessionStartRegressionPercentiles(comparison, 10)).toEqual(['p95', 'p99']);
  });

  test('extracts exact Dragonfly and Redis compatibility versions from INFO', () => {
    expect(
      parseCoordinationServerVersion(
        '# Server\r\ndragonfly_version:1.30.3\r\nredis_version:7.2.4\r\n',
      ),
    ).toBe('dragonfly=1.30.3;redis=7.2.4');
    expect(parseCoordinationServerVersion('# Server\nredis_version:7.2.4\n')).toBe('redis=7.2.4');
  });

  test('rejects unusable coordination-server INFO responses', () => {
    expect(() => parseCoordinationServerVersion(null)).toThrow('non-string response');
    expect(() => parseCoordinationServerVersion('# Server\nuptime_in_seconds:10\n')).toThrow(
      'did not include a server version',
    );
  });
});

function createArtifact(
  implementation: string,
  p50Ms: number,
  p95Ms: number,
  p99Ms: number,
): SessionStartBenchmarkArtifact {
  return {
    schemaVersion: SESSION_START_BENCHMARK_SCHEMA_VERSION,
    benchmark: SESSION_START_BENCHMARK_NAME,
    measurementBoundary: SESSION_START_MEASUREMENT_BOUNDARY,
    implementation,
    confirmationSemantics:
      implementation === 'pre-cut-control'
        ? 'pre-cut-bridge-delivery-receipt'
        : 'daemon-command-ack',
    harnessTopology:
      implementation === 'pre-cut-control'
        ? 'pre-cut-sidecar-relay'
        : 'bounded-in-process-control-socket',
    environment: {
      platform: 'test',
      osRelease: 'test',
      architecture: 'test',
      cpuModel: 'test',
      logicalCpuCount: 8,
      bunVersion: 'test',
      coordinationServerVersion: 'test',
    },
    iterations: 1_000,
    warmupIterations: 100,
    meanMs: p50Ms,
    p50Ms,
    p95Ms,
    p99Ms,
  };
}
