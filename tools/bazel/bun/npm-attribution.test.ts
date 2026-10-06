import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { brotliCompressSync } from 'node:zlib';
import { type NpmCompilerBinding, selectNpmAttribution } from './npm-attribution';

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'npm-attribution-control-'));
  const bytes = 'export const declared = true;\n';
  await mkdir(path.join(root, 'package'));
  await mkdir(path.join(root, 'unused'));
  await writeFile(path.join(root, 'package/index.js'), bytes);
  await writeFile(
    path.join(root, 'package/package.json'),
    JSON.stringify({
      name: 'probe',
      version: '1.0.0',
      license: 'MIT',
      repository: 'https://example.test/probe',
    }),
  );
  await writeFile(
    path.join(root, 'unused/package.json'),
    JSON.stringify({ name: 'unused', version: '2.0.0' }),
  );
  const json = async (name: string, value: unknown) =>
    writeFile(path.join(root, name), JSON.stringify(value));
  const artifact = path.join(root, 'server');
  const emitted = 'native emitted executable bytes';
  await writeFile(artifact, emitted);
  const binding: NpmCompilerBinding = {
    producer: '//apps/server:server',
    artifact: { kind: 'standalone', executable: artifact },
  };
  await json('compiler.json', {
    inputs: {
      'node_modules/probe/index.js': {
        owner: '//link:probe',
        bytes: Buffer.byteLength(bytes),
        sha256: createHash('sha256').update(bytes).digest('hex'),
        imports: [],
      },
    },
    outputs: {
      server: {
        bytes: 1,
        inputs: { 'node_modules/probe/index.js': { bytesInOutput: 1 } },
        imports: [],
        exports: [],
        entryPoint: 'node_modules/probe/index.js',
      },
    },
    artifacts: {
      server: {
        bytes: Buffer.byteLength(emitted),
        sha256: createHash('sha256').update(emitted).digest('hex'),
      },
    },
  });
  await json('declarations.json', {
    'node_modules/probe': {
      input: 'package',
      link: true,
      owner: '//registry:probe',
      canonical: 'node_modules/probe',
    },
  });
  await json('sources.json', [
    {
      package: 'probe',
      version: '1.0.0',
      input: 'package',
      source_label: '//registry:probe',
      workspace: false,
    },
    {
      package: 'unused',
      version: '2.0.0',
      input: 'unused',
      source_label: '//registry:unused',
      workspace: false,
    },
  ]);
  await json('configuration.json', {
    producer: '@@//apps/server:server',
    compile_target: 'bun-darwin-arm64',
    compiler_tooling: [],
  });
  await json('registry.json', {
    'probe@1.0.0': {
      integrity: `sha512-${Buffer.alloc(64, 1).toString('base64')}`,
      tarball: 'https://registry.npmjs.org/probe/-/probe-1.0.0.tgz',
    },
  });
  return {
    root,
    json,
    binding,
    select: (selectedBinding: NpmCompilerBinding = binding) =>
      selectNpmAttribution(
        ...([
          'compiler.json',
          'declarations.json',
          'sources.json',
          'configuration.json',
          'registry.json',
        ].map((name) => path.join(root, name)) as [string, string, string, string, string]),
        selectedBinding,
        root,
      ),
  };
}

test('uses actual compiler-selected typed packages and retains independent source facts', async () => {
  const control = await fixture();
  try {
    const result = await control.select();
    expect(result.expected.producer).toBe('//apps/server:server');
    expect(result.expected.components.map((item) => item.name)).toEqual(['probe']);
    expect(result.expected.components[0]?.source_label).toBe('//registry:probe');
    expect(result.authorities[0]?.package_json_sha256).toBe(
      createHash('sha256')
        .update(await readFile(path.join(control.root, 'package/package.json')))
        .digest('hex'),
    );
    expect(result.pending_scopes).toEqual(['first-party', 'wasm', 'embedded-runtime']);
  } finally {
    await rm(control.root, { recursive: true, force: true });
  }
});

test('rejects compiler artifact substitution, omitted facts and foreign producer contexts', async () => {
  const control = await fixture();
  try {
    const original = JSON.parse(await readFile(path.join(control.root, 'compiler.json'), 'utf8'));
    const { artifacts: _artifacts, ...oldShape } = original;
    await control.json('compiler.json', oldShape);
    await expect(control.select()).rejects.toThrow('schema');
    await control.json('compiler.json', {
      ...original,
      artifacts: { ...original.artifacts, extra: original.artifacts.server },
    });
    await expect(control.select()).rejects.toThrow('membership');
    await control.json('compiler.json', original);
    const declared = JSON.parse(
      await readFile(path.join(control.root, 'declarations.json'), 'utf8'),
    );
    const { canonical: _canonical, ...oldDeclaration } = declared['node_modules/probe'];
    await control.json('declarations.json', { 'node_modules/probe': oldDeclaration });
    await expect(control.select()).rejects.toThrow('canonical placement facts');
    await control.json('declarations.json', {
      'node_modules/alias': { ...declared['node_modules/probe'], canonical: 'node_modules/probe' },
    });
    await expect(control.select()).rejects.toThrow('no declared materialization');
    await control.json('declarations.json', declared);
    await expect(
      control.select({ ...control.binding, producer: '//apps/daemon:daemon' }),
    ).rejects.toThrow('typed build authority');
    await control.json('configuration.json', {
      producer: '//foreign:producer',
      compile_target: 'bun-darwin-arm64',
      compiler_tooling: [],
    });
    await expect(
      control.select({ ...control.binding, producer: '//foreign:producer' }),
    ).rejects.toThrow('standalone compiler context');
    await control.json('configuration.json', {
      producer: '//apps/server:server',
      compile_target: 'bun-darwin-arm64',
      compiler_tooling: [],
    });
    await writeFile(path.join(control.root, 'server'), 'substituted artifact');
    await expect(control.select()).rejects.toThrow('differs from its inventory');
  } finally {
    await rm(control.root, { recursive: true, force: true });
  }
});

test('migration bundle reconciles exact member bytes, entry points and typed npm sources', async () => {
  const control = await fixture();
  try {
    const compiler = JSON.parse(await readFile(path.join(control.root, 'compiler.json'), 'utf8'));
    const bundle = path.join(control.root, 'bundle');
    await mkdir(bundle);
    const entryPoint = 'apps/server/migrations/001_initial.ts';
    const authored = 'export const up = true;';
    const emitted = 'bundled migration including selected npm implementation';
    await writeFile(path.join(control.root, 'migration.ts'), authored);
    await writeFile(path.join(bundle, '001_initial.js'), emitted);
    compiler.inputs[entryPoint] = {
      bytes: Buffer.byteLength(authored),
      sha256: createHash('sha256').update(authored).digest('hex'),
      owner: '//apps/server:migration.ts',
      imports: [],
    };
    compiler.outputs = {
      '001_initial.js': {
        bytes: Buffer.byteLength(emitted),
        inputs: {
          [entryPoint]: { bytesInOutput: 1 },
          'node_modules/probe/index.js': { bytesInOutput: 1 },
        },
        imports: [],
        exports: [],
        entryPoint,
      },
    };
    compiler.artifacts = {
      '001_initial.js': {
        bytes: Buffer.byteLength(emitted),
        sha256: createHash('sha256').update(emitted).digest('hex'),
      },
    };
    const declarations = JSON.parse(
      await readFile(path.join(control.root, 'declarations.json'), 'utf8'),
    );
    declarations[entryPoint] = {
      input: 'migration.ts',
      link: false,
      owner: '//apps/server:migration.ts',
      canonical: entryPoint,
    };
    await control.json('declarations.json', declarations);
    await control.json('compiler.json', compiler);
    const configuration = {
      producer: '@@//apps/server:migrations',
      target: 'bun',
      root: 'apps/server/migrations',
      entry_points: [entryPoint],
      compiler_tooling: [],
    };
    await control.json('configuration.json', configuration);
    const binding: NpmCompilerBinding = {
      producer: '//apps/server:migrations',
      artifact: { kind: 'bundle', directory: bundle },
    };
    const result = await control.select(binding);
    expect(result.expected.producer).toBe('//apps/server:migrations');
    expect(result.expected.components.map((item) => item.name)).toEqual(['probe']);
    expect(result.pending_scopes).toEqual(['first-party']);
    await control.json('configuration.json', {
      ...configuration,
      entry_points: ['apps/server/migrations/foreign.ts'],
    });
    await expect(control.select(binding)).rejects.toThrow('configured entry points');
    for (const tooling of [undefined, null, {}, [{ manifest_label: '//foreign:Cargo.toml' }]]) {
      await control.json('configuration.json', { ...configuration, compiler_tooling: tooling });
      await expect(control.select(binding)).rejects.toThrow('migration bundle context');
    }
    await control.json('configuration.json', configuration);
    await writeFile(path.join(bundle, 'unselected.js'), 'extra');
    await expect(control.select(binding)).rejects.toThrow('membership');
    await rm(path.join(bundle, 'unselected.js'));
    await writeFile(path.join(bundle, '001_initial.js'), 'changed emitted migration');
    await expect(control.select(binding)).rejects.toThrow('differs from its inventory');
  } finally {
    await rm(control.root, { recursive: true, force: true });
  }
});

test('rejects omitted typed selected source and source bytes unlike compiler facts', async () => {
  const control = await fixture();
  try {
    const sources = await readFile(path.join(control.root, 'sources.json'), 'utf8');
    await control.json('sources.json', []);
    await expect(control.select()).rejects.toThrow('no typed package source provider');
    await writeFile(path.join(control.root, 'sources.json'), sources);
    await writeFile(path.join(control.root, 'package/index.js'), 'different compiler bytes');
    await expect(control.select()).rejects.toThrow('differs from actual compiler input');
  } finally {
    await rm(control.root, { recursive: true, force: true });
  }
});

test('rejects unlocked sources and mismatched provider metadata', async () => {
  const control = await fixture();
  try {
    await control.json('registry.json', {});
    await expect(control.select()).rejects.toThrow('absent from the locked registry inventory');
    await control.json('package/package.json', {
      name: 'foreign',
      version: '1.0.0',
      license: 'MIT',
    });
    await expect(control.select()).rejects.toThrow('disagrees with package metadata');
  } finally {
    await rm(control.root, { recursive: true, force: true });
  }
});

test('rejects absent selected license and unsafe explicit license path', async () => {
  const control = await fixture();
  try {
    await control.json('package/package.json', { name: 'probe', version: '1.0.0' });
    await expect(control.select()).rejects.toThrow('no declared license');
    await control.json('package/package.json', {
      name: 'probe',
      version: '1.0.0',
      license: 'SEE LICENSE IN ../foreign',
    });
    await expect(control.select()).rejects.toThrow('portable path');
  } finally {
    await rm(control.root, { recursive: true, force: true });
  }
});

test('retains the declared peer context when engine presentations share package members', async () => {
  const control = await fixture();
  try {
    const before = await control.select();
    await mkdir(path.join(control.root, 'peer-package'));
    for (const member of ['index.js', 'package.json']) {
      await symlink(
        path.join(control.root, 'package', member),
        path.join(control.root, 'peer-package', member),
      );
    }
    const sources = JSON.parse(await readFile(path.join(control.root, 'sources.json'), 'utf8'));
    await control.json('sources.json', [
      ...sources,
      {
        package: 'probe',
        version: '1.0.0(peer@2.0.0)',
        input: 'peer-package',
        source_label: '//registry:probe_peer_context',
        workspace: false,
      },
    ]);
    await control.json('declarations.json', {
      'node_modules/probe': {
        input: 'peer-package',
        link: true,
        owner: '//registry:probe_peer_context',
        canonical: 'node_modules/probe',
      },
    });
    const after = await control.select();
    expect(after.expected.components.map((item) => item.source_label)).toEqual([
      '//registry:probe_peer_context',
    ]);
    expect(after.authorities[0]?.resolver_version).toBe('1.0.0(peer@2.0.0)');
    expect(after.expected.configuration).not.toBe(before.expected.configuration);
  } finally {
    await rm(control.root, { recursive: true, force: true });
  }
});

async function frontendFixture() {
  const control = await fixture();
  const bundle = path.join(control.root, 'frontend');
  await mkdir(bundle);
  const compiler = JSON.parse(await readFile(path.join(control.root, 'compiler.json'), 'utf8'));
  compiler.outputs = {};
  compiler.artifacts = {};
  const emitted = Buffer.from('export const frontend = "original selected probe";');
  for (const [name, bytes] of [
    ['index.js', emitted],
    ['index.js.br', brotliCompressSync(emitted)],
  ] as const) {
    await writeFile(path.join(bundle, name), bytes);
    compiler.outputs[name] = {
      bytes: bytes.length,
      ...(name.endsWith('.br') ? { compressed_from: 'index.js' } : {}),
      observations: [
        {
          environment: 'client',
          type: 'chunk',
          selected: [
            { id: '/declared/node_modules/probe/index.js', source: 'node_modules/probe/index.js' },
          ],
        },
      ],
    };
    compiler.artifacts[name] = {
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
  }
  compiler.inputs['node_modules/probe/index.js'].owner = '//registry:probe';
  const configuration = {
    producer: '@@//apps/web:frontend_precompressed',
    project: 'apps/web',
    frontend_build_id: '11111111-1111-1111-1111-111111111111',
    backend_origin: 'https://example.test',
    opaque_public_key: Buffer.alloc(32, 1).toString('base64url'),
    build_commit: 'dev',
    release_public_key: '',
    public_release: {
      version: 'dev',
      sequence: 0,
      releasePublicKey: '',
      origin: 'https://example.test',
      opaquePublicKey: Buffer.alloc(32, 1).toString('base64url'),
    },
    precompression: true,
    compiler_tooling: [],
  };
  compiler.unmatched_generated_modules = [];
  compiler.unmatched_generated_assets = [];
  await control.json('compiler.json', compiler);
  await control.json('configuration.json', configuration);
  const binding: NpmCompilerBinding = {
    producer: '//apps/web:frontend_precompressed',
    artifact: { kind: 'bundle', directory: bundle },
  };
  return { ...control, compiler, configuration, bundle, binding };
}

test('frontend npm selection binds original packages and exact precompressed emitted bytes', async () => {
  const control = await frontendFixture();
  try {
    const result = await control.select(control.binding);
    expect(result.expected.producer).toBe('//apps/web:frontend_precompressed');
    expect(result.expected.components.map((item) => item.name)).toEqual(['probe']);
    expect(result.expected.components[0]?.source_label).toBe('//registry:probe');
    expect(result.pending_scopes).toEqual(['first-party', 'wasm']);
    await writeFile(path.join(control.bundle, 'index.js.br'), 'substituted compressed bytes');
    await expect(control.select(control.binding)).rejects.toThrow('differs from its inventory');
  } finally {
    await rm(control.root, { recursive: true, force: true });
  }
});

test('frontend refuses foreign context, omitted diagnostics and unresolved generated custody', async () => {
  const control = await frontendFixture();
  try {
    for (const change of [
      { project: 'apps/foreign' },
      { precompression: false },
      { frontend_build_id: 'foreign' },
      { public_release: false },
      { producer: '//apps/web:frontend' },
      { target: 'bun' },
    ]) {
      await control.json('configuration.json', { ...control.configuration, ...change });
      await expect(control.select(control.binding)).rejects.toThrow(
        Object.hasOwn(change, 'producer') ? 'typed build authority' : 'frontend context',
      );
    }
    for (const field of Object.keys(control.configuration)) {
      const omitted: Record<string, unknown> = { ...control.configuration };
      delete omitted[field];
      await control.json('configuration.json', omitted);
      await expect(control.select(control.binding)).rejects.toThrow(
        field === 'producer' ? 'typed build authority' : 'frontend context',
      );
    }
    await control.json('configuration.json', control.configuration);
    for (const field of ['unmatched_generated_modules', 'unmatched_generated_assets']) {
      const omitted = { ...control.compiler };
      delete omitted[field];
      await control.json('compiler.json', omitted);
      await expect(control.select(control.binding)).rejects.toThrow('selection schema');
      await control.json('compiler.json', { ...control.compiler, [field]: [{ id: 'unknown' }] });
      await expect(control.select(control.binding)).rejects.toThrow('unresolved generated');
    }
    await control.json('compiler.json', control.compiler);
    const missingOwner = structuredClone(control.compiler);
    delete missingOwner.inputs['node_modules/probe/index.js'].owner;
    await control.json('compiler.json', missingOwner);
    await expect(control.select(control.binding)).rejects.toThrow('schema');
    const foreignOwner = structuredClone(control.compiler);
    foreignOwner.inputs['node_modules/probe/index.js'].owner = '//foreign:source';
    await control.json('compiler.json', foreignOwner);
    await expect(control.select(control.binding)).rejects.toThrow('original File owner');
    const missingInput = structuredClone(control.compiler);
    delete missingInput.inputs['node_modules/probe/index.js'];
    await control.json('compiler.json', missingInput);
    await expect(control.select(control.binding)).rejects.toThrow('must contain selected sources');
    await control.json('compiler.json', control.compiler);
    await writeFile(path.join(control.root, 'package/index.js'), 'changed original npm source');
    await expect(control.select(control.binding)).rejects.toThrow(
      'differs from actual compiler input',
    );
    await writeFile(path.join(control.root, 'package/index.js'), 'export const declared = true;\n');
    await control.json('sources.json', []);
    await expect(control.select(control.binding)).rejects.toThrow(
      'no typed package source provider',
    );
  } finally {
    await rm(control.root, { recursive: true, force: true });
  }
});

test('frontend validates genuine observation/public-copy metadata and original compression pairs', async () => {
  const control = await frontendFixture();
  try {
    const source = 'apps/web/public/notice.txt';
    const bytes = Buffer.from('original declared public bytes');
    await writeFile(path.join(control.root, 'notice.txt'), bytes);
    control.compiler.inputs[source] = {
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      owner: '//apps/web:notice.txt',
      imports: [],
    };
    const declarations = JSON.parse(
      await readFile(path.join(control.root, 'declarations.json'), 'utf8'),
    );
    declarations[source] = {
      input: 'notice.txt',
      link: false,
      owner: '//apps/web:notice.txt',
      canonical: source,
    };
    await control.json('declarations.json', declarations);
    for (const [name, emitted] of [
      ['notice.txt', bytes],
      ['notice.txt.br', brotliCompressSync(bytes)],
    ] as const) {
      await writeFile(path.join(control.bundle, name), emitted);
      control.compiler.outputs[name] = {
        bytes: emitted.length,
        public_input: source,
        ...(name.endsWith('.br') ? { compressed_from: 'notice.txt' } : {}),
      };
      control.compiler.artifacts[name] = {
        bytes: emitted.length,
        sha256: createHash('sha256').update(emitted).digest('hex'),
      };
    }
    await control.json('compiler.json', control.compiler);
    expect(
      (await control.select(control.binding)).expected.components.map((fact) => fact.name),
    ).toEqual(['probe']);
    for (const change of [
      {
        observations: [
          { environment: 'client', type: 'chunk', selected: [{ id: 'virtual', source: null }] },
        ],
      },
      { observations: [] },
      { inputs: { 'node_modules/probe/index.js': { bytesInOutput: 1 } } },
    ]) {
      const changed = structuredClone(control.compiler);
      Object.assign(changed.outputs['index.js'], change);
      await control.json('compiler.json', changed);
      await expect(control.select(control.binding)).rejects.toThrow('Frontend');
    }
    const wrongPair = structuredClone(control.compiler);
    wrongPair.outputs['index.js.br'].compressed_from = 'notice.txt';
    await control.json('compiler.json', wrongPair);
    await expect(control.select(control.binding)).rejects.toThrow('precompression');
    const wrongPublic = structuredClone(control.compiler);
    wrongPublic.outputs['notice.txt'].public_input = 'node_modules/probe/index.js';
    await control.json('compiler.json', wrongPublic);
    await expect(control.select(control.binding)).rejects.toThrow('public output differs');
    const nonMatchingCompression = brotliCompressSync(Buffer.from('different original bytes'));
    await writeFile(path.join(control.bundle, 'index.js.br'), nonMatchingCompression);
    const wrongBytes = structuredClone(control.compiler);
    wrongBytes.outputs['index.js.br'].bytes = nonMatchingCompression.length;
    wrongBytes.artifacts['index.js.br'] = {
      bytes: nonMatchingCompression.length,
      sha256: createHash('sha256').update(nonMatchingCompression).digest('hex'),
    };
    await control.json('compiler.json', wrongBytes);
    await expect(control.select(control.binding)).rejects.toThrow('original output bytes');
  } finally {
    await rm(control.root, { recursive: true, force: true });
  }
});

test('frontend observation and import enums require original string values', async () => {
  const control = await frontendFixture();
  try {
    for (const field of ['environment', 'type', 'kind']) {
      const valid =
        field === 'environment' ? 'client' : field === 'type' ? 'chunk' : 'import-statement';
      for (const malformed of [[valid], { value: valid }, null, 1]) {
        const changed = structuredClone(control.compiler);
        if (field === 'kind') {
          changed.inputs['node_modules/probe/index.js'].imports = [
            {
              path: 'node_modules/probe/index.js',
              kind: malformed,
            },
          ];
        } else {
          for (const name of ['index.js', 'index.js.br'])
            changed.outputs[name].observations[0][field] = malformed;
        }
        await control.json('compiler.json', changed);
        await expect(control.select(control.binding)).rejects.toThrow(
          field === 'kind' ? 'unresolved original source custody' : 'invalid compiler observations',
        );
      }
    }
  } finally {
    await rm(control.root, { recursive: true, force: true });
  }
});

test('frontend preserves exact compiler-tooling joins in its configured digest and pending scope', async () => {
  const control = await frontendFixture();
  try {
    const before = await control.select(control.binding);
    const tooling = [
      {
        manifest_label: '@@original_source//crates/generator:Cargo.toml',
        native: { input: 'native/rolldown.node', label: '//native:rolldown' },
      },
      {
        manifest_label: '@@original_source//crates/renderer:Cargo.toml',
        native: { input: 'native/rolldown.node', label: '//native:rolldown' },
      },
    ];
    const configuration = { ...control.configuration, compiler_tooling: tooling };
    await control.json('configuration.json', configuration);
    const after = await control.select(control.binding);
    expect(after.pending_scopes).toEqual(['first-party', 'wasm', 'compiler-tooling']);
    expect(after.configuration_authority.settings_sha256).toBe(
      createHash('sha256').update(JSON.stringify(configuration)).digest('hex'),
    );
    expect(after.expected.configuration).not.toBe(before.expected.configuration);
    expect(configuration.compiler_tooling).toEqual(tooling);
  } finally {
    await rm(control.root, { recursive: true, force: true });
  }
});

test('frontend refuses malformed, foreign-path or duplicated compiler-tooling joins', async () => {
  const control = await frontendFixture();
  try {
    const item = {
      manifest_label: '@@original_source//crates/generator:Cargo.toml',
      native: { input: 'native/rolldown.node', label: '//native:rolldown' },
    };
    for (const tooling of [
      null,
      {},
      [null],
      [{ native: item.native }],
      [{ ...item, extra: true }],
      [{ ...item, native: { ...item.native, extra: true } }],
      [{ ...item, manifest_label: 'foreign' }],
      [{ ...item, manifest_label: '//workspace:Cargo.toml' }],
      [{ ...item, manifest_label: '@@original_source//crates/generator:package.json' }],
      [{ ...item, native: { ...item.native, label: 'foreign' } }],
      [{ ...item, native: { ...item.native, input: '../native/rolldown.node' } }],
      [{ ...item, native: { ...item.native, input: '/native/rolldown.node' } }],
      [{ ...item, native: { label: item.native.label } }],
      [item, structuredClone(item)],
    ]) {
      await control.json('configuration.json', {
        ...control.configuration,
        compiler_tooling: tooling,
      });
      await expect(control.select(control.binding)).rejects.toThrow();
    }
  } finally {
    await rm(control.root, { recursive: true, force: true });
  }
});

test('standalone npm contexts require an explicit empty compiler-tooling partition', async () => {
  const control = await fixture();
  try {
    const original = JSON.parse(
      await readFile(path.join(control.root, 'configuration.json'), 'utf8'),
    );
    for (const tooling of [undefined, null, {}, [{ manifest_label: '//foreign:Cargo.toml' }]]) {
      await control.json('configuration.json', { ...original, compiler_tooling: tooling });
      await expect(control.select()).rejects.toThrow('standalone compiler context');
    }
  } finally {
    await rm(control.root, { recursive: true, force: true });
  }
});
