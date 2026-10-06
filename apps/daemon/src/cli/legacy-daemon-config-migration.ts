import { readFile } from 'node:fs/promises';

import { validateDaemonConfig } from '@merkur/config';
import { Effect } from 'effect';

const LEGACY_CONFIG_FIELDS = new Set([
  'daemon_id',
  'server_origin',
  'daemon_identity_signing_seed',
  'shell',
  'webtransport_port',
  'session_token_verify_key',
  'user_root_public_key',
  'root_epoch',
  'daemon_binding',
  'revoked_delegations',
]);
const LEGACY_32_BYTE_VALUE_PATTERN = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
const LINK_SAFE_DAEMON_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const MAX_LINK_SAFE_DAEMON_ID_LENGTH = 128;
const LEGACY_CONFIG_ERROR =
  'Existing daemon config is not the exact supported one-time link migration schema';

/**
 * The only legacy value allowed to cross the hard cut is the stable daemon ID.
 * Retired credentials are validated solely to identify the deployed schema and
 * are deliberately absent from this result type.
 */
export interface LegacyDaemonLinkMigration {
  readonly daemonId: string;
}

/**
 * Migration-only parser for the final pre-hard-cut daemon config. It accepts
 * exactly that schema, rejects mixed/current/malformed objects, and returns no
 * credential material.
 */
export function parseLegacyDaemonConfigForLinkMigration(value: unknown): LegacyDaemonLinkMigration {
  try {
    return parseExactLegacyDaemonConfig(value);
  } catch {
    throw new Error(LEGACY_CONFIG_ERROR);
  }
}

export function loadLegacyDaemonConfigForLinkMigration(
  configPath: string,
): Effect.Effect<LegacyDaemonLinkMigration, Error> {
  return Effect.tryPromise({
    try: async () => {
      const raw = await readFile(configPath);
      try {
        return parseLegacyDaemonConfigForLinkMigration(JSON.parse(raw.toString('utf8')));
      } finally {
        raw.fill(0);
      }
    },
    catch: () => new Error(LEGACY_CONFIG_ERROR),
  });
}

function parseExactLegacyDaemonConfig(value: unknown): LegacyDaemonLinkMigration {
  if (!isRecord(value)) {
    throw new Error(LEGACY_CONFIG_ERROR);
  }

  const fields = Object.keys(value);
  if (
    fields.length !== LEGACY_CONFIG_FIELDS.size ||
    fields.some((field) => !LEGACY_CONFIG_FIELDS.has(field))
  ) {
    throw new Error(LEGACY_CONFIG_ERROR);
  }

  const daemonId = requireNonEmptyString(value, 'daemon_id');
  if (
    daemonId.length > MAX_LINK_SAFE_DAEMON_ID_LENGTH ||
    !LINK_SAFE_DAEMON_ID_PATTERN.test(daemonId)
  ) {
    throw new Error(LEGACY_CONFIG_ERROR);
  }

  requireCanonicalEncodedField(value, 'daemon_identity_signing_seed', LEGACY_32_BYTE_VALUE_PATTERN);
  const { daemon_identity_signing_seed: retiredSeed, ...publicConfig } = value;
  void retiredSeed;
  // Reuse current validation for unchanged public fields. Never decode or carry
  // the retired seed into the replacement identity.
  validateDaemonConfig({
    ...publicConfig,
    daemon_identity_seal: {
      backend: 'software',
      material: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    },
  });

  return { daemonId };
}

function requireCanonicalEncodedField(
  value: Record<string, unknown>,
  fieldName: string,
  pattern: RegExp,
): void {
  const encoded = requireNonEmptyString(value, fieldName);
  // These exact legacy regexes encode both the byte length and canonical final
  // base64url quantum. Do not decode retired credential material during the
  // migration; it is only a schema discriminator.
  if (!pattern.test(encoded)) {
    throw new Error(LEGACY_CONFIG_ERROR);
  }
}

function requireNonEmptyString(value: Record<string, unknown>, fieldName: string): string {
  const field = requireString(value, fieldName);
  if (field.trim().length === 0) {
    throw new Error(LEGACY_CONFIG_ERROR);
  }
  return field;
}

function requireString(value: Record<string, unknown>, fieldName: string): string {
  const field = value[fieldName];
  if (typeof field !== 'string') {
    throw new Error(LEGACY_CONFIG_ERROR);
  }
  return field;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
