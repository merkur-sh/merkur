import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { greenTestFiles } from '../../../scripts/verification-junit';
import { materializeBunRuntime, runtimeMember } from './runtime-materializer';

const [manifestFile, runfilesRoot, ...inventory] = process.argv.slice(2);
if (manifestFile === undefined || runfilesRoot === undefined)
  throw new Error('Bazel Bun test requires its explicit runtime manifest and runfiles root');
const manifest: {
  files: Record<string, { runfile: string; link: boolean }>;
  cwd: string;
  config: string;
} = JSON.parse(await readFile(manifestFile, 'utf8'));
const scratch = process.env.TEST_TMPDIR;
if (scratch === undefined) throw new Error('Bazel test scratch directory is absent');
const runtimeRoot = await mkdtemp(path.join(scratch, 'bun-runtime-'));
await materializeBunRuntime(manifest, runfilesRoot, runtimeRoot);
const inside = runtimeMember;
const cwd = inside(runtimeRoot, manifest.cwd);
const commandMode = inventory[0] === '--command';
const selected = commandMode ? [] : inventory.map((file) => inside(runtimeRoot, file));
let command: string[];
let report: string | undefined;
if (commandMode) {
  const [verb, script, ...args] = inventory.slice(1);
  if (verb !== 'run' || script === undefined)
    throw new Error('Bazel Bun command requires its explicit run script');
  const relative = script.startsWith('./') ? script.slice(2) : script;
  const entry = manifest.files[relative];
  if (entry === undefined || entry.link)
    throw new Error('Bazel Bun command script must be an explicit copied runtime File');
  command = ['run', inside(runtimeRoot, relative), ...args];
} else {
  if (selected.length === 0) throw new Error('Bazel Bun test has no declared test files');
  const directory = process.env.TEST_UNDECLARED_OUTPUTS_DIR ?? process.env.TEST_TMPDIR;
  if (directory === undefined) throw new Error('Bazel test output directory is absent');
  await mkdir(directory, { recursive: true });
  report = path.join(directory, 'bun-junit.xml');
  await rm(report, { force: true });
  // The target declares this test's deadline and the engine enforces it. Bun's own default of
  // five seconds for each case would be a second, undeclared one beneath it.
  const deadline = Number(process.env.TEST_TIMEOUT);
  if (!Number.isSafeInteger(deadline) || deadline <= 0)
    throw new Error('Bazel test deadline is absent');
  command = [
    'test',
    ...selected,
    `--timeout=${deadline * 1000}`,
    '--reporter=junit',
    '--reporter-outfile',
    report,
  ];
}
const sdkPrefix = process.env.MERKUR_BAZEL_NATIVE_SDK_PREFIX;
const nativeEnvironment: Record<string, string> = {};
if (sdkPrefix !== undefined) {
  // The engine supplied this exact checksum-pinned SDK payload. Use its physical
  // prefix consistently for executable and loader identities across runfiles trees.
  const prefix = await realpath(sdkPrefix);
  nativeEnvironment.MERKUR_BAZEL_NATIVE_SDK_PREFIX = prefix;
  if (process.platform === 'linux') nativeEnvironment.LD_LIBRARY_PATH = path.join(prefix, 'lib');
  // Preserve absolute Apple OS libraries before resolving absent package paths
  // from this declared SDK; GNU libiconv cannot replace Apple's iconv ABI.
  else nativeEnvironment.DYLD_FALLBACK_LIBRARY_PATH = path.join(prefix, 'lib');
  nativeEnvironment.GIT_EXEC_PATH = path.join(prefix, 'libexec/git-core');
  nativeEnvironment.GIT_TEMPLATE_DIR = path.join(prefix, 'share/git-core/templates');
  nativeEnvironment.OPENSSL_CONF = path.join(prefix, 'ssl/openssl.cnf');
  nativeEnvironment.OPENSSL_MODULES = path.join(prefix, 'lib/ossl-modules');
  nativeEnvironment.PATH = `${path.join(prefix, 'bin')}:${process.env.PATH ?? ''}`;
}
const executableRoot = process.env.MERKUR_BAZEL_EXECUTABLE_ROOT;
if (executableRoot !== undefined && !path.isAbsolute(executableRoot))
  throw new Error('MERKUR_BAZEL_EXECUTABLE_ROOT must be absolute');
const childEnvironment: NodeJS.ProcessEnv = {
  ...process.env,
  ...nativeEnvironment,
  TMPDIR: scratch,
  MERKUR_BAZEL_RUNFILES_ROOT: runfilesRoot,
  // Stand-in executables are stored by content digest. A root the engine declares outlives
  // the test, so macOS assesses each distinct stub once instead of once per test and run.
  MERKUR_BAZEL_SCRATCH_ROOT: executableRoot ?? scratch,
};
delete childEnvironment.BUN_OPTIONS;
if (sdkPrefix !== undefined && process.platform === 'darwin')
  delete childEnvironment.DYLD_LIBRARY_PATH;
const child = Bun.spawn(
  [
    process.execPath,
    '--no-install',
    '--no-env-file',
    `--config=${inside(runtimeRoot, manifest.config)}`,
    ...command,
  ],
  {
    cwd,
    env: childEnvironment,
    stdout: 'inherit',
    stderr: 'inherit',
  },
);
const status = await child.exited;
if (commandMode) process.exit(status);
if (report === undefined) throw new Error('Bazel Bun test report path is absent');
let xml: string;
try {
  xml = await readFile(report, 'utf8');
} catch {
  throw new Error(`Bun exited ${status} without its required JUnit report`);
}
const bazelXml = process.env.XML_OUTPUT_FILE;
if (bazelXml !== undefined) await writeFile(bazelXml, xml);
if (status !== 0) process.exit(status);
const canonical = await Promise.all(selected.map((file) => realpath(file)));
const accepted = greenTestFiles(xml, cwd, canonical);
if (accepted.length !== selected.length) {
  throw new Error(
    'Bun report does not establish a complete passing result for every selected file',
  );
}
