import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import type { ConnectionStatus } from '../../apps/web/src/app/navigation';
import { expect, test } from './fixtures/daemon-process';

test.skip(process.platform !== 'darwin', 'The real iOS Safari harness requires macOS');

test('real iOS WebKit cold and repeat startup trace', async ({
  baseURL,
  linkedDaemon,
}, testInfo) => {
  if (typeof baseURL !== 'string') throw new Error('iOS WebKit harness requires baseURL');
  const result = spawnSync(
    'bun',
    [
      'run',
      'scripts/run-ios-webkit-harness.ts',
      '--url',
      baseURL,
      '--username',
      linkedDaemon.username,
      '--password',
      linkedDaemon.password,
      '--daemon-name',
      linkedDaemon.daemonName,
    ],
    { cwd: process.cwd(), encoding: 'utf8' },
  );
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  expect(result.status, stderr || stdout).toBe(0);
  const summary = JSON.parse(stdout.trim().split('\n').at(-1) ?? '{}') as {
    artifactRoot?: string;
    device?: string;
    reason?: string;
    sampleCount?: number;
  };
  test.skip(
    summary.reason === 'no-webgpu-adapter',
    `${summary.device ?? 'The simulated device'}'s Safari exposes no WebGPU adapter, and the terminal renders only through WebGPU`,
  );
  expect(summary.reason).toBe('complete');
  expect(summary.sampleCount ?? 0).toBeGreaterThan(20);
  if (summary.artifactRoot === undefined) throw new Error('iOS artifact root missing');
  const artifact = JSON.parse(
    readFileSync(path.join(summary.artifactRoot, 'trace.json'), 'utf8'),
  ) as {
    trace?: {
      samples?: Array<{
        phase?: string;
        connection?: string;
        dpr?: number;
        canvas?: {
          width?: number;
          height?: number;
          backingWidth?: number;
          backingHeight?: number;
          cssWidth?: string;
        } | null;
      }>;
    };
  };
  const firstConnectionSurfaces =
    artifact.trace?.samples?.filter(
      (sample) =>
        sample.phase === 'first' &&
        sample.connection === ('connected' satisfies ConnectionStatus) &&
        typeof sample.canvas?.cssWidth === 'string' &&
        sample.canvas.cssWidth.length > 0,
    ) ?? [];
  expect(firstConnectionSurfaces.length).toBeGreaterThanOrEqual(8);
  for (const sample of firstConnectionSurfaces) {
    const canvas = sample.canvas;
    const dpr = sample.dpr;
    if (
      canvas === null ||
      canvas === undefined ||
      dpr === undefined ||
      canvas.width === undefined ||
      canvas.height === undefined ||
      canvas.backingWidth === undefined ||
      canvas.backingHeight === undefined
    ) {
      throw new Error('Incomplete iOS canvas sample');
    }
    expect(Math.abs(canvas.backingWidth - canvas.width * dpr)).toBeLessThanOrEqual(3);
    expect(Math.abs(canvas.backingHeight - canvas.height * dpr)).toBeLessThanOrEqual(3);
  }

  await testInfo.attach('ios-webkit-trace.json', {
    path: path.join(summary.artifactRoot, 'trace.json'),
    contentType: 'application/json',
  });
});
