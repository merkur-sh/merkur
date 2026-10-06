import { describe, expect, test } from 'bun:test';

import {
  createPredictionRttForwarder,
  forwardPredictionRttSample,
} from './prediction-rtt-forwarding';

describe('forwardPredictionRttSample', () => {
  test('resets the old path before forwarding the first sample from its replacement', () => {
    const calls: string[] = [];

    forwardPredictionRttSample(
      {
        resetSrtt: () => calls.push('reset'),
        updateRtt: (rttMs) => calls.push(`sample:${rttMs}`),
      },
      52,
      true,
    );

    expect(calls).toEqual(['reset', 'sample:52']);
  });

  test('forwards same-path samples without resetting and permits a null transition sample', () => {
    const calls: string[] = [];
    const sink = {
      resetSrtt: () => calls.push('reset'),
      updateRtt: (rttMs: number) => calls.push(`sample:${rttMs}`),
    };

    forwardPredictionRttSample(sink, 18, false);
    forwardPredictionRttSample(sink, null, true);

    expect(calls).toEqual(['sample:18', 'reset']);
  });
});

describe('createPredictionRttForwarder', () => {
  test('replays a first-heartbeat sample that arrived before the worker was ready', () => {
    const calls: string[] = [];
    const forwarder = createPredictionRttForwarder();

    forwarder.observe(146, true);
    forwarder.setSink({
      resetSrtt: () => calls.push('reset'),
      updateRtt: (rttMs) => calls.push(`sample:${rttMs}`),
    });

    expect(calls).toEqual(['reset', 'sample:146']);
  });

  test('retains only the newest bounded sample from the current path', () => {
    const calls: string[] = [];
    const forwarder = createPredictionRttForwarder();

    forwarder.observe(80, true);
    forwarder.observe(72, false);
    forwarder.observe(68, false);
    forwarder.setSink({
      resetSrtt: () => calls.push('reset'),
      updateRtt: (rttMs) => calls.push(`sample:${rttMs}`),
    });

    expect(calls).toEqual(['reset', 'sample:68']);
  });

  test('a sample-less path transition invalidates a retained sample', () => {
    const calls: string[] = [];
    const forwarder = createPredictionRttForwarder();

    forwarder.observe(180, true);
    forwarder.observe(null, true);
    forwarder.setSink({
      resetSrtt: () => calls.push('reset'),
      updateRtt: (rttMs) => calls.push(`sample:${rttMs}`),
    });

    expect(calls).toEqual(['reset']);
  });

  test('detach preserves the sample for a replacement worker while clear drops it', () => {
    const firstCalls: string[] = [];
    const secondCalls: string[] = [];
    const forwarder = createPredictionRttForwarder();
    const first = {
      resetSrtt: () => firstCalls.push('reset'),
      updateRtt: (rttMs: number) => firstCalls.push(`sample:${rttMs}`),
    };

    forwarder.setSink(first);
    forwarder.observe(92, false);
    forwarder.setSink(null);
    forwarder.setSink({
      resetSrtt: () => secondCalls.push('reset'),
      updateRtt: (rttMs) => secondCalls.push(`sample:${rttMs}`),
    });
    forwarder.clear();
    forwarder.setSink(null);
    forwarder.setSink({
      resetSrtt: () => secondCalls.push('reset-after-clear'),
      updateRtt: (rttMs) => secondCalls.push(`sample-after-clear:${rttMs}`),
    });

    expect(firstCalls).toEqual(['reset', 'sample:92']);
    expect(secondCalls).toEqual(['reset', 'sample:92', 'reset', 'reset-after-clear']);
  });

  test('does not retain invalid metrics for a future worker', () => {
    const calls: string[] = [];
    const forwarder = createPredictionRttForwarder();

    forwarder.observe(Number.NaN, true);
    forwarder.observe(-1, false);
    forwarder.setSink({
      resetSrtt: () => calls.push('reset'),
      updateRtt: (rttMs) => calls.push(`sample:${rttMs}`),
    });

    expect(calls).toEqual(['reset']);
  });
});
