import '../packages/shared/src/e2e-wasm-bun';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Effect } from 'effect';
import { environmentSources } from '../packages/config/src/environment';
import { loadDevelopmentEnvironment, toolEnvironment } from './dev-environment';
import { probeRedis, redisEndpoint } from './dev-redis';
import { nativeProgram } from './native-artifacts';

const CURRENT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(CURRENT_DIRECTORY, '..');

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
const pinnedBun = (await Bun.file(path.join(REPO_ROOT, '.bun-version')).text()).trim();

checks.push(await checkFile('apps/server/.env', true, 'create with: bun run setup'));
checks.push(await checkServerConfiguration());
checks.push({
  label: 'bun runtime',
  ok: process.versions.bun === pinnedBun,
  critical: true,
  details: `${process.versions.bun}; use the Bun .bun-version pins, ${pinnedBun}`,
});

// Bazel brings Rust, Node and the WebAssembly tools; the Secure Enclave bridge compiles with the
// selected Xcode's Swift.
checks.push(await checkCommand('bazel', true));
if (process.platform === 'darwin') checks.push(await checkCommand('swiftc', true));
checks.push(await checkRedis());

checks.push(
  await checkFile(
    path.relative(REPO_ROOT, nativeProgram(REPO_ROOT, 'merkur-dataplane')),
    false,
    'build with: bun run build:native',
  ),
);
checks.push(
  await checkFile('packages/term-wasm/pkg/term_wasm.js', false, 'build with: bun run build:wasm'),
);
checks.push(
  await checkFile(
    'apps/web/src/term-wasm/pkg/term_wasm_bg.wasm',
    false,
    'build with: bun run build:wasm',
  ),
);
checks.push(
  await checkFile(
    path.relative(REPO_ROOT, nativeProgram(REPO_ROOT, 'merkur-edge')),
    false,
    'built automatically by: bun run dev',
  ),
);

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
