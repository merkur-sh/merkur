import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

interface DeclaredInput {
  readonly input: string;
  readonly link: boolean;
  readonly owner?: string;
  readonly canonical: string;
}
interface InputRoot {
  readonly logical: string;
  readonly physical: string;
  readonly directory: boolean;
  readonly owner: string;
}
interface CompilerInput {
  readonly bytes: number;
  readonly format?: string;
  readonly imports: readonly { readonly path: string; readonly external?: boolean }[];
}
interface CompilerOutput {
  readonly bytes: number;
  readonly inputs: Readonly<Record<string, { readonly bytesInOutput: number }>>;
  readonly entryPoint?: string;
}
interface Metafile {
  readonly inputs: Readonly<Record<string, CompilerInput>>;
  readonly outputs: Readonly<Record<string, CompilerOutput>>;
}

export type CompilerArtifact =
  | { readonly kind: 'standalone'; readonly executable: string }
  | { readonly kind: 'bundle'; readonly directory: string };

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('Compiler inventory requires an object');
  return value as Record<string, unknown>;
}

function keys(value: Record<string, unknown>, required: string[], optional: string[] = []): void {
  if (
    required.some((key) => !Object.hasOwn(value, key)) ||
    Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key))
  )
    throw new Error('Compiler inventory has an incomplete or unknown schema');
}

function byteCount(value: unknown): void {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new Error('Compiler inventory has an invalid byte count');
}

function imports(value: unknown): void {
  if (!Array.isArray(value)) throw new Error('Compiler imports must be an array');
  for (const item of value) {
    const fields = record(item);
    keys(fields, ['path', 'kind'], ['external', 'original']);
    if (typeof fields.path !== 'string' || fields.path === '' || typeof fields.kind !== 'string')
      throw new Error('Compiler import has an invalid path or kind');
    if (fields.external !== undefined && typeof fields.external !== 'boolean')
      throw new Error('Compiler import has an invalid external marker');
    if (fields.original !== undefined && typeof fields.original !== 'string')
      throw new Error('Compiler import has an invalid original path');
  }
}

function metafile(value: unknown): Metafile {
  const fields = record(value);
  keys(fields, ['inputs', 'outputs']);
  const inputs = record(fields.inputs);
  const outputs = record(fields.outputs);
  if (Object.keys(inputs).length === 0 || Object.keys(outputs).length === 0)
    throw new Error('Compiler inventory must contain selected sources and outputs');
  for (const input of Object.values(inputs)) {
    const fields = record(input);
    keys(fields, ['bytes', 'imports'], ['format']);
    byteCount(fields.bytes);
    imports(fields.imports);
    if (fields.format !== undefined && typeof fields.format !== 'string')
      throw new Error('Compiler input has an invalid format');
  }
  for (const output of Object.values(outputs)) {
    const fields = record(output);
    keys(fields, ['bytes', 'inputs', 'imports', 'exports'], ['entryPoint']);
    byteCount(fields.bytes);
    imports(fields.imports);
    if (!Array.isArray(fields.exports) || fields.exports.some((value) => typeof value !== 'string'))
      throw new Error('Compiler exports must be string names');
    if (fields.entryPoint !== undefined && typeof fields.entryPoint !== 'string')
      throw new Error('Compiler output has an invalid entry point');
    for (const contribution of Object.values(record(fields.inputs))) {
      const fields = record(contribution);
      keys(fields, ['bytesInOutput']);
      byteCount(fields.bytesInOutput);
    }
  }
  return value as Metafile;
}

export async function captureCompilerFileBytes(
  filename: string,
  declaredInput = false,
): Promise<Buffer> {
  const physical = declaredInput ? await realpath(filename) : filename;
  const handle = await open(
    physical,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) throw new Error('Compiler artifact is not an ordinary regular file');
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    const current = await lstat(declaredInput ? await realpath(filename) : filename, {
      bigint: true,
    });
    if (declaredInput && (await realpath(filename)) !== physical)
      throw new Error('Compiler artifact carrier changed during capture');
    for (const value of [after, current]) {
      if (
        !value.isFile() ||
        value.dev !== before.dev ||
        value.ino !== before.ino ||
        value.size !== before.size ||
        value.mtimeNs !== before.mtimeNs ||
        value.ctimeNs !== before.ctimeNs
      )
        throw new Error('Compiler artifact changed during capture');
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

export async function captureCompilerArtifactFacts(
  artifact: CompilerArtifact,
  declaredInput = false,
): Promise<Record<string, { bytes: number; sha256: string }>> {
  const names =
    artifact.kind === 'standalone'
      ? [path.basename(artifact.executable)]
      : await bundleMembers(
          declaredInput ? await realpath(artifact.directory) : artifact.directory,
          '',
          declaredInput,
        );
  const result: Record<string, { bytes: number; sha256: string }> = Object.create(null);
  for (const name of names) {
    outputName(name, artifact);
    const filename =
      artifact.kind === 'standalone' ? artifact.executable : path.join(artifact.directory, name);
    const bytes = await captureCompilerFileBytes(filename, declaredInput);
    result[name] = {
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
  }
  return result;
}

/** Reconcile the inventory's sole emitted-byte authority against the actual declared artifact. */
export async function verifyCompilerArtifacts(
  value: unknown,
  artifact: CompilerArtifact,
): Promise<void> {
  const inventory = record(value);
  keys(inventory, ['inputs', 'outputs', 'artifacts']);
  const inputs = record(inventory.inputs);
  const metadataInputs: Record<string, unknown> = {};
  for (const [name, input] of Object.entries(inputs)) {
    const fields = record(input);
    keys(fields, ['bytes', 'imports', 'owner', 'sha256'], ['format', 'compilerBytes', 'loader']);
    if (
      typeof fields.owner !== 'string' ||
      fields.owner === '' ||
      typeof fields.sha256 !== 'string' ||
      !/^[0-9a-f]{64}$/.test(fields.sha256)
    )
      throw new Error('Compiler selected input has invalid owner or digest facts');
    const { owner: _owner, sha256: _digest, compilerBytes, loader, ...metadata } = fields;
    if (loader !== undefined || compilerBytes !== undefined) {
      if (
        loader !== 'file' ||
        compilerBytes !== 0 ||
        metadata.format !== undefined ||
        !Array.isArray(metadata.imports) ||
        metadata.imports.length !== 0
      )
        throw new Error('Compiler retained file-loader facts are invalid');
      byteCount(metadata.bytes);
      metadataInputs[name] = { ...metadata, bytes: compilerBytes };
    } else metadataInputs[name] = metadata;
  }
  const metadata = metafile({ inputs: metadataInputs, outputs: inventory.outputs });
  for (const output of Object.values(metadata.outputs)) {
    if (
      Object.keys(output.inputs).some((name) => !Object.hasOwn(inputs, name)) ||
      (output.entryPoint !== undefined && !Object.hasOwn(inputs, output.entryPoint))
    )
      throw new Error('Compiler output refers to an unowned source');
  }
  const facts = record(inventory.artifacts);
  // A downstream action's exact declared File may have Bazel carrier symlinks.
  // These reads establish member bytes, not ownership of the carrier topology.
  const actual = await captureCompilerArtifactFacts(artifact, true);
  const names = Object.keys(actual).sort();
  if (
    names.length === 0 ||
    JSON.stringify(names) !== JSON.stringify(Object.keys(facts).sort()) ||
    JSON.stringify(names) !== JSON.stringify(Object.keys(record(inventory.outputs)).sort())
  )
    throw new Error('Compiler artifact membership differs from its inventory');
  for (const name of names) {
    const fields = record(facts[name]);
    keys(fields, ['bytes', 'sha256']);
    byteCount(fields.bytes);
    if (fields.bytes !== actual[name]?.bytes || fields.sha256 !== actual[name]?.sha256)
      throw new Error('Compiler emitted artifact differs from its inventory');
  }
}

function outputName(file: string, artifact: CompilerArtifact): string {
  const relative = file.replace(/^\.\//, '');
  if (
    path.isAbsolute(relative) ||
    relative.split('/').some((part) => part === '' || part === '.' || part === '..') ||
    relative.includes('\\')
  ) {
    throw new Error('Compiler output escaped its declared artifact');
  }
  if (artifact.kind === 'standalone' && path.basename(relative) !== relative)
    throw new Error('Standalone compiler output has an unexpected path');
  return relative;
}

async function bundleMembers(
  directory: string,
  relative = '',
  declaredInput = false,
): Promise<string[]> {
  if (!(await lstat(path.join(directory, relative))).isDirectory())
    throw new Error('Compiler output tree is not an ordinary directory');
  const members: string[] = [];
  for (const child of await readdir(path.join(directory, relative), { withFileTypes: true })) {
    const member = relative ? `${relative}/${child.name}` : child.name;
    if (child.isDirectory())
      members.push(...(await bundleMembers(directory, member, declaredInput)));
    else if (child.isFile()) members.push(member);
    else if (
      declaredInput &&
      child.isSymbolicLink() &&
      (await stat(path.join(directory, member))).isFile()
    )
      members.push(member);
    else throw new Error('Compiler output tree contains a non-regular member');
  }
  return members.sort();
}

function under(root: string, file: string): string | undefined {
  const relative = path.relative(root, file);
  return relative === '' || (!relative.startsWith('../') && !path.isAbsolute(relative))
    ? relative
    : undefined;
}

/** Replace compiler scratch paths with identities from the action's declared inputs. */
export async function retainCompilerInventory(
  filename: string,
  copiedRoot: string,
  executionRoot: string,
  declarations: Readonly<Record<string, DeclaredInput>>,
  artifact: CompilerArtifact,
  fileLoaderExtensions: ReadonlySet<string> = new Set(),
): Promise<void> {
  const roots: InputRoot[] = [];
  for (const [logical, declaration] of Object.entries(declarations)) {
    if (declaration.owner === undefined) throw new Error(`Unowned compiler input: ${logical}`);
    if (
      typeof declaration.canonical !== 'string' ||
      path.isAbsolute(declaration.canonical) ||
      declaration.canonical.includes('\\') ||
      declaration.canonical.split('/').some((part) => part === '' || part === '.' || part === '..')
    )
      throw new Error('Compiler declaration requires its portable canonical destination');
    if (logical !== declaration.canonical) continue;
    const physical = await realpath(path.resolve(executionRoot, declaration.input));
    roots.push({
      logical,
      physical,
      directory: (await stat(physical)).isDirectory(),
      owner: declaration.owner,
    });
  }
  roots.sort((a, b) => a.logical.localeCompare(b.logical));
  const physicalInputs = new Map<string, { path: string; owner: string }>();
  const visited = new Set<string>();
  async function index(root: InputRoot, relative: string): Promise<void> {
    const filename = path.join(root.physical, relative);
    const info = await stat(filename);
    if (info.isDirectory()) {
      if (visited.has(filename)) return;
      visited.add(filename);
      for (const child of await readdir(filename)) await index(root, path.join(relative, child));
    } else if (info.isFile()) {
      const physical = await realpath(filename);
      if (!physicalInputs.has(physical)) {
        physicalInputs.set(physical, {
          path: path.join(root.logical, relative),
          owner: root.owner,
        });
      }
    } else throw new Error('Declared compiler source contains a non-regular input');
  }
  for (const root of roots) await index(root, '');
  const physicalCopiedRoot = await realpath(copiedRoot);
  async function resolve(file: string): Promise<{ path: string; owner: string }> {
    const physical = await realpath(path.resolve(copiedRoot, file));
    const local = under(physicalCopiedRoot, physical);
    if (local !== undefined) {
      const declaration = declarations[local];
      if (declaration?.owner !== undefined) return { path: local, owner: declaration.owner };
      for (const root of roots) {
        if (root.directory && under(root.logical, local) !== undefined) {
          return { path: local, owner: root.owner };
        }
      }
    }
    const declared = physicalInputs.get(physical);
    if (declared !== undefined) return declared;
    throw new Error(`Compiler input has no declared source owner: ${file}`);
  }
  const metadata = metafile(JSON.parse(await readFile(filename, 'utf8')));
  const identities = new Map(
    await Promise.all(
      Object.keys(metadata.inputs).map(async (file) => [file, await resolve(file)] as const),
    ),
  );
  const inputs: Record<string, unknown> = {};
  for (const [file, input] of Object.entries(metadata.inputs)) {
    const identity = identities.get(file);
    if (identity === undefined) throw new Error('Compiler input identity disappeared');
    if (inputs[identity.path] !== undefined)
      throw new Error('Compiler input identity is ambiguous');
    const content = await readFile(path.resolve(copiedRoot, file));
    const fileLoaded = fileLoaderExtensions.has(path.extname(file));
    // Bun's file loader moves the binary payload out of Source.contents. The
    // original metafile records that empty text buffer, not the embedded File.
    // Only extensions explicitly configured on this compiler invocation qualify.
    if (fileLoaded) {
      if (input.bytes !== 0 || input.format !== undefined || input.imports.length !== 0)
        throw new Error('Compiler file-loader metadata differs from its original asset shape');
    } else if (content.byteLength !== input.bytes) {
      throw new Error('Compiler input bytes changed');
    }
    inputs[identity.path] = {
      ...input,
      ...(fileLoaded ? { compilerBytes: input.bytes, loader: 'file' } : {}),
      bytes: content.byteLength,
      owner: identity.owner,
      sha256: createHash('sha256').update(content).digest('hex'),
      imports: await Promise.all(
        input.imports.map(async (item) => ({
          ...item,
          path: item.external ? item.path : (await resolve(item.path)).path,
        })),
      ),
    };
  }
  const artifacts = await captureCompilerArtifactFacts(artifact);
  const outputs: Record<string, unknown> = {};
  for (const [file, output] of Object.entries(metadata.outputs)) {
    const name = outputName(file, artifact);
    if (outputs[name] !== undefined) throw new Error('Compiler output identity is ambiguous');
    if (artifact.kind === 'bundle') {
      if (artifacts[name]?.bytes !== output.bytes) throw new Error('Compiler output bytes changed');
    } else if (name !== path.basename(artifact.executable) || output.entryPoint === undefined) {
      throw new Error('Standalone compiler output differs from its declared executable');
    }
    const entryPoint =
      output.entryPoint === undefined ? undefined : identities.get(output.entryPoint)?.path;
    if (output.entryPoint !== undefined && entryPoint === undefined)
      throw new Error('Compiler output has an unowned entry point');
    outputs[name] = {
      ...output,
      inputs: Object.fromEntries(
        Object.entries(output.inputs).map(([file, value]) => {
          const identity = identities.get(file);
          if (identity === undefined)
            throw new Error('Compiler output refers to an unowned source');
          return [identity.path, value];
        }),
      ),
      ...(entryPoint === undefined ? {} : { entryPoint }),
    };
  }
  const inventory = { inputs, outputs, artifacts };
  await verifyCompilerArtifacts(inventory, artifact);
  await writeFile(
    filename,
    `${JSON.stringify(
      {
        inputs: Object.fromEntries(
          Object.entries(inputs).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
        ),
        outputs: Object.fromEntries(
          Object.entries(outputs).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
        ),
        artifacts,
      },
      null,
      2,
    )}\n`,
  );
}
