import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  collectNativeBuildEnvironmentOverrides,
  createEdgeHarnessNativeArtifactManifest,
  EDGE_HARNESS_NATIVE_BUILD_COMMANDS,
  ensureCanonicalNativeBuildOutputDirectory,
  provisionEdgeHarnessNativeArtifacts,
  validateCanonicalNativeBuildArtifact,
  verifyProvisionedNativeArtifacts,
} from './edge-harness-native-artifacts';
import { runTestProcess } from './test-process';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('edge harness native artifact preflight', () => {
  test('requires the helper and pins its source alongside the dataplane', async () => {
    const absent = await createFixture();
    mutateManifest(absent.manifestPath, (manifest) => {
      delete requiredRecord(manifest.artifacts).imageWorker;
    });
    await expectRejectedWithoutBuild(absent);

    const changed = await createFixture();
    const source = 'packages/merkur-image-worker/src/main.rs';
    mkdirSync(path.dirname(path.join(changed.root, source)), { recursive: true });
    writeFileSync(path.join(changed.root, source), 'fn main() {}\n');
    await expectRejectedWithoutBuild(changed, 'native source closure is dirty');
    await git(changed.root, 'add', source);
    await git(changed.root, 'commit', '--quiet', '-m', 'worker source');
    await expectRejectedWithoutBuild(changed, 'source closure does not match');
  });

  test('installs one verified artifact set without invoking the build callback', async () => {
    const fixture = await createFixture();
    let buildCalls = 0;

    const provenance = await provisionEdgeHarnessNativeArtifacts(
      fixture.root,
      fixture.manifestPath,
      async () => {
        buildCalls += 1;
      },
    );

    expect(buildCalls).toBe(0);
    expect(provenance.mode).toBe('verified-prebuilt');
    if (provenance.mode !== 'verified-prebuilt') throw new Error('wrong provenance mode');
    expect(provenance.manifestPath).toBe(fixture.manifestPath);
    expect(provenance.manifestSha256).toBe(
      createHash('sha256').update(readFileSync(fixture.manifestPath)).digest('hex'),
    );
    expect(provenance.buildCommands).toEqual(EDGE_HARNESS_NATIVE_BUILD_COMMANDS);
    for (const [name, relativePaths] of Object.entries(INSTALL_PATHS)) {
      const artifact = provenance.artifacts[name as keyof typeof INSTALL_PATHS];
      expect(artifact.installedPaths).toEqual(
        relativePaths.map((entry) => path.join(fixture.root, entry)),
      );
      for (const installed of artifact.installedPaths) {
        expect(readFileSync(installed)).toEqual(readFileSync(artifact.path));
        expect(statSync(installed).mode & 0o111).toBe(0o111);
      }
    }
  });

  test('never falls back to a build when a supplied manifest is invalid', async () => {
    const fixture = await createFixture();
    // Corrupt the last artifact: preflight must verify all four before writing
    // even an earlier valid artifact into the target worktree.
    mutateManifest(fixture.manifestPath, (manifest) => {
      requiredRecord(requiredRecord(manifest.artifacts).proxy).sha256 = '0'.repeat(64);
    });
    await expectRejectedWithoutBuild(fixture, 'proxy artifact bytes do not match the manifest');
  });

  test('runs the Playwright global-setup artifact resolver in a real Node subprocess without Bun', async () => {
    const fixture = await createFixture();
    let buildCalls = 0;
    const provenance = await provisionEdgeHarnessNativeArtifacts(
      fixture.root,
      fixture.manifestPath,
      async () => {
        buildCalls += 1;
      },
    );
    const helperUrl = new URL('./edge-harness-native-artifacts.ts', import.meta.url).href;
    // Playwright globalSetup runs under Node, not the Bun process executing
    // this test. Import the actual module and exercise its complete read-only
    // verification path, including PATH/toolchain discovery, in that runtime.
    const node = await runTestProcess(
      [
        'node',
        '--input-type=module',
        '--eval',
        `
        import { readFileSync } from 'node:fs';
        if (process.release.name !== 'node' || process.versions.bun !== undefined ||
            typeof globalThis.Bun !== 'undefined') throw new Error('expected real Node without Bun');
        const helper = await import(process.argv[1]);
        const executable = await helper.resolveVerifiedPrebuiltDataplanePath(process.argv[2], process.argv[3]);
        process.stdout.write(JSON.stringify({
          runtime: process.release.name,
          bunGlobal: typeof globalThis.Bun,
          pid: process.pid,
          executable,
          body: readFileSync(executable, 'utf8'),
        }));
      `,
        helperUrl,
        fixture.root,
        fixture.manifestPath,
      ],
      { cwd: temporaryDirectory('edge-harness-node-global-setup-cwd-'), timeout: 15_000 },
    );
    expect(node.exitCode, node.stderr).toBe(0);
    const result = requiredRecord(JSON.parse(node.stdout));
    expect(result.runtime).toBe('node');
    expect(result.bunGlobal).toBe('undefined');
    expect(result.pid).not.toBe(process.pid);
    expect(result.executable).toBe(path.join(fixture.root, INSTALL_PATHS.dataplane[1]));
    expect(result.body).toBe('dataplane');
    expect(buildCalls).toBe(0);
    expect(() => verifyProvisionedNativeArtifacts(provenance)).not.toThrow();
  });

  test('detects same-size post-provision mutation and symlink replacement at every installed path', async () => {
    const fixture = await createFixture();
    let buildCalls = 0;
    const provenance = await provisionEdgeHarnessNativeArtifacts(
      fixture.root,
      fixture.manifestPath,
      async () => {
        buildCalls += 1;
      },
    );
    expect(() => verifyProvisionedNativeArtifacts(provenance)).not.toThrow();
    for (const name of ['dataplane', 'imageWorker', 'edge', 'proxy'] as const) {
      const artifact = provenance.artifacts[name];
      for (const installed of artifact.installedPaths) {
        const original = readFileSync(installed);
        const changed = Buffer.from(original);
        changed[0] = (changed[0] ?? 0) ^ 1;
        chmodSync(installed, 0o755);
        writeFileSync(installed, changed);
        expect(statSync(installed).size).toBe(original.byteLength);
        expect(() => verifyProvisionedNativeArtifacts(provenance)).toThrow(
          'artifact changed after native preflight',
        );
        writeFileSync(installed, original);
        chmodSync(installed, 0o555);
        expect(() => verifyProvisionedNativeArtifacts(provenance)).not.toThrow();

        // Equal bytes do not make a new symlink an owned install destination.
        // The external source is the same immutable artifact, not a bad hash.
        unlinkSync(installed);
        symlinkSync(fixture.artifactPaths[name], installed);
        expect(readFileSync(installed)).toEqual(original);
        expect(() => verifyProvisionedNativeArtifacts(provenance)).toThrow(
          'not a canonical singly linked file',
        );
        unlinkSync(installed);
        writeExecutable(installed, original.toString('utf8'));
        chmodSync(installed, 0o555);
        expect(() => verifyProvisionedNativeArtifacts(provenance)).not.toThrow();
      }
    }
    expect(buildCalls).toBe(0);
  });

  test('rejects source, toolchain, command, and path provenance drift', async () => {
    const sourceDrift = await createFixture();
    writeFileSync(
      path.join(sourceDrift.root, 'Cargo.toml'),
      '[workspace]\nmembers=[]\n# changed\n',
    );
    await expectRejectedWithoutBuild(sourceDrift, 'native source closure is dirty');
    await git(sourceDrift.root, 'add', 'Cargo.toml');
    await git(sourceDrift.root, 'commit', '--quiet', '-m', 'changed source');
    await expectRejectedWithoutBuild(sourceDrift, 'source closure does not match');

    const toolchainDrift = await createFixture();
    mutateManifest(toolchainDrift.manifestPath, (manifest) => {
      const toolchain = requiredRecord(manifest.toolchain);
      const rustc = requiredRecord(toolchain.rustc);
      rustc.versionVerbose = `${String(rustc.versionVerbose)}-different`;
    });
    await expectRejectedWithoutBuild(toolchainDrift, 'toolchain does not match');

    const commandDrift = await createFixture();
    mutateManifest(commandDrift.manifestPath, (manifest) => {
      const build = requiredRecord(manifest.build);
      build.commands = [['cargo', 'build', '--release']];
    });
    await expectRejectedWithoutBuild(commandDrift, 'build commands are not exact');

    await expectRejectedWithoutBuild(
      { ...commandDrift, manifestPath: 'relative/native-artifact-manifest.json' },
      'must be an absolute path',
    );
  });

  test('rejects malformed manifests, unknown fields, missing paths, and manifest aliases', async () => {
    const fixture = await createFixture();
    const valid = readFileSync(fixture.manifestPath);
    for (const malformed of ['{', 'null', '[]', '{}']) {
      writeFileSync(fixture.manifestPath, malformed);
      await expectRejectedWithoutBuild(fixture);
    }
    writeFileSync(fixture.manifestPath, valid);
    mutateManifest(fixture.manifestPath, (manifest) => {
      manifest.unrecognized = true;
    });
    await expectRejectedWithoutBuild(fixture, 'object keys');
    writeFileSync(fixture.manifestPath, valid);
    const alias = path.join(path.dirname(fixture.manifestPath), 'manifest-alias.json');
    symlinkSync(fixture.manifestPath, alias);
    await expectRejectedWithoutBuild({ ...fixture, manifestPath: alias }, 'fully resolved');
    await expectRejectedWithoutBuild({
      ...fixture,
      manifestPath: path.join(path.dirname(fixture.manifestPath), 'missing-manifest.json'),
    });
    await expectRejectedWithoutBuild({ ...fixture, manifestPath: '' }, 'absolute path');
  });

  test('rejects environment overrides without changing the process environment', async () => {
    const fixture = await createFixture();
    mutateManifest(fixture.manifestPath, (manifest) => {
      requiredRecord(manifest.build).environmentOverrides = [
        { name: 'RUSTFLAGS', value: '--cfg definitely_not_this_benchmark' },
      ];
    });
    await expectRejectedWithoutBuild(fixture, 'build environment does not match');
  });

  test('rejects artifact byte, length, executable, alias, and reused-path failures before install', async () => {
    const fixture = await createFixture();
    const valid = readFileSync(fixture.manifestPath);
    const proxy = fixture.artifactPaths.proxy;
    writeFileSync(proxy, 'wrong'); // Same length: the hash, not only size, must protect identity.
    await expectRejectedWithoutBuild(fixture, 'proxy artifact bytes do not match');
    writeFileSync(proxy, 'proxy');
    mutateManifest(fixture.manifestPath, (manifest) => {
      requiredRecord(requiredRecord(manifest.artifacts).proxy).byteLength = 6;
    });
    await expectRejectedWithoutBuild(fixture, 'proxy artifact bytes do not match');
    writeFileSync(fixture.manifestPath, valid);
    chmodSync(proxy, 0o644);
    await expectRejectedWithoutBuild(fixture);
    chmodSync(proxy, 0o755);
    const alias = path.join(path.dirname(proxy), 'proxy-alias');
    symlinkSync(proxy, alias);
    mutateManifest(fixture.manifestPath, (manifest) => {
      requiredRecord(requiredRecord(manifest.artifacts).proxy).path = alias;
    });
    await expectRejectedWithoutBuild(fixture, 'path is unresolved or reused');
    writeFileSync(fixture.manifestPath, valid);
    mutateManifest(fixture.manifestPath, (manifest) => {
      const artifacts = requiredRecord(manifest.artifacts);
      artifacts.proxy = artifacts.edge;
    });
    await expectRejectedWithoutBuild(fixture, 'path is unresolved or reused');
    writeFileSync(fixture.manifestPath, valid);
    mutateManifest(fixture.manifestPath, (manifest) => {
      requiredRecord(requiredRecord(manifest.artifacts).proxy).path = 'relative/proxy';
    });
    await expectRejectedWithoutBuild(fixture, 'proxy artifact evidence is invalid');
  });

  test('rejects untracked native inputs but permits unrelated browser source differences', async () => {
    const fixture = await createFixture();
    mkdirSync(path.join(fixture.root, 'apps/web/src'), { recursive: true });
    writeFileSync(
      path.join(fixture.root, 'apps/web/src/browser-candidate.ts'),
      'export const credits = 2;',
    );
    // Browser-only differences must not invalidate the shared native closure.
    const browserVariant = await createEdgeHarnessNativeArtifactManifest(
      fixture.root,
      fixture.artifactPaths,
    );
    const original = requiredRecord(JSON.parse(readFileSync(fixture.manifestPath, 'utf8')));
    expect(original.source).toEqual(browserVariant.source);
    mkdirSync(path.join(fixture.root, 'apps/daemon/dataplane/src'), { recursive: true });
    writeFileSync(
      path.join(fixture.root, 'apps/daemon/dataplane/src/untracked.rs'),
      'fn changed() {}',
    );
    await expectRejectedWithoutBuild(fixture, 'native source closure is dirty');
  });

  test('validates the final install target before replacing any earlier artifact', async () => {
    for (const targetKind of ['directory', 'symlink'] as const) {
      const fixture = await createFixture();
      const earlierPaths = [
        ...INSTALL_PATHS.dataplane,
        ...INSTALL_PATHS.imageWorker,
        ...INSTALL_PATHS.edge,
      ].map((relative) => writeExecutable(path.join(fixture.root, relative), `old:${relative}`));
      const before = earlierPaths.map((file) => ({
        body: readFileSync(file),
        metadata: statSync(file),
      }));
      const rejectedTarget = path.join(fixture.root, INSTALL_PATHS.proxy[0]);
      const external = temporaryDirectory('edge-harness-native-untouched-');
      const sentinel = writeExecutable(path.join(external, 'sentinel'), 'external bytes');
      if (targetKind === 'directory') mkdirSync(rejectedTarget);
      else symlinkSync(sentinel, rejectedTarget);
      const releaseDirectory = path.dirname(rejectedTarget);
      const directoryBefore = readdirSync(releaseDirectory).sort();
      let buildCalls = 0;

      await expect(
        provisionEdgeHarnessNativeArtifacts(fixture.root, fixture.manifestPath, async () => {
          buildCalls += 1;
        }),
      ).rejects.toThrow('proxy artifact install target is not a canonical singly linked file');

      expect(buildCalls).toBe(0);
      for (const [index, file] of earlierPaths.entries()) {
        const original = before[index];
        if (original === undefined) throw new Error('missing original install evidence');
        const after = statSync(file);
        expect(readFileSync(file)).toEqual(original.body);
        expect(after.ino).toBe(original.metadata.ino);
        expect(after.mtimeMs).toBe(original.metadata.mtimeMs);
        expect(after.mode).toBe(original.metadata.mode);
      }
      expect(readdirSync(releaseDirectory).sort()).toEqual(directoryBefore);
      expect(readFileSync(sentinel, 'utf8')).toBe('external bytes');
      if (targetKind === 'symlink') expect(realpathSync(rejectedTarget)).toBe(sentinel);
      else expect(readdirSync(rejectedTarget)).toEqual([]);
    }
  });

  test('validates a later install ancestor before writing an earlier canonical target', async () => {
    const fixture = await createFixture();
    const earlier = writeExecutable(
      path.join(fixture.root, INSTALL_PATHS.dataplane[0]),
      'old dataplane',
    );
    const before = statSync(earlier);
    const external = temporaryDirectory('edge-harness-native-dist-untouched-');
    mkdirSync(path.join(fixture.root, 'apps/daemon'), { recursive: true });
    symlinkSync(external, path.join(fixture.root, 'apps/daemon/dist'));
    let buildCalls = 0;
    await expect(
      provisionEdgeHarnessNativeArtifacts(fixture.root, fixture.manifestPath, async () => {
        buildCalls += 1;
      }),
    ).rejects.toThrow('native artifact directory is not canonical');
    expect(buildCalls).toBe(0);
    expect(readFileSync(earlier, 'utf8')).toBe('old dataplane');
    expect(statSync(earlier).ino).toBe(before.ino);
    expect(statSync(earlier).mtimeMs).toBe(before.mtimeMs);
    expect(readdirSync(external)).toEqual([]);
    expect(existsSync(path.join(fixture.root, INSTALL_PATHS.edge[0]))).toBe(false);
    expect(existsSync(path.join(fixture.root, INSTALL_PATHS.proxy[0]))).toBe(false);
  });

  test('round-trips mixed-case native paths in deterministic code-unit order', async () => {
    const fixture = await createFixture();
    const sourcePaths = [
      'apps/daemon/dataplane/src/Zebra.rs',
      'apps/daemon/dataplane/src/alpha.rs',
      'apps/daemon/dataplane/src/nested/A.rs',
    ];
    for (const relative of [...sourcePaths].reverse()) {
      const file = path.join(fixture.root, relative);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, '// fixture source\n');
    }
    await git(fixture.root, 'add', ...sourcePaths);
    await git(fixture.root, 'commit', '--quiet', '-m', 'mixed-case source');
    const manifest = await createEdgeHarnessNativeArtifactManifest(
      fixture.root,
      fixture.artifactPaths,
    );
    expect(manifest.source.entries.map((entry) => entry.path)).toEqual([
      'Cargo.toml',
      ...sourcePaths,
    ]);
    writeFileSync(fixture.manifestPath, `${JSON.stringify(manifest)}\n`);
    let buildCalls = 0;
    const installed = await provisionEdgeHarnessNativeArtifacts(
      fixture.root,
      fixture.manifestPath,
      async () => {
        buildCalls += 1;
      },
    );
    expect(buildCalls).toBe(0);
    expect(installed.mode).toBe('verified-prebuilt');
    if (installed.mode !== 'verified-prebuilt') throw new Error('wrong provenance mode');
    expect(installed.sourceClosureSha256).toBe(manifest.source.sha256);
    expect(
      collectNativeBuildEnvironmentOverrides({
        CARGO_PROFILE_alpha: 'lower',
        CARGO_PROFILE_Zebra: 'upper',
      }).map((entry) => entry.name),
    ).toEqual(['CARGO_PROFILE_Zebra', 'CARGO_PROFILE_alpha']);
  });

  test('rejects symlinked build-output ancestors before the caller can start a build', () => {
    for (const relative of ['target', 'target/rust', 'target/rust/release']) {
      const root = temporaryDirectory('edge-harness-native-build-chain-');
      const external = temporaryDirectory('edge-harness-native-build-external-');
      const unsafe = path.join(root, relative);
      mkdirSync(path.dirname(unsafe), { recursive: true });
      symlinkSync(external, unsafe);
      let buildCalls = 0;
      const prepare = (): void => {
        ensureCanonicalNativeBuildOutputDirectory(root);
        buildCalls += 1;
      };
      expect(prepare).toThrow('native artifact directory is not canonical');
      expect(buildCalls).toBe(0);
      expect(readdirSync(external)).toEqual([]);
      expect(realpathSync(unsafe)).toBe(external);
    }
  });

  test('validates final native build artifacts without following aliases or changing outputs', () => {
    for (const name of [
      'merkur-dataplane',
      'merkur-image-worker',
      'merkur-edge',
      'delay_proxy',
    ] as const) {
      for (const invalidKind of ['symlink', 'directory'] as const) {
        const root = temporaryDirectory('edge-harness-native-build-artifact-');
        const outputDirectory = ensureCanonicalNativeBuildOutputDirectory(root);
        const neighbor = writeExecutable(
          path.join(outputDirectory, 'untouched-neighbor'),
          'neighbor',
        );
        const neighborBefore = statSync(neighbor);
        const external = temporaryDirectory('edge-harness-native-build-artifact-external-');
        const original = writeExecutable(path.join(external, 'original'), 'same artifact bytes');
        const output = path.join(outputDirectory, name);
        if (invalidKind === 'symlink') symlinkSync(original, output);
        else mkdirSync(output);
        const directoryBefore = readdirSync(outputDirectory).sort();
        expect(() => validateCanonicalNativeBuildArtifact(root, name)).toThrow();
        expect(readdirSync(outputDirectory).sort()).toEqual(directoryBefore);
        expect(statSync(neighbor).ino).toBe(neighborBefore.ino);
        expect(statSync(neighbor).mtimeMs).toBe(neighborBefore.mtimeMs);
        expect(readFileSync(neighbor, 'utf8')).toBe('neighbor');
        expect(readFileSync(original, 'utf8')).toBe('same artifact bytes');
      }
      const root = temporaryDirectory('edge-harness-native-build-artifact-valid-');
      const valid = writeExecutable(
        path.join(ensureCanonicalNativeBuildOutputDirectory(root), name),
        'artifact',
      );
      const before = statSync(valid);
      expect(validateCanonicalNativeBuildArtifact(root, name)).toBe(valid);
      expect(statSync(valid).ino).toBe(before.ino);
      expect(statSync(valid).mtimeMs).toBe(before.mtimeMs);
      expect(readFileSync(valid, 'utf8')).toBe('artifact');
      const cargoDependency = path.join(path.dirname(valid), 'deps', name);
      mkdirSync(path.dirname(cargoDependency));
      linkSync(valid, cargoDependency);
      expect(validateCanonicalNativeBuildArtifact(root, name)).toBe(valid);
      expect(statSync(valid).nlink).toBe(2);
    }
  });

  test('replaces Cargo hardlinks without mutating their deps inode and rejects retained aliases', async () => {
    const fixture = await createFixture();
    const output = path.join(fixture.root, INSTALL_PATHS.dataplane[0]);
    const dependency = writeExecutable(path.join(path.dirname(output), 'deps', 'dataplane'), 'old');
    linkSync(dependency, output);
    const provenance = await provisionEdgeHarnessNativeArtifacts(
      fixture.root,
      fixture.manifestPath,
      async () => {
        throw new Error('unexpected build');
      },
    );
    verifyProvisionedNativeArtifacts(provenance);
    expect(readFileSync(dependency, 'utf8')).toBe('old');
    expect(statSync(output).nlink).toBe(1);
    expect(readFileSync(output)).toEqual(readFileSync(fixture.artifactPaths.dataplane));
    const aliased = await createFixture();
    linkSync(aliased.artifactPaths.dataplane, `${aliased.artifactPaths.dataplane}-alias`);
    await expectRejectedWithoutBuild(aliased, 'singly linked regular file');
  });

  test('keeps the ordinary harness build path when no manifest is supplied', async () => {
    const root = temporaryDirectory('edge-harness-native-build-');
    let buildCalls = 0;
    const provenance = await provisionEdgeHarnessNativeArtifacts(root, undefined, async () => {
      buildCalls += 1;
      writeExecutable(path.join(root, 'target/rust/release/merkur-dataplane'), 'dataplane');
      writeExecutable(path.join(root, 'apps/daemon/dist/merkur-dataplane'), 'dataplane');
      writeExecutable(path.join(root, 'target/rust/release/merkur-image-worker'), 'imageWorker');
      writeExecutable(path.join(root, 'apps/daemon/dist/merkur-image-worker'), 'imageWorker');
      writeExecutable(path.join(root, 'target/rust/release/merkur-edge'), 'edge');
      writeExecutable(path.join(root, 'target/rust/release/delay_proxy'), 'proxy');
      writeExecutable(path.join(root, 'target/rust/release/merkur-tui'), 'tui');
      mkdirSync(path.join(root, 'target/rust/release/deps'));
      linkSync(
        path.join(root, INSTALL_PATHS.dataplane[0]),
        path.join(root, 'target/rust/release/deps/merkur-dataplane'),
      );
    });

    expect(buildCalls).toBe(1);
    verifyProvisionedNativeArtifacts(provenance);
    expect(provenance).toMatchObject({
      mode: 'built-in-worktree',
      buildCommands: EDGE_HARNESS_NATIVE_BUILD_COMMANDS,
      artifacts: {
        dataplane: {
          byteLength: 9,
          installedPaths: INSTALL_PATHS.dataplane.map((relative) => path.join(root, relative)),
        },
        imageWorker: { byteLength: 11 },
        edge: { byteLength: 4 },
        proxy: { byteLength: 5 },
      },
    });
    for (const relative of INSTALL_PATHS.dataplane) {
      expect(readFileSync(path.join(root, relative), 'utf8')).toBe('dataplane');
    }
  });

  test('propagates the absent-manifest build failure without retrying or reporting provenance', async () => {
    const root = temporaryDirectory('edge-harness-native-build-failure-');
    let buildCalls = 0;
    await expect(
      provisionEdgeHarnessNativeArtifacts(root, undefined, async () => {
        buildCalls += 1;
        throw new Error('intentional build failure');
      }),
    ).rejects.toThrow('intentional build failure');
    expect(buildCalls).toBe(1);
  });
});

const INSTALL_PATHS = {
  dataplane: ['target/rust/release/merkur-dataplane', 'apps/daemon/dist/merkur-dataplane'],
  imageWorker: ['target/rust/release/merkur-image-worker', 'apps/daemon/dist/merkur-image-worker'],
  edge: ['target/rust/release/merkur-edge'],
  proxy: ['target/rust/release/delay_proxy'],
  tui: ['target/rust/release/merkur-tui'],
} as const;

async function expectRejectedWithoutBuild(
  fixture: { readonly root: string; readonly manifestPath: string },
  message?: string,
): Promise<void> {
  let buildCalls = 0;
  await expect(
    provisionEdgeHarnessNativeArtifacts(fixture.root, fixture.manifestPath, async () => {
      buildCalls += 1;
    }),
  ).rejects.toThrow(message);
  expect(buildCalls).toBe(0);
  for (const relativePaths of Object.values(INSTALL_PATHS)) {
    for (const relativePath of relativePaths) {
      expect(existsSync(path.join(fixture.root, relativePath))).toBe(false);
    }
  }
}

async function createFixture(): Promise<{
  readonly root: string;
  readonly manifestPath: string;
  readonly artifactPaths: Readonly<Record<keyof typeof INSTALL_PATHS, string>>;
}> {
  const root = temporaryDirectory('edge-harness-native-root-');
  cpSync(await committedRepository(), root, { recursive: true });

  const artifacts = temporaryDirectory('edge-harness-native-artifacts-');
  const artifactPaths = {
    dataplane: writeExecutable(path.join(artifacts, 'merkur-dataplane'), 'dataplane'),
    imageWorker: writeExecutable(path.join(artifacts, 'merkur-image-worker'), 'imageWorker'),
    edge: writeExecutable(path.join(artifacts, 'merkur-edge'), 'edge'),
    proxy: writeExecutable(path.join(artifacts, 'delay_proxy'), 'proxy'),
    tui: writeExecutable(path.join(artifacts, 'merkur-tui'), 'tui'),
  };
  const manifest = await createEdgeHarnessNativeArtifactManifest(root, artifactPaths);
  const manifestPath = path.join(artifacts, 'native-artifact-manifest.json');
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { root, manifestPath: realpathSync(manifestPath), artifactPaths };
}

let repositoryTemplate: Promise<string> | undefined;
afterAll(async () => {
  if (repositoryTemplate !== undefined)
    rmSync(await repositoryTemplate, { recursive: true, force: true });
});

/**
 * The fixture's committed workspace, made once per file. Each fixture copies it rather than
 * running five Git processes of its own; every copy is the same one-commit repository.
 */
function committedRepository(): Promise<string> {
  repositoryTemplate ??= (async () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'edge-harness-native-template-')));
    writeFileSync(path.join(root, 'Cargo.toml'), '[workspace]\nmembers=[]\n');
    await git(root, 'init', '--quiet');
    await git(root, 'config', 'user.email', 'native-preflight@example.invalid');
    await git(root, 'config', 'user.name', 'Native Preflight Test');
    await git(root, 'add', 'Cargo.toml');
    await git(root, 'commit', '--quiet', '-m', 'fixture');
    return root;
  })();
  return repositoryTemplate;
}

async function git(cwd: string, ...args: string[]): Promise<void> {
  const result = await runTestProcess(['git', ...args], { cwd });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
}

function writeExecutable(file: string, body: string): string {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, body, { mode: 0o755 });
  chmodSync(file, 0o755);
  return realpathSync(file);
}

function temporaryDirectory(prefix: string): string {
  const directory = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
  temporaryDirectories.push(directory);
  return directory;
}

function mutateManifest(
  manifestPath: string,
  mutate: (manifest: Record<string, unknown>) => void,
): void {
  const manifest = requiredRecord(JSON.parse(readFileSync(manifestPath, 'utf8')));
  mutate(manifest);
  writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
}

function requiredRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('fixture manifest field is not an object');
  }
  return value as Record<string, unknown>;
}
