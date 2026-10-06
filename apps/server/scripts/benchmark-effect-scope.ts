import { Effect, type Layer } from 'effect';

/**
 * Keep infrastructure acquired outside the program's scope so program
 * finalizers can still use it. Effect scopes close in lexical nesting order:
 * the scoped program releases first, then the provided layer.
 */
export function provideLayerAroundScopedProgram<A, E, R, ROut, E2, RIn>(
  program: Effect.Effect<A, E, R>,
  layer: Layer.Layer<ROut, E2, RIn>,
) {
  return Effect.scoped(program).pipe(Effect.provide(layer));
}
