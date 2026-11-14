/**
 * The OPAQUE server half of `@serenity-kit/opaque`, for the tools that pin against or provision
 * `merkur-keyd`: the application server itself never holds a server setup, and signs nobody in
 * here. keyd runs the same protocol natively (`apps/keyd`).
 */
import * as opaque from '@serenity-kit/opaque';

export const OPAQUE_SERVER_SETUP_BYTES = 128;
export const OPAQUE_SERVER_PUBLIC_KEY_BYTES = 32;
export const OPAQUE_REGISTRATION_REQUEST_BYTES = 32;
export const OPAQUE_REGISTRATION_RESPONSE_BYTES = 64;
export const OPAQUE_REGISTRATION_RECORD_BYTES = 192;

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
