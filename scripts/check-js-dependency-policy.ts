import { appendFile, copyFile, mkdir, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { Option, Schema } from 'effect';

/**
 * The JavaScript half of the dependency policy; `deny.toml` holds the Rust half. Every package
 * `pnpm-lock.yaml` resolves comes from the npm registry under a sha512 integrity, every workspace
 * names its dependencies by version, range, catalog or workspace, every package declares a
 * licence the policy grants, and no dependency runs an install script unless
 * `onlyBuiltDependencies` in `pnpm-workspace.yaml` names it.
 *
 * The lockfile records no licences, so they are read from installed manifests. The lockfile is
 * installed into `target/js-dependency-policy` for every operating system, CPU and libc any
 * locked package names, with scripts off, so a platform binary another machine would install is
 * checked here too.
 */

const ROOT = path.resolve(import.meta.dir, '..');
const STAGE = path.join(ROOT, 'target/js-dependency-policy');
/** What `pnpm install` reads besides the workspace manifests. */
const INSTALL_INPUTS = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', '.npmrc'];

/** `deny.toml`'s third-party licences, plus 0BSD and CC0-1.0, which grant at least as much. */
const ALLOWED_LICENSES: ReadonlySet<string> = new Set([
  '0BSD',
  'Apache-2.0',
  'Apache-2.0 WITH LLVM-exception',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'BSL-1.0',
  'CC0-1.0',
  'CDLA-Permissive-2.0',
  'ISC',
  'MIT',
  'Unicode-3.0',
  'Zlib',
]);

/**
 * Packages admitted under a licence the allowlist does not grant, by name and exact declared
 * expression, so a relicensed release fails until it is reviewed again. An exception also
 * covers the platform binaries its package lists as `optionalDependencies`.
 */
const LICENSE_EXCEPTIONS: ReadonlyMap<string, string> = new Map([
  // Vite's CSS transformer, used unmodified: MPL-2.0's copyleft reaches only changed files.
  ['lightningcss', 'MPL-2.0'],
  // Browserslist's browser-support data, under an attribution licence for data.
  ['caniuse-lite', 'CC-BY-4.0'],
]);

const INSTALL_SCRIPTS = ['preinstall', 'install', 'postinstall'] as const;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const SPEC = /^(?:catalog:|workspace:\*|[~^]?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/;
const INTEGRITY = /^sha512-[A-Za-z0-9+/]{86}==$/;
const LICENSE_ID = /^[A-Za-z0-9.+-]+$/;

const LockedSpec = Schema.Struct({ specifier: Schema.String, version: Schema.String });
const Specs = Schema.optionalKey(Schema.Record(Schema.String, LockedSpec));
const Platforms = Schema.optionalKey(Schema.Array(Schema.String));

const LockedImporter = Schema.Struct({
  dependencies: Specs,
  devDependencies: Specs,
  optionalDependencies: Specs,
});
type LockedImporter = typeof LockedImporter.Type;

/** A `packages` entry. A registry package's resolution is its integrity alone. */
const LockedEntry = Schema.Struct({
  resolution: Schema.Record(Schema.String, Schema.String),
  os: Platforms,
  cpu: Platforms,
  libc: Platforms,
});
type LockedEntry = typeof LockedEntry.Type;

/** A `snapshots` entry, keyed by the package and its peers: what it depends on. */
const LockedSnapshot = Schema.Struct({
  optionalDependencies: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
});

const PnpmLock = Schema.Struct({
  importers: Schema.Record(Schema.String, LockedImporter),
  catalogs: Schema.optionalKey(
    Schema.Record(Schema.String, Schema.Record(Schema.String, LockedSpec)),
  ),
  packages: Schema.optionalKey(Schema.Record(Schema.String, LockedEntry)),
  snapshots: Schema.optionalKey(Schema.Record(Schema.String, LockedSnapshot)),
});
export const decodeLockfile = Schema.decodeUnknownSync(PnpmLock);

const WorkspaceSettings = Schema.Struct({
  onlyBuiltDependencies: Schema.optionalKey(Schema.Array(Schema.String)),
});
type WorkspaceSettings = typeof WorkspaceSettings.Type;

const LicenseObject = Schema.Struct({ type: Schema.String });
const InstalledManifest = Schema.Struct({
  name: Schema.String,
  version: Schema.String,
  license: Schema.optionalKey(Schema.Union([Schema.String, LicenseObject])),
  licenses: Schema.optionalKey(Schema.Array(LicenseObject)),
  scripts: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
});
export type InstalledManifest = typeof InstalledManifest.Type;
const isText = Schema.is(Schema.String);

interface LockedPackage {
  readonly key: string;
  readonly name: string;
  readonly version: string;
  /** Names under the entry's `optionalDependencies`: its platform binaries. */
  readonly optional: readonly string[];
}

/** The platforms the locked packages name, which the policy install covers. */
interface Architectures {
  readonly os: readonly string[];
  readonly cpu: readonly string[];
  readonly libc: readonly string[];
}

interface Lockfile {
  /** Workspace directories other than the root. */
  readonly workspaces: readonly string[];
  readonly packages: readonly LockedPackage[];
  readonly architectures: Architectures;
  readonly findings: readonly string[];
}

export interface Installed {
  /** `null` when the manifest does not decode as one. */
  readonly manifest: InstalledManifest | null;
  /** A root `binding.gyp`, for which pnpm runs `node-gyp rebuild` when no script is declared. */
  readonly bindingGyp: boolean;
}

interface PolicyReport {
  readonly findings: readonly string[];
  readonly checked: number;
  /** Dependencies with an install script that `onlyBuiltDependencies` leaves blocked. */
  readonly blocked: readonly string[];
}

type LicenseNode =
  | string
  | { readonly operator: 'AND' | 'OR'; readonly left: LicenseNode; readonly right: LicenseNode };

/** Source and spec findings for a decoded `pnpm-lock.yaml`, and the registry packages it resolves. */
export function readLockfile(lockfile: typeof PnpmLock.Type): Lockfile {
  const findings: string[] = [];
  for (const [importer, entry] of Object.entries(lockfile.importers)) {
    findings.push(...specFindings(importer === '.' ? '' : `${importer}/`, entry));
  }
  for (const [catalog, entries] of Object.entries(lockfile.catalogs ?? {})) {
    for (const [name, { specifier }] of Object.entries(entries)) {
      if (!VERSION.test(specifier))
        findings.push(`catalog ${catalog} ${name}: "${specifier}" is not an exact version`);
    }
  }
  const workspaces = Object.keys(lockfile.importers).filter((importer) => importer !== '.');
  // A snapshot key names the package, then each peer set it was resolved with in parentheses.
  const optional = new Map<string, Set<string>>();
  for (const [key, snapshot] of Object.entries(lockfile.snapshots ?? {})) {
    const base = key.split('(')[0] ?? key;
    const names = optional.get(base) ?? new Set<string>();
    for (const name of Object.keys(snapshot.optionalDependencies ?? {})) names.add(name);
    optional.set(base, names);
  }
  const packages: LockedPackage[] = [];
  const os = new Set<string>();
  const cpu = new Set<string>();
  const libc = new Set<string>();
  for (const [key, entry] of Object.entries(lockfile.packages ?? {})) {
    const locked = lockedPackage(key, entry, [...(optional.get(key) ?? [])].sort());
    if (isText(locked)) {
      findings.push(locked);
      continue;
    }
    packages.push(locked);
    for (const [names, into] of [
      [entry.os, os],
      [entry.cpu, cpu],
      [entry.libc, libc],
    ] as const) {
      for (const name of names ?? []) if (!name.startsWith('!')) into.add(name);
    }
  }
  const architectures = { os: [...os].sort(), cpu: [...cpu].sort(), libc: [...libc].sort() };
  return { workspaces, packages, architectures, findings };
}

function specFindings(directory: string, importer: LockedImporter): string[] {
  const findings: string[] = [];
  for (const [field, specs] of Object.entries(importer)) {
    for (const [name, { specifier }] of Object.entries(specs ?? {})) {
      if (!SPEC.test(specifier)) {
        findings.push(
          `${directory}package.json ${field} ${name}: "${specifier}" is not a version, caret or tilde range, catalog or workspace spec`,
        );
      }
    }
  }
  return findings;
}

/** A registry package, or the finding that refuses the entry. */
function lockedPackage(
  key: string,
  entry: LockedEntry,
  optional: readonly string[],
): LockedPackage | string {
  const at = key.lastIndexOf('@');
  const name = key.slice(0, at);
  const version = key.slice(at + 1);
  if (at <= 0 || !VERSION.test(version)) return `${key}: resolved outside the npm registry`;
  const { integrity, ...rest } = entry.resolution;
  const elsewhere = rest.tarball ?? rest.repo ?? rest.directory ?? rest.type;
  if (elsewhere !== undefined) return `${key}: resolved from "${elsewhere}", not npm`;
  if (integrity === undefined || !INTEGRITY.test(integrity)) {
    return `${key}: has no sha512 integrity`;
  }
  return { key, name, version, optional };
}

/** The licence, install-script and trust findings over the installed manifests. */
export function policyFindings(
  settings: WorkspaceSettings,
  packages: readonly LockedPackage[],
  installed: ReadonlyMap<string, Installed>,
): PolicyReport {
  const findings: string[] = [];
  const excepted = exceptedLicenses(packages, findings);
  const scripted = new Set<string>();
  let checked = 0;
  for (const locked of packages) {
    const ident = `${locked.name}@${locked.version}`;
    const entry = installed.get(locked.key);
    if (entry === undefined) {
      findings.push(`${ident}: not installed`);
      continue;
    }
    const { manifest } = entry;
    if (manifest === null) {
      findings.push(`${ident}: the installed manifest has no readable licence or scripts`);
      continue;
    }
    if (manifest.name !== locked.name || manifest.version !== locked.version) {
      findings.push(`${ident}: the installed manifest names another package`);
      continue;
    }
    checked += 1;
    const finding = licenseFinding(ident, declaredLicense(manifest), excepted.get(locked.name));
    if (finding !== null) findings.push(finding);
    if (entry.bindingGyp || hasInstallScript(manifest)) scripted.add(locked.name);
  }
  const trusted = settings.onlyBuiltDependencies ?? [];
  for (const name of trusted) {
    if (!scripted.has(name)) {
      findings.push(
        `pnpm-workspace.yaml: onlyBuiltDependencies names ${name}, which has no install script`,
      );
    }
  }
  const blocked = [...scripted].filter((name) => !trusted.includes(name)).sort();
  return { findings, checked, blocked };
}

function exceptedLicenses(packages: readonly LockedPackage[], findings: string[]) {
  const excepted = new Map<string, string>();
  for (const [name, license] of LICENSE_EXCEPTIONS) {
    const covered = packages.filter((locked) => locked.name === name);
    if (covered.length === 0) {
      findings.push(`LICENSE_EXCEPTIONS names ${name}, which pnpm-lock.yaml does not resolve`);
    }
    excepted.set(name, license);
    for (const binary of covered.flatMap((locked) => locked.optional)) {
      excepted.set(binary, license);
    }
  }
  return excepted;
}

function licenseFinding(
  ident: string,
  declared: string | null,
  exception: string | undefined,
): string | null {
  if (declared === null) return `${ident}: declares no licence`;
  if (exception !== undefined) {
    return declared === exception
      ? null
      : `${ident}: declares ${declared}, but its exception admits ${exception}`;
  }
  const expression = parseLicense(declared);
  if (expression === null) return `${ident}: "${declared}" is not an SPDX expression`;
  return licenseGranted(expression) ? null : `${ident}: ${declared} is not an allowed licence`;
}

/** The manifest's licence: SPDX `license`, the older `{ type }` object, or a lone `licenses` entry. */
export function declaredLicense(manifest: InstalledManifest): string | null {
  const { license, licenses } = manifest;
  if (license !== undefined) return isText(license) ? license : license.type;
  // Several pre-SPDX `licenses` entries do not say whether all apply or any one does.
  const [only, ...more] = licenses ?? [];
  return only === undefined || more.length > 0 ? null : only.type;
}

/** An SPDX licence expression's tree, or `null` when the text is not one. */
export function parseLicense(text: string): LicenseNode | null {
  const tokens = text.match(/[()]|[^\s()]+/g) ?? [];
  let at = 0;
  function expression(operator: 'OR' | 'AND'): LicenseNode | null {
    const operand = () => (operator === 'OR' ? expression('AND') : term());
    let left = operand();
    while (left !== null && tokens[at] === operator) {
      at += 1;
      const right = operand();
      left = right === null ? null : { operator, left, right };
    }
    return left;
  }
  function term(): LicenseNode | null {
    const token = tokens[at];
    at += 1;
    if (token === '(') {
      const inner = expression('OR');
      if (tokens[at] !== ')') return null;
      at += 1;
      return inner;
    }
    if (!isLicenseId(token)) return null;
    if (tokens[at] !== 'WITH') return token;
    const exception = tokens[at + 1];
    at += 2;
    return isLicenseId(exception) ? `${token} WITH ${exception}` : null;
  }
  const tree = expression('OR');
  return at === tokens.length ? tree : null;
}

function isLicenseId(token: string | undefined): token is string {
  return (
    token !== undefined &&
    LICENSE_ID.test(token) &&
    token !== 'AND' &&
    token !== 'OR' &&
    token !== 'WITH'
  );
}

export function licenseGranted(node: LicenseNode): boolean {
  if (isText(node)) return ALLOWED_LICENSES.has(node);
  return node.operator === 'AND'
    ? licenseGranted(node.left) && licenseGranted(node.right)
    : licenseGranted(node.left) || licenseGranted(node.right);
}

function hasInstallScript(manifest: InstalledManifest): boolean {
  return INSTALL_SCRIPTS.some((name) => (manifest.scripts?.[name] ?? '') !== '');
}

/** `pnpm-workspace.yaml`'s `supportedArchitectures`: every platform the lock names. */
export function supportedArchitectures(architectures: Architectures): string {
  const list = (names: readonly string[]) =>
    `[${names.map((name) => JSON.stringify(name)).join(', ')}]`;
  return [
    'supportedArchitectures:',
    `  os: ${list(architectures.os)}`,
    `  cpu: ${list(architectures.cpu)}`,
    `  libc: ${list(architectures.libc)}`,
    '',
  ].join('\n');
}

async function installEveryPlatform(lockfile: Lockfile): Promise<void> {
  await rm(STAGE, { recursive: true, force: true });
  const manifests = lockfile.workspaces.map((workspace) => path.join(workspace, 'package.json'));
  for (const file of [...INSTALL_INPUTS, ...manifests]) {
    await mkdir(path.dirname(path.join(STAGE, file)), { recursive: true });
    await copyFile(path.join(ROOT, file), path.join(STAGE, file));
  }
  await appendFile(
    path.join(STAGE, 'pnpm-workspace.yaml'),
    `\n${supportedArchitectures(lockfile.architectures)}`,
  );
  const install = Bun.spawn(['pnpm', 'install', '--frozen-lockfile', '--ignore-scripts'], {
    cwd: STAGE,
    stdout: 'ignore',
    stderr: 'pipe',
  });
  const stderr = await new Response(install.stderr).text();
  if ((await install.exited) !== 0) throw new Error(`pnpm install failed in ${STAGE}:\n${stderr}`);
}

async function readInstalled(packages: readonly LockedPackage[]): Promise<Map<string, Installed>> {
  const store = path.join(STAGE, 'node_modules/.pnpm');
  const entries = await readdir(store);
  const installed = new Map<string, Installed>();
  for (const locked of packages) {
    // The virtual store names a package `<name, / as +>@<version>`, plus `_<peers>` per peer set.
    const base = `${locked.name.replace('/', '+')}@${locked.version}`;
    const entry = entries.find((name) => name === base || name.startsWith(`${base}_`));
    if (entry === undefined) continue;
    const directory = path.join(store, entry, 'node_modules', locked.name);
    const manifest = Schema.decodeUnknownOption(InstalledManifest)(
      await Bun.file(path.join(directory, 'package.json')).json(),
    );
    installed.set(locked.key, {
      manifest: Option.getOrNull(manifest),
      bindingGyp: await Bun.file(path.join(directory, 'binding.gyp')).exists(),
    });
  }
  return installed;
}

if (import.meta.main) {
  const settings = Schema.decodeUnknownSync(WorkspaceSettings)(
    Bun.YAML.parse(await Bun.file(path.join(ROOT, 'pnpm-workspace.yaml')).text()),
  );
  const lockfile = readLockfile(
    decodeLockfile(Bun.YAML.parse(await Bun.file(path.join(ROOT, 'pnpm-lock.yaml')).text())),
  );
  await installEveryPlatform(lockfile);
  const report = policyFindings(
    settings,
    lockfile.packages,
    await readInstalled(lockfile.packages),
  );
  const findings = [...lockfile.findings, ...report.findings];
  if (findings.length > 0) {
    process.stderr.write('JavaScript dependency policy violations:\n');
    for (const finding of findings) process.stderr.write(`- ${finding}\n`);
    process.exit(1);
  }
  const blocked =
    report.blocked.length === 0 ? '' : `; install scripts blocked: ${report.blocked.join(', ')}`;
  process.stdout.write(
    `JavaScript dependency policy holds for ${report.checked} packages${blocked}.\n`,
  );
}
