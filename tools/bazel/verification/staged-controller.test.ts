import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type ControllerEngine, verifyReservedBatch } from './controller';
import type { RequiredCheck } from './events';
import type { EnginePlan, FrontEndEngine } from './front-end';
import { captureGitContext } from './git-context';
import { openReportOutput } from './report-output';
import {
  type LedgerSnapshot,
  parseLedger,
  type RevocationStore,
  type TestReservation,
} from './revocation';
import { materializeStagedSnapshot } from './staged-snapshot';
import { BAZEL_STATIC_GATES as STATIC_GATES } from './static-gates';

const sources = ['.bazelversion', 'BUILD.bazel', 'MODULE.bazel', 'input.ts'];
const staticOperations = STATIC_GATES.map((name) => ({
  name,
  checks: [{ label: `//staged:${name.replaceAll(':', '_')}`, kind: 'test', fresh: true } as const],
}));
const required: readonly RequiredCheck[] = [
  { label: '//staged:unit', kind: 'test', fresh: true },
  ...staticOperations.flatMap((operation) => operation.checks),
];
const plan: EnginePlan = {
  coverage: {
    files: ['input.ts'],
    docsOnly: false,
    required,
    deferred: [],
    pendingDeferred: [],
    reasons: ['input.ts'],
    staticOperations,
  },
  actionSources: ['input.ts'],
  analysisSources: sources.slice(0, 3),
  contextDigest: 'b'.repeat(64),
  pendingQualifications: [],
};
const unrelated = '//staged:unselected';
const unrelatedNonce = 'a'.repeat(64);

function fixture(format: 'sha1' | 'sha256') {
  const executable = process.env.MERKUR_STAGED_SNAPSHOT_GIT;
  if (executable === undefined || !path.isAbsolute(executable)) {
    throw new Error('Staged controller controls require their declared Git executable');
  }
  const directory = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'merkur-staged-controller-')));
  const live = path.join(directory, 'live');
  const home = path.join(directory, 'home');
  mkdirSync(live);
  mkdirSync(home);
  const sdk = Object.fromEntries(
    [
      'DYLD_LIBRARY_PATH',
      'DYLD_FALLBACK_LIBRARY_PATH',
      'LD_LIBRARY_PATH',
      'GIT_EXEC_PATH',
      'GIT_TEMPLATE_DIR',
    ].flatMap((key) => (process.env[key] === undefined ? [] : [[key, process.env[key]] as const])),
  );
  const runGit = (args: readonly string[]) => {
    const child = Bun.spawnSync([executable, ...args], {
      cwd: live,
      env: {
        ...sdk,
        HOME: home,
        PATH: '',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_SYSTEM: '/dev/null',
        GIT_AUTHOR_NAME: 'Controller control',
        GIT_AUTHOR_EMAIL: 'controller@example.invalid',
        GIT_COMMITTER_NAME: 'Controller control',
        GIT_COMMITTER_EMAIL: 'controller@example.invalid',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    if (child.exitCode !== 0 || child.signalCode) {
      throw new Error(`Declared Git failed: ${child.stderr.toString()}`);
    }
    return child.stdout;
  };
  runGit(['init', '--initial-branch=main', `--object-format=${format}`]);
  for (const source of sources) writeFileSync(path.join(live, source), 'committed\n');
  runGit(['add', '--', ...sources]);
  runGit(['commit', '-m', 'base']);
  writeFileSync(path.join(live, 'input.ts'), 'staged\n');
  runGit(['add', '--', 'input.ts']);
  const head = runGit(['rev-parse', 'HEAD^{commit}']).toString().trim();
  const git = captureGitContext((args) => runGit(args).toString(), head, head, true);
  const captured = {
    sourceRoot: live,
    destination: path.join(directory, 'index'),
    head,
    index: git.index,
    indexTree: runGit(['write-tree']).toString().trim(),
    runGit,
  };
  const staged = materializeStagedSnapshot(captured);
  writeFileSync(path.join(live, 'input.ts'), 'unstaged-private\n');
  let current: LedgerSnapshot = {
    revision: 'initial',
    ledger: parseLedger({ [unrelated]: { nonce: unrelatedNonce, state: 'ready' } }),
  };
  let revision = 0;
  const store: RevocationStore = {
    read: () => current,
    compareExchange(previous, ledger) {
      if (previous !== current) return null;
      current = { revision: String(++revision), ledger: parseLedger(ledger) };
      return current;
    },
  };
  return {
    directory,
    live,
    git,
    captured,
    staged,
    runGit,
    store,
    close: () => rmSync(directory, { recursive: true, force: true }),
  };
}

/** Synthetic engine completion isolates the genuine Git/materializer/controller boundary. */
function events(invocation: string) {
  return [
    { id: { started: {} }, started: { uuid: invocation, buildToolVersion: '9.2.0' } },
    ...required.flatMap((check) => {
      const configured = { label: check.label, configuration: { id: 'config' } };
      return [
        { id: { targetCompleted: configured }, completed: { success: true } },
        {
          id: { testResult: { ...configured, run: 1, shard: 1, attempt: 1 } },
          testResult: { status: 'PASSED' },
        },
        {
          id: { testSummary: configured },
          testSummary: { overallStatus: 'PASSED', totalRunCount: 1 },
        },
      ];
    }),
    {
      id: { buildFinished: {} },
      finished: { exitCode: { code: 0, name: 'SUCCESS' } },
      lastMessage: true,
    },
  ]
    .map((event) => JSON.stringify(event))
    .join('\n');
}

for (const format of ['sha1', 'sha256'] as const) {
  describe(`genuine ${format} staged controller`, () => {
    let active: ReturnType<typeof fixture> | undefined;
    beforeEach(() => {
      active = fixture(format);
    });
    afterEach(() => {
      active?.close();
      active = undefined;
    });

    for (const mutation of [
      'unstaged',
      'index-execution',
      'index-publication',
      'head-publication',
      'last-helper-read',
    ] as const) {
      test(`handles ${mutation} at the controller boundary`, async () => {
        const f = active;
        if (f === undefined) throw new Error('Staged controller fixture is absent');
        let staged = f.staged;
        if (mutation === 'last-helper-read') {
          let reads = 0;
          staged = materializeStagedSnapshot({
            ...f.captured,
            destination: path.join(f.directory, 'raced-index'),
            runGit(args) {
              const bytes = f.runGit(args);
              if (args[0] === 'ls-files' && args.includes('--stage') && ++reads === 4) {
                f.runGit(['commit', '--allow-empty', '-m', 'concurrent HEAD']);
              }
              return bytes;
            },
          });
          expect(staged.head).not.toBe(f.runGit(['rev-parse', 'HEAD^{commit}']).toString().trim());
        }
        let bound: TestReservation | undefined;
        let executed = 0;
        const engine: ControllerEngine = {
          version: '9.2.0',
          platform: 'darwin-arm64',
          readGit: async () => {
            staged.assertCurrent();
            return f.git;
          },
          plan: async () => plan,
          completeTestInventory: async () => [...required.map((check) => check.label), unrelated],
          bindTestReservation: (reservation) => {
            bound = reservation;
          },
          selectedChecks: async () => required,
          testConfigurations: () => new Map(required.map((check) => [check.label, 'config'])),
          execute: async (request: Parameters<FrontEndEngine['execute']>[0]) => {
            executed++;
            expect(readFileSync(path.join(request.root, 'input.ts'), 'utf8')).toBe('staged\n');
            expect(readFileSync(path.join(f.live, 'input.ts'), 'utf8')).toBe('unstaged-private\n');
            writeFileSync(path.join(f.live, 'input.ts'), 'later-unstaged\n');
            if (mutation === 'index-execution') f.runGit(['add', '--', 'input.ts']);
            return { events: events(request.invocation), exitCode: 0 };
          },
        };
        const output = openReportOutput(
          path.join(f.directory, 'expectations.json'),
          staged.manifest.root,
        );
        try {
          const completed = verifyReservedBatch({
            signal: new AbortController().signal,
            store: f.store,
            force: true,
            attempts: [
              {
                engine,
                options: {
                  root: staged.manifest.root,
                  destination: path.join(f.directory, 'execution'),
                  admittedUntracked: [],
                },
              },
            ],
            expectationOutputs: [output],
            retainReports: () => {},
            publishAdmission: async () => {
              await Promise.resolve();
              if (mutation === 'index-publication') f.runGit(['add', '--', 'input.ts']);
              if (mutation === 'head-publication')
                f.runGit(['commit', '--allow-empty', '-m', 'late HEAD']);
            },
          });
          if (mutation === 'last-helper-read') {
            await expect(completed).rejects.toThrow('HEAD or index changed');
            expect(executed).toBe(0);
          } else if (mutation.endsWith('publication')) {
            await expect(completed).rejects.toThrow('changed before controller completion');
          } else {
            const result = await completed;
            expect(result.admitted).toBe(mutation === 'unstaged');
            expect(result.results[0]?.currentAccepted).toBe(mutation === 'unstaged');
          }
          const nonce = bound?.snapshot.ledger['//staged:unit']?.nonce;
          expect(nonce).toBeDefined();
          const terminal = f.store.read().ledger['//staged:unit'];
          expect(terminal?.state).toBe(mutation === 'unstaged' ? 'ready' : 'pending');
          if (mutation === 'unstaged') expect(terminal?.nonce).toBe(nonce);
          else expect(terminal?.nonce).not.toBe(nonce);
          expect(f.store.read().ledger[unrelated]).toEqual({
            nonce: unrelatedNonce,
            state: 'ready',
          });
        } finally {
          output.close();
        }
      });
    }
  });
}
