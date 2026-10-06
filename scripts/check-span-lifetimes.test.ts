import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { findSpanLifetimeViolations } from './check-span-lifetimes';

const root = mkdtempSync(path.join(tmpdir(), 'span-lifetimes-'));

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function fixture(name: string, source: string): string {
  const dir = path.join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'subject.ts'), source);
  return dir;
}

describe('findSpanLifetimeViolations', () => {
  test('catches a span wrapped around a repeated forever loop', () => {
    // The exact pre-fix shape of runServerHealthMonitorEffect, which put 9,156
    // health-refresh spans under one never-ending parent at a 5.00s cadence.
    const dir = fixture(
      'repeat-loop',
      `import { Effect, Schedule } from 'effect';
export const runServerHealthMonitorEffect = refreshServerHealthEffect.pipe(
  Effect.repeat(Schedule.spaced('5 seconds')),
  Effect.delay('5 seconds'),
  Effect.withSpan('server.health.monitor'),
);
`,
    );

    const violations = findSpanLifetimeViolations([dir]);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.span).toBe("'server.health.monitor'");
    expect(violations[0]?.marker).toBe('Effect.repeat(');
  });

  test('catches a span wrapped around a program that waits for a shutdown signal', () => {
    // The pre-fix shape of server.runtime. The unbounded marker is in the piped
    // SUBJECT, not the pipe arguments, so scanning arguments alone misses it.
    const dir = fixture(
      'signal-wait',
      `import { Effect } from 'effect';
const serverProgram = Effect.scoped(
  Effect.gen(function* () {
    const signal = yield* Effect.raceFirst(waitForProcessSignal(), other());
    yield* logEffect('info', 'server', 'server_shutdown_started', { signal });
  }),
).pipe(Effect.withLogSpan('server.runtime'), Effect.withSpan('server.runtime'));
`,
    );

    const violations = findSpanLifetimeViolations([dir]);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.span).toBe("'server.runtime'");
    expect(violations[0]?.marker).toBe('waitForProcessSignal');
  });

  test('accepts a span on the repeated unit of work itself', () => {
    // The post-fix shape: the span is on one iteration, the repeat carries none.
    const dir = fixture(
      'bounded-iteration',
      `import { Effect, Schedule } from 'effect';
export const refreshServerHealthEffect = Effect.gen(function* () {
  yield* probe();
}).pipe(Effect.withSpan('server.health.refresh', { root: true }));

export const runServerHealthMonitorEffect = refreshServerHealthEffect.pipe(
  Effect.repeat(Schedule.spaced('5 seconds')),
);
`,
    );

    expect(findSpanLifetimeViolations([dir])).toHaveLength(0);
  });

  test('does not flag a retried effect, which stops on first success', () => {
    const dir = fixture(
      'retry',
      `import { Effect, Schedule } from 'effect';
export const publish = attempt.pipe(
  Effect.retry(Schedule.spaced('1 second')),
  Effect.withSpan('edge.register.publish'),
);
`,
    );

    expect(findSpanLifetimeViolations([dir])).toHaveLength(0);
  });

  test('ignores markers that appear only inside strings or comments', () => {
    // Offsets are preserved when blanking, so a mention in prose must not shift
    // delimiter matching or trip the scan.
    const dir = fixture(
      'prose',
      `import { Effect } from 'effect';
// Never compose this with Effect.repeat( — see check-span-lifetimes.
export const send = payload.pipe(Effect.withSpan('note: Effect.forever is banned here'));
`,
    );

    expect(findSpanLifetimeViolations([dir])).toHaveLength(0);
  });
});
