import { spyOn } from 'bun:test';
import * as filesystem from 'node:fs/promises';
import path from 'node:path';
import { Effect, Predicate } from 'effect';

import { persistReleaseTrustFloorEffect } from './daemon-release';

const [directory, barrier] = process.argv.slice(2);
if (directory === undefined || barrier === undefined) throw new Error('Missing lock fixture args');
const temporary = path.join(directory, '.release-trust.json.new');
const target = path.join(directory, 'release-trust.json');
async function pause() {
  process.stdout.write('ready\n');
  await Bun.stdin.stream().getReader().read();
}
const open = filesystem.open;
spyOn(filesystem, 'open').mockImplementation(async (filename, flags, mode) => {
  const handle = await open(filename, flags, mode);
  if (filename === temporary) {
    if (barrier === 'created') await pause();
    const sync = handle.sync.bind(handle);
    spyOn(handle, 'sync').mockImplementation(async () => {
      await sync();
      if (barrier === 'flushed') await pause();
    });
  }
  return handle;
});
const rename = filesystem.rename;
spyOn(filesystem, 'rename').mockImplementation(async (from, to) => {
  await rename(from, to);
  if (to === target && barrier === 'renamed') await pause();
});
const file = Bun.file.bind(Bun);
spyOn(Bun, 'file').mockImplementation((filename, options) => {
  if (!Predicate.isString(filename)) throw new Error('Release fixture expects a file path');
  const result = file(filename, options);
  if (filename === target && barrier === 'locked') {
    const bytes = result.bytes.bind(result);
    spyOn(result, 'bytes').mockImplementation(async () => {
      await pause();
      return bytes();
    });
  }
  return result;
});
await Effect.runPromise(
  persistReleaseTrustFloorEffect(directory, { manifestSha512: 'cd'.repeat(64), sequence: 43 }),
);
