import { chmod, cp, lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { retainCompilerInventory } from './compiler-inventory';

const [manifestFile, mode, entry, outputFile, configuration, ...flags] = process.argv.slice(2);
if (
  manifestFile === undefined ||
  entry === undefined ||
  outputFile === undefined ||
  configuration === undefined ||
  (mode !== 'compile' && mode !== 'bundle' && mode !== 'vite')
) {
  throw new Error('Bun build requires its declared input manifest, operation, entry and output');
}
const sourceRoot = process.cwd();
const output = path.resolve(outputFile);
const inputs: Record<string, { input: string; link: boolean; owner: string; canonical: string }> =
  JSON.parse(await readFile(manifestFile, 'utf8'));
const root = await mkdtemp(path.join(os.tmpdir(), 'merkur-build-'));
function inside(relative: string): string {
  if (
    path.isAbsolute(relative) ||
    relative.includes('\\') ||
    relative.split('/').some((part) => part === '..' || part === '.' || part === '')
  ) {
    throw new Error(`Build input escaped declared repository: ${relative}`);
  }
  return path.join(root, relative);
}
async function ownCopiedDirectories(directory: string): Promise<void> {
  const info = await lstat(directory);
  if (!info.isDirectory()) return;
  // Tree artifacts are immutable inputs. Their private physical copies belong
  // to this action, including directory write permission needed for cleanup.
  await chmod(directory, info.mode | 0o700);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) await ownCopiedDirectories(path.join(directory, entry.name));
  }
}

try {
  for (const [relative, value] of Object.entries(inputs)) {
    if (
      Object.keys(value).sort().join(',') !== 'canonical,input,link,owner' ||
      typeof value.input !== 'string' ||
      typeof value.owner !== 'string' ||
      typeof value.link !== 'boolean' ||
      typeof value.canonical !== 'string'
    )
      throw new Error(
        'Build declarations require exact original File and canonical placement facts',
      );
    inside(value.canonical);
    if (relative !== value.canonical) continue;
    const destination = inside(relative);
    const source = path.resolve(sourceRoot, value.input);
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(source, destination, { recursive: true, dereference: true });
    await ownCopiedDirectories(destination);
  }
  for (const [relative, value] of Object.entries(inputs)) {
    if (relative === value.canonical) continue;
    const destination = inside(relative);
    const target = inside(value.canonical);
    // Only explicitly declared canonical Files or authored namespaces have
    // been copied. Never scan the original directory behind a workspace alias.
    await lstat(target);
    await mkdir(path.dirname(destination), { recursive: true });
    await symlink(target, destination);
  }
  const command = [
    process.execPath,
    '--no-install',
    '--no-env-file',
    `--config=${inside(configuration)}`,
  ];
  // This explicit original loader configuration also controls inventory byte accounting.
  const fileLoaderExtensions = new Set(mode === 'compile' || mode === 'bundle' ? ['.wasm'] : []);
  if (flags.some((flag) => flag === '--loader' || flag.startsWith('--loader=')))
    throw new Error('Build loaders are selected solely by the declared compiler action');
  const buildFlags = flags.map((flag) =>
    flag.startsWith('--metafile=')
      ? `--metafile=${path.resolve(sourceRoot, flag.slice('--metafile='.length))}`
      : flag,
  );
  if (mode === 'compile') {
    const runtimeFlag = '--compile-executable-path=';
    const runtimeFlags = flags.filter((flag) => flag.startsWith(runtimeFlag));
    const targets = flags.filter((flag) => flag.startsWith('--target='));
    if (runtimeFlags.length !== 1 || targets.length !== 1) {
      throw new Error('Compilation requires one declared target and pinned executable input');
    }
    const compileFlags = buildFlags.map((flag) =>
      flag.startsWith(runtimeFlag)
        ? runtimeFlag + path.resolve(sourceRoot, flag.slice(runtimeFlag.length))
        : flag,
    );
    command.push('build', inside(entry), '--compile', '--outfile', output, ...compileFlags);
  } else if (mode === 'bundle')
    command.push('build', inside(entry), ...buildFlags, '--target=bun', '--outdir', output);
  else {
    const selection = flags.at(-2);
    const vitePackage = flags.at(-1);
    if (flags.length !== 8 || selection === undefined || vitePackage === undefined)
      throw new Error('Vite requires its declared selection output');
    command.push(
      inside(entry),
      ...flags.slice(0, 1),
      output,
      ...flags.slice(1, -2),
      path.resolve(sourceRoot, manifestFile),
      sourceRoot,
      path.resolve(sourceRoot, selection),
      inside(vitePackage),
    );
  }
  if (fileLoaderExtensions.size !== 0) command.push('--loader=.wasm:file');
  const child = Bun.spawn(command, { cwd: root, stdout: 'inherit', stderr: 'inherit' });
  const status = await child.exited;
  if (status !== 0) process.exitCode = status;
  else {
    const inventory = flags.find((flag) => flag.startsWith('--metafile='));
    if (inventory !== undefined) {
      await retainCompilerInventory(
        path.resolve(sourceRoot, inventory.slice('--metafile='.length)),
        root,
        sourceRoot,
        inputs,
        mode === 'bundle'
          ? { kind: 'bundle', directory: output }
          : { kind: 'standalone', executable: output },
        fileLoaderExtensions,
      );
    }
  }
} finally {
  await rm(root, { recursive: true, force: true });
}
