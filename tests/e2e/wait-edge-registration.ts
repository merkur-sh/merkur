import { RedisClient } from 'bun';
import { waitForHarnessEdgeRegistration } from './global-setup';

const [redisPort, edgeId, edgeUrl, certHash] = process.argv.slice(2);
if (
  redisPort === undefined ||
  edgeId === undefined ||
  edgeUrl === undefined ||
  certHash === undefined
) {
  throw new Error(
    'edge registration probe requires Redis port, edge ID, URL, and certificate hash',
  );
}

// Playwright runs on Node; keep the native Redis connection in an owned Bun process.
const client = new RedisClient(`redis://127.0.0.1:${redisPort}`, {
  autoReconnect: false,
  enableOfflineQueue: false,
  connectionTimeout: 5_000,
});
try {
  await client.connect();
  await waitForHarnessEdgeRegistration(
    async () => {
      // Read both values atomically, as the old MULTI/EXEC did.
      const reply: unknown = await client.send('EVAL', [
        "return {redis.call('GET', KEYS[1]), redis.call('ZSCORE', KEYS[2], ARGV[1])}",
        '2',
        `merkur:edge:registration:${edgeId}`,
        'merkur:edge:registrations',
        edgeId,
      ]);
      if (!Array.isArray(reply)) throw new Error('invalid edge registration reply');
      return { record: reply[0], score: typeof reply[1] === 'string' ? Number(reply[1]) : null };
    },
    { edgeId, edgeUrl, certHash },
    AbortSignal.timeout(45_000),
  );
} finally {
  client.close();
}
