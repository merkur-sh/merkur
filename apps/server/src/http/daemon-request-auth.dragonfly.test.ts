import { expect, test } from 'bun:test';
import { daemonHttpProofHeaders, signDaemonProof } from '@merkur/auth';
import { RedisClient } from 'bun';
import { Effect } from 'effect';

import { createRedisCommandClient, RedisError, type RedisService } from '../services/redis-service';
import { DAEMON_TEST_SEED, daemonAuthFixture } from './daemon-auth-fixture';
import { authorizeDaemonRequest, parseDaemonJsonBody } from './daemon-request-auth';

const dragonflyUrl = process.env.DRAGONFLY_TEST_URL;
if (dragonflyUrl === undefined) {
  test.skip('daemon HTTP replay rejection across live Dragonfly connections', () => {});
} else {
  test('daemon HTTP replay rejection across live Dragonfly connections', async () => {
    const clients = [new RedisClient(dragonflyUrl), new RedisClient(dragonflyUrl)];
    await Promise.all(clients.map((client) => client.connect()));
    const url = 'https://merkur.test/api/daemon/perf';
    const body = '{}';
    const headers = {
      'content-type': 'application/json',
      ...(await daemonHttpProofHeaders(
        'daemon-1',
        async (transcript) => signDaemonProof(DAEMON_TEST_SEED, 'http', transcript),
        'POST',
        url,
        'application/json',
        new TextEncoder().encode(body),
        Date.now(),
      )),
    };
    const replayKey = `merkur:daemon-proof:daemon-1:${new Headers(headers).get('x-merkur-nonce')}`;
    try {
      const fixtures = clients.map((client) => {
        const unused = () => Effect.die(new Error('Unexpected Redis fixture call'));
        const redis: RedisService = {
          useCommands: (fn) =>
            Effect.tryPromise({
              try: async () => fn(createRedisCommandClient(client)),
              catch: (cause) =>
                new RedisError({ cause, message: 'Dragonfly test operation failed' }),
            }),
          publish: unused,
          subscribe: unused,
          unsubscribe: unused,
          healthSnapshot: unused,
        };
        return daemonAuthFixture({ origin: 'https://merkur.test', redis });
      });
      const outcomes = await Promise.all(
        fixtures.map(async (f) => {
          const request = new Request(url, { method: 'POST', headers, body });
          await parseDaemonJsonBody({ request });
          return authorizeDaemonRequest(f.runProgram, request, f.logger);
        }),
      );
      expect(outcomes.filter((value) => value !== null)).toHaveLength(1);
      const client = clients[0];
      if (client === undefined) throw new Error('Missing Redis connection');
      const ttl = await client.pttl(replayKey);
      expect(ttl).toBeGreaterThan(120_000);
      expect(ttl).toBeLessThanOrEqual(121_000);
    } finally {
      await clients[0]?.del(replayKey);
      for (const client of clients) client.close();
    }
  });
}
