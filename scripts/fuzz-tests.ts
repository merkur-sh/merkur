import { copyFile, mkdir, readdir, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import targetList from '../tools/bolero/targets.json';
import {
  absoluteCargoPaths,
  cargoEnvironment,
  manifestText,
  productionWorkspaceTables,
  root,
  table,
} from './generated-cargo-workspace';

interface Target {
  crate: string;
  /** Harness file in `tools/bolero`; absent when the tests live in the crate. */
  source?: string;
  tests: string[];
  maxLength: number;
  /** Bounded harnesses `kani` verifies; each also runs in `smoke`. */
  proofs?: string[];
}

const targets: Target[] = targetList;
const workspace = path.join(root, 'test-results', 'bolero', 'workspace');
const retainedLock = path.join(root, 'tools', 'bolero', 'Cargo.lock');
const boleroVersion = '0.13.6';
const cliVersion = '0.13.5';
/** A proof without a verdict by then is halved once, then left to fuzzing. */
const kaniTimeoutMinutes = 15;

async function prepare(): Promise<void> {
  const { lints, patch } = await productionWorkspaceTables();
  await mkdir(workspace, { recursive: true });
  const manifest = {
    workspace: {
      resolver: '3',
      members: targets.map((target) => target.crate),
      lints,
    },
    patch,
    profile: {
      fuzz: {
        inherits: 'dev',
        'opt-level': 3,
        'codegen-units': 1,
        'debug-assertions': true,
        'overflow-checks': true,
      },
    },
  };
  await writeFile(path.join(workspace, 'Cargo.toml'), manifestText(manifest));
  // Members read the interop vectors by manifest-relative path
  // (`../shared/test-vectors`), so the generated members get that sibling too.
  await linkOnce(path.join(root, 'packages', 'shared'), path.join(workspace, 'shared'));
  for (const target of targets) {
    const original = path.join(root, 'packages', target.crate);
    const destination = path.join(workspace, target.crate);
    const originalManifest = table(
      Bun.TOML.parse(await Bun.file(path.join(original, 'Cargo.toml')).text()),
    );
    const generated = table(absoluteCargoPaths(originalManifest, original));
    generated.package = {
      ...table(generated.package),
      name: `${target.crate}-fuzz`,
      autotests: false,
    };
    generated.lib = {
      ...table(generated.lib ?? {}),
      name: target.crate.replaceAll('-', '_'),
      path: path.join(original, 'src', 'lib.rs'),
    };
    generated['dev-dependencies'] = {
      ...table(generated['dev-dependencies'] ?? {}),
      bolero: `=${boleroVersion}`,
    };
    if (typeof target.source === 'string') {
      generated.test = [{ name: 'fuzz', path: path.join(root, 'tools', 'bolero', target.source) }];
    }
    await mkdir(destination, { recursive: true });
    // Preserve manifest-relative test assets/build-script inputs without copying source.
    for (const entry of await readdir(original)) {
      if (entry === 'Cargo.toml' || entry === 'Cargo.lock' || entry === 'target') continue;
      await linkOnce(path.join(original, entry), path.join(destination, entry));
    }
    await writeFile(path.join(destination, 'Cargo.toml'), manifestText(generated));
  }
}

async function linkOnce(target: string, link: string): Promise<void> {
  if (await Bun.file(link).exists()) return;
  try {
    await symlink(target, link);
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
  }
}

function cargoEnv(args: string[], overrides: Record<string, string>): Record<string, string> {
  // This cfg compiles only test modules in the generated workspace. Preserve the
  // native x86 CPU floor when taking ownership of the instrumented build's flags.
  // cargo-bolero appends engine cfg/sanitizer flags to RUSTFLAGS. Encoded flags
  // take precedence in Cargo and would silently disable its instrumentation.
  const rustflags = `--cfg merkur_fuzz${args[1] === 'bolero' ? ' --cfg merkur_libfuzzer' : ''}${process.arch === 'x64' ? ' -C target-feature=+ssse3' : ''}`;
  return cargoEnvironment(rustflags, path.join(workspace, 'target'), overrides);
}

async function command(args: string[], overrides: Record<string, string> = {}): Promise<void> {
  const env = cargoEnv(args, overrides);
  const child = Bun.spawn(args, { cwd: workspace, env, stdout: 'inherit', stderr: 'inherit' });
  const code = await child.exited;
  if (code !== 0) throw new Error(`${args.join(' ')} failed (${code})`);
}

/** Kani has no `--locked`: a run that rewrote the copied lock resolved something new. */
async function assertLockUnchanged(generatedLock: string): Promise<void> {
  if ((await Bun.file(generatedLock).text()) !== (await Bun.file(retainedLock).text())) {
    throw new Error('cargo kani changed the generated Cargo.lock; run test:fuzz:update-lock');
  }
}

/**
 * One bounded proof. Kani exits non-zero on a refuted property; a cover it
 * cannot satisfy would otherwise pass, which is a vacuous proof.
 */
async function prove(crate: string, proof: string, timeoutMinutes: number): Promise<void> {
  // Kani stops its own solver at the budget; a signal to `cargo kani` would
  // orphan CBMC instead.
  const args = [
    'cargo',
    'kani',
    '--tests',
    '--package',
    `${crate}-fuzz`,
    '--harness',
    proof,
    '-Z',
    'unstable-options',
    // `#[kani::stub]` replaces the crypto a state-machine proof cannot reason about.
    '-Z',
    'stubbing',
    '--harness-timeout',
    `${timeoutMinutes}m`,
  ];
  const env = cargoEnv(args, {});
  env.CARGO_TARGET_DIR = path.join(workspace, 'target-kani');
  const child = Bun.spawn(args, { cwd: workspace, env, stdout: 'pipe', stderr: 'inherit' });
  let output = '';
  const decoder = new TextDecoder();
  for await (const chunk of child.stdout) {
    const text = decoder.decode(chunk, { stream: true });
    output += text;
    process.stdout.write(text);
  }
  const code = await child.exited;
  if (/timed out|TIMEOUT/.test(output)) {
    throw new Error(`${proof}: no verdict within ${timeoutMinutes} min`);
  }
  if (code !== 0 || !output.includes('VERIFICATION:- SUCCESSFUL')) {
    throw new Error(`${proof}: verification failed (${code})`);
  }
  const covers = /\*\* (\d+) of (\d+) cover properties satisfied/.exec(output);
  if (covers === null || covers[1] !== covers[2]) {
    throw new Error(`${proof}: ${covers?.[0] ?? 'no cover tally'}; the proof is vacuous`);
  }
}

async function run(): Promise<void> {
  const [mode = 'smoke', runsText = '10000'] = process.argv.slice(2);
  if (mode === 'kani') {
    // The second argument, when given, names one proof.
    const only = process.argv[3];
    await prepare();
    const generatedLock = path.join(workspace, 'Cargo.lock');
    await copyFile(retainedLock, generatedLock);
    let proved = 0;
    for (const target of targets) {
      for (const proof of target.proofs ?? []) {
        if (only !== undefined && proof !== only) continue;
        await prove(target.crate, proof, kaniTimeoutMinutes);
        await assertLockUnchanged(generatedLock);
        proved += 1;
      }
    }
    if (proved === 0) throw new Error(`No proof named ${only}`);
    return;
  }
  if (
    !['smoke', 'campaign', 'update-lock', 'policy'].includes(mode) ||
    !/^[1-9]\d*$/.test(runsText) ||
    !Number.isSafeInteger(Number(runsText))
  ) {
    throw new Error(
      'Usage: bun scripts/fuzz-tests.ts smoke|campaign|update-lock|policy [runs] | kani [proof]',
    );
  }
  await prepare();
  const generatedLock = path.join(workspace, 'Cargo.lock');
  if (await Bun.file(retainedLock).exists()) await copyFile(retainedLock, generatedLock);
  if (mode === 'update-lock') {
    await command(['cargo', 'update', '--workspace']);
    await copyFile(generatedLock, retainedLock);
    return;
  }
  if (!(await Bun.file(retainedLock).exists())) throw new Error('Run test:fuzz:update-lock first');
  if (mode === 'policy') {
    await command([
      'cargo',
      'deny',
      '--locked',
      '--config',
      path.join(root, 'deny.toml'),
      'check',
      'bans',
      'licenses',
      'sources',
    ]);
    return;
  }
  if (mode === 'smoke') {
    await command(['cargo', 'test', '--locked', '--workspace', 'fuzz_'], {
      BOLERO_RANDOM_ITERATIONS: '0',
      BOLERO_RANDOM_SEED: '1',
    });
    // Bounded proofs carry no seeds; the random engine gives them inputs here.
    await command(['cargo', 'test', '--locked', '--workspace', '--test', 'fuzz', 'proof_'], {
      BOLERO_RANDOM_ITERATIONS: '10000',
      BOLERO_RANDOM_SEED: '1',
    });
    return;
  }
  const version = Bun.spawnSync(['cargo', 'bolero', '--version'], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (version.exitCode !== 0 || version.stdout.toString().trim() !== `cargo-bolero ${cliVersion}`) {
    throw new Error(`cargo-bolero ${cliVersion} required; run setup:fuzz`);
  }
  for (const target of targets) {
    for (const test of target.tests) {
      const corpus = path.join(root, 'test-results', 'bolero', 'corpus', ...test.split('::'));
      const crashes = path.join(root, 'test-results', 'bolero', 'crashes', ...test.split('::'));
      await mkdir(corpus, { recursive: true });
      await mkdir(crashes, { recursive: true });
      await command(
        [
          'cargo',
          'bolero',
          'test',
          test,
          '--package',
          `${target.crate}-fuzz`,
          '--engine',
          'libfuzzer',
          '--rustc-bootstrap',
          '--runs',
          runsText,
          '-S',
          '1',
          '--max-input-length',
          String(target.maxLength),
          '--timeout',
          '2s',
          '--corpus-dir',
          corpus,
          '--crashes-dir',
          crashes,
          '--engine-args=-rss_limit_mb=2048',
        ],
        { MERKUR_FUZZ_CORPUS: corpus },
      );
    }
  }
}

if (import.meta.main) await run();
