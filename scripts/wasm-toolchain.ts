// Shared toolchain resolution for the repository's wasm-pack builds.
//
// WebAssembly crates need the same pinned rustc, the same pinned
// wasm-bindgen CLI, and the same PATH/RUSTUP_TOOLCHAIN handling. Keeping one
// copy means a toolchain bump cannot land for one crate and miss another,
// which would silently produce incompatible glue ABIs.

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CURRENT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));

export const REPO_ROOT = path.resolve(CURRENT_DIRECTORY, '..');
const WASM_BINDGEN_ROOT = path.join(REPO_ROOT, '.tools/wasm-bindgen');
const WASM_BINDGEN_BIN_DIRECTORY = path.join(WASM_BINDGEN_ROOT, 'bin');
const WASM_BINDGEN_BINARY = path.join(WASM_BINDGEN_BIN_DIRECTORY, 'wasm-bindgen');
const resolvedCargoHome = path.resolve(process.env.CARGO_HOME ?? path.join(os.homedir(), '.cargo'));
const CARGO_BIN_DIRECTORY = path.join(resolvedCargoHome, 'bin');
const RUSTC_BINARY = path.join(
  CARGO_BIN_DIRECTORY,
  process.platform === 'win32' ? 'rustc.exe' : 'rustc',
);
const CARGO_BINARY = path.join(
  CARGO_BIN_DIRECTORY,
  process.platform === 'win32' ? 'cargo.exe' : 'cargo',
);

/// Installs the wasm-bindgen CLI matching Cargo.lock, then builds `cratePath`
/// with wasm-pack. The generated glue and the linked wasm-bindgen runtime must
/// come from the same version or the module fails to instantiate at load.
/// `cargoArgs` reach `cargo build` after wasm-pack's `--`.
export async function buildWasmCrate(
  cratePath: string,
  cargoArgs: readonly string[] = [],
): Promise<void> {
  const pinnedRustToolchain = await resolvePinnedRustToolchain();
  await ensureWasmBindgenCli(pinnedRustToolchain);

  await runOrThrow(
    [
      'wasm-pack',
      'build',
      cratePath,
      '--target',
      'web',
      '--release',
      '--mode',
      'no-install',
      ...(cargoArgs.length === 0 ? [] : ['--', ...cargoArgs]),
    ],
    REPO_ROOT,
    pinnedRustToolchain,
  );
}

/// Installs the wasm-bindgen CLI matching Cargo.lock when it is absent or
/// stale. The same install provides `wasm-bindgen-test-runner`.
export async function ensureWasmBindgenCli(pinnedRustToolchain: string): Promise<void> {
  const requiredVersion = await resolveRequiredWasmBindgenVersion();
  const installedVersion = await resolveInstalledWasmBindgenVersion();
  if (installedVersion === requiredVersion) return;
  const installArgs = ['cargo', 'install', '--locked', 'wasm-bindgen-cli'];
  if (requiredVersion !== null) {
    installArgs.push('--version', requiredVersion);
  }
  installArgs.push('--root', WASM_BINDGEN_ROOT, '--force');
  await runOrThrow(installArgs, REPO_ROOT, pinnedRustToolchain);
}

/// The test runner the pinned wasm-bindgen CLI install provides.
export const WASM_BINDGEN_TEST_RUNNER = path.join(
  WASM_BINDGEN_BIN_DIRECTORY,
  'wasm-bindgen-test-runner',
);

export async function runOrThrow(
  cmd: string[],
  cwd: string,
  pinnedRustToolchain: string,
  extraEnv: Readonly<Record<string, string>> = {},
): Promise<void> {
  const cToolchain = await resolveWasmCToolchainEnv();
  const env: Record<string, string | undefined> = {
    ...process.env,
    ...cToolchain,
    // Prefer rustup's cargo/rustc proxies over system package-manager
    // binaries. Mixing Homebrew cargo/rustc with a rustup-installed wasm
    // target produces a misleading "target may not be installed" failure.
    // A resolved wasm32 C compiler's directory leads, for build scripts that
    // call `clang` by name (minicov's profile runtime).
    PATH: [
      ...(cToolchain.CC_wasm32_unknown_unknown === undefined
        ? []
        : [path.dirname(cToolchain.CC_wasm32_unknown_unknown)]),
      WASM_BINDGEN_BIN_DIRECTORY,
      CARGO_BIN_DIRECTORY,
      process.env.PATH ?? '',
    ].join(path.delimiter),
    ...extraEnv,
    ...(process.env.CARGO === undefined && existsSync(CARGO_BINARY) ? { CARGO: CARGO_BINARY } : {}),
    ...(process.env.RUSTC === undefined && existsSync(RUSTC_BINARY) ? { RUSTC: RUSTC_BINARY } : {}),
  };
  // An ambient beta/nightly override must not silently bypass
  // rust-toolchain.toml (including its wasm target). A dedicated Merkur
  // override remains available for controlled migration experiments.
  delete env.RUSTUP_TOOLCHAIN;
  if (process.env.MERKUR_RUST_TOOLCHAIN !== undefined) {
    env.RUSTUP_TOOLCHAIN = process.env.MERKUR_RUST_TOOLCHAIN;
  } else if (pinnedRustToolchain.length === 0) {
    throw new Error('resolved Rust toolchain cannot be empty');
  } else {
    // wasm-pack 0.15 asks rustup to resolve the repository toolchain file
    // itself. Its bundled parser does not understand the `targets` array in
    // our rust-toolchain.toml, even though rustup does. Pass the already
    // resolved channel explicitly so wasm-pack never reparses that file.
    env.RUSTUP_TOOLCHAIN = pinnedRustToolchain;
  }
  const proc = Bun.spawn(cmd, {
    cwd,
    env,
    stdout: 'inherit',
    stderr: 'inherit',
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    process.exit(exitCode);
  }
}

/// term-wasm links libzstd, which zstd-sys compiles for wasm32 with the C
/// compiler cc-rs selects for that target. Linux builds (CI, the Dockerfile)
/// install `clang` and `llvm`, whose unversioned binaries cc-rs finds on PATH.
/// Apple's clang has no WebAssembly backend, so macOS builds use Homebrew's
/// LLVM. An explicit `CC_`/`AR_wasm32_unknown_unknown` is left untouched.
async function resolveWasmCToolchainEnv(): Promise<Record<string, string>> {
  if (
    process.platform !== 'darwin' ||
    (process.env.CC_wasm32_unknown_unknown !== undefined &&
      process.env.AR_wasm32_unknown_unknown !== undefined)
  ) {
    return {};
  }
  const missing = new Error(
    'WASM builds compile libzstd for wasm32, which Apple clang cannot target: brew install llvm',
  );
  let prefix: string;
  try {
    const proc = Bun.spawn(['brew', '--prefix', 'llvm'], { stdout: 'pipe', stderr: 'pipe' });
    prefix = (await new Response(proc.stdout).text()).trim();
    if ((await proc.exited) !== 0) throw missing;
  } catch {
    throw missing;
  }
  const compiler = path.join(prefix, 'bin', 'clang');
  const archiver = path.join(prefix, 'bin', 'llvm-ar');
  if (!existsSync(compiler) || !existsSync(archiver)) throw missing;
  return {
    CC_wasm32_unknown_unknown: process.env.CC_wasm32_unknown_unknown ?? compiler,
    AR_wasm32_unknown_unknown: process.env.AR_wasm32_unknown_unknown ?? archiver,
  };
}

export async function resolvePinnedRustToolchain(): Promise<string> {
  const configuration = await readFile(path.join(REPO_ROOT, 'rust-toolchain.toml'), 'utf8');
  const channel = configuration.match(/^\s*channel\s*=\s*"([^"]+)"\s*$/m)?.[1];
  if (channel === undefined || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(channel)) {
    throw new Error('rust-toolchain.toml must declare an exact Rust release');
  }
  return channel;
}

async function resolveRequiredWasmBindgenVersion(): Promise<string | null> {
  try {
    const lockFile = await readFile(path.join(REPO_ROOT, 'Cargo.lock'), 'utf8');
    const match = lockFile.match(/name = "wasm-bindgen"\nversion = "([^"]+)"/);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

async function resolveInstalledWasmBindgenVersion(): Promise<string | null> {
  if (!existsSync(WASM_BINDGEN_BINARY)) {
    return null;
  }

  const proc = Bun.spawn([WASM_BINDGEN_BINARY, '--version'], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0 || proc.stdout === null) {
    return null;
  }

  const output = await new Response(proc.stdout).text();
  const match = output.trim().match(/^wasm-bindgen\s+(.+)$/);
  return match?.[1] ?? null;
}
