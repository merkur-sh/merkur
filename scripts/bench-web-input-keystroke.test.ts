import { describe, expect, test } from 'bun:test';

import { parsePerfMetrics } from './perf/harness';
import { runTestProcess, type TestProcessResult } from './test-process';

const ROOT = new URL('..', import.meta.url).pathname;
const SMALL_RUN = {
  BENCH_KEYSTROKES: '256',
  BENCH_SAMPLES: '3',
  BENCH_WARMUPS: '2',
  BENCH_TIMING_SAMPLES: '2',
};
/** Spawns a Bun process that loads the Noise WASM; a loaded machine needs headroom. */
const TIMEOUT_MS = 30_000;

function run(command: readonly string[]): Promise<TestProcessResult> {
  return runTestProcess(command, { cwd: ROOT, env: { ...process.env, ...SMALL_RUN } });
}

describe('web input keystroke benchmark', () => {
  test(
    'reports objects and time per keystroke for every stage of the production path',
    async () => {
      const { stdout, stderr, exitCode } = await run([
        'bun',
        'run',
        'scripts/bench-web-input-keystroke.ts',
      ]);

      expect(exitCode, stderr).toBe(0);
      const metrics = new Map(parsePerfMetrics(stdout).map((metric) => [metric.name, metric]));
      for (const stage of [
        'main-physical-key',
        'transport-send',
        'reader-park',
        'link-activity',
        'touch-tap',
      ]) {
        for (const suffix of ['objects', 'ns']) {
          const metric = metrics.get(`web-input-${stage}-${suffix}`);
          expect(metric, `${stage}-${suffix}`).toBeDefined();
          expect(Number.isFinite(metric?.value)).toBe(true);
        }
      }
      // The keydown/keyup listeners, key records, ring write and prediction
      // admission allocate nothing per key; a record, closure or view minted on
      // that path again would show here first.
      expect(metrics.get('web-input-main-physical-key-objects')?.value).toBeLessThan(2);
    },
    TIMEOUT_MS,
  );

  test(
    'reports the app keyboard layer on a terminal keystroke',
    async () => {
      const { stdout, stderr, exitCode } = await run([
        'bun',
        '--conditions=browser',
        'run',
        'scripts/bench-web-input-keybinds.ts',
      ]);

      expect(exitCode, stderr).toBe(0);
      const metrics = parsePerfMetrics(stdout);
      expect(metrics.map((metric) => metric.name)).toEqual([
        'web-input-app-keybinds-objects',
        'web-input-app-keybinds-ns',
      ]);
      // The document listener runs ahead of the terminal's on every key, and a
      // key it does not bind costs it no filtered, flattened or mapped copy of
      // the registry and no prefix string per binding.
      expect(metrics[0]?.value).toBeLessThan(2);
    },
    TIMEOUT_MS,
  );

  test(
    'reports V8 allocation bytes per keystroke on both tiers',
    async () => {
      const { stdout, stderr, exitCode } = await run([
        'bun',
        'run',
        'scripts/bench-web-input-v8.ts',
      ]);

      expect(exitCode, stderr).toBe(0);
      const metrics = new Map(parsePerfMetrics(stdout).map((metric) => [metric.name, metric]));
      for (const tier of ['default', 'interpreted']) {
        for (const stage of ['session-input', 'reader-park', 'app-keybinds']) {
          const metric = metrics.get(`web-input-v8-${tier}-${stage}-bytes`);
          expect(metric, `${tier}-${stage}`).toBeDefined();
          expect(Number.isFinite(metric?.value)).toBe(true);
        }
      }
      // Interpreted-tier bytes per keystroke. V8 frees an array's backing store
      // on `length = 0`, which JSC does not, so only V8 shows the app keyboard
      // layer's reused arrays reallocating.
      const limits: Record<string, number> = {
        'app-keybinds': 64,
      };
      for (const [stage, limit] of Object.entries(limits)) {
        const metric = metrics.get(`web-input-v8-interpreted-${stage}-bytes`);
        expect(metric?.value, stage).toBeLessThan(limit);
      }
    },
    TIMEOUT_MS,
  );
});
