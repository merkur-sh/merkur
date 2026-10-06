import { describe, expect, test } from 'bun:test';
import { createSocket, type Socket } from 'node:dgram';
import { requestProxyImpairmentStats } from './edge-network-control';
import {
  PROXY_CONTROL_CHUNK_PAYLOAD_BYTES,
  PROXY_CONTROL_MAX_DATAGRAM_BYTES,
  PROXY_DELAY_HISTOGRAM_BUCKETS,
} from './edge-network-stats';

describe('delay proxy chunked control client', () => {
  test('round-trips a macOS-oversized full stats payload over real loopback UDP', async () => {
    const server = await bindLoopbackServer();
    try {
      server.on('message', (request, remote) => {
        const [kind, nonce, extra] = request.toString('utf8').split(':');
        if (kind !== 'stats' || nonce === undefined || extra !== undefined) return;
        const payload = Buffer.from(JSON.stringify(emptyProxyStats()));
        expect(payload.length).toBeGreaterThan(9_216);
        const chunks = encodeControlChunks(kind, nonce, 11, payload);
        expect(chunks.length).toBeGreaterThan(1);
        expect(Math.max(...chunks.map((chunk) => chunk.length))).toBeLessThanOrEqual(
          PROXY_CONTROL_MAX_DATAGRAM_BYTES,
        );
        const stale = Buffer.from(
          chunks[0]?.toString('utf8').replace(`"nonce":"${nonce}"`, `"nonce":"stale-${nonce}"`) ??
            '',
        );
        server.send(stale, remote.port, remote.address);
        for (const chunk of [...chunks].reverse()) server.send(chunk, remote.port, remote.address);
        // A retried/cached native response may repeat an already received chunk.
        server.send(chunks[0] ?? Buffer.alloc(0), remote.port, remote.address);
      });

      const result = await requestProxyImpairmentStats(server.address().port, 'stats');
      expect(result.schemaVersion).toBe(9);
      expect(result.relays).toEqual([]);
      expect(result.config.profile).toBe('fast');
      expect(result.epoch).toBe(1);
      expect(result.upstream.scheduledDelayUs.histogram).toHaveLength(
        PROXY_DELAY_HISTOGRAM_BUCKETS,
      );
    } finally {
      await closeSocket(server);
    }
  });

  test('retries one incomplete reset reply under the same nonce without applying reset twice', async () => {
    const server = await bindLoopbackServer();
    const requests: Buffer[] = [];
    const sentResponseIds: number[] = [];
    const responsesByAttempt: Buffer[][] = [];
    let resetApplicationCount = 0;
    let cachedResponses: Buffer[] = [];
    try {
      server.on('message', (request, remote) => {
        const rawRequest = request.toString('utf8');
        const [kind, nonce, extra] = rawRequest.split(':');
        if (kind !== 'reset' || nonce === undefined || extra !== undefined) return;
        requests.push(Buffer.from(request));

        if (cachedResponses.length === 0) {
          resetApplicationCount += 1;
          const payload = Buffer.from(
            JSON.stringify({ ...emptyProxyStats(), epoch: resetApplicationCount }),
          );
          cachedResponses = encodeControlChunks(kind, nonce, 31, payload);
        }
        const responses = cachedResponses;
        expect(responses.length).toBeGreaterThan(2);
        const omittedInteriorIndex = Math.floor(responses.length / 2);
        expect(omittedInteriorIndex).toBeGreaterThan(0);
        expect(omittedInteriorIndex).toBeLessThan(responses.length - 1);
        const sentThisAttempt: Buffer[] = [];
        for (const [index, response] of responses.entries()) {
          // The first native send succeeds, but one interior UDP datagram is
          // lost after admission. The retry reaches the nonce-exact response
          // cache and replays the same snapshot rather than resetting again.
          if (requests.length === 1 && index === omittedInteriorIndex) continue;
          const envelope = JSON.parse(response.toString('utf8')) as { responseId?: unknown };
          if (typeof envelope.responseId === 'number') sentResponseIds.push(envelope.responseId);
          sentThisAttempt.push(Buffer.from(response));
          server.send(response, remote.port, remote.address);
        }
        responsesByAttempt.push(sentThisAttempt);
      });

      const result = await requestProxyImpairmentStats(server.address().port, 'reset');
      // Let one client retry interval pass: resolution must have closed the
      // socket, and a late retry must not mutate the native reset epoch.
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(result.epoch).toBe(1);
      expect(resetApplicationCount).toBe(1);
      expect(requests.length).toBeGreaterThanOrEqual(2);
      expect(requests.every((request) => request.equals(requests[0] ?? Buffer.alloc(0)))).toBe(
        true,
      );
      expect(responsesByAttempt[0]).toHaveLength(cachedResponses.length - 1);
      expect(responsesByAttempt[1]).toEqual(cachedResponses);
      expect(new Set(sentResponseIds)).toEqual(new Set([31]));
    } finally {
      await closeSocket(server);
    }
  });

  test('rejects chunks mixed from distinct native snapshots under one nonce', async () => {
    const server = await bindLoopbackServer();
    try {
      server.on('message', (request, remote) => {
        const [kind, nonce, extra] = request.toString('utf8').split(':');
        if (kind !== 'stats' || nonce === undefined || extra !== undefined) return;
        const payload = Buffer.from(JSON.stringify(emptyProxyStats()));
        const chunks = encodeControlChunks(kind, nonce, 21, payload);
        server.send(chunks[0] ?? Buffer.alloc(0), remote.port, remote.address);
        const mixed = Buffer.from(
          (chunks[1] ?? Buffer.alloc(0))
            .toString('utf8')
            .replace('"responseId":21', '"responseId":22'),
        );
        server.send(mixed, remote.port, remote.address);
      });

      await expect(requestProxyImpairmentStats(server.address().port, 'stats')).rejects.toThrow(
        'mixed control response snapshots',
      );
    } finally {
      await closeSocket(server);
    }
  });
});

function encodeControlChunks(
  kind: 'reset' | 'stats',
  nonce: string,
  responseId: number,
  payload: Buffer,
): Buffer[] {
  const chunkCount = Math.ceil(payload.length / PROXY_CONTROL_CHUNK_PAYLOAD_BYTES);
  return Array.from({ length: chunkCount }, (_, chunkIndex) => {
    const chunk = payload.subarray(
      chunkIndex * PROXY_CONTROL_CHUNK_PAYLOAD_BYTES,
      Math.min((chunkIndex + 1) * PROXY_CONTROL_CHUNK_PAYLOAD_BYTES, payload.length),
    );
    return Buffer.from(
      JSON.stringify({
        kind,
        nonce,
        responseId,
        chunkIndex,
        chunkCount,
        payloadByteLength: payload.length,
        payloadBase64: chunk.toString('base64'),
      }),
    );
  });
}

function emptyProxyStats(): Record<string, unknown> {
  return {
    schemaVersion: 9,
    epoch: 1,
    config: {
      profile: 'fast',
      targetRttMs: 50,
      baseDelayUs: 12_500,
      jitterRadiusUs: 1_250,
      datagramLossPercent: 0,
      faultSite: 'edge-to-client',
      faultSitesPerLogicalDirection: 1,
      reorder: 'none',
      scenario: 'steady',
      seed: 1_296_388_675,
    },
    upstream: emptyDirectionStats(),
    downstream: emptyDirectionStats(),
    logicalPathImpairment: {
      faultSite: 'edge-to-client',
      faultSitesPerLogicalDirection: 1,
      requestedDatagramLossPercent: 0,
      observedFaultSitePackets: 0,
      droppedAtFaultSite: 0,
      achievedPacketLossPercent: 0,
    },
    harnessDrops: { oversized: 0, admission: 0, leaseExhausted: 0 },
    splitDatagrams: 0,
    pendingScheduledPackets: 0,
    exactLossWindowsCompleted: 0,
    exactLossDroppedInCompletedWindows: 0,
    relays: [],
    links: [],
    relayLinks: [],
  };
}

function emptyDirectionStats(): Record<string, unknown> {
  return {
    seen: 0,
    forwarded: 0,
    dropped: 0,
    exactLossDropped: 0,
    burstLossDropped: 0,
    burstLossRunsCompleted: 0,
    jittered: 0,
    reorderInversions: 0,
    reordered: 0,
    congested: 0,
    congestedForwarded: 0,
    congestionClamped: 0,
    maxCongestionQueueDelayUs: 0,
    maxForwardedCongestionQueueDelayUs: 0,
    achievedPacketLossPercent: 0,
    scheduledDelayUs: emptyDelayDistribution(),
    releaseTargetResidenceUs: emptyDelayDistribution(),
    actualResidenceUs: emptyDelayDistribution(),
    releaseOvershootUs: emptyDelayDistribution(),
    releaseEarlyCount: 0,
    maxReleaseEarlyUs: 0,
  };
}

function emptyDelayDistribution(): Record<string, unknown> {
  return {
    count: 0,
    mean: 0,
    min: 0,
    p50: 0,
    p95: 0,
    p99: 0,
    max: 0,
    histogramBucketUs: 500,
    histogram: Array<number>(PROXY_DELAY_HISTOGRAM_BUCKETS).fill(0),
  };
}

async function bindLoopbackServer(): Promise<Socket> {
  const socket = createSocket('udp6');
  await new Promise<void>((resolve, reject) => {
    socket.once('error', reject);
    socket.bind(0, '::1', () => {
      socket.off('error', reject);
      resolve();
    });
  });
  return socket;
}

function closeSocket(socket: Socket): Promise<void> {
  return new Promise((resolve) => socket.close(() => resolve()));
}
