import { STATIC_GATES } from '../../../scripts/gate-policy';

/**
 * A static gate the source lanes run and no Bazel check implements. The anti-slop gate has one
 * path, the source lanes'; a Bazel plan carries it as a declared qualification.
 */
export const UNIMPLEMENTED_STATIC_GATES: readonly string[] = ['check:slop'];

/** The static gates every Bazel plan carries. */
export const BAZEL_STATIC_GATES: readonly string[] = STATIC_GATES.filter(
  (name) => !UNIMPLEMENTED_STATIC_GATES.includes(name),
);
