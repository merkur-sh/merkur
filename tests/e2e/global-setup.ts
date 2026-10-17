import { execFile } from 'node:child_process';
import path from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { promisify } from 'node:util';
import { NATIVE_PROGRAMS_SYNCED_ENV, syncNativeArtifacts } from '../../scripts/native-artifacts';

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

export default async function globalSetup(): Promise<void> {
  const edgeId = process.env.PW_E2E_EDGE_ID;
  if (edgeId !== undefined) {
    const edgeUrl = process.env.PW_E2E_EDGE_URL;
    const certHash = process.env.PW_E2E_EDGE_CERT_HASH;
    if (edgeUrl === undefined || certHash === undefined) {
      throw new Error('edge harness readiness requires its URL and certificate hash');
    }
    const redisPort =
      process.env.PW_E2E_REDIS_PORT ?? String(Number(process.env.PW_E2E_PORT ?? 24331) + 1);
    await promisify(execFile)('bun', [
      'run',
      path.join(PROJECT_ROOT, 'tests/e2e/wait-edge-registration.ts'),
      redisPort,
      edgeId,
      edgeUrl,
      certHash,
    ]);
    process.stderr.write(`[e2e] edge ${edgeId} registered in this phase's Redis\n`);
  }
  // The daemon runs the dataplane and image worker in `apps/daemon/dist`. A harness syncs them
  // once for all its phases; a suite Playwright starts itself syncs here, where an unchanged
  // sync is Bazel's no-op and leaves every installed program untouched.
  if (process.env[NATIVE_PROGRAMS_SYNCED_ENV] === undefined)
    await syncNativeArtifacts(PROJECT_ROOT);
}

/** Each Playwright phase starts fresh Redis; the long-lived edge must register in it. */
export async function waitForHarnessEdgeRegistration(
  read: () => Promise<{ record: unknown; score: unknown }>,
  expected: { edgeId: string; edgeUrl: string; certHash: string },
  signal: AbortSignal,
): Promise<void> {
  while (true) {
    signal.throwIfAborted();
    const { record, score } = await read();
    signal.throwIfAborted();
    if (typeof record === 'string' && typeof score === 'number') {
      const registration: unknown = JSON.parse(record);
      if (
        typeof registration === 'object' &&
        registration !== null &&
        'edgeId' in registration &&
        registration.edgeId === expected.edgeId &&
        'edgeWtUrl' in registration &&
        registration.edgeWtUrl === expected.edgeUrl &&
        'activeCertHash' in registration &&
        registration.activeCertHash === expected.certHash &&
        'certHashes' in registration &&
        Array.isArray(registration.certHashes) &&
        registration.certHashes[0] === expected.certHash &&
        'updatedAt' in registration &&
        registration.updatedAt === score
      )
        return;
    }
    await setTimeout(100, undefined, { signal });
  }
}
