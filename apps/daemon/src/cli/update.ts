import { randomUUID } from 'node:crypto';
import { constants, createReadStream, existsSync } from 'node:fs';
import {
  access,
  type FileHandle,
  mkdir,
  open,
  readdir,
  readlink,
  rename,
  rm,
  stat,
  symlink,
} from 'node:fs/promises';
import path from 'node:path';
import { createGunzip } from 'node:zlib';
import {
  currentReleasePlatform,
  latestReleaseAssetUrl,
  merkurReleasePublicKey,
  merkurReleaseSequence,
  merkurVersion,
  normalizeUnknownError,
  parseCanonicalReleaseManifest,
  RELEASE_ARTIFACT_MAX_BYTES,
  RELEASE_BOOTSTRAP_MINIMUM_SEQUENCE,
  RELEASE_MANIFEST_FILE,
  RELEASE_MANIFEST_MAX_BYTES,
  RELEASE_MANIFEST_MAX_FUTURE_MS,
  RELEASE_MANIFEST_SIGNATURE_FILE,
  RELEASE_SIGNATURE_MAX_BYTES,
  type ReleaseManifest,
  type ReleaseManifestArtifact,
  releaseArtifact,
  releaseAssetUrl,
} from '@merkur/shared';
import {
  decodeReleasePublicKey,
  decodeReleaseSignature,
  verifyReleaseManifestSignature,
} from '@merkur/shared/release-signature';
import { Cause, Clock, Data, Effect, Exit, Schedule } from 'effect';

import { loadDaemonConfigEffect, merkurInstallRootPath } from '../config';
import type { Logger } from '../logger';
import { installDaemonServiceForExecutableEffect } from './install';

const DAEMON_EXECUTABLE_NAME = 'merkur';
const DATAPLANE_EXECUTABLE_NAME = 'merkur-dataplane';
const IMAGE_WORKER_EXECUTABLE_NAME = 'merkur-image-worker';
const TUI_EXECUTABLE_NAME = 'merkur-tui';
const RELEASE_EXECUTABLE_NAMES = new Set([
  DAEMON_EXECUTABLE_NAME,
  DATAPLANE_EXECUTABLE_NAME,
  IMAGE_WORKER_EXECUTABLE_NAME,
  TUI_EXECUTABLE_NAME,
]);
const UPDATE_FETCH_ATTEMPT_TIMEOUT = '10 seconds';
const UPDATE_FETCH_OVERALL_TIMEOUT = '30 seconds';
const UPDATE_FETCH_ATTEMPT_TIMEOUT_MS = 10_000;
const UPDATE_FETCH_OVERALL_TIMEOUT_MS = 30_000;
const UPDATE_FETCH_RETRY_COUNT = 2;
const UPDATE_ARTIFACT_HEADER_TIMEOUT_MS = 10_000;
const UPDATE_ARTIFACT_INACTIVITY_TIMEOUT_MS = 10_000;
const UPDATE_ARTIFACT_ATTEMPT_FLOOR_MS = 30_000;
const UPDATE_ARTIFACT_MINIMUM_BYTES_PER_SECOND = 128 * 1024;
const UPDATE_ARTIFACT_RETRY_OVERHEAD_MS = 2_000;
const RELEASE_TRUST_STATE_FILE = 'release-trust.json';
const RELEASE_TRUST_STATE_TEMP_FILE = '.release-trust.json.new';
const SHA512_HEX_PATTERN = /^[0-9a-f]{128}$/;
const TAR_BLOCK_BYTES = 512;
const TAR_MAX_EXPANDED_BYTES = 1024 * 1024 * 1024;
const TEXT_DECODER = new TextDecoder('utf-8', { fatal: true });
const TEXT_ENCODER = new TextEncoder();

export class DaemonUpdateTransportError extends Data.TaggedError('DaemonUpdateTransportError')<{
  readonly cause: unknown;
  readonly operation: string;
}> {}

export class DaemonUpdateTimeoutError extends Data.TaggedError('DaemonUpdateTimeoutError')<{
  readonly deadlineMs: number;
  readonly operation: string;
}> {}

export class DaemonUpdateHttpError extends Data.TaggedError('DaemonUpdateHttpError')<{
  readonly operation: string;
  readonly status: number;
}> {}

export class DaemonUpdatePayloadError extends Data.TaggedError('DaemonUpdatePayloadError')<{
  readonly message: string;
  readonly operation: string;
}> {}

export class DaemonUpdateTrustError extends Data.TaggedError('DaemonUpdateTrustError')<{
  readonly cause?: unknown;
  readonly message: string;
}> {}

export class DaemonUpdatePersistenceError extends Data.TaggedError('DaemonUpdatePersistenceError')<{
  readonly cause: unknown;
  readonly operation: string;
}> {}

type DaemonUpdateFetchError =
  | DaemonUpdateTransportError
  | DaemonUpdateTimeoutError
  | DaemonUpdateHttpError
  | DaemonUpdatePayloadError;

export type DaemonUpdateFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface VersionedDaemonExecutables {
  readonly daemon: string;
  readonly dataplane: string;
  readonly imageWorker: string;
  readonly tui: string;
}

export interface ReleaseTrustFloor {
  readonly manifestSha512: string | null;
  readonly sequence: number;
}

export interface VerifiedReleaseCandidate {
  readonly artifact: ReleaseManifestArtifact;
  readonly manifest: ReleaseManifest;
  readonly manifestSha512: string;
}

export interface DaemonUpdateActivationDependencies {
  readonly verifyExecutables: (
    executables: VersionedDaemonExecutables,
  ) => Effect.Effect<void, Error>;
  readonly readCurrentSymlinkTarget: (installRoot: string) => Effect.Effect<string | null, Error>;
  readonly swapCurrentSymlinkTarget: (
    installRoot: string,
    target: string,
  ) => Effect.Effect<void, Error>;
  readonly removeCurrentSymlink: (installRoot: string) => Effect.Effect<void, Error>;
  readonly activateDaemonService: (executablePath: string) => Effect.Effect<number, Error>;
}

export async function runUpdateCommand(logger: Logger): Promise<number> {
  return Effect.runPromise(runUpdateCommandEffect(logger));
}

function runUpdateCommandEffect(logger: Logger): Effect.Effect<number, Error> {
  return Effect.gen(function* () {
    const currentVersion = merkurVersion();
    if (currentVersion === 'dev') {
      logger.error('daemon_update_unsupported', {
        reason: 'running from source; update with git instead',
      });
      return 1;
    }

    const platform = currentReleasePlatform();
    if (platform === null) {
      logger.error('daemon_update_unsupported', {
        reason: `no release artifacts for ${process.platform}-${process.arch}`,
      });
      return 1;
    }

    const latestVersion = yield* fetchLatestVersionEffect();
    const installRoot = merkurInstallRootPath();
    const currentSequence = merkurReleaseSequence();
    if (currentSequence < RELEASE_BOOTSTRAP_MINIMUM_SEQUENCE) {
      return yield* new DaemonUpdateTrustError({
        message: 'daemon release sequence is not embedded; refusing release trust',
      });
    }

    const now = yield* Clock.currentTimeMillis;
    const trustFloor = yield* readReleaseTrustFloorEffect(installRoot, currentSequence);
    const candidate = yield* loadVerifiedReleaseCandidateEffect({
      consumerSequence: currentSequence,
      consumerVersion: currentVersion,
      expectedVersion: latestVersion,
      now,
      platform,
      publicKeyBase64url: merkurReleasePublicKey(),
      trustFloor,
    });

    if (candidate.manifest.version === currentVersion) {
      yield* persistReleaseTrustFloorEffect(installRoot, {
        manifestSha512: candidate.manifestSha512,
        sequence: candidate.manifest.sequence,
      });
      logger.info('daemon_update_up_to_date', {
        sequence: candidate.manifest.sequence,
        version: currentVersion,
      });
      return 0;
    }

    logger.info('daemon_update_started', {
      from: currentVersion,
      sequence: candidate.manifest.sequence,
      to: candidate.manifest.version,
    });
    yield* installVerifiedReleaseEffect({
      logger,
      installRoot,
      candidate,
      artifactUrl: releaseAssetUrl(candidate.manifest.version, candidate.artifact.name),
      previousVersion: currentVersion,
    });
    logger.info('daemon_update_success', {
      from: currentVersion,
      sequence: candidate.manifest.sequence,
      to: candidate.manifest.version,
    });
    return 0;
  });
}

/**
 * Installs one release whose manifest has already been verified: streams the
 * artifact through the manifest's size and SHA-512 checks, raises the rollback
 * floor, extracts it into `versions/<version>`, and activates it.
 *
 * Shared by `update`, which downloads from GitHub, and `setup`, which reads the
 * tarball the installer already fetched through a `file:` URL. One pipeline, so
 * the first install is held to exactly the checks every later update is.
 *
 * The service is (re)installed only when a daemon config exists. An unlinked
 * daemon exits on its missing config, so a supervised unit for one would
 * crash-loop until someone linked it; a successful `merkur link` installs it.
 */
export function installVerifiedReleaseEffect(input: {
  readonly logger: Logger;
  readonly installRoot: string;
  readonly candidate: VerifiedReleaseCandidate;
  readonly artifactUrl: string;
  readonly previousVersion: string | null;
}): Effect.Effect<void, Error> {
  return Effect.gen(function* () {
    const { candidate, installRoot, logger } = input;
    const downloadDirectory = path.join(installRoot, 'tmp', candidate.manifest.version);
    yield* Effect.tryPromise({
      try: () => mkdir(downloadDirectory, { recursive: true }),
      catch: normalizeUnknownError,
    });

    const artifactPath = path.join(downloadDirectory, candidate.artifact.name);
    yield* downloadReleaseArtifactToFileEffect(input.artifactUrl, artifactPath, candidate.artifact);
    yield* persistReleaseTrustFloorEffect(installRoot, {
      manifestSha512: candidate.manifestSha512,
      sequence: candidate.manifest.sequence,
    });

    const versionsDirectory = path.join(installRoot, 'versions');
    const versionDirectory = path.join(versionsDirectory, candidate.manifest.version);
    yield* Effect.tryPromise({
      try: () => mkdir(versionsDirectory, { recursive: true, mode: 0o700 }),
      catch: normalizeUnknownError,
    });
    const linked = (yield* loadDaemonConfigEffect()) !== null;
    const dependencies: DaemonUpdateActivationDependencies = {
      ...LIVE_ACTIVATION_DEPENDENCIES,
      activateDaemonService: (executablePath) =>
        linked
          ? installDaemonServiceForExecutableEffect(logger, executablePath)
          : Effect.succeed(0),
    };
    let keepVersionDirectory = false;
    yield* Effect.acquireUseRelease(
      Effect.tryPromise({
        try: async () => {
          await mkdir(versionDirectory, { mode: 0o700 });
          return versionDirectory;
        },
        catch: normalizeUnknownError,
      }),
      () =>
        extractTarballEffect(artifactPath, versionDirectory).pipe(
          Effect.andThen(
            Effect.uninterruptible(
              activateVersionedDaemonEffect(installRoot, versionDirectory, dependencies).pipe(
                Effect.tap(() =>
                  Effect.sync(() => {
                    keepVersionDirectory = true;
                  }),
                ),
              ),
            ),
          ),
        ),
      () =>
        keepVersionDirectory
          ? Effect.void
          : Effect.tryPromise({
              try: () => rm(versionDirectory, { recursive: true, force: true }),
              catch: normalizeUnknownError,
            }),
    );
    yield* pruneEffect(
      installRoot,
      downloadDirectory,
      candidate.manifest.version,
      input.previousVersion,
      logger,
    );
  });
}

/**
 * The newest release's version, read out of the latest signed manifest.
 *
 * Nothing here is trusted: the version only selects which tag the manifest and
 * its signature are fetched from, and that pair is what gets verified.
 */
export function fetchLatestVersionEffect(
  fetchImpl: DaemonUpdateFetch = globalThis.fetch,
): Effect.Effect<string, DaemonUpdateFetchError> {
  const operation = 'release-version-lookup';
  return updaterGet(
    fetchImpl,
    latestReleaseAssetUrl(RELEASE_MANIFEST_FILE),
    operation,
    (response) =>
      readBoundedResponseEffect(response, RELEASE_MANIFEST_MAX_BYTES, operation).pipe(
        Effect.flatMap((bytes) =>
          Effect.try({
            try: () => parseCanonicalReleaseManifest(bytes).version,
            catch: () =>
              new DaemonUpdatePayloadError({
                message: 'latest release manifest is not a canonical release manifest',
                operation,
              }),
          }),
        ),
      ),
  );
}

export function downloadEffect(
  url: string,
  fetchImpl: DaemonUpdateFetch = globalThis.fetch,
  maximumBytes = RELEASE_ARTIFACT_MAX_BYTES,
): Effect.Effect<Uint8Array, DaemonUpdateFetchError> {
  const operation = 'release-asset-download';
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0) {
    return Effect.fail(
      new DaemonUpdatePayloadError({
        message: 'release download limit must be a positive safe integer',
        operation,
      }),
    );
  }
  return updaterGet(fetchImpl, url, operation, (response) => {
    const contentLength = response.headers.get('content-length');
    if (contentLength !== null) {
      const declaredLength = Number(contentLength);
      if (
        !/^\d+$/.test(contentLength) ||
        !Number.isSafeInteger(declaredLength) ||
        declaredLength > maximumBytes
      ) {
        return Effect.fail(
          new DaemonUpdatePayloadError({
            message: `release asset exceeds ${maximumBytes} bytes`,
            operation,
          }),
        );
      }
    }
    return readBoundedResponseEffect(response, maximumBytes, operation);
  });
}

/**
 * Stream one signed release artifact to an exclusive temporary file, verify it
 * while writing, and publish it with one same-directory rename.
 *
 * The manifest owns the exact byte count and SHA-512 digest. No full-artifact
 * buffer exists: steady-state memory is one fetch chunk plus the runtime's
 * socket buffering, independent of archive size.
 */
export function downloadReleaseArtifactToFileEffect(
  url: string,
  destinationPath: string,
  artifact: ReleaseManifestArtifact,
  fetchImpl: DaemonUpdateFetch = globalThis.fetch,
): Effect.Effect<
  void,
  DaemonUpdateFetchError | DaemonUpdateTrustError | DaemonUpdatePersistenceError
> {
  const operation = 'release-asset-download';
  if (!Number.isSafeInteger(artifact.size) || artifact.size <= 0) {
    return Effect.fail(
      new DaemonUpdatePayloadError({
        message: 'release artifact size must be a positive safe integer',
        operation,
      }),
    );
  }
  if (!SHA512_HEX_PATTERN.test(artifact.sha512)) {
    return Effect.fail(
      new DaemonUpdateTrustError({ message: `invalid SHA-512 for ${artifact.name}` }),
    );
  }

  const attemptTimeoutMs = artifactAttemptTimeoutMs(artifact.size);
  const attempt = Effect.tryPromise({
    try: (signal) =>
      streamReleaseArtifactAttempt({
        artifact,
        attemptTimeoutMs,
        destinationPath,
        fetchImpl,
        operation,
        signal,
        url,
      }),
    catch: (cause) => classifyArtifactDownloadFailure(cause, operation),
  });
  const overallTimeoutMs =
    attemptTimeoutMs * (UPDATE_FETCH_RETRY_COUNT + 1) + UPDATE_ARTIFACT_RETRY_OVERHEAD_MS;

  return attempt.pipe(
    Effect.retry({
      times: UPDATE_FETCH_RETRY_COUNT,
      schedule: Schedule.exponential('200 millis'),
      while: isTransientArtifactDownloadError,
    }),
    Effect.timeoutOrElse({
      duration: `${overallTimeoutMs} millis`,
      orElse: () =>
        Effect.fail(
          new DaemonUpdateTimeoutError({
            deadlineMs: overallTimeoutMs,
            operation,
          }),
        ),
    }),
  );
}

interface StreamReleaseArtifactAttemptInput {
  readonly artifact: ReleaseManifestArtifact;
  readonly attemptTimeoutMs: number;
  readonly destinationPath: string;
  readonly fetchImpl: DaemonUpdateFetch;
  readonly operation: string;
  readonly signal: AbortSignal;
  readonly url: string;
}

async function streamReleaseArtifactAttempt(
  input: StreamReleaseArtifactAttemptInput,
): Promise<void> {
  const temporaryPath = `${input.destinationPath}.part-${process.pid}-${randomUUID()}`;
  const controller = new AbortController();
  const abortFromParent = (): void => controller.abort(input.signal.reason);
  input.signal.addEventListener('abort', abortFromParent, { once: true });
  if (input.signal.aborted) abortFromParent();

  let deadline: ReturnType<typeof setTimeout> | undefined;
  const armDeadline = (deadlineMs: number): void => {
    if (deadline !== undefined) clearTimeout(deadline);
    deadline = setTimeout(() => {
      controller.abort(new DaemonUpdateTimeoutError({ deadlineMs, operation: input.operation }));
    }, deadlineMs);
  };
  const overallDeadline = setTimeout(() => {
    controller.abort(
      new DaemonUpdateTimeoutError({
        deadlineMs: input.attemptTimeoutMs,
        operation: input.operation,
      }),
    );
  }, input.attemptTimeoutMs);

  let file: FileHandle | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let published = false;
  try {
    file = await persistencePromise(open(temporaryPath, 'wx', 0o600), input.operation);
    armDeadline(UPDATE_ARTIFACT_HEADER_TIMEOUT_MS);
    const response = await input.fetchImpl(input.url, {
      headers: { 'user-agent': 'merkur-daemon-updater' },
      signal: controller.signal,
    });
    reader = response.body?.getReader();
    if (!response.ok) {
      throw new DaemonUpdateHttpError({ operation: input.operation, status: response.status });
    }
    validateArtifactContentLength(response, input.artifact, input.operation);

    const hasher = new Bun.CryptoHasher('sha512');
    let total = 0;
    armDeadline(UPDATE_ARTIFACT_INACTIVITY_TIMEOUT_MS);
    if (reader !== undefined) {
      while (true) {
        const next = await readStreamWithAbort(reader, controller.signal);
        if (next.done) break;
        if (next.value.byteLength === 0) continue;
        total += next.value.byteLength;
        if (total > input.artifact.size) {
          throw new DaemonUpdatePayloadError({
            message: `release asset exceeds ${input.artifact.size} bytes`,
            operation: input.operation,
          });
        }
        hasher.update(next.value);
        await persistencePromise(writeEntireChunk(file, next.value), input.operation);
        armDeadline(UPDATE_ARTIFACT_INACTIVITY_TIMEOUT_MS);
      }
    }

    if (total !== input.artifact.size) {
      throw new DaemonUpdateTrustError({
        message: `${input.artifact.name} has ${total} bytes; expected ${input.artifact.size}`,
      });
    }
    const digest = hasher.digest('hex');
    if (digest !== input.artifact.sha512) {
      throw new DaemonUpdateTrustError({
        message: `SHA-512 mismatch for ${input.artifact.name}`,
      });
    }
    await persistencePromise(file.sync(), input.operation);
    await persistencePromise(file.close(), input.operation);
    file = undefined;
    await persistencePromise(rename(temporaryPath, input.destinationPath), input.operation);
    published = true;
  } finally {
    if (deadline !== undefined) clearTimeout(deadline);
    clearTimeout(overallDeadline);
    input.signal.removeEventListener('abort', abortFromParent);
    if (!published) {
      try {
        await reader?.cancel('release download did not commit');
      } catch {
        // Preserve the primary download, trust, timeout, or interruption error.
      }
      try {
        await file?.close();
      } catch {
        // `rm` below is still attempted after a close failure.
      }
      await persistencePromise(rm(temporaryPath, { force: true }), input.operation);
    }
    reader?.releaseLock();
  }
}

function artifactAttemptTimeoutMs(expectedBytes: number): number {
  return Math.max(
    UPDATE_ARTIFACT_ATTEMPT_FLOOR_MS,
    UPDATE_ARTIFACT_HEADER_TIMEOUT_MS +
      Math.ceil((expectedBytes / UPDATE_ARTIFACT_MINIMUM_BYTES_PER_SECOND) * 1_000),
  );
}

function validateArtifactContentLength(
  response: Response,
  artifact: ReleaseManifestArtifact,
  operation: string,
): void {
  const contentLength = response.headers.get('content-length');
  if (contentLength === null) return;
  const declaredLength = Number(contentLength);
  if (!/^\d+$/.test(contentLength) || !Number.isSafeInteger(declaredLength)) {
    throw new DaemonUpdatePayloadError({
      message: 'release asset has an invalid content-length',
      operation,
    });
  }
  if (declaredLength !== artifact.size) {
    throw new DaemonUpdatePayloadError({
      message: `release asset declares ${declaredLength} bytes; expected ${artifact.size}`,
      operation,
    });
  }
}

async function writeEntireChunk(file: FileHandle, chunk: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < chunk.byteLength) {
    const { bytesWritten } = await file.write(chunk, offset, chunk.byteLength - offset);
    if (bytesWritten <= 0) throw new Error('release artifact write made no progress');
    offset += bytesWritten;
  }
}

function readStreamWithAbort(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): ReturnType<ReadableStreamDefaultReader<Uint8Array>['read']> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const aborted = (): void => reject(signal.reason);
    signal.addEventListener('abort', aborted, { once: true });
    reader.read().then(
      (result) => {
        signal.removeEventListener('abort', aborted);
        resolve(result);
      },
      (cause: unknown) => {
        signal.removeEventListener('abort', aborted);
        reject(cause);
      },
    );
  });
}

function classifyArtifactDownloadFailure(
  cause: unknown,
  operation: string,
): DaemonUpdateFetchError | DaemonUpdateTrustError | DaemonUpdatePersistenceError {
  if (
    cause instanceof DaemonUpdateTransportError ||
    cause instanceof DaemonUpdateTimeoutError ||
    cause instanceof DaemonUpdateHttpError ||
    cause instanceof DaemonUpdatePayloadError ||
    cause instanceof DaemonUpdateTrustError ||
    cause instanceof DaemonUpdatePersistenceError
  ) {
    return cause;
  }
  return new DaemonUpdateTransportError({ cause, operation });
}

function isTransientArtifactDownloadError(
  error: DaemonUpdateFetchError | DaemonUpdateTrustError | DaemonUpdatePersistenceError,
): error is DaemonUpdateFetchError {
  return (
    error._tag !== 'DaemonUpdateTrustError' &&
    error._tag !== 'DaemonUpdatePersistenceError' &&
    isTransientUpdateFetchError(error)
  );
}

async function persistencePromise<A>(promise: Promise<A>, operation: string): Promise<A> {
  try {
    return await promise;
  } catch (cause) {
    throw new DaemonUpdatePersistenceError({ cause, operation });
  }
}

function updaterGet<A>(
  fetchImpl: DaemonUpdateFetch,
  url: string,
  operation: string,
  decode: (response: Response) => Effect.Effect<A, DaemonUpdateFetchError>,
): Effect.Effect<A, DaemonUpdateFetchError> {
  const attempt = Effect.acquireUseRelease(
    Effect.sync(() => new AbortController()),
    (controller) =>
      Effect.tryPromise({
        try: () =>
          fetchImpl(url, {
            headers: { 'user-agent': 'merkur-daemon-updater' },
            signal: controller.signal,
          }),
        catch: (cause) => new DaemonUpdateTransportError({ cause, operation }),
      }).pipe(
        Effect.flatMap((response) => {
          if (!response.ok) {
            return Effect.fail(
              new DaemonUpdateHttpError({
                operation,
                status: response.status,
              }),
            );
          }
          return decode(response);
        }),
      ),
    (controller) =>
      Effect.sync(() => {
        if (!controller.signal.aborted) {
          controller.abort();
        }
      }),
  ).pipe(
    Effect.timeoutOrElse({
      duration: UPDATE_FETCH_ATTEMPT_TIMEOUT,
      orElse: () =>
        Effect.fail(
          new DaemonUpdateTimeoutError({
            deadlineMs: UPDATE_FETCH_ATTEMPT_TIMEOUT_MS,
            operation,
          }),
        ),
    }),
  );

  return attempt.pipe(
    Effect.retry({
      times: UPDATE_FETCH_RETRY_COUNT,
      schedule: Schedule.exponential('200 millis'),
      while: isTransientUpdateFetchError,
    }),
    Effect.timeoutOrElse({
      duration: UPDATE_FETCH_OVERALL_TIMEOUT,
      orElse: () =>
        Effect.fail(
          new DaemonUpdateTimeoutError({
            deadlineMs: UPDATE_FETCH_OVERALL_TIMEOUT_MS,
            operation,
          }),
        ),
    }),
  );
}

function isTransientUpdateFetchError(error: DaemonUpdateFetchError): boolean {
  return (
    error instanceof DaemonUpdateTransportError ||
    error instanceof DaemonUpdateTimeoutError ||
    (error instanceof DaemonUpdateHttpError && isTransientHttpStatus(error.status))
  );
}

function isTransientHttpStatus(status: number): boolean {
  return (
    status === 408 ||
    status === 429 ||
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504
  );
}

function readBoundedResponseEffect(
  response: Response,
  maximumBytes: number,
  operation: string,
): Effect.Effect<Uint8Array, DaemonUpdateFetchError> {
  return Effect.tryPromise({
    try: async () => {
      const reader = response.body?.getReader();
      if (reader === undefined) return new Uint8Array(0);
      const chunks: Uint8Array[] = [];
      let total = 0;
      try {
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          total += next.value.byteLength;
          if (total > maximumBytes) {
            await reader.cancel('release asset exceeded the byte limit');
            throw new DaemonUpdatePayloadError({
              message: `release asset exceeds ${maximumBytes} bytes`,
              operation,
            });
          }
          chunks.push(next.value);
        }
      } finally {
        reader.releaseLock();
      }

      const result = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        result.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return result;
    },
    catch: (cause) =>
      cause instanceof DaemonUpdatePayloadError
        ? cause
        : new DaemonUpdateTransportError({ cause, operation }),
  });
}

export function verifyReleaseCandidateEffect(input: {
  readonly consumerSequence: number;
  readonly consumerVersion: string;
  readonly expectedVersion: string;
  readonly manifestBytes: Uint8Array;
  readonly now: number;
  readonly platform: Parameters<typeof releaseArtifact>[1];
  readonly publicKeyBase64url: string;
  readonly signatureBytes: Uint8Array;
  readonly trustFloor: ReleaseTrustFloor;
}): Effect.Effect<VerifiedReleaseCandidate, DaemonUpdateTrustError> {
  return Effect.try({
    try: () => {
      const manifest = parseCanonicalReleaseManifest(input.manifestBytes);
      if (manifest.version !== input.expectedVersion) {
        throw new Error('signed release version does not match the requested GitHub tag');
      }
      if (!Number.isSafeInteger(input.now) || input.now <= 0 || input.now >= manifest.expiresAt) {
        throw new Error('signed release manifest is expired');
      }
      if (manifest.expiresAt - input.now > RELEASE_MANIFEST_MAX_FUTURE_MS) {
        throw new Error('signed release manifest expiry exceeds the 30-day trust window');
      }
      if (
        !Number.isSafeInteger(input.consumerSequence) ||
        input.consumerSequence < manifest.minimumSequence
      ) {
        throw new Error(`release requires installed sequence ${manifest.minimumSequence} or newer`);
      }
      const publicKey = decodeReleasePublicKey(input.publicKeyBase64url);
      let signature: Uint8Array | undefined;
      try {
        const signatureText = TEXT_DECODER.decode(input.signatureBytes);
        signature = decodeReleaseSignature(signatureText);
        if (!verifyReleaseManifestSignature(input.manifestBytes, signature, publicKey)) {
          throw new Error('ML-DSA-87 release signature verification failed');
        }
      } finally {
        publicKey.fill(0);
        signature?.fill(0);
      }

      const manifestSha512 = sha512Hex(input.manifestBytes);
      if (manifest.sequence < input.trustFloor.sequence) {
        throw new Error(
          `release sequence ${manifest.sequence} is below rollback floor ${input.trustFloor.sequence}`,
        );
      }
      if (
        manifest.sequence === input.consumerSequence &&
        manifest.version !== input.consumerVersion
      ) {
        throw new Error('release sequence was reused for a different version');
      }
      if (
        manifest.sequence === input.trustFloor.sequence &&
        input.trustFloor.manifestSha512 !== null &&
        input.trustFloor.manifestSha512 !== manifestSha512
      ) {
        throw new Error('release sequence was reused for a different signed manifest');
      }

      return {
        artifact: releaseArtifact(manifest, input.platform),
        manifest,
        manifestSha512,
      };
    },
    catch: (cause) =>
      new DaemonUpdateTrustError({
        cause,
        message: cause instanceof Error ? cause.message : 'release trust verification failed',
      }),
  });
}

export function loadVerifiedReleaseCandidateEffect(input: {
  readonly consumerSequence: number;
  readonly consumerVersion: string;
  readonly expectedVersion: string;
  readonly now: number;
  readonly platform: Parameters<typeof releaseArtifact>[1];
  readonly publicKeyBase64url: string;
  readonly trustFloor: ReleaseTrustFloor;
}): Effect.Effect<VerifiedReleaseCandidate, DaemonUpdateFetchError | DaemonUpdateTrustError> {
  return Effect.acquireUseRelease(
    Effect.all(
      [
        downloadEffect(
          releaseAssetUrl(input.expectedVersion, RELEASE_MANIFEST_FILE),
          globalThis.fetch,
          RELEASE_MANIFEST_MAX_BYTES,
        ),
        downloadEffect(
          releaseAssetUrl(input.expectedVersion, RELEASE_MANIFEST_SIGNATURE_FILE),
          globalThis.fetch,
          // Signature assets are exactly 6,170 canonical base64url bytes. A
          // trailing newline is deliberately non-canonical and rejected.
          RELEASE_SIGNATURE_MAX_BYTES,
        ),
      ],
      { concurrency: 'unbounded' },
    ),
    ([manifestBytes, signatureBytes]) =>
      verifyReleaseCandidateEffect({
        consumerSequence: input.consumerSequence,
        consumerVersion: input.consumerVersion,
        expectedVersion: input.expectedVersion,
        manifestBytes,
        now: input.now,
        platform: input.platform,
        publicKeyBase64url: input.publicKeyBase64url,
        signatureBytes,
        trustFloor: input.trustFloor,
      }),
    ([manifestBytes, signatureBytes]) =>
      Effect.sync(() => {
        manifestBytes.fill(0);
        signatureBytes.fill(0);
      }),
  );
}

function sha512Hex(bytes: Uint8Array): string {
  const hasher = new Bun.CryptoHasher('sha512');
  hasher.update(bytes);
  return hasher.digest('hex');
}

export function readReleaseTrustFloorEffect(
  installRoot: string,
  embeddedSequence: number,
): Effect.Effect<ReleaseTrustFloor, DaemonUpdateTrustError> {
  return Effect.tryPromise({
    try: async () => {
      const baseline = Math.max(RELEASE_BOOTSTRAP_MINIMUM_SEQUENCE, embeddedSequence);
      let bytes: Uint8Array;
      try {
        bytes = await Bun.file(path.join(installRoot, RELEASE_TRUST_STATE_FILE)).bytes();
      } catch (cause) {
        if (isNoEntryError(cause)) return { manifestSha512: null, sequence: baseline };
        throw cause;
      }

      const state = parseCanonicalReleaseTrustState(bytes);
      return {
        // The saved hash authenticates only its saved sequence. A newer
        // installer's embedded floor must not relabel that older manifest.
        manifestSha512: state.sequence >= baseline ? state.manifestSha512 : null,
        sequence: Math.max(baseline, state.sequence),
      };
    },
    catch: (cause) =>
      new DaemonUpdateTrustError({ cause, message: 'failed to read release rollback floor' }),
  });
}

export function persistReleaseTrustFloorEffect(
  installRoot: string,
  next: ReleaseTrustFloor,
): Effect.Effect<void, DaemonUpdateTrustError> {
  const lockDirectory = path.join(installRoot, 'release-trust.lock');
  return Effect.gen(function* () {
    yield* Effect.tryPromise({
      try: () => mkdir(installRoot, { recursive: true, mode: 0o700 }),
      catch: (cause) =>
        new DaemonUpdateTrustError({
          cause,
          message: 'failed to create the release trust-state directory',
        }),
    });
    yield* Effect.acquireUseRelease(
      Effect.tryPromise({
        try: () => mkdir(lockDirectory),
        catch: (cause) =>
          new DaemonUpdateTrustError({
            cause,
            message: 'another update owns the release trust-state lock',
          }),
      }),
      () =>
        Effect.uninterruptible(
          Effect.gen(function* () {
            validateReleaseTrustFloor(next);
            const current = yield* readReleaseTrustFloorEffect(
              installRoot,
              Math.max(RELEASE_BOOTSTRAP_MINIMUM_SEQUENCE, merkurReleaseSequence()),
            );
            if (next.sequence < current.sequence) {
              return yield* new DaemonUpdateTrustError({
                message: `refusing to lower release rollback floor from ${current.sequence} to ${next.sequence}`,
              });
            }
            if (
              next.sequence === current.sequence &&
              current.manifestSha512 !== null &&
              current.manifestSha512 !== next.manifestSha512
            ) {
              return yield* new DaemonUpdateTrustError({
                message: 'refusing a different manifest at the persisted release sequence',
              });
            }
            yield* writeReleaseTrustStateEffect(installRoot, next);
          }),
        ),
      () =>
        Effect.tryPromise({
          try: () => rm(lockDirectory, { recursive: true, force: true }),
          catch: (cause) =>
            new DaemonUpdateTrustError({
              cause,
              message: 'failed to release the release trust-state lock',
            }),
        }),
    );
  });
}

function writeReleaseTrustStateEffect(
  installRoot: string,
  state: ReleaseTrustFloor,
): Effect.Effect<void, DaemonUpdateTrustError> {
  const target = path.join(installRoot, RELEASE_TRUST_STATE_FILE);
  const temporary = path.join(installRoot, RELEASE_TRUST_STATE_TEMP_FILE);
  const bytes = encodeReleaseTrustState(state);
  const write = Effect.gen(function* () {
    yield* Effect.acquireUseRelease(
      Effect.tryPromise({
        try: () => open(temporary, 'wx', 0o600),
        catch: (cause) =>
          new DaemonUpdateTrustError({ cause, message: 'failed to create release trust state' }),
      }),
      (handle) =>
        Effect.tryPromise({
          try: async () => {
            await handle.writeFile(bytes);
            await handle.sync();
          },
          catch: (cause) =>
            new DaemonUpdateTrustError({ cause, message: 'failed to flush release trust state' }),
        }),
      (handle) =>
        Effect.tryPromise({
          try: () => handle.close(),
          catch: (cause) =>
            new DaemonUpdateTrustError({ cause, message: 'failed to close release trust state' }),
        }),
    );
    yield* Effect.tryPromise({
      try: () => rename(temporary, target),
      catch: (cause) =>
        new DaemonUpdateTrustError({ cause, message: 'failed to commit release trust state' }),
    });
    yield* syncDirectoryEffect(installRoot);
  });
  return write.pipe(
    Effect.ensuring(
      Effect.tryPromise({
        try: () => rm(temporary, { force: true }),
        catch: normalizeUnknownError,
      }).pipe(Effect.ignore),
    ),
  );
}

function syncDirectoryEffect(directory: string): Effect.Effect<void, DaemonUpdateTrustError> {
  return Effect.acquireUseRelease(
    Effect.tryPromise({
      try: () => open(directory, 'r'),
      catch: (cause) =>
        new DaemonUpdateTrustError({ cause, message: 'failed to open release trust directory' }),
    }),
    (handle) =>
      Effect.tryPromise({
        try: () => handle.sync(),
        catch: (cause) =>
          new DaemonUpdateTrustError({ cause, message: 'failed to flush release trust directory' }),
      }),
    (handle) =>
      Effect.tryPromise({
        try: () => handle.close(),
        catch: (cause) =>
          new DaemonUpdateTrustError({ cause, message: 'failed to close release trust directory' }),
      }),
  );
}

function encodeReleaseTrustState(state: ReleaseTrustFloor): Uint8Array {
  validateReleaseTrustFloor(state);
  return TEXT_ENCODER.encode(`${JSON.stringify(state)}\n`);
}

function parseCanonicalReleaseTrustState(bytes: Uint8Array): ReleaseTrustFloor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(TEXT_DECODER.decode(bytes));
  } catch (cause) {
    throw new Error('release trust state is not valid UTF-8 JSON', { cause });
  }
  if (!isRecord(parsed)) throw new Error('release trust state must be an object');
  const keys = Object.keys(parsed);
  if (keys.length !== 2 || keys[0] !== 'manifestSha512' || keys[1] !== 'sequence') {
    throw new Error('release trust state does not have canonical fields');
  }
  const state = {
    manifestSha512: parsed.manifestSha512,
    sequence: parsed.sequence,
  };
  validateReleaseTrustFloor(state);
  const canonical = encodeReleaseTrustState(state);
  if (!bytesEqual(bytes, canonical)) throw new Error('release trust state bytes are not canonical');
  return state;
}

function validateReleaseTrustFloor(value: unknown): asserts value is ReleaseTrustFloor {
  if (!isRecord(value)) throw new Error('release trust floor must be an object');
  if (
    typeof value.sequence !== 'number' ||
    !Number.isSafeInteger(value.sequence) ||
    value.sequence < RELEASE_BOOTSTRAP_MINIMUM_SEQUENCE
  ) {
    throw new Error('release trust sequence must be a positive safe integer');
  }
  if (
    value.manifestSha512 !== null &&
    (typeof value.manifestSha512 !== 'string' || !SHA512_HEX_PATTERN.test(value.manifestSha512))
  ) {
    throw new Error('release trust manifest hash must be a lowercase SHA-512 digest');
  }
}

function isNoEntryError(value: unknown): boolean {
  return isRecord(value) && value.code === 'ENOENT';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

class ReleaseTarValidator {
  private readonly entries = new Set<string>();
  private ended = false;
  private expandedBytes = 0;
  private pending = new Uint8Array(0);
  private skipBytes = 0;
  private zeroBlocks = 0;

  push(chunk: Uint8Array): void {
    this.expandedBytes += chunk.byteLength;
    if (this.expandedBytes > TAR_MAX_EXPANDED_BYTES) {
      throw new Error(`release archive expands beyond ${TAR_MAX_EXPANDED_BYTES} bytes`);
    }

    const bytes = concatenateBytes(this.pending, chunk);
    let offset = 0;
    while (offset < bytes.byteLength) {
      if (this.ended) {
        requireZeroBytes(bytes.subarray(offset), 'release archive trailing data');
        offset = bytes.byteLength;
        break;
      }
      if (this.skipBytes > 0) {
        const consumed = Math.min(this.skipBytes, bytes.byteLength - offset);
        this.skipBytes -= consumed;
        offset += consumed;
        continue;
      }
      if (bytes.byteLength - offset < TAR_BLOCK_BYTES) break;

      const header = bytes.subarray(offset, offset + TAR_BLOCK_BYTES);
      offset += TAR_BLOCK_BYTES;
      if (isZeroBytes(header)) {
        this.zeroBlocks += 1;
        if (this.zeroBlocks === 2) this.ended = true;
        continue;
      }
      if (this.zeroBlocks !== 0) {
        throw new Error('release archive has data after an incomplete end marker');
      }
      const size = this.validateHeader(header);
      this.skipBytes = Math.ceil(size / TAR_BLOCK_BYTES) * TAR_BLOCK_BYTES;
    }
    this.pending = bytes.slice(offset);
  }

  finish(): void {
    if (this.skipBytes !== 0 || this.pending.byteLength !== 0 || !this.ended) {
      throw new Error('release archive is truncated or missing its end marker');
    }
    const expected = RELEASE_EXECUTABLE_NAMES;
    if (
      this.entries.size !== expected.size ||
      [...expected].some((entry) => !this.entries.has(entry))
    ) {
      throw new Error(`release archive must contain exactly ${[...expected].join(', ')}`);
    }
  }

  private validateHeader(header: Uint8Array): number {
    const expectedChecksum = parseTarOctal(header.subarray(148, 156), 'header checksum');
    let actualChecksum = 0;
    for (let index = 0; index < header.byteLength; index += 1) {
      actualChecksum += index >= 148 && index < 156 ? 0x20 : (header[index] ?? 0);
    }
    if (actualChecksum !== expectedChecksum) {
      throw new Error('release archive header checksum is invalid');
    }
    if (readTarString(header.subarray(257, 263), 'archive magic') !== 'ustar') {
      throw new Error('release archive must use the ustar format');
    }
    if (readTarString(header.subarray(345, 500), 'archive path prefix') !== '') {
      throw new Error('release archive path prefixes are forbidden');
    }
    requireZeroBytes(header.subarray(500), 'release archive extension bytes');

    const name = readTarString(header.subarray(0, 100), 'archive entry name');
    if (!RELEASE_EXECUTABLE_NAMES.has(name)) {
      throw new Error(`release archive entry is forbidden: ${name}`);
    }
    if (this.entries.has(name)) throw new Error(`release archive entry is duplicated: ${name}`);
    const type = header[156];
    if (type !== 0 && type !== 0x30) {
      throw new Error(`release archive entry ${name} is not a regular file`);
    }
    if (readTarString(header.subarray(157, 257), 'archive link target') !== '') {
      throw new Error(`release archive entry ${name} has a forbidden link target`);
    }
    const mode = parseTarOctal(header.subarray(100, 108), `${name} mode`);
    if ((mode & 0o7000) !== 0 || (mode & 0o111) === 0) {
      throw new Error(`release archive entry ${name} has unsafe permissions`);
    }
    const size = parseTarOctal(header.subarray(124, 136), `${name} size`);
    if (size <= 0 || size > RELEASE_ARTIFACT_MAX_BYTES) {
      throw new Error(`release archive entry ${name} has an unsafe size`);
    }
    this.entries.add(name);
    return size;
  }
}

export function validateReleaseTarballEffect(
  artifactPath: string,
): Effect.Effect<void, DaemonUpdateTrustError> {
  return Effect.tryPromise({
    try: async (signal) => {
      const source = createReadStream(artifactPath);
      const gunzip = createGunzip();
      const abort = () => {
        source.destroy(signal.reason);
        gunzip.destroy(signal.reason);
      };
      signal.addEventListener('abort', abort, { once: true });
      const validator = new ReleaseTarValidator();
      try {
        for await (const chunk of source.pipe(gunzip)) {
          if (!(chunk instanceof Uint8Array)) {
            throw new Error('release archive decompressor returned non-binary data');
          }
          validator.push(chunk);
        }
        validator.finish();
      } finally {
        signal.removeEventListener('abort', abort);
        source.destroy();
        gunzip.destroy();
      }
    },
    catch: (cause) =>
      new DaemonUpdateTrustError({
        cause,
        message: cause instanceof Error ? cause.message : 'release archive validation failed',
      }),
  });
}

function concatenateBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  if (left.byteLength === 0) return right;
  const combined = new Uint8Array(left.byteLength + right.byteLength);
  combined.set(left);
  combined.set(right, left.byteLength);
  return combined;
}

function isZeroBytes(bytes: Uint8Array): boolean {
  for (const byte of bytes) if (byte !== 0) return false;
  return true;
}

function requireZeroBytes(bytes: Uint8Array, label: string): void {
  if (!isZeroBytes(bytes)) throw new Error(`${label} must be zero-filled`);
}

function readTarString(bytes: Uint8Array, label: string): string {
  const zero = bytes.indexOf(0);
  const end = zero === -1 ? bytes.byteLength : zero;
  if (zero !== -1) requireZeroBytes(bytes.subarray(zero), `${label} padding`);
  let result = '';
  for (let index = 0; index < end; index += 1) {
    const byte = bytes[index];
    if (byte === undefined || byte < 0x20 || byte > 0x7e) {
      throw new Error(`${label} must contain printable ASCII`);
    }
    result += String.fromCharCode(byte);
  }
  return result;
}

function parseTarOctal(bytes: Uint8Array, label: string): number {
  let text = '';
  for (const byte of bytes) {
    if (byte !== 0 && byte !== 0x20) text += String.fromCharCode(byte);
  }
  if (!/^[0-7]+$/.test(text)) throw new Error(`${label} is not canonical octal`);
  const value = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(value)) throw new Error(`${label} exceeds the safe-integer range`);
  return value;
}

function extractTarballEffect(
  artifactPath: string,
  versionDirectory: string,
): Effect.Effect<void, Error> {
  return validateReleaseTarballEffect(artifactPath).pipe(
    Effect.andThen(
      Effect.acquireUseRelease(
        Effect.sync(() =>
          Bun.spawn(
            [
              'tar',
              '-xzf',
              artifactPath,
              '-C',
              versionDirectory,
              '--no-same-owner',
              '--no-same-permissions',
              '--',
            ],
            { stdout: 'ignore', stderr: 'pipe' },
          ),
        ),
        (proc) =>
          Effect.tryPromise({
            try: async () => {
              const errorOutputPromise = new Response(proc.stderr).text();
              const exitCode = await proc.exited;
              const errorOutput = (await errorOutputPromise).trim();
              if (exitCode !== 0) throw new Error(`tar extraction failed: ${errorOutput}`);
            },
            catch: normalizeUnknownError,
          }),
        (proc) =>
          Effect.sync(() => {
            if (proc.exitCode === null) proc.kill();
          }),
      ),
    ),
  );
}

/** Where `current` points, or `null` on a first install that has no `current` yet. */
function readCurrentSymlinkTargetEffect(installRoot: string): Effect.Effect<string | null, Error> {
  return Effect.tryPromise({
    try: async () => {
      try {
        return await readlink(path.join(installRoot, 'current'));
      } catch (error) {
        if (isNoEntryError(error)) return null;
        throw error;
      }
    },
    catch: normalizeUnknownError,
  });
}

function removeCurrentSymlinkEffect(installRoot: string): Effect.Effect<void, Error> {
  return Effect.tryPromise({
    try: () => rm(path.join(installRoot, 'current'), { force: true }),
    catch: normalizeUnknownError,
  });
}

function swapCurrentSymlinkTargetEffect(
  installRoot: string,
  target: string,
): Effect.Effect<void, Error> {
  return Effect.tryPromise({
    try: async () => {
      const currentLink = path.join(installRoot, 'current');
      const stagingLink = path.join(installRoot, 'current.new');
      await rm(stagingLink, { force: true });
      await symlink(target, stagingLink);
      // rename over the old link is atomic; the running binary's inode
      // stays valid, so self-update is safe.
      await rename(stagingLink, currentLink);
    },
    catch: normalizeUnknownError,
  });
}

function verifyVersionedDaemonExecutablesEffect(
  executables: VersionedDaemonExecutables,
): Effect.Effect<void, Error> {
  return Effect.tryPromise({
    try: async () => {
      for (const executablePath of [
        executables.daemon,
        executables.dataplane,
        executables.imageWorker,
        executables.tui,
      ]) {
        const metadata = await stat(executablePath);
        if (!metadata.isFile()) {
          throw new Error(`release executable is not a file: ${executablePath}`);
        }
        await access(executablePath, constants.X_OK);
      }
    },
    catch: normalizeUnknownError,
  });
}

/** Everything but the service step, which depends on whether the daemon is linked. */
const LIVE_ACTIVATION_DEPENDENCIES: Omit<
  DaemonUpdateActivationDependencies,
  'activateDaemonService'
> = {
  verifyExecutables: verifyVersionedDaemonExecutablesEffect,
  readCurrentSymlinkTarget: readCurrentSymlinkTargetEffect,
  swapCurrentSymlinkTarget: swapCurrentSymlinkTargetEffect,
  removeCurrentSymlink: removeCurrentSymlinkEffect,
};

export function resolveVersionedDaemonExecutables(
  versionDirectory: string,
): VersionedDaemonExecutables {
  return {
    daemon: path.join(versionDirectory, DAEMON_EXECUTABLE_NAME),
    dataplane: path.join(versionDirectory, DATAPLANE_EXECUTABLE_NAME),
    imageWorker: path.join(versionDirectory, IMAGE_WORKER_EXECUTABLE_NAME),
    tui: path.join(versionDirectory, TUI_EXECUTABLE_NAME),
  };
}

export function activateVersionedDaemonEffect(
  installRoot: string,
  versionDirectory: string,
  dependencies: DaemonUpdateActivationDependencies,
): Effect.Effect<void, Error> {
  return Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const executables = resolveVersionedDaemonExecutables(versionDirectory);
      yield* dependencies.verifyExecutables(executables);

      const currentLink = path.join(installRoot, 'current');
      const previousTarget = yield* dependencies.readCurrentSymlinkTarget(installRoot);

      yield* dependencies.swapCurrentSymlinkTarget(installRoot, versionDirectory);
      const activationExit = yield* Effect.exit(
        restore(dependencies.activateDaemonService(executables.daemon)),
      );
      const activationFailure = activationFailureCause(
        activationExit,
        `new daemon ${executables.daemon}`,
      );
      if (activationFailure === null) {
        return;
      }

      if (previousTarget === null) {
        // A first install has nothing to roll back to: withdraw the link so the
        // failed version is not left looking installed.
        yield* dependencies.removeCurrentSymlink(installRoot).pipe(Effect.ignore);
        return yield* Effect.failCause(activationFailure);
      }
      const previousVersionDirectory = path.resolve(path.dirname(currentLink), previousTarget);
      return yield* rollbackDaemonActivationEffect(
        dependencies,
        installRoot,
        previousTarget,
        resolveVersionedDaemonExecutables(previousVersionDirectory).daemon,
        activationFailure,
      );
    }),
  );
}

function rollbackDaemonActivationEffect(
  dependencies: DaemonUpdateActivationDependencies,
  installRoot: string,
  previousTarget: string,
  previousExecutable: string,
  primaryFailure: Cause.Cause<Error>,
): Effect.Effect<never, Error> {
  return Effect.gen(function* () {
    const restoreSymlinkExit = yield* Effect.exit(
      dependencies.swapCurrentSymlinkTarget(installRoot, previousTarget),
    );
    const reactivatePreviousExit = yield* Effect.exit(
      dependencies.activateDaemonService(previousExecutable),
    );

    const rollbackFailures: string[] = [];
    if (Exit.isFailure(restoreSymlinkExit)) {
      rollbackFailures.push(`restore current symlink: ${Cause.pretty(restoreSymlinkExit.cause)}`);
    }
    const previousActivationFailure = activationFailureCause(
      reactivatePreviousExit,
      `previous daemon ${previousExecutable}`,
    );
    if (previousActivationFailure !== null) {
      rollbackFailures.push(
        `reactivate previous daemon: ${Cause.pretty(previousActivationFailure)}`,
      );
    }

    if (rollbackFailures.length === 0) {
      return yield* Effect.failCause(primaryFailure);
    }

    const primaryError = firstFailureError(primaryFailure);
    return yield* Effect.fail(
      new Error(
        `daemon update activation failed: ${Cause.pretty(primaryFailure)}; rollback failed: ${rollbackFailures.join('; ')}`,
        { cause: primaryError },
      ),
    );
  });
}

function activationFailureCause(
  exit: Exit.Exit<number, Error>,
  description: string,
): Cause.Cause<Error> | null {
  if (Exit.isFailure(exit)) {
    return exit.cause;
  }
  if (exit.value !== 0) {
    return Cause.fail(new Error(`${description} activation exited with code ${exit.value}`));
  }
  return null;
}

function firstFailureError(cause: Cause.Cause<Error>): Error {
  for (const reason of cause.reasons) {
    if (Cause.isFailReason(reason)) {
      return reason.error;
    }
  }
  return new Error(Cause.pretty(cause));
}

function pruneEffect(
  installRoot: string,
  downloadDirectory: string,
  latestVersion: string,
  previousVersion: string | null,
  logger: Logger,
): Effect.Effect<void, Error> {
  return Effect.tryPromise({
    try: async () => {
      await rm(downloadDirectory, { recursive: true, force: true });

      const versionsDirectory = path.join(installRoot, 'versions');
      if (!existsSync(versionsDirectory)) {
        return;
      }
      const entries = await readdir(versionsDirectory);
      // Keep the new version plus the previous one for manual rollback.
      const keep = new Set(
        previousVersion === null ? [latestVersion] : [latestVersion, previousVersion],
      );
      for (const entry of entries) {
        if (!keep.has(entry)) {
          await rm(path.join(versionsDirectory, entry), { recursive: true, force: true });
          logger.info('daemon_update_pruned_version', { version: entry });
        }
      }
    },
    catch: normalizeUnknownError,
  });
}
