import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { hardCutGeneratedTermWasmGlue } from '../../../scripts/term-wasm-current-glue';
import {
  hasExactTermWasmArtifactSet,
  termWasmArtifactsMatchSource,
  writeTermWasmBuildManifest,
} from '../../../scripts/term-wasm-provenance';

function requiredArgument(index: number): string {
  const value = process.argv[index];
  if (value === undefined) throw new Error('WASM packaging requires explicit action arguments');
  return path.resolve(value);
}

const bindings = requiredArgument(2);
const crateManifest = requiredArgument(3);
const output = requiredArgument(4);
const repoRoot = requiredArgument(5);
const moduleName = process.argv[6];
const terminal = process.argv[7] === 'terminal';
if (moduleName === undefined) throw new Error('WASM packaging requires its module name');

const parsed: unknown = Bun.TOML.parse(await fs.readFile(crateManifest, 'utf8'));
if (typeof parsed !== 'object' || parsed === null || !('package' in parsed)) {
  throw new Error('WASM Cargo manifest must declare a package table');
}
const metadata: unknown = parsed.package;
if (typeof metadata !== 'object' || metadata === null) {
  throw new Error('WASM Cargo manifest must declare package metadata');
}
const { name, version, license } = metadata as Record<string, unknown>;
if (typeof name !== 'string' || typeof version !== 'string' || typeof license !== 'string') {
  throw new Error('WASM Cargo manifest must pin package name, version, and license');
}
const files = [
  `${moduleName}.js`,
  `${moduleName}.d.ts`,
  `${moduleName}_bg.wasm`,
  `${moduleName}_bg.wasm.d.ts`,
];
const entries = await fs.readdir(bindings, { withFileTypes: true });
const retainedFiles = await Promise.all(files.map((file) => fs.stat(path.join(bindings, file))));
if (
  entries.length !== files.length ||
  entries.some((entry) => !files.includes(entry.name)) ||
  retainedFiles.some((file) => !file.isFile())
) {
  throw new Error('WASM binding output does not contain the exact declared package inventory');
}
await fs.mkdir(output, { recursive: true });
await Promise.all(
  files.map(async (file) => {
    const destination = path.join(output, file);
    await fs.copyFile(path.join(bindings, file), destination);
    // Bazel action inputs are read-only; retained package outputs have a fixed
    // data-file mode before terminal glue is rewritten and attested.
    await fs.chmod(destination, 0o644);
  }),
);
await fs.writeFile(
  path.join(output, 'package.json'),
  `${JSON.stringify(
    {
      name,
      type: 'module',
      version,
      license,
      files: [`${moduleName}_bg.wasm`, `${moduleName}.js`, `${moduleName}.d.ts`],
      main: `${moduleName}.js`,
      types: `${moduleName}.d.ts`,
      sideEffects: ['./snippets/*'],
    },
    null,
    2,
  )}\n`,
);
await fs.writeFile(path.join(output, '.gitignore'), '*');
if (terminal) {
  if (moduleName !== 'term_wasm') throw new Error('Terminal packaging requires term_wasm bindings');
  await hardCutGeneratedTermWasmGlue(output);
  await writeTermWasmBuildManifest(repoRoot, output);
  if (
    !(await hasExactTermWasmArtifactSet(output)) ||
    !(await termWasmArtifactsMatchSource(repoRoot, output))
  ) {
    throw new Error('Terminal WASM package failed source and retained-byte provenance validation');
  }
}

const inventoryOutput = requiredArgument(8);
const producer = process.argv[9];
if (producer === undefined) throw new Error('WASM package requires its declared producer identity');
const members = [];
for (const member of (await fs.readdir(output)).sort()) {
  const filename = path.join(output, member);
  if (!(await fs.lstat(filename)).isFile())
    throw new Error('Produced WASM package has a non-regular member');
  const content = await fs.readFile(filename);
  members.push({
    member,
    size: content.byteLength,
    sha256: createHash('sha256').update(content).digest('hex'),
  });
}
await fs.writeFile(
  inventoryOutput,
  `${JSON.stringify({ producer, module: moduleName, members }, null, 2)}\n`,
  { flag: 'wx' },
);
