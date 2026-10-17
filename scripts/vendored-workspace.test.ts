import { expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { VENDORED_WORKSPACE, vendoredDirectories } from './vendored-workspace';

const ROOT = path.resolve(import.meta.dir, '..');

test('the hub reads every vendored crate as a member and nothing else', () => {
  const members = readdirSync(path.join(ROOT, VENDORED_WORKSPACE, 'crates')).sort();
  const hub = readFileSync(path.join(ROOT, VENDORED_WORKSPACE, 'hub.MODULE.bazel'), 'utf8');
  const named = [...hub.matchAll(/crates\/([^/]+)\/Cargo\.toml/g)].map((match) => match[1]).sort();
  expect(named).toEqual(members);
  expect(members).toHaveLength(vendoredDirectories().length);
});
