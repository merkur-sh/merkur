import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { retainCompilerInventory, verifyCompilerArtifacts } from './compiler-inventory';

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'compiler-inputs-'));
  const copied = path.join(directory, 'copied');
  const execution = path.join(directory, 'execution');
  const packageRoot = path.join(execution, 'package');
  await mkdir(copied);
  await mkdir(packageRoot, { recursive: true });
  await writeFile(path.join(copied, 'entry.ts'), 'entry');
  await writeFile(path.join(execution, 'entry.ts'), 'entry');
  await writeFile(path.join(packageRoot, 'index.js'), 'dependency');
  await symlink(packageRoot, path.join(copied, 'package'));
  const dependency = path.relative(copied, path.join(packageRoot, 'index.js'));
  const filename = path.join(directory, 'inventory.json');
  const metadata = {
    inputs: {
      'entry.ts': { bytes: 5, imports: [{ path: dependency, kind: 'import-statement' }] },
      [dependency]: { bytes: 10, imports: [] },
    },
    outputs: {
      './program': {
        bytes: 15,
        imports: [],
        exports: [],
        entryPoint: 'entry.ts',
        inputs: { 'entry.ts': { bytesInOutput: 5 } },
      },
    },
  };
  const declarations = {
    'entry.ts': {
      input: 'entry.ts',
      link: false,
      owner: '//source:entry.ts',
      canonical: 'entry.ts',
    },
    'node_modules/locked-package': {
      input: 'package',
      link: true,
      owner: '@npm//:locked-package',
      canonical: 'node_modules/locked-package',
    },
  };
  const executable = path.join(directory, 'program');
  await writeFile(executable, 'emitted program bytes are larger than the JS estimate');
  await writeFile(filename, JSON.stringify(metadata));
  return { directory, copied, execution, filename, metadata, declarations, executable };
}

test('compiler facts bind copied first-party and declared package roots to portable owners', async () => {
  const item = await fixture();
  try {
    await retainCompilerInventory(item.filename, item.copied, item.execution, item.declarations, {
      kind: 'standalone',
      executable: item.executable,
    });
    const actual = JSON.parse(await readFile(item.filename, 'utf8'));
    expect(Object.keys(actual.inputs)).toEqual([
      'entry.ts',
      'node_modules/locked-package/index.js',
    ]);
    expect(actual.inputs['entry.ts'].imports[0].path).toBe('node_modules/locked-package/index.js');
    expect(actual.inputs['node_modules/locked-package/index.js'].owner).toBe(
      '@npm//:locked-package',
    );
    expect(actual.inputs['entry.ts'].sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(actual.outputs.program.entryPoint).toBe('entry.ts');
    expect(actual.outputs.program.bytes).toBe(15);
    expect(Object.hasOwn(actual.outputs.program, 'sha256')).toBe(false);
    const emitted = await readFile(item.executable);
    expect(actual.artifacts.program).toEqual({
      bytes: emitted.length,
      sha256: new Bun.CryptoHasher('sha256').update(emitted).digest('hex'),
    });
    expect(actual.artifacts.program.bytes).toBeGreaterThan(actual.outputs.program.bytes);
    expect(JSON.stringify(actual)).not.toContain(item.directory);
  } finally {
    await rm(item.directory, { recursive: true, force: true });
  }
});

test('standalone inventory refuses malformed compiler outputs and substitutes for emitted bytes', async () => {
  const item = await fixture();
  try {
    async function capture(outputs: unknown) {
      await writeFile(item.filename, JSON.stringify({ ...item.metadata, outputs }));
      return retainCompilerInventory(
        item.filename,
        item.copied,
        item.execution,
        item.declarations,
        {
          kind: 'standalone',
          executable: item.executable,
        },
      );
    }
    const output = item.metadata.outputs['./program'];
    for (const outputs of [
      {},
      { program: { ...output, bytes: true } },
      { program: { ...output, inputs: { 'entry.ts': { bytesInOutput: -1 } } } },
      { program: { ...output, imports: null } },
      { program: { ...output, exports: [false] } },
      { program: { ...output, invented: true } },
    ])
      await expect(capture(outputs)).rejects.toThrow();
    await expect(capture({ foreign: output })).rejects.toThrow('declared executable');
    await expect(capture({ program: { ...output, entryPoint: undefined } })).rejects.toThrow(
      'declared executable',
    );
    await expect(capture({ program: output, extra: output })).rejects.toThrow(
      'declared executable',
    );
    await capture(item.metadata.outputs);
    const actual = JSON.parse(await readFile(item.filename, 'utf8'));
    await expect(
      verifyCompilerArtifacts(
        { inputs: actual.inputs, outputs: actual.outputs },
        {
          kind: 'standalone',
          executable: item.executable,
        },
      ),
    ).rejects.toThrow('schema');
    await writeFile(item.executable, 'substituted executable');
    await expect(
      verifyCompilerArtifacts(actual, {
        kind: 'standalone',
        executable: item.executable,
      }),
    ).rejects.toThrow('differs from its inventory');
    await rm(item.executable);
    await symlink(path.join(item.copied, 'entry.ts'), item.executable);
    await expect(capture(item.metadata.outputs)).rejects.toThrow();
  } finally {
    await rm(item.directory, { recursive: true, force: true });
  }
});

test('compiler capture refuses undeclared input, changed byte counts and missing owner facts', async () => {
  const item = await fixture();
  try {
    await writeFile(path.join(item.directory, 'ambient.js'), 'ambient');
    await writeFile(
      item.filename,
      JSON.stringify({
        ...item.metadata,
        inputs: { ...item.metadata.inputs, '../ambient.js': { bytes: 7, imports: [] } },
      }),
    );
    await expect(
      retainCompilerInventory(item.filename, item.copied, item.execution, item.declarations, {
        kind: 'standalone',
        executable: item.executable,
      }),
    ).rejects.toThrow('no declared source owner');
    await writeFile(item.filename, JSON.stringify(item.metadata));
    await writeFile(path.join(item.copied, 'entry.ts'), 'mutated');
    await expect(
      retainCompilerInventory(item.filename, item.copied, item.execution, item.declarations, {
        kind: 'standalone',
        executable: item.executable,
      }),
    ).rejects.toThrow('bytes changed');
    await expect(
      retainCompilerInventory(
        item.filename,
        item.copied,
        item.execution,
        {
          'entry.ts': { input: 'entry.ts', link: false, canonical: 'entry.ts' },
        },
        { kind: 'standalone', executable: item.executable },
      ),
    ).rejects.toThrow('Unowned compiler input');
  } finally {
    await rm(item.directory, { recursive: true, force: true });
  }
});

test('bundle inventory binds nested output members and refuses omissions, aliases and changed bytes', async () => {
  const item = await fixture();
  const output = path.join(item.directory, 'bundle');
  try {
    await mkdir(path.join(output, 'nested'), { recursive: true });
    await writeFile(path.join(output, 'program.js'), 'selected output');
    await writeFile(path.join(output, 'nested/other.js'), 'other output');
    const metadata = {
      ...item.metadata,
      outputs: {
        './program.js': { ...item.metadata.outputs['./program'], bytes: 15 },
        'nested/other.js': { ...item.metadata.outputs['./program'], bytes: 12 },
      },
    };
    async function capture(
      data: {
        inputs: typeof item.metadata.inputs;
        outputs: Record<string, (typeof item.metadata.outputs)['./program']>;
      } = metadata,
    ) {
      await writeFile(item.filename, JSON.stringify(data));
      return retainCompilerInventory(
        item.filename,
        item.copied,
        item.execution,
        item.declarations,
        {
          kind: 'bundle',
          directory: output,
        },
      );
    }
    await capture();
    const actual = JSON.parse(await readFile(item.filename, 'utf8'));
    expect(Object.keys(actual.outputs)).toEqual(['nested/other.js', 'program.js']);
    expect(actual.artifacts['nested/other.js'].sha256).toBe(
      new Bun.CryptoHasher('sha256').update('other output').digest('hex'),
    );
    await writeFile(path.join(output, '__proto__'), 'unselected emitted bytes');
    await expect(capture()).rejects.toThrow('membership differs');
    await expect(
      verifyCompilerArtifacts(actual, {
        kind: 'bundle',
        directory: output,
      }),
    ).rejects.toThrow('membership differs');
    await rm(path.join(output, '__proto__'));
    await expect(
      capture({ ...metadata, outputs: { './program.js': metadata.outputs['./program.js'] } }),
    ).rejects.toThrow('membership differs');
    await expect(
      capture({
        ...metadata,
        outputs: {
          ...metadata.outputs,
          'program.js': metadata.outputs['./program.js'],
        },
      }),
    ).rejects.toThrow('identity is ambiguous');
    await expect(
      capture({
        ...metadata,
        outputs: {
          '../outside.js': metadata.outputs['./program.js'],
        },
      }),
    ).rejects.toThrow('escaped its declared artifact');
    await writeFile(path.join(output, 'program.js'), 'changed output');
    await expect(capture()).rejects.toThrow('output bytes changed');
    await rm(path.join(output, 'program.js'));
    await symlink(path.join(output, 'nested/other.js'), path.join(output, 'program.js'));
    await expect(capture()).rejects.toThrow('non-regular member');
  } finally {
    await rm(item.directory, { recursive: true, force: true });
  }
});

test('explicit compiler file loader retains raw text metadata and actual binary File bytes', async () => {
  const item = await fixture();
  try {
    const asset = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]);
    await writeFile(path.join(item.copied, 'module.wasm'), asset);
    await writeFile(path.join(item.execution, 'module.wasm'), asset);
    const declarations = {
      ...item.declarations,
      'module.wasm': {
        input: 'module.wasm',
        link: false,
        owner: '//wasm:original',
        canonical: 'module.wasm',
      },
    };
    const metadata = {
      ...item.metadata,
      inputs: { ...item.metadata.inputs, 'module.wasm': { bytes: 0, imports: [] } },
    };
    async function capture(loader: ReadonlySet<string>, bytes = 0, format?: string) {
      await writeFile(
        item.filename,
        JSON.stringify({
          ...metadata,
          inputs: {
            ...metadata.inputs,
            'module.wasm': { bytes, imports: [], ...(format === undefined ? {} : { format }) },
          },
        }),
      );
      return retainCompilerInventory(
        item.filename,
        item.copied,
        item.execution,
        declarations,
        { kind: 'standalone', executable: item.executable },
        loader,
      );
    }
    await expect(capture(new Set())).rejects.toThrow('Compiler input bytes changed');
    await capture(new Set(['.wasm']));
    const retained = JSON.parse(await readFile(item.filename, 'utf8'));
    expect(retained.inputs['module.wasm']).toMatchObject({
      bytes: asset.length,
      compilerBytes: 0,
      loader: 'file',
      owner: '//wasm:original',
      sha256: new Bun.CryptoHasher('sha256').update(asset).digest('hex'),
    });
    await expect(capture(new Set(['.wasm']), asset.length)).rejects.toThrow('original asset shape');
    await expect(capture(new Set(['.wasm']), 0, 'esm')).rejects.toThrow('original asset shape');
    await writeFile(path.join(item.copied, 'entry.ts'), 'changed ordinary source');
    await expect(capture(new Set(['.wasm']))).rejects.toThrow('Compiler input bytes changed');
  } finally {
    await rm(item.directory, { recursive: true, force: true });
  }
});
