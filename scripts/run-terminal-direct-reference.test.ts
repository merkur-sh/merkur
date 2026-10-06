import { describe, expect, test } from 'bun:test';
import { PROXY_DELAY_HISTOGRAM_BUCKETS } from './edge-network-stats';
import {
  buildReferencePlaywrightConfig,
  DIRECT_REFERENCE_COMMON_FILES,
  replaceReferenceProxyPath,
  validateReferenceCompanionResult,
  validateReferenceOverlayPaths,
} from './run-terminal-direct-reference';

describe('owned historical Direct test overlay', () => {
  test('carries every current-only runtime helper into the historical overlay', () => {
    expect(DIRECT_REFERENCE_COMMON_FILES).toContain('tests/e2e/fixtures/direct-artifacts.ts');
    expect(DIRECT_REFERENCE_COMMON_FILES).toContain('tests/e2e/fixtures/direct-tui-workloads.ts');
    expect(DIRECT_REFERENCE_COMMON_FILES).toContain(
      'tests/e2e/fixtures/direct-reference-events.ts',
    );
    expect(DIRECT_REFERENCE_COMMON_FILES).toContain('tests/e2e/fixtures/direct-redraw-coverage.ts');
  });
  test('pins one common automation switch for executable provenance', () => {
    const base =
      "import { defineConfig } from '@playwright/test';\n" +
      "export default defineConfig({ use: { launchOptions: { args: ['--same-base-flag'] } } });\n";
    const config = buildReferencePlaywrightConfig(base);
    expect(config).toContain("args: ['--same-base-flag']");
    expect(config).toContain(
      ".filter((arg) => arg !== '--enable-automation'), '--enable-automation'",
    );
    expect(config).toContain('args: referenceArgs, executablePath: referenceBrowser');
    expect(config).toContain('./tests/e2e/node_modules/@playwright/test/index.mjs');
    expect(() => buildReferencePlaywrightConfig(base + base)).toThrow('config drift');
  });
  test('only the exact fixture binary declaration changes', () => {
    const declaration =
      "const PROXY_BIN = path.join(ROOT, 'target', 'rust', 'release', 'delay_proxy');";
    const source = `const x = 1;\n${declaration}\nconst y = 2;\n`;
    const patched = replaceReferenceProxyPath(source, declaration);
    expect(patched).toStartWith('const x = 1;\n');
    expect(patched).toEndWith('const y = 2;\n');
    expect(patched).toContain('const PROXY_BIN = PROXY_BINARY_PATH;');
    expect(patched).toContain('path.isAbsolute(PROXY_BINARY_PATH)');
    expect(() => replaceReferenceProxyPath(source + declaration, declaration)).toThrow('drift');
    expect(() => replaceReferenceProxyPath('different fixture', declaration)).toThrow('drift');
  });
  test('refuses every production/path-escape overlay and duplicate target', () => {
    expect(() =>
      validateReferenceOverlayPaths([
        { path: 'tests/e2e/terminal-direct-reference.e2e.ts', source: '' },
      ]),
    ).not.toThrow();
    for (const target of [
      'apps/web/src/terminal-worker.ts',
      'packages/term-wasm/src/lib.rs',
      'Cargo.toml',
      '../tests/a.ts',
      '/tmp/foreign.ts',
      'tests/e2e/../../apps/a.ts',
    ]) {
      expect(() => validateReferenceOverlayPaths([{ path: target, source: '' }])).toThrow(
        'refused',
      );
    }
    expect(() =>
      validateReferenceOverlayPaths([
        { path: 'scripts/a.ts', source: 'a' },
        { path: 'scripts/a.ts', source: 'b' },
      ]),
    ).toThrow('duplicate');
  });
  test('requires an exact populated and drained 400ms companion path', () => {
    const result = companionResult();
    expect(validateReferenceCompanionResult(result, 1_296_388_675).complete).toBe(true);
    expect(() =>
      validateReferenceCompanionResult(
        { ...result, network: { ...(result.network as object), seed: 7 } },
        1_296_388_675,
      ),
    ).toThrow('400ms contract');
    const proxyStats = result.proxyStats as Record<string, unknown>;
    // One live relay still owns a scheduled packet: parseable, not drained.
    const undrainedRelay = {
      admissionSeq: 1,
      listener: { role: 'browser', competitor: false },
      upstreamPort: 50_001,
      pending: 1,
      upSeen: 0,
      downSeen: 0,
      downDropped: 0,
      downReordered: 0,
      upMaxInFlight: 0,
      downMaxInFlight: 1,
      bottleneckDrops: 0,
    };
    expect(() =>
      validateReferenceCompanionResult(
        {
          ...result,
          proxyStats: { ...proxyStats, pendingScheduledPackets: 1, relays: [undrainedRelay] },
        },
        1_296_388_675,
      ),
    ).toThrow('incomplete');
  });
});

function companionResult(): Record<string, unknown> {
  const seed = 1_296_388_675;
  const direction = populatedDirection();
  return {
    schemaVersion: 2,
    playwrightExitCode: 0,
    harnessExitCode: 0,
    impairmentValidation: { complete: true, errors: [] },
    network: {
      profile: { name: 'difficult', targetRttMs: 400, hopDelayUs: 100_000 },
      datagramLossPercent: 0,
      reorder: 'none',
      scenario: 'steady',
      seed,
      hopJitterRadiusUs: 7_500,
    },
    proxyStats: {
      schemaVersion: 9,
      epoch: 1,
      config: {
        profile: 'difficult',
        targetRttMs: 400,
        baseDelayUs: 100_000,
        jitterRadiusUs: 7_500,
        datagramLossPercent: 0,
        faultSite: 'edge-to-client',
        faultSitesPerLogicalDirection: 1,
        reorder: 'none',
        scenario: 'steady',
        seed,
      },
      upstream: direction,
      downstream: direction,
      logicalPathImpairment: {
        faultSite: 'edge-to-client',
        faultSitesPerLogicalDirection: 1,
        requestedDatagramLossPercent: 0,
        observedFaultSitePackets: 100,
        droppedAtFaultSite: 0,
        achievedPacketLossPercent: 0,
      },
      harnessDrops: { oversized: 0, admission: 0, leaseExhausted: 0 },
      splitDatagrams: 0,
      pendingScheduledPackets: 0,
      exactLossWindowsCompleted: 1,
      exactLossDroppedInCompletedWindows: 0,
      relays: [],
      links: [],
      relayLinks: [],
    },
  };
}

function populatedDirection(): Record<string, unknown> {
  const scheduled = distribution([
    [92_500, 50],
    [107_500, 50],
  ]);
  const zero = distribution([[0, 100]]);
  return {
    seen: 100,
    forwarded: 100,
    dropped: 0,
    exactLossDropped: 0,
    burstLossDropped: 0,
    burstLossRunsCompleted: 0,
    jittered: 100,
    reorderInversions: 0,
    reordered: 0,
    congested: 0,
    congestedForwarded: 0,
    congestionClamped: 0,
    maxCongestionQueueDelayUs: 0,
    maxForwardedCongestionQueueDelayUs: 0,
    achievedPacketLossPercent: 0,
    scheduledDelayUs: scheduled,
    releaseTargetResidenceUs: scheduled,
    actualResidenceUs: scheduled,
    releaseOvershootUs: zero,
    releaseEarlyCount: 0,
    maxReleaseEarlyUs: 0,
  };
}

function distribution(population: readonly (readonly [number, number])[]) {
  const histogram = Array<number>(PROXY_DELAY_HISTOGRAM_BUCKETS).fill(0);
  let count = 0;
  let sum = 0;
  for (const [value, occurrences] of population) {
    const bucket = Math.min(histogram.length - 1, Math.floor(value / 500));
    histogram[bucket] = (histogram[bucket] ?? 0) + occurrences;
    count += occurrences;
    sum += value * occurrences;
  }
  const ordered = population.flatMap(([value, occurrences]) =>
    Array<number>(occurrences).fill(value),
  );
  const quantile = (ratio: number): number => {
    if (count === 0) return 0;
    const target = Math.ceil(count * ratio);
    let cumulative = 0;
    for (let index = 0; index < histogram.length; index += 1) {
      cumulative += histogram[index] ?? 0;
      if (cumulative >= target) {
        return Math.min((index + 1) * 500, ordered.at(-1) ?? 0);
      }
    }
    throw new Error('fixture histogram does not cover its declared population');
  };
  return {
    count,
    mean: sum / count,
    min: ordered[0] ?? 0,
    p50: quantile(0.5),
    p95: quantile(0.95),
    p99: quantile(0.99),
    max: ordered.at(-1) ?? 0,
    histogramBucketUs: 500,
    histogram,
  };
}
