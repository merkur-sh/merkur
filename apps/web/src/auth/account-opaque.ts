import { finishOpaqueInWorker } from './account-opaque-finish';
import { decodeBase64UrlExact } from './encoding';

type OpaqueModule = typeof import('@serenity-kit/opaque');

/**
 * OPAQUE inlines its WebAssembly as base64 inside its JS module, so a static
 * import puts ~434 KB raw (~132 KB brotli) of blocking bytes into the boot
 * bundle on every load — including a returning authenticated browser going
 * straight to a terminal, which never runs OPAQUE at all. Loading it on demand
 * keeps those bytes off the boot parse path. The emitted chunk is still part of
 * the service-worker precache manifest, and `warmAccountOpaque` starts the load
 * when the auth screen mounts, so a real sign-in does not wait for the fetch.
 */
let opaqueModule: Promise<OpaqueModule> | null = null;

async function importOpaque(): Promise<OpaqueModule> {
  try {
    const module = await import('@serenity-kit/opaque');
    await module.ready;
    return module;
  } catch (error) {
    // Never retain a failed load: one transient chunk fetch failure must not
    // wedge every later sign-in until the page is reloaded.
    opaqueModule = null;
    throw error;
  }
}

function loadOpaque(): Promise<OpaqueModule> {
  opaqueModule ??= importOpaque();
  return opaqueModule;
}

/**
 * Begin loading OPAQUE before a password is submitted. Safe to call repeatedly;
 * the load is shared with the sign-in path and its failure is left for the
 * submit that actually needs it to report.
 */
export function warmAccountOpaque(): void {
  void loadOpaque().catch(() => undefined);
}

const OPAQUE_SERVER_PUBLIC_KEY_BYTES = 32;
const OPAQUE_SERVER_PUBLIC_KEY_ENV = 'VITE_MERKUR_OPAQUE_SERVER_PUBLIC_KEY';

export interface AccountRegistrationStart {
  readonly clientRegistrationState: string;
  readonly registrationRequest: string;
}

export interface AccountRegistrationFinish {
  readonly registrationRecord: string;
  readonly exportKey: Uint8Array;
  readonly serverPublicKey: string;
}

export interface AccountLoginStart {
  readonly clientLoginState: string;
  readonly startLoginRequest: string;
}

export interface AccountLoginFinish {
  readonly finishLoginRequest: string;
  readonly exportKey: Uint8Array;
  readonly serverPublicKey: string;
}

export async function startAccountRegistration(
  password: string,
): Promise<AccountRegistrationStart> {
  requirePassword(password);
  const opaque = await loadOpaque();
  return opaque.client.startRegistration({ password });
}

export async function finishAccountRegistration(
  password: string,
  clientRegistrationState: string,
  registrationResponse: string,
  userId: string,
  serverOrigin: string,
  signal?: AbortSignal,
): Promise<AccountRegistrationFinish> {
  requirePassword(password);
  requireOpaqueMessage(clientRegistrationState, 'OPAQUE registration state');
  requireOpaqueMessage(registrationResponse, 'OPAQUE registration response');
  requireIdentifier(userId, 'OPAQUE client identifier');
  requireIdentifier(serverOrigin, 'OPAQUE server identifier');
  const finished = await finishOpaqueInWorker(
    {
      operation: 'registration',
      parameters: {
        password,
        clientRegistrationState,
        registrationResponse,
        identifiers: { client: userId, server: serverOrigin },
      },
    },
    signal,
  );
  if (finished === null) throw new Error('Account registration failed');
  try {
    verifyPinnedServerPublicKey(finished.serverPublicKey);
    return {
      registrationRecord: finished.proof,
      exportKey: finished.exportKey,
      serverPublicKey: finished.serverPublicKey,
    };
  } catch (error) {
    finished.exportKey.fill(0);
    throw error;
  }
}

export async function startAccountLogin(password: string): Promise<AccountLoginStart> {
  requirePassword(password);
  const opaque = await loadOpaque();
  return opaque.client.startLogin({ password });
}

export async function finishAccountLogin(
  password: string,
  clientLoginState: string,
  loginResponse: string,
  userId: string,
  serverOrigin: string,
  signal?: AbortSignal,
): Promise<AccountLoginFinish | null> {
  requirePassword(password);
  requireOpaqueMessage(clientLoginState, 'OPAQUE login state');
  requireOpaqueMessage(loginResponse, 'OPAQUE login response');
  requireIdentifier(userId, 'OPAQUE client identifier');
  requireIdentifier(serverOrigin, 'OPAQUE server identifier');
  const finished = await finishOpaqueInWorker(
    {
      operation: 'login',
      parameters: {
        password,
        clientLoginState,
        loginResponse,
        identifiers: { client: userId, server: serverOrigin },
      },
    },
    signal,
  );
  if (finished === null) return null;
  try {
    verifyPinnedServerPublicKey(finished.serverPublicKey);
    return {
      finishLoginRequest: finished.proof,
      exportKey: finished.exportKey,
      serverPublicKey: finished.serverPublicKey,
    };
  } catch (error) {
    finished.exportKey.fill(0);
    throw error;
  }
}

function verifyPinnedServerPublicKey(value: string): void {
  const actual = decodeBase64UrlExact(
    value,
    OPAQUE_SERVER_PUBLIC_KEY_BYTES,
    'OPAQUE server public key',
  );
  const configured = import.meta.env.VITE_MERKUR_OPAQUE_SERVER_PUBLIC_KEY;
  if (typeof configured !== 'string' || configured.length === 0) {
    actual.fill(0);
    throw new Error(`${OPAQUE_SERVER_PUBLIC_KEY_ENV} is required`);
  }
  const expected = decodeBase64UrlExact(
    configured,
    OPAQUE_SERVER_PUBLIC_KEY_BYTES,
    'pinned OPAQUE server public key',
  );
  try {
    let difference = 0;
    for (let index = 0; index < expected.byteLength; index += 1) {
      difference |= (expected[index] ?? 0) ^ (actual[index] ?? 0);
    }
    if (difference !== 0) throw new Error('OPAQUE server public key does not match the build pin');
  } finally {
    actual.fill(0);
    expected.fill(0);
  }
}

function requirePassword(password: string): void {
  if (password.length === 0) throw new Error('Password must not be empty');
}

function requireOpaqueMessage(value: string, label: string): void {
  if (value.length === 0) throw new Error(`${label} must not be empty`);
}

function requireIdentifier(value: string, label: string): void {
  if (value.length === 0 || new TextEncoder().encode(value).byteLength > 128) {
    throw new Error(`${label} is invalid`);
  }
}
