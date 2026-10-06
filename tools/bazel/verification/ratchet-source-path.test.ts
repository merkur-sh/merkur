import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCapturedRatchetPolicy } from './ratchet-policy';

/** Declaration/path controls only; genuine complete-source ratchet qualification is separate. */
test('ratchet refuses a missing or relative payload mapping instead of guessing a layout', async () => {
  const previous = process.env.MERKUR_CAPTURED_SOURCE_PAYLOAD;
  try {
    for (const value of [undefined, 'tools/bazel/verification/static_payload.json']) {
      if (value === undefined) delete process.env.MERKUR_CAPTURED_SOURCE_PAYLOAD;
      else process.env.MERKUR_CAPTURED_SOURCE_PAYLOAD = value;
      await expect(runCapturedRatchetPolicy()).rejects.toThrow(
        'Declared complete captured source payload required',
      );
    }
  } finally {
    if (previous === undefined) delete process.env.MERKUR_CAPTURED_SOURCE_PAYLOAD;
    else process.env.MERKUR_CAPTURED_SOURCE_PAYLOAD = previous;
  }
});

test('the declared payload mapping reaches the original Git/runfiles boundary unchanged', async () => {
  const parent = mkdtempSync(path.join(os.tmpdir(), 'ratchet-source-path-control-'));
  const payload = path.join(parent, 'external-context/source_payload.json');
  mkdirSync(path.dirname(payload), { recursive: true });
  writeFileSync(payload, '{}');
  const previous = {
    payload: process.env.MERKUR_CAPTURED_SOURCE_PAYLOAD,
    runfiles: process.env.TEST_SRCDIR,
  };
  try {
    process.env.MERKUR_CAPTURED_SOURCE_PAYLOAD = payload;
    delete process.env.TEST_SRCDIR;
    await expect(runCapturedRatchetPolicy()).rejects.toThrow(
      'Declared native Git and engine-owned policy workspace are required',
    );
    expect(process.env.MERKUR_CAPTURED_SOURCE_PAYLOAD).toBe(payload);
  } finally {
    if (previous.payload === undefined) delete process.env.MERKUR_CAPTURED_SOURCE_PAYLOAD;
    else process.env.MERKUR_CAPTURED_SOURCE_PAYLOAD = previous.payload;
    if (previous.runfiles === undefined) delete process.env.TEST_SRCDIR;
    else process.env.TEST_SRCDIR = previous.runfiles;
    rmSync(parent, { recursive: true, force: true });
  }
});
