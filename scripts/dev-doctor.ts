import '../packages/shared/src/e2e-wasm-bun';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Effect } from 'effect';
import { environmentSources } from '../packages/config/src/environment';
import { loadDevelopmentEnvironment, toolEnvironment } from './dev-environment';
import { probeRedis, redisEndpoint } from './dev-redis';

const CURRENT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(CURRENT_DIRECTORY, '..');
const TARGET_WASM = 'wasm32-unknown-unknown';
const DATAPLANE_BINARY =
  process.platform === 'win32'
    ? 'target/rust/release/merkur-dataplane.exe'
    : 'target/rust/release/merkur-dataplane';
const EDGE_BINARY =
  process.platform === 'win32'
    ? 'target/rust/debug/merkur-edge.exe'
    : 'target/rust/debug/merkur-edge';

interface CheckResult {
  readonly label: string;
  readonly ok: boolean;
  readonly details?: string;
  readonly critical?: boolean;
}

const checks: CheckResult[] = [];
const environment = await Effect.runPromise(
  Effect.result(loadDevelopmentEnvironment(path.join(REPO_ROOT, 'apps/server/.env'), process.env)),
);
if (process.argv.includes('--sources') && environment._tag === 'Success') {
  process.stdout.write(`${environmentSources(environment.success.sources)}\n`);
}
const manifest: unknown = await Bun.file(path.join(REPO_ROOT, 'package.json')).json();
const pinnedBun =
  typeof manifest === 'object' &&
  manifest !== null &&
  'packageManager' in manifest &&
  typeof manifest.packageManager === 'string'
    ? manifest.packageManager.replace('bun@', '')
    : '';

checks.push(await checkFile('apps/server/.env', true, 'create with: bun run setup'));
checks.push(await checkServerConfiguration());
checks.push({
  label: 'bun runtime',
  ok: process.versions.bun === pinnedBun,
  critical: true,
  details: `${process.versions.bun}; use the packageManager-pinned Bun ${pinnedBun}`,
});

checks.push(await checkCommand('cargo', true));
checks.push(await checkRustToolchain());
if (process.platform === 'darwin') checks.push(await checkCommand('swiftc', true));
checks.push(await checkCommand('rustup', true));
checks.push(await checkCommand('wasm-pack', true));
checks.push(await checkWasmOpt());
checks.push(await checkRedis());

checks.push(await checkRustTarget(TARGET_WASM));
checks.push(await checkFile(DATAPLANE_BINARY, false, 'build with: bun run build:dataplane'));
checks.push(
  await checkFile('packages/term-wasm/pkg/term_wasm.js', false, 'build with: bun run build:wasm'),
);
checks.push(
  await checkFile(
    'apps/web/src/term-wasm/pkg/term_wasm_bg.wasm',
    false,
    'sync with: bun run sync:wasm',
  ),
);
checks.push(await checkFile(EDGE_BINARY, false, 'built automatically by: bun run dev'));

let hasCriticalFailure = false;
for (const check of checks) {
  const status = check.ok ? 'OK' : check.critical ? 'FAIL' : 'WARN';
  const detail = check.details ? ` (${check.details})` : '';
  process.stdout.write(`${status.padEnd(5)} ${check.label}${detail}\n`);
  if (!check.ok && check.critical) {
    hasCriticalFailure = true;
  }
}

if (hasCriticalFailure) {
  process.stderr.write('\nOne or more critical prerequisites are missing.\n');
  process.exit(1);
}

process.stdout.write(
  '\nDoctor completed. The local edge registers itself through `bun run dev`.\n',
);

async function checkCommand(command: string, critical: boolean) {
  const resolved = Bun.which(command, { PATH: toolEnvironment(process.env).PATH });
  return {
    label: `command: ${command}`,
    ok: typeof resolved === 'string' && resolved.length > 0,
    details: resolved ?? 'not found in PATH',
    critical,
  };
}

async function checkServerConfiguration(): Promise<CheckResult> {
  return environment._tag === 'Success'
    ? {
        label: 'server configuration and OPAQUE pin',
        ok: true,
        details: 'validated',
        critical: true,
      }
    : {
        label: 'server configuration',
        ok: false,
        details: `${String(environment.failure)}; run bun run setup to add missing settings; repair invalid existing assignments explicitly`,
        critical: true,
      };
}

async function checkWasmOpt() {
  const resolved = Bun.which('wasm-opt');
  const ok = typeof resolved === 'string' && resolved.length > 0;
  return {
    label: 'command: wasm-opt',
    ok,
    details: ok ? resolved : 'optional; install with: brew install binaryen',
    critical: false,
  };
}

async function checkRedis(): Promise<CheckResult> {
  if (environment._tag !== 'Success') {
    return {
      label: 'Redis',
      ok: false,
      details: 'configuration must validate before a connectivity check',
      critical: true,
    };
  }
  const url = environment.success.config.redisUrl;
  const outcome = await Effect.runPromise(Effect.result(probeRedis(url)));
  return {
    label: 'Redis',
    ok: outcome._tag === 'Success',
    critical: true,
    details:
      outcome._tag === 'Success'
        ? `${redisEndpoint(url)} authenticated PING succeeded`
        : `${redisEndpoint(url)} authentication, TLS, or PING failed; verify this backend (local infrastructure: bun run infra:up)`,
  };
}

async function checkRustToolchain(): Promise<CheckResult> {
  const manifest = Bun.TOML.parse(
    await Bun.file(path.join(REPO_ROOT, 'rust-toolchain.toml')).text(),
  );
  const toolchain = 'toolchain' in manifest ? manifest.toolchain : undefined;
  const expected =
    typeof toolchain === 'object' &&
    toolchain !== null &&
    'channel' in toolchain &&
    typeof toolchain.channel === 'string'
      ? toolchain.channel
      : '';
  const rustc = Bun.which('rustc', { PATH: toolEnvironment(process.env).PATH });
  if (rustc === null)
    return { label: 'Rust toolchain', ok: false, details: 'rustc missing', critical: true };
  const child = Bun.spawn([rustc, '--version'], {
    cwd: REPO_ROOT,
    env: toolEnvironment(process.env),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const output = (await new Response(child.stdout).text()).trim();
  const exitCode = await child.exited;
  return {
    label: 'Rust toolchain',
    ok: exitCode === 0 && output.split(' ')[1] === expected,
    details: `${output || 'unavailable'}; required ${expected}; install with: rustup toolchain install ${expected}`,
    critical: true,
  };
}

async function checkRustTarget(target: string) {
  const rustupPath = Bun.which('rustup');
  if (!rustupPath) {
    return {
      label: `rust target: ${target}`,
      ok: false,
      details: 'rustup missing',
      critical: true,
    };
  }

  const proc = Bun.spawn([rustupPath, 'target', 'list', '--installed'], {
    cwd: REPO_ROOT,
    env: toolEnvironment(process.env),
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    return {
      label: `rust target: ${target}`,
      ok: false,
      details: stderr.trim() || `command failed with ${exitCode}`,
      critical: true,
    };
  }

  const stdout = await new Response(proc.stdout).text();
  const installedTargets = stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  return {
    label: `rust target: ${target}`,
    ok: installedTargets.includes(target),
    details: installedTargets.includes(target)
      ? 'installed'
      : `missing (run: rustup target add ${target})`,
    critical: true,
  };
}

async function checkFile(filePath: string, critical: boolean, hint?: string) {
  const absolutePath = path.join(REPO_ROOT, filePath);
  try {
    await access(absolutePath);
    return {
      label: `file: ${filePath}`,
      ok: true,
      critical,
    };
  } catch {
    return {
      label: `file: ${filePath}`,
      ok: false,
      details: hint,
      critical,
    };
  }
}
