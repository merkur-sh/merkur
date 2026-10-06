import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { brotliCompressSync, constants } from 'node:zlib';
import { captureCompilerArtifactFacts, captureCompilerFileBytes } from './compiler-inventory';

type Facts = Record<string, { bytes: number; sha256: string }>;
type Selection = {
  inputs: Record<string, unknown>;
  outputs: Record<string, { bytes: number; [key: string]: unknown }>;
  artifacts: Facts;
  unmatched_generated_modules: unknown[];
  unmatched_generated_assets: unknown[];
};

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('Precompression requires an original frontend record');
  return value as Record<string, unknown>;
}

function reconcile(value: unknown, facts: Facts): Selection {
  const selection = record(value);
  if (
    Object.keys(selection).sort().join(',') !==
      'artifacts,inputs,outputs,unmatched_generated_assets,unmatched_generated_modules' ||
    !Array.isArray(selection.unmatched_generated_modules) ||
    !Array.isArray(selection.unmatched_generated_assets)
  )
    throw new Error('Precompression requires the original frontend selection diagnostics');
  record(selection.inputs);
  const artifacts = record(selection.artifacts);
  const outputs = record(selection.outputs);
  const names = Object.keys(facts).sort().join(',');
  if (
    Object.keys(artifacts).sort().join(',') !== names ||
    Object.keys(outputs).sort().join(',') !== names
  )
    throw new Error('Frontend selection does not match its exact original artifact members');
  for (const [name, fact] of Object.entries(facts)) {
    const captured = record(artifacts[name]);
    if (
      Object.keys(captured).sort().join(',') !== 'bytes,sha256' ||
      captured.bytes !== fact.bytes ||
      captured.sha256 !== fact.sha256 ||
      record(outputs[name]).bytes !== fact.bytes
    )
      throw new Error('Frontend selection differs from its original emitted bytes');
  }
  return selection as Selection;
}

const canonicalLabel = (label: string): string =>
  label.startsWith('@@//') ? label.slice(2) : label;

function context(value: unknown, producer: string): Record<string, unknown> {
  const original = record(value);
  if (
    Object.keys(original).sort().join(',') !==
      'backend_origin,build_commit,compiler_tooling,frontend_build_id,opaque_public_key,precompression,producer,project,public_release,release_public_key' ||
    !Array.isArray(original.compiler_tooling) ||
    typeof original.producer !== 'string' ||
    canonicalLabel(original.producer) !== '//apps/web:frontend' ||
    original.project !== 'apps/web' ||
    original.precompression !== false ||
    canonicalLabel(producer) !== '//apps/web:frontend_precompressed'
  )
    throw new Error('Precompression requires the original configured frontend producer');
  const manifests = new Set<string>();
  for (const value of original.compiler_tooling) {
    const item = record(value);
    const native = record(item.native);
    if (
      Object.keys(item).sort().join(',') !== 'manifest_label,native' ||
      typeof item.manifest_label !== 'string' ||
      !item.manifest_label.startsWith('@@') ||
      item.manifest_label.startsWith('@@//') ||
      !item.manifest_label.endsWith(':Cargo.toml') ||
      manifests.has(item.manifest_label) ||
      Object.keys(native).sort().join(',') !== 'input,label' ||
      typeof native.input !== 'string' ||
      native.input.length === 0 ||
      typeof native.label !== 'string' ||
      native.label.length === 0
    )
      throw new Error('Precompression requires exact original compiler tooling identities');
    manifests.add(item.manifest_label);
  }
  return { ...original, producer, precompression: true };
}

export async function precompressFrontend(
  source: string,
  output: string,
  originalSelection: string,
  selectionOutput: string,
  originalContext: string,
  contextOutput: string,
  producer: string,
): Promise<void> {
  const before = await captureCompilerArtifactFacts({ kind: 'bundle', directory: source }, true);
  const selection = reconcile(JSON.parse(await readFile(originalSelection, 'utf8')), before);
  const settings = context(JSON.parse(await readFile(originalContext, 'utf8')), producer);
  await mkdir(output, { recursive: true });
  for (const name of Object.keys(before)) {
    if (name.endsWith('.br'))
      throw new Error('Frontend producer already contains compressed bytes');
    const input = path.join(source, name);
    const destination = path.join(output, name);
    await mkdir(path.dirname(destination), { recursive: true });
    const bytes = await captureCompilerFileBytes(input, true);
    await writeFile(destination, bytes, { flag: 'wx' });
    await chmod(destination, 0o644);
    await writeFile(
      `${destination}.br`,
      brotliCompressSync(bytes, {
        params: {
          [constants.BROTLI_PARAM_QUALITY]: 11,
          [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_GENERIC,
          [constants.BROTLI_PARAM_SIZE_HINT]: bytes.byteLength,
        },
      }),
      { flag: 'wx' },
    );
  }
  reconcile(
    selection,
    await captureCompilerArtifactFacts({ kind: 'bundle', directory: source }, true),
  );
  const artifacts = await captureCompilerArtifactFacts({ kind: 'bundle', directory: output });
  const outputs: Selection['outputs'] = {};
  for (const [name, fact] of Object.entries(before)) {
    if (artifacts[name]?.sha256 !== fact.sha256)
      throw new Error('Precompression changed the original frontend bytes');
    const compressed = artifacts[`${name}.br`];
    if (compressed === undefined)
      throw new Error('Precompression omitted its original Brotli member');
    const original = selection.outputs[name];
    if (original === undefined) throw new Error('Frontend output observation disappeared');
    outputs[name] = original;
    outputs[`${name}.br`] = { ...original, bytes: compressed.bytes, compressed_from: name };
  }
  if (Object.keys(artifacts).length !== Object.keys(before).length * 2)
    throw new Error('Precompression emitted an undeclared frontend member');
  await writeFile(selectionOutput, `${JSON.stringify({ ...selection, outputs, artifacts })}\n`, {
    flag: 'wx',
  });
  await writeFile(contextOutput, `${JSON.stringify(settings)}\n`, { flag: 'wx' });
}

if (import.meta.main) {
  const [
    source,
    output,
    originalSelection,
    selectionOutput,
    originalContext,
    contextOutput,
    producer,
  ] = process.argv.slice(2);
  if (
    source === undefined ||
    output === undefined ||
    originalSelection === undefined ||
    selectionOutput === undefined ||
    originalContext === undefined ||
    contextOutput === undefined ||
    producer === undefined
  )
    throw new Error(
      'Precompression requires its declared frontend tree, selection and configuration',
    );
  await precompressFrontend(
    source,
    output,
    originalSelection,
    selectionOutput,
    originalContext,
    contextOutput,
    producer,
  );
}
