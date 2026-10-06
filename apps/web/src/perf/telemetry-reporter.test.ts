import { beforeAll, describe, expect, test } from 'bun:test';
import type { LinkQualitySample } from './link-quality-aggregator';
import { type BrowserLinkReportBody, createTelemetryReporter } from './telemetry-reporter';

beforeAll(() => {
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      visibilityState: 'visible',
      addEventListener(): void {},
      removeEventListener(): void {},
    },
  });
});

function sampleWithRtt(rttMs: number): LinkQualitySample {
  return {
    rttMs,
    inputAckRttMs: 12,
    path: 'direct',
    linkState: 'ready',
    degraded: false,
    txBytes: 1_024,
    rxBytes: 2_048,
  };
}

/**
 * `send` resolves only when the harness says so, which is what makes the
 * one-in-flight rule observable: until `settle` runs, the reporter is mid-send.
 */
function createHarness(): {
  readonly sent: BrowserLinkReportBody[];
  readonly settle: () => Promise<void>;
  readonly reporter: ReturnType<typeof createTelemetryReporter>;
} {
  const sent: BrowserLinkReportBody[] = [];
  const pending: Array<() => void> = [];
  let nowMs = 0;
  const reporter = createTelemetryReporter({
    send: (body) => {
      sent.push(body);
      return new Promise<void>((resolve) => pending.push(resolve));
    },
    now: () => (nowMs += 1_000),
  });
  return {
    sent,
    reporter,
    async settle() {
      for (const resolve of pending.splice(0)) resolve();
      // One turn for the `.finally` that clears the in-flight flag.
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}

describe('telemetry reporter streaming cadence', () => {
  test('posts each observed sample rather than waiting for a window', async () => {
    const { sent, settle, reporter } = createHarness();

    reporter.observeLink(sampleWithRtt(30));
    expect(sent).toHaveLength(1);
    expect(sent[0]?.sampleCount).toBe(1);
    expect(sent[0]?.rttP50Ms).toBe(30);

    await settle();
    reporter.observeLink(sampleWithRtt(40));
    expect(sent).toHaveLength(2);
    expect(sent[1]?.sampleCount).toBe(1);
  });

  test('samples observed during an outstanding send coalesce into the next report', async () => {
    const { sent, settle, reporter } = createHarness();

    reporter.observeLink(sampleWithRtt(30));
    expect(sent).toHaveLength(1);

    // Still in flight: these must not each open their own request.
    reporter.observeLink(sampleWithRtt(40));
    reporter.observeLink(sampleWithRtt(50));
    expect(sent).toHaveLength(1);

    await settle();
    // Nothing drives a send but an observation, so the coalesced pair rides out
    // with the next one.
    reporter.observeLink(sampleWithRtt(60));
    expect(sent).toHaveLength(2);
    expect(sent[1]?.sampleCount).toBe(3);
  });

  test('a session that never produces a sample posts nothing', () => {
    const { sent, reporter } = createHarness();
    reporter.stop();
    expect(sent).toHaveLength(0);
  });
});

describe('telemetry reporter consent boundary', () => {
  test('stop flushes samples accumulated behind an outstanding send', async () => {
    const { sent, settle, reporter } = createHarness();

    reporter.observeLink(sampleWithRtt(30));
    reporter.observeLink(sampleWithRtt(40));
    await settle();
    reporter.stop();

    expect(sent).toHaveLength(2);
    expect(sent[1]?.sampleCount).toBe(1);
  });

  test('discard drops what is accumulated instead of posting it', async () => {
    const { sent, settle, reporter } = createHarness();

    reporter.observeLink(sampleWithRtt(30));
    // Accumulates behind the outstanding send rather than posting.
    reporter.observeLink(sampleWithRtt(40));
    await settle();
    reporter.discard();

    // What was accumulated before the user turned reporting off must never
    // reach the server. This is the whole point of `discard` existing.
    expect(sent).toHaveLength(1);
  });

  test('a discarded reporter accepts no further samples and cannot be flushed', async () => {
    const { sent, settle, reporter } = createHarness();

    reporter.discard();
    reporter.observeLink(sampleWithRtt(30));
    await settle();
    reporter.stop();

    expect(sent).toHaveLength(0);
  });
});
