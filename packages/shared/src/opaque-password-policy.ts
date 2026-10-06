/**
 * Identical Argon2id policy in browser registration/login and the native client. Every
 * stored registration record is derived with it, so changing it is a hard cutover of
 * every account credential.
 */
export const OPAQUE_PASSWORD_STRETCHING = {
  'argon2id-custom': { memory: 65_536, iterations: 6, parallelism: 4 },
} as const;
