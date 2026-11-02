/** What `JSON.parse` gives back: the value of every key in web storage, before it is read as anything. */
export type Json =
  | null
  | boolean
  | number
  | string
  | readonly Json[]
  | { readonly [key: string]: Json };

/**
 * What IndexedDB gives back: a structured clone of whatever was put, by this
 * build or another. Never `undefined`, which is how IndexedDB says a key holds
 * nothing.
 */
export type Cloned = null | boolean | number | bigint | string | object;

/**
 * Reads a stored value as `T`, or `null` when it is not one. Whatever a browser
 * hands back was written by some earlier build, another tab, or a user's
 * devtools, so every read in this package passes through one. A parser may also
 * normalize (clamp, rebuild, drop unknown fields): what it returns is what the
 * caller gets.
 */
export type Parse<From, T> = (value: From) => T | null;

/**
 * A parser from a type guard, such as one `compileCheck` builds from a TypeBox
 * schema. It reads a structured clone, and so JSON as well.
 */
export function guarded<T>(guard: (value: unknown) => value is T): Parse<Cloned, T> {
  return (value) => (guard(value) ? value : null);
}
