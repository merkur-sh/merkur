/**
 * The Effect Atom <-> Solid bridge.
 *
 * Upstream `@effect/atom-solid` is built on `createComputed`, `createResource`
 * and `Context.Provider`, all of which Solid 2 removed, so the hooks this app
 * uses live here instead. The contract is unchanged: one registry per owner
 * subtree, atoms read through Solid accessors, and every mount or subscription
 * released through Solid cleanup.
 *
 * Two Solid 2 details shape the implementation:
 *
 * - Effects no longer run during creation, so `useAtomValue` seeds its signal
 *   synchronously from the registry. Without the seed, the first read of a
 *   freshly created accessor would return a placeholder until the first flush.
 * - Registry callbacks write the mirror signal from inside the effect's apply
 *   phase, which is an owned scope. That is exactly what `ownedWrite` marks: the
 *   signal is hook-internal state, not app state written from a computation.
 */
import type * as Atom from 'effect/reactivity/Atom';
import * as AtomRegistry from 'effect/reactivity/AtomRegistry';
import {
  type Accessor,
  createComponent,
  createContext,
  createEffect,
  createSignal,
  type Element,
  onCleanup,
  untrack,
  useContext,
} from 'solid-js';

/** Delivers the current value on subscribe, so a re-subscription is never a gap. */
const SUBSCRIBE_IMMEDIATE = { immediate: true } as const;

/**
 * Carries the `AtomRegistry` for an owner subtree. Default-less on purpose: the
 * device-event loop and the state it publishes must be the *same* atoms
 * everywhere, so a missing provider is a bug worth throwing on rather than a
 * silently divergent second registry.
 */
export const RegistryContext = createContext<AtomRegistry.AtomRegistry>();

/**
 * Creates an `AtomRegistry` for a Solid subtree and disposes it with the owner.
 *
 * `defaultIdleTTL` bounds how long an atom survives with no subscribers; it only
 * affects atoms that are not explicitly kept alive.
 */
export const RegistryProvider = (props: { readonly children?: Element }): Element => {
  const registry = AtomRegistry.make({ defaultIdleTTL: 400 });
  onCleanup(() => registry.dispose());
  return createComponent(RegistryContext, {
    value: registry,
    get children() {
      return props.children;
    },
  });
};

/**
 * Holds the atom value behind an object so the signal never sees a bare
 * function. Solid reserves function arguments for the derived `createSignal(fn)`
 * form and types the value overload as `Exclude<T, Function>`, which an opaque
 * atom value cannot satisfy; boxing keeps a function-valued atom from being run
 * as a compute without casting the generic away.
 */
interface AtomBox<A> {
  readonly value: A;
}

/** Compares boxes by the value they carry, so a republished identical value is not a change. */
const sameAtomValue = <A>(a: AtomBox<A>, b: AtomBox<A>): boolean => a.value === b.value;

/**
 * Subscribes to an atom in the current registry and exposes it as a Solid
 * accessor. Re-subscribes when the thunk selects a different atom.
 */
export const useAtomValue = <A>(atom: () => Atom.Atom<A>): Accessor<A> => {
  const registry = useContext(RegistryContext);
  const [box, setBox] = createSignal<AtomBox<A>>(
    { value: untrack(() => registry.get(atom())) },
    { ownedWrite: true, equals: sameAtomValue },
  );
  createEffect(atom, (current) =>
    registry.subscribe(current, (next) => setBox({ value: next }), SUBSCRIBE_IMMEDIATE),
  );
  return () => box().value;
};

/**
 * Keeps an atom mounted for the lifetime of the current owner without reading
 * it. Used for atoms that are pure machinery — the device-event recovery loop
 * publishes into other atoms and has no value anything renders.
 */
export const useAtomMount = <A>(atom: () => Atom.Atom<A>): void => {
  const registry = useContext(RegistryContext);
  createEffect(atom, (current) => registry.mount(current));
};
