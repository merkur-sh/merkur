/**
 * Prepares two owned, detached experiment trees. It does not build or launch
 * anything: those expensive steps require a separately coordinated CPU slot.
 * A is the exact supplied checkpoint; B hardwires only the measured whole-span
 * bulk policy. There is no product runtime selector or installed-binary override.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { packingExecutionIdentity } from '../tests/e2e/fixtures/packing-delivery-provenance';

const ROOT = path.resolve(import.meta.dir, '..');
const SENDER = 'apps/daemon/dataplane/src/display/send.rs';
const OWNER = 'merkur-whole-span-delivery-experiment';
const DRIVER = 'tests/e2e/terminal-packing-delivery.e2e.ts';

function replaceExactly(source: string, before: string, after: string): string {
  if (source.split(before).length !== 2) throw new Error('packing experiment source anchor drift');
  return source.replace(before, after);
}

/** Normal builds choose WholeSpan; tests retain the measured paired oracle. */
export function wholeSpanDeliveryOverlay(source: string): string {
  let result = replaceExactly(
    source,
    '    #[cfg(test)]\n    if *experiment == PackingExperiment::WholeSpan\n        && presentation_workload != DisplayWorkload::Interactive\n    {',
    '    #[cfg(test)]\n    let whole_span_delivery = *experiment == PackingExperiment::WholeSpan;\n' +
      '    #[cfg(not(test))]\n    let whole_span_delivery = true;\n' +
      '    if whole_span_delivery && presentation_workload != DisplayWorkload::Interactive {',
  );
  result = replaceExactly(
    result,
    '#[cfg(test)]\nfn pack_whole_span_candidate(',
    'fn pack_whole_span_candidate(',
  );
  return replaceExactly(
    result,
    '/// Test-only measured contender, not a production policy.',
    '/// Detached delivery experiment only; not an accepted production policy.',
  );
}

/** All transport/server/browser behavior remains the common checkpoint. */
export function packingDeliveryConfigOverlay(source: string): string {
  if (source.includes('PACKING_BROWSER_BINARY'))
    throw new Error('packing experiment source anchor drift');
  const redirected = replaceExactly(
    source,
    'export default defineConfig({',
    'const base = defineConfig({',
  );
  return (
    redirected +
    '\nconst executablePath = process.env.PACKING_BROWSER_BINARY;\n' +
    "if (!executablePath?.startsWith('/')) throw new Error('exact packing browser executable required');\n" +
    "export default defineConfig({ ...base, testMatch: ['**/terminal-packing-delivery.e2e.ts'], retries: 0, workers: 1, fullyParallel: false, use: { ...base.use, trace: 'off', video: 'off', launchOptions: { ...base.use.launchOptions, executablePath } } });\n"
  );
}

const sha = (bytes: string | Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');
const git = (cwd: string, args: readonly string[]): string =>
  execFileSync('git', [...args], { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

export function preparePackingDeliveryTrees(revision: string): string {
  if (
    !/^[0-9a-f]{40}$/u.test(revision) ||
    git(ROOT, ['rev-parse', `${revision}^{commit}`]).trim() !== revision
  )
    throw new Error('packing experiment requires an exact full checkpoint');
  // No dirty-source overlay: the driver and all its dependencies must already
  // be part of the common checkpoint so both arms resolve exactly the same code.
  git(ROOT, ['cat-file', '-e', `${revision}:${DRIVER}`]);
  const directory = realpathSync(mkdtempSync(path.join(tmpdir(), 'merkur-packing-delivery-')));
  const arms: Array<{
    name: string;
    directory: string;
    sourceSha256: string;
    diffSha256: string;
    files: Array<{ path: string; sha256: string }>;
  }> = [];
  for (const name of ['adaptive', 'whole-span']) {
    const arm = path.join(directory, name);
    git(ROOT, ['worktree', 'add', '--detach', arm, revision]);
    const sender = readFileSync(path.join(arm, SENDER), 'utf8');
    if (name === 'whole-span')
      writeFileSync(path.join(arm, SENDER), wholeSpanDeliveryOverlay(sender));
    const config = path.join(arm, 'playwright.edge.config.mjs');
    writeFileSync(config, packingDeliveryConfigOverlay(readFileSync(config, 'utf8')));
    const files = git(arm, ['ls-files', '-z'])
      .split('\0')
      .filter(Boolean)
      .sort()
      .map((file) => ({
        path: file,
        sha256: sha(readFileSync(path.join(arm, file))),
      }));
    const diff = git(arm, ['diff', '--binary', 'HEAD', '--']);
    writeFileSync(path.join(directory, `${name}.patch`), diff);
    arms.push({
      name,
      directory: arm,
      sourceSha256: sha(JSON.stringify(files)),
      diffSha256: sha(diff),
      files,
    });
  }
  mkdirSync(path.join(directory, 'artifacts'));
  writeFileSync(
    path.join(directory, 'manifest.json'),
    `${JSON.stringify(
      {
        owner: OWNER,
        revision,
        preparedAt: new Date().toISOString(),
        runnerSha256: sha(readFileSync(import.meta.path)),
        productionAccepted: false,
        nativeVerdict: 'inconclusive-three-preregistered-capture-p99-failures',
        launch:
          'Each tree uses its own normal apps/daemon/dist/merkur-dataplane; MERKUR_DATAPLANE_BIN is deliberately removed by the common E2E fixture',
        arms,
      },
      null,
      2,
    )}\n`,
  );
  return directory;
}

/** Shared product/test components must be byte-identical; only native policy differs. */
export function assertPackingArmEquivalence(
  adaptive: ReturnType<typeof packingExecutionIdentity>,
  wholeSpan: ReturnType<typeof packingExecutionIdentity>,
): void {
  if (adaptive.checkpoint !== wholeSpan.checkpoint || adaptive.directory === wholeSpan.directory)
    throw new Error('packing arms require distinct trees at the same exact checkpoint');
  if (adaptive.nativeAndWasm.length !== wholeSpan.nativeAndWasm.length)
    throw new Error('packing arm runtime populations differ');
  for (let index = 0; index < adaptive.nativeAndWasm.length; index++) {
    const before = adaptive.nativeAndWasm[index];
    const after = wholeSpan.nativeAndWasm[index];
    if (before === undefined || after === undefined || before.path !== after.path)
      throw new Error('packing arm runtime paths differ');
    const changed = before.sha256 !== after.sha256;
    if (changed !== (before.path === 'apps/daemon/dist/merkur-dataplane'))
      throw new Error(`unexpected packing runtime equality/difference: ${before.path}`);
  }
  if (
    adaptive.webBundleSha256 !== wholeSpan.webBundleSha256 ||
    JSON.stringify(adaptive.browser) !== JSON.stringify(wholeSpan.browser) ||
    JSON.stringify(adaptive.node) !== JSON.stringify(wholeSpan.node) ||
    JSON.stringify(adaptive.bun) !== JSON.stringify(wholeSpan.bun) ||
    JSON.stringify(adaptive.testTools.map((tool) => tool.sha256)) !==
      JSON.stringify(wholeSpan.testTools.map((tool) => tool.sha256))
  )
    throw new Error('packing arms differ in shared web/browser/test runtime');
}

/**
 * After normal product builds in each owned tree, seal the executed artifacts.
 * Does not install, build or run anything. A subsequent startup rebuild that
 * changes the web/WASM/native bytes is rejected by the driver, not ignored.
 */
export function sealPackingDeliveryTrees(preparedDirectory: string): string[] {
  const directory = realpathSync(preparedDirectory);
  const manifestBytes = readFileSync(path.join(directory, 'manifest.json'));
  const value: unknown = JSON.parse(manifestBytes.toString('utf8'));
  if (typeof value !== 'object' || value === null) throw new Error('invalid prepared manifest');
  const manifest = value as Record<string, unknown>;
  if (
    manifest.owner !== OWNER ||
    typeof manifest.revision !== 'string' ||
    !/^[0-9a-f]{40}$/u.test(manifest.revision) ||
    !Array.isArray(manifest.arms) ||
    manifest.arms.length !== 2
  )
    throw new Error('invalid prepared manifest ownership/checkpoint');
  const browser = process.env.PACKING_BROWSER_BINARY;
  if (browser === undefined || !path.isAbsolute(browser))
    throw new Error('exact browser executable required');
  const identities: Array<ReturnType<typeof packingExecutionIdentity>> = [];
  for (const [index, name] of ['adaptive', 'whole-span'].entries()) {
    const candidate: unknown = manifest.arms[index];
    if (typeof candidate !== 'object' || candidate === null)
      throw new Error('invalid prepared arm');
    const arm = candidate as Record<string, unknown>;
    const armDirectory = realpathSync(path.join(directory, name));
    if (arm.name !== name || arm.directory !== armDirectory)
      throw new Error('prepared arm path/ownership mismatch');
    const identity = packingExecutionIdentity(armDirectory, browser);
    if (
      identity.checkpoint !== manifest.revision ||
      identity.sourceSha256 !== arm.sourceSha256 ||
      identity.overlaySha256 !== arm.diffSha256
    )
      throw new Error('product source changed after detached preparation');
    identities.push(identity);
  }
  const adaptive = identities[0],
    wholeSpan = identities[1];
  if (adaptive === undefined || wholeSpan === undefined) throw new Error('missing arm');
  assertPackingArmEquivalence(adaptive, wholeSpan);
  return identities.map((identity, index) => {
    const destination = path.join(
      directory,
      `${index === 0 ? 'adaptive' : 'whole-span'}.sealed-run.json`,
    );
    writeFileSync(
      destination,
      `${JSON.stringify(
        {
          owner: 'merkur-packing-delivery-sealed-run',
          preparedManifestSha256: sha(manifestBytes),
          identity,
          productionAccepted: false,
          nativeVerdict: 'combined-discordant-inconclusive',
        },
        null,
        2,
      )}\n`,
      { flag: 'wx' },
    );
    return destination;
  });
}

if (import.meta.main) {
  const [command, argument, extra] = process.argv.slice(2);
  if (
    argument === undefined ||
    extra !== undefined ||
    (command !== 'prepare' && command !== 'seal')
  )
    throw new Error(
      'Usage: bun scripts/run-terminal-packing-delivery.ts prepare <exact-checkpoint> | seal <owned-prepared-directory>',
    );
  process.stdout.write(
    `${command === 'prepare' ? preparePackingDeliveryTrees(argument) : sealPackingDeliveryTrees(argument).join('\n')}\n`,
  );
}
