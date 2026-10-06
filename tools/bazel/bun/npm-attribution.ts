import { createHash } from 'node:crypto';
import { readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { brotliDecompressSync } from 'node:zlib';
import {
  type CompilerArtifact,
  captureCompilerArtifactFacts,
  captureCompilerFileBytes,
  verifyCompilerArtifacts,
} from './compiler-inventory';
import { openOwnedDirectory } from './owned-files';
import { portablePath } from './portable-path';

interface PackageSource {
  readonly package: string;
  readonly version: string;
  readonly input: string;
  readonly source_label: string;
  readonly workspace: boolean;
}
interface Declaration {
  readonly input: string;
  readonly link: boolean;
  readonly owner: string;
  readonly canonical: string;
}
interface CompilerInput {
  readonly owner: string;
  readonly bytes: number;
  readonly sha256: string;
}
interface RegistrySource {
  readonly integrity: string;
  readonly tarball: string;
}
interface PhysicalSource {
  readonly source: PackageSource;
  readonly root: string;
}

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const canonicalLabel = (label: string): string =>
  label.startsWith('@@//') ? label.slice(2) : label;

export interface NpmCompilerBinding {
  readonly producer: string;
  readonly artifact: CompilerArtifact;
}

export function frontendContext(configuration: Record<string, unknown>): void {
  const fields = [
    'producer',
    'project',
    'frontend_build_id',
    'backend_origin',
    'opaque_public_key',
    'build_commit',
    'release_public_key',
    'public_release',
    'precompression',
    'compiler_tooling',
  ];
  const release = configuration.public_release;
  if (
    Object.keys(configuration).sort().join(',') !== fields.sort().join(',') ||
    configuration.project !== 'apps/web' ||
    configuration.precompression !== true ||
    typeof configuration.frontend_build_id !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
      configuration.frontend_build_id,
    ) ||
    ['backend_origin', 'opaque_public_key', 'build_commit', 'release_public_key'].some(
      (key) => typeof configuration[key] !== 'string',
    ) ||
    typeof release !== 'object' ||
    release === null ||
    Array.isArray(release) ||
    Object.keys(release).sort().join(',') !==
      'opaquePublicKey,origin,releasePublicKey,sequence,version' ||
    !('sequence' in release) ||
    typeof release.sequence !== 'number' ||
    !Number.isSafeInteger(release.sequence) ||
    release.sequence < 0 ||
    ['version', 'releasePublicKey', 'origin', 'opaquePublicKey'].some(
      (key) => !(key in release) || typeof (release as Record<string, unknown>)[key] !== 'string',
    )
  )
    throw new Error('Npm attribution requires the exact supported precompressed frontend context');
  compilerTooling(configuration.compiler_tooling);
}

function frontendInventory(value: Record<string, unknown>): Record<string, unknown> {
  if (
    Object.keys(value).sort().join(',') !==
      'artifacts,inputs,outputs,unmatched_generated_assets,unmatched_generated_modules' ||
    !Array.isArray(value.unmatched_generated_modules) ||
    !Array.isArray(value.unmatched_generated_assets)
  )
    throw new Error('Frontend npm attribution requires the original complete selection schema');
  if (value.unmatched_generated_modules.length || value.unmatched_generated_assets.length)
    throw new Error('Frontend npm attribution has unresolved generated source custody');
  return value;
}

function frontendMap(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('Frontend compiler selection has an invalid schema');
  return value as Record<string, unknown>;
}

function frontendRecord(value: unknown, required: string[], optional: string[] = []) {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    required.some((key) => !Object.hasOwn(value, key)) ||
    Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key))
  )
    throw new Error('Frontend compiler selection has an invalid schema');
  return value as Record<string, unknown>;
}

function frontendBytes(value: unknown): void {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new Error('Frontend compiler selection has invalid byte facts');
}

function frontendInputs(value: unknown): Record<string, unknown> {
  const inputs = frontendMap(value);
  if (!Object.keys(inputs).length)
    throw new Error('Frontend compiler must contain selected sources');
  for (const [name, input] of Object.entries(inputs)) {
    relative(name);
    const fields = frontendRecord(input, ['bytes', 'imports', 'owner', 'sha256']);
    frontendBytes(fields.bytes);
    if (
      typeof fields.owner !== 'string' ||
      fields.owner === '' ||
      typeof fields.sha256 !== 'string' ||
      !/^[0-9a-f]{64}$/.test(fields.sha256) ||
      !Array.isArray(fields.imports)
    )
      throw new Error('Frontend selected input has invalid original owner or digest');
    for (const item of fields.imports) {
      const imported = frontendRecord(item, ['path', 'kind']);
      if (
        typeof imported.path !== 'string' ||
        typeof imported.kind !== 'string' ||
        !['import-statement', 'dynamic-import'].includes(imported.kind) ||
        !Object.hasOwn(inputs, imported.path)
      )
        throw new Error('Frontend import has unresolved original source custody');
    }
  }
  return inputs;
}

function frontendOutput(value: unknown, inputs: Record<string, unknown>): Record<string, unknown> {
  const object = frontendRecord(
    value,
    ['bytes'],
    ['observations', 'public_input', 'compressed_from'],
  );
  frontendBytes(object.bytes);
  if (Object.hasOwn(object, 'observations') === Object.hasOwn(object, 'public_input'))
    throw new Error('Frontend output requires one genuine selection boundary');
  if (object.public_input !== undefined) {
    if (typeof object.public_input !== 'string' || !Object.hasOwn(inputs, object.public_input))
      throw new Error('Frontend public output has an unowned source');
  } else {
    if (!Array.isArray(object.observations) || object.observations.length === 0)
      throw new Error('Frontend output has no compiler observations');
    for (const value of object.observations) {
      const observation = frontendRecord(value, ['environment', 'type', 'selected']);
      if (
        typeof observation.environment !== 'string' ||
        !['client', 'worker'].includes(observation.environment) ||
        typeof observation.type !== 'string' ||
        !['chunk', 'asset'].includes(observation.type) ||
        !Array.isArray(observation.selected) ||
        observation.selected.length === 0
      )
        throw new Error('Frontend output has invalid compiler observations');
      for (const item of observation.selected) {
        const selected = frontendRecord(item, ['id', 'source']);
        if (
          typeof selected.id !== 'string' ||
          typeof selected.source !== 'string' ||
          !Object.hasOwn(inputs, selected.source)
        )
          throw new Error('Frontend output has unresolved original source custody');
      }
    }
  }
  return object;
}

export async function verifyFrontendArtifacts(
  value: Record<string, unknown>,
  artifact: CompilerArtifact,
) {
  if (artifact.kind !== 'bundle') throw new Error('Frontend requires its actual bundle artifact');
  const inventory = frontendInventory(value);
  const inputs = frontendInputs(inventory.inputs);
  const outputs = frontendMap(inventory.outputs);
  const facts = frontendMap(inventory.artifacts);
  const actual = await captureCompilerArtifactFacts(artifact, true);
  const names = Object.keys(actual).sort();
  if (
    !names.length ||
    JSON.stringify(names) !== JSON.stringify(Object.keys(outputs).sort()) ||
    JSON.stringify(names) !== JSON.stringify(Object.keys(facts).sort())
  )
    throw new Error('Frontend artifact membership differs from its inventory');
  for (const name of names) {
    relative(name);
    const fact = frontendRecord(facts[name], ['bytes', 'sha256']);
    frontendBytes(fact.bytes);
    const output = frontendOutput(outputs[name], inputs);
    if (
      fact.bytes !== actual[name]?.bytes ||
      fact.sha256 !== actual[name]?.sha256 ||
      output.bytes !== fact.bytes
    )
      throw new Error('Frontend emitted artifact differs from its inventory');
    if (name.endsWith('.br')) {
      const originalName = name.slice(0, -3);
      const original = frontendOutput(outputs[originalName], inputs);
      const { bytes: _bytes, compressed_from: compressed, ...selection } = output;
      const { bytes: _originalBytes, ...originalSelection } = original;
      if (
        compressed !== originalName ||
        Object.hasOwn(original, 'compressed_from') ||
        JSON.stringify(selection) !== JSON.stringify(originalSelection)
      )
        throw new Error('Frontend precompression differs from the original selected output');
      const compressedBytes = await pinnedRead(path.join(artifact.directory, name));
      const originalBytes = await pinnedRead(path.join(artifact.directory, originalName));
      if (!brotliDecompressSync(compressedBytes).equals(originalBytes))
        throw new Error('Frontend precompression differs from original output bytes');
    } else if (Object.hasOwn(output, 'compressed_from') || !Object.hasOwn(outputs, `${name}.br`))
      throw new Error('Frontend output has an incomplete precompression pair');
    if (output.public_input !== undefined && !name.endsWith('.br')) {
      const source = inputs[String(output.public_input)] as CompilerInput;
      if (source.bytes !== fact.bytes || source.sha256 !== fact.sha256)
        throw new Error('Frontend public output differs from original source bytes');
    }
  }
}

async function verifyNpmArtifacts(compiler: Record<string, unknown>, binding: NpmCompilerBinding) {
  if (canonicalLabel(binding.producer) === '//apps/web:frontend_precompressed')
    await verifyFrontendArtifacts(compiler, binding.artifact);
  else await verifyCompilerArtifacts(compiler, binding.artifact);
}

function compilerTooling(value: unknown): readonly Record<string, unknown>[] {
  if (!Array.isArray(value))
    throw new Error('Npm frontend context requires its original compiler tooling');
  const manifests = new Set<string>();
  for (const original of value) {
    const item = frontendRecord(original, ['manifest_label', 'native']);
    const native = frontendRecord(item.native, ['input', 'label']);
    for (const label of [item.manifest_label, native.label]) {
      if (
        typeof label !== 'string' ||
        !/^(?:@@?[A-Za-z0-9_.+~-]+)?\/\/[A-Za-z0-9_./+~@-]*:[A-Za-z0-9_./+~@-]+$/.test(
          canonicalLabel(label),
        )
      )
        throw new Error('Npm frontend context has an invalid compiler-tooling File label');
    }
    if (
      typeof item.manifest_label !== 'string' ||
      !/^@@?[A-Za-z0-9_.+~-]+\/\//.test(item.manifest_label) ||
      !item.manifest_label.endsWith(':Cargo.toml')
    )
      throw new Error('Npm frontend context lacks its original upstream Cargo manifest');
    if (typeof native.input !== 'string')
      throw new Error('Npm frontend context has an invalid compiler-tooling File input');
    relative(native.input);
    if (
      typeof item.manifest_label !== 'string' ||
      manifests.has(canonicalLabel(item.manifest_label))
    )
      throw new Error('Npm frontend context repeats a compiler-tooling source manifest');
    manifests.add(canonicalLabel(item.manifest_label));
  }
  return value;
}

function pendingScopes(
  configuration: Record<string, unknown>,
  outputs: Record<string, { entryPoint?: string }>,
  binding: NpmCompilerBinding,
): string[] {
  const producer = canonicalLabel(binding.producer);
  if (
    typeof configuration.producer !== 'string' ||
    canonicalLabel(configuration.producer) !== producer
  )
    throw new Error('Npm compiler producer differs from its typed build authority');
  if (binding.artifact.kind === 'bundle') {
    if (producer === '//apps/web:frontend_precompressed') {
      frontendContext(configuration);
      return [
        'first-party',
        'wasm',
        ...(compilerTooling(configuration.compiler_tooling).length ? ['compiler-tooling'] : []),
      ];
    }
    const entries = configuration.entry_points;
    if (
      producer !== '//apps/server:migrations' ||
      configuration.target !== 'bun' ||
      !Array.isArray(configuration.compiler_tooling) ||
      configuration.compiler_tooling.length !== 0 ||
      configuration.root !== 'apps/server/migrations' ||
      !Array.isArray(entries) ||
      entries.length === 0 ||
      entries.some(
        (entry) => typeof entry !== 'string' || !entry.startsWith('apps/server/migrations/'),
      ) ||
      new Set(entries).size !== entries.length
    )
      throw new Error('Npm attribution requires the exact supported migration bundle context');
    const selectedEntries = Object.values(outputs)
      .map((output) => output.entryPoint)
      .sort();
    if (JSON.stringify(selectedEntries) !== JSON.stringify([...entries].sort()))
      throw new Error('Migration compiler outputs differ from configured entry points');
    return ['first-party'];
  }
  if (
    !['//apps/server:server', '//apps/daemon:daemon', '//scripts:release_verifier'].includes(
      producer,
    ) ||
    !['bun-darwin-arm64', 'bun-darwin-x64', 'bun-linux-arm64', 'bun-linux-x64'].includes(
      String(configuration.compile_target),
    ) ||
    !Array.isArray(configuration.compiler_tooling) ||
    configuration.compiler_tooling.length !== 0 ||
    ['entry_points', 'root', 'target'].some((key) => Object.hasOwn(configuration, key))
  )
    throw new Error('Npm attribution requires the exact supported standalone compiler context');
  return ['first-party', 'wasm', 'embedded-runtime'];
}

function relative(value: string): string {
  return portablePath(value, 'Attribution input is not a declared portable path');
}

function declaredInputs(value: unknown): Record<string, Declaration> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('Npm attribution requires original File declarations');
  for (const [logical, fields] of Object.entries(value)) {
    relative(logical);
    if (
      typeof fields !== 'object' ||
      fields === null ||
      Array.isArray(fields) ||
      Object.keys(fields).sort().join(',') !== 'canonical,input,link,owner' ||
      typeof fields.input !== 'string' ||
      typeof fields.owner !== 'string' ||
      typeof fields.link !== 'boolean' ||
      typeof fields.canonical !== 'string'
    )
      throw new Error('Npm attribution requires exact original File and canonical placement facts');
    relative(fields.input);
    relative(fields.canonical);
  }
  return value as Record<string, Declaration>;
}

/** Retain the original declared File through the same compiler custody check. */
async function pinnedRead(filename: string): Promise<Buffer> {
  return captureCompilerFileBytes(filename, true);
}

function member(root: string, filename: string): string | undefined {
  const value = path.relative(root, filename);
  return value !== '' && !value.startsWith('../') && !path.isAbsolute(value) ? value : undefined;
}

async function declaredFile(
  filename: string,
  declarations: Readonly<Record<string, Declaration>>,
  executionRoot: string,
): Promise<{ physical: string; linked: boolean; root: string | undefined; owner: string }> {
  relative(filename);
  const candidates = Object.entries(declarations)
    .filter(
      ([logical, declaration]) =>
        logical === declaration.canonical &&
        (logical === filename || member(logical, filename) !== undefined),
    )
    .sort(([a], [b]) => b.length - a.length);
  for (const [logical, declaration] of candidates) {
    const input = path.resolve(executionRoot, relative(declaration.input));
    if (logical === filename)
      return {
        physical: await realpath(input),
        linked: declaration.link,
        root: undefined,
        owner: declaration.owner,
      };
    if ((await stat(input)).isDirectory())
      return {
        physical: await realpath(path.join(input, path.relative(logical, filename))),
        linked: declaration.link,
        root: await realpath(input),
        owner: declaration.owner,
      };
  }
  throw new Error(`Compiler source has no declared materialization: ${filename}`);
}

async function indexPackageSources(
  roots: readonly PhysicalSource[],
): Promise<Map<string, PhysicalSource[]>> {
  const members = new Map<string, PhysicalSource[]>();
  async function visit(
    source: PhysicalSource,
    filename: string,
    ancestors: ReadonlySet<string>,
  ): Promise<void> {
    const physical = await realpath(filename);
    const info = await stat(physical);
    if (info.isDirectory()) {
      if (ancestors.has(physical))
        throw new Error('Declared npm package contains a directory cycle');
      const visited = new Set([...ancestors, physical]);
      for (const child of await readdir(filename))
        await visit(source, path.join(filename, child), visited);
    } else if (info.isFile()) {
      const current = members.get(physical) ?? [];
      if (!current.some((item) => item.source.input === source.source.input)) current.push(source);
      members.set(physical, current);
    } else throw new Error('Declared npm package contains a non-regular member');
  }
  for (const root of roots) {
    if (!root.source.workspace) await visit(root, root.root, new Set());
  }
  return members;
}

async function selectedSources(
  compiler: Readonly<Record<string, CompilerInput>>,
  declarations: Readonly<Record<string, Declaration>>,
  sources: readonly PackageSource[],
  executionRoot: string,
  frontend = false,
): Promise<PhysicalSource[]> {
  const roots = await Promise.all(
    sources.map(async (source) => ({
      source,
      root: await realpath(path.resolve(executionRoot, relative(source.input))),
    })),
  );
  const members = await indexPackageSources(roots);
  const selected = new Map<string, PhysicalSource>();
  for (const [filename, fact] of Object.entries(compiler)) {
    const declared = await declaredFile(filename, declarations, executionRoot);
    if (frontend && fact.owner !== declared.owner)
      throw new Error('Frontend compiler source differs from its original File owner');
    const physical = declared.physical;
    const bytes = await pinnedRead(physical);
    if (bytes.length !== fact.bytes || sha256(bytes) !== fact.sha256)
      throw new Error('Declared attribution source differs from actual compiler input');
    const candidates = members.get(physical) ?? [];
    const source =
      candidates.length === 1
        ? candidates[0]
        : candidates.find((item) => item.root === declared.root);
    if (candidates.length > 1 && source === undefined)
      throw new Error('Compiler source has ambiguous typed npm resolution context');
    if (source !== undefined) selected.set(source.source.input, source);
    else if (declared.linked)
      throw new Error(`Compiler npm input has no typed package source provider: ${filename}`);
  }
  return [...selected.values()].sort((a, b) =>
    a.source.input < b.source.input ? -1 : a.source.input > b.source.input ? 1 : 0,
  );
}

function repository(value: unknown): string | null {
  if (typeof value === 'string' && value.length > 0) return value;
  if (
    typeof value === 'object' &&
    value !== null &&
    'url' in value &&
    typeof value.url === 'string'
  )
    return value.url;
  return null;
}

async function packageFacts(
  item: PhysicalSource,
  registry: Readonly<Record<string, RegistrySource>>,
) {
  const packageBytes = await pinnedRead(path.join(item.root, 'package.json'));
  const metadata = JSON.parse(packageBytes.toString('utf8')) as Record<string, unknown>;
  if (
    metadata.name !== item.source.package ||
    typeof metadata.version !== 'string' ||
    (item.source.version !== metadata.version &&
      !item.source.version.startsWith(`${metadata.version}(`))
  )
    throw new Error('Typed npm provider disagrees with package metadata');
  const lock = registry[`${metadata.name}@${metadata.version}`];
  if (lock === undefined) {
    // Workspace providers are retained explicitly as a pending first-party scope.
    if (!item.source.workspace || item.source.version !== '0.0.0')
      throw new Error('Selected npm package is absent from the locked registry inventory');
    return { kind: 'workspace' as const, local: item.source };
  }
  if (typeof metadata.license !== 'string' || metadata.license.trim() === '')
    throw new Error('Selected npm package has no declared license');
  const digest = lock.integrity.startsWith('sha512-') ? lock.integrity.slice('sha512-'.length) : '';
  const integrity = Buffer.from(digest, 'base64');
  if (
    integrity.length !== 64 ||
    integrity.toString('base64') !== digest ||
    !lock.tarball.startsWith('https://registry.npmjs.org/')
  )
    throw new Error('Selected npm package has no locked registry source');
  const id = `${metadata.name}@${metadata.version}#${sha256(Buffer.from(item.source.source_label))}`;
  const sourceLabel = canonicalLabel(item.source.source_label);
  const licenseFile = metadata.license.startsWith('SEE LICENSE IN ')
    ? relative(metadata.license.slice('SEE LICENSE IN '.length))
    : null;
  return {
    kind: 'registry' as const,
    component: {
      id,
      name: metadata.name,
      version: metadata.version,
      source: `${lock.tarball} ${lock.integrity}`,
      license: metadata.license,
      repository: repository(metadata.repository),
      license_file: licenseFile,
      source_label: sourceLabel,
    },
    materialization: { root: item.source.input, label: sourceLabel },
    authority: {
      id,
      resolver_version: item.source.version,
      package_json_sha256: sha256(packageBytes),
      registry_integrity: lock.integrity,
      registry_tarball: lock.tarball,
    },
  };
}

/** Npm attribution intermediate; local, WASM and embedded-runtime scopes remain explicit. */
export async function selectNpmAttribution(
  compilerFile: string,
  declarationsFile: string,
  sourcesFile: string,
  configurationFile: string,
  registryFile: string,
  binding: NpmCompilerBinding,
  executionRoot = process.cwd(),
) {
  const [compilerBytes, declarationsBytes, sourcesBytes, configurationBytes, registryBytes] =
    await Promise.all([
      pinnedRead(compilerFile),
      pinnedRead(declarationsFile),
      pinnedRead(sourcesFile),
      pinnedRead(configurationFile),
      pinnedRead(registryFile),
    ]);
  const originalCompiler = JSON.parse(compilerBytes.toString('utf8')) as Record<string, unknown>;
  const compiler = originalCompiler as {
    inputs: Record<string, CompilerInput>;
    outputs: Record<string, { entryPoint?: string }>;
  };
  await verifyNpmArtifacts(originalCompiler, binding);
  const declarations = declaredInputs(JSON.parse(declarationsBytes.toString('utf8')));
  const sources = JSON.parse(sourcesBytes.toString('utf8')) as PackageSource[];
  const configuration = JSON.parse(configurationBytes.toString('utf8')) as Record<string, unknown>;
  const pending = pendingScopes(configuration, compiler.outputs, binding);
  const registry = JSON.parse(registryBytes.toString('utf8')) as Record<string, RegistrySource>;
  const selected = await selectedSources(
    compiler.inputs,
    declarations,
    sources,
    executionRoot,
    canonicalLabel(binding.producer) === '//apps/web:frontend_precompressed',
  );
  const facts = await Promise.all(selected.map((item) => packageFacts(item, registry)));
  const packages = facts.filter((fact) => fact.kind === 'registry');
  const components = packages.map((fact) => fact.component);
  const configurationAuthority = {
    settings_sha256: sha256(configurationBytes),
    npm_sources_sha256: sha256(sourcesBytes),
  };
  if (components.length === 0)
    throw new Error('The compiler selected no locked npm package sources');
  await verifyNpmArtifacts(originalCompiler, binding);
  return {
    kind: 'compiler-selected-npm-attribution',
    expected: {
      producer: canonicalLabel(binding.producer),
      configuration: sha256(Buffer.from(JSON.stringify(configurationAuthority))),
      source_digest: sha256(compilerBytes),
      components,
    },
    configuration_authority: configurationAuthority,
    compiler_inventory_sha256: sha256(compilerBytes),
    registry_inventory_sha256: sha256(registryBytes),
    authorities: packages.map((fact) => fact.authority),
    materializations: Object.fromEntries(
      packages.map((fact) => [fact.component.id, fact.materialization]),
    ),
    pending_scopes: pending,
    selected_workspace_sources: facts
      .filter((fact) => fact.kind === 'workspace')
      .map((fact) => fact.local),
  };
}

if (import.meta.main) {
  const [
    compiler,
    declarations,
    sources,
    configuration,
    registry,
    output,
    producer,
    kind,
    artifact,
  ] = process.argv.slice(2);
  if (
    compiler === undefined ||
    declarations === undefined ||
    sources === undefined ||
    configuration === undefined ||
    registry === undefined ||
    output === undefined ||
    producer === undefined ||
    artifact === undefined ||
    (kind !== 'standalone' && kind !== 'bundle') ||
    process.argv.slice(2).length !== 9
  )
    throw new Error('Npm attribution arguments disappeared');
  const result = await selectNpmAttribution(
    compiler,
    declarations,
    sources,
    configuration,
    registry,
    {
      producer,
      artifact:
        kind === 'standalone' ? { kind, executable: artifact } : { kind, directory: artifact },
    },
  );
  const owned = openOwnedDirectory(path.dirname(path.resolve(output)));
  try {
    owned.write(path.basename(output), `${JSON.stringify(result, null, 2)}\n`);
  } finally {
    owned.close();
  }
}
