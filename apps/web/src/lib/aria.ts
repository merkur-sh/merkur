/**
 * Solid 2 types the enumerated ARIA attributes (`aria-hidden`, `aria-busy`,
 * `aria-pressed`, `aria-checked`, `aria-expanded`, ...) as the literal strings
 * the DOM actually carries rather than as booleans, matching the platform
 * instead of coercing for us. This keeps the call sites reading as predicates.
 */
export const ariaBool = (value: boolean): 'true' | 'false' => (value ? 'true' : 'false');
