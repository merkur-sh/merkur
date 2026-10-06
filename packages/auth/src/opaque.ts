import * as opaque from '@serenity-kit/opaque';

export const OPAQUE_SERVER_SETUP_BYTES = 128;
export const OPAQUE_SERVER_PUBLIC_KEY_BYTES = 32;
export const OPAQUE_REGISTRATION_REQUEST_BYTES = 32;
export const OPAQUE_REGISTRATION_RESPONSE_BYTES = 64;
export const OPAQUE_REGISTRATION_RECORD_BYTES = 192;
export const OPAQUE_LOGIN_REQUEST_BYTES = 96;
export const OPAQUE_LOGIN_RESPONSE_BYTES = 320;
export const OPAQUE_LOGIN_FINISH_BYTES = 64;

export interface OpaqueLoginStart {
  readonly serverLoginState: string;
  readonly loginResponse: string;
}

export async function createOpaqueServerSetup(): Promise<string> {
  await opaque.ready;
  return opaque.server.createSetup();
}

export async function validateOpaqueServerSetup(serverSetup: string): Promise<string> {
  requireCanonicalBase64Url(serverSetup, OPAQUE_SERVER_SETUP_BYTES, 'OPAQUE server setup');
  await opaque.ready;
  const publicKey = opaque.server.getPublicKey(serverSetup);
  requireCanonicalBase64Url(publicKey, OPAQUE_SERVER_PUBLIC_KEY_BYTES, 'OPAQUE server public key');
  return publicKey;
}

export async function createOpaqueRegistrationResponse(input: {
  readonly serverSetup: string;
  readonly userId: string;
  readonly registrationRequest: string;
}): Promise<string> {
  requireIdentifier(input.userId, 'user id');
  requireCanonicalBase64Url(
    input.registrationRequest,
    OPAQUE_REGISTRATION_REQUEST_BYTES,
    'OPAQUE registration request',
  );
  await validateOpaqueServerSetup(input.serverSetup);
  const result = opaque.server.createRegistrationResponse({
    serverSetup: input.serverSetup,
    userIdentifier: input.userId,
    registrationRequest: input.registrationRequest,
  });
  requireCanonicalBase64Url(
    result.registrationResponse,
    OPAQUE_REGISTRATION_RESPONSE_BYTES,
    'OPAQUE registration response',
  );
  return result.registrationResponse;
}

export function validateOpaqueRegistrationRecord(registrationRecord: string): void {
  requireCanonicalBase64Url(
    registrationRecord,
    OPAQUE_REGISTRATION_RECORD_BYTES,
    'OPAQUE registration record',
  );
}

export async function startOpaqueServerLogin(input: {
  readonly serverSetup: string;
  readonly registrationRecord: string | null;
  readonly startLoginRequest: string;
  readonly userId: string;
  readonly serverIdentity: string;
}): Promise<OpaqueLoginStart> {
  requireIdentifier(input.userId, 'user id');
  requireIdentifier(input.serverIdentity, 'server identity');
  if (input.registrationRecord !== null) {
    validateOpaqueRegistrationRecord(input.registrationRecord);
  }
  requireCanonicalBase64Url(
    input.startLoginRequest,
    OPAQUE_LOGIN_REQUEST_BYTES,
    'OPAQUE login request',
  );
  await validateOpaqueServerSetup(input.serverSetup);
  const result = opaque.server.startLogin({
    serverSetup: input.serverSetup,
    registrationRecord: input.registrationRecord,
    startLoginRequest: input.startLoginRequest,
    userIdentifier: input.userId,
    identifiers: {
      client: input.userId,
      server: input.serverIdentity,
    },
  });
  requireCanonicalBase64Url(
    result.serverLoginState,
    OPAQUE_SERVER_SETUP_BYTES,
    'OPAQUE server login state',
  );
  requireCanonicalBase64Url(
    result.loginResponse,
    OPAQUE_LOGIN_RESPONSE_BYTES,
    'OPAQUE login response',
  );
  return result;
}

export async function finishOpaqueServerLogin(input: {
  readonly serverLoginState: string;
  readonly finishLoginRequest: string;
  readonly userId: string;
  readonly serverIdentity: string;
}): Promise<void> {
  requireCanonicalBase64Url(
    input.serverLoginState,
    OPAQUE_SERVER_SETUP_BYTES,
    'OPAQUE server login state',
  );
  requireCanonicalBase64Url(
    input.finishLoginRequest,
    OPAQUE_LOGIN_FINISH_BYTES,
    'OPAQUE login finish',
  );
  requireIdentifier(input.userId, 'user id');
  requireIdentifier(input.serverIdentity, 'server identity');
  await opaque.ready;
  const result = opaque.server.finishLogin({
    serverLoginState: input.serverLoginState,
    finishLoginRequest: input.finishLoginRequest,
    identifiers: {
      client: input.userId,
      server: input.serverIdentity,
    },
  });
  requireCanonicalBase64Url(result.sessionKey, 64, 'OPAQUE session key');
}

function requireIdentifier(value: string, label: string): void {
  if (value.length === 0 || new TextEncoder().encode(value).byteLength > 128) {
    throw new Error(`${label} is invalid`);
  }
}

function requireCanonicalBase64Url(value: string, bytes: number, label: string): void {
  if (value.length === 0 || !/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new Error(`${label} is not canonical base64url`);
  }
  const decoded = Buffer.from(value, 'base64url');
  try {
    if (decoded.byteLength !== bytes || decoded.toString('base64url') !== value) {
      throw new Error(`${label} has an invalid length or encoding`);
    }
  } finally {
    decoded.fill(0);
  }
}
