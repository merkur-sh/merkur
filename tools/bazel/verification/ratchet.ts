import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import {
  type RatchetAnalysis,
  readFallowReport,
  runRatchetAnalysis,
} from '../../../scripts/check-ratchet';
import { runConcurrently } from './concurrent-commands';
import { captureGitContext, type GitContext, validGitContext } from './git-context';
import { type GitObjectEvidence, withGitObjects } from './git-objects';
import { manifestFromInventory, type SourceManifest, validSourceManifest } from './snapshot';
import { type StaticSource, withStaticSources } from './static-sources';

/**
 * Run fallow's analyses over the private source and answer each in the order asked.
 *
 * An audit without a cache makes a temporary worktree of the base commit, and before it does it
 * removes every other audit's: those its repository lists, and those it finds in the temporary
 * directory, whichever process and repository made them. So the audits share a lane, the health
 * report, which makes none, runs beside them, and the temporary directory is this check's own,
 * out of reach of every other process's audits.
 */
function declaredAnalyses(
  analyses: readonly RatchetAnalysis[],
  options: {
    readonly fallow: string;
    readonly root: string;
    readonly scratch: string;
    readonly staged: boolean;
    readonly environment: Readonly<Record<string, string>>;
  },
): readonly ReturnType<typeof readFallowReport>[] {
  const audits = analyses.filter(({ args }) => args[0] === 'audit');
  const lanes = [
    ...(audits.length === 0 ? [] : [audits]),
    ...analyses.filter(({ args }) => args[0] !== 'audit').map((analysis) => [analysis]),
  ];
  const temporary = mkdtempSync(path.join(options.scratch, 'ratchet-analysis-'));
  let results: ReturnType<typeof runConcurrently>;
  try {
    results = runConcurrently({
      lanes: lanes.map((lane) =>
        lane.map(({ args }) => [
          options.fallow,
          ...(options.staged ? args.filter((arg) => arg !== '--staged') : args),
          '--no-cache',
          '--format',
          'json',
          '--quiet',
        ]),
      ),
      cwd: options.root,
      environment: { ...options.environment, TMPDIR: temporary },
      timeoutMs: 60_000,
    });
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
  const answers = new Map(
    lanes.flatMap((lane, index) =>
      lane.map(({ label }, position) => [label, results[index]?.[position]] as const),
    ),
  );
  return analyses.map(({ label }) => {
    const result = answers.get(label);
    if (result === undefined) throw new Error('Declared ratchet analysis has no answer');
    // An analysis that could not run says why on its own streams; keep that.
    if (result.exitCode !== 0 && result.exitCode !== 1)
      process.stderr.write(`${label}: ${result.stderr}${result.stdout}\n`);
    return readFallowReport(label, result.exitCode, result.signalCode, result.stdout);
  });
}

/** Run the existing ratchet policy against declared source bytes and native tools. */
export function declaredRatchet(options: {
  readonly root: string;
  readonly scratch: string;
  readonly git: string;
  readonly fallow: string;
  readonly runfiles: string;
  readonly pack: string;
  readonly objects: GitObjectEvidence;
  readonly context: GitContext;
  readonly source: SourceManifest;
  readonly sdkEnvironment: Readonly<Record<string, string>>;
  readonly generated?: readonly StaticSource[];
  readonly staged?: boolean;
}): number {
  if (
    !validGitContext(options.context) ||
    !validSourceManifest(options.source) ||
    options.source.commit !== options.context.head ||
    !path.isAbsolute(options.fallow) ||
    !path.isAbsolute(options.runfiles)
  )
    throw new Error('Declared ratchet source, Git identities and native Fallow are required');
  if (
    options.staged &&
    (options.context.base !== options.context.head ||
      options.context.candidate !== options.context.head ||
      options.context.committed.length !== 0 ||
      options.context.untracked.length !== 0 ||
      options.context.unstaged.length !== 0)
  )
    throw new Error('Staged ratchet requires the exact index projection against HEAD');
  const inventory = [
    ...options.context.index.map((entry) => entry.path),
    ...options.context.untracked,
  ].sort();
  if (
    JSON.stringify(inventory) !==
      JSON.stringify(options.source.inputs.map((input) => input.path)) ||
    manifestFromInventory(options.root, inventory, options.context.head).digest !==
      options.source.digest
  )
    throw new Error('Ratchet source does not match the complete captured Git inventory');
  let verdict: number | undefined;
  withGitObjects(
    {
      executable: options.git,
      root: options.root,
      scratch: options.scratch,
      pack: options.pack,
      evidence: options.objects,
      context: options.context,
      sdkEnvironment: options.sdkEnvironment,
    },
    (environment) => {
      const readGit = (args: readonly string[]): string => {
        const result = Bun.spawnSync([options.git, ...args], {
          cwd: options.root,
          env: environment,
          stdout: 'pipe',
          stderr: 'pipe',
          stdin: 'ignore',
        });
        if (result.exitCode !== 0 || result.signalCode)
          throw new Error(`Declared ratchet Git failed: ${result.stderr.toString()}`);
        return result.stdout.toString();
      };
      const current = captureGitContext(
        readGit,
        options.context.base,
        options.context.candidate,
        options.staged ?? false,
      );
      if (current.digest !== options.context.digest)
        throw new Error('Ratchet Git facts differ from the captured source context');
      const ignored = (relative: string): boolean => {
        const result = Bun.spawnSync([options.git, 'check-ignore', '--quiet', '--', relative], {
          cwd: options.root,
          env: environment,
          stdout: 'pipe',
          stderr: 'pipe',
          stdin: 'ignore',
        });
        if (result.signalCode || (result.exitCode !== 0 && result.exitCode !== 1))
          throw new Error('Declared generated-source ignore interpretation failed');
        return result.exitCode === 0;
      };
      withStaticSources(options.root, options.source, options.generated ?? [], ignored, () => {
        verdict = runRatchetAnalysis({
          root: options.root,
          base: options.context.base,
          changed: options.staged ? options.context.staged : options.context.changed,
          staged: options.staged ?? false,
          diffArgs: options.staged ? ['--staged'] : [],
          fallow: (analyses) =>
            declaredAnalyses(analyses, {
              fallow: options.fallow,
              root: options.root,
              scratch: options.scratch,
              // Fallow 3.17 audits current root bytes against HEAD; it has no --staged option.
              // The validated index projection makes that native diff exactly the staged diff.
              staged: options.staged ?? false,
              environment: { ...environment, RUNFILES_DIR: options.runfiles, RUST_LOG: 'error' },
            }),
        });
      });
      if (
        captureGitContext(
          readGit,
          options.context.base,
          options.context.candidate,
          options.staged ?? false,
        ).digest !== options.context.digest ||
        manifestFromInventory(options.root, inventory, options.context.head).digest !==
          options.source.digest
      )
        throw new Error('Ratchet source or Git context changed during analysis');
    },
  );
  if (verdict === undefined) throw new Error('Ratchet analysis did not return a verdict');
  return verdict;
}
