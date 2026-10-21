/**
 * The Merkur build version, stamped at build time: the daemon and server
 * through `bun build --define` (daemon release tag, server deployment commit), the
 * browser bundle through the matching `define` in `apps/web/vite.config.ts`.
 * Source/dev runs report 'dev'.
 */
export function merkurVersion(): string {
  return process.env.MERKUR_VERSION ?? 'dev';
}

/**
 * The release this build belongs to: the `vX.Y.Z` tag the release workflow stamps into the
 * daemon CLI and the server, or 'dev' from source. A daemon runs exactly its server's release;
 * this decides which binary runs and never how a protocol behaves (docs/releases.md,
 * Convergence).
 */
export function merkurRelease(): string {
  return process.env.MERKUR_RELEASE ?? 'dev';
}
