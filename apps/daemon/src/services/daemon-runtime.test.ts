import { describe, expect, test } from 'bun:test';
import { Cause, Data, Effect, Exit } from 'effect';

import { superviseCriticalDaemonEffects } from './daemon-runtime';

class TestDataplaneFatalError extends Data.TaggedError('TestDataplaneFatalError')<{
  readonly reason: string;
}> {}

class TestBellFatalError extends Data.TaggedError('TestBellFatalError')<{
  readonly reason: string;
}> {}

describe('daemon critical supervision', () => {
  test('propagates a terminal dataplane failure instead of leaving control alive', async () => {
    const fatal = new TestDataplaneFatalError({ reason: 'protocol_error' });
    const observed = await Effect.runPromise(
      Effect.flip(
        superviseCriticalDaemonEffects(
          Effect.never,
          Effect.fail(fatal),
          Effect.never,
          Effect.never,
          Effect.never,
        ),
      ),
    );

    expect(observed).toBe(fatal);
  });

  test('keeps superseded as the typed terminal control outcome', async () => {
    const outcome = await Effect.runPromise(
      superviseCriticalDaemonEffects(
        Effect.succeed({ _tag: 'DaemonControlSuperseded' }),
        Effect.never,
        Effect.never,
        Effect.never,
        Effect.never,
      ),
    );

    expect(outcome).toEqual({ _tag: 'DaemonControlSuperseded' });
  });

  test('propagates a terminal bell worker failure through the same owner', async () => {
    const fatal = new TestBellFatalError({ reason: 'worker_defect' });
    const observed = await Effect.runPromise(
      Effect.flip(
        superviseCriticalDaemonEffects(
          Effect.never,
          Effect.never,
          Effect.fail(fatal),
          Effect.never,
          Effect.never,
        ),
      ),
    );

    expect(observed).toBe(fatal);
  });

  test('surfaces an observability reporter defect through the owner fiber', async () => {
    const exit = await Effect.runPromiseExit(
      superviseCriticalDaemonEffects(
        Effect.never,
        Effect.never,
        Effect.never,
        Effect.die(new Error('health reporter defect')),
        Effect.never,
      ),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Cause.pretty(exit.cause)).toContain('health reporter defect');
    }
  });

  test('surfaces a perf reporter defect through the owner fiber', async () => {
    const exit = await Effect.runPromiseExit(
      superviseCriticalDaemonEffects(
        Effect.never,
        Effect.never,
        Effect.never,
        Effect.never,
        Effect.die(new Error('perf reporter defect')),
      ),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Cause.pretty(exit.cause)).toContain('perf reporter defect');
    }
  });
});
