import { expect, test } from 'bun:test';
import { executorFlags, NATIVE_EXECUTION_PLATFORMS, parseExecutorPolicy } from './executor-policy';

// Synthetic operator values exercise refusal/selection, never qualify a deployed worker.
function inventory() {
  return {
    pools: NATIVE_EXECUTION_PLATFORMS.map((platform, index) => ({
      platform,
      provider: platform.startsWith('linux-') ? 'hosted' : 'registered',
      pool: `control-${platform}`,
      executionPlatform: `//control:platform_${index}`,
      imageDigest: String(index + 1).repeat(64),
      sdkDigest: 'a'.repeat(64),
      containerImage: platform.startsWith('linux-')
        ? `registry.invalid/control@sha256:${String(index + 1).repeat(64)}`
        : null,
    })),
  };
}

test('native placement retains hosted test caching and exact OS, CPU, pool and image selection', () => {
  const policy = parseExecutorPolicy(inventory());
  const flags = executorFlags(policy, 'linux-arm64');
  expect(flags).toContain('--remote_executor=grpcs://remote.buildbuddy.io');
  expect(flags).toContain('--remote_default_exec_properties=Arch=arm64');
  expect(flags).toContain('--remote_default_exec_properties=OSFamily=linux');
  expect(flags).toContain('--remote_default_exec_properties=Pool=control-linux-arm64');
  expect(
    flags.some((flag) => flag.startsWith('--remote_default_exec_properties=container-image=')),
  ).toBe(true);
  expect(flags.some((flag) => /no.cache|cache_test_results|remote_accept_cached/.test(flag))).toBe(
    false,
  );
  expect(executorFlags(policy, 'darwin-x86_64')).toContain(
    '--remote_default_exec_properties=use-self-hosted-executors=true',
  );
  expect(Object.isFrozen(policy.pools)).toBe(true);
});

test('missing, duplicate, foreign and mutable deployment inventories refuse native-four placement', () => {
  for (const mutate of [
    (value: ReturnType<typeof inventory>) => value.pools.pop(),
    (value: ReturnType<typeof inventory>) => value.pools.push({ ...value.pools[0] } as never),
    (value: ReturnType<typeof inventory>) => {
      const pool = value.pools[0];
      if (pool !== undefined) pool.platform = 'windows-x86_64' as never;
    },
    (value: ReturnType<typeof inventory>) => {
      const pool = value.pools[2];
      if (pool !== undefined) pool.containerImage = 'registry.invalid/control:latest';
    },
    (value: ReturnType<typeof inventory>) => {
      const pool = value.pools[0];
      if (pool !== undefined)
        pool.containerImage = `registry.invalid/linux@sha256:${'a'.repeat(64)}`;
    },
  ]) {
    const value = inventory();
    mutate(value);
    expect(() => parseExecutorPolicy(value)).toThrow();
  }
  const value = inventory();
  const captured = parseExecutorPolicy(value);
  const pool = value.pools[2];
  if (pool !== undefined) pool.pool = 'replaced';
  expect(executorFlags(captured, 'linux-arm64')).toContain(
    '--remote_default_exec_properties=Pool=control-linux-arm64',
  );
});

test('explicit default pools retain exact scheduling properties; absent pools never default', () => {
  const value = inventory();
  for (const pool of value.pools) pool.pool = '';
  const captured = parseExecutorPolicy(value);
  for (const platform of NATIVE_EXECUTION_PLATFORMS) {
    const pool = captured.pools.find((entry) => entry.platform === platform);
    expect(pool?.pool).toBe('');
    const flags = executorFlags(captured, platform);
    expect(flags).toContain('--remote_default_exec_properties=Pool=');
    const registered = platform.startsWith('linux-') ? 'false' : 'true';
    expect(flags).toContain(
      `--remote_default_exec_properties=use-self-hosted-executors=${registered}`,
    );
  }
  for (const replacement of [undefined, null, 0]) {
    const malformed = inventory();
    const first = malformed.pools[0];
    if (first === undefined) throw new Error('Control requires its original four pools');
    if (replacement === undefined) Reflect.deleteProperty(first, 'pool');
    else Object.assign(first, { pool: replacement });
    expect(() => parseExecutorPolicy(malformed)).toThrow();
  }
});
