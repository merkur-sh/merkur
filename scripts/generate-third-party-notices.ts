import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Generates the notice text the daemon CLI embeds and `merkur licenses` prints.
 *
 * MIT and BSD require the copyright notice to travel with binary distributions,
 * and Apache-2.0 section 4(d) requires the upstream NOTICE text to travel with
 * derivative distributions. The release archive cannot carry it: the updater
 * accepts exactly three executable entries and rejects anything else, and
 * weakening that check to smuggle a text file in would be the wrong trade. The
 * notices are compiled into the `merkur` executable instead, where they cannot
 * be separated from the binary they describe.
 *
 * The crate set is the exact resolved dependency closure of the shipped Rust
 * binaries, minus Merkur's own AGPL crates, read from `cargo metadata` under
 * `--locked`; the JavaScript set is the closure of the daemon CLI's published
 * dependencies. Nothing here is a hand-kept list.
 */

const CURRENT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(CURRENT_DIRECTORY, '..');
const DEFAULT_OUTFILE = path.join(REPO_ROOT, 'apps/daemon/NOTICES.txt');

/** The Rust executables that ship in a daemon archive. */
const RUST_ROOTS = ['merkur-dataplane', 'merkur-image-worker', 'merkur-tui'] as const;

/** Merkur's own crates carry this expression and are covered by LICENSE. */
const OWN_LICENSE = 'AGPL-3.0-only';

const LICENSE_FILE_PATTERN = /^(licen[cs]e|copying|notice|unlicense)/i;

interface CargoPackage {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly license: string | null;
  readonly license_file: string | null;
  readonly manifest_path: string;
  readonly repository: string | null;
  readonly source: string | null;
}

interface CargoNode {
  readonly id: string;
  readonly deps: readonly {
    readonly pkg: string;
    readonly dep_kinds: readonly { readonly kind: string | null }[];
  }[];
}

interface Component {
  readonly name: string;
  readonly version: string;
  readonly license: string;
  readonly repository: string | null;
  readonly texts: readonly { readonly file: string; readonly body: string }[];
}

const outfile = resolveOutfile();
const components = [...(await collectRustComponents()), ...(await collectJavaScriptComponents())];
const bunVersion = await resolveBunVersion();
const ownLicense = await fs.readFile(path.join(REPO_ROOT, 'LICENSE'), 'utf8');

await fs.mkdir(path.dirname(outfile), { recursive: true });
await fs.writeFile(outfile, render(components, bunVersion, ownLicense), 'utf8');

process.stdout.write(`wrote ${outfile} (${components.length} components)\n`);

function resolveOutfile(): string {
  const index = process.argv.indexOf('--out');
  const explicit = index === -1 ? undefined : process.argv[index + 1];
  return explicit === undefined || explicit.length === 0
    ? DEFAULT_OUTFILE
    : path.resolve(REPO_ROOT, explicit);
}

async function collectRustComponents(): Promise<readonly Component[]> {
  const metadata = await runJson(['cargo', 'metadata', '--format-version', '1', '--locked']);
  const packages = metadata.packages as readonly CargoPackage[];
  const nodes = (metadata.resolve as { readonly nodes: readonly CargoNode[] }).nodes;

  const byId = new Map(packages.map((entry) => [entry.id, entry]));
  const nodeById = new Map(nodes.map((node) => [node.id, node]));

  const roots = packages.filter((entry) => RUST_ROOTS.includes(entry.name as never));
  const missing = RUST_ROOTS.filter((name) => !roots.some((entry) => entry.name === name));
  if (missing.length > 0) {
    throw new Error(`cargo metadata has no package named ${missing.join(', ')}`);
  }

  // Shipped binaries carry their normal and build dependencies; dev-dependencies
  // exist only for `cargo test` and are not in the artifact.
  const reached = new Set<string>();
  const queue = roots.map((entry) => entry.id);
  while (queue.length > 0) {
    const id = queue.pop();
    if (id === undefined || reached.has(id)) {
      continue;
    }
    reached.add(id);
    const node = nodeById.get(id);
    if (node === undefined) {
      continue;
    }
    for (const dep of node.deps) {
      const shipped = dep.dep_kinds.some((kind) => kind.kind === null || kind.kind === 'build');
      if (shipped && !reached.has(dep.pkg)) {
        queue.push(dep.pkg);
      }
    }
  }

  const collected: Component[] = [];
  for (const id of reached) {
    const entry = byId.get(id);
    if (entry === undefined || entry.license === OWN_LICENSE) {
      continue;
    }
    const directory = path.dirname(entry.manifest_path);
    collected.push({
      name: entry.name,
      version: entry.version,
      license: entry.license ?? (entry.license_file === null ? 'UNSTATED' : 'see license file'),
      repository: entry.repository,
      texts: await readLicenseTexts(directory, entry.license_file),
    });
  }
  return sortComponents(collected);
}

async function collectJavaScriptComponents(): Promise<readonly Component[]> {
  const daemonDirectory = path.join(REPO_ROOT, 'apps/daemon');
  const manifest = await readManifest(path.join(daemonDirectory, 'package.json'));
  const roots = Object.entries(manifest.dependencies ?? {})
    .filter(([, spec]) => !spec.startsWith('workspace:'))
    .map(([name]) => name);

  const seen = new Set<string>();
  const collected: Component[] = [];
  const queue = roots.map((name) => ({ name, from: daemonDirectory }));
  while (queue.length > 0) {
    const next = queue.pop();
    if (next === undefined) {
      continue;
    }
    const directory = resolvePackageDirectory(next.name, next.from);
    if (directory === null || seen.has(directory)) {
      continue;
    }
    seen.add(directory);
    const dependency = await readManifest(path.join(directory, 'package.json'));
    collected.push({
      name: dependency.name ?? next.name,
      version: dependency.version ?? 'unknown',
      license: dependency.license ?? 'UNSTATED',
      repository: readRepository(dependency),
      texts: await readLicenseTexts(directory, null),
    });
    for (const name of Object.keys(dependency.dependencies ?? {})) {
      queue.push({ name, from: directory });
    }
  }
  return sortComponents(collected);
}

async function readLicenseTexts(
  directory: string,
  declared: string | null,
): Promise<readonly { readonly file: string; readonly body: string }[]> {
  const names = new Set<string>();
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.isFile() && LICENSE_FILE_PATTERN.test(entry.name)) {
      names.add(entry.name);
    }
  }
  if (declared !== null) {
    names.add(declared);
  }

  const texts: { file: string; body: string }[] = [];
  for (const name of [...names].sort()) {
    const body = await fs.readFile(path.join(directory, name), 'utf8').catch(() => null);
    if (body !== null && body.trim().length > 0) {
      texts.push({ file: name, body: body.trimEnd() });
    }
  }
  return texts;
}

function render(components: readonly Component[], bunVersion: string, ownLicense: string): string {
  const lines: string[] = [];
  lines.push('MERKUR LICENSES AND NOTICES');
  lines.push('');
  lines.push('Generated by scripts/generate-third-party-notices.ts. Do not edit by hand.');
  lines.push('');
  lines.push('Merkur is licensed under the GNU Affero General Public License v3.0, whose');
  lines.push('full text is reproduced below, except for one directory of the repository:');
  lines.push('packages/logger, under the Apache License 2.0. These executables are AGPL and');
  lines.push("include Merkur's own Apache-2.0 logger. The corresponding source is the");
  lines.push('tagged commit this build was made from, at https://github.com/merkur-sh/merkur.');
  lines.push('The rest of this file is the attribution for the third-party components');
  lines.push('compiled into the Merkur executables.');
  lines.push('');
  lines.push("MERKUR'S OWN LICENSE");
  lines.push('');
  lines.push(ownLicense.trimEnd());
  lines.push('');
  lines.push('EMBEDDED RUNTIME');
  lines.push('');
  lines.push(`The merkur executable embeds the Bun runtime (bun@${bunVersion}, MIT), which`);
  lines.push('statically links JavaScriptCore/WebKit and tinycc under the LGPL along with the');
  lines.push('components listed in https://github.com/oven-sh/bun/blob/main/LICENSE.md. To');
  lines.push('exercise the LGPL right to run a modified version of those libraries, rebuild');
  lines.push('the executable from Merkur source against your own Bun build:');
  lines.push('');
  lines.push('    bun run scripts/build-daemon-dist.ts');
  lines.push('');
  lines.push('The Bun version is pinned in the repository package.json, and the Rust');
  lines.push('executables beside it are built by scripts/build-daemon-artifacts.ts.');
  lines.push('');
  lines.push('COMPONENTS');
  lines.push('');
  for (const component of components) {
    const repository = component.repository === null ? '' : `  ${component.repository}`;
    lines.push(`  ${component.name} ${component.version}  (${component.license})${repository}`);
  }
  lines.push('');
  lines.push('LICENSE TEXTS');
  lines.push('');

  // One copy of each distinct text, listing every component it covers: the
  // notices are identical across hundreds of crates and repetition hides them.
  const groups = new Map<string, { text: string; file: string; components: string[] }>();
  const unstated: string[] = [];
  for (const component of components) {
    const label = `${component.name} ${component.version}`;
    if (component.texts.length === 0) {
      unstated.push(`${label} (${component.license})`);
      continue;
    }
    for (const text of component.texts) {
      const key = createHash('sha256').update(text.body).digest('hex');
      const group = groups.get(key);
      if (group === undefined) {
        groups.set(key, { text: text.body, file: text.file, components: [label] });
      } else if (!group.components.includes(label)) {
        group.components.push(label);
      }
    }
  }

  for (const group of [...groups.values()].sort(
    (a, b) => b.components.length - a.components.length,
  )) {
    lines.push('-'.repeat(78));
    lines.push(`${group.file}, as published with:`);
    for (const label of [...group.components].sort()) {
      lines.push(`  ${label}`);
    }
    lines.push('');
    lines.push(group.text);
    lines.push('');
  }

  if (unstated.length > 0) {
    lines.push('-'.repeat(78));
    lines.push('The following components ship no license file of their own; their license is');
    lines.push('the expression declared in their manifest, recorded above:');
    for (const label of unstated.sort()) {
      lines.push(`  ${label}`);
    }
    lines.push('');
  }
  return `${lines.join('\n').replaceAll('\r\n', '\n')}\n`;
}

function sortComponents(components: readonly Component[]): readonly Component[] {
  return [...components].sort(
    (a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version),
  );
}

function resolvePackageDirectory(name: string, from: string): string | null {
  try {
    return path.dirname(Bun.resolveSync(`${name}/package.json`, from));
  } catch {
    // Packages without a package.json export still resolve through their entry
    // point; walk up from it to the directory the manifest lives in.
    try {
      let directory = path.dirname(Bun.resolveSync(name, from));
      while (directory !== path.dirname(directory)) {
        if (path.basename(directory) === path.basename(name)) {
          return directory;
        }
        directory = path.dirname(directory);
      }
    } catch {
      return null;
    }
    return null;
  }
}

interface Manifest {
  readonly name?: string;
  readonly version?: string;
  readonly license?: string;
  readonly repository?: string | { readonly url?: string };
  readonly dependencies?: Record<string, string>;
}

async function readManifest(file: string): Promise<Manifest> {
  const body = await fs.readFile(file, 'utf8');
  return JSON.parse(body) as Manifest;
}

function readRepository(manifest: Manifest): string | null {
  const repository = manifest.repository;
  if (typeof repository === 'string') {
    return repository;
  }
  if (repository !== undefined && typeof repository.url === 'string') {
    return repository.url;
  }
  return null;
}

async function resolveBunVersion(): Promise<string> {
  const manifest = await readManifest(path.join(REPO_ROOT, 'package.json'));
  const pinned = (manifest as { readonly packageManager?: string }).packageManager;
  if (pinned === undefined || !pinned.startsWith('bun@')) {
    throw new Error('root package.json has no bun packageManager pin');
  }
  return pinned.slice('bun@'.length);
}

async function runJson(command: readonly string[]): Promise<Record<string, unknown>> {
  const child = Bun.spawn([...command], { cwd: REPO_ROOT, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, status] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (status !== 0) {
    throw new Error(`${command.join(' ')} failed with ${status}: ${stderr}`);
  }
  return JSON.parse(stdout) as Record<string, unknown>;
}
