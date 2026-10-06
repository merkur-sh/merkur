import { createHash } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { lstat, open, readdir, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { withOwnedDirectory } from '../bun/owned-files';

type ObjectValue = Record<string, unknown>;

function object(value: unknown, keys: readonly string[]): ObjectValue {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('WASM projection requires a declared object');
  const result = value as ObjectValue;
  if (Object.keys(result).sort().join(',') !== [...keys].sort().join(','))
    throw new Error('WASM projection has unexpected or missing fields');
  return result;
}

function text(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0)
    throw new Error('WASM projection requires a nonempty string');
  return value;
}

function portable(value: unknown): string {
  const result = text(value);
  if (
    result.includes('\\') ||
    result.includes('\0') ||
    result.startsWith('/') ||
    result.split('/').some((part) => part === '' || part === '.' || part === '..')
  )
    throw new Error('WASM projection requires a portable relative path');
  return result;
}

function label(value: unknown): string {
  const result = text(value);
  if (!/^@@?[^/]*\/\/[^:]*:[^:]+$/.test(result))
    throw new Error('WASM projection requires an exact configured producer label');
  return result;
}

function sameIdentity(left: Stats, right: Stats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

async function retainedMember(filename: string, expected: ObjectValue): Promise<Buffer> {
  // Engine TreeArtifact presentations may use symlinks. Authority comes from the
  // original package producer's declared inventory, rather than pathname shape.
  const resolved = await realpath(filename);
  const handle = await open(
    resolved,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error('WASM projection requires a regular package member');
    const content = await handle.readFile();
    const after = await handle.stat();
    const final = await lstat(resolved);
    if (
      !sameIdentity(before, after) ||
      !sameIdentity(before, final) ||
      resolved !== (await realpath(filename))
    )
      throw new Error('WASM package member changed during projection');
    if (
      expected.size !== content.byteLength ||
      expected.sha256 !== createHash('sha256').update(content).digest('hex')
    )
      throw new Error('WASM package member differs from its original producer inventory');
    return content;
  } finally {
    await handle.close();
  }
}

function memberFact(value: unknown): ObjectValue {
  const fact = object(value, ['member', 'size', 'sha256']);
  const member = portable(fact.member);
  if (
    path.basename(member) !== member ||
    !Number.isSafeInteger(fact.size) ||
    typeof fact.size !== 'number' ||
    fact.size < 0 ||
    typeof fact.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(fact.sha256)
  )
    throw new Error('WASM producer inventory contains an invalid member fact');
  return fact;
}

async function packageMembers(packageTree: string, inventory: ObjectValue) {
  if (!Array.isArray(inventory.members) || inventory.members.length === 0)
    throw new Error('WASM producer inventory requires its complete package membership');
  const members = new Map<string, Buffer>();
  for (const value of inventory.members) {
    const fact = memberFact(value);
    const member = text(fact.member);
    if (members.has(member)) throw new Error('WASM producer inventory duplicates a member');
    members.set(member, await retainedMember(path.join(packageTree, member), fact));
  }
  if ([...(await readdir(packageTree))].sort().join('\0') !== [...members.keys()].sort().join('\0'))
    throw new Error('WASM package membership differs from its original producer inventory');
  return members;
}

function projectionFiles(value: unknown, moduleName: string) {
  if (!Array.isArray(value)) throw new Error('WASM projection requires its exact file list');
  const files = value.map((entry) =>
    object(entry, ['member', 'output', 'artifact', 'destination']),
  );
  const expected = ['.js', '.d.ts', '_bg.wasm', '_bg.wasm.d.ts'].map(
    (suffix) => moduleName + suffix,
  );
  if (
    files
      .map((file) => text(file.member))
      .sort()
      .join('\0') !== expected.sort().join('\0')
  )
    throw new Error('WASM projection must contain each declared generated source exactly once');
  for (const key of ['output', 'artifact', 'destination']) {
    const values = files.map((file) => portable(file[key]));
    if (new Set(values).size !== files.length)
      throw new Error('WASM projection duplicates a destination');
    if (files.some((file) => path.basename(portable(file[key])) !== file.member))
      throw new Error('WASM projection destination changes its declared member');
  }
  return files;
}

export async function projectSources(
  packageTree: string,
  specification: string,
  outputManifest: string,
  inventoryFile: string,
  root = process.cwd(),
) {
  const description = object(JSON.parse(await readFile(specification, 'utf8')), [
    'producer',
    'projection',
    'packageProducer',
    'files',
  ]);
  const inventory = object(JSON.parse(await readFile(inventoryFile, 'utf8')), [
    'producer',
    'module',
    'members',
  ]);
  if (label(description.packageProducer) !== label(inventory.producer))
    throw new Error('WASM projection inventory belongs to a different package producer');
  const moduleName = portable(inventory.module);
  if (path.basename(moduleName) !== moduleName)
    throw new Error('WASM module must be a direct name');
  const producer = label(description.producer);
  const projection = label(description.projection);
  const files = projectionFiles(description.files, moduleName);
  const members = await packageMembers(packageTree, inventory);
  await withOwnedDirectory(root, async (directory) => {
    const sources = [];
    for (const file of files) {
      const content = members.get(text(file.member));
      if (content === undefined)
        throw new Error('WASM projection is absent from its producer inventory');
      directory.write(portable(file.output), content);
      sources.push({
        artifact: portable(file.artifact),
        destination: portable(file.destination),
        size: content.byteLength,
        sha256: createHash('sha256').update(content).digest('hex'),
      });
    }
    directory.write(
      outputManifest,
      `${JSON.stringify({ producer, projection, sources }, null, 2)}\n`,
    );
    for (const file of files) directory.verify(portable(file.output));
    directory.verify(outputManifest);
  });
}

if (import.meta.main) {
  const [packageTree, specification, outputManifest, inventory] = process.argv.slice(2);
  if (
    packageTree === undefined ||
    specification === undefined ||
    outputManifest === undefined ||
    inventory === undefined
  )
    throw new Error('WASM source projection requires declared package, destinations and inventory');
  await projectSources(packageTree, specification, outputManifest, inventory);
}
