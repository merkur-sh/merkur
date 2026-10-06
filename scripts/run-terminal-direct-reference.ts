/**
 * Explicit test-only overlay runner. `prepare` creates a new owned detached
 * worktree; `run` builds that exact production revision and runs the common
 * driver. It never edits an existing checkout, backports telemetry, or reuses
 * a historical build with newer product source. The original release worktree
 * (including user notes) is not an input/output target.
 *
 * prepare --revision=<full commit> --proxy-binary=<absolute pinned executable>
 *         --browser-binary=<actual common Chromium/headless-shell executable>
 * run --worktree=<owned directory printed by prepare> --profile=fast
 *
 * Preparation is separate so CPU/source coordination can precede every build.
 * Owned worktrees/artifacts remain available for audit; this runner never
 * recursively removes a worktree or an unrelated temporary directory.
 */
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import {
  analyzeDirectReferenceInputs,
  type DirectReferenceWindow,
  validateDirectReferenceDump,
} from '../tests/e2e/fixtures/direct-reference-events';
import {
  configuredProxyFaultEvidenceErrors,
  parseProxyImpairmentStats,
} from './edge-network-stats';

const ROOT = path.resolve(import.meta.dir, '..');
const MANIFEST = 'direct-reference-manifest.json';
const OWNER = 'merkur-direct-reference-owned-worktree';
export const DIRECT_REFERENCE_COMMON_FILES = [
  'tests/e2e/terminal-direct-reference.e2e.ts',
  'tests/e2e/fixtures/direct-reference-events.ts',
  'tests/e2e/fixtures/direct-redraw-coverage.ts',
  'tests/e2e/fixtures/terminal-redraw-reference.ts',
  'tests/e2e/fixtures/direct-artifacts.ts',
  // Only launch plans/tool hashes/owned-resource cleanup are called. The
  // newer viewport/transaction helpers in this test module are NOT invoked.
  'tests/e2e/fixtures/direct-tui-workloads.ts',
  // This fixture differs from 60f only by isolated Direct port reservation,
  // exact bound-listener readiness and returning the selected backend port.
  'tests/e2e/fixtures/daemon-process.ts',
  'scripts/edge-network-profile.ts',
  'scripts/edge-network-stats.ts',
  'scripts/edge-network-control.ts',
] as const;

export interface ReferenceOverlay {
  readonly path: string;
  readonly source: string;
}
interface Manifest {
  readonly owner: typeof OWNER;
  readonly worktree: string;
  readonly revision: string;
  readonly tree: string;
  readonly production: readonly { path: string; sha256: string }[];
  readonly productionSha256: string;
  readonly overlays: readonly { path: string; sha256: string }[];
  readonly proxy: { relativePath: string; sha256: string; sourcePath: string };
  readonly browser: {
    path: string;
    sha256: string;
    bundlePath: string;
    bundleSha256: string;
  };
  readonly driver: { path: string; sha256: string };
  readonly playwright: readonly { name: string; path: string; sha256: string }[];
  readonly runnerSha256: string;
}

interface RunArtifact {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

interface ReplayedCommonArtifact {
  readonly path: string;
  readonly sha256: string;
  readonly eventCount: number;
  readonly sampleCount: number;
  readonly reportSha256: string;
}

/** Exact test-tool patch, deliberately not a production compatibility branch. */
export function replaceReferenceProxyPath(source: string, declaration: string): string {
  if (source.split(declaration).length !== 2) throw new Error('reference proxy declaration drift');
  return source.replace(
    declaration,
    'const PROXY_BINARY_PATH = process.env.DIRECT_REFERENCE_PROXY_BINARY;\n' +
      "if (PROXY_BINARY_PATH === undefined || !path.isAbsolute(PROXY_BINARY_PATH)) throw new Error('explicit reference proxy binary required');\n" +
      declaration.replace(/ = .*;$/u, ' = PROXY_BINARY_PATH;'),
  );
}

export function validateReferenceOverlayPaths(overlays: readonly ReferenceOverlay[]): void {
  const seen = new Set<string>();
  for (const overlay of overlays) {
    if (seen.has(overlay.path)) throw new Error('duplicate test overlay target');
    seen.add(overlay.path);
    if (
      overlay.path.includes('..') ||
      path.isAbsolute(overlay.path) ||
      !(
        overlay.path.startsWith('tests/e2e/') ||
        overlay.path.startsWith('scripts/') ||
        overlay.path === 'playwright.direct-reference.config.mjs'
      )
    )
      throw new Error(`non-test reference overlay refused: ${overlay.path}`);
  }
}

function overlayPlan(): ReferenceOverlay[] {
  const overlays: ReferenceOverlay[] = DIRECT_REFERENCE_COMMON_FILES.map((file) => ({
    path: file,
    source: readFileSync(path.join(ROOT, file), 'utf8'),
  }));
  for (const [file, declaration] of [
    [
      'scripts/run-edge-harness.ts',
      "const PROXY_BIN = path.join(ROOT, 'target', 'rust', 'release', 'delay_proxy');",
    ],
    [
      'tests/e2e/fixtures/direct-network-proxy.ts',
      "const PROXY_BINARY = path.resolve(__dirname, '../../../target/rust/release/delay_proxy');",
    ],
  ] as const) {
    overlays.push({
      path: file,
      source: replaceReferenceProxyPath(readFileSync(path.join(ROOT, file), 'utf8'), declaration),
    });
  }
  // The normal edge runner chooses this config only inside this owned test
  // overlay. Native edge/dataplane sources and build commands stay unchanged.
  const runner = overlays.find((overlay) => overlay.path === 'scripts/run-edge-harness.ts');
  if (runner === undefined) throw new Error('reference edge runner missing');
  const position = overlays.indexOf(runner);
  const configLiteral = "'-c', 'playwright.edge.config.mjs'";
  if (runner.source.split(configLiteral).length !== 2)
    throw new Error('reference config invocation drift');
  const networkLiteral = 'const NETWORK = resolveEdgeNetworkConfig(process.env);';
  if (runner.source.split(networkLiteral).length !== 2)
    throw new Error('reference network configuration drift');
  const invocation = "spawn('bunx', ['playwright', 'test',";
  if (runner.source.split(invocation).length !== 2)
    throw new Error('reference Playwright invocation drift');
  overlays[position] = {
    ...runner,
    source: runner.source
      .replace(configLiteral, "'-c', 'playwright.direct-reference.config.mjs'")
      .replace(invocation, "spawn(REFERENCE_DRIVER_BINARY, [REFERENCE_PLAYWRIGHT_CLI, 'test',")
      .replace(
        networkLiteral,
        'const REFERENCE_DRIVER_BINARY = process.env.DIRECT_REFERENCE_DRIVER_BINARY;\n' +
          'const REFERENCE_PLAYWRIGHT_CLI = process.env.DIRECT_REFERENCE_PLAYWRIGHT_CLI;\n' +
          "if (REFERENCE_DRIVER_BINARY === undefined || REFERENCE_PLAYWRIGHT_CLI === undefined) throw new Error('explicit reference test driver required');\n" +
          'const REFERENCE_BASE_NETWORK = resolveEdgeNetworkConfig(process.env);\n' +
          "if (REFERENCE_BASE_NETWORK === null) throw new Error('reference companion edge must be emulated');\n" +
          // One identical, explicit 400ms companion on every Direct profile. Its
          // advertised RTT, native schedule and returned stats all use 400ms;
          // the Direct helper keeps the unchanged 50/120/200ms profile table.
          'const NETWORK = { ...REFERENCE_BASE_NETWORK, profile: { ...REFERENCE_BASE_NETWORK.profile, targetRttMs: 400, hopDelayUs: 100_000 }, drainGraceMs: Math.max(450, REFERENCE_BASE_NETWORK.drainGraceMs) };',
      ),
  };
  overlays.push({
    path: 'playwright.direct-reference.config.mjs',
    source: buildReferencePlaywrightConfig(
      readFileSync(path.join(ROOT, 'playwright.edge.config.mjs'), 'utf8'),
    ),
  });
  validateReferenceOverlayPaths(overlays);
  return overlays;
}

export function buildReferencePlaywrightConfig(config: string): string {
  const importLiteral = "import { defineConfig } from '@playwright/test';";
  const exportLiteral = 'export default defineConfig(';
  if (config.split(importLiteral).length !== 2 || config.split(exportLiteral).length !== 2)
    throw new Error('reference Playwright config drift');
  return (
    config
      .replace(
        importLiteral,
        "import { defineConfig } from './tests/e2e/node_modules/@playwright/test/index.mjs';",
      )
      .replace(exportLiteral, 'const referenceBase = defineConfig(') +
    '\nconst referenceBrowser = process.env.DIRECT_REFERENCE_BROWSER_BINARY;\n' +
    "if (referenceBrowser === undefined) throw new Error('explicit common browser binary required');\n" +
    'const referenceOutput = process.env.DIRECT_REFERENCE_OUTPUT_DIR;\n' +
    "if (referenceOutput === undefined) throw new Error('explicit reference output directory required');\n" +
    // Chromium 1.62's default arguments no longer guarantee this switch.
    // The provenance CDP method requires it; pin the identical test-driver
    // setting explicitly for both original product arms, not only one arm.
    "const referenceArgs = [...(referenceBase.use.launchOptions.args ?? []).filter((arg) => arg !== '--enable-automation'), '--enable-automation'];\n" +
    "export default { ...referenceBase, testMatch: ['**/terminal-direct-reference.e2e.ts'], workers: 1, fullyParallel: false, retries: 0, outputDir: referenceOutput, use: { ...referenceBase.use, trace: 'off', video: 'off', screenshot: 'only-on-failure', launchOptions: { ...referenceBase.use.launchOptions, args: referenceArgs, executablePath: referenceBrowser } } };\n"
  );
}

function prepare(revision: string, proxySource: string, browserSource: string): void {
  if (!/^[0-9a-f]{40}$/u.test(revision))
    throw new Error('prepare requires an exact full commit hash');
  const resolved = git(ROOT, ['rev-parse', `${revision}^{commit}`]).trim();
  if (resolved !== revision) throw new Error('revision did not resolve exactly');
  if (!path.isAbsolute(proxySource) || !statSync(proxySource).isFile())
    throw new Error('explicit existing proxy executable required');
  if (!path.isAbsolute(browserSource) || !statSync(browserSource).isFile())
    throw new Error('explicit existing browser executable required');
  const node = Bun.which('node');
  if (node === null) throw new Error('common Node test driver is unavailable');
  const testRoot = realpathSync(path.join(ROOT, 'node_modules/@playwright/test'));
  const requireTest = createRequire(path.join(testRoot, 'package.json'));
  const playwrightRoot = path.dirname(requireTest.resolve('playwright/package.json'));
  const requirePlaywright = createRequire(path.join(playwrightRoot, 'package.json'));
  const coreRoot = path.dirname(requirePlaywright.resolve('playwright-core/package.json'));
  const playwright = [
    ['@playwright/test', testRoot],
    ['playwright', playwrightRoot],
    ['playwright-core', coreRoot],
  ].map(([name, directory]) => {
    if (name === undefined || directory === undefined)
      throw new Error('incomplete test-tool closure');
    return { name, path: realpathSync(directory), sha256: packageTreeHash(directory) };
  });
  const plan = overlayPlan();
  const browserPath = realpathSync(browserSource);
  const browserBundlePath = resolveBrowserBundlePath(browserPath);
  const directory = realpathSync(mkdtempSync(path.join(tmpdir(), 'merkur-direct-reference-')));
  git(ROOT, ['worktree', 'add', '--detach', directory, revision]);
  const overlayPaths = new Set(plan.map((overlay) => overlay.path));
  const files = git(directory, ['ls-files', '-z']).split('\0').filter(Boolean);
  const production = files
    .filter((file) => !overlayPaths.has(file))
    .map((file) => ({ path: file, sha256: hash(readFileSync(path.join(directory, file))) }));
  for (const overlay of plan) {
    const target = path.join(directory, overlay.path);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, overlay.source);
  }
  const proxyRelativePath = 'target/direct-reference-fixture-bin/delay_proxy';
  const proxyTarget = path.join(directory, proxyRelativePath);
  mkdirSync(path.dirname(proxyTarget), { recursive: true });
  copyFileSync(proxySource, proxyTarget);
  const manifest: Manifest = {
    owner: OWNER,
    worktree: directory,
    revision,
    tree: git(directory, ['rev-parse', 'HEAD^{tree}']).trim(),
    production,
    productionSha256: hash(JSON.stringify(production)),
    overlays: plan.map((overlay) => ({ path: overlay.path, sha256: hash(overlay.source) })),
    proxy: {
      relativePath: proxyRelativePath,
      sha256: hash(readFileSync(proxyTarget)),
      sourcePath: realpathSync(proxySource),
    },
    browser: {
      path: browserPath,
      sha256: hash(readFileSync(browserPath)),
      bundlePath: browserBundlePath,
      bundleSha256: filesystemTreeHash(browserBundlePath),
    },
    driver: { path: realpathSync(node), sha256: hash(readFileSync(node)) },
    playwright,
    runnerSha256: hash(readFileSync(import.meta.path)),
  };
  writeFileSync(path.join(directory, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
  process.stdout.write(
    `${JSON.stringify({ worktree: directory, manifest: path.join(directory, MANIFEST), revision, productionSha256: manifest.productionSha256 }, null, 2)}\n`,
  );
}

function verify(directory: string): Manifest {
  const manifest: Manifest = JSON.parse(readFileSync(path.join(directory, MANIFEST), 'utf8'));
  if (
    manifest.owner !== OWNER ||
    manifest.worktree !== realpathSync(directory) ||
    !/^[0-9a-f]{40}$/u.test(manifest.revision)
  )
    throw new Error('not an owned reference worktree');
  if (manifest.runnerSha256 !== hash(readFileSync(import.meta.path)))
    throw new Error('reference runner changed after preparation');
  if (git(directory, ['rev-parse', 'HEAD']).trim() !== manifest.revision)
    throw new Error('reference worktree revision changed');
  const overlays = manifest.overlays.map((entry) => ({ path: entry.path, source: '' }));
  validateReferenceOverlayPaths(overlays);
  for (const entry of [...manifest.production, ...manifest.overlays]) {
    if (
      path.isAbsolute(entry.path) ||
      entry.path.includes('..') ||
      hash(readFileSync(path.join(directory, entry.path))) !== entry.sha256
    )
      throw new Error(`reference source changed: ${entry.path}`);
  }
  if (hash(JSON.stringify(manifest.production)) !== manifest.productionSha256)
    throw new Error('reference source manifest changed');
  if (
    hash(readFileSync(path.join(directory, manifest.proxy.relativePath))) !== manifest.proxy.sha256
  )
    throw new Error('reference proxy binary changed');
  for (const executable of [manifest.browser, manifest.driver]) {
    if (hash(readFileSync(executable.path)) !== executable.sha256)
      throw new Error('reference browser/driver executable changed');
  }
  if (
    resolveBrowserBundlePath(manifest.browser.path) !== manifest.browser.bundlePath ||
    filesystemTreeHash(manifest.browser.bundlePath) !== manifest.browser.bundleSha256
  ) {
    throw new Error('reference browser bundle changed');
  }
  for (const packageInfo of manifest.playwright) {
    if (packageTreeHash(packageInfo.path) !== packageInfo.sha256)
      throw new Error('reference test-tool closure changed');
  }
  return manifest;
}

export function validateReferenceCompanionResult(
  value: unknown,
  seed: number,
  minimumDirectionalPackets = 100,
) {
  const result = requiredRecord(value, 'companion edge result');
  if (
    result.schemaVersion !== 2 ||
    result.playwrightExitCode !== 0 ||
    result.harnessExitCode !== 0
  ) {
    throw new Error('companion edge harness did not complete cleanly');
  }
  const validation = requiredRecord(result.impairmentValidation, 'companion impairment validation');
  if (
    validation.complete !== true ||
    !Array.isArray(validation.errors) ||
    validation.errors.length !== 0
  ) {
    throw new Error('companion edge impairment validation is incomplete');
  }
  const network = requiredRecord(result.network, 'companion network configuration');
  const profile = requiredRecord(network.profile, 'companion network profile');
  if (
    profile.name !== 'difficult' ||
    profile.targetRttMs !== 400 ||
    profile.hopDelayUs !== 100_000 ||
    network.datagramLossPercent !== 0 ||
    network.reorder !== 'none' ||
    network.scenario !== 'steady' ||
    network.seed !== seed >>> 0 ||
    network.hopJitterRadiusUs !== 7_500
  ) {
    throw new Error('companion edge network configuration does not match the exact 400ms contract');
  }
  const stats = parseProxyImpairmentStats(result.proxyStats);
  if (stats === null) throw new Error('companion edge proxy stats are invalid');
  if (
    stats.config.profile !== 'difficult' ||
    stats.config.targetRttMs !== 400 ||
    stats.config.baseDelayUs !== 100_000 ||
    stats.config.jitterRadiusUs !== 7_500 ||
    stats.config.datagramLossPercent !== 0 ||
    stats.config.reorder !== 'none' ||
    stats.config.scenario !== 'steady' ||
    stats.config.seed !== seed >>> 0
  ) {
    throw new Error('companion edge proxy did not run the declared 400ms schedule');
  }
  const errors = configuredProxyFaultEvidenceErrors(stats, {
    requireDrained: true,
    requireConfiguredFaultsObserved: false,
  });
  if (errors.length > 0)
    throw new Error(`companion edge proxy is incomplete: ${errors.join('; ')}`);
  for (const [name, direction] of [
    ['upstream', stats.upstream],
    ['downstream', stats.downstream],
  ] as const) {
    if (
      direction.forwarded < minimumDirectionalPackets ||
      direction.scheduledDelayUs.count !== direction.forwarded ||
      direction.scheduledDelayUs.min < 92_500 ||
      direction.scheduledDelayUs.max > 107_500
    ) {
      throw new Error(`companion edge ${name} delay population is incomplete`);
    }
  }
  return {
    complete: true as const,
    targetRttMs: 400 as const,
    directionalLegCount: 2 as const,
    stats,
  };
}

function collectRunArtifacts(directory: string): RunArtifact[] {
  if (!existsSync(directory)) return [];
  const artifacts: RunArtifact[] = [];
  const visit = (relative: string): void => {
    for (const entry of readdirSync(path.join(directory, relative), { withFileTypes: true }).sort(
      (left, right) => left.name.localeCompare(right.name),
    )) {
      const name = path.join(relative, entry.name);
      const absolute = path.join(directory, name);
      if (entry.isDirectory()) visit(name);
      else if (entry.isFile()) {
        const body = readFileSync(absolute);
        artifacts.push({ path: name, bytes: body.byteLength, sha256: hash(body) });
      } else {
        throw new Error(`unexpected reference artifact entry: ${name}`);
      }
    }
  };
  visit('');
  return artifacts;
}

function replayCommonArtifacts(
  outputDirectory: string,
  artifacts: readonly RunArtifact[],
): ReplayedCommonArtifact[] {
  const replayed: ReplayedCommonArtifact[] = [];
  for (const artifact of artifacts) {
    if (!artifact.path.endsWith('.common-events.json.gz')) continue;
    const absolute = path.join(outputDirectory, artifact.path);
    const decoded: unknown = JSON.parse(gunzipSync(readFileSync(absolute)).toString('utf8'));
    const envelope = requiredRecord(decoded, `common raw artifact ${artifact.path}`);
    const dump = validateDirectReferenceDump(envelope.workerDump);
    const window = parseDirectReferenceWindow(envelope.window);
    const inputClasses = stringArray(envelope.inputClasses, 'common input classes');
    const mode = envelope.mode;
    let sampleCount = 0;
    let reportSha256 = hash('control');
    if (mode === 'completeness-only' || mode === 'latency') {
      const report = analyzeDirectReferenceInputs(dump.events, window, inputClasses);
      sampleCount = report.samples.length;
      reportSha256 = hash(JSON.stringify(report));
    } else if (mode !== 'control') {
      throw new Error(`common raw artifact ${artifact.path} has an invalid mode`);
    }
    const reportPath = artifact.path.replace(/\.common-events\.json\.gz$/u, '.common-report.json');
    const reportArtifact = artifacts.find((entry) => entry.path === reportPath);
    if (reportArtifact === undefined) {
      throw new Error(`common raw artifact ${artifact.path} has no durable report`);
    }
    const reportEnvelope: unknown = JSON.parse(
      readFileSync(path.join(outputDirectory, reportPath), 'utf8'),
    );
    const retainedReport = requiredRecord(reportEnvelope, `common report ${reportPath}`);
    if (retainedReport.rawSha256 !== artifact.sha256) {
      throw new Error(`common report ${reportPath} does not own its raw artifact`);
    }
    replayed.push({
      path: artifact.path,
      sha256: artifact.sha256,
      eventCount: dump.events.length,
      sampleCount,
      reportSha256,
    });
  }
  if (replayed.length === 0) throw new Error('reference run produced no common raw artifacts');
  return replayed;
}

async function run(directory: string, profile: string, seed: number, label: string): Promise<void> {
  if (profile !== 'fast' && profile !== 'typical' && profile !== 'difficult')
    throw new Error('explicit fast/typical/difficult profile required');
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/u.test(label)) throw new Error('invalid reference run label');
  const manifest = verify(directory);
  const buildEnvironment = { ...process.env };
  delete buildEnvironment.CARGO_TARGET_DIR;
  // Distinct dependency trees honor each exact lockfile. Do not symlink the
  // current node_modules into a historical source tree.
  await command(directory, ['bun', 'install', '--frozen-lockfile'], buildEnvironment);
  await command(directory, ['bun', 'run', 'build:wasm'], buildEnvironment);
  await command(directory, ['bun', 'run', 'sync:wasm'], buildEnvironment);
  verify(directory);
  const testPackage = manifest.playwright.find((entry) => entry.name === '@playwright/test');
  if (testPackage === undefined) throw new Error('reference test tool is missing');
  // This alias exists only beneath the TEST tree. It is not an ancestor of
  // apps/, packages/, scripts/ or the root's node_modules: product resolution
  // cannot see it. Both product lockfile and root dependency aliases stay exact.
  const rootTestAlias = realpathSync(path.join(directory, 'node_modules/@playwright/test'));
  const testAlias = path.join(directory, 'tests/e2e/node_modules/@playwright/test');
  mkdirSync(path.dirname(testAlias), { recursive: true });
  if (existsSync(testAlias)) {
    if (!lstatSync(testAlias).isSymbolicLink() || realpathSync(testAlias) !== testPackage.path)
      throw new Error('foreign test-tool alias in owned tree');
  } else symlinkSync(testPackage.path, testAlias, 'dir');
  if (realpathSync(path.join(directory, 'node_modules/@playwright/test')) !== rootTestAlias)
    throw new Error('product dependency alias changed');
  const outputDirectory = path.join(
    directory,
    'test-results',
    `e2e-direct-reference-${profile}-${seed}-${label}`,
  );
  const edgeResultPath = path.join(
    directory,
    `direct-reference-${profile}-${seed}-${label}-edge.json`,
  );
  const environment = {
    ...buildEnvironment,
    FORCE_EDGE: '0',
    PW_E2E_BROWSER: 'chromium',
    DIRECT_REFERENCE_PROFILE: profile,
    DIRECT_REFERENCE_SEED: String(seed),
    DIRECT_REFERENCE_MANIFEST: path.join(directory, MANIFEST),
    DIRECT_REFERENCE_PROXY_BINARY: path.join(directory, manifest.proxy.relativePath),
    DIRECT_REFERENCE_BROWSER_BINARY: manifest.browser.path,
    DIRECT_REFERENCE_DRIVER_BINARY: manifest.driver.path,
    DIRECT_REFERENCE_PLAYWRIGHT_CLI: path.join(testPackage.path, 'cli.js'),
    DIRECT_REFERENCE_OUTPUT_DIR: outputDirectory,
    // Test overlay declares the actual 400ms companion, not the profile-table
    // value. Label difficult only selects its unchanged 0–30ms jitter shape.
    EDGE_NETWORK_PROFILE: 'difficult',
    EDGE_NETWORK_DATAGRAM_LOSS_PERCENT: '0',
    EDGE_NETWORK_REORDER: 'none',
    EDGE_NETWORK_SCENARIO: 'steady',
    EDGE_NETWORK_SEED: String(seed),
    MERKUR_EDGE_HARNESS_RESULT_PATH: edgeResultPath,
  };
  const startedAt = new Date().toISOString();
  let error: unknown = null;
  try {
    await command(
      directory,
      [
        'bun',
        'run',
        'scripts/run-edge-harness.ts',
        'terminal-direct-reference.e2e.ts',
        '--workers=1',
      ],
      environment,
    );
  } catch (caught) {
    error = caught;
  }
  const finalManifest = verify(directory);
  const evidenceErrors: string[] = [];
  let companion: ReturnType<typeof validateReferenceCompanionResult> | null = null;
  try {
    const edgeResult: unknown = JSON.parse(readFileSync(edgeResultPath, 'utf8'));
    companion = validateReferenceCompanionResult(edgeResult, seed);
  } catch (caught) {
    evidenceErrors.push(`companion: ${errorMessage(caught)}`);
  }
  let artifacts: RunArtifact[] = [];
  let replayed: ReplayedCommonArtifact[] = [];
  try {
    artifacts = collectRunArtifacts(outputDirectory);
    replayed = replayCommonArtifacts(outputDirectory, artifacts);
  } catch (caught) {
    evidenceErrors.push(`artifacts: ${errorMessage(caught)}`);
  }
  const evidence = {
    revision: finalManifest.revision,
    productionSha256: finalManifest.productionSha256,
    startedAt,
    completedAt: new Date().toISOString(),
    profile,
    seed,
    label,
    runtime: {
      bun: process.versions.bun,
      node: process.versions.node,
      arch: process.arch,
      platform: process.platform,
    },
    binaries: collectBinaryHashes(directory),
    proxy: finalManifest.proxy,
    companion,
    outputDirectory,
    artifacts,
    replayed,
    evidenceErrors,
    testToolNormalization: {
      resolutionScope: 'tests/e2e/node_modules only; product root dependencies unchanged',
      originalRootTestAlias: rootTestAlias,
      packages: finalManifest.playwright,
      driver: finalManifest.driver,
      browser: finalManifest.browser,
    },
    runError: error === null ? null : String(error),
  };
  const runEvidencePath = path.join(
    directory,
    `direct-reference-${profile}-${seed}-${label}-run.json`,
  );
  writeFileSync(runEvidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  if (error !== null || evidenceErrors.length > 0) {
    throw new AggregateError(
      [...(error === null ? [] : [error]), ...evidenceErrors.map((entry) => new Error(entry))],
      `reference run failed; evidence retained at ${runEvidencePath}`,
    );
  }
}

function collectBinaryHashes(directory: string): { path: string; sha256: string }[] {
  const roots = [
    'apps/daemon/dist',
    'packages/term-wasm/pkg',
    'apps/web/public/wasm',
    'target/rust/release',
  ];
  const result: { path: string; sha256: string }[] = [];
  for (const root of roots) {
    const absolute = path.join(directory, root);
    if (!existsSync(absolute)) continue;
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      if (
        !entry.isFile() ||
        !(
          entry.name.endsWith('.wasm') ||
          entry.name === 'merkur-edge' ||
          entry.name.startsWith('merkur-dataplane')
        )
      )
        continue;
      const relative = path.join(root, entry.name);
      result.push({ path: relative, sha256: hash(readFileSync(path.join(directory, relative))) });
    }
  }
  return result;
}
function git(directory: string, args: readonly string[]): string {
  return execFileSync('git', args, {
    cwd: directory,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
}
function hash(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}
function packageTreeHash(directory: string): string {
  const files: { path: string; sha256: string }[] = [];
  const visit = (relative: string): void => {
    for (const entry of readdirSync(path.join(directory, relative), { withFileTypes: true }).sort(
      (a, b) => a.name.localeCompare(b.name),
    )) {
      if (entry.name === 'node_modules') continue;
      const name = path.join(relative, entry.name);
      if (entry.isDirectory()) visit(name);
      else if (entry.isFile())
        files.push({ path: name, sha256: hash(readFileSync(path.join(directory, name))) });
      else throw new Error(`unexpected non-file in test-tool package: ${name}`);
    }
  };
  visit('');
  return hash(JSON.stringify(files));
}
export function resolveBrowserBundlePath(executable: string): string {
  const resolvedExecutable = realpathSync(executable);
  let cursor = path.dirname(resolvedExecutable);
  while (path.dirname(cursor) !== cursor) {
    if (cursor.endsWith('.app') && statSync(cursor).isDirectory()) return cursor;
    cursor = path.dirname(cursor);
  }
  return path.dirname(resolvedExecutable);
}
function filesystemTreeHash(directory: string): string {
  const entries: { path: string; kind: 'file' | 'symlink'; sha256: string }[] = [];
  const visit = (relative: string): void => {
    const absolute = path.join(directory, relative);
    for (const entry of readdirSync(absolute, { withFileTypes: true }).sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      const name = path.join(relative, entry.name);
      const target = path.join(directory, name);
      if (entry.isDirectory()) visit(name);
      else if (entry.isFile()) {
        entries.push({ path: name, kind: 'file', sha256: hash(readFileSync(target)) });
      } else if (entry.isSymbolicLink()) {
        entries.push({ path: name, kind: 'symlink', sha256: hash(readlinkSync(target)) });
      } else {
        throw new Error(`unexpected browser bundle entry: ${name}`);
      }
    }
  };
  visit('');
  return hash(JSON.stringify(entries));
}
async function command(
  directory: string,
  command: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const [executable, ...args] = command;
  if (executable === undefined) throw new Error('empty reference command');
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, args, { cwd: directory, env, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code, signal) =>
      code === 0 ? resolve() : reject(new Error(`${executable} exited ${code}, signal ${signal}`)),
    );
  });
}
function option(name: string): string {
  const match = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  if (match === undefined) throw new Error(`--${name}= is required`);
  return match.slice(name.length + 3);
}
function parseSeed(raw: string): number {
  const seed = Number(raw);
  if (!Number.isSafeInteger(seed) || seed <= 0 || seed > 0xffff_ffff) {
    throw new Error('reference seed must be a nonzero u32');
  }
  return seed;
}
function requiredRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}
function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new Error(`${label} must be a string array`);
  }
  return value as string[];
}
function parseDirectReferenceWindow(value: unknown): DirectReferenceWindow {
  const record = requiredRecord(value, 'common observation window');
  for (const key of ['startAtMs', 'inputEndAtMs', 'endAtMs', 'proofAtMs'] as const) {
    if (typeof record[key] !== 'number' || !Number.isFinite(record[key])) {
      throw new Error(`common observation window ${key} is invalid`);
    }
  }
  if (!Number.isSafeInteger(record.expectedInputCount) || Number(record.expectedInputCount) < 0) {
    throw new Error('common observation expected input count is invalid');
  }
  return {
    startAtMs: Number(record.startAtMs),
    inputEndAtMs: Number(record.inputEndAtMs),
    endAtMs: Number(record.endAtMs),
    proofAtMs: Number(record.proofAtMs),
    expectedInputCount: Number(record.expectedInputCount),
  };
}
function errorMessage(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
if (import.meta.main) {
  const operation = process.argv[2];
  if (operation === 'prepare')
    prepare(option('revision'), option('proxy-binary'), option('browser-binary'));
  else if (operation === 'run') {
    await run(
      realpathSync(option('worktree')),
      option('profile'),
      parseSeed(option('seed')),
      option('label'),
    );
  } else throw new Error('expected prepare or run');
}
