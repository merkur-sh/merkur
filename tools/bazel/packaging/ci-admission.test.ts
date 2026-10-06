import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ciAdmissionMain, IncompleteTestRetention } from './ci-admission';
import { verificationFixture } from './evidence-fixture';

test('retention preserves original log/XML bytes and refuses an incomplete declared inventory', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ci-test-output-'));
  try {
    const directory = path.join(root, 'pkg', 'control');
    mkdirSync(directory, { recursive: true });
    const log = Buffer.from([0, 255, 65, 10]);
    writeFileSync(path.join(directory, 'test.log'), log);
    let partial: unknown;
    try {
      await ciAdmissionMain(['retain-tests', root, '//pkg:control']);
    } catch (error) {
      if (!(error instanceof IncompleteTestRetention)) throw error;
      partial = JSON.parse(error.document);
    }
    expect(partial).toMatchObject({
      complete: false,
      missing: [{ label: '//pkg:control', name: 'test.xml' }],
      files: [{ label: '//pkg:control', name: 'test.log', base64: log.toString('base64') }],
    });
    writeFileSync(path.join(directory, 'test.xml'), '<testsuite tests="1"/>');
    const result = JSON.parse(await ciAdmissionMain(['retain-tests', root, '//pkg:control']));
    expect(result.files).toHaveLength(2);
    expect(Buffer.from(result.files[0].base64, 'base64')).toEqual(log);
    expect(result.files[0].size).toBe(log.length);
    await expect(
      ciAdmissionMain(['retain-tests', root, '//pkg:control', '//pkg:control']),
    ).rejects.toThrow();
    await expect(
      ciAdmissionMain(['retain-tests', root, '//pkg/../elsewhere:control']),
    ).rejects.toThrow();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('diagnostic reconstruction checks Files against a separate context without admission', async () => {
  await verificationFixture(async (evidence, context, root) => {
    const report = path.join(root, 'report.json');
    const expected = path.join(root, 'expected.json');
    const { commit, ...rest } = context;
    writeFileSync(report, JSON.stringify({ evidence, currentAccepted: false }));
    writeFileSync(expected, JSON.stringify([{ ...rest, head: commit }]));
    expect(
      JSON.parse(await ciAdmissionMain(['reconstruct', report, expected])).currentAccepted,
    ).toBe(true);
    // The CLI report envelope is a whole controller result, not a single raw report.
    writeFileSync(
      report,
      JSON.stringify({ admitted: true, results: [{ evidence }], problems: [] }),
    );
    await expect(ciAdmissionMain(['reconstruct', report, expected])).rejects.toThrow(
      'CI admission requires raw execution evidence and an independent complete context',
    );
    // The removed admission command cannot turn diagnostic JSON into controller authority.
    await expect(ciAdmissionMain(['admit', report, expected])).rejects.toThrow('Usage:');
    writeFileSync(report, JSON.stringify({ evidence, currentAccepted: false }));
    for (const batch of [
      { ...rest, head: commit },
      [],
      [
        { ...rest, head: commit },
        { ...rest, head: commit },
      ],
    ]) {
      writeFileSync(expected, JSON.stringify(batch));
      await expect(ciAdmissionMain(['reconstruct', report, expected])).rejects.toThrow();
    }
    writeFileSync(expected, JSON.stringify([{ ...rest, head: 'e'.repeat(40) }]));
    await expect(ciAdmissionMain(['reconstruct', report, expected])).rejects.toThrow();
  });
});

test('CI retention strips unrelated command environment without modifying the input', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ci-retention-'));
  try {
    const input = path.join(root, 'events.jsonl');
    const bytes = JSON.stringify({
      id: { started: {} },
      started: { uuid: 'invocation', buildToolVersion: '9.2.0', command: 'test' },
      structuredCommandLine: { sections: [{ environment: 'unrelated-private-value' }] },
    });
    writeFileSync(input, bytes);
    const safe = await ciAdmissionMain(['sanitize-bep', input]);
    expect(safe).not.toContain('unrelated-private-value');
    expect(JSON.parse(safe).started.buildToolVersion).toBe('9.2.0');
    expect(readFileSync(input, 'utf8')).toBe(bytes);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('diagnostic reconstruction refuses relative, missing and malformed inputs', async () => {
  await expect(ciAdmissionMain(['reconstruct', 'report.json', '/expected.json'])).rejects.toThrow();
  await expect(ciAdmissionMain(['reconstruct', '/report.json'])).rejects.toThrow();
  await expect(ciAdmissionMain(['sanitize-bep', '/missing-ci-evidence-input'])).rejects.toThrow();
  const root = mkdtempSync(path.join(os.tmpdir(), 'ci-admission-'));
  try {
    const report = path.join(root, 'report.json');
    const expected = path.join(root, 'expected.json');
    writeFileSync(report, JSON.stringify({ currentAccepted: true }));
    writeFileSync(expected, JSON.stringify({ required: [] }));
    await expect(ciAdmissionMain(['reconstruct', report, expected])).rejects.toThrow();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
