import { mkdtempSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readDeclaredInput } from './artifacts';
import { validGitContext } from './git-context';
import type { GitObjectEvidence } from './git-objects';
import { declaredRatchet } from './ratchet';
import { validSourceManifest } from './snapshot';
import { capturedSourcePayload, withCapturedSourceTree } from './source-tree';
import { loadDeclaredStaticSources, type StaticSource } from './static-sources';

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function captured(here: string, name: string): Promise<unknown> {
  const input = await readDeclaredInput(here, name);
  return JSON.parse(input.bytes.toString('utf8'));
}

function objects(value: unknown): GitObjectEvidence {
  if (
    !record(value) ||
    Object.keys(value).sort().join(',') !== 'contextDigest,packBytes,packDigest,shallow' ||
    typeof value.contextDigest !== 'string' ||
    typeof value.packDigest !== 'string' ||
    typeof value.packBytes !== 'number' ||
    !Array.isArray(value.shallow) ||
    !value.shallow.every((entry) => typeof entry === 'string')
  )
    throw new Error('Captured Git object inventory is invalid');
  return {
    contextDigest: value.contextDigest,
    packDigest: value.packDigest,
    packBytes: value.packBytes,
    shallow: value.shallow,
  };
}

export async function loadCapturedStaticProjections(
  root: string,
  value: unknown,
): Promise<readonly StaticSource[]> {
  if (!Array.isArray(value) || value.length !== 4)
    throw new Error('Complete configured projection dependencies are required');
  const result: StaticSource[] = [];
  const owners = new Set<string>();
  for (const projection of value) {
    if (
      !record(projection) ||
      Object.keys(projection).sort().join(',') !== 'files,manifest,producer,projection' ||
      typeof projection.manifest !== 'string' ||
      typeof projection.producer !== 'string' ||
      typeof projection.projection !== 'string' ||
      owners.has(projection.projection) ||
      !Array.isArray(projection.files) ||
      projection.files.length !== 4
    )
      throw new Error('Invalid configured WASM projection identity');
    owners.add(projection.projection);
    const files: { artifact: string; destination: string }[] = [];
    for (const file of projection.files) {
      if (
        !record(file) ||
        Object.keys(file).sort().join(',') !== 'artifact,destination' ||
        typeof file.artifact !== 'string' ||
        typeof file.destination !== 'string'
      )
        throw new Error('Invalid configured WASM File dependency');
      files.push({ artifact: file.artifact, destination: file.destination });
    }
    result.push(
      ...(await loadDeclaredStaticSources({
        root,
        manifest: projection.manifest,
        producer: projection.producer,
        projection: projection.projection,
        files,
      })),
    );
  }
  return result;
}

export async function runCapturedRatchetPolicy(): Promise<number> {
  const here = fileURLToPath(new URL('.', import.meta.url));
  const payload = process.env.MERKUR_CAPTURED_SOURCE_PAYLOAD;
  if (payload === undefined || !path.isAbsolute(payload))
    throw new Error('Declared complete captured source payload required');
  const runfiles = process.env.TEST_SRCDIR;
  const scratch = process.env.TEST_TMPDIR;
  const git = Bun.which('git');
  if (git === null || runfiles === undefined || scratch === undefined)
    throw new Error('Declared native Git and engine-owned policy workspace are required');
  const context = await captured(here, 'current-git.json');
  const source = await captured(here, 'full-source.json');
  if (!validGitContext(context) || !validSourceManifest(source) || context.head !== source.commit)
    throw new Error('Fresh complete captured source and Git facts are required');
  const objectEvidence = objects(await captured(here, 'git-objects.json'));
  const generated = await loadCapturedStaticProjections(
    path.resolve(here, '../../..'),
    await captured(here, 'ratchet_projection_inputs.json'),
  );
  const fallow = process.env.MERKUR_VERIFICATION_FALLOW;
  if (fallow === undefined || !path.isAbsolute(fallow))
    throw new Error('Declared native Fallow executable required');
  const sdkEnvironment = Object.fromEntries(
    [
      'DYLD_LIBRARY_PATH',
      'DYLD_FALLBACK_LIBRARY_PATH',
      'GIT_EXEC_PATH',
      'GIT_TEMPLATE_DIR',
      'OPENSSL_CONF',
      'OPENSSL_MODULES',
      'MERKUR_BAZEL_NATIVE_SDK_PREFIX',
    ].flatMap((name) => {
      const value = process.env[name];
      return value === undefined ? [] : [[name, value]];
    }),
  );
  return withCapturedSourceTree(
    {
      ...capturedSourcePayload(payload, runfiles, source),
      root: mkdtempSync(path.join(scratch, 'ratchet-source-')),
      source,
    },
    async (root) =>
      declaredRatchet({
        root,
        scratch,
        git,
        fallow,
        runfiles,
        pack: path.join(here, 'objects.pack'),
        objects: objectEvidence,
        context,
        source,
        sdkEnvironment,
        generated,
      }),
  );
}
