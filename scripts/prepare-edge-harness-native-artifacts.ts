import { spawn } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import {
  collectNativeBuildEnvironmentOverrides,
  collectNativeToolchainEvidence,
  computeNativeSourceClosure,
  createEdgeHarnessNativeArtifactManifest,
  EDGE_HARNESS_NATIVE_BUILD_COMMANDS,
  ensureCanonicalNativeBuildOutputDirectory,
  type NativeBuildArtifactName,
  validateCanonicalNativeBuildArtifact,
} from './edge-harness-native-artifacts';

const ROOT = path.resolve(import.meta.dir, '..');
const OUTPUT_OPTION = '--output=';

if (import.meta.main) {
  const outputArgument = process.argv.find((argument) => argument.startsWith(OUTPUT_OPTION));
  const output = outputArgument?.slice(OUTPUT_OPTION.length);
  if (output === undefined || !path.isAbsolute(output)) {
    throw new Error(
      'usage: bun run scripts/prepare-edge-harness-native-artifacts.ts --output=/absolute/new/directory',
    );
  }
  if (existsSync(output)) throw new Error('native artifact output directory already exists');
  const environmentBefore = collectNativeBuildEnvironmentOverrides();
  if (environmentBefore.length !== 0) {
    throw new Error(
      'benchmark native artifact build requires no compiler/profile/target overrides',
    );
  }

  // `.cargo/config.toml` fixes Cargo's output below this repository-local
  // chain. Validate it before Cargo can write through a pre-existing symlink.
  ensureCanonicalNativeBuildOutputDirectory(ROOT);
  const sourceBefore = await computeNativeSourceClosure(ROOT);
  const toolchainBefore = await collectNativeToolchainEvidence(ROOT);
  for (const command of EDGE_HARNESS_NATIVE_BUILD_COMMANDS) await run(command);
  const sourceAfter = await computeNativeSourceClosure(ROOT);
  if (JSON.stringify(sourceAfter) !== JSON.stringify(sourceBefore)) {
    throw new Error('native source closure changed during the benchmark preflight build');
  }

  const buildArtifactPaths = {
    dataplane: validateCanonicalNativeBuildArtifact(ROOT, 'merkur-dataplane'),
    imageWorker: validateCanonicalNativeBuildArtifact(ROOT, 'merkur-image-worker'),
    edge: validateCanonicalNativeBuildArtifact(ROOT, 'merkur-edge'),
    proxy: validateCanonicalNativeBuildArtifact(ROOT, 'delay_proxy'),
    tui: validateCanonicalNativeBuildArtifact(ROOT, 'merkur-tui'),
  };
  mkdirSync(output, { mode: 0o700 });
  const artifactPaths = {
    dataplane: copyArtifact(buildArtifactPaths.dataplane, 'merkur-dataplane', output),
    imageWorker: copyArtifact(buildArtifactPaths.imageWorker, 'merkur-image-worker', output),
    edge: copyArtifact(buildArtifactPaths.edge, 'merkur-edge', output),
    proxy: copyArtifact(buildArtifactPaths.proxy, 'delay_proxy', output),
    tui: copyArtifact(buildArtifactPaths.tui, 'merkur-tui', output),
  };
  const manifest = await createEdgeHarnessNativeArtifactManifest(ROOT, artifactPaths);
  if (
    JSON.stringify(manifest.toolchain) !== JSON.stringify(toolchainBefore) ||
    JSON.stringify(manifest.build.environmentOverrides) !== JSON.stringify(environmentBefore)
  ) {
    throw new Error('native toolchain or build environment changed during preflight');
  }
  const manifestPath = path.join(output, 'native-artifact-manifest.json');
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  chmodSync(manifestPath, 0o444);
  chmodSync(output, 0o555);
  process.stdout.write(
    `${JSON.stringify(
      {
        manifestPath: realpathSync(manifestPath),
        sourceClosureSha256: manifest.source.sha256,
        artifacts: manifest.artifacts,
      },
      null,
      2,
    )}\n`,
  );
}

async function run(command: readonly string[]): Promise<void> {
  const [executable, ...arguments_] = command;
  if (executable === undefined) throw new Error('native build command is empty');
  const child = spawn(executable, arguments_, { cwd: ROOT, stdio: 'inherit' });
  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => resolve(code ?? 1));
  });
  if (exitCode !== 0) throw new Error(`${executable} exited ${exitCode}`);
}

function copyArtifact(source: string, name: NativeBuildArtifactName, output: string): string {
  const destination = path.join(output, name);
  copyFileSync(source, destination);
  chmodSync(destination, 0o555);
  return realpathSync(destination);
}
