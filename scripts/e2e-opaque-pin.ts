/**
 * The test-only OPAQUE authority's public key. The E2E server holds the
 * matching setup (`tests/e2e/start-server.ts`); the E2E web build pins this
 * key, and so does every native client a spec drives. Its own module so the
 * Playwright specs, which Playwright transpiles to CommonJS, can import it.
 */
export const E2E_OPAQUE_PUBLIC_KEY = '_lV018BV4Yes2R8Lq3TmVchsl3XYbxFxC3aHCOGyy1E';
