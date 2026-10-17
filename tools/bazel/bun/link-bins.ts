/**
 * The `node_modules/.bin` commands pnpm writes, for a test's checkout: rules_js links packages
 * but writes no `.bin`, and `bun run` finds a script's commands there.
 *
 *   bun link-bins.ts <node_modules directory>...
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { Schema } from 'effect';

function packages(modules: string): string[] {
  return readdirSync(modules)
    .filter((entry) => !entry.startsWith('.'))
    .flatMap((entry) =>
      entry.startsWith('@')
        ? readdirSync(path.join(modules, entry)).map((scoped) => `${entry}/${scoped}`)
        : [entry],
    );
}

const Manifest = Schema.Struct({
  bin: Schema.optional(Schema.Union([Schema.String, Schema.Record(Schema.String, Schema.String)])),
});

/** A package's commands, by name, with the file each runs: its manifest's `bin`. */
function bins(directory: string, name: string): [string, string][] {
  const manifest = path.join(directory, 'package.json');
  if (!existsSync(manifest)) return [];
  const { bin } = Schema.decodeUnknownSync(Manifest)(JSON.parse(readFileSync(manifest, 'utf8')));
  if (bin === undefined) return [];
  if (Schema.is(Schema.String)(bin)) return [[name.replace(/^@[^/]+\//, ''), bin]];
  return Object.entries(bin);
}

for (const modules of process.argv.slice(2)) {
  const commands = path.join(modules, '.bin');
  mkdirSync(commands, { recursive: true });
  for (const name of packages(modules)) {
    const directory = path.join(modules, name);
    for (const [command, file] of bins(directory, name)) {
      const launcher = path.join(commands, command);
      writeFileSync(launcher, `#!/bin/sh\nexec node "${path.resolve(directory, file)}" "$@"\n`);
      chmodSync(launcher, 0o755);
    }
  }
}
