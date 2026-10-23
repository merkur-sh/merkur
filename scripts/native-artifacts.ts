/**
 * The native programs a checkout runs, which `//tools/bazel/native:sync` builds in the release
 * profile and installs: the daemon's sidecars in `apps/daemon/dist`, where the daemon finds them,
 * and the edge with the harnesses' network peers in `apps/edge/dist`.
 *
 * `bun run build:native` runs the sync; every suite and harness that runs them syncs first. Bazel's cache makes an unchanged sync a
 * no-op, and the action graph is what the programs were built from.
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

export const DAEMON_DIST = 'apps/daemon/dist';
export const EDGE_DIST = 'apps/edge/dist';

/**
 * Set by a harness that synced the programs for the Playwright runs it starts, which then leave
 * them as they are: every phase of one run tests the same bytes.
 */
export const NATIVE_PROGRAMS_SYNCED_ENV = 'PW_E2E_NATIVE_PROGRAMS_SYNCED';

const PROGRAMS = {
  'merkur-dataplane': DAEMON_DIST,
  'merkur-image-worker': DAEMON_DIST,
  'merkur-tui': DAEMON_DIST,
  'merkur-edge': EDGE_DIST,
  bulk_competitor: EDGE_DIST,
  delay_proxy: EDGE_DIST,
} as const;

/** A synced program's path in `root`. */
export function nativeProgram(root: string, name: keyof typeof PROGRAMS): string {
  return path.join(root, PROGRAMS[name], name);
}

/** Each installed program's SHA-256, which a run records and holds its programs to. */
export function nativeProgramDigests(root: string) {
  return Object.fromEntries(
    Object.entries(PROGRAMS).map(([name, directory]) => [
      name,
      createHash('sha256')
        .update(readFileSync(path.join(root, directory, name)))
        .digest('hex'),
    ]),
  );
}

export type NativeProgramDigests = ReturnType<typeof nativeProgramDigests>;

/** Throws when an installed program is no longer the one `digests` recorded. */
export function verifyNativePrograms(root: string, digests: NativeProgramDigests): void {
  const current = nativeProgramDigests(root);
  const changed = Object.keys(PROGRAMS).filter((name) => current[name] !== digests[name]);
  if (changed.length > 0) throw new Error(`native programs changed: ${changed.join(', ')}`);
}

/**
 * Builds and installs the programs. `tpmSim` builds the TPM backend's software-TPM transport,
 * which a run against `MERKUR_TPM_SIM_ADDR` needs.
 */
export async function syncNativeArtifacts(
  root: string,
  tpmSim = process.env.MERKUR_TPM_SIM_ADDR !== undefined,
): Promise<void> {
  const child = spawn(
    'bazel',
    [
      'run',
      ...(tpmSim ? ['--//packages/merkur-identity-seal:tpm_sim'] : []),
      '//tools/bazel/native:sync',
    ],
    { cwd: root, stdio: 'inherit' },
  );
  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => resolve(code ?? 1));
  });
  if (exitCode !== 0) throw new Error(`the native programs failed to build (exit ${exitCode})`);
}
