import { describe, expect, test } from 'bun:test';
import { Context, Effect, Layer } from 'effect';

import { provideLayerAroundScopedProgram } from './benchmark-effect-scope';

class SentinelInfrastructure extends Context.Service<
  SentinelInfrastructure,
  Record<string, never>
>()('SentinelInfrastructure') {}

describe('benchmark Effect scope ordering', () => {
  test('program finalizers run while provided infrastructure remains alive', async () => {
    let infrastructureAlive = false;
    let programFinalizerObservedInfrastructure = false;
    const infrastructureLayer = Layer.effect(
      SentinelInfrastructure,
      Effect.acquireRelease(
        Effect.sync(() => {
          infrastructureAlive = true;
          return {};
        }),
        () =>
          Effect.sync(() => {
            infrastructureAlive = false;
          }),
      ),
    );
    const program = Effect.gen(function* () {
      yield* SentinelInfrastructure;
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          programFinalizerObservedInfrastructure = infrastructureAlive;
        }),
      );
    });

    await Effect.runPromise(provideLayerAroundScopedProgram(program, infrastructureLayer));

    expect(programFinalizerObservedInfrastructure).toBe(true);
    expect(infrastructureAlive).toBe(false);
  });
});
