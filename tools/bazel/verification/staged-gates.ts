import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { SECRET_SCAN_ARGUMENTS } from '../../../scripts/secret-scanning';
import pin from '../../../scripts/trufflehog.json';
import { readDeclaredInput } from './artifacts';
import {
  captureGitContext,
  type GitContext,
  type IndexEntry,
  validGitContext,
} from './git-context';
import { type GitObjectEvidence, withGitObjects } from './git-objects';
import { declaredRatchet } from './ratchet';
import { loadCapturedStaticProjections } from './ratchet-policy';
import { manifestFromInventory, type SourceManifest, validSourceManifest } from './snapshot';
import { withCapturedSourceTree } from './source-tree';

export interface DeclaredStagedTree {
  readonly root: string;
  readonly manifest: SourceManifest;
}

export interface StagedGateInputs {
  readonly index: DeclaredStagedTree;
  /** The index projection: base=candidate=HEAD; live unstaged bytes are absent. */
  readonly context: GitContext;
  readonly scratch: string;
  readonly git: string;
  readonly pack: string;
  readonly objects: GitObjectEvidence;
  readonly sdkEnvironment: Readonly<Record<string, string>>;
}

function unchanged(tree: DeclaredStagedTree): void {
  if (
    !path.isAbsolute(tree.root) ||
    !validSourceManifest(tree.manifest) ||
    manifestFromInventory(
      tree.root,
      tree.manifest.inputs.map((input) => input.path),
      tree.manifest.commit,
    ).digest !== tree.manifest.digest
  )
    throw new Error('Staged gate source bytes differ from their exact declared manifest');
}

function validate(options: StagedGateInputs): void {
  const context = options.context;
  if (
    !validGitContext(context) ||
    context.base !== context.head ||
    context.candidate !== context.head ||
    context.committed.length !== 0 ||
    context.untracked.length !== 0 ||
    context.unstaged.length !== 0 ||
    options.index.manifest.commit !== context.head ||
    JSON.stringify(options.index.manifest.inputs.map((input) => input.path)) !==
      JSON.stringify(context.index.map((entry) => entry.path))
  )
    throw new Error('Staged gates require the exact index and HEAD source projection');
  unchanged(options.index);
}

function command(options: StagedGateInputs, environment: Readonly<Record<string, string>>) {
  return (args: readonly string[], stdin?: Uint8Array): Buffer => {
    const result = Bun.spawnSync([options.git, ...args], {
      cwd: options.index.root,
      env: environment,
      stdin: stdin ?? 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    if (result.exitCode !== 0 || result.signalCode)
      throw new Error('Declared staged Git object operation failed');
    return Buffer.from(result.stdout);
  };
}

/** Parse Git's length-delimited blob protocol; embedded newlines and NULs remain bytes. */
function blobs(
  read: ReturnType<typeof command>,
  entries: readonly IndexEntry[],
): ReadonlyMap<string, Buffer> {
  const ids = [...new Set(entries.map((entry) => entry.object))];
  const result = new Map<string, Buffer>();
  if (ids.length === 0) return result;
  const bytes = read(['cat-file', '--batch'], Buffer.from(`${ids.join('\n')}\n`));
  let offset = 0;
  for (const id of ids) {
    const end = bytes.indexOf(10, offset);
    const [object, kind, rawSize] = bytes.subarray(offset, end).toString('ascii').split(' ');
    const size = Number(rawSize);
    if (
      end < offset ||
      object !== id ||
      kind !== 'blob' ||
      rawSize === undefined ||
      !/^(?:0|[1-9][0-9]*)$/.test(rawSize) ||
      !Number.isSafeInteger(size) ||
      end + 1 + size >= bytes.length ||
      bytes[end + 1 + size] !== 10
    )
      throw new Error('Declared Git blob batch is incomplete or malformed');
    result.set(id, bytes.subarray(end + 1, end + 1 + size));
    offset = end + 2 + size;
  }
  if (offset !== bytes.length) throw new Error('Declared Git blob batch contains foreign bytes');
  return result;
}

/** Use the existing pinned scanner over changed index blob bytes, including symlink text. */
export function declaredStagedSecretScan(
  options: StagedGateInputs & {
    readonly scanner: string;
  },
): number {
  validate(options);
  if (!path.isAbsolute(options.scanner)) throw new Error('Declared pinned secret scanner required');
  let verdict: number | undefined;
  withGitObjects(
    {
      executable: options.git,
      root: options.index.root,
      scratch: options.scratch,
      pack: options.pack,
      evidence: options.objects,
      context: options.context,
      sdkEnvironment: options.sdkEnvironment,
    },
    (environment) => {
      const read = command(options, environment);
      if (
        captureGitContext(
          (args) => read(args).toString(),
          options.context.head,
          options.context.head,
        ).digest !== options.context.digest
      )
        throw new Error('Declared staged index bytes differ from their Git context');
      const changed = new Set(options.context.staged);
      const entries = options.context.index.filter(
        (entry) => changed.has(entry.path) && entry.mode !== '160000',
      );
      const files = blobs(read, entries);
      const directory = mkdtempSync(path.join(options.scratch, 'staged-secrets-'));
      try {
        for (const entry of entries) {
          const data = files.get(entry.object);
          if (data === undefined) throw new Error('Declared staged secret blob is absent');
          const destination = path.join(directory, entry.path);
          mkdirSync(path.dirname(destination), { recursive: true });
          writeFileSync(destination, data, { flag: 'wx', mode: 0o600 });
        }
        if (entries.length === 0) verdict = 0;
        else {
          const version = Bun.spawnSync([options.scanner, '--version'], {
            cwd: directory,
            env: environment,
            stdin: 'ignore',
            stdout: 'pipe',
            stderr: 'pipe',
          });
          if (
            version.exitCode !== 0 ||
            version.signalCode ||
            `${version.stdout}${version.stderr}`.trim() !== `trufflehog ${pin.version}`
          )
            throw new Error('Declared secret scanner differs from the existing pinned version');
          const scan = Bun.spawnSync([options.scanner, ...SECRET_SCAN_ARGUMENTS], {
            cwd: directory,
            env: environment,
            stdin: 'ignore',
            stdout: 'inherit',
            stderr: 'inherit',
          });
          if (scan.signalCode) throw new Error('Declared staged secret scanning was cancelled');
          verdict = scan.exitCode;
        }
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
      unchanged(options.index);
      if (
        captureGitContext(
          (args) => read(args).toString(),
          options.context.head,
          options.context.head,
        ).digest !== options.context.digest
      )
        throw new Error('Declared staged context changed during secret scanning');
    },
  );
  if (verdict === undefined) throw new Error('Staged scanner did not produce a verdict');
  return verdict;
}

/** Keep exact/semantic audits, staged ceiling scope and all existing ratchet policies. */
export function declaredStagedRatchet(
  options: StagedGateInputs & {
    readonly fallow: string;
    readonly runfiles: string;
    readonly generated?: Parameters<typeof declaredRatchet>[0]['generated'];
  },
): number {
  validate(options);
  const result = declaredRatchet({
    root: options.index.root,
    source: options.index.manifest,
    scratch: options.scratch,
    git: options.git,
    fallow: options.fallow,
    runfiles: options.runfiles,
    pack: options.pack,
    objects: options.objects,
    context: options.context,
    sdkEnvironment: options.sdkEnvironment,
    generated: options.generated,
    staged: true,
  });
  unchanged(options.index);
  return result;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function captured(root: string, file: string): Promise<unknown> {
  return JSON.parse((await readDeclaredInput(root, file)).bytes.toString('utf8'));
}

/** Consume declared Files under the existing nonce-aware Bun TestRunner. */
export async function runCapturedStagedGate(args: readonly string[]): Promise<number> {
  const [operation, descriptor] = args;
  if (
    args.length !== 2 ||
    !['secrets', 'ratchet'].includes(operation ?? '') ||
    descriptor === undefined
  )
    throw new Error('A staged operation and exact declared input descriptor are required');
  const root = process.cwd();
  const spec = await captured(root, descriptor);
  const fields = [
    'index_tree',
    'index_manifest',
    'context',
    'objects',
    'object_pack',
    'projections',
  ];
  if (
    !record(spec) ||
    Object.keys(spec).sort().join(',') !== fields.sort().join(',') ||
    fields
      .filter((field) => field !== 'projections')
      .some((field) => typeof spec[field] !== 'string') ||
    (operation === 'ratchet' ? typeof spec.projections !== 'string' : spec.projections !== null)
  )
    throw new Error('The staged input descriptor is incomplete or foreign');
  const file = (field: string): string => {
    const value = spec[field];
    if (typeof value !== 'string') throw new Error('Staged input File is absent');
    if (
      value.startsWith('/') ||
      value.includes('\\') ||
      value.includes('\0') ||
      value.split('/').some((part) => part === '' || part === '.' || part === '..')
    )
      throw new Error('Staged input File must stay within declared runfiles');
    return value;
  };
  const context = await captured(root, file('context'));
  const index = await captured(root, file('index_manifest'));
  const evidence = await captured(root, file('objects'));
  if (
    !validGitContext(context) ||
    !validSourceManifest(index) ||
    !record(evidence) ||
    Object.keys(evidence).sort().join(',') !== 'contextDigest,packBytes,packDigest,shallow' ||
    typeof evidence.contextDigest !== 'string' ||
    typeof evidence.packDigest !== 'string' ||
    typeof evidence.packBytes !== 'number' ||
    !Array.isArray(evidence.shallow) ||
    !evidence.shallow.every((entry) => typeof entry === 'string')
  )
    throw new Error('Exact staged source and Git object facts are required');
  const git = process.env.MERKUR_VERIFICATION_GIT;
  const native =
    process.env[
      operation === 'secrets' ? 'MERKUR_VERIFICATION_TRUFFLEHOG' : 'MERKUR_VERIFICATION_FALLOW'
    ];
  const scratch = process.env.TEST_TMPDIR;
  const runfiles = process.env.TEST_SRCDIR;
  if (
    git === undefined ||
    !path.isAbsolute(git) ||
    native === undefined ||
    !path.isAbsolute(native) ||
    scratch === undefined ||
    !path.isAbsolute(scratch) ||
    runfiles === undefined
  )
    throw new Error('Declared native tools and engine-owned private workspace are required');
  const generated =
    operation === 'ratchet'
      ? await loadCapturedStaticProjections(root, await captured(root, file('projections')))
      : undefined;
  const sdkEnvironment = Object.fromEntries(
    [
      'DYLD_LIBRARY_PATH',
      'DYLD_FALLBACK_LIBRARY_PATH',
      'GIT_EXEC_PATH',
      'GIT_TEMPLATE_DIR',
      'OPENSSL_CONF',
      'OPENSSL_MODULES',
      'MERKUR_BAZEL_NATIVE_SDK_PREFIX',
    ].flatMap((key) => (process.env[key] === undefined ? [] : [[key, process.env[key] ?? '']])),
  );
  const indexRoot = mkdtempSync(path.join(scratch, 'staged-index-'));
  try {
    return await withCapturedSourceTree(
      { tree: path.resolve(root, file('index_tree')), root: indexRoot, source: index },
      async (indexDirectory) => {
        const options: StagedGateInputs = {
          index: { root: indexDirectory, manifest: index },
          context,
          objects: {
            contextDigest: evidence.contextDigest as string,
            packDigest: evidence.packDigest as string,
            packBytes: evidence.packBytes as number,
            shallow: evidence.shallow as string[],
          },
          pack: path.resolve(root, file('object_pack')),
          git,
          scratch,
          sdkEnvironment,
        };
        return operation === 'secrets'
          ? declaredStagedSecretScan({ ...options, scanner: native })
          : declaredStagedRatchet({ ...options, fallow: native, runfiles, generated });
      },
    );
  } finally {
    rmSync(indexRoot, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  try {
    process.exitCode = await runCapturedStagedGate(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'Staged gate failed'}\n`);
    process.exitCode = 1;
  }
}
