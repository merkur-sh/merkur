import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { STATIC_GATES } from '../../../scripts/gate-policy';
import type { OwnedDirectory } from '../bun/owned-files';
import {
  type ControllerEngine,
  controllerExpectations,
  verifyReservedBatch,
} from '../verification/controller';
import type { RequiredCheck } from '../verification/events';
import type { EnginePlan } from '../verification/front-end';
import { captureGitContext } from '../verification/git-context';
import { openReportOutput } from '../verification/report-output';
import {
  type LedgerSnapshot,
  type RevocationStore,
  reserveTests,
} from '../verification/revocation';
import { type CiArtifactStagingOptions, stageCiArtifacts } from './ci-artifact-staging';
import {
  bindControllerCiArtifacts,
  type PreparedCiArtifactInputs,
  type PreparedCiArtifacts,
} from './ci-preparation';

interface Fixture extends CiArtifactStagingOptions {
  readonly root: string;
  readonly batches: PreparedCiArtifacts[];
  readonly sources: PreparedCiArtifactInputs[];
}

async function fixture(run: (item: Fixture) => Promise<void>) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ci-artifact-staging-'));
  const source = path.join(root, 'engine');
  const prefix = 'bazel-out/native/bin/tools/bazel/packaging';
  mkdirSync(path.join(source, prefix), { recursive: true });
  writeFileSync(path.join(root, 'other-evidence'), 'untouched existing evidence');
  const label = '//tools/bazel/packaging:verify_linux_x64';
  const outputs = ['verify-linux-x64', 'verify-linux-x64.signing-inputs.json'].map(
    (destination) => ({
      path: `${prefix}/${destination}`,
      destination,
    }),
  );
  const artifacts = outputs.map((output) => {
    const bytes = Buffer.from(`captured original: ${output.destination}`);
    writeFileSync(path.join(source, output.path), bytes);
    return {
      producer: label,
      configuration: 'native',
      group: 'default',
      destination: output.destination,
      artifact: {
        path: output.path,
        digest: createHash('sha256').update(bytes).digest('hex'),
        length: String(bytes.length),
      },
    };
  });
  try {
    await run({
      root,
      batches: [{ invocation: 'actual-invocation', platform: 'linux-x86_64', artifacts }],
      sources: [
        {
          invocation: 'actual-invocation',
          materializedRoot: source,
          producers: [{ label, configuration: 'native', group: 'default', outputs }],
        },
      ],
      outputRoot: path.join(root, 'unsigned'),
      assertCurrent: () => {},
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function first(item: Fixture) {
  const batch = item.batches[0];
  const source = item.sources[0];
  const artifact = batch?.artifacts[0];
  const producer = source?.producers[0];
  if (
    batch === undefined ||
    source === undefined ||
    artifact === undefined ||
    producer === undefined
  )
    throw new Error('Missing fixture configured output');
  return { batch, source, artifact, producer };
}

test('stages the exact selected platform outputs and signing JSON without claiming ten files', async () => {
  await fixture(async (item) => {
    const output = await stageCiArtifacts(item);
    try {
      expect(readdirSync(item.outputRoot).sort()).toEqual([
        'verify-linux-x64',
        'verify-linux-x64.signing-inputs.json',
      ]);
      for (const artifact of first(item).batch.artifacts) {
        expect(readFileSync(path.join(item.outputRoot, artifact.destination))).toEqual(
          readFileSync(path.join(first(item).source.materializedRoot, artifact.artifact.path)),
        );
        output.verify(artifact.destination);
        expect(lstatSync(path.join(item.outputRoot, artifact.destination)).mode & 0o777).toBe(
          artifact.destination === 'verify-linux-x64' ? 0o555 : 0o444,
        );
      }
      expect(readFileSync(path.join(item.root, 'other-evidence')).toString()).toBe(
        'untouched existing evidence',
      );
    } finally {
      output.close();
    }
  });
});

for (const fault of [
  'missing',
  'extra',
  'foreign-producer',
  'foreign-config',
  'foreign-group',
] as const)
  test(`rejects ${fault} bound outputs before creating consumer namespace`, async () => {
    await fixture(async (item) => {
      const { batch, artifact } = first(item);
      const artifacts =
        fault === 'missing'
          ? batch.artifacts.slice(1)
          : fault === 'extra'
            ? [...batch.artifacts, artifact]
            : [
                {
                  ...artifact,
                  ...(fault === 'foreign-producer' ? { producer: '//foreign:output' } : {}),
                  ...(fault === 'foreign-config' ? { configuration: 'foreign' } : {}),
                  ...(fault === 'foreign-group' ? { group: 'foreign' } : {}),
                },
                ...batch.artifacts.slice(1),
              ];
      await expect(
        stageCiArtifacts({ ...item, batches: [{ ...batch, artifacts }] }),
      ).rejects.toThrow('CI staging bound output');
      expect(existsSync(item.outputRoot)).toBe(false);
    });
  });

test('rejects empty, duplicate, foreign and mixed-platform invocations', async () => {
  await fixture(async (item) => {
    const { batch, source } = first(item);
    for (const replacement of [
      { batches: [], sources: [] },
      { batches: [batch, batch], sources: [source, source] },
      { batches: [{ ...batch, invocation: 'foreign' }], sources: [source] },
      {
        batches: [batch, { ...batch, invocation: 'second', platform: 'darwin-arm64' }],
        sources: [source, { ...source, invocation: 'second' }],
      },
    ]) {
      await expect(stageCiArtifacts({ ...item, ...replacement })).rejects.toThrow('CI staging');
      expect(existsSync(item.outputRoot)).toBe(false);
    }
  });
});

test('uses original flat configured destinations, refusing redirects and duplicate contracts', async () => {
  await fixture(async (item) => {
    const { source, producer } = first(item);
    const original = producer.outputs[0];
    if (original === undefined) throw new Error('Missing fixture destination');
    for (const outputs of [
      [{ ...original, destination: '../outside' }, ...producer.outputs.slice(1)],
      [{ ...original, destination: 'different-basename' }, ...producer.outputs.slice(1)],
      [...producer.outputs, original],
    ]) {
      await expect(
        stageCiArtifacts({
          ...item,
          sources: [{ ...source, producers: [{ ...producer, outputs }] }],
        }),
      ).rejects.toThrow('captured destination');
      expect(existsSync(item.outputRoot)).toBe(false);
    }
  });
});

test('fresh output creation preserves existing publishers and rejects aliases', async () => {
  await fixture(async (item) => {
    mkdirSync(item.outputRoot);
    writeFileSync(path.join(item.outputRoot, 'foreign'), 'untouched');
    await expect(stageCiArtifacts(item)).rejects.toThrow();
    expect(readFileSync(path.join(item.outputRoot, 'foreign')).toString()).toBe('untouched');
    rmSync(item.outputRoot, { recursive: true });
    symlinkSync(first(item).source.materializedRoot, item.outputRoot);
    await expect(stageCiArtifacts(item)).rejects.toThrow();
    expect(lstatSync(item.outputRoot).isSymbolicLink()).toBe(true);
  });
});

test('requires an absolute output outside the original materialized engine root', async () => {
  await fixture(async (item) => {
    for (const outputRoot of [
      'relative-output',
      path.join(first(item).source.materializedRoot, 'unsigned'),
    ])
      await expect(stageCiArtifacts({ ...item, outputRoot })).rejects.toThrow('CI staging');
    expect(existsSync(item.outputRoot)).toBe(false);
  });
});

test('source content and aliases fail capture and remove only created consumer Files', async () => {
  await fixture(async (item) => {
    const { source, batch } = first(item);
    const last = batch.artifacts.at(-1);
    if (last === undefined) throw new Error('Missing last fixture');
    const original = path.join(source.materializedRoot, last.artifact.path);
    const bytes = readFileSync(original);
    for (const alias of [false, true]) {
      rmSync(original);
      if (alias) {
        const foreign = path.join(item.root, 'same-bytes-foreign');
        writeFileSync(foreign, bytes);
        symlinkSync(foreign, original);
      } else writeFileSync(original, 'changed original output');
      await expect(stageCiArtifacts(item)).rejects.toThrow();
      expect(readdirSync(item.outputRoot)).toEqual([]);
      expect(readFileSync(path.join(item.root, 'other-evidence')).toString()).toBe(
        'untouched existing evidence',
      );
      rmSync(item.outputRoot, { recursive: true });
    }
  });
});

test('nonce cancellation during copying and after copying removes owned outputs', async () => {
  await fixture(async (item) => {
    for (const failureCheck of [3, 6]) {
      let checks = 0;
      await expect(
        stageCiArtifacts({
          ...item,
          assertCurrent() {
            if (++checks === failureCheck) throw new Error('Current nonce was revoked');
          },
        }),
      ).rejects.toThrow('nonce was revoked');
      expect(readdirSync(item.outputRoot)).toEqual([]);
      rmdirSync(item.outputRoot);
    }
  });
});

test('captures immutable inventories before asynchronous reads', async () => {
  await fixture(async (item) => {
    const run = stageCiArtifacts(item);
    item.batches.splice(0);
    item.sources.splice(0);
    const output = await run;
    try {
      expect(readdirSync(item.outputRoot)).toHaveLength(2);
      output.verify('verify-linux-x64.signing-inputs.json');
    } finally {
      output.close();
    }
  });
});

test('returned journal stays held through late controller failure and clears its own Files', async () => {
  await fixture(async (item) => {
    const output = await stageCiArtifacts(item);
    try {
      output.verify('verify-linux-x64');
      // The owning controller rejects a later source/nonce failure after publication returned.
      output.removeCreated();
      expect(readdirSync(item.outputRoot)).toEqual([]);
      expect(readFileSync(path.join(item.root, 'other-evidence')).toString()).toBe(
        'untouched existing evidence',
      );
    } finally {
      output.close();
    }
  });
});

test('late foreign replacement is detected and never unlinked as owned output', async () => {
  await fixture(async (item) => {
    let output: OwnedDirectory | undefined;
    try {
      output = await stageCiArtifacts(item);
      const original = path.join(item.outputRoot, 'verify-linux-x64');
      renameSync(original, path.join(item.root, 'displaced-owned-output'));
      writeFileSync(original, 'foreign replacement must survive');
      expect(() => output?.verify('verify-linux-x64')).toThrow();
      expect(() => output?.removeCreated()).toThrow();
      expect(readFileSync(original).toString()).toBe('foreign replacement must survive');
    } finally {
      output?.close();
    }
  });
});

// Synthetic engine output bytes exercise the actual controller capability and lifecycle;
// they are not evidence that native production providers or executor pools are qualified.
type ControllerFault =
  | 'none'
  | 'late-source'
  | 'late-nonce'
  | 'late-root-directory'
  | 'late-root-alias'
  | 'late-output-namespace'
  | 'late-output-bytes'
  | 'late-output-mode'
  | 'late-extra-output';

async function controllerFixture(fault: ControllerFault) {
  await fixture(async (item) => {
    const { batch, source, producer } = first(item);
    const repository = path.join(item.root, 'source');
    mkdirSync(repository);
    const inputs = ['.bazelversion', 'BUILD.bazel', 'MODULE.bazel', 'input.ts'];
    for (const input of inputs) writeFileSync(path.join(repository, input), 'captured source');
    const head = 'a'.repeat(40);
    const git = () =>
      captureGitContext(
        (args) => {
          if (args[0] === 'rev-parse') return `${head}\n`;
          if (args.includes('-v')) return inputs.map((name) => `H ${name}\0`).join('');
          if (args.includes('--stage'))
            return inputs.map((name) => `100644 ${head} 0\t${name}\0`).join('');
          return '';
        },
        head,
        head,
      );
    let ledger: LedgerSnapshot = { revision: '0', ledger: {} };
    const store: RevocationStore = {
      read: () => ledger,
      compareExchange(previous, replacement) {
        if (previous.revision !== ledger.revision) return null;
        ledger = { revision: String(Number(ledger.revision) + 1), ledger: replacement };
        return ledger;
      },
    };
    const staticOperations = STATIC_GATES.map((name) => ({
      name,
      checks: [
        { label: `//test:${name.replaceAll(':', '_')}`, kind: 'test', fresh: true } as const,
      ],
    }));
    const tests: readonly RequiredCheck[] = [
      { label: '//test:unit', kind: 'test', fresh: true },
      ...staticOperations.flatMap((operation) => operation.checks),
    ];
    const checks: readonly RequiredCheck[] = [
      ...tests,
      { label: producer.label, kind: 'build', fresh: false },
    ];
    const plan: EnginePlan = {
      coverage: {
        files: ['input.ts'],
        docsOnly: false,
        required: checks,
        deferred: [],
        pendingDeferred: [],
        reasons: ['input.ts'],
        staticOperations,
      },
      actionSources: ['input.ts'],
      analysisSources: inputs.slice(0, 3),
      contextDigest: 'b'.repeat(64),
      pendingQualifications: [],
    };
    const captured: PreparedCiArtifactInputs[] = [];
    let publication: OwnedDirectory | undefined;
    let disrupted = false;
    let validations = 0;
    const displacedRoot = path.join(item.root, 'displaced-owned-root');
    const foreignRoot = path.join(item.root, 'foreign-root');
    const engine: ControllerEngine = {
      version: '9.2.0',
      platform: batch.platform,
      async readGit() {
        // This mutation happens in the final awaited source/Git validation after the
        // publication callback returned. A check inside that callback cannot catch it.
        if (
          publication !== undefined &&
          !disrupted &&
          !['none', 'late-source', 'late-nonce'].includes(fault)
        ) {
          disrupted = true;
          if (fault === 'late-root-directory' || fault === 'late-root-alias') {
            renameSync(item.outputRoot, displacedRoot);
            if (fault === 'late-root-directory') mkdirSync(item.outputRoot);
            else {
              mkdirSync(foreignRoot);
              symlinkSync(foreignRoot, item.outputRoot);
            }
            writeFileSync(path.join(item.outputRoot, 'foreign'), 'foreign root must survive');
          } else if (fault === 'late-extra-output') {
            writeFileSync(
              path.join(item.outputRoot, 'unconfigured-extra'),
              'foreign extra must survive',
            );
          } else {
            const original = path.join(item.outputRoot, 'verify-linux-x64');
            if (fault === 'late-output-namespace') {
              const bytes = readFileSync(original);
              renameSync(original, path.join(item.root, 'displaced-owned-file'));
              writeFileSync(original, bytes, { mode: 0o555 });
            } else if (fault === 'late-output-mode') chmodSync(original, 0o777);
            else {
              const size = readFileSync(original).byteLength;
              chmodSync(original, 0o644);
              writeFileSync(original, Buffer.alloc(size, 0x5a));
              chmodSync(original, 0o555);
            }
          }
        }
        return git();
      },
      plan: async () => plan,
      completeTestInventory: async () => tests.map((test) => test.label),
      bindTestReservation: () => {},
      selectedChecks: async () => checks,
      testConfigurations: () => new Map(checks.map((check) => [check.label, 'native'])),
      async execute(request) {
        captured.push({ ...source, invocation: request.invocation });
        const events: unknown[] = [
          { id: { started: {} }, started: { uuid: request.invocation, buildToolVersion: '9.2.0' } },
          ...tests.flatMap((test) => {
            const configured = { label: test.label, configuration: { id: 'native' } };
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
            id: { namedSet: { id: 'outputs' } },
            namedSetOfFiles: {
              files: batch.artifacts.map(({ artifact }) => ({
                name: path.posix.basename(artifact.path),
                pathPrefix: path.posix.dirname(artifact.path).split('/'),
                digest: artifact.digest,
                length: artifact.length,
              })),
            },
          },
          {
            id: { targetCompleted: { label: producer.label, configuration: { id: 'native' } } },
            completed: {
              success: true,
              outputGroup: [{ name: 'default', fileSets: [{ id: 'outputs' }] }],
            },
          },
          {
            id: { buildFinished: {} },
            finished: { exitCode: { code: 0 } },
            lastMessage: true,
          },
        ];
        return { events: events.map((event) => JSON.stringify(event)).join('\n'), exitCode: 0 };
      },
    };
    const expected = openReportOutput(path.join(item.root, 'expected.json'), repository);
    try {
      const run = verifyReservedBatch({
        signal: new AbortController().signal,
        attempts: [
          {
            options: {
              root: repository,
              destination: path.join(item.root, 'frozen'),
              admittedUntracked: [],
            },
            engine,
          },
        ],
        store,
        force: true,
        expectationOutputs: [expected],
        retainReports: () => {},
        validateAdmission(result) {
          validations++;
          controllerExpectations(result);
          if (publication === undefined) throw new Error('Missing actual staging journal');
          publication.verifyCreated(item.outputRoot);
        },
        async publishAdmission(result) {
          const bound = await bindControllerCiArtifacts(result, captured);
          publication = await stageCiArtifacts({
            batches: bound,
            sources: captured,
            outputRoot: item.outputRoot,
            assertCurrent: () => {
              controllerExpectations(result);
            },
          });
          if (fault === 'late-source')
            writeFileSync(path.join(repository, 'input.ts'), 'changed after staging returned');
          if (fault === 'late-nonce') reserveTests(store, ['//test:unit'], true);
        },
      }).catch((error: unknown) => {
        publication?.removeCreated();
        throw error;
      });
      if (fault === 'none') {
        expect((await run).admitted).toBe(true);
        expect(store.read().ledger['//test:unit']?.state).toBe('ready');
        expect(readdirSync(item.outputRoot)).toHaveLength(2);
        publication?.verify('verify-linux-x64.signing-inputs.json');
      } else {
        await expect(run).rejects.toThrow();
        expect(store.read().ledger['//test:unit']?.state).toBe('pending');
        if (fault === 'late-root-directory' || fault === 'late-root-alias') {
          expect(readFileSync(path.join(item.outputRoot, 'foreign')).toString()).toBe(
            'foreign root must survive',
          );
          expect(readdirSync(displacedRoot)).toEqual([]);
          expect(lstatSync(item.outputRoot).isSymbolicLink()).toBe(fault === 'late-root-alias');
        } else if (fault === 'late-output-namespace') {
          // Identical foreign bytes do not confer ownership; failed cleanup preserves them.
          expect(readFileSync(path.join(item.outputRoot, 'verify-linux-x64'))).toEqual(
            readFileSync(path.join(item.root, 'displaced-owned-file')),
          );
          expect(
            existsSync(path.join(item.outputRoot, 'verify-linux-x64.signing-inputs.json')),
          ).toBe(false);
        } else if (fault === 'late-extra-output') {
          expect(readdirSync(item.outputRoot)).toEqual(['unconfigured-extra']);
          expect(readFileSync(path.join(item.outputRoot, 'unconfigured-extra')).toString()).toBe(
            'foreign extra must survive',
          );
        } else expect(readdirSync(item.outputRoot)).toEqual([]);
      }
      if (fault === 'none') expect(validations).toBe(1);
      else if (fault === 'late-source' || fault === 'late-nonce') expect(validations).toBe(0);
      else {
        expect(disrupted).toBe(true);
        expect(validations).toBe(1);
      }
      expect(readFileSync(path.join(item.root, 'other-evidence')).toString()).toBe(
        'untouched existing evidence',
      );
    } finally {
      publication?.close();
      expected.close();
    }
  });
}

for (const fault of [
  'none',
  'late-source',
  'late-nonce',
  'late-root-directory',
  'late-root-alias',
  'late-output-namespace',
  'late-output-bytes',
  'late-output-mode',
  'late-extra-output',
] as const)
  test(`actual controller binds configured outputs and retires staging after ${fault}`, () =>
    controllerFixture(fault));
