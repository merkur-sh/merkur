import { withDragonflyContainer } from './dragonfly-container';

await withDragonflyContainer(async ({ redisUrl }) => {
  const processHandle = Bun.spawn(
    [
      'bun',
      'test',
      'apps/server/src/services/redis-service.dragonfly.test.ts',
      'apps/server/src/services/browser-session-presence.dragonfly.test.ts',
      'apps/server/src/services/realtime-coordination-service.dragonfly.test.ts',
      'apps/server/src/services/auth-flow-store.dragonfly.test.ts',
      'apps/server/src/services/rate-limit-service.dragonfly.test.ts',
      'apps/server/src/services/edge-registry-service.dragonfly.test.ts',
      'apps/server/src/services/daemon-control-service.dragonfly.test.ts',
      'apps/server/src/http/daemon-request-auth.dragonfly.test.ts',
      'apps/server/src/services/session-issuance-service.dragonfly.test.ts',
    ],
    {
      env: { ...process.env, DRAGONFLY_TEST_URL: redisUrl },
      stdout: 'inherit',
      stderr: 'inherit',
    },
  );
  const exitCode = await processHandle.exited;
  if (exitCode !== 0) {
    throw new Error(`Dragonfly integration tests exited with ${exitCode}`);
  }
});
