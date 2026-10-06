import '../packages/shared/src/e2e-wasm-bun';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Effect } from 'effect';

import {
  type DaemonUpdateFetch,
  downloadEffect,
  downloadReleaseArtifactToFileEffect,
} from '../apps/daemon/src/cli/update';
import { emitPerfMetric, perfEnvInteger } from './perf/harness';

const mode = process.argv[2] === 'memory' ? 'memory' : 'stream';
const byteLength = perfEnvInteger('BENCH_UPDATE_BYTES', 48 * 1024 * 1024);
const chunkBytes = perfEnvInteger('BENCH_UPDATE_CHUNK_BYTES', 64 * 1024);
const digest = digestFixture(byteLength, chunkBytes);
const artifact = { name: 'merkur-update-benchmark.tar.gz', size: byteLength, sha512: digest };
const fetchImpl: DaemonUpdateFetch = () =>
  Promise.resolve(
    new Response(fixtureStream(byteLength, chunkBytes), {
      headers: { 'content-length': String(byteLength) },
    }),
  );

const directory = await mkdtemp(path.join(os.tmpdir(), 'merkur-update-benchmark-'));
const destination = path.join(directory, artifact.name);
const started = performance.now();
try {
  if (mode === 'memory') {
    const bytes = await Effect.runPromise(
      downloadEffect('https://merkur.invalid/benchmark', fetchImpl, byteLength),
    );
    if (bytes.byteLength !== byteLength || sha512(bytes) !== digest) {
      throw new Error('in-memory updater benchmark produced the wrong artifact');
    }
    bytes.fill(0);
  } else {
    await Effect.runPromise(
      downloadReleaseArtifactToFileEffect(
        'https://merkur.invalid/benchmark',
        destination,
        artifact,
        fetchImpl,
      ),
    );
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}

const elapsedMs = performance.now() - started;
const throughputMibPerSecond = byteLength / (1024 * 1024) / (elapsedMs / 1_000);
process.stdout.write(
  `daemon updater ${mode}: ${(byteLength / 1024 / 1024).toFixed(1)} MiB in ${elapsedMs.toFixed(2)} ms (${throughputMibPerSecond.toFixed(1)} MiB/s)\n`,
);
emitPerfMetric({
  name: `daemon-update-${mode}-throughput`,
  value: throughputMibPerSecond,
  unit: 'MiB/s',
  direction: 'higher',
  sampleSize: 1,
});

function fixtureStream(totalBytes: number, bytesPerChunk: number): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= totalBytes) {
        controller.close();
        return;
      }
      const length = Math.min(bytesPerChunk, totalBytes - offset);
      controller.enqueue(fixtureChunk(offset, length));
      offset += length;
    },
  });
}

function digestFixture(totalBytes: number, bytesPerChunk: number): string {
  const hasher = new Bun.CryptoHasher('sha512');
  for (let offset = 0; offset < totalBytes; offset += bytesPerChunk) {
    hasher.update(fixtureChunk(offset, Math.min(bytesPerChunk, totalBytes - offset)));
  }
  return hasher.digest('hex');
}

function fixtureChunk(offset: number, length: number): Uint8Array {
  const chunk = new Uint8Array(length);
  for (let index = 0; index < length; index += 1) {
    const absolute = offset + index;
    chunk[index] = (absolute * 131 + (absolute >>> 8) * 17 + 29) & 0xff;
  }
  return chunk;
}

function sha512(bytes: Uint8Array): string {
  const hasher = new Bun.CryptoHasher('sha512');
  hasher.update(bytes);
  return hasher.digest('hex');
}
