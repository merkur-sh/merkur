/**
 * `check:types`: `tsc --noEmit` over every TypeScript project, three at a time.
 *
 *   bun run check:types                               every project
 *   bun run scripts/check-types.ts --project <tsconfig>  one, as each Bazel test runs it
 *
 * Bazel runs one test per project (`//:check_types`) over a checkout of the files that project's
 * program reads (`tools/bazel/types.bzl`, `scripts/bazel-types.ts`).
 */

import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '..');
const WORKSPACE_ROOTS = ['apps', 'packages'];
/**
 * Projects that are not Bun workspaces but still ship checked source.
 *
 * The per-app `scripts/` directories are here because a workspace tsconfig
 * includes only `src/**` and `migrations/**`, so nothing type-checked them.
 * `apps/server/scripts/telemetry-smoke.ts` had drifted five config fields out
 * of date and would have failed at runtime while `bun run check:types` stayed
 * green — exactly the silent rot this list exists to prevent.
 */
const STANDALONE_PROJECTS = [
  'scripts/tsconfig.json',
  'tests/tsconfig.json',
  'apps/server/scripts/tsconfig.json',
];
const TSC_ARGS = ['bunx', 'tsc', '--noEmit', '--noUnusedLocals', '--noUnusedParameters'];
const DEFAULT_CONCURRENCY = 3;
const CONCURRENCY_ENVIRONMENT_VARIABLE = 'CHECK_TYPES_CONCURRENCY';

interface ProjectResult {
  readonly project: string;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Every project's `tsconfig.json`, by its path from `root`: each workspace's and the standalone ones. */
export function typeProjects(root = ROOT): string[] {
  const discovered: string[] = [];

  for (const workspaceRoot of WORKSPACE_ROOTS) {
    const entries = readdirSync(path.join(root, workspaceRoot), { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) {
        continue;
      }

      const tsconfigPath = path.posix.join(workspaceRoot, entry.name, 'tsconfig.json');
      if (existsSync(path.join(root, tsconfigPath))) {
        discovered.push(tsconfigPath);
      }
    }
  }

  for (const tsconfigPath of STANDALONE_PROJECTS) {
    if (existsSync(path.join(root, tsconfigPath))) {
      discovered.push(tsconfigPath);
    }
  }

  return discovered.sort((left, right) => left.localeCompare(right));
}

/** The projects to check: the one `--project` names, which must be one of them, or all. */
async function selectedProjects(): Promise<string[]> {
  const projects = typeProjects();
  const flag = process.argv.indexOf('--project');
  if (flag === -1) return projects;
  const project = process.argv[flag + 1];
  if (project === undefined || !projects.includes(project)) {
    await writeConfigurationError(
      `--project must name one of: ${projects.join(', ')}; got ${project ?? 'nothing'}\n`,
    );
    process.exit(1);
  }
  return [project];
}

async function main(): Promise<void> {
  const projects = await selectedProjects();
  const concurrency = await resolveConcurrency();
  const results = await runProjects(projects, concurrency);
  let failureExitCode = 0;

  for (const result of results) {
    if (result.stdout.length > 0) {
      process.stdout.write(`\n[${result.project}:stdout]\n${result.stdout}`);
      if (!result.stdout.endsWith('\n')) {
        process.stdout.write('\n');
      }
    }
    if (result.stderr.length > 0) {
      process.stderr.write(`\n[${result.project}:stderr]\n${result.stderr}`);
      if (!result.stderr.endsWith('\n')) {
        process.stderr.write('\n');
      }
    }

    if (result.exitCode !== 0 && failureExitCode === 0) {
      failureExitCode = result.exitCode;
    }
  }

  if (failureExitCode !== 0) {
    process.exitCode = failureExitCode;
  }
}

if (import.meta.main) {
  await main();
}

async function resolveConcurrency(): Promise<number> {
  const configured = process.env[CONCURRENCY_ENVIRONMENT_VARIABLE];
  if (configured === undefined) {
    return DEFAULT_CONCURRENCY;
  }

  if (!/^[1-9]\d*$/.test(configured)) {
    await writeConfigurationError(
      `${CONCURRENCY_ENVIRONMENT_VARIABLE} must be a positive integer without leading zeros.\n`,
    );
    process.exit(1);
  }

  const parsed = Number(configured);
  if (!Number.isSafeInteger(parsed)) {
    await writeConfigurationError(
      `${CONCURRENCY_ENVIRONMENT_VARIABLE} exceeds the safe integer range.\n`,
    );
    process.exit(1);
  }

  return parsed;
}

async function writeConfigurationError(message: string): Promise<void> {
  await new Promise<void>((resolve) => {
    process.stderr.write(message, () => resolve());
  });
}

async function runProjects(projectPaths: string[], concurrency: number): Promise<ProjectResult[]> {
  const results: Array<ProjectResult | undefined> = new Array(projectPaths.length);
  let nextProjectIndex = 0;

  async function runWorker(): Promise<void> {
    while (nextProjectIndex < projectPaths.length) {
      const projectIndex = nextProjectIndex;
      nextProjectIndex += 1;
      const project = projectPaths[projectIndex];
      if (project === undefined) {
        throw new Error(`Missing project at index ${projectIndex}`);
      }
      results[projectIndex] = await runProject(project);
    }
  }

  const workerCount = Math.min(concurrency, projectPaths.length);
  await Promise.all(Array.from({ length: workerCount }, runWorker));

  return results.map((result, index) => {
    if (result === undefined) {
      throw new Error(`Missing type-check result at index ${index}`);
    }
    return result;
  });
}

async function runProject(project: string): Promise<ProjectResult> {
  const cmd = [...TSC_ARGS, '-p', project];
  const proc = Bun.spawn(cmd, {
    cwd: ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return { project, exitCode, stdout, stderr };
}
