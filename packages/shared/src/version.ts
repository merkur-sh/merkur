/**
 * The Merkur build version, stamped at build time: the daemon and server
 * through `bun build --define` (daemon release tag, server deployment commit), the
 * browser bundle through the matching `define` in `apps/web/vite.config.ts`.
 * Source/dev runs report 'dev'.
 */
export function merkurVersion(): string {
  return process.env.MERKUR_VERSION ?? 'dev';
}
