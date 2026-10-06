import { cpSync, mkdirSync, readFileSync, realpathSync, statSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import { portablePath } from './portable-path';

export interface RuntimeDeclaration {
  readonly input: string;
  readonly owner: string;
  readonly link: boolean;
  readonly canonical: string;
}

interface PackageManifest {
  readonly name: string;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly peerDependencies?: Readonly<Record<string, string>>;
  readonly peerDependenciesMeta?: Readonly<Record<string, { readonly optional?: boolean }>>;
  readonly optionalDependencies?: Readonly<Record<string, string>>;
}

function portable(value: string): string {
  return portablePath(value, `Runtime package namespace escaped: ${value}`);
}

function packageName(name: string): string {
  portable(name);
  const parts = name.split('/');
  if (parts.length !== (name.startsWith('@') ? 2 : 1))
    throw new Error(`Invalid runtime dependency name: ${name}`);
  return name;
}

/** Preserve the actual declared npm dependency graph beside the original emitted JS package. */
export function materializeRolldownPackageRuntime(options: {
  readonly namespaceRoot: string;
  readonly packageDirectory: string;
  readonly output: string;
  readonly declarations: Readonly<Record<string, RuntimeDeclaration>>;
  readonly localNativeBinding: {
    readonly file: string;
    readonly replaces: readonly string[];
  };
}): void {
  const namespaceRoot = realpathSync(options.namespaceRoot);
  const rootPackage = portable(options.packageDirectory);
  const output = realpathSync(options.output);
  const copied = new Map<string, string>();
  const native = realpathSync(options.localNativeBinding.file);
  if (!native.startsWith(`${output}${path.sep}`) || !statSync(native).isFile())
    throw new Error('Original emitted native binding is missing from the runtime package');
  const replaced = new Set(options.localNativeBinding.replaces);
  const rootManifest = manifest(rootPackage);
  for (const name of replaced) {
    packageName(name);
    if (!Object.hasOwn(rootManifest.optionalDependencies ?? {}, name))
      throw new Error(`Native binding does not replace an original optional dependency: ${name}`);
  }

  function source(logical: string): string {
    const absolute = realpathSync(path.join(namespaceRoot, portable(logical)));
    if (!absolute.startsWith(`${namespaceRoot}${path.sep}`))
      throw new Error(`Runtime package escaped declared namespace: ${logical}`);
    return absolute;
  }

  function contained(original: string, entry: string): string {
    const resolved = realpathSync(entry);
    if (resolved !== original && !resolved.startsWith(`${original}${path.sep}`))
      throw new Error(`Runtime package input escaped its declared tree: ${entry}`);
    return resolved;
  }

  function resolveDependency(directory: string, name: string): string | undefined {
    packageName(name);
    let parent = directory;
    for (;;) {
      const alias = parent === '.' ? `node_modules/${name}` : `${parent}/node_modules/${name}`;
      const declaration = options.declarations[alias];
      if (declaration !== undefined) {
        const canonical = portable(declaration.canonical);
        const original = options.declarations[canonical];
        if (
          !declaration.link ||
          original === undefined ||
          !original.link ||
          original.canonical !== canonical ||
          original.owner.length === 0
        )
          throw new Error(`Runtime dependency lacks its original typed package: ${alias}`);
        return canonical;
      }
      if (parent === '.') return undefined;
      parent = path.posix.dirname(parent);
    }
  }

  function manifest(directory: string): PackageManifest {
    const original = source(directory);
    const value = JSON.parse(
      readFileSync(contained(original, path.join(original, 'package.json')), 'utf8'),
    ) as PackageManifest;
    if (typeof value.name !== 'string')
      throw new Error(`Runtime package has no original name: ${directory}`);
    return value;
  }

  function install(directory: string, destination: string, isRoot: boolean): void {
    const info = manifest(directory);
    if (isRoot && info.name !== 'rolldown')
      throw new Error('Runtime root must be original Rolldown');
    const required = new Set(Object.keys(info.dependencies ?? {}));
    for (const name of Object.keys(info.peerDependencies ?? {})) {
      if (!info.peerDependenciesMeta?.[name]?.optional) required.add(name);
    }
    const optional = Object.keys(info.optionalDependencies ?? {}).filter(
      (name) => !(isRoot && replaced.has(name)),
    );
    for (const name of new Set([...required, ...optional])) {
      const canonical = resolveDependency(directory, name);
      if (canonical === undefined) {
        if (required.has(name))
          throw new Error(`Missing declared runtime dependency: ${info.name} -> ${name}`);
        continue;
      }
      let target = copied.get(canonical);
      if (target === undefined) {
        target = path.join(output, 'node_modules/.store', canonical);
        copied.set(canonical, target);
        const original = source(canonical);
        mkdirSync(path.dirname(target), { recursive: true });
        cpSync(original, target, {
          recursive: true,
          dereference: true,
          errorOnExist: true,
          force: false,
          filter: (entry) => {
            if (entry === path.join(original, 'node_modules')) return false;
            contained(original, entry);
            return true;
          },
        });
        install(canonical, target, false);
      }
      const alias = path.join(destination, 'node_modules', name);
      mkdirSync(path.dirname(alias), { recursive: true });
      symlinkSync(path.relative(path.dirname(alias), target), alias);
    }
  }
  install(rootPackage, output, true);
}
