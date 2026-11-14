/**
 * Starting `merkur-keyd` outside systemd: for the development stack, the end-to-end server and
 * the server's tests. systemd hands keyd the same three inputs in production
 * (`deploy/app/merkur-keyd.service`): its keys as credential files, a state directory for the
 * attempt log, and the socket path.
 */
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createOpaqueServerSetup } from '../packages/auth/src/opaque';
import { bazelTool } from './bazel-tool';

const READY_LINE = 'keyd: listening';

/** The keyd binary Bazel builds, or the one a Bazel test declared on its PATH. */
export function keydExecutable(root: string): string {
  return bazelTool('merkur-keyd', '//apps/keyd:merkur-keyd', root);
}

export interface KeydPaths {
  /** Holds `opaque-server-setup`, `session-token-mldsa87-seed` and, for web push, `web-push-vapid-private-key`. */
  readonly credentials: string;
  readonly state: string;
  readonly socket: string;
}

/** Writes `files` as a credentials directory: each the canonical base64url a key file holds. */
export async function writeKeydCredentials(
  directory: string,
  files: Readonly<Record<string, string>>,
): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  for (const [name, value] of Object.entries(files)) {
    await writeFile(path.join(directory, name), value, { mode: 0o600 });
  }
}

export const KEYD_OPAQUE_SERVER_SETUP = 'opaque-server-setup';
export const KEYD_SESSION_TOKEN_SEED = 'session-token-mldsa87-seed';
export const KEYD_VAPID_PRIVATE_KEY = 'web-push-vapid-private-key';

/**
 * A fresh key set as keyd's credential files hold it: serenity's OPAQUE server setup (keyd loads
 * exactly that encoding), a random ML-DSA-87 seed and a P-256 VAPID scalar. Development and tests
 * provision with this; a deployment's keys are provisioned once and never replaced.
 */
export async function newKeydKeySet(): Promise<Record<string, string>> {
  const vapid = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({
    format: 'jwk',
  });
  if (vapid.d === undefined) throw new Error('P-256 key without a scalar');
  return {
    [KEYD_OPAQUE_SERVER_SETUP]: await createOpaqueServerSetup(),
    [KEYD_SESSION_TOKEN_SEED]: randomBytes(32).toString('base64url'),
    [KEYD_VAPID_PRIVATE_KEY]: vapid.d,
  };
}

/** A keyd serving `paths`, resolved once it says it is listening. */
export async function spawnKeyd(
  executable: string,
  paths: KeydPaths,
  environment: Readonly<Record<string, string>> = {},
): Promise<ReturnType<typeof Bun.spawn<'ignore', 'pipe', 'inherit'>>> {
  await mkdir(paths.state, { recursive: true, mode: 0o700 });
  const child = Bun.spawn([executable], {
    env: {
      ...environment,
      CREDENTIALS_DIRECTORY: paths.credentials,
      STATE_DIRECTORY: paths.state,
      MERKUR_KEYD_SOCKET: paths.socket,
      NO_COLOR: '1',
    },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'inherit',
  });
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let seen = '';
  while (!seen.includes(READY_LINE)) {
    const chunk = await reader.read();
    if (chunk.done)
      throw new Error(`merkur-keyd exited before listening (code ${await child.exited})`);
    seen += decoder.decode(chunk.value, { stream: true });
  }
  // The ready line is the only one keyd writes to stdout (its logs go to stderr), so nothing
  // more arrives on this pipe to fill it.
  reader.releaseLock();
  return child;
}
