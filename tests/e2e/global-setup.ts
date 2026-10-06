import { execFile, spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync } from 'node:fs';
import path from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { promisify } from 'node:util';
import {
  EDGE_HARNESS_NATIVE_MANIFEST_ENV,
  resolveVerifiedPrebuiltDataplanePath,
} from '../../scripts/edge-harness-native-artifacts';

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const DATAPLANE_BINARY = path.join(PROJECT_ROOT, 'apps', 'daemon', 'dist', 'merkur-dataplane');

export default async function globalSetup(): Promise<void> {
  const edgeId = process.env.PW_E2E_EDGE_ID;
  if (edgeId !== undefined) {
    const edgeUrl = process.env.PW_E2E_EDGE_URL;
    const certHash = process.env.PW_E2E_EDGE_CERT_HASH;
    if (edgeUrl === undefined || certHash === undefined) {
      throw new Error('edge harness readiness requires its URL and certificate hash');
    }
    const redisPort =
      process.env.PW_E2E_REDIS_PORT ?? String(Number(process.env.PW_E2E_PORT ?? 54331) + 1);
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
  const nativeManifestPath = process.env[EDGE_HARNESS_NATIVE_MANIFEST_ENV];
  const tpmSimulator = process.env.MERKUR_TPM_SIM_ADDR !== undefined;
  const setupMode = selectDataplaneGlobalSetupMode(
    nativeManifestPath,
    existsSync(DATAPLANE_BINARY),
    tpmSimulator,
  );
  if (setupMode === 'verify-prebuilt') {
    if (nativeManifestPath === undefined) throw new Error('prebuilt setup lost its manifest path');
    const verifiedDataplane = await resolveVerifiedPrebuiltDataplanePath(
      PROJECT_ROOT,
      nativeManifestPath,
    );
    if (verifiedDataplane !== DATAPLANE_BINARY) {
      throw new Error('prebuilt dataplane did not resolve to the project-local dist path');
    }
    assertDataplaneExecutable();
    return;
  }
  if (setupMode === 'use-existing') {
    assertDataplaneExecutable();
    return;
  }

  process.stderr.write(`[e2e] building ${tpmSimulator ? 'TPM simulator' : 'missing'} dataplane\n`);
  const result = spawnSync(
    'bun',
    ['run', 'build:dataplane', ...(tpmSimulator ? ['--tpm-sim'] : [])],
    {
      cwd: PROJECT_ROOT,
      stdio: 'inherit',
    },
  );
  if (result.status !== 0) {
    throw new Error('build:dataplane failed; daemon e2e specs cannot run');
  }
  if (!existsSync(DATAPLANE_BINARY)) {
    throw new Error(`dataplane binary missing after build at ${DATAPLANE_BINARY}`);
  }
  assertDataplaneExecutable();
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

export function selectDataplaneGlobalSetupMode(
  nativeManifestPath: string | undefined,
  dataplaneExists: boolean,
  tpmSimulator = false,
): 'verify-prebuilt' | 'use-existing' | 'build' {
  if (nativeManifestPath !== undefined) return 'verify-prebuilt';
  if (tpmSimulator) return 'build';
  return dataplaneExists ? 'use-existing' : 'build';
}

function assertDataplaneExecutable(): void {
  try {
    accessSync(DATAPLANE_BINARY, constants.X_OK);
  } catch {
    throw new Error(`dataplane binary is not executable: ${DATAPLANE_BINARY}`);
  }
}
