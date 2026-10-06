import { describe, expect, test } from 'bun:test';
import type { TerminalPerfEvent } from '../../../apps/web/src/perf/terminal-latency';
import {
  graphicsContentionAttribution,
  graphicsDaemonTerms,
  graphicsEgressBetween,
} from './graphics-contention';

function egress(
  atMs: number,
  hop: 'daemon' | 'edge',
  interactiveBlocked: number,
  interactiveWaitedUs: number,
  series = 1,
): TerminalPerfEvent {
  return {
    kind: 'transport_egress',
    atMs,
    observationEpoch: 1,
    hop,
    series,
    interactive: { blocked: interactiveBlocked, paced: 0, waitedUs: interactiveWaitedUs },
    bulk: { blocked: 0, paced: 0, waitedUs: 0 },
  };
}

function residence(atMs: number, slow: number): TerminalPerfEvent {
  return {
    kind: 'edge_forward_residence',
    atMs,
    observationEpoch: 1,
    series: 1,
    buckets: [5, 0, 0, 0, 0, 0, 0, 0, 0, slow, 0, 0],
  };
}

function timing(inputSeq: number, writeCompletionUs: number | null): TerminalPerfEvent {
  return {
    kind: 'daemon_timing',
    atMs: 0,
    inputSeq,
    recvToPtyUs: 8,
    ptyToReadUs: 100,
    gridApplyUs: 20,
    displayCoalesceUs: 1,
    selectCaptureUs: 50,
    prepareQueueUs: 0,
    encodeUs: 12,
    compressionUs: 0,
    completionQueueUs: 0,
    transportSubmitUs: 4,
    writeCompletionUs,
    ackTransmitUs: 900,
    ownerCpuUs: 30,
    ownerOffCpuUs: 60,
    ownerQuinnWaitUs: 50,
    ownerRegistryWaitUs: 0,
    flushLockWaitUs: 20,
    batchSeq: 1,
    observationEpoch: 1,
  };
}

describe('graphics contention attribution', () => {
  test('a member owns the snapshots between its arm and the next arm', () => {
    const events = [
      egress(10, 'daemon', 1, 100),
      residence(10, 0),
      egress(50, 'daemon', 3, 7_100),
      residence(60, 2),
      // The next member's arm is at 100: this snapshot is not ours.
      egress(120, 'daemon', 9, 9_000),
    ];
    expect(graphicsEgressBetween(events, 20, 100)).toEqual({
      daemon: {
        interactive: { blocked: 2, paced: 0, waitedUs: 7_000 },
        bulk: { blocked: 0, paced: 0, waitedUs: 0 },
      },
      edge: null,
      edgeForwardResidence: [0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0],
    });
  });

  test('a replaced group reads unknown, even when its counters grew', () => {
    const events = [egress(10, 'edge', 5, 500, 1), egress(50, 'edge', 9, 900, 2)];
    expect(graphicsEgressBetween(events, 20, 100).edge).toBeNull();
  });

  test('a counter that wrapped within its group is an exact step', () => {
    // Waits accumulate for the group's lifetime; u32 microseconds wrap.
    const events = [egress(10, 'daemon', 5, 2 ** 32 - 100), egress(50, 'daemon', 6, 400)];
    expect(graphicsEgressBetween(events, 20, 100).daemon).toEqual({
      interactive: { blocked: 1, paced: 0, waitedUs: 500 },
      bulk: { blocked: 0, paced: 0, waitedUs: 0 },
    });
  });

  test('the first group after none counts from zero', () => {
    const events = [egress(10, 'daemon', 0, 0, 0), egress(50, 'daemon', 2, 300, 7)];
    expect(graphicsEgressBetween(events, 20, 100).daemon).toEqual({
      interactive: { blocked: 2, paced: 0, waitedUs: 300 },
      bulk: { blocked: 0, paced: 0, waitedUs: 0 },
    });
  });

  test('the daemon ACK share needs every acknowledgment boundary', () => {
    const events = [timing(3, 40), timing(4, null)];
    expect(graphicsDaemonTerms(events, 3)?.ackUs).toBe(8 + 40 + 900);
    expect(graphicsDaemonTerms(events, 4)?.ackUs).toBeNull();
    expect(graphicsDaemonTerms(events, 5)).toBeNull();
  });

  test('the daemon echo share is all ten terms, and the owner rides beside it', () => {
    const terms = graphicsDaemonTerms([timing(3, 40)], 3);
    expect(terms?.echoUs).toBe(8 + 100 + 20 + 1 + 50 + 0 + 12 + 0 + 0 + 4);
    expect(terms).toMatchObject({
      ownerCpuUs: 30,
      ownerOffCpuUs: 60,
      ownerQuinnWaitUs: 50,
      ownerRegistryWaitUs: 0,
      flushLockWaitUs: 20,
    });
  });

  function member(inputAckMs: number, ackUs: number, echoUs: number, quinnWaitUs: number) {
    return {
      inputAckMs,
      fenceMs: inputAckMs + 1,
      daemon: {
        recvToPtyUs: 0,
        writeCompletionUs: 0,
        ackTransmitUs: ackUs,
        ackUs,
        ptyToReadUs: 0,
        gridApplyUs: 0,
        displayCoalesceUs: 0,
        selectCaptureUs: 0,
        encodeUs: 0,
        transportSubmitUs: 0,
        echoUs,
        ownerCpuUs: 100,
        ownerOffCpuUs: quinnWaitUs,
        ownerQuinnWaitUs: quinnWaitUs,
        ownerRegistryWaitUs: 0,
        flushLockWaitUs: quinnWaitUs / 2,
      },
      egress: { daemon: null, edge: null, edgeForwardResidence: null },
    };
  }

  test('the paired ACK tail splits into the daemon share and the rest of the path', () => {
    // The image arm's ACK is 7 ms later, and the daemon accounts for 1 ms.
    const pairs = Array.from({ length: 20 }, () => ({
      control: member(0.7, 100, 500, 0),
      image: member(7.7, 1_100, 500, 0),
    }));
    const attribution = graphicsContentionAttribution(pairs);
    expect(attribution.pairsWithDaemonAck).toBe(20);
    expect(attribution.daemonAckMs).toMatchObject({ difference: 1 });
    expect('difference' in attribution.pathAckMs && attribution.pathAckMs.difference).toBeCloseTo(
      6,
      9,
    );
  });

  test('the added echo share sits beside the owner lock wait that explains it', () => {
    // The image arm's echo is 2 ms longer, all of it the owner waiting on QUIC
    // connection state, a quarter of that inside the flush.
    const pairs = Array.from({ length: 20 }, () => ({
      control: member(0.7, 100, 500, 0),
      image: member(0.7, 100, 2_500, 2_000),
    }));
    const attribution = graphicsContentionAttribution(pairs);
    expect(attribution.pairsWithDaemonEcho).toBe(20);
    expect(attribution.daemonEchoMs).toMatchObject({ difference: 2 });
    expect(attribution.owner.quinnWaitMs).toMatchObject({ difference: 2 });
    expect(attribution.owner.offCpuMs).toMatchObject({ difference: 2 });
    expect(attribution.owner.flushLockWaitMs).toMatchObject({ difference: 1 });
    expect(attribution.owner.registryWaitMs).toMatchObject({ difference: 0 });
    expect(attribution.owner.cpuMs).toMatchObject({ difference: 0 });
    expect(attribution.image.daemonUs.ownerQuinnWait).toMatchObject({ count: 20, p95: 2_000 });
  });
});
