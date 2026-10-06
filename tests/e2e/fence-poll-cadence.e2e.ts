import { expect, test } from '@playwright/test';

/**
 * Prove, in a real browser, that the fence poll chain's cadence is what the
 * code asks for rather than what the HTML timer nesting rule silently imposes.
 *
 * This is the load-bearing claim behind `FENCE_POLL_INTERVAL_MS` and
 * `fencePollBounce` in `apps/web/src/terminal-worker.ts`, and it is not
 * checkable from a unit test: the clamp lives in the browser's timer
 * implementation, not in any code this repo owns. Production said it was real —
 * `poll_count` p50 6, fence wait p50 5.77 / 9.85 / 14.94 / 20.80 ms at 6 / 7 /
 * 8 / 9 polls, and effectively no observation-error samples between 0.5 ms and
 * 4 ms across 65k frames — but production cannot be re-run against a candidate.
 *
 * Runs in a dedicated worker rather than on the page, because that is where the
 * fence chain runs and because a nesting rule that differed between the two
 * would invalidate the fix precisely where it is applied.
 */

/** Per the HTML timer initialisation steps: nesting level > 5 clamps to >= 4ms. */
const CLAMP_THRESHOLD_MS = 4;
const SAMPLES = 12;

const WORKER_SOURCE = `
// A self-rearming setTimeout chain — what the fence poll used to be.
function nested(samples) {
  return new Promise((resolve) => {
    const gaps = [];
    let last = performance.now();
    const step = () => {
      const now = performance.now();
      gaps.push(now - last);
      last = now;
      if (gaps.length >= samples) { resolve(gaps); return; }
      setTimeout(step, 0);
    };
    setTimeout(step, 0);
  });
}

// Alternating port -> timer. Every setTimeout is called from a MESSAGE task,
// where the timer nesting level is zero, so each timer is level one.
function bounced(samples, delayMs) {
  return new Promise((resolve) => {
    const gaps = [];
    const channel = new MessageChannel();
    let last = performance.now();
    channel.port1.onmessage = () => {
      setTimeout(() => {
        const now = performance.now();
        gaps.push(now - last);
        last = now;
        if (gaps.length >= samples) { channel.port1.close(); channel.port2.close(); resolve(gaps); return; }
        channel.port2.postMessage(0);
      }, delayMs);
    };
    channel.port2.postMessage(0);
  });
}

self.onmessage = async (event) => {
  const { samples, delayMs } = event.data;
  const nestedGaps = await nested(samples);
  const bouncedGaps = await bounced(samples, delayMs);
  self.postMessage({ nestedGaps, bouncedGaps });
};
`;

test.describe('fence poll cadence', () => {
  test('bouncing through a port defeats the timer nesting clamp', async ({ page }) => {
    await page.goto('about:blank');

    const result = await page.evaluate(
      async ({ source, samples, delayMs }) => {
        const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
        const worker = new Worker(url);
        try {
          const measured = await new Promise<{ nestedGaps: number[]; bouncedGaps: number[] }>(
            (resolve, reject) => {
              const timer = setTimeout(() => reject(new Error('worker timed out')), 20_000);
              worker.onmessage = (event) => {
                clearTimeout(timer);
                resolve(event.data);
              };
              worker.onerror = (event) => {
                clearTimeout(timer);
                reject(new Error(String(event.message)));
              };
              worker.postMessage({ samples, delayMs });
            },
          );
          return measured;
        } finally {
          worker.terminate();
          URL.revokeObjectURL(url);
        }
      },
      { source: WORKER_SOURCE, samples: SAMPLES, delayMs: 1 },
    );

    const median = (values: number[]): number => {
      const sorted = [...values].sort((a, b) => a - b);
      return sorted[Math.floor(sorted.length / 2)] ?? Number.NaN;
    };

    // The tail of each chain, past the point where nesting has accumulated.
    // The first few of the nested chain are genuinely fast — that is the
    // inversion being fixed, not a counter-example.
    const nestedTail = result.nestedGaps.slice(6);
    const bouncedTail = result.bouncedGaps.slice(6);
    const nestedMedian = median(nestedTail);
    const bouncedMedian = median(bouncedTail);

    // biome-ignore lint/suspicious/noConsole: harness diagnostic output
    console.log(
      `[fence-poll-cadence] nested=${result.nestedGaps.map((g) => g.toFixed(2)).join(',')}\n` +
        `[fence-poll-cadence] bounced=${result.bouncedGaps.map((g) => g.toFixed(2)).join(',')}`,
    );

    // The clamp is real: without the bounce the chain cannot poll faster than
    // ~4ms once nested, however small a delay it asks for.
    expect(nestedMedian).toBeGreaterThanOrEqual(CLAMP_THRESHOLD_MS * 0.9);

    // And the bounce defeats it. Asserted as a ratio as well as an absolute so
    // this fails loudly if a browser ever starts clamping message-sourced
    // timers too, which would make the fix inert rather than wrong.
    expect(bouncedMedian).toBeLessThan(CLAMP_THRESHOLD_MS * 0.9);
    expect(bouncedMedian).toBeLessThan(nestedMedian);
  });
});
