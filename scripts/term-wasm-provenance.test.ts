import { describe, expect, test } from 'bun:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { synchronizeTermWasmArtifactSet } from './sync-term-wasm';
import {
  assertRepositoryTermWasmArtifactsCurrent,
  calculateTermWasmSourceSha256,
  hasExactTermWasmArtifactSet,
  TERM_WASM_ARTIFACT_FILES,
  TERM_WASM_BAZEL_PIPELINE_INPUTS,
  TERM_WASM_BUILD_MANIFEST,
  TERM_WASM_PACKAGE_FILES,
  termWasmArtifactSetsEqual,
  termWasmArtifactsMatchSource,
  writeTermWasmBuildManifest,
} from './term-wasm-provenance';

describe('terminal WASM provenance', () => {
  test('requires the exact generated package without missing or surplus files', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'merkur-wasm-artifacts-'));
    try {
      await writeArtifactSet(directory);
      expect(await hasExactTermWasmArtifactSet(directory)).toBe(true);

      for (const file of TERM_WASM_PACKAGE_FILES) {
        await fs.rm(path.join(directory, file));
        expect(await hasExactTermWasmArtifactSet(directory)).toBe(false);
        await fs.writeFile(path.join(directory, file), file);
      }

      await fs.writeFile(path.join(directory, 'obsolete-binding.js'), 'stale');
      expect(await hasExactTermWasmArtifactSet(directory)).toBe(false);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  test('source provenance includes build logic and every local Rust dependency', async () => {
    const repoRoot = await createSourceFixture();
    try {
      const baseline = await calculateTermWasmSourceSha256(repoRoot);
      const inputs = [
        ...TERM_WASM_BAZEL_PIPELINE_INPUTS,
        'scripts/build-term-wasm.ts',
        'scripts/sync-term-wasm.ts',
        'scripts/term-wasm-current-glue.ts',
        'scripts/term-wasm-provenance.ts',
        'scripts/term-wasm-pgo.ts',
        'scripts/term-wasm-ingress-fixture.ts',
        'scripts/wasm-toolchain.ts',
        'packages/term-wasm-pgo/src/lib.rs',
        'packages/term-wasm/src/pgo_training.rs',
        'packages/zstd-fixture/src/lib.rs',
        'packages/term-wasm/.cargo/config.toml',
        'packages/term-wasm/src/lib.rs',
        'packages/merkur-codec/src/lib.rs',
        'packages/merkur-fec/src/lib.rs',
        'packages/alacritty-terminal-patch/src/lib.rs',
        'packages/vte-patch/Cargo.toml',
        'packages/vte-patch/src/lib.rs',
        'Cargo.toml',
      ];

      // A comment keeps the TOML inputs parseable while still changing their bytes.
      for (const input of inputs) {
        const inputPath = path.join(repoRoot, input);
        const original = await fs.readFile(inputPath);
        await fs.appendFile(inputPath, '\n# changed');
        expect(await calculateTermWasmSourceSha256(repoRoot)).not.toBe(baseline);
        await fs.writeFile(inputPath, original);
      }
    } finally {
      await fs.rm(repoRoot, { recursive: true, force: true });
    }
  });

  test('tracks the resolved dependency closure rather than the whole lockfile', async () => {
    const repoRoot = await createSourceFixture();
    const lockfile = path.join(repoRoot, 'Cargo.lock');
    try {
      const baseline = await calculateTermWasmSourceSha256(repoRoot);

      // `quinn` is locked but nothing the WASM build compiles reaches it.
      await fs.writeFile(lockfile, FIXTURE_LOCKFILE.replace('3'.repeat(64), '9'.repeat(64)));
      expect(await calculateTermWasmSourceSha256(repoRoot)).toBe(baseline);

      // `memchr` is in the closure, through the patched VTE.
      await fs.writeFile(lockfile, FIXTURE_LOCKFILE.replace('2'.repeat(64), '9'.repeat(64)));
      expect(await calculateTermWasmSourceSha256(repoRoot)).not.toBe(baseline);

      // `minicov` is reached only through the active Cargo PGO training driver.
      await fs.writeFile(lockfile, FIXTURE_LOCKFILE.replace('4'.repeat(64), '9'.repeat(64)));
      expect(await calculateTermWasmSourceSha256(repoRoot)).not.toBe(baseline);

      // The vendored VTE is compiled from source, so its sources must be hashed.
      await fs.writeFile(lockfile, FIXTURE_LOCKFILE);
      await fs.appendFile(path.join(repoRoot, 'packages/vte-patch/src/lib.rs'), '\nchanged');
      expect(await calculateTermWasmSourceSha256(repoRoot)).not.toBe(baseline);
    } finally {
      await fs.rm(repoRoot, { recursive: true, force: true });
    }
  });

  test('rejects partial, mutated, stale-schema, and stale-source artifact sets', async () => {
    const repoRoot = await createSourceFixture();
    const artifacts = path.join(repoRoot, 'artifacts');
    try {
      await writeRuntimeArtifacts(artifacts);
      await writeTermWasmBuildManifest(repoRoot, artifacts);
      expect(await termWasmArtifactsMatchSource(repoRoot, artifacts)).toBe(true);

      await fs.appendFile(path.join(artifacts, 'term_wasm.d.ts'), '\nmutated');
      expect(await termWasmArtifactsMatchSource(repoRoot, artifacts)).toBe(false);

      await writeRuntimeArtifacts(artifacts);
      await writeTermWasmBuildManifest(repoRoot, artifacts);
      await fs.appendFile(path.join(repoRoot, 'packages/merkur-codec/src/lib.rs'), '\nchanged');
      expect(await termWasmArtifactsMatchSource(repoRoot, artifacts)).toBe(false);

      await fs.writeFile(
        path.join(artifacts, TERM_WASM_BUILD_MANIFEST),
        JSON.stringify({ schemaVersion: 2, sourceSha256: '0'.repeat(64) }),
      );
      expect(await termWasmArtifactsMatchSource(repoRoot, artifacts)).toBe(false);
    } finally {
      await fs.rm(repoRoot, { recursive: true, force: true });
    }
  });

  test('compares the complete synchronized artifact set byte-for-byte', async () => {
    const left = await fs.mkdtemp(path.join(os.tmpdir(), 'merkur-wasm-left-'));
    const right = await fs.mkdtemp(path.join(os.tmpdir(), 'merkur-wasm-right-'));
    try {
      await Promise.all([writeArtifactSet(left), writeArtifactSet(right)]);
      expect(await termWasmArtifactSetsEqual(left, right)).toBe(true);

      await fs.appendFile(path.join(right, 'term_wasm_bg.wasm.d.ts'), '\nchanged');
      expect(await termWasmArtifactSetsEqual(left, right)).toBe(false);

      await writeArtifactSet(right);
      await fs.writeFile(path.join(right, 'obsolete-binding.js'), 'stale');
      expect(await termWasmArtifactSetsEqual(left, right)).toBe(false);
    } finally {
      await Promise.all([
        fs.rm(left, { recursive: true, force: true }),
        fs.rm(right, { recursive: true, force: true }),
      ]);
    }
  });

  test('synchronization replaces the target and removes obsolete generated files', async () => {
    const source = await fs.mkdtemp(path.join(os.tmpdir(), 'merkur-wasm-source-artifacts-'));
    const target = await fs.mkdtemp(path.join(os.tmpdir(), 'merkur-wasm-target-artifacts-'));
    try {
      await Promise.all([writeArtifactSet(source), writeArtifactSet(target)]);
      await fs.writeFile(path.join(target, 'obsolete-binding.js'), 'stale');

      expect(await synchronizeTermWasmArtifactSet(source, target)).toBe(true);
      expect(await fs.readdir(target).then((files) => files.sort())).toEqual(
        [...TERM_WASM_PACKAGE_FILES].sort(),
      );
      expect(await termWasmArtifactSetsEqual(source, target)).toBe(true);
      expect(await synchronizeTermWasmArtifactSet(source, target)).toBe(false);
    } finally {
      await Promise.all([
        fs.rm(source, { recursive: true, force: true }),
        fs.rm(target, { recursive: true, force: true }),
      ]);
    }
  });

  test('validates present repository artifacts and permits an artifact-free clean checkout', async () => {
    const repoRoot = await createSourceFixture();
    const source = path.join(repoRoot, 'packages/term-wasm/pkg');
    const deployed = path.join(repoRoot, 'apps/web/src/term-wasm/pkg');
    try {
      await expect(assertRepositoryTermWasmArtifactsCurrent(repoRoot)).resolves.toBeUndefined();

      await writeRuntimeArtifacts(source);
      await writeTermWasmBuildManifest(repoRoot, source);
      await fs.mkdir(path.dirname(deployed), { recursive: true });
      await fs.cp(source, deployed, { recursive: true });
      await expect(assertRepositoryTermWasmArtifactsCurrent(repoRoot)).resolves.toBeUndefined();

      await fs.appendFile(path.join(deployed, 'term_wasm_bg.wasm'), 'stale');
      await expect(assertRepositoryTermWasmArtifactsCurrent(repoRoot)).rejects.toThrow(
        'deployed web artifacts do not match the current Rust/build inputs',
      );

      await fs.rm(deployed, { recursive: true, force: true });
      await expect(assertRepositoryTermWasmArtifactsCurrent(repoRoot)).rejects.toThrow(
        'deployed web artifact tree is missing',
      );
    } finally {
      await fs.rm(repoRoot, { recursive: true, force: true });
    }
  });
});

/** Directory to crate name, mirroring the real workspace's patched-crate renames. */
const FIXTURE_CRATES: readonly (readonly [string, string])[] = [
  ['packages/term-wasm', 'term-wasm'],
  ['packages/term-wasm-pgo', 'term-wasm-pgo'],
  ['packages/zstd-fixture', 'zstd-fixture'],
  ['packages/merkur-codec', 'merkur-codec'],
  ['packages/merkur-fec', 'merkur-fec'],
  ['packages/alacritty-terminal-patch', 'alacritty_terminal'],
  ['packages/vte-patch', 'vte'],
  ['apps/daemon/dataplane', 'merkur-dataplane'],
];

const FIXTURE_ROOT_MANIFEST = `[workspace]
resolver = "3"
members = [${FIXTURE_CRATES.map(([directory]) => `"${directory}"`).join(', ')}]

[patch.crates-io]
alacritty_terminal = { path = "packages/alacritty-terminal-patch" }
vte = { path = "packages/vte-patch" }
`;

/**
 * `term-wasm` reaches `vte` only through the patched `alacritty_terminal`, and
 * `merkur-dataplane` reaches `quinn` outside that closure entirely. The PGO
 * Cargo training driver and fixture compressor are closure roots of their own.
 * Bazel training hooks share the terminal crate.
 */
const FIXTURE_LOCKFILE = `[[package]]
name = "term-wasm"
version = "0.1.0"
dependencies = ["alacritty_terminal", "merkur-codec", "merkur-fec", "unicode-width"]

[[package]]
name = "term-wasm-pgo"
version = "0.1.0"
dependencies = ["minicov", "term-wasm"]

[[package]]
name = "zstd-fixture"
version = "0.1.0"
dependencies = ["merkur-codec", "zstd"]

[[package]]
name = "minicov"
version = "0.3.8"
source = "registry+https://github.com/rust-lang/crates.io-index"
checksum = "${'4'.repeat(64)}"

[[package]]
name = "zstd"
version = "0.13.3"
source = "registry+https://github.com/rust-lang/crates.io-index"
checksum = "${'5'.repeat(64)}"

[[package]]
name = "alacritty_terminal"
version = "0.26.0"
dependencies = ["vte"]

[[package]]
name = "vte"
version = "0.15.0"
dependencies = ["memchr"]

[[package]]
name = "merkur-codec"
version = "0.1.0"

[[package]]
name = "merkur-fec"
version = "0.1.0"

[[package]]
name = "merkur-dataplane"
version = "0.1.0"
dependencies = ["quinn"]

[[package]]
name = "unicode-width"
version = "0.2.2"
source = "registry+https://github.com/rust-lang/crates.io-index"
checksum = "${'1'.repeat(64)}"

[[package]]
name = "memchr"
version = "2.7.4"
source = "registry+https://github.com/rust-lang/crates.io-index"
checksum = "${'2'.repeat(64)}"

[[package]]
name = "quinn"
version = "0.11.9"
source = "registry+https://github.com/rust-lang/crates.io-index"
checksum = "${'3'.repeat(64)}"
`;

async function createSourceFixture(): Promise<string> {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'merkur-wasm-source-'));
  const files: (readonly [string, string])[] = [
    ...TERM_WASM_BAZEL_PIPELINE_INPUTS.map((file): readonly [string, string] => [file, file]),
    ['Cargo.lock', FIXTURE_LOCKFILE],
    ['Cargo.toml', FIXTURE_ROOT_MANIFEST],
    ['rust-toolchain.toml', 'rust-toolchain.toml'],
    ['scripts/build-term-wasm.ts', 'scripts/build-term-wasm.ts'],
    ['scripts/sync-term-wasm.ts', 'scripts/sync-term-wasm.ts'],
    ['scripts/term-wasm-current-glue.ts', 'scripts/term-wasm-current-glue.ts'],
    ['scripts/term-wasm-provenance.ts', 'scripts/term-wasm-provenance.ts'],
    ['scripts/term-wasm-pgo.ts', 'scripts/term-wasm-pgo.ts'],
    ['scripts/term-wasm-ingress-fixture.ts', 'scripts/term-wasm-ingress-fixture.ts'],
    ['scripts/wasm-toolchain.ts', 'scripts/wasm-toolchain.ts'],
    ['packages/term-wasm/.cargo/config.toml', 'packages/term-wasm/.cargo/config.toml'],
    ['packages/term-wasm/src/pgo_training.rs', 'same-crate training hooks'],
    ...FIXTURE_CRATES.flatMap(([directory, crate]): (readonly [string, string])[] => [
      [`${directory}/Cargo.toml`, `[package]\nname = "${crate}"\nversion = "0.1.0"\n`],
      [`${directory}/src/lib.rs`, `${directory}/src/lib.rs`],
    ]),
  ];
  await Promise.all(
    files.map(async ([file, contents]) => {
      const filePath = path.join(repoRoot, file);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, contents);
    }),
  );
  return repoRoot;
}

async function writeRuntimeArtifacts(directory: string): Promise<void> {
  await fs.mkdir(directory, { recursive: true });
  await Promise.all([
    ...TERM_WASM_ARTIFACT_FILES.filter(
      (file) => file !== 'term_wasm.js' && file !== 'term_wasm.d.ts',
    ).map((file) => fs.writeFile(path.join(directory, file), file)),
    fs.writeFile(
      path.join(directory, 'term_wasm.js'),
      [
        "throw new TypeError('initSync requires exactly { module }')",
        "throw new TypeError('WASM initialization requires exactly { module_or_path }')",
      ].join('\n'),
    ),
    fs.writeFile(
      path.join(directory, 'term_wasm.d.ts'),
      [
        'export function initSync(module: { module: SyncInitInput }): InitOutput;',
        'export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> }): Promise<InitOutput>;',
      ].join('\n'),
    ),
    fs.writeFile(path.join(directory, '.gitignore'), '\n'),
  ]);
}

async function writeArtifactSet(directory: string): Promise<void> {
  await fs.mkdir(directory, { recursive: true });
  await Promise.all(
    TERM_WASM_PACKAGE_FILES.map((file) => fs.writeFile(path.join(directory, file), file)),
  );
}
