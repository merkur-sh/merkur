/** Operator deployment inputs select workers; they are not execution evidence. */
export const NATIVE_EXECUTION_PLATFORMS = [
  'darwin-arm64',
  'darwin-x86_64',
  'linux-arm64',
  'linux-x86_64',
] as const;

export type NativeExecutionPlatform = (typeof NATIVE_EXECUTION_PLATFORMS)[number];

export interface ExecutorPool {
  readonly platform: NativeExecutionPlatform;
  readonly provider: 'hosted' | 'registered';
  /** Explicit empty string selects the documented default pool; omission never does. */
  readonly pool: string;
  readonly executionPlatform: string;
  /** Linux OCI image; macOS provisioned OS image identity, both immutable. */
  readonly imageDigest: string;
  readonly sdkDigest: string;
  readonly containerImage: string | null;
}

export interface ExecutorPolicy {
  readonly pools: readonly ExecutorPool[];
}

const fields = [
  'containerImage',
  'executionPlatform',
  'imageDigest',
  'platform',
  'pool',
  'provider',
  'sdkDigest',
]
  .sort()
  .join(',');

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function digest(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

/** Missing pools/images cannot silently select an ambient or differently configured host. */
export function parseExecutorPolicy(value: unknown): ExecutorPolicy {
  if (!record(value) || Object.keys(value).join(',') !== 'pools' || !Array.isArray(value.pools))
    throw new Error('Executor policy requires the complete native pool inventory');
  const pools: ExecutorPool[] = [];
  for (const entry of value.pools) {
    if (
      !record(entry) ||
      Object.keys(entry).sort().join(',') !== fields ||
      !NATIVE_EXECUTION_PLATFORMS.includes(entry.platform as NativeExecutionPlatform) ||
      (entry.provider !== 'hosted' && entry.provider !== 'registered') ||
      typeof entry.pool !== 'string' ||
      entry.pool.trim() !== entry.pool ||
      !/^[a-zA-Z0-9_.-]*$/.test(entry.pool) ||
      typeof entry.executionPlatform !== 'string' ||
      !/^\/\/[^:,\s]*:[^:,\s]+$/.test(entry.executionPlatform) ||
      !digest(entry.imageDigest) ||
      !digest(entry.sdkDigest)
    )
      throw new Error('Executor pool requires exact platform, pool, image and SDK identities');
    const platform = entry.platform as NativeExecutionPlatform;
    if (platform.startsWith('linux-')) {
      if (
        entry.provider !== 'hosted' ||
        typeof entry.containerImage !== 'string' ||
        !/^[^\s@]+@sha256:[a-f0-9]{64}$/.test(entry.containerImage) ||
        !entry.containerImage.endsWith(`@sha256:${String(entry.imageDigest)}`)
      )
        throw new Error('Hosted Linux execution requires its exact digest-pinned OCI image');
    } else if (
      entry.containerImage !== null ||
      (platform === 'darwin-x86_64' && entry.provider !== 'registered')
    ) {
      throw new Error(
        'Native Intel macOS requires a registered standing pool; Macs do not use OCI',
      );
    }
    pools.push(
      Object.freeze({
        platform,
        provider: entry.provider as ExecutorPool['provider'],
        pool: entry.pool,
        executionPlatform: entry.executionPlatform,
        imageDigest: entry.imageDigest,
        sdkDigest: entry.sdkDigest,
        containerImage: entry.containerImage as string | null,
      }),
    );
  }
  if (
    pools.length !== NATIVE_EXECUTION_PLATFORMS.length ||
    new Set(pools.map((pool) => pool.platform)).size !== pools.length ||
    new Set(pools.map((pool) => pool.executionPlatform)).size !== pools.length
  )
    throw new Error('Exactly one independently configured pool per native platform is required');
  return Object.freeze({
    pools: Object.freeze(
      NATIVE_EXECUTION_PLATFORMS.map((platform) => {
        const pool = pools.find((item) => item.platform === platform);
        if (pool === undefined) throw new Error('Missing native execution pool');
        return pool;
      }),
    ),
  });
}

/** BuildBuddy scheduling properties; the engine still validates actual action execution. */
export function executorFlags(
  supplied: ExecutorPolicy,
  platform: NativeExecutionPlatform,
): readonly string[] {
  const policy = parseExecutorPolicy(supplied);
  const pool = policy.pools.find((item) => item.platform === platform);
  if (pool === undefined) throw new Error('Unknown native execution platform');
  const properties: Record<string, string> = {
    OSFamily: platform.startsWith('linux-') ? 'linux' : 'darwin',
    Arch: platform.endsWith('arm64') ? 'arm64' : 'amd64',
    Pool: pool.pool,
    'use-self-hosted-executors': pool.provider === 'registered' ? 'true' : 'false',
  };
  if (pool.containerImage !== null) properties['container-image'] = pool.containerImage;
  return Object.freeze([
    '--remote_executor=grpcs://remote.buildbuddy.io',
    `--extra_execution_platforms=${pool.executionPlatform}`,
    ...Object.entries(properties)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => `--remote_default_exec_properties=${key}=${value}`),
  ]);
}
