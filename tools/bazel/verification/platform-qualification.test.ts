import { expect, test } from 'bun:test';
import type { ControllerAttempt } from './controller';
import { NATIVE_EXECUTION_PLATFORMS, parseExecutorPolicy } from './executor-policy';
import { requireNativePlatformAttempts, verifyNativePlatformBatch } from './platform-qualification';

function attempts(platforms: readonly string[]): readonly ControllerAttempt[] {
  const unexpected = () => {
    throw new Error('Platform preflight attempted engine execution');
  };
  return platforms.map((platform) => ({
    engine: {
      version: '9.2.0',
      platform,
      completeTestInventory: async () => unexpected(),
      bindTestReservation: unexpected,
      selectedChecks: async () => unexpected(),
      testConfigurations: unexpected,
      readGit: async () => unexpected(),
      plan: async () => unexpected(),
      execute: async () => unexpected(),
    },
    options: { root: '/control/source', destination: '/control/frozen', admittedUntracked: [] },
  }));
}

test('qualification driver refuses incomplete, duplicate, cross-compiled and foreign platform jobs', () => {
  expect(() => requireNativePlatformAttempts(attempts(NATIVE_EXECUTION_PLATFORMS))).not.toThrow();
  for (const platforms of [
    NATIVE_EXECUTION_PLATFORMS.slice(1),
    [...NATIVE_EXECUTION_PLATFORMS, 'linux-arm64'],
    ['linux-arm64', 'linux-arm64', 'linux-x86_64', 'darwin-x86_64'],
    ['darwin-arm64', 'linux-arm64', 'linux-x86_64', 'wasm32'],
  ])
    expect(() => requireNativePlatformAttempts(attempts(platforms))).toThrow('exactly the four');
});

test('partial qualification cannot reserve nonces or publish a platform report', async () => {
  let entered = false;
  const unexpected = () => {
    entered = true;
    throw new Error('Partial platform inventory crossed the controller boundary');
  };
  const executorPolicy = parseExecutorPolicy({
    pools: NATIVE_EXECUTION_PLATFORMS.map((platform, index) => ({
      platform,
      provider: platform.startsWith('linux-') ? 'hosted' : 'registered',
      pool: `control-${platform}`,
      executionPlatform: `//control:platform_${index}`,
      imageDigest: 'a'.repeat(64),
      sdkDigest: 'b'.repeat(64),
      containerImage: platform.startsWith('linux-')
        ? `registry.invalid/control@sha256:${'a'.repeat(64)}`
        : null,
    })),
  });
  await expect(
    verifyNativePlatformBatch({
      executorPolicy,
      signal: new AbortController().signal,
      attempts: attempts(['darwin-arm64']),
      store: { read: unexpected, compareExchange: unexpected },
      force: true,
      expectationOutputs: [],
      retainReports: unexpected,
      publishAdmission: unexpected,
    }),
  ).rejects.toThrow('exactly the four');
  expect(entered).toBe(false);
});
