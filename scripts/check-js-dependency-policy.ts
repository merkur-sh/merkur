import { copyFile, mkdir, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { Option, Schema } from 'effect';

/**
 * The JavaScript half of the dependency policy; `deny.toml` holds the Rust half. Every package
 * `bun.lock` resolves comes from the npm registry under a sha512 integrity, every workspace
 * names its dependencies by version, range, catalog or workspace, every installable package
 * declares a licence the policy grants, and no dependency runs an install script unless the
 * root `trustedDependencies` names it.
 *
 * The lockfile records no licences, so they are read from installed manifests. The lockfile is
 * installed into `target/js-dependency-policy` for every OS and CPU Bun knows, with scripts
 * off, so a platform binary another machine would install is checked here too. A package the
 * lockfile marks installable nowhere (`os` or `cpu` "none"), and everything beneath it, is
 * never installed by Bun and is skipped.
 */

const ROOT = path.resolve(import.meta.dir, '..');
const STAGE = path.join(ROOT, 'target/js-dependency-policy');
/** What `bun install` reads besides the workspace manifests. */
const INSTALL_INPUTS = ['package.json', 'bun.lock', 'bunfig.toml', '.npmrc'];

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

const Specs = Schema.optionalKey(Schema.Record(Schema.String, Schema.String));
const Platforms = Schema.optionalKey(Schema.Union([Schema.String, Schema.Array(Schema.String)]));

const LockedWorkspace = Schema.Struct({
  dependencies: Specs,
  devDependencies: Specs,
  optionalDependencies: Specs,
  peerDependencies: Specs,
});
type LockedWorkspace = typeof LockedWorkspace.Type;

/** Any `packages` entry: its identity first, then a shape that depends on its source. */
const LockEntry = Schema.TupleWithRest(Schema.Tuple([Schema.String]), [Schema.Unknown]);
type LockEntry = typeof LockEntry.Type;
const WorkspaceEntry = Schema.Tuple([Schema.String]);
const RegistryEntry = Schema.Tuple([
  Schema.String,
  Schema.String,
  Schema.Struct({ os: Platforms, cpu: Platforms, optionalDependencies: Specs }),
  Schema.String,
]);

const BunLock = Schema.Struct({
  workspaces: Schema.Record(Schema.String, LockedWorkspace),
  catalog: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  packages: Schema.Record(Schema.String, LockEntry),
});
export const decodeLockfile = Schema.decodeUnknownSync(BunLock);

const RootManifest = Schema.Struct({
  trustedDependencies: Schema.optionalKey(Schema.Array(Schema.String)),
});
type RootManifest = typeof RootManifest.Type;

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
  readonly installable: boolean;
}

interface Lockfile {
  /** Workspace directories other than the root. */
  readonly workspaces: readonly string[];
  readonly packages: readonly LockedPackage[];
  readonly findings: readonly string[];
}

export interface Installed {
  /** `null` when the manifest does not decode as one. */
  readonly manifest: InstalledManifest | null;
  /** A root `binding.gyp`, for which Bun runs `node-gyp rebuild` when no script is declared. */
  readonly bindingGyp: boolean;
}

interface PolicyReport {
  readonly findings: readonly string[];
  readonly checked: number;
  /** Dependencies with an install script that `trustedDependencies` leaves blocked. */
  readonly blocked: readonly string[];
}

type LicenseNode =
  | string
  | { readonly operator: 'AND' | 'OR'; readonly left: LicenseNode; readonly right: LicenseNode };

/** Source and spec findings for a decoded `bun.lock`, and the registry packages it resolves. */
export function readLockfile(lockfile: typeof BunLock.Type): Lockfile {
  const findings: string[] = [];
  for (const [workspace, entry] of Object.entries(lockfile.workspaces)) {
    findings.push(...specFindings(workspace === '' ? '' : `${workspace}/`, entry));
  }
  for (const [name, version] of Object.entries(lockfile.catalog ?? {})) {
    if (!VERSION.test(version))
      findings.push(`catalog ${name}: "${version}" is not an exact version`);
  }
  const workspaces = Object.keys(lockfile.workspaces).filter((workspace) => workspace !== '');
  const resolved: Omit<LockedPackage, 'installable'>[] = [];
  const nowhere = new Set<string>();
  for (const [key, entry] of Object.entries(lockfile.packages)) {
    const locked = lockedPackage(key, entry, workspaces);
    if (isText(locked)) findings.push(locked);
    else if (locked !== null) {
      resolved.push(locked.locked);
      if (locked.nowhere) nowhere.add(key);
    }
  }
  const packages = resolved.map((locked) => ({
    ...locked,
    installable: !nowhere.has(locked.key) && !nestedUnder(locked.key, nowhere),
  }));
  return { workspaces, packages, findings };
}

function specFindings(directory: string, workspace: LockedWorkspace): string[] {
  const findings: string[] = [];
  for (const [field, specs] of Object.entries(workspace)) {
    for (const [name, spec] of Object.entries(specs ?? {})) {
      if (!SPEC.test(spec)) {
        findings.push(
          `${directory}package.json ${field} ${name}: "${spec}" is not a version, caret or tilde range, catalog or workspace spec`,
        );
      }
    }
  }
  return findings;
}

/** A registry package, `null` for a workspace, or the finding that refuses the entry. */
function lockedPackage(
  key: string,
  entry: LockEntry,
  workspaces: readonly string[],
): { locked: Omit<LockedPackage, 'installable'>; nowhere: boolean } | string | null {
  const [ident] = entry;
  const at = ident.lastIndexOf('@');
  const name = ident.slice(0, at);
  const version = ident.slice(at + 1);
  if (!Schema.is(RegistryEntry)(entry) || at <= 0 || !VERSION.test(version)) {
    const workspace = Schema.is(WorkspaceEntry)(entry) && version.startsWith('workspace:');
    return workspace && workspaces.includes(version.slice('workspace:'.length))
      ? null
      : `${ident}: resolved outside the npm registry`;
  }
  const [, registry, info, integrity] = entry;
  if (registry !== '') return `${ident}: resolved from "${registry}", not npm`;
  if (!INTEGRITY.test(integrity)) return `${ident}: has no sha512 integrity`;
  return {
    locked: { key, name, version, optional: Object.keys(info.optionalDependencies ?? {}) },
    nowhere: info.os === 'none' || info.cpu === 'none',
  };
}

/** Whether a nested lockfile key (`parent/child`) sits beneath one of `parents`. */
function nestedUnder(key: string, parents: ReadonlySet<string>): boolean {
  for (let slash = key.indexOf('/'); slash !== -1; slash = key.indexOf('/', slash + 1)) {
    if (parents.has(key.slice(0, slash))) return true;
  }
  return false;
}

/** The licence, install-script and trust findings over the installed manifests. */
export function policyFindings(
  root: RootManifest,
  packages: readonly LockedPackage[],
  installed: ReadonlyMap<string, Installed>,
): PolicyReport {
  const findings: string[] = [];
  const excepted = exceptedLicenses(packages, findings);
  const scripted = new Set<string>();
  let checked = 0;
  for (const locked of packages) {
    if (!locked.installable) continue;
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
  const trusted = root.trustedDependencies;
  if (trusted === undefined) {
    findings.push(
      'package.json: trustedDependencies must list the dependencies allowed to run install scripts; without it Bun runs its built-in list',
    );
  }
  for (const name of trusted ?? []) {
    if (!scripted.has(name)) {
      findings.push(`package.json: trustedDependencies names ${name}, which has no install script`);
    }
  }
  const blocked = [...scripted].filter((name) => !trusted?.includes(name)).sort();
  return { findings, checked, blocked };
}

function exceptedLicenses(packages: readonly LockedPackage[], findings: string[]) {
  const excepted = new Map<string, string>();
  for (const [name, license] of LICENSE_EXCEPTIONS) {
    const covered = packages.filter((locked) => locked.name === name);
    if (covered.length === 0) {
      findings.push(`LICENSE_EXCEPTIONS names ${name}, which bun.lock does not resolve`);
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

async function installEveryPlatform(workspaces: readonly string[]): Promise<void> {
  await rm(STAGE, { recursive: true, force: true });
  const manifests = workspaces.map((workspace) => path.join(workspace, 'package.json'));
  for (const file of [...INSTALL_INPUTS, ...manifests]) {
    await mkdir(path.dirname(path.join(STAGE, file)), { recursive: true });
    await copyFile(path.join(ROOT, file), path.join(STAGE, file));
  }
  const install = Bun.spawn(
    [process.execPath, 'install', '--frozen-lockfile', '--ignore-scripts', '--os=*', '--cpu=*'],
    { cwd: STAGE, stdout: 'ignore', stderr: 'pipe' },
  );
  const stderr = await new Response(install.stderr).text();
  if ((await install.exited) !== 0) throw new Error(`bun install failed in ${STAGE}:\n${stderr}`);
}

async function readInstalled(packages: readonly LockedPackage[]): Promise<Map<string, Installed>> {
  const store = path.join(STAGE, 'node_modules/.bun');
  const entries = await readdir(store);
  const installed = new Map<string, Installed>();
  for (const locked of packages.filter((candidate) => candidate.installable)) {
    // The isolated store names a package `<name, / as +>@<version>`, plus `+<hash>` per peer set.
    const base = `${locked.name.replace('/', '+')}@${locked.version}`;
    const entry = entries.find((name) => name === base || name.startsWith(`${base}+`));
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
  const root = Schema.decodeUnknownSync(RootManifest)(
    await Bun.file(path.join(ROOT, 'package.json')).json(),
  );
  const lockfile = readLockfile(
    decodeLockfile(Bun.JSONC.parse(await Bun.file(path.join(ROOT, 'bun.lock')).text())),
  );
  await installEveryPlatform(lockfile.workspaces);
  const report = policyFindings(root, lockfile.packages, await readInstalled(lockfile.packages));
  const findings = [...lockfile.findings, ...report.findings];
  if (findings.length > 0) {
    process.stderr.write('JavaScript dependency policy violations:\n');
    for (const finding of findings) process.stderr.write(`- ${finding}\n`);
    process.exit(1);
  }
  const blocked =
    report.blocked.length === 0 ? '' : `; install scripts blocked: ${report.blocked.join(', ')}`;
  process.stdout.write(
    `JavaScript dependency policy holds for ${report.checked} installable packages${blocked}.\n`,
  );
}
