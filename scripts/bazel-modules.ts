/**
 * The files each Bun test loads (`tools/bazel/modules.bzl`).
 *
 * A Bun test runs over a checkout of exactly what its test file loads, so it reruns only when one
 * of those files changes. A file loads the modules it imports, as Bun resolves them, and the files
 * it names relative to itself with a literal `new URL('…', import.meta.url)` or
 * `import.meta.resolve('…')`: a directory so named, every file Git sees in it, and the
 * repository's root, the whole checkout. Bun reads its nearest `package.json` and `tsconfig.json`
 * (with what that extends) to resolve and transpile it. Each such file is a target,
 * `<path>.module`, in the Bazel package that owns it: the file and every file it loads.
 * `bun_test_files` (`tools/bazel/bun/bun.bzl`) gives each test its file's target. What a test reads
 * by any other name, it declares in its package's `BUILD.bazel`.
 *
 * The graph starts from the test files of every package that declares `bun_test_files`, from the
 * preloads `bunfig.toml` names, and from every file a `BUILD.bazel` names by its module target: a
 * script a test runs, a fixture it reads by a computed path. Installed dependencies are not part
 * of it: a test links every package's from the lockfile. `bun run scripts/bazel-sources.ts`
 * writes this file with the rest.
 */

import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { Predicate, Schema } from 'effect';
import { type Argument, type Expression, parseSync, Visitor } from 'oxc-parser';
import { typeProjects } from './check-types';

export const MODULES = 'tools/bazel/modules.bzl';

/** The generated WebAssembly packages a module may import, by directory, with their targets. */
const WASM_PACKAGES: readonly (readonly [string, string])[] = [
  ['apps/web/src/term-wasm/pkg', '//apps/web:term_wasm_files'],
  ['packages/e2e-wasm/pkg', '//packages/e2e-wasm:pkg_files'],
  ['packages/graphics-codec-probe/pkg', '//packages/graphics-codec-probe:pkg_files'],
  ['packages/graphics-wasm/pkg', '//packages/graphics-wasm:pkg_files'],
  ['packages/term-wasm/pkg', '//packages/term-wasm:pkg_files'],
];

/**
 * What a module that names the repository's root directory reads: the whole checkout, with every
 * package's installed dependencies, as a test declaring `checkout` holds it.
 */
const CHECKOUT = ['//:sources', '//:test_node_modules', '//:wasm_packages'];

const CODE = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const TEST = /\.test\.tsx?$/;
const TSCONFIG = /(?:^|\/)tsconfig[^/]*\.json$/;

/** Runtime builtins, and the modules Vite's plugins make, which are no files. */
const NOT_FILES = /^(?:bun|node|virtual):/;

const Bunfig = Schema.Struct({
  test: Schema.optional(Schema.Struct({ preload: Schema.optional(Schema.Array(Schema.String)) })),
});

const TsconfigOptions = Schema.Struct({
  extends: Schema.optional(Schema.Union([Schema.String, Schema.Array(Schema.String)])),
});
type TsconfigOptions = typeof TsconfigOptions.Type;

const Importer = Schema.Struct({
  dependencies: Schema.optional(
    Schema.Record(Schema.String, Schema.Struct({ version: Schema.String })),
  ),
  devDependencies: Schema.optional(
    Schema.Record(Schema.String, Schema.Struct({ version: Schema.String })),
  ),
  optionalDependencies: Schema.optional(
    Schema.Record(Schema.String, Schema.Struct({ version: Schema.String })),
  ),
});
const Lockfile = Schema.Struct({ importers: Schema.Record(Schema.String, Importer) });

/**
 * Each pnpm importer's direct dependencies, by its directory (the root's is ''): the third-party
 * ones, which its `:node_modules` links from the store, and the workspace packages it links.
 */
export function importerDependencies(root: string): [string, string[], string[]][] {
  const { importers } = Schema.decodeUnknownSync(Lockfile)(
    Bun.YAML.parse(readFileSync(path.join(root, 'pnpm-lock.yaml'), 'utf8')),
    { onExcessProperty: 'ignore' },
  );
  return Object.entries(importers)
    .map(([directory, importer]): [string, string[], string[]] => {
      const dependencies = Object.entries({
        ...importer.dependencies,
        ...importer.devDependencies,
        ...importer.optionalDependencies,
      });
      const workspace = ({ version }: { version: string }) => version.startsWith('link:');
      return [
        directory === '.' ? '' : directory,
        dependencies.flatMap(([name, spec]) => (workspace(spec) ? [] : [name])).sort(),
        dependencies.flatMap(([name, spec]) => (workspace(spec) ? [name] : [])).sort(),
      ];
    })
    .sort(([a], [b]) => a.localeCompare(b));
}

/** A name a module gives another file: an import or `import.meta.resolve`, or a literal URL. */
type Reference =
  | { readonly kind: 'specifier'; readonly specifier: string }
  | { readonly kind: 'url'; readonly relative: string };

/** Where a referenced path lies: a file Git sees, a generated package, or installed code. */
type Place = { readonly file: string } | { readonly target: string } | 'installed' | 'nowhere';

/** `URL` or `globalThis.URL`. */
function isUrl(callee: Expression): boolean {
  if (callee.type === 'Identifier') return callee.name === 'URL';
  return (
    callee.type === 'MemberExpression' &&
    !callee.computed &&
    callee.object.type === 'Identifier' &&
    callee.object.name === 'globalThis' &&
    callee.property.type === 'Identifier' &&
    callee.property.name === 'URL'
  );
}

/** `import.meta.<property>`. */
function isImportMeta(node: Argument | Expression | undefined, property: string): boolean {
  return (
    node?.type === 'MemberExpression' &&
    !node.computed &&
    node.property.type === 'Identifier' &&
    node.property.name === property &&
    node.object.type === 'MetaProperty' &&
    node.object.meta.name === 'import'
  );
}

/** The string a literal or a template without substitutions spells. */
function literal(node: Argument | undefined): string | undefined {
  if (node?.type === 'Literal' && Predicate.isString(node.value)) return node.value;
  if (node?.type === 'TemplateLiteral' && node.expressions.length === 0)
    return node.quasis[0]?.value.cooked ?? undefined;
  return undefined;
}

/** What `source` names relative to itself: literal URLs and `import.meta.resolve` calls. */
export function namedReferences(file: string, source: string): Reference[] {
  const parsed = parseSync(file, source);
  const first = parsed.errors[0];
  if (first !== undefined) throw new Error(`${file}: ${first.message}`);
  const named: Reference[] = [];
  new Visitor({
    NewExpression(node) {
      const relative = literal(node.arguments[0]);
      if (isUrl(node.callee) && isImportMeta(node.arguments[1], 'url') && relative !== undefined)
        named.push({ kind: 'url', relative });
    },
    CallExpression(node) {
      const specifier = literal(node.arguments[0]);
      if (isImportMeta(node.callee, 'resolve') && specifier !== undefined)
        named.push({ kind: 'specifier', specifier });
    },
  }).visit(parsed.program);
  return named;
}

/** Every file Git sees, tracked or not yet added, minus what it ignores. */
function gitFiles(root: string): Set<string> {
  const listing = Bun.spawnSync(['git', 'ls-files', '--cached', '--others', '--exclude-standard'], {
    cwd: root,
    stdout: 'pipe',
    stderr: 'inherit',
  });
  if (listing.exitCode !== 0) throw new Error('git ls-files failed');
  return new Set(listing.stdout.toString().split('\n').filter(Boolean));
}

class Graph {
  readonly #root: string;
  readonly #files: Set<string>;
  /** Package directories, longest first, so the first prefix that matches owns a file. */
  readonly #packages: string[];
  readonly #transpilers = new Map<string, Bun.Transpiler>();
  readonly #configs = new Map<string, TsconfigOptions>();
  /** Each pnpm importer's third-party dependencies, by its directory. */
  readonly #installed: Map<string, string[]>;
  /** Each module, by its path, with the targets of what it loads. */
  readonly modules = new Map<string, Set<string>>();
  readonly errors: string[] = [];

  constructor(root: string, packages: readonly string[]) {
    this.#root = root;
    this.#files = gitFiles(root);
    this.#packages = [...packages].sort((a, b) => b.length - a.length);
    this.#installed = new Map(
      importerDependencies(root).map(([directory, thirdParty]) => [directory, thirdParty]),
    );
  }

  /** The package that owns `file`: the nearest directory above it with a `BUILD.bazel`. */
  owner(file: string): string {
    return this.#packages.find((directory) => file.startsWith(`${directory}/`)) ?? '';
  }

  /** The label of the module target for `file`, as written in `from`'s package. */
  label(file: string, from: string): string {
    const owner = this.owner(file);
    const name = `${owner === '' ? file : file.slice(owner.length + 1)}.module`;
    return owner === from ? `:${name}` : `//${owner}:${name}`;
  }

  /** Whether Git sees `file`. */
  has(file: string): boolean {
    return this.#files.has(file);
  }

  /** The files Git sees that match `pattern`. */
  files(pattern: RegExp): string[] {
    return [...this.#files].filter((file) => pattern.test(file)).sort();
  }

  /**
   * What `tsc` reads to check `project`: the files of its program, as `tsc` itself lists them,
   * each one's nearest `package.json`, and the project's configuration with what it extends.
   * Files Git sees are returned; generated packages go in `targets`.
   */
  typeInputs(project: string, targets: Set<string>): Set<string> {
    // `--noEmit` as `check:types` checks it: an emit setting's diagnostic is no listing's.
    const listing = Bun.spawnSync(['bunx', 'tsc', '--listFilesOnly', '--noEmit', '-p', project], {
      cwd: this.#root,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    if (listing.exitCode !== 0)
      throw new Error(`tsc --listFilesOnly -p ${project}: ${listing.stderr.toString()}`);
    const files = new Set<string>();
    for (const listed of listing.stdout.toString().split('\n').filter(Boolean)) {
      const file = this.#fileAt(listed, targets, `${project}: tsc reads ${listed}`);
      if (file !== undefined) files.add(file);
    }
    for (const file of [...files]) {
      const manifest = this.#nearest(file, 'package.json');
      if (manifest !== undefined) files.add(manifest);
    }
    const configs = [project];
    for (let config = configs.pop(); config !== undefined; config = configs.pop()) {
      files.add(config);
      configs.push(...this.#extended(config));
    }
    return files;
  }

  /** Adds `start` and everything it loads. */
  add(start: string): void {
    const pending = [start];
    for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
      if (this.modules.has(file)) continue;
      const loads = new Set<string>();
      this.modules.set(file, loads);
      const from = this.owner(file);
      for (const dependency of this.#loads(file, loads)) {
        loads.add(this.label(dependency, from));
        pending.push(dependency);
      }
    }
  }

  /** The repository files `file` loads; the generated packages and checkouts go in `targets`. */
  #loads(file: string, targets: Set<string>): string[] {
    if (TSCONFIG.test(file)) return this.#extended(file);
    // A package's manifest brings the third-party packages its `node_modules` links, which Bun
    // resolves the package's bare imports through.
    if (path.posix.basename(file) === 'package.json') {
      const directory = path.posix.dirname(file);
      const importer = directory === '.' ? '' : directory;
      for (const dependency of this.#installed.get(importer) ?? [])
        targets.add(`//${importer}:node_modules/${dependency}`);
      return [];
    }
    if (!CODE.test(file)) return [];
    const absolute = path.join(this.#root, file);
    const source = readFileSync(absolute, 'utf8');
    const loaded = [this.#nearest(file, 'package.json'), this.#nearest(file, 'tsconfig.json')];
    const imports = this.#transpiler(file)
      .scan(source)
      .imports.map(({ path: specifier }): Reference => ({ kind: 'specifier', specifier }));
    for (const reference of [...imports, ...namedReferences(file, source)]) {
      for (const [name, target] of this.#targets(reference, absolute, targets)) {
        const named = this.#fileAt(
          target,
          targets,
          `${file}: ${name} names ${target ?? 'nothing'}`,
        );
        if (named !== file) loaded.push(named);
      }
    }
    return loaded.filter(Predicate.isNotUndefined);
  }

  /**
   * The file Git sees at `target`. A generated package goes in `targets` instead, installed code
   * is no file of the checkout, and anything else is an error, which `reference` names.
   */
  #fileAt(target: string | undefined, targets: Set<string>, reference: string): string | undefined {
    const place = target === undefined ? 'nowhere' : this.#place(target);
    if (place === 'nowhere') this.errors.push(`${reference}, no file Git sees`);
    else if (place !== 'installed' && 'target' in place) targets.add(place.target);
    else if (place !== 'installed') return place.file;
    return undefined;
  }

  /** The absolute paths a reference from `absolute` names, by what it named them. */
  #targets(
    reference: Reference,
    absolute: string,
    targets: Set<string>,
  ): [string, string | undefined][] {
    if (reference.kind === 'specifier') {
      if (NOT_FILES.test(reference.specifier)) return [];
      const target = this.#resolve(reference.specifier, path.dirname(absolute));
      // A builtin resolves to its bare name.
      return target !== undefined && !path.isAbsolute(target)
        ? []
        : [[reference.specifier, target]];
    }
    const named = decodeURI(new URL(reference.relative, Bun.pathToFileURL(absolute)).pathname);
    if (statSync(named, { throwIfNoEntry: false })?.isDirectory() !== true)
      return [[reference.relative, named]];
    // A directory's files are read by names its source computes: all of them, and the
    // repository's are the whole checkout.
    if (this.#relative(named) === '') {
      for (const target of CHECKOUT) targets.add(target);
      return [];
    }
    return this.#within(named).map((inside) => [reference.relative, inside]);
  }

  #resolve(specifier: string, directory: string): string | undefined {
    try {
      return Bun.resolveSync(specifier, directory);
    } catch (error) {
      if (error instanceof ResolveMessage) return undefined;
      throw error;
    }
  }

  /** The nearest file named `name` in `file`'s directory or above it. */
  #nearest(file: string, name: string): string | undefined {
    for (let directory = path.posix.dirname(file); ; directory = path.posix.dirname(directory)) {
      const candidate = directory === '.' ? name : `${directory}/${name}`;
      if (this.#files.has(candidate)) return candidate;
      if (directory === '.') return undefined;
    }
  }

  #tsconfig(file: string): TsconfigOptions {
    const known = this.#configs.get(file);
    if (known !== undefined) return known;
    const options = Schema.decodeUnknownSync(TsconfigOptions)(
      Bun.JSONC.parse(readFileSync(path.join(this.#root, file), 'utf8')),
      { onExcessProperty: 'ignore' },
    );
    this.#configs.set(file, options);
    return options;
  }

  /** The configurations `tsconfig` extends that the checkout holds, nearest first. */
  #extended(tsconfig: string): string[] {
    const parents = this.#tsconfig(tsconfig).extends;
    return (parents === undefined ? [] : [parents].flat()).flatMap((parent) => {
      // A package's configuration is installed, not the checkout's.
      if (!parent.startsWith('.')) return [];
      const file = path.posix.normalize(path.posix.join(path.posix.dirname(tsconfig), parent));
      return [file.endsWith('.json') ? file : `${file}.json`];
    });
  }

  /**
   * The transpiler for `file`'s loader. Its full scan lists what the file imports once Bun has
   * transpiled it, without the JSX runtime, which Bun injects from an installed package.
   */
  #transpiler(file: string): Bun.Transpiler {
    const loader = file.endsWith('x') ? (file.endsWith('.tsx') ? 'tsx' : 'jsx') : 'ts';
    const known = this.#transpilers.get(loader);
    if (known !== undefined) return known;
    const transpiler = new Bun.Transpiler({ loader });
    this.#transpilers.set(loader, transpiler);
    return transpiler;
  }

  /** An existing path's place in the repository, `''` for its root. */
  #relative(absolute: string): string {
    return path.relative(this.#root, realpathSync(absolute)).split(path.sep).join('/');
  }

  /** The absolute paths of the files Git sees under a directory, or its generated package. */
  #within(absolute: string): string[] {
    const directory = this.#relative(absolute);
    for (const [generated] of WASM_PACKAGES)
      if (directory === generated || directory.startsWith(`${generated}/`))
        return [path.join(this.#root, generated)];
    return [...this.#files].flatMap((file) =>
      file.startsWith(`${directory}/`) ? [path.join(this.#root, file)] : [],
    );
  }

  /** Where an absolute path lies, once its links are followed. */
  #place(absolute: string): Place {
    if (!existsSync(absolute)) return 'nowhere';
    const file = this.#relative(absolute);
    if (file.startsWith('../') || /(?:^|\/)node_modules\//.test(file)) return 'installed';
    for (const [directory, target] of WASM_PACKAGES)
      if (file === directory || file.startsWith(`${directory}/`)) return { target };
    return this.#files.has(file) ? { file } : 'nowhere';
  }
}

/** The packages whose `BUILD.bazel` declares `bun_test_files`, whose test files start the graph. */
function testPackages(packages: readonly string[], root: string): Set<string> {
  return new Set(
    packages.filter((directory) =>
      /^bun_test_files\(/m.test(readFileSync(path.join(root, directory, 'BUILD.bazel'), 'utf8')),
    ),
  );
}

/**
 * The files the `BUILD.bazel` files name by their module target, `":<path>.module"` or
 * `"//<package>:<path>.module"`: what a test runs or reads beyond what its file loads.
 */
function declaredModules(packages: readonly string[], root: string): string[] {
  const declared: string[] = [];
  for (const directory of packages) {
    const build = readFileSync(path.join(root, directory, 'BUILD.bazel'), 'utf8');
    for (const [, owner, name] of build.matchAll(/"(?:\/\/([^:"]*))?:([^"]+)\.module"/g)) {
      if (name === undefined) continue;
      const within = owner ?? directory;
      declared.push(within === '' ? name : `${within}/${name}`);
    }
  }
  return declared;
}

/** The preloads `bunfig.toml` names, from the repository's root. */
function preloads(root: string): string[] {
  const { test } = Schema.decodeUnknownSync(Bunfig)(
    Bun.TOML.parse(readFileSync(path.join(root, 'bunfig.toml'), 'utf8')),
    { onExcessProperty: 'ignore' },
  );
  return (test?.preload ?? []).map((file) => path.posix.normalize(file));
}

/** `MODULES`'s entries: each package's modules, by path within it, with what each loads. */
function modulesBzl(graph: Graph): string[] {
  const byPackage = new Map<string, [string, string[]][]>();
  for (const [file, loads] of graph.modules) {
    const owner = graph.owner(file);
    const name = owner === '' ? file : file.slice(owner.length + 1);
    byPackage.set(owner, [...(byPackage.get(owner) ?? []), [name, [...loads].sort()]]);
  }
  return [...byPackage]
    .sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([owner, entries]) => [
      `    "${owner}": {`,
      ...entries
        .sort(([a], [b]) => a.localeCompare(b))
        .flatMap(([name, loads]) =>
          loads.length === 0
            ? [`        "${name}": [],`]
            : [
                `        "${name}": [`,
                ...loads.map((load) => `            "${load}",`),
                '        ],',
              ],
        ),
      '    },',
    ]);
}

/** `TYPE_INPUTS` and `TYPE_PROJECTS`: what each project's `tsc` reads, by package and by project. */
function typesBzl(graph: Graph, root: string): [string[], string[]] {
  const byPackage = new Map<string, Map<string, string[]>>();
  const projects: string[] = [];
  for (const project of typeProjects(root)) {
    const targets = new Set<string>();
    const owners = new Set<string>();
    for (const file of graph.typeInputs(project, targets)) {
      const owner = graph.owner(file);
      const inputs = byPackage.get(owner) ?? new Map<string, string[]>();
      inputs.set(project, [
        ...(inputs.get(project) ?? []),
        owner === '' ? file : file.slice(owner.length + 1),
      ]);
      byPackage.set(owner, inputs);
      owners.add(owner);
    }
    const labels = [...[...owners].map((owner) => `//${owner}:type_inputs/${project}`), ...targets];
    projects.push(
      `    "${project}": [`,
      ...labels.sort().map((label) => `        "${label}",`),
      '    ],',
    );
  }
  const inputs = [...byPackage]
    .sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([owner, byProject]) => [
      `    "${owner}": {`,
      ...[...byProject]
        .sort(([a], [b]) => a.localeCompare(b))
        .flatMap(([project, files]) => [
          `        "${project}": [`,
          ...files.sort().map((file) => `            "${file}",`),
          '        ],',
        ]),
      '    },',
    ]);
  return [inputs, projects];
}

/** `tools/bazel/modules.bzl`, for the checkout at `root` and its Bazel packages. */
export function bazelModules(root: string, packages: readonly string[]): string {
  const graph = new Graph(root, packages);
  const tested = testPackages(packages, root);
  for (const file of declaredModules(packages, root)) {
    if (!graph.has(file)) graph.errors.push(`a BUILD.bazel names ${file}.module: no such file`);
    else graph.add(file);
  }
  const preloaded = preloads(root);
  for (const file of preloaded) graph.add(file);
  for (const file of graph.files(TEST)) if (tested.has(graph.owner(file))) graph.add(file);
  const [typeInputs, typeProjectInputs] = typesBzl(graph, root);
  if (graph.errors.length > 0) throw new Error(graph.errors.sort().join('\n'));
  return [
    '"""Generated by scripts/bazel-modules.ts: every file a Bun test loads, by the package that',
    'owns it, with the module targets of the files it loads, and the files each TypeScript',
    'project\'s `tsc` reads."""',
    '',
    'MODULES = {',
    ...modulesBzl(graph),
    '}',
    '',
    '# The preloads `bunfig.toml` names, which every Bun test loads first.',
    'PRELOADS = [',
    ...preloaded.map((file) => `    "${graph.label(file, '')}",`),
    ']',
    '',
    "# The files each project's `tsc` reads, by the package that owns them, as each package's",
    '# `type_inputs/<project>`.',
    'TYPE_INPUTS = {',
    ...typeInputs,
    '}',
    '',
    '# Each TypeScript project (`scripts/check-types.ts`), with the targets of what its `tsc` reads.',
    'TYPE_PROJECTS = {',
    ...typeProjectInputs,
    '}',
    '',
  ].join('\n');
}
