import { createHash } from 'node:crypto';
import { chmod, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const [inputsPath, executable, output, manifestPath, producer, configuredUnit, descriptorPath] =
  process.argv.slice(2);
if (
  inputsPath === undefined ||
  executable === undefined ||
  output === undefined ||
  manifestPath === undefined ||
  producer === undefined ||
  configuredUnit === undefined ||
  descriptorPath === undefined
)
  throw new Error(
    'Native oracle packaging requires declared source facts, executable, outputs and producer',
  );
const hash = (bytes: string | Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');
const inputs = JSON.parse(await readFile(inputsPath, 'utf8')) as Record<string, string>;
const sourceInputs: Record<string, string> = {};
for (const [relative, physical] of Object.entries(inputs).sort(([a], [b]) =>
  a < b ? -1 : a > b ? 1 : 0,
)) {
  if (relative.startsWith('/') || relative.split('/').includes('..'))
    throw new Error(`Native oracle source fact escapes the repository: ${relative}`);
  sourceInputs[relative] = hash(await readFile(physical));
}
if (Object.values(inputs).filter((physical) => physical === descriptorPath).length !== 1)
  throw new Error('Native oracle descriptor must be the exact declared source File');
const descriptor = JSON.parse(await readFile(descriptorPath, 'utf8')) as {
  roots: string[];
  compiler_label: string;
  source_membership: string[];
};
if (
  !Array.isArray(descriptor.source_membership) ||
  JSON.stringify(descriptor.source_membership) !== JSON.stringify(Object.keys(sourceInputs))
)
  throw new Error('Native oracle source provider differs from its selected compiler membership');
const unit = configuredUnit.split(':u_')[1];
if (
  unit === undefined ||
  configuredUnit !== descriptor.compiler_label ||
  producer !== descriptor.compiler_label ||
  descriptor.roots.length !== 1 ||
  descriptor.roots[0] !== unit
)
  throw new Error('Native oracle producer differs from its declared configured compiler root');
const digest = hash(await readFile(executable));
const retained = path.join(output, digest, 'browser_session_oracle');
await mkdir(path.dirname(retained), { recursive: true });
await copyFile(executable, retained);
await chmod(retained, 0o555);
await writeFile(
  manifestPath,
  JSON.stringify(
    {
      source: hash(JSON.stringify(Object.entries(sourceInputs))),
      sourceInputs,
      configuredUnit: unit,
      executable: `target/rust/client-session-oracle/${digest}/browser_session_oracle`,
      sha256: digest,
      command: ['bazel', 'build', producer],
    },
    null,
    2,
  ) + '\n',
);
