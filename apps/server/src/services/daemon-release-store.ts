import { existsSync, readdirSync, readFileSync, watch } from 'node:fs';
import path from 'node:path';
import {
  isReleaseVersion,
  merkurRelease,
  parseCanonicalReleaseManifest,
  RELEASE_MANIFEST_FILE,
  RELEASE_MANIFEST_SIGNATURE_FILE,
} from '@merkur/shared';
import {
  decodeReleasePublicKey,
  decodeReleaseSignature,
  verifyReleaseManifestSignature,
} from '@merkur/shared/release-signature';
import { Context, Effect, Layer, Queue, type Scope } from 'effect';

import { createLogger, type Logger } from '../logger';

/**
 * The signed daemon releases this server hands its daemons, `<store>/<tag>/<file>`, bound
 * read-only by `deploy/app/merkur-server.service`. The release workflow writes each release
 * whole and renames it into place before it deploys the server of that release. A source run
 * has none: its daemons run from source too.
 */
export const DAEMON_RELEASE_STORE_DIRECTORY = '/daemon-releases';

export interface DaemonReleaseStore {
  /** The release staged past this server's own, if the store holds one. */
  readonly staged: Effect.Effect<string | null>;
  /** Each newly staged release, once, for the control service to announce. */
  readonly announcements: Queue.Dequeue<string>;
}

/**
 * The newest release in `directory` past `ownRelease`, by signed sequence, counting only
 * manifests the release key verifies and whose tag is their directory's name. Null when the
 * store holds nothing newer, or does not hold this server's own release to compare with.
 */
export function readStagedRelease(
  directory: string,
  ownRelease: string,
  publicKeyBase64url: string,
  logger: Logger,
): string | null {
  if (!existsSync(directory)) return null;
  const releases = readdirSync(directory)
    .filter(isReleaseVersion)
    .flatMap((version) => {
      const sequence = verifiedSequence(
        path.join(directory, version),
        version,
        publicKeyBase64url,
        logger,
      );
      return sequence === null ? [] : [{ version, sequence }];
    });
  const own = releases.find((release) => release.version === ownRelease);
  if (own === undefined) return null;
  const newest = releases
    .filter((release) => release.sequence > own.sequence)
    .sort((left, right) => right.sequence - left.sequence)[0];
  return newest?.version ?? null;
}

/**
 * The signed sequence of the release in `directory`, or null for an entry this server will not
 * name: unsigned, signed by another key, unreadable, or another tag's manifest.
 */
function verifiedSequence(
  directory: string,
  version: string,
  publicKeyBase64url: string,
  logger: Logger,
): number | null {
  try {
    const manifestBytes = new Uint8Array(readFileSync(path.join(directory, RELEASE_MANIFEST_FILE)));
    const signatureText = readFileSync(
      path.join(directory, RELEASE_MANIFEST_SIGNATURE_FILE),
      'utf8',
    );
    const publicKey = decodeReleasePublicKey(publicKeyBase64url);
    const signature = decodeReleaseSignature(signatureText);
    const verified = verifyReleaseManifestSignature(manifestBytes, signature, publicKey);
    publicKey.fill(0);
    signature.fill(0);
    if (!verified) throw new Error('the release key does not verify its manifest');
    const manifest = parseCanonicalReleaseManifest(manifestBytes);
    if (manifest.version !== version) throw new Error(`its manifest names ${manifest.version}`);
    return manifest.sequence;
  } catch (error) {
    logger.warn('daemon_release_store_entry_refused', { version, error: String(error) });
    return null;
  }
}

/**
 * Watches the store for the scope's life. A rename into the store is the release workflow's
 * one write, and every change is answered by reading the whole store again, so an event
 * coalesced or reordered by the kernel cannot leave the staged release stale.
 */
function releaseStoreScoped(input: {
  readonly directory: string;
  readonly ownRelease: string;
  readonly publicKeyBase64url: string;
  readonly logger: Logger;
}): Effect.Effect<DaemonReleaseStore, never, Scope.Scope> {
  return Effect.gen(function* () {
    const read = () =>
      readStagedRelease(input.directory, input.ownRelease, input.publicKeyBase64url, input.logger);
    // Read and written only by the watcher's callback and `staged`, both on the event loop.
    let staged = read();
    const announcements = yield* Queue.sliding<string>(1);
    if (existsSync(input.directory)) {
      const rescan = (): void => {
        const next = read();
        if (next === staged) return;
        staged = next;
        if (next !== null) {
          input.logger.info('daemon_release_staged', { release: next });
          Queue.offerUnsafe(announcements, next);
        }
      };
      yield* Effect.acquireRelease(
        Effect.sync(() => watch(input.directory, rescan)),
        (watcher) => Effect.sync(() => watcher.close()),
      );
    }
    return { staged: Effect.sync(() => staged), announcements };
  });
}

export class DaemonReleaseStoreTag extends Context.Service<
  DaemonReleaseStoreTag,
  DaemonReleaseStore
>()('DaemonReleaseStore') {}

/** The deployment's store, watched for the server's life (`DAEMON_RELEASE_STORE_DIRECTORY`). */
export const DaemonReleaseStoreLive = Layer.effect(
  DaemonReleaseStoreTag,
  releaseStoreScoped({
    directory: DAEMON_RELEASE_STORE_DIRECTORY,
    ownRelease: merkurRelease(),
    publicKeyBase64url: process.env.MERKUR_RELEASE_MLDSA87_PUBLIC_KEY ?? '',
    logger: createLogger('daemon-release-store'),
  }),
);
