import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliDecompressSync } from 'node:zlib';
import { precompressFrontend } from './brotli-build';
import { captureCompilerArtifactFacts } from './compiler-inventory';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'frontend-attribution '));
  roots.push(root);
  const source = path.join(root, 'original');
  mkdirSync(path.join(source, 'assets'), { recursive: true });
  writeFileSync(path.join(source, 'index.html'), '<script src="assets/original.js"></script>');
  writeFileSync(path.join(source, 'assets/original.js'), 'original authored bytes');
  const artifacts = await captureCompilerArtifactFacts({ kind: 'bundle', directory: source });
  const selection = {
    inputs: {
      'apps/web/src/index.tsx': {
        bytes: 23,
        owner: '//apps/web:src/index.tsx',
        sha256: 'a'.repeat(64),
        imports: [],
      },
    },
    outputs: Object.fromEntries(
      Object.entries(artifacts).map(([name, fact]) => [
        name,
        { bytes: fact.bytes, observations: [{ source: 'apps/web/src/index.tsx' }] },
      ]),
    ),
    artifacts,
    unmatched_generated_modules: [
      { id: 'original transformed source', reason: 'original generator remains unresolved' },
    ],
    unmatched_generated_assets: [
      { path: 'assets/original.js', reason: 'original generator remains unresolved' },
    ],
  };
  const context = {
    producer: '//apps/web:frontend',
    project: 'apps/web',
    frontend_build_id: '10000000-0000-0000-0000-000000000001',
    backend_origin: 'https://original.example',
    opaque_public_key: 'original public key',
    build_commit: 'dev',
    release_public_key: '',
    public_release: {
      version: 'dev',
      sequence: 0,
      releasePublicKey: '',
      origin: 'https://original.example',
      opaquePublicKey: 'original public key',
    },
    precompression: false,
    compiler_tooling: [
      {
        manifest_label: '@@original_rolldown//crates/rolldown_binding:Cargo.toml',
        native: { input: 'bazel-out/original.node', label: '//tools:original_native' },
      },
    ],
  };
  const originalSelection = path.join(root, 'original-selection.json');
  const originalContext = path.join(root, 'original-context.json');
  writeFileSync(originalSelection, JSON.stringify(selection));
  writeFileSync(originalContext, JSON.stringify(context));
  const output = path.join(root, 'compressed');
  const selectionOutput = path.join(root, 'compressed-selection.json');
  const contextOutput = path.join(root, 'compressed-context.json');
  const run = () =>
    precompressFrontend(
      source,
      output,
      originalSelection,
      selectionOutput,
      originalContext,
      contextOutput,
      '//apps/web:frontend_precompressed',
    );
  return {
    root,
    source,
    selection,
    context,
    originalSelection,
    originalContext,
    output,
    selectionOutput,
    contextOutput,
    run,
  };
}

test('actual frontend bytes and pending compiler facts survive precompression and spaces', async () => {
  const value = await fixture();
  await value.run();
  const inventory = JSON.parse(readFileSync(value.selectionOutput, 'utf8'));
  expect(inventory.inputs).toEqual(value.selection.inputs);
  expect(inventory.unmatched_generated_modules).toEqual(
    value.selection.unmatched_generated_modules,
  );
  expect(inventory.unmatched_generated_assets).toEqual(value.selection.unmatched_generated_assets);
  expect(inventory.artifacts).toEqual(
    await captureCompilerArtifactFacts({ kind: 'bundle', directory: value.output }),
  );
  expect(Object.keys(inventory.outputs).sort()).toEqual(Object.keys(inventory.artifacts).sort());
  for (const [name, original] of Object.entries(value.selection.outputs)) {
    expect(inventory.outputs[name]).toEqual(original);
    expect(readFileSync(path.join(value.output, name))).toEqual(
      readFileSync(path.join(value.source, name)),
    );
    expect(brotliDecompressSync(readFileSync(path.join(value.output, `${name}.br`)))).toEqual(
      readFileSync(path.join(value.source, name)),
    );
  }
  expect(JSON.parse(readFileSync(value.contextOutput, 'utf8'))).toEqual({
    ...value.context,
    producer: '//apps/web:frontend_precompressed',
    precompression: true,
  });
  expect(JSON.parse(readFileSync(value.originalSelection, 'utf8'))).toEqual(value.selection);
  expect(JSON.parse(readFileSync(value.originalContext, 'utf8'))).toEqual(value.context);
});

test.each(['bytes', 'extra', 'missing'] as const)(
  'refuses captured frontend %s mismatch before publication',
  async (change) => {
    const value = await fixture();
    if (change === 'bytes')
      writeFileSync(path.join(value.source, 'assets/original.js'), 'foreign changed bytes');
    if (change === 'extra') writeFileSync(path.join(value.source, 'foreign.txt'), 'foreign');
    if (change === 'missing') rmSync(path.join(value.source, 'index.html'));
    await expect(value.run()).rejects.toThrow('Frontend selection');
    expect(existsSync(value.selectionOutput)).toBe(false);
    expect(existsSync(value.contextOutput)).toBe(false);
  },
);

test('refuses foreign original producer while preserving context and diagnostics', async () => {
  const value = await fixture();
  const foreign = { ...value.context, producer: '//foreign:frontend' };
  writeFileSync(value.originalContext, JSON.stringify(foreign));
  await expect(value.run()).rejects.toThrow('original configured frontend producer');
  expect(existsSync(value.output)).toBe(false);
  expect(JSON.parse(readFileSync(value.originalContext, 'utf8'))).toEqual(foreign);
});

test('accepts actual configured main-repository labels while preserving their original spelling', async () => {
  const value = await fixture();
  const original = { ...value.context, producer: '@@//apps/web:frontend' };
  writeFileSync(value.originalContext, JSON.stringify(original));
  await precompressFrontend(
    value.source,
    value.output,
    value.originalSelection,
    value.selectionOutput,
    value.originalContext,
    value.contextOutput,
    '@@//apps/web:frontend_precompressed',
  );
  expect(JSON.parse(readFileSync(value.contextOutput, 'utf8'))).toEqual({
    ...original,
    producer: '@@//apps/web:frontend_precompressed',
    precompression: true,
  });
  expect(JSON.parse(readFileSync(value.originalContext, 'utf8'))).toEqual(original);
});

test.each(['@@foreign//apps/web:frontend', '@foreign//apps/web:frontend'])(
  'refuses the same package spelling in foreign repository %s',
  async (producer) => {
    const value = await fixture();
    writeFileSync(value.originalContext, JSON.stringify({ ...value.context, producer }));
    await expect(value.run()).rejects.toThrow('original configured frontend producer');
    expect(existsSync(value.contextOutput)).toBe(false);
  },
);

test('refuses diagnostic erasure and unconfigured output inventory', async () => {
  const value = await fixture();
  const { unmatched_generated_assets: _, ...erased } = value.selection;
  writeFileSync(value.originalSelection, JSON.stringify(erased));
  await expect(value.run()).rejects.toThrow('original frontend selection diagnostics');
  expect(existsSync(value.output)).toBe(false);
});

test('the actual declared Bun runner publishes the same retained frontend contract', async () => {
  const value = await fixture();
  const child = Bun.spawn(
    [
      process.execPath,
      '--no-install',
      '--no-env-file',
      '--config=' + fileURLToPath(new URL('empty-bunfig.toml', import.meta.url)),
      fileURLToPath(new URL('brotli-build.ts', import.meta.url)),
      value.source,
      value.output,
      value.originalSelection,
      value.selectionOutput,
      value.originalContext,
      value.contextOutput,
      '//apps/web:frontend_precompressed',
    ],
    { stdout: 'pipe', stderr: 'pipe' },
  );
  const [, error, status] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect({ status, error }).toEqual({ status: 0, error: '' });
  const inventory = JSON.parse(readFileSync(value.selectionOutput, 'utf8'));
  expect(inventory.inputs).toEqual(value.selection.inputs);
  expect(inventory.unmatched_generated_assets).toEqual(value.selection.unmatched_generated_assets);
  expect(inventory.artifacts).toEqual(
    await captureCompilerArtifactFacts({ kind: 'bundle', directory: value.output }),
  );
});

test('precompression preserves the original native tooling association without admitting its scope', async () => {
  const value = await fixture();
  await value.run();
  const captured = JSON.parse(readFileSync(value.contextOutput, 'utf8'));
  expect(captured.compiler_tooling).toEqual(value.context.compiler_tooling);
});

test.each(['missing', 'duplicate', 'authored', 'foreign-field'])(
  'precompression refuses malformed original tooling relation: %s',
  async (kind) => {
    const value = await fixture();
    const changed: Record<string, unknown> = { ...value.context };
    if (kind === 'missing') delete changed.compiler_tooling;
    else if (kind === 'duplicate')
      changed.compiler_tooling = [
        ...value.context.compiler_tooling,
        ...value.context.compiler_tooling,
      ];
    else if (kind === 'authored')
      changed.compiler_tooling = [
        { ...value.context.compiler_tooling[0], manifest_label: '//apps/web:Cargo.toml' },
      ];
    else changed.compiler_tooling = [{ ...value.context.compiler_tooling[0], scope: 'complete' }];
    writeFileSync(value.originalContext, JSON.stringify(changed));
    await expect(value.run()).rejects.toThrow(
      /original configured frontend producer|original compiler tooling/,
    );
  },
);
