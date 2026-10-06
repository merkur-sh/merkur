import { createHash } from 'node:crypto';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { TOML } from 'bun';

type Json = Record<string, unknown>;
function record(value: unknown): Json {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Expected an object in the declared acquisition contract');
  }
  return value as Json;
}
function text(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error('Expected nonempty text');
  return value;
}
function entries(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error('Expected an acquisition array');
  return value;
}
function hash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(record(value))
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)]),
    );
  }
  return value;
}
function relative(root: string, member: string): string {
  const result = path.relative(root, member);
  if (result === '..' || result.startsWith('../') || path.isAbsolute(result)) {
    throw new Error('Cargo source escaped the declared snapshot');
  }
  return result;
}

const descriptorPath = process.argv[2];
const outputPath = process.argv[3];
if (!descriptorPath || !outputPath || process.argv.length !== 4) {
  throw new Error('Expected acquisition descriptor and receipt File paths');
}
const descriptor = record(JSON.parse(readFileSync(descriptorPath, 'utf8')));
const host = text(descriptor.execution_host);
const mode = text(descriptor.mode);
if (mode !== 'build' && mode !== 'test') throw new Error('Unknown native acquisition mode');
const arch = host === 'x86_64-unknown-linux-gnu' ? 'x64' : 'arm64';
if (
  !['x86_64-unknown-linux-gnu', 'aarch64-unknown-linux-gnu'].includes(host) ||
  process.platform !== 'linux' ||
  process.arch !== arch ||
  Bun.version !== '1.4.2'
) {
  throw new Error('Acquisition did not execute on its pinned native Linux/Bun host');
}
const sources = record(descriptor.sources);
const root = mkdtempSync(path.join(tmpdir(), 'merkur-cargo-host-'));
const snapshot = path.join(root, 'snapshot');
const cargoHome = path.join(root, 'cargo-home');
mkdirSync(snapshot);
mkdirSync(cargoHome);
function noAncestorConfiguration(): string[] {
  const absent: string[] = [];
  for (let current = root; ; current = path.dirname(current)) {
    for (const name of ['config', 'config.toml']) {
      const candidate = path.join(current, '.cargo', name);
      try {
        lstatSync(candidate);
      } catch (error) {
        if (
          typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          error.code === 'ENOENT'
        ) {
          absent.push(candidate);
          continue;
        }
        throw error;
      }
      throw new Error(
        'Undeclared ancestor Cargo configuration would contaminate the physical snapshot',
      );
    }
    if (current === path.dirname(current)) break;
  }
  return absent;
}
const facts: { path: string; sha256: string; size: number }[] = [];
try {
  for (const [member, input] of Object.entries(sources).sort(([a], [b]) => a.localeCompare(b))) {
    if (path.isAbsolute(member) || member.split('/').some((part) => part === '..' || part === '')) {
      throw new Error('Invalid source snapshot member');
    }
    const bytes = readFileSync(text(input));
    const destination = path.join(snapshot, member);
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(destination, bytes, { flag: 'wx', mode: 0o444 });
    facts.push({ path: member, sha256: hash(bytes), size: bytes.length });
  }
  // Cargo may create its private target/cache directory, but source bytes are read-only.
  const cargo = path.resolve(text(descriptor.cargo));
  const rustc = path.resolve(text(descriptor.rustc));
  const env = {
    PATH: '',
    HOME: root,
    CARGO_HOME: cargoHome,
    RUSTC: rustc,
    CARGO_TARGET_DIR: path.join(root, 'target'),
    RUSTC_BOOTSTRAP: '1',
    CARGO_NET_OFFLINE: 'true',
    LANG: 'C',
    LC_ALL: 'C',
  };
  function run(executable: string, args: string[]): string {
    noAncestorConfiguration();
    const result = Bun.spawnSync([executable, ...args], {
      cwd: snapshot,
      env,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    if (result.exitCode !== 0) {
      throw new Error(`Declared Cargo introspection failed: ${result.stderr.toString()}`);
    }
    noAncestorConfiguration();
    return result.stdout.toString();
  }
  const cargoIdentity = run(cargo, ['--version']).trim();
  const rustcIdentity = run(rustc, ['-vV']).trim();
  if (
    !cargoIdentity.startsWith('cargo 1.97.1 ') ||
    !rustcIdentity.startsWith('rustc 1.97.1 ') ||
    !rustcIdentity.split('\n').includes(`host: ${host}`)
  ) {
    throw new Error('Actual native Cargo/rustc host identity differs from the action contract');
  }
  const sdkFacts = entries(descriptor.sdk).map((member) => {
    const name = text(member);
    const bytes = readFileSync(name);
    return { path: name, size: bytes.length, sha256: hash(bytes) };
  });
  const manifest = path.join(snapshot, text(descriptor.manifest));
  const original = text(descriptor.original_manifest);
  const context = record(
    JSON.parse(readFileSync(path.join(path.dirname(manifest), 'metadata.json'), 'utf8')),
  );
  if (context.package !== 'merkur-fec' || context.mode !== mode || context.platform !== 'native') {
    throw new Error('The declared scoped-manifest authority has another root identity');
  }
  const contextInputs = record(context.inputs);
  const requiredInputs = [
    '.cargo/config.toml',
    'Cargo.lock',
    'Cargo.toml',
    original,
    'rust-toolchain.toml',
    'tools/bazel/rust/acquisition_sdk.py',
    'tools/bazel/rust/contexts.py',
    'tools/bazel/rust/metadata.json',
  ];
  if (
    JSON.stringify(Object.keys(contextInputs).sort()) !== JSON.stringify(requiredInputs.sort()) ||
    JSON.stringify(Object.keys(record(context.generated_inputs)).sort()) !==
      JSON.stringify(['Cargo.lock', 'Cargo.toml'])
  ) {
    throw new Error('Scoped-manifest freshness authority has incomplete membership');
  }
  for (const [member, expected] of Object.entries(contextInputs)) {
    if (!Object.hasOwn(sources, member))
      throw new Error('Freshness input is outside the declared snapshot');
    if (hash(readFileSync(path.join(snapshot, member))) !== text(expected)) {
      throw new Error(`Stale scoped-manifest source authority: ${member}`);
    }
  }
  for (const [member, expected] of Object.entries(record(context.generated_inputs))) {
    if (
      !['Cargo.toml', 'Cargo.lock'].includes(member) ||
      hash(readFileSync(path.join(path.dirname(manifest), member))) !== text(expected)
    ) {
      throw new Error(`Changed declared scoped manifest or lock: ${member}`);
    }
  }
  const originalPackage = record(
    record(TOML.parse(readFileSync(path.join(snapshot, original), 'utf8'))).package,
  );
  const capturedManifest = record(record(TOML.parse(readFileSync(manifest, 'utf8'))).package);
  for (const key of ['name', 'version', 'edition', 'license']) {
    if (originalPackage[key] !== capturedManifest[key])
      throw new Error(`Scoped root changed ${key}`);
  }
  const raw = record(
    JSON.parse(
      run(cargo, [
        'metadata',
        '--offline',
        '--locked',
        '--format-version=1',
        '--manifest-path',
        manifest,
      ]),
    ),
  );
  const packages = entries(raw.packages).map(record);
  if (packages.length !== 1 || packages[0]?.name !== 'merkur-fec' || packages[0]?.source !== null) {
    throw new Error('The bounded FEC context unexpectedly acquired other dependencies');
  }
  const id = text(packages[0].id);
  const canonicalId = 'workspace:packages/merkur-fec';
  const normalizeGraph = (value: unknown): Json => {
    const graph = record(value);
    if (graph.version !== 1 || entries(graph.roots).length !== (mode === 'build' ? 1 : 4))
      throw new Error('Unexpected Cargo unit graph');
    for (const value of entries(graph.units)) {
      const unit = record(value);
      if (unit.pkg_id !== id) throw new Error('Unexpected unit source identity');
      unit.pkg_id = canonicalId;
      const target = record(unit.target);
      target.src_path = relative(snapshot, text(target.src_path));
      unit.rust_flags = [];
    }
    graph.execution_host = host;
    return graph;
  };
  const graphs: Json = {};
  for (const profile of mode === 'build' ? ['dev', 'release'] : ['test']) {
    const args = [
      mode,
      '--unit-graph',
      '-Z',
      'unstable-options',
      '--offline',
      '--locked',
      '--manifest-path',
      manifest,
    ];
    if (profile === 'release') args.push('--release');
    graphs[profile] = normalizeGraph(JSON.parse(run(cargo, args)));
  }
  const cfg = run(rustc, ['--print', 'cfg', '--target', host]).trim().split('\n').sort();
  const effectiveConfiguration = record(
    JSON.parse(
      run(cargo, ['-Z', 'unstable-options', 'config', 'get', 'target', '--format', 'json']),
    ),
  );
  const declaredConfiguration = record(
    TOML.parse(readFileSync(path.join(snapshot, '.cargo/config.toml'), 'utf8')),
  );
  if (
    JSON.stringify(canonical(effectiveConfiguration.target)) !==
    JSON.stringify(canonical(declaredConfiguration.target))
  ) {
    throw new Error(
      'Effective Cargo target configuration differs from the single declared root configuration',
    );
  }
  const targetConfiguration = record(effectiveConfiguration.target);
  function selectedFlags(name: 'rustflags' | 'rustdocflags'): string[] {
    const selected: string[] = [];
    // Cargo c980f4866 target_info.rs: literal triple first, then sorted cfg entries.
    if (Object.hasOwn(targetConfiguration, host)) {
      selected.push(...entries(record(targetConfiguration[host])[name] ?? []).map(text));
    }
    for (const [predicate, value] of Object.entries(targetConfiguration).sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      const atom =
        predicate.startsWith('cfg(') && predicate.endsWith(')')
          ? predicate.slice(4, -1).replaceAll(' ', '')
          : null;
      if (atom !== null && (atom.includes('(') || atom.includes(',')))
        throw new Error('Unmodeled Cargo target predicate');
      if (
        atom !== null &&
        ![
          'unix',
          'windows',
          'target_arch',
          'target_os',
          'target_env',
          'target_vendor',
          'target_family',
          'target_endian',
          'target_pointer_width',
          'target_abi',
        ].includes(atom.split('=')[0] ?? '')
      ) {
        throw new Error('Cargo target predicate needs flag-derived cfg resolution');
      }
      if (atom !== null && cfg.includes(atom)) {
        selected.push(...entries(record(value)[name] ?? []).map(text));
      }
    }
    if (selected.length === 0) {
      const build = declaredConfiguration.build;
      if (build !== undefined) selected.push(...entries(record(build)[name] ?? []).map(text));
    }
    return selected;
  }
  const flags = selectedFlags('rustflags');
  const docFlags = selectedFlags('rustdocflags');
  for (const graph of Object.values(graphs)) {
    for (const unit of entries(record(graph).units)) {
      const compilerUnit = record(unit);
      compilerUnit.rust_flags = compilerUnit.mode === 'doctest' ? docFlags : flags;
    }
  }
  const effectiveCfg: Record<string, string[]> = {};
  for (const [name, value] of Object.entries(graphs)) {
    const unit = record(entries(record(value).units)[0]);
    const profile = record(unit.profile);
    if (
      typeof profile.debug_assertions !== 'boolean' ||
      typeof profile.overflow_checks !== 'boolean'
    ) {
      throw new Error('Cargo compiler profile lacks its assertion/check controls');
    }
    effectiveCfg[name] = run(rustc, [
      '--print',
      'cfg',
      '--target',
      host,
      ...flags,
      '-C',
      `opt-level=${text(profile.opt_level)}`,
      '-C',
      `debug-assertions=${profile.debug_assertions ? 'yes' : 'no'}`,
      '-C',
      `overflow-checks=${profile.overflow_checks ? 'yes' : 'no'}`,
      '-C',
      `panic=${text(profile.panic)}`,
    ])
      .trim()
      .split('\n')
      .sort();
  }
  const normalizedPackage: Json = {};
  for (const key of [
    'name',
    'version',
    'source',
    'edition',
    'features',
    'links',
    'authors',
    'description',
    'homepage',
    'repository',
    'license',
    'rust_version',
  ]) {
    normalizedPackage[key] = packages[0][key];
  }
  normalizedPackage.id = canonicalId;
  normalizedPackage.manifest = original;
  normalizedPackage.targets = entries(packages[0].targets).map((value) => {
    const target = record(value);
    return {
      name: target.name,
      kind: target.kind,
      source: relative(snapshot, text(target.src_path)),
    };
  });
  for (const fact of facts) {
    if (
      hash(readFileSync(text(sources[fact.path]))) !== fact.sha256 ||
      hash(readFileSync(path.join(snapshot, fact.path))) !== fact.sha256
    ) {
      throw new Error('Declared or copied source bytes changed during acquisition');
    }
  }
  const receipt = {
    package: 'merkur-fec',
    mode,
    platform: 'native',
    execution_host: host,
    executor_image: descriptor.executor_image,
    cargo_identity: cargoIdentity,
    rustc_identity: rustcIdentity,
    native_runtime: { bun: Bun.version, os: process.platform, arch: process.arch },
    source_facts: facts,
    sdk_facts: sdkFacts,
    inputs: Object.fromEntries(facts.map((fact) => [fact.path, fact.sha256])),
    generated_inputs: Object.fromEntries(
      ['Cargo.toml', 'Cargo.lock'].map((name) => [
        name,
        hash(readFileSync(path.join(path.dirname(manifest), name))),
      ]),
    ),
    contexts: {
      [host]: { root: canonicalId, members: [canonicalId], packages: [normalizedPackage] },
    },
    unit_graphs: { [host]: graphs },
    resolution_cfg: cfg,
    effective_cfg: effectiveCfg,
    effective_configuration: effectiveConfiguration,
    configured_resolution_qualified: true,
    qualification_scope: `Only the captured dependency-free FEC native ${mode} roots on this actual execution host`,
  };
  writeFileSync(outputPath, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx', mode: 0o644 });
} finally {
  // These are exclusively this action's physical source and cache directories.
  chmodSync(snapshot, 0o700);
  rmSync(root, { recursive: true, force: true });
}
