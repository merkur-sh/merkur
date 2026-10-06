import { describe, expect, test } from 'bun:test';
import { link, mkdtemp, readFile, symlink, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  assertDistinctReportFiles,
  atomicWriteText,
  prepareProfilerArtifacts,
  validateProfilerArtifacts,
} from './report-io';

describe('profile report I/O', () => {
  test('rejects symlink and hard-link aliases without modifying the baseline', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'merkur-profile-alias-'));
    const baseline = path.join(directory, 'baseline.json');
    const symlinkOutput = path.join(directory, 'symlink.json');
    const hardLinkOutput = path.join(directory, 'hard-link.json');
    await writeFile(baseline, 'baseline\n');
    await symlink(baseline, symlinkOutput);
    await link(baseline, hardLinkOutput);

    await expect(assertDistinctReportFiles(baseline, symlinkOutput)).rejects.toThrow(
      'different files',
    );
    await expect(assertDistinctReportFiles(baseline, hardLinkOutput)).rejects.toThrow(
      /different files|hard-link/,
    );
    expect(await readFile(baseline, 'utf8')).toBe('baseline\n');
  });

  test('atomically replaces a report and leaves no temporary file', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'merkur-profile-atomic-'));
    const output = path.join(directory, 'report.json');
    await writeFile(output, 'old\n');

    await atomicWriteText(output, 'new\n');

    expect(await readFile(output, 'utf8')).toBe('new\n');
    expect(
      Array.from(new Bun.Glob('.report.json.*.tmp').scanSync({ cwd: directory })),
    ).toHaveLength(0);
  });

  test('removes stale profiler artifacts and validates fresh non-empty JSON', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'merkur-profile-artifact-'));
    const artifact = path.join(directory, 'capture.cpuprofile');
    await writeFile(artifact, '{"stale":true}\n');

    const startedAt = await prepareProfilerArtifacts([artifact]);
    expect(await Bun.file(artifact).exists()).toBe(false);
    await writeFile(artifact, '{"fresh":true}\n');
    await validateProfilerArtifacts([artifact], startedAt);

    const oldTime = new Date(startedAt - 10_000);
    await utimes(artifact, oldTime, oldTime);
    await expect(validateProfilerArtifacts([artifact], startedAt)).rejects.toThrow('stale');

    await writeFile(artifact, 'not json');
    await expect(validateProfilerArtifacts([artifact], Date.now())).rejects.toThrow('valid JSON');
  });
});
