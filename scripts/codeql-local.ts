/**
 * The JavaScript analysis `.github/workflows/codeql.yml` runs on `main`, run here over the files a
 * commit stages, before the commit lands:
 *
 *   bun run setup:codeql   install the CLI bundle the workflow's pinned codeql-action installs
 *   bun run check:codeql   analyze the staged JavaScript and TypeScript; any finding fails
 *
 * The pre-commit hook runs `check:codeql`. The analysis is the workflow's: the bundle its pinned
 * action names, Merkur's suite (security-extended and Merkur's queries) and Merkur's models, which
 * `database create` reads from `.github/codeql/extensions` under the code-scanning config, whose
 * `paths-ignore` also applies. Only the staged files are extracted, so a flow that runs through an
 * unstaged file is the workflow's to find.
 */
import { createReadStream, existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { Schema } from 'effect';

const root = path.resolve(import.meta.dir, '..');
const workflow = path.join(root, '.github/workflows/codeql.yml');
const config = path.join(root, '.github/codeql/codeql-config.yml');
const suite = path.join(root, 'tools/codeql/javascript/src/merkur-javascript.qls');
const models = path.join(root, 'tools/codeql/javascript/models');
const EXTENSIONS = /\.(?:[cm]?[jt]s|[jt]sx)$/;

/** The codeql-action commit the workflow pins; its bundle is the one installed here. */
async function actionCommit(): Promise<string> {
  const match = (await readFile(workflow, 'utf8')).match(
    /github\/codeql-action\/init@([0-9a-f]{40})/,
  );
  if (match?.[1] === undefined) throw new Error(`${workflow} pins no codeql-action commit`);
  return match[1];
}

/** Where the bundle for `commit` lives: one directory per pinned action commit. */
function installation(commit: string): string {
  const cache =
    process.platform === 'darwin'
      ? path.join(homedir(), 'Library/Caches')
      : (process.env.XDG_CACHE_HOME ?? path.join(homedir(), '.cache'));
  return path.join(cache, 'merkur-codeql', commit);
}

function bundleAsset(): string {
  if (process.platform === 'darwin') return 'codeql-bundle-osx64.tar.gz';
  if (process.platform === 'linux' && process.arch === 'x64') return 'codeql-bundle-linux64.tar.gz';
  if (process.platform === 'linux' && process.arch === 'arm64')
    return 'codeql-bundle-linux-arm64.tar.gz';
  throw new Error(`no CodeQL bundle for ${process.platform} ${process.arch}`);
}

async function run(command: string[], cwd = root): Promise<string> {
  const child = Bun.spawn(command, { cwd, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`${command.join(' ')} failed (${code}):\n${stderr}`);
  return stdout;
}

const Defaults = Schema.Struct({ bundleVersion: Schema.String, cliVersion: Schema.String });
const Release = Schema.Struct({
  assets: Schema.Array(
    Schema.Struct({ name: Schema.String, digest: Schema.NullOr(Schema.String) }),
  ),
});

async function setup(): Promise<void> {
  const commit = await actionCommit();
  const target = installation(commit);
  const defaults = Schema.decodeUnknownSync(Defaults)(
    JSON.parse(
      await run([
        'curl',
        '-fsSL',
        `https://raw.githubusercontent.com/github/codeql-action/${commit}/src/defaults.json`,
      ]),
    ),
  );
  const { bundleVersion, cliVersion } = defaults;
  if (!/^codeql-bundle-v\d+\.\d+\.\d+$/.test(bundleVersion) || !/^\d+\.\d+\.\d+$/.test(cliVersion))
    throw new Error(`codeql-action ${commit} names no bundle release`);
  const asset = bundleAsset();
  const release = Schema.decodeUnknownSync(Release)(
    JSON.parse(
      await run([
        'curl',
        '-fsSL',
        `https://api.github.com/repos/github/codeql-action/releases/tags/${bundleVersion}`,
      ]),
    ),
  );
  const digest = release.assets.find(({ name }) => name === asset)?.digest;
  if (digest === undefined || digest === null || !/^sha256:[0-9a-f]{64}$/.test(digest))
    throw new Error(`${bundleVersion} publishes no SHA-256 for ${asset}`);
  const scratch = await mkdtemp(path.join(tmpdir(), 'merkur-codeql-setup-'));
  try {
    const archive = path.join(scratch, asset);
    process.stdout.write(`downloading ${bundleVersion} ${asset}\n`);
    await run([
      'curl',
      '-fsSL',
      '-o',
      archive,
      `https://github.com/github/codeql-action/releases/download/${bundleVersion}/${asset}`,
    ]);
    const hasher = new Bun.CryptoHasher('sha256');
    for await (const chunk of createReadStream(archive)) hasher.update(chunk);
    if (`sha256:${hasher.digest('hex')}` !== digest)
      throw new Error(`${asset} does not match the release's ${digest}`);
    await rm(target, { recursive: true, force: true });
    await mkdir(target, { recursive: true });
    await run(['tar', '-xzf', archive, '-C', target]);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
  const version = await run([path.join(target, 'codeql/codeql'), 'version', '--format=terse']);
  if (version.trim() !== cliVersion)
    throw new Error(`installed CodeQL ${version.trim()}, not ${cliVersion}`);
  process.stdout.write(`CodeQL ${cliVersion} for codeql-action ${commit} in ${target}\n`);
}

const Config = Schema.Struct({ 'paths-ignore': Schema.optional(Schema.Array(Schema.String)) });
const Sarif = Schema.Struct({
  runs: Schema.Array(
    Schema.Struct({
      results: Schema.Array(
        Schema.Struct({
          ruleId: Schema.String,
          message: Schema.Struct({ text: Schema.String }),
          locations: Schema.Array(
            Schema.Struct({
              physicalLocation: Schema.Struct({
                artifactLocation: Schema.Struct({ uri: Schema.String }),
                region: Schema.Struct({ startLine: Schema.Number }),
              }),
            }),
          ),
        }),
      ),
    }),
  ),
});

/** The staged JavaScript and TypeScript the code-scanning config does not ignore. */
async function stagedSources(): Promise<string[]> {
  const ignored = (
    Schema.decodeUnknownSync(Config)(Bun.YAML.parse(await readFile(config, 'utf8')))[
      'paths-ignore'
    ] ?? []
  ).map((pattern) => new Bun.Glob(pattern.endsWith('/**') ? pattern : `${pattern}{,/**}`));
  return (await run(['git', 'diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z']))
    .split('\0')
    .filter((file) => EXTENSIONS.test(file) && !ignored.some((glob) => glob.match(file)));
}

async function check(): Promise<void> {
  const files = await stagedSources();
  if (files.length === 0) return;
  const codeql = path.join(installation(await actionCommit()), 'codeql/codeql');
  if (!existsSync(codeql))
    throw new Error('CodeQL for the pinned codeql-action is missing: bun run setup:codeql');
  const scratch = await mkdtemp(path.join(tmpdir(), 'merkur-codeql-'));
  try {
    const source = path.join(scratch, 'src');
    for (const file of files) {
      await mkdir(path.dirname(path.join(source, file)), { recursive: true });
      await writeFile(path.join(source, file), await run(['git', 'show', `:${file}`]));
    }
    // Where the workflow puts its one language's model pack, which `database create` stores.
    await cp(models, path.join(source, '.github/codeql/extensions/models'), { recursive: true });
    const database = path.join(scratch, 'db');
    await run(
      [
        codeql,
        'database',
        'create',
        database,
        '--language=javascript',
        `--source-root=${source}`,
        `--codescanning-config=${config}`,
      ],
      source,
    );
    const sarif = path.join(scratch, 'results.sarif');
    await run([
      codeql,
      'database',
      'analyze',
      database,
      suite,
      `--additional-packs=${root}`,
      '--format=sarif-latest',
      `--output=${sarif}`,
    ]);
    const findings = Schema.decodeUnknownSync(Sarif)(JSON.parse(await readFile(sarif, 'utf8')))
      .runs.flatMap(({ results }) => results)
      .map(({ ruleId, message, locations }) => {
        const where = locations[0]?.physicalLocation;
        return `${where?.artifactLocation.uri}:${where?.region.startLine} ${ruleId}: ${message.text}`;
      });
    if (findings.length > 0)
      throw new Error(`CodeQL finds what code scanning would report:\n${findings.join('\n')}`);
    process.stdout.write(`check:codeql: pass (${files.length} staged files)\n`);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

const mode = process.argv[2];
if (mode === 'setup') await setup();
else if (mode === 'staged') await check();
else throw new Error('Usage: bun scripts/codeql-local.ts setup|staged');
