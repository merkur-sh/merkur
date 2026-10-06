import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { attachDirectArtifact, type DirectArtifactTestInfo } from './direct-artifacts';

describe('Direct performance artifacts', () => {
  test('writes exact bytes into the preserved output directory before attaching by path', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'merkur-direct-artifact-'));
    const attachments: Array<{
      name: string;
      path: string;
      contentType: string;
    }> = [];
    const testInfo: DirectArtifactTestInfo = {
      outputPath: (...segments) => join(directory, ...segments),
      attach: async (name, options) => {
        attachments.push({ name, ...options });
      },
    };
    const bytes = Uint8Array.of(0, 1, 2, 254, 255);

    try {
      const artifactPath = await attachDirectArtifact(testInfo, 'raw/events.bin', {
        body: bytes,
        contentType: 'application/octet-stream',
      });
      expect(artifactPath).toBe(join(directory, 'raw/events.bin'));
      expect(new Uint8Array(await readFile(artifactPath))).toEqual(bytes);
      expect(attachments).toEqual([
        {
          name: 'raw/events.bin',
          path: artifactPath,
          contentType: 'application/octet-stream',
        },
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('keeps the exact output file when reporter attachment fails', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'merkur-direct-artifact-failure-'));
    const artifactPath = join(directory, 'evidence.json');
    const testInfo: DirectArtifactTestInfo = {
      outputPath: () => artifactPath,
      attach: async () => {
        throw new Error('reporter unavailable');
      },
    };

    try {
      await expect(
        attachDirectArtifact(testInfo, 'evidence.json', {
          body: '{"complete":false}\n',
          contentType: 'application/json',
        }),
      ).rejects.toThrow('reporter unavailable');
      expect(await readFile(artifactPath, 'utf8')).toBe('{"complete":false}\n');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
