import { describe, expect, test } from 'bun:test';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  daemonArtifactName,
  encodeReleaseManifest,
  RELEASE_PLATFORMS,
  type ReleaseManifest,
} from '@merkur/shared';
import {
  deriveReleaseSigningKey,
  encodeReleasePublicKey,
  encodeReleaseSignature,
  signReleaseManifest,
} from '@merkur/shared/release-signature';
import { Effect } from 'effect';

import { buildDaemonServiceProgramArguments } from '../cli/install';
import { createLogger } from '../logger';
import {
  activateReleaseEffect,
  type DaemonUpdateFetch,
  DaemonUpdateHttpError,
  downloadEffect,
  downloadReleaseArtifactToFileEffect,
  fetchServerReleaseEffect,
  persistReleaseTrustFloorEffect,
  readReleaseTrustFloorEffect,
  releaseVersionDirectory,
  resolveVersionedDaemonExecutables,
  stageVerifiedReleaseEffect,
  validateReleaseTarballEffect,
  verifyReleaseCandidateEffect,
} from './daemon-release';

const logger = createLogger('daemon-release-test');

describe('the service unit', () => {
  test('runs current, which every update moves, beside its dataplane', () => {
    const current = '/home/user/.merkur/current/merkur';
    expect(buildDaemonServiceProgramArguments(current)).toEqual([current, 'daemon']);
    const executables = resolveVersionedDaemonExecutables('/home/user/.merkur/versions/v0.2.0');
    expect(path.dirname(executables.daemon)).toBe(path.dirname(executables.dataplane));
    expect(path.basename(executables.imageWorker)).toBe('merkur-image-worker');
  });
});

describe('release convergence', () => {
  test("reads the server's release, retrying a transient failure", async () => {
    const requested: string[] = [];
    const fetchImpl: DaemonUpdateFetch = (input) => {
      requested.push(String(input));
      return Promise.resolve(
        requested.length === 1
          ? new Response('temporary', { status: 503 })
          : Response.json({ release: 'v9.8.7' }),
      );
    };
    expect(
      await Effect.runPromise(fetchServerReleaseEffect('https://merkur.test', fetchImpl)),
    ).toBe('v9.8.7');
    expect(requested).toEqual([
      'https://merkur.test/api/release',
      'https://merkur.test/api/release',
    ]);
  });

  test('refuses a release answer of any other shape', async () => {
    for (const body of [
      'v0.2.0',
      '{"version":"v0.2.0"}',
      '{"release":""}',
      '{"release":"latest"}',
      '{"release":"v1.2"}',
      '{"release":"a\\nb"}',
    ]) {
      const fetchImpl: DaemonUpdateFetch = () => Promise.resolve(new Response(body));
      const error = await Effect.runPromise(
        fetchServerReleaseEffect('https://merkur.test', fetchImpl).pipe(Effect.flip),
      );
      expect(error._tag).toBe('DaemonUpdatePayloadError');
    }
  });

  test('stages a release whole, once, and activation keeps only it and the running one', async () => {
    const installRoot = await mkdtemp(path.join(os.tmpdir(), 'merkur-stage-'));
    const archive = Uint8Array.from(
      Bun.gzipSync(
        makeTarArchive(
          ['merkur', 'merkur-dataplane', 'merkur-image-worker', 'merkur-tui'].map((name) => ({
            name,
            type: 0x30,
          })),
        ),
      ),
    );
    const archivePath = path.join(installRoot, 'archive.tar.gz');
    try {
      await Bun.write(archivePath, archive);
      const hasher = new Bun.CryptoHasher('sha512');
      hasher.update(archive);
      const candidate = (version: string, sequence: number) => ({
        artifact: {
          name: daemonArtifactName('linux-x64'),
          size: archive.byteLength,
          sha512: hasher.copy().digest('hex'),
        },
        manifest: {
          sequence,
          version,
          expiresAt: 1,
          minimumSequence: 1,
          artifacts: [],
        },
        manifestSha512: 'ab'.repeat(64),
      });
      const artifactUrl = Bun.pathToFileURL(archivePath).href;
      for (const [version, sequence] of [
        ['v1.0.0', 1],
        ['v1.1.0', 2],
        ['v1.2.0', 3],
      ] as const) {
        await Effect.runPromise(
          stageVerifiedReleaseEffect({
            installRoot,
            candidate: candidate(version, sequence),
            artifactUrl,
          }),
        );
      }
      // A second stager of a staged release finds it complete and changes nothing.
      await Effect.runPromise(
        stageVerifiedReleaseEffect({ installRoot, candidate: candidate('v1.2.0', 3), artifactUrl }),
      );
      // Another stager's directory, still being filled.
      await Bun.write(path.join(installRoot, 'versions', '.staging-other', 'merkur'), 'partial');

      await Effect.runPromise(
        activateReleaseEffect({
          logger,
          installRoot,
          versionDirectory: releaseVersionDirectory(installRoot, 'v1.2.0'),
          running: 'v1.1.0',
        }),
      );

      expect((await readdir(path.join(installRoot, 'versions'))).sort()).toEqual([
        '.staging-other',
        'v1.1.0',
        'v1.2.0',
      ]);
      expect(await Bun.file(path.join(installRoot, 'current', 'merkur-tui')).exists()).toBe(true);
      expect(await Effect.runPromise(readReleaseTrustFloorEffect(installRoot, 1))).toEqual({
        manifestSha512: 'ab'.repeat(64),
        sequence: 3,
      });
      expect(await readdir(path.join(installRoot, 'tmp'))).toEqual([]);
    } finally {
      archive.fill(0);
      await rm(installRoot, { recursive: true, force: true });
    }
  });
});

describe('daemon updater HTTP reliability', () => {
  test('does not retry a permanent download response', async () => {
    let calls = 0;
    const fetchImpl: DaemonUpdateFetch = () => {
      calls += 1;
      return Promise.resolve(new Response('missing', { status: 404 }));
    };

    const error = await Effect.runPromise(
      downloadEffect('https://merkur.test/releases/missing', fetchImpl).pipe(Effect.flip),
    );
    expect(error).toBeInstanceOf(DaemonUpdateHttpError);
    expect(calls).toBe(1);
  });

  test('cancels a chunked response as soon as it exceeds its byte owner', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(4));
        controller.enqueue(new Uint8Array(4));
      },
      cancel() {
        cancelled = true;
      },
    });
    const fetchImpl: DaemonUpdateFetch = () => Promise.resolve(new Response(body));

    const error = await Effect.runPromise(
      downloadEffect('https://merkur.test/releases/oversized', fetchImpl, 7).pipe(Effect.flip),
    );

    expect(error._tag).toBe('DaemonUpdatePayloadError');
    expect(cancelled).toBe(true);
  });

  test('passes Effect cancellation into fetch as an AbortSignal', async () => {
    const observed: { signal?: AbortSignal | null } = {};
    const fetchImpl: DaemonUpdateFetch = (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal ?? null;
        observed.signal = signal;
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    const controller = new AbortController();

    const request = Effect.runPromise(
      downloadEffect('https://merkur.test/releases/hung', fetchImpl),
      { signal: controller.signal },
    ).catch(() => undefined);
    await waitFor(() => observed.signal != null);
    controller.abort(new Error('test cancellation'));
    await request;

    expect(observed.signal?.aborted).toBe(true);
  });

  test('streams an artifact to an atomically published verified file', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'merkur-update-stream-'));
    const destination = path.join(directory, 'release.tar.gz');
    const chunks = [new Uint8Array(19), new Uint8Array(31), new Uint8Array(7)];
    chunks.forEach((chunk, chunkIndex) => {
      chunk.forEach((_value, byteIndex) => {
        chunk[byteIndex] = (chunkIndex * 71 + byteIndex * 13) & 0xff;
      });
    });
    const bytes = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    const artifact = {
      name: 'release.tar.gz',
      size: bytes.length,
      sha512: sha512ForTest(bytes),
    };
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    });

    try {
      await Effect.runPromise(
        downloadReleaseArtifactToFileEffect(
          'https://merkur.test/releases/release.tar.gz',
          destination,
          artifact,
          () =>
            Promise.resolve(
              new Response(body, { headers: { 'content-length': String(bytes.length) } }),
            ),
        ),
      );

      expect(new Uint8Array(await readFile(destination))).toEqual(bytes);
      expect((await stat(destination)).mode & 0o777).toBe(0o600);
      expect(await readdir(directory)).toEqual(['release.tar.gz']);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('never publishes and removes its temporary file on digest failure', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'merkur-update-stream-'));
    const destination = path.join(directory, 'release.tar.gz');
    const bytes = new TextEncoder().encode('signed size, wrong content');
    const artifact = {
      name: 'release.tar.gz',
      size: bytes.length,
      sha512: '0'.repeat(128),
    };

    try {
      const error = await Effect.runPromise(
        downloadReleaseArtifactToFileEffect(
          'https://merkur.test/releases/release.tar.gz',
          destination,
          artifact,
          () => Promise.resolve(new Response(bytes)),
        ).pipe(Effect.flip),
      );

      expect(error._tag).toBe('DaemonUpdateTrustError');
      expect(await readdir(directory)).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('rejects a declared size mismatch before reading the body', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'merkur-update-stream-'));
    const destination = path.join(directory, 'release.tar.gz');
    const bytes = new Uint8Array([1, 2, 3]);
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull() {},
      cancel() {
        cancelled = true;
      },
    });
    const artifact = {
      name: 'release.tar.gz',
      size: bytes.length,
      sha512: sha512ForTest(bytes),
    };

    try {
      const error = await Effect.runPromise(
        downloadReleaseArtifactToFileEffect(
          'https://merkur.test/releases/release.tar.gz',
          destination,
          artifact,
          () => Promise.resolve(new Response(body, { headers: { 'content-length': '4' } })),
        ).pipe(Effect.flip),
      );

      expect(error._tag).toBe('DaemonUpdatePayloadError');
      expect(cancelled).toBe(true);
      expect(await readdir(directory)).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('does not retry a local persistence failure as a network failure', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'merkur-update-stream-'));
    const bytes = new Uint8Array([1]);
    let fetchCalls = 0;
    try {
      const error = await Effect.runPromise(
        downloadReleaseArtifactToFileEffect(
          'https://merkur.test/releases/release.tar.gz',
          path.join(directory, 'missing', 'release.tar.gz'),
          { name: 'release.tar.gz', size: 1, sha512: sha512ForTest(bytes) },
          () => {
            fetchCalls += 1;
            return Promise.resolve(new Response(bytes));
          },
        ).pipe(Effect.flip),
      );

      expect(error._tag).toBe('DaemonUpdatePersistenceError');
      expect(fetchCalls).toBe(0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('aborts and removes its temporary file when streaming is interrupted', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'merkur-update-stream-'));
    const destination = path.join(directory, 'release.tar.gz');
    const observed: { signal?: AbortSignal | null } = {};
    const fetchImpl: DaemonUpdateFetch = (_input, init) => {
      observed.signal = init?.signal ?? null;
      return Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array([1]));
            },
          }),
        ),
      );
    };
    const controller = new AbortController();
    const artifact = {
      name: 'release.tar.gz',
      size: 2,
      sha512: '0'.repeat(128),
    };

    try {
      const request = Effect.runPromise(
        downloadReleaseArtifactToFileEffect(
          'https://merkur.test/releases/release.tar.gz',
          destination,
          artifact,
          fetchImpl,
        ),
        { signal: controller.signal },
      ).catch(() => undefined);
      await waitFor(() => observed.signal != null);
      controller.abort(new Error('test cancellation'));
      await request;
      await waitFor(async () => (await readdir(directory)).length === 0);

      expect(observed.signal?.aborted).toBe(true);
      expect(await readdir(directory)).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe('post-quantum release trust', () => {
  test('verifies a canonical ML-DSA-87 manifest and enforces its consumer floor', async () => {
    const fixture = signedReleaseFixture(42, 40);
    try {
      const verified = await Effect.runPromise(
        verifyReleaseCandidateEffect({
          consumerSequence: 41,
          consumerVersion: 'v9.8.6',
          expectedVersion: fixture.manifest.version,
          manifestBytes: fixture.manifestBytes,
          now: 1_800_000_000_000,
          platform: 'darwin-arm64',
          publicKeyBase64url: fixture.publicKey,
          signatureBytes: fixture.signatureBytes,
          trustFloor: { manifestSha512: null, sequence: 41 },
        }),
      );

      expect(verified.manifest.sequence).toBe(42);
      expect(verified.artifact.name).toBe(daemonArtifactName('darwin-arm64'));

      const error = await Effect.runPromise(
        verifyReleaseCandidateEffect({
          consumerSequence: 39,
          consumerVersion: 'v9.8.6',
          expectedVersion: fixture.manifest.version,
          manifestBytes: fixture.manifestBytes,
          now: 1_800_000_000_000,
          platform: 'darwin-arm64',
          publicKeyBase64url: fixture.publicKey,
          signatureBytes: fixture.signatureBytes,
          trustFloor: { manifestSha512: null, sequence: 39 },
        }).pipe(Effect.flip),
      );
      expect(error.message).toContain('requires installed sequence 40');
    } finally {
      fixture.dispose();
    }
  });

  test('rejects rollback and same-sequence manifest equivocation', async () => {
    const fixture = signedReleaseFixture(42, 1);
    try {
      const rollback = await Effect.runPromise(
        verifyReleaseCandidateEffect({
          consumerSequence: 42,
          consumerVersion: fixture.manifest.version,
          expectedVersion: fixture.manifest.version,
          manifestBytes: fixture.manifestBytes,
          now: 1_800_000_000_000,
          platform: 'linux-x64',
          publicKeyBase64url: fixture.publicKey,
          signatureBytes: fixture.signatureBytes,
          trustFloor: { manifestSha512: null, sequence: 43 },
        }).pipe(Effect.flip),
      );
      expect(rollback.message).toContain('below rollback floor');

      const reusedVersion = await Effect.runPromise(
        verifyReleaseCandidateEffect({
          consumerSequence: 42,
          consumerVersion: 'v9.8.6',
          expectedVersion: fixture.manifest.version,
          manifestBytes: fixture.manifestBytes,
          now: 1_800_000_000_000,
          platform: 'linux-x64',
          publicKeyBase64url: fixture.publicKey,
          signatureBytes: fixture.signatureBytes,
          trustFloor: { manifestSha512: null, sequence: 42 },
        }).pipe(Effect.flip),
      );
      expect(reusedVersion.message).toContain('reused for a different version');

      const equivocation = await Effect.runPromise(
        verifyReleaseCandidateEffect({
          consumerSequence: 42,
          consumerVersion: fixture.manifest.version,
          expectedVersion: fixture.manifest.version,
          manifestBytes: fixture.manifestBytes,
          now: 1_800_000_000_000,
          platform: 'linux-x64',
          publicKeyBase64url: fixture.publicKey,
          signatureBytes: fixture.signatureBytes,
          trustFloor: { manifestSha512: '00'.repeat(64), sequence: 42 },
        }).pipe(Effect.flip),
      );
      expect(equivocation.message).toContain('reused');
    } finally {
      fixture.dispose();
    }
  });

  test('a newer installer keeps the saved hash bound to its original sequence', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'merkur-installer-floor-'));
    const floor = { manifestSha512: 'ab'.repeat(64), sequence: 41 } as const;
    const fixture = signedReleaseFixture(42, 1);
    try {
      await Effect.runPromise(persistReleaseTrustFloorEffect(directory, floor));
      const raised = await Effect.runPromise(readReleaseTrustFloorEffect(directory, 42));
      expect(raised).toEqual({ manifestSha512: null, sequence: 42 });
      const verified = await Effect.runPromise(
        verifyReleaseCandidateEffect({
          consumerSequence: 42,
          consumerVersion: fixture.manifest.version,
          expectedVersion: fixture.manifest.version,
          manifestBytes: fixture.manifestBytes,
          signatureBytes: fixture.signatureBytes,
          publicKeyBase64url: fixture.publicKey,
          now: 1_800_000_000_000,
          platform: 'darwin-arm64',
          trustFloor: raised,
        }),
      );
      expect(verified.manifest.sequence).toBe(42);
      // Reading does not rewrite accepted trust or drop a same/newer hash.
      expect(await Effect.runPromise(readReleaseTrustFloorEffect(directory, 41))).toEqual(floor);
      expect(await Effect.runPromise(readReleaseTrustFloorEffect(directory, 40))).toEqual(floor);
      expect(await readFile(path.join(directory, 'release-trust.json'), 'utf8')).toBe(
        `${JSON.stringify(floor)}\n`,
      );
    } finally {
      fixture.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('persists the highest accepted floor atomically and refuses to lower it', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'merkur-release-trust-'));
    const floor = { manifestSha512: 'ab'.repeat(64), sequence: 42 } as const;
    try {
      await Effect.runPromise(persistReleaseTrustFloorEffect(directory, floor));
      expect(await Effect.runPromise(readReleaseTrustFloorEffect(directory, 1))).toEqual(floor);
      expect(await readFile(path.join(directory, 'release-trust.json'), 'utf8')).toBe(
        `${JSON.stringify(floor)}\n`,
      );

      const error = await Effect.runPromise(
        persistReleaseTrustFloorEffect(directory, {
          manifestSha512: 'cd'.repeat(64),
          sequence: 41,
        }).pipe(Effect.flip),
      );
      expect(error.message).toContain('refusing to lower');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe('release archive confinement', () => {
  test('rejects every absent, duplicated or linked release executable before activation', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'merkur-release-executables-'));
    const binaries = ['merkur', 'merkur-dataplane', 'merkur-image-worker', 'merkur-tui'].map(
      (name) => ({ name, type: 0x30 }),
    );
    try {
      for (const binary of binaries) {
        const others = binaries.filter((entry) => entry !== binary);
        const cases = [
          { entries: others, error: 'must contain exactly' },
          { entries: [...binaries, binary], error: 'entry is duplicated' },
          { entries: [...others, { ...binary, type: 0x32 }], error: 'not a regular file' },
          { entries: [...others, { ...binary, type: 0x31 }], error: 'not a regular file' },
        ];
        for (const [index, fixture] of cases.entries()) {
          const archive = path.join(directory, `${binary.name}-${index}.tar.gz`);
          await Bun.write(archive, Bun.gzipSync(makeTarArchive(fixture.entries)));
          const failure = await Effect.runPromise(
            validateReleaseTarballEffect(archive).pipe(Effect.flip),
          );
          expect(failure.message).toContain(fixture.error);
        }
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('accepts only the four root executables and rejects traversal before extraction', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'merkur-release-tar-'));
    const validPath = path.join(directory, 'valid.tar.gz');
    const traversalPath = path.join(directory, 'traversal.tar.gz');
    const valid: Uint8Array<ArrayBuffer> = Uint8Array.from(
      Bun.gzipSync(
        makeTarArchive([
          { name: 'merkur', type: 0x30 },
          { name: 'merkur-dataplane', type: 0x30 },
          { name: 'merkur-image-worker', type: 0x30 },
          { name: 'merkur-tui', type: 0x30 },
        ]),
      ),
    );
    const traversal: Uint8Array<ArrayBuffer> = Uint8Array.from(
      Bun.gzipSync(makeTarArchive([{ name: '../escape', type: 0x30 }])),
    );
    try {
      await Bun.write(validPath, valid);
      await Bun.write(traversalPath, traversal);
      await Effect.runPromise(validateReleaseTarballEffect(validPath));

      const error = await Effect.runPromise(
        validateReleaseTarballEffect(traversalPath).pipe(Effect.flip),
      );
      expect(error.message).toContain('entry is forbidden: ../escape');
      expect(await Bun.file(path.join(directory, 'escape')).exists()).toBe(false);
    } finally {
      valid.fill(0);
      traversal.fill(0);
      await rm(directory, { recursive: true, force: true });
    }
  });
});

function makeTarArchive(
  entries: readonly { readonly name: string; readonly type: number }[],
): Uint8Array<ArrayBuffer> {
  const blocks: Uint8Array<ArrayBuffer>[] = [];
  for (const entry of entries) {
    const header = new Uint8Array(512);
    writeTarText(header, 0, 100, entry.name);
    writeTarOctal(header, 100, 8, 0o755);
    writeTarOctal(header, 108, 8, 0);
    writeTarOctal(header, 116, 8, 0);
    writeTarOctal(header, 124, 12, 1);
    writeTarOctal(header, 136, 12, 1);
    header.fill(0x20, 148, 156);
    header[156] = entry.type;
    writeTarText(header, 257, 6, 'ustar');
    writeTarText(header, 263, 2, '00', false);
    let checksum = 0;
    for (const byte of header) checksum += byte;
    const checksumText = checksum.toString(8).padStart(6, '0');
    writeTarText(header, 148, 7, checksumText);
    header[155] = 0x20;
    blocks.push(header, new Uint8Array(512));
  }
  blocks.push(new Uint8Array(1024));
  const archive = new Uint8Array(blocks.reduce((total, block) => total + block.byteLength, 0));
  let offset = 0;
  for (const block of blocks) {
    archive.set(block, offset);
    offset += block.byteLength;
  }
  return archive;
}

function writeTarText(
  target: Uint8Array,
  offset: number,
  length: number,
  value: string,
  terminate = true,
): void {
  const bytes = new TextEncoder().encode(value);
  if (bytes.byteLength + (terminate ? 1 : 0) > length) {
    throw new Error('tar fixture field overflow');
  }
  target.set(bytes, offset);
}

function writeTarOctal(target: Uint8Array, offset: number, length: number, value: number): void {
  const encoded = value.toString(8).padStart(length - 1, '0');
  writeTarText(target, offset, length, encoded);
}

function signedReleaseFixture(
  sequence: number,
  minimumSequence: number,
): {
  readonly dispose: () => void;
  readonly manifest: ReleaseManifest;
  readonly manifestBytes: Uint8Array;
  readonly publicKey: string;
  readonly signatureBytes: Uint8Array;
} {
  const seed = new Uint8Array(32).fill(3);
  const entropy = new Uint8Array(32).fill(5);
  const pair = deriveReleaseSigningKey(seed);
  const manifest: ReleaseManifest = {
    sequence,
    version: 'v9.8.7',
    expiresAt: 1_801_000_000_000,
    minimumSequence,
    artifacts: RELEASE_PLATFORMS.map((platform, index) => ({
      name: daemonArtifactName(platform),
      size: 100 + index,
      sha512: 'ab'.repeat(64),
    })),
  };
  const manifestBytes = encodeReleaseManifest(manifest);
  const signature = signReleaseManifest(manifestBytes, pair, entropy);
  const signatureBytes = new TextEncoder().encode(encodeReleaseSignature(signature));
  const publicKey = encodeReleasePublicKey(pair.publicKey);
  return {
    dispose: () => {
      seed.fill(0);
      entropy.fill(0);
      pair.free();
      signature.fill(0);
      signatureBytes.fill(0);
      manifestBytes.fill(0);
    },
    manifest,
    manifestBytes,
    publicKey,
    signatureBytes,
  };
}

function sha512ForTest(bytes: Uint8Array): string {
  const hasher = new Bun.CryptoHasher('sha512');
  hasher.update(bytes);
  return hasher.digest('hex');
}

async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    if (await predicate()) return;
    await Bun.sleep(1);
  }
  throw new Error('condition was not reached');
}
