import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { STATIC_GATES } from '../../../scripts/gate-policy';
import { verificationArguments } from '../verification/cli';
import {
  type ControllerEngine,
  controllerExpectations,
  verifyReservedBatch,
} from '../verification/controller';
import {
  type EnginePlan,
  executePreparedVerification,
  type FrontEndEngine,
  type PreparedVerification,
  type PublishedVerificationExpectations,
  prepareVerification,
  rejectPreparedVerification,
  type VerificationExpectation,
  type verifySnapshot,
  writeVerificationExpectations,
} from '../verification/front-end';
import { captureGitContext } from '../verification/git-context';
import { openReportOutput } from '../verification/report-output';
import {
  type LedgerSnapshot,
  type RevocationStore,
  reserveTests,
} from '../verification/revocation';

const head = 'a'.repeat(40);
const inputs = ['.bazelversion', 'BUILD.bazel', 'MODULE.bazel', 'input.ts'];
const staticOperations = STATIC_GATES.map((name) => ({
  name,
  checks: [{ label: `//test:${name.replaceAll(':', '_')}`, kind: 'test', fresh: true } as const],
}));
const required = [
  { label: '//test:unit', kind: 'test', fresh: true } as const,
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
  analysisSources: inputs.slice(0, 3),
  contextDigest: 'b'.repeat(64),
  pendingQualifications: [],
};

function git(index = inputs, changed: readonly string[] = []) {
  return captureGitContext(
    (args) => {
      if (args[0] === 'rev-parse') return `${head}\n`;
      if (args.includes('-v')) return index.map((name) => `H ${name}\0`).join('');
      if (args.includes('--stage'))
        return index.map((name) => `100644 ${head} 0\t${name}\0`).join('');
      if (args[0] === 'diff' && !args.includes('--cached') && !args.includes(head))
        return changed.map((name) => `${name}\0`).join('');
      return '';
    },
    head,
    head,
  );
}

function events(invocation: string, omit = false): string {
  return [
    { id: { started: {} }, started: { uuid: invocation, buildToolVersion: '9.2.0' } },
    ...required.flatMap((check) => {
      if (omit && check.label === '//test:unit') return [];
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

async function fixture(
  run: (root: string, options: Parameters<typeof verifySnapshot>[0]) => Promise<void>,
): Promise<void> {
  const parent = mkdtempSync(path.join(os.tmpdir(), 'merkur-front-end-'));
  const root = path.join(parent, 'live');
  mkdirSync(root);
  for (const name of inputs) writeFileSync(path.join(root, name), 'captured bytes');
  try {
    await run(root, {
      root,
      destination: path.join(parent, 'frozen'),
      admittedUntracked: [],
      publishExpectation: () => {
        throw new Error('Fixture uses complete owned batch publication');
      },
    });
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
}

function engine(overrides: Partial<FrontEndEngine> = {}): FrontEndEngine {
  return {
    version: '9.2.0',
    platform: 'macos_arm64',
    readGit: async () => git(),
    plan: async () => plan,
    execute: async (request) => ({ events: events(request.invocation), exitCode: 0 }),
    ...overrides,
  };
}

import { reconstructControllerCiReport } from './ci-admission';

import {
  bindControllerCiArtifacts,
  bindPreparedCiArtifacts,
  captureControllerCiExpectations,
  confirmCiExpectations,
  reconstructPreparedCiBatch,
  reconstructPreparedCiEvidence,
} from './ci-preparation';

async function confirm(
  prepared: readonly PreparedVerification[],
  options: Parameters<typeof verifySnapshot>[0],
  before?: (contexts: readonly VerificationExpectation[]) => void | Promise<void>,
) {
  const first = prepared[0];
  if (first === undefined) throw new Error('Fixture preparation is absent');
  const file = path.join(path.dirname(options.destination), `${first.expectation.invocation}.json`);
  const output = openReportOutput(file, options.root);
  try {
    return await confirmCiExpectations(prepared, async (contexts) => {
      await before?.(contexts);
      return writeVerificationExpectations(prepared, [output]);
    });
  } finally {
    output.close();
  }
}

// Synthetic engines test ownership; publication uses the actual local root writer and flush.
// These controls do not qualify hosted storage, engines or pools.
test('CI captures expected authority only from confirmed owned preparations', async () => {
  await fixture(async (_root, options) => {
    const prepared = await prepareVerification(options, engine());
    let published = false;
    const confirmed = await confirm([prepared], options, (contexts) => {
      published = contexts.length === 1 && contexts[0] === prepared.expectation;
    });
    expect(published).toBe(true);
    expect(Object.isFrozen(confirmed.expectations)).toBe(true);
    expect(Object.isFrozen(confirmed.expectations[0]?.required)).toBe(true);
    const report = await executePreparedVerification(prepared);
    expect(reconstructPreparedCiEvidence(confirmed, report).currentAccepted).toBe(true);
    for (const change of [
      { invocation: '22222222-2222-4222-8222-222222222222' },
      { platform: 'linux_x64' },
      { required: [] },
      { context: { ...report.evidence.context, configuredDigest: 'c'.repeat(64) } },
    ])
      expect(() =>
        reconstructPreparedCiEvidence(confirmed, {
          evidence: { ...report.evidence, ...change },
          expected: confirmed.expectations,
          currentAccepted: true,
        }),
      ).toThrow();
  });
});

test('uploaded JSON cannot forge preparations or publication capabilities', async () => {
  await fixture(async (_root, options) => {
    const prepared = await prepareVerification(options, engine());
    const copied = JSON.parse(JSON.stringify(prepared));
    await expect(
      confirmCiExpectations([copied], () => {
        throw new Error('Forged preparation reached publication');
      }),
    ).rejects.toThrow();
    const confirmed = await confirm([prepared], options);
    const report = await executePreparedVerification(prepared);
    for (const forged of [
      { expectations: confirmed.expectations },
      JSON.parse(JSON.stringify(confirmed)),
    ])
      expect(() => reconstructPreparedCiEvidence(forged, report)).toThrow();
    for (const absent of [{ currentAccepted: true }, { evidence: {} }, { phase: 'blocked' }])
      expect(() => reconstructPreparedCiEvidence(confirmed, absent)).toThrow();
  });
});

test('publisher failure produces no confirmation or dispatch', async () => {
  await fixture(async (_root, options) => {
    let dispatched = false;
    const prepared = await prepareVerification(
      options,
      engine({
        execute: async () => {
          dispatched = true;
          throw new Error('Unexpected engine execution');
        },
      }),
    );
    await expect(
      confirm([prepared], options, () => {
        throw new Error('Publisher refused durable storage');
      }),
    ).rejects.toThrow('Publisher refused');
    await expect(executePreparedVerification(prepared)).rejects.toThrow();
    expect(dispatched).toBe(false);
  });
});

test('rejection while publisher awaits prevents a confirmation and dispatch', async () => {
  await fixture(async (_root, options) => {
    const prepared = await prepareVerification(options, engine());
    let finish = () => {};
    let entered = () => {};
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const start = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const pending = confirm([prepared], options, async () => {
      entered();
      await gate;
    });
    await start;
    rejectPreparedVerification(prepared);
    finish();
    await expect(pending).rejects.toThrow();
    await expect(executePreparedVerification(prepared)).rejects.toThrow();
  });
});

test('duplicate platform preparations refuse the whole publication batch', async () => {
  await fixture(async (_a, a) =>
    fixture(async (_b, b) => {
      const first = await prepareVerification(a, engine());
      const second = await prepareVerification(b, engine());
      let published = false;
      await expect(
        confirm([first, second], a, () => {
          published = true;
        }),
      ).rejects.toThrow();
      expect(published).toBe(false);
      await expect(executePreparedVerification(first)).rejects.toThrow();
      await expect(executePreparedVerification(second)).rejects.toThrow();
    }),
  );
});

test('a confirmed distinct-platform batch binds each report to its own captured invocation', async () => {
  await fixture(async (_a, a) =>
    fixture(async (_b, b) => {
      const first = await prepareVerification(a, engine());
      const second = await prepareVerification(b, engine({ platform: 'linux_arm64' }));
      const confirmed = await confirm([first, second], a, () => {});
      const reports = await Promise.all([
        executePreparedVerification(first),
        executePreparedVerification(second),
      ]);
      for (const report of reports)
        expect(reconstructPreparedCiEvidence(confirmed, report).currentAccepted).toBe(true);
      const report = reports[0];
      if (report === undefined) throw new Error('Fixture report is absent');
      expect(() =>
        reconstructPreparedCiEvidence(confirmed, {
          ...report,
          evidence: { ...report.evidence, invocation: second.expectation.invocation },
        }),
      ).toThrow();
    }),
  );
});

test('batch reconstruction requires every captured report and returns detached immutable verdicts', async () => {
  await fixture(async (_a, a) =>
    fixture(async (_b, b) => {
      const first = await prepareVerification(a, engine());
      const second = await prepareVerification(b, engine({ platform: 'linux_arm64' }));
      const confirmed = await confirm([first, second], a, () => {});
      const one = await executePreparedVerification(first);
      const two = await executePreparedVerification(second);
      const verdicts = reconstructPreparedCiBatch(confirmed, [two, one]);
      expect(verdicts.map((report) => report.invocation)).toEqual([
        first.expectation.invocation,
        second.expectation.invocation,
      ]);
      expect(Object.isFrozen(verdicts)).toBe(true);
      expect(Object.isFrozen(verdicts[0]?.source.inputs)).toBe(true);
      expect(Object.isFrozen(verdicts[0]?.events.checks)).toBe(true);
      expect(verdicts[0]?.source).not.toBe(one.evidence.snapshot);
      for (const reports of [[], [one], [one, one], [one, two, two]])
        expect(() => reconstructPreparedCiBatch(confirmed, reports)).toThrow();
      expect(() =>
        reconstructPreparedCiBatch({ expectations: confirmed.expectations }, [one, two]),
      ).toThrow();
      expect(() =>
        reconstructPreparedCiBatch(confirmed, [
          one,
          {
            ...two,
            evidence: { ...two.evidence, invocation: '22222222-2222-4222-8222-222222222222' },
          },
        ]),
      ).toThrow();
      const omitted = required[0]?.label;
      if (omitted === undefined) throw new Error('Fixture check is absent');
      expect(() =>
        reconstructPreparedCiBatch(confirmed, [
          one,
          {
            ...two,
            evidence: {
              ...two.evidence,
              required: two.evidence.required.filter((check) => check.label !== omitted),
              buildEvents: events(two.evidence.invocation, true),
            },
          },
        ]),
      ).toThrow();
      expect(() =>
        reconstructPreparedCiBatch(confirmed, [
          one,
          {
            ...two,
            evidence: { ...two.evidence, processExitCode: 37 },
          },
        ]),
      ).toThrow();
    }),
  );
});

test('CI propagates the actual durable full-batch publication receipt', async () => {
  await fixture(async (_a, a) =>
    fixture(async (_b, b) => {
      const first = await prepareVerification(a, engine());
      const second = await prepareVerification(b, engine({ platform: 'linux_arm64' }));
      const prepared = [first, second];
      const file = path.join(path.dirname(a.destination), 'published-contexts.json');
      const output = openReportOutput(file, a.root);
      try {
        const confirmed = await confirmCiExpectations(prepared, () =>
          writeVerificationExpectations(prepared, [output]),
        );
        expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(confirmed.expectations);
        expect(confirmed.expectations).toHaveLength(2);
        expect(confirmed.expectations[0]).toBe(first.expectation);
        expect(confirmed.expectations[1]).toBe(second.expectation);
      } finally {
        output.close();
      }
    }),
  );
});

test('CI cannot confirm absent, copied, closed or changed publication receipts', async () => {
  for (const kind of ['absent', 'structural', 'copied', 'serialized', 'closed', 'changed']) {
    await fixture(async (_root, options) => {
      const prepared = await prepareVerification(options, engine());
      const file = path.join(path.dirname(options.destination), 'publication.json');
      const output = openReportOutput(file, options.root);
      let minted = false;
      const guard =
        kind === 'absent'
          ? 'An owned durable expectation publication receipt is required'
          : kind === 'closed'
            ? 'An open owned report output is required'
            : kind === 'changed'
              ? 'Owned publication'
              : 'An owned durable receipt for the exact preparation batch is required';
      try {
        await expect(
          confirmCiExpectations([prepared], () => {
            if (kind === 'absent') return undefined as unknown as PublishedVerificationExpectations;
            if (kind === 'structural') return { sha256: 'a'.repeat(64) };
            const receipt = writeVerificationExpectations([prepared], [output]);
            minted = true;
            if (kind === 'copied') return { ...receipt };
            if (kind === 'serialized') return JSON.parse(JSON.stringify(receipt));
            if (kind === 'closed') output.close();
            if (kind === 'changed') writeFileSync(file, 'replaced context bytes');
            return receipt;
          }),
        ).rejects.toThrow(guard);
        expect(minted).toBe(kind !== 'absent' && kind !== 'structural');
        await expect(executePreparedVerification(prepared)).rejects.toThrow();
      } finally {
        output.close();
      }
    });
  }
});

test('CI refuses a genuine receipt for only part or another ordering of its batch', async () => {
  for (const kind of ['subset', 'reordered'])
    await fixture(async (_a, a) =>
      fixture(async (_b, b) => {
        const first = await prepareVerification(a, engine());
        const second = await prepareVerification(b, engine({ platform: 'linux_arm64' }));
        const output = openReportOutput(
          path.join(path.dirname(a.destination), 'contexts.json'),
          a.root,
        );
        try {
          await expect(
            confirmCiExpectations([first, second], () =>
              writeVerificationExpectations(kind === 'subset' ? [first] : [second, first], [
                output,
              ]),
            ),
          ).rejects.toThrow('An owned durable receipt for the exact preparation batch is required');
          await expect(executePreparedVerification(first)).rejects.toThrow();
          await expect(executePreparedVerification(second)).rejects.toThrow();
        } finally {
          output.close();
        }
      }),
    );
});

const artifactProducer = {
  label: '//scripts:release_verifier',
  configuration: 'config',
  group: 'default',
  outputs: [{ path: 'bazel-out/native/bin/verify.bin', destination: 'verify' }],
};

async function artifactFixture(
  run: (
    confirmed: Awaited<ReturnType<typeof confirmCiExpectations>>,
    reports: readonly Awaited<ReturnType<typeof executePreparedVerification>>[],
    inventories: readonly {
      invocation: string;
      materializedRoot: string;
      producers: readonly (typeof artifactProducer)[];
    }[],
  ) => Promise<void>,
) {
  await fixture(async (_a, a) =>
    fixture(async (_b, b) => {
      const preparations: PreparedVerification[] = [];
      const inventories = [];
      for (const [options, platform] of [
        [a, 'macos_arm64'],
        [b, 'linux_arm64'],
      ] as const) {
        const output = Buffer.from(`unsigned fixture for ${platform}`);
        const materializedRoot = path.join(path.dirname(options.destination), 'engine');
        mkdirSync(path.join(materializedRoot, 'bazel-out/native/bin'), { recursive: true });
        writeFileSync(path.join(materializedRoot, 'bazel-out/native/bin/verify.bin'), output);
        const prepared = await prepareVerification(
          options,
          engine({
            platform,
            plan: async () => ({
              ...plan,
              coverage: {
                ...plan.coverage,
                required: [
                  ...required,
                  { label: artifactProducer.label, kind: 'build', fresh: false },
                ],
              },
            }),
            execute: async (request) => {
              const original = events(request.invocation)
                .split('\n')
                .map((line) => JSON.parse(line));
              original.splice(
                original.length - 1,
                0,
                {
                  id: { namedSet: { id: 'outputs' } },
                  namedSetOfFiles: {
                    files: [
                      {
                        name: 'verify.bin',
                        pathPrefix: ['bazel-out', 'native', 'bin'],
                        digest: createHash('sha256').update(output).digest('hex'),
                        length: String(output.length),
                      },
                    ],
                  },
                },
                {
                  id: {
                    targetCompleted: {
                      label: artifactProducer.label,
                      configuration: { id: 'config' },
                    },
                  },
                  completed: {
                    success: true,
                    outputGroup: [{ name: 'default', fileSets: [{ id: 'outputs' }] }],
                  },
                },
              );
              return {
                events: original.map((event) => JSON.stringify(event)).join('\n'),
                exitCode: 0,
              };
            },
          }),
        );
        preparations.push(prepared);
        inventories.push({
          invocation: prepared.expectation.invocation,
          materializedRoot,
          producers: [artifactProducer],
        });
      }
      const confirmed = await confirm(preparations, a);
      const reports = await Promise.all(preparations.map(executePreparedVerification));
      await run(confirmed, reports, inventories);
    }),
  );
}

test('unsigned artifacts use the same owned complete controller batch without another context', async () => {
  await artifactFixture(async (confirmed, reports, inventories) => {
    const bound = await bindPreparedCiArtifacts(
      confirmed,
      [...reports].reverse(),
      [...inventories].reverse(),
    );
    expect(bound.map((item) => item.invocation)).toEqual(
      confirmed.expectations.map((item) => item.invocation),
    );
    expect(bound.map((item) => item.platform)).toEqual(['macos_arm64', 'linux_arm64']);
    expect(bound.map((item) => item.artifacts[0]?.destination)).toEqual(['verify', 'verify']);
    expect(Object.isFrozen(bound)).toBe(true);
    expect(Object.isFrozen(bound[0]?.artifacts[0]?.artifact)).toBe(true);
    expect(bound[0]?.artifacts[0]?.artifact.digest).not.toBe(
      bound[1]?.artifacts[0]?.artifact.digest,
    );
  });
});

test('unsigned binding refuses missing, duplicate, foreign or independently changed batches', async () => {
  await artifactFixture(async (confirmed, reports, inventories) => {
    const one = reports[0];
    const first = inventories[0];
    const second = inventories[1];
    if (one === undefined || first === undefined || second === undefined)
      throw new Error('Fixture batch absent');
    for (const submitted of [[], [one], [one, one], [...reports, one]])
      await expect(bindPreparedCiArtifacts(confirmed, submitted, inventories)).rejects.toThrow();
    for (const supplied of [
      [],
      [first],
      [first, first],
      [...inventories, first],
      [first, { ...second, invocation: '22222222-2222-4222-8222-222222222222' }],
      [first, { ...second, materializedRoot: 'relative-engine' }],
      [first, { ...second, producers: [{ ...artifactProducer, configuration: 'foreign' }] }],
      [first, { ...second, producers: [{ ...artifactProducer, group: 'foreign' }] }],
      [first, { ...second, context: confirmed.expectations[1] }],
    ])
      await expect(bindPreparedCiArtifacts(confirmed, reports, supplied)).rejects.toThrow();
    await expect(
      bindPreparedCiArtifacts({ expectations: confirmed.expectations }, reports, inventories),
    ).rejects.toThrow('owned confirmation');
    await expect(
      bindPreparedCiArtifacts(
        confirmed,
        [{ ...one, evidence: { ...one.evidence, required: [], buildEvents: '' } }, reports[1]],
        inventories,
      ),
    ).rejects.toThrow();
    await expect(
      bindPreparedCiArtifacts(
        confirmed,
        [
          {
            ...one,
            evidence: {
              ...one.evidence,
              context: { ...one.evidence.context, configuredDigest: 'e'.repeat(64) },
            },
          },
          reports[1],
        ],
        inventories,
      ),
    ).rejects.toThrow();
    await expect(
      bindPreparedCiArtifacts(
        confirmed,
        [{ ...one, evidence: { ...one.evidence, processExitCode: 37 } }, reports[1]],
        inventories,
      ),
    ).rejects.toThrow();
    writeFileSync(
      path.join(first.materializedRoot, artifactProducer.outputs[0]?.path ?? ''),
      'corrupt unsigned output',
    );
    await expect(bindPreparedCiArtifacts(confirmed, reports, inventories)).rejects.toThrow();
  });
});

test('unsigned binding detaches submitted reports and configured contracts before yielding', async () => {
  await artifactFixture(async (confirmed, reports, inventories) => {
    const submitted = structuredClone(reports);
    const supplied = structuredClone(inventories);
    const pending = bindPreparedCiArtifacts(confirmed, submitted, supplied);
    const firstReport = submitted[0];
    const firstInventory = supplied[0];
    if (firstReport === undefined || firstInventory === undefined)
      throw new Error('Fixture absent');
    Object.assign(firstReport.evidence, { required: [], context: {} });
    Object.assign(firstInventory, { producers: [], materializedRoot: '/foreign' });
    const bound = await pending;
    expect(bound).toHaveLength(2);
    expect(bound[0]?.artifacts).toHaveLength(1);
    expect(bound[1]?.artifacts).toHaveLength(1);
    expect(Object.isFrozen(bound[0]?.artifacts)).toBe(true);
  });
});

function localStore(): RevocationStore {
  let current: LedgerSnapshot = { revision: '0', ledger: {} };
  return {
    read: () => current,
    compareExchange: (previous, ledger) => {
      if (previous.revision !== current.revision) return null;
      current = { revision: String(Number(current.revision) + 1), ledger };
      return current;
    },
  };
}

test('cached controller CI handles reread selected epochs before and after artifact binding', async () => {
  for (const timing of [
    'before-use',
    'during-binding',
    'during-report',
    'unrelated',
    'publication-output-changed',
  ])
    await fixture(async (_root, options) => {
      const bytes = Buffer.from('ordinary unsigned controller fixture');
      const materializedRoot = path.join(path.dirname(options.destination), 'engine');
      mkdirSync(path.join(materializedRoot, 'bazel-out/native/bin'), { recursive: true });
      writeFileSync(path.join(materializedRoot, 'bazel-out/native/bin/verify.bin'), bytes);
      const checks = [
        ...required,
        { label: artifactProducer.label, kind: 'build', fresh: false } as const,
      ];
      const controlled: ControllerEngine = {
        ...engine({
          platform: 'darwin-arm64',
          plan: async () => ({ ...plan, coverage: { ...plan.coverage, required: checks } }),
          execute: async (request) => {
            const original = events(request.invocation)
              .split('\n')
              .map((line) => JSON.parse(line));
            original.splice(
              original.length - 1,
              0,
              {
                id: { namedSet: { id: 'outputs' } },
                namedSetOfFiles: {
                  files: [
                    {
                      name: 'verify.bin',
                      pathPrefix: ['bazel-out', 'native', 'bin'],
                      digest: createHash('sha256').update(bytes).digest('hex'),
                      length: String(bytes.length),
                    },
                  ],
                },
              },
              {
                id: {
                  targetCompleted: {
                    label: artifactProducer.label,
                    configuration: { id: 'config' },
                  },
                },
                completed: {
                  success: true,
                  outputGroup: [{ name: 'default', fileSets: [{ id: 'outputs' }] }],
                },
              },
            );
            return {
              events: original.map((event) => JSON.stringify(event)).join('\n'),
              exitCode: 0,
            };
          },
        }),
        completeTestInventory: async () => [
          ...required.map((check) => check.label),
          '//test:other',
        ],
        bindTestReservation: () => {},
        selectedChecks: async () => checks,
        testConfigurations: () => new Map(checks.map((check) => [check.label, 'config'])),
      };
      const store = localStore();
      const output = openReportOutput(
        path.join(path.dirname(options.destination), 'controller.json'),
        options.root,
      );
      try {
        if (timing === 'publication-output-changed') {
          await expect(
            verifyReservedBatch({
              signal: new AbortController().signal,
              attempts: [{ options, engine: controlled }],
              store,
              force: true,
              expectationOutputs: [output],
              retainReports: () => {},
              async publishAdmission(result) {
                const context = controllerExpectations(result)[0];
                if (context === undefined) throw new Error('Captured producer context is absent');
                writeFileSync(
                  path.join(materializedRoot, 'bazel-out/native/bin/verify.bin'),
                  'changed unsigned output',
                );
                await bindControllerCiArtifacts(result, [
                  {
                    invocation: context.invocation,
                    materializedRoot,
                    producers: [artifactProducer],
                  },
                ]);
              },
            }),
          ).rejects.toThrow('Materialized engine artifact has the wrong type or size');
          expect(store.read().ledger['//test:unit']?.state).toBe('pending');
          return;
        }
        const result = await verifyReservedBatch({
          signal: new AbortController().signal,
          attempts: [{ options, engine: controlled }],
          store,
          force: true,
          expectationOutputs: [output],
          retainReports: () => {},
        });
        expect(result.admitted).toBe(true);
        const ciReport = reconstructControllerCiReport(result);
        expect(ciReport.admitted).toBe(true);
        const confirmed = captureControllerCiExpectations(result);
        const context = confirmed.expectations[0];
        const report = result.results[0];
        if (context === undefined || report === undefined)
          throw new Error('Controller fixture absent');
        const inventories = [
          { invocation: context.invocation, materializedRoot, producers: [artifactProducer] },
        ];
        expect(
          (await bindPreparedCiArtifacts(confirmed, result.results, inventories))[0]?.artifacts,
        ).toHaveLength(1);
        const controlledArtifacts = await bindControllerCiArtifacts(result, inventories);
        expect(controlledArtifacts[0]?.artifacts).toHaveLength(1);
        expect(Object.isFrozen(controlledArtifacts)).toBe(true);
        expect(Object.isFrozen(controlledArtifacts[0]?.artifacts)).toBe(true);
        await expect(bindControllerCiArtifacts(result, [])).rejects.toThrow(
          'complete confirmed platform batch',
        );
        for (const copy of [
          { ...result },
          JSON.parse(JSON.stringify(result)),
          Object.create(result),
        ])
          await expect(bindControllerCiArtifacts(copy, inventories)).rejects.toThrow(
            'owned published controller result',
          );
        const rotate = () => reserveTests(store, ['//test:unit'], true);
        const guard = 'A newer revocation superseded this controller admission';
        if (timing === 'during-binding') {
          const pending = bindControllerCiArtifacts(result, inventories);
          rotate();
          await expect(pending).rejects.toThrow(guard);
        } else if (timing === 'during-report') {
          let rotated = false;
          const submitted = {
            get evidence() {
              if (!rotated) {
                rotate();
                rotated = true;
              }
              return report.evidence;
            },
          };
          expect(() => reconstructPreparedCiEvidence(confirmed, submitted)).toThrow(guard);
          expect(rotated).toBe(true);
        } else if (timing === 'unrelated') {
          reserveTests(store, ['//test:other'], true);
          expect(reconstructPreparedCiBatch(confirmed, result.results)[0]?.currentAccepted).toBe(
            true,
          );
          expect(
            (await bindPreparedCiArtifacts(confirmed, result.results, inventories))[0]?.artifacts,
          ).toHaveLength(1);
        } else {
          rotate();
          expect(() => captureControllerCiExpectations(result)).toThrow(guard);
          expect(() => reconstructControllerCiReport(result)).toThrow(guard);
          expect(() => reconstructPreparedCiEvidence(confirmed, report)).toThrow(guard);
          expect(() => reconstructPreparedCiBatch(confirmed, result.results)).toThrow(guard);
          await expect(
            bindPreparedCiArtifacts(confirmed, result.results, inventories),
          ).rejects.toThrow(guard);
          await expect(bindControllerCiArtifacts(result, inventories)).rejects.toThrow(guard);
        }
      } finally {
        output.close();
      }
    });
});

test('CI consumes the actual controller publication and nested reports without republishing', async () => {
  await fixture(async (_root, options) => {
    const output = openReportOutput(
      path.join(path.dirname(options.destination), 'controller.json'),
      options.root,
    );
    const controlled: ControllerEngine = {
      ...engine({ platform: 'darwin-arm64' }),
      completeTestInventory: async () => required.map((check) => check.label),
      bindTestReservation: () => {},
      selectedChecks: async () => required,
      testConfigurations: () => new Map(required.map((check) => [check.label, 'config'])),
    };
    let retained = 0;
    try {
      const result = await verifyReservedBatch({
        signal: new AbortController().signal,
        attempts: [{ options, engine: controlled }],
        store: localStore(),
        force: true,
        expectationOutputs: [output],
        retainReports: (reports) => {
          retained = reports.length;
        },
      });
      // This passing synthetic policy fixture proves API custody only, not a real native pool.
      expect(result.admitted).toBe(true);
      expect(retained).toBe(1);
      const ciReport = reconstructControllerCiReport(result);
      expect(ciReport.admitted).toBe(true);
      expect(ciReport.reports).toHaveLength(1);
      expect(ciReport.reports[0]?.currentAccepted).toBe(true);
      expect(Object.isFrozen(ciReport)).toBe(true);
      expect(Object.isFrozen(ciReport.reports[0]?.events.checks)).toBe(true);
      const confirmed = captureControllerCiExpectations(result);
      expect(
        JSON.parse(
          readFileSync(path.join(path.dirname(options.destination), 'controller.json'), 'utf8'),
        ),
      ).toEqual(confirmed.expectations);
      expect(reconstructPreparedCiBatch(confirmed, result.results)[0]?.currentAccepted).toBe(true);
      expect(Object.isFrozen(confirmed.expectations)).toBe(true);
      for (const copy of [
        { ...result },
        JSON.parse(JSON.stringify(result)),
        Object.create(result),
        { ...result, results: [] },
        { ...result, results: [...result.results, ...result.results] },
      ])
        expect(() => captureControllerCiExpectations(copy)).toThrow(
          'owned published controller result',
        );
      for (const copy of [{ ...result }, JSON.parse(JSON.stringify(result)), Object.create(result)])
        expect(() => reconstructControllerCiReport(copy)).toThrow(
          'owned published controller result',
        );
    } finally {
      output.close();
    }
  });
});

test('CI rejects the actual controller batch with failed process or pending qualification', async () => {
  for (const fault of ['process', 'qualification'])
    await fixture(async (_root, options) => {
      const output = openReportOutput(
        path.join(path.dirname(options.destination), 'controller.json'),
        options.root,
      );
      const controlled: ControllerEngine = {
        ...engine({
          platform: 'darwin-arm64',
          plan: async () => ({
            ...plan,
            pendingQualifications:
              fault === 'qualification' ? ['Synthetic native SDK remains unqualified'] : [],
          }),
          execute: async (request) => ({
            events: events(request.invocation),
            exitCode: fault === 'process' ? 37 : 0,
          }),
        }),
        completeTestInventory: async () => required.map((check) => check.label),
        bindTestReservation: () => {},
        selectedChecks: async () => required,
        testConfigurations: () => new Map(required.map((check) => [check.label, 'config'])),
      };
      try {
        const result = await verifyReservedBatch({
          signal: new AbortController().signal,
          attempts: [{ options, engine: controlled }],
          store: localStore(),
          force: true,
          expectationOutputs: [output],
          retainReports: () => {},
        });
        expect(result.admitted).toBe(false);
        await expect(bindControllerCiArtifacts(result, [])).rejects.toThrow(
          'failed, incomplete, stale or pending',
        );
        expect(result.results).toHaveLength(1);
        expect(() => reconstructControllerCiReport(result)).toThrow(
          'failed, incomplete, stale or pending',
        );
        expect(() => captureControllerCiExpectations(result)).toThrow(
          'failed, incomplete, stale or pending',
        );
      } finally {
        output.close();
      }
    });
});

test('controller CI report retains the exact complete captured platform batch', async () => {
  await fixture(async (_root, options) => {
    const output = openReportOutput(
      path.join(path.dirname(options.destination), 'ci-platforms.json'),
      options.root,
    );
    const controlled = (platform: string): ControllerEngine => ({
      ...engine({ platform }),
      completeTestInventory: async () => required.map((check) => check.label),
      bindTestReservation: () => {},
      selectedChecks: async () => required,
      testConfigurations: () => new Map(required.map((check) => [check.label, 'config'])),
    });
    const store = localStore();
    try {
      const result = await verifyReservedBatch({
        signal: new AbortController().signal,
        attempts: [
          { options, engine: controlled('darwin-arm64') },
          {
            options: { ...options, destination: `${options.destination}-linux` },
            engine: controlled('linux-arm64'),
          },
        ],
        store,
        force: true,
        expectationOutputs: [output],
        retainReports: () => {},
      });
      expect(result.admitted).toBe(true);
      const report = reconstructControllerCiReport(result);
      expect(report.expectations.map((item) => item.platform)).toEqual([
        'darwin-arm64',
        'linux-arm64',
      ]);
      expect(report.reports.map((item) => item.invocation)).toEqual(
        report.expectations.map((item) => item.invocation),
      );
      expect(report.reports.every((item) => item.currentAccepted)).toBe(true);
      expect(Object.isFrozen(report.expectations[0]?.required)).toBe(true);
      expect(Object.isFrozen(report.reports)).toBe(true);
      for (const foreign of [
        { ...result, results: result.results.slice(0, 1) },
        { ...result, results: [...result.results, ...result.results] },
        { ...result, admitted: false },
        { ...result, problems: ['failed'] },
        JSON.parse(JSON.stringify(result)),
      ])
        expect(() => reconstructControllerCiReport(foreign)).toThrow(
          'owned published controller result',
        );
      reserveTests(store, ['//test:unit'], true);
      expect(() => reconstructControllerCiReport(result)).toThrow(
        'A newer revocation superseded this controller admission',
      );
    } finally {
      output.close();
    }
  });
});

function workflowCommands(file: string, name: string): readonly string[] {
  const lines = readFileSync(file, 'utf8').split('\n');
  const commands: string[] = [];
  for (let index = 0; index < lines.length; index++) {
    if (lines[index] !== `      - name: ${name}`) continue;
    while (index < lines.length && lines[index] !== '        run: |') index++;
    if (lines[index] !== '        run: |') throw new Error('Expected the actual workflow command');
    const command: string[] = [];
    for (index++; index < lines.length; index++) {
      const line = lines[index];
      if (line === undefined || (!line.startsWith('          ') && line !== '')) break;
      command.push(line.slice(10));
    }
    commands.push(command.join('\n'));
  }
  if (commands.length === 0) throw new Error('The declared workflow step is absent');
  return commands;
}

function workflowFixture(exitCode: number) {
  const sdk = process.env.MERKUR_BAZEL_NATIVE_SDK_PREFIX;
  if (sdk === undefined || !path.isAbsolute(sdk))
    throw new Error('Entrypoint controls require their declared native SDK');
  const shell = path.join(sdk, 'bin', 'bash');
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'merkur-ci-entrypoint-')));
  const executable = path.join(root, 'declared-bazel');
  const log = path.join(root, 'arguments.json');
  const executorPolicy = path.join(root, 'executor-policy.json');
  const temporaryStorage = path.join(root, 'bazel-output', 'tmp');
  mkdirSync(temporaryStorage, { recursive: true });
  writeFileSync(executorPolicy, '{}\n');
  writeFileSync(
    executable,
    `#!${process.execPath}\n` +
      `const args=process.argv.slice(2);` +
      `await Bun.write(${JSON.stringify(log)}, JSON.stringify({args, ambient:process.env.GH_TOKEN, temporaryStorage:process.env.TMPDIR}));` +
      `if(${exitCode}===0){for(const flag of ['--report-file','--ci-report-file','--expected-context-file']){` +
      `const file=args[args.indexOf(flag)+1];if(!file)throw new Error('Missing controller output');` +
      `await Bun.write(file,'{}\\n');}}process.exit(${exitCode});\n`,
  );
  chmodSync(executable, 0o700);
  const environment = {
    ...process.env,
    VERIFICATION_BAZEL: executable,
    MERKUR_VERIFICATION_BAZEL: executable,
    LEDGER_CLIENT: path.join(root, 'provisioned.git'),
    MERKUR_VERIFICATION_LEDGER_CLIENT: path.join(root, 'provisioned.git'),
    CREDENTIAL_FILE: path.join(root, 'backend-source'),
    MERKUR_VERIFICATION_CREDENTIAL_FILE: path.join(root, 'backend-source'),
    MERKUR_VERIFICATION_EXECUTOR_POLICY_FILE: executorPolicy,
    BAZEL_OUTPUT_USER_ROOT: path.join(root, 'bazel-output', 'bazel'),
    TMPDIR: temporaryStorage,
    RUNNER_TEMP: root,
    GITHUB_RUN_ID: 'fixture-run',
    GITHUB_RUN_ATTEMPT: '1',
    GITHUB_JOB: 'fixture-job',
    SOURCE_CANDIDATE_SHA: head,
    EVENT_NAME: 'pull_request',
    GH_TOKEN: 'test-only-ambient-marker',
  };
  return {
    root,
    log,
    run(command: string, extra: Readonly<Record<string, string>> = {}) {
      return Bun.spawnSync([shell, '-c', command], {
        cwd: root,
        env: { ...environment, ...extra },
        stdout: 'pipe',
        stderr: 'pipe',
      });
    },
    close: () => rmSync(root, { recursive: true, force: true }),
  };
}

const workflowLaunchCases = [
  [
    '.github/workflows/bazel-ci.yml.in',
    'Verify the complete fresh native platform batch through the owned controller',
  ],
  [
    '.github/workflows/bazel-assurance.yml.in',
    'Verify the complete union through one nonce reservation and admission',
  ],
  [
    '.github/workflows/bazel-dependency-audit.yml.in',
    'Verify the complete fresh inventory through the owned controller',
  ],
  [
    '.github/workflows/bazel-extended-ci.yml.in',
    'Verify the complete fresh inventory through the owned controller',
  ],
  [
    '.github/workflows/bazel-release.yml.in',
    'Verify unsigned release inputs through the one controller lifecycle',
  ],
] as const;
const workflowLaunchCommands = new Map<string, string>();
for (const [file, name] of workflowLaunchCases) {
  for (const command of workflowCommands(file, name)) workflowLaunchCommands.set(command, file);
}
for (const [command, file] of workflowLaunchCommands) {
  for (const exitCode of [0, 17]) {
    test(`the ${file} controller launch preserves exact inputs and exit ${exitCode}`, () => {
      const setup = workflowFixture(exitCode);
      try {
        const suite = command.includes('test:natlab|test:tpm-sim|test:graphics:long')
          ? 'test:natlab'
          : 'test:e2e:transport:impaired:functional';
        const result = setup.run(command, { SUITE: suite });
        expect(result.exitCode).toBe(exitCode);
        const observed = JSON.parse(readFileSync(setup.log, 'utf8'));
        expect(observed.args.slice(0, 11)).toEqual([
          '--ignore_all_rc_files',
          '--host_jvm_args=-XX:+ExitOnOutOfMemoryError',
          `--output_user_root=${path.join(setup.root, 'bazel-output', 'bazel')}`,
          'run',
          '--incompatible_strict_action_env',
          '--guard_against_concurrent_changes',
          '--remote_verify_downloads',
          '--remote_download_outputs=all',
          '--symlink_prefix=/',
          '//tools:verify',
          '--',
        ]);
        expect(observed.args).toContain('--all');
        expect(observed.args).toContain('--force');
        if (file === '.github/workflows/bazel-assurance.yml.in')
          expect(observed.args[observed.args.indexOf('--assurance-event') + 1]).toBe(
            'pull_request',
          );
        expect(observed.args[observed.args.indexOf('--candidate') + 1]).toBe(head);
        expect(observed.args[observed.args.indexOf('--ledger-client') + 1]).toBe(
          path.join(setup.root, 'provisioned.git'),
        );
        expect(observed.args[observed.args.indexOf('--credential-file') + 1]).toBe(
          path.join(setup.root, 'backend-source'),
        );
        if (file === '.github/workflows/bazel-ci.yml.in') {
          const selected = verificationArguments(observed.args.slice(11));
          expect(selected.nativePlatforms).toBe(true);
          expect(selected.unsigned).toBeUndefined();
          expect(selected.executorPolicyFile).toBe(path.join(setup.root, 'executor-policy.json'));
        }
        if (file === '.github/workflows/bazel-release.yml.in') {
          expect(observed.args).toContain('--unsigned');
          expect(observed.args).toContain('--native-platforms');
          const selected = verificationArguments(observed.args.slice(11));
          expect(selected.nativePlatforms).toBe(true);
          expect(selected.unsigned).toBe(true);
          expect(selected.force).toBe(true);
          expect(observed.args[observed.args.indexOf('--executor-policy-file') + 1]).toBe(
            path.join(setup.root, 'executor-policy.json'),
          );
          expect(observed.args[observed.args.indexOf('--unsigned-output-directory') + 1]).toBe(
            path.join(setup.root, 'unsigned-verification-1', 'artifacts'),
          );
        }
        expect(observed.ambient).toBeUndefined();
        expect(observed.temporaryStorage).toBe(path.join(setup.root, 'bazel-output', 'tmp'));
      } finally {
        setup.close();
      }
    });
  }
}

for (const kind of ['missing', 'foreign', 'absent-directory'] as const) {
  test(`CI launch refuses ${kind} owned temporary storage before execution`, () => {
    for (const command of workflowLaunchCommands.keys()) {
      const setup = workflowFixture(0);
      try {
        const temporaryStorage = path.join(setup.root, 'bazel-output', 'tmp');
        if (kind === 'absent-directory') rmSync(temporaryStorage, { recursive: true });
        const result = setup.run(command, {
          TMPDIR: kind === 'missing' ? '' : kind === 'foreign' ? setup.root : temporaryStorage,
        });
        expect(result.exitCode).not.toBe(0);
        expect(() => readFileSync(setup.log)).toThrow();
      } finally {
        setup.close();
      }
    }
  });
}

for (const kind of ['missing', 'relative', 'empty', 'directory', 'symlink'] as const) {
  test(`the complete unsigned launch refuses ${kind} executor policy before execution`, () => {
    const command = workflowCommands(
      '.github/workflows/bazel-release.yml.in',
      'Verify unsigned release inputs through the one controller lifecycle',
    )[0];
    if (command === undefined) throw new Error('Expected release launch command');
    const setup = workflowFixture(0);
    try {
      const policy = path.join(setup.root, 'executor-policy.json');
      rmSync(policy);
      let input = policy;
      if (kind === 'relative') {
        writeFileSync(policy, '{}\n');
        input = 'executor-policy.json';
      } else if (kind === 'empty') writeFileSync(policy, '');
      else if (kind === 'directory') mkdirSync(policy);
      else if (kind === 'symlink') {
        const target = path.join(setup.root, 'original-policy.json');
        writeFileSync(target, '{}\n');
        symlinkSync(target, policy);
      }
      expect(
        setup.run(command, { MERKUR_VERIFICATION_EXECUTOR_POLICY_FILE: input }).exitCode,
      ).not.toBe(0);
      expect(() => readFileSync(setup.log)).toThrow();
    } finally {
      setup.close();
    }
  });
}

for (const result of ['success', 'failure', 'cancelled', 'skipped'] as const) {
  test(`release native and service status projections preserve controller ${result}`, () => {
    const commands = workflowCommands(
      '.github/workflows/bazel-release.yml.in',
      'Require the successful complete native unsigned controller command',
    );
    expect(commands).toHaveLength(2);
    const setup = workflowFixture(0);
    try {
      for (const command of commands) {
        const observed = setup.run(command, { CONTROLLER_RESULT: result });
        expect(observed.exitCode === 0).toBe(result === 'success');
        expect(() => readFileSync(setup.log)).toThrow();
      }
    } finally {
      setup.close();
    }
  });
}

test('the release signer selects only the complete shipping upload namespace', () => {
  const source = readFileSync('.github/workflows/bazel-release.yml.in', 'utf8');
  const shipping = source
    .split('      - name: Retain the controller-bound complete unsigned shipping directory\n')[1]
    ?.split('      - name: Retain the original auxiliary signing metadata separately\n')[0];
  const signing = source
    .split('      - name: Retain the original auxiliary signing metadata separately\n')[1]
    ?.split('  daemon:\n')[0];
  if (shipping === undefined || signing === undefined) throw new Error('Expected exact uploads');
  expect(shipping).toContain("if: success() && steps.unsigned.outcome == 'success'");
  expect(shipping).toContain('name: release-controller');
  expect(shipping).toContain('/artifacts/');
  expect(shipping).not.toContain('/artifacts.evidence/');
  expect(signing).toContain("if: success() && steps.unsigned.outcome == 'success'");
  expect(signing).toContain('name: unsigned-signing-evidence');
  expect(signing).toContain('/artifacts.evidence/');
  expect(source).toContain('pattern: release-*');
  expect(source).toContain(
    'python3 scripts/ci/release_assets.py validate-unsigned dist/ci-release',
  );
  expect(source).toContain('platform: [linux-x64, linux-arm64, darwin-arm64, darwin-x64]');
});

test('workflow retention requires every ordinary nonempty controller diagnostic File', () => {
  const cases = [
    [
      '.github/workflows/bazel-ci.yml.in',
      'Require all three retained controller diagnostic Files',
      false,
    ],
    [
      '.github/workflows/bazel-assurance.yml.in',
      'Require all three retained controller diagnostic Files',
      false,
    ],
    [
      '.github/workflows/bazel-dependency-audit.yml.in',
      'Require all three retained controller diagnostic Files',
      false,
    ],
    [
      '.github/workflows/bazel-extended-ci.yml.in',
      'Require all three retained controller diagnostic Files',
      false,
    ],
    [
      '.github/workflows/bazel-release.yml.in',
      'Require complete unsigned controller diagnostic Files',
      true,
    ],
  ] as const;
  for (const [file, name, release] of cases) {
    const command = workflowCommands(file, name)[0];
    if (command === undefined) throw new Error('Expected retention command');
    const setup = workflowFixture(0);
    try {
      const controllerDirectory =
        release ||
        file === '.github/workflows/bazel-assurance.yml.in' ||
        file === '.github/workflows/bazel-extended-ci.yml.in';
      const directory = release
        ? path.join(setup.root, 'unsigned-verification-1')
        : file === '.github/workflows/bazel-assurance.yml.in'
          ? path.join(setup.root, 'assurance-controller-1')
          : file === '.github/workflows/bazel-extended-ci.yml.in'
            ? path.join(setup.root, 'extended-controller-1')
            : setup.root;
      if (controllerDirectory) mkdirSync(directory);
      const files = controllerDirectory
        ? ['controller.json', 'ci.json', 'expected.json'].map((name) => path.join(directory, name))
        : ['.json', '.ci.json', '.expected-context.json'].map((suffix) =>
            path.join(directory, `merkur-verification-fixture-run-1-fixture-job${suffix}`),
          );
      expect(setup.run(command).exitCode).not.toBe(0);
      for (const output of files) writeFileSync(output, '{}\n');
      expect(setup.run(command).exitCode).toBe(0);
      for (const output of files) {
        writeFileSync(output, '');
        expect(setup.run(command).exitCode).not.toBe(0);
        writeFileSync(output, '{}\n');
        rmSync(output);
        expect(setup.run(command).exitCode).not.toBe(0);
        const foreign = files.find((file) => file !== output);
        if (foreign === undefined) throw new Error('Expected another diagnostic File');
        symlinkSync(foreign, output);
        expect(setup.run(command).exitCode).not.toBe(0);
        rmSync(output);
        writeFileSync(output, '{}\n');
      }
    } finally {
      setup.close();
    }
  }
});

test('the staged hook preserves the one controller path and rejects repeated diagnostic outputs', () => {
  const command = readFileSync('.githooks/pre-commit.bazel.in', 'utf8');
  for (const exitCode of [0, 17]) {
    const setup = workflowFixture(exitCode);
    try {
      const outputs = {
        MERKUR_VERIFICATION_REPORT: path.join(setup.root, 'controller.json'),
        MERKUR_VERIFICATION_CI_REPORT: path.join(setup.root, 'ci.json'),
        MERKUR_VERIFICATION_EXPECTED_CONTEXT: path.join(setup.root, 'expected.json'),
      };
      expect(setup.run(command, outputs).exitCode).toBe(exitCode);
      const { args } = JSON.parse(readFileSync(setup.log, 'utf8'));
      expect(args.slice(0, 10)).toEqual([
        '--ignore_all_rc_files',
        '--host_jvm_args=-XX:+ExitOnOutOfMemoryError',
        'run',
        '--incompatible_strict_action_env',
        '--guard_against_concurrent_changes',
        '--remote_verify_downloads',
        '--remote_download_outputs=all',
        '--symlink_prefix=/',
        '//tools:verify',
        '--',
      ]);
      expect(args[10]).toBe('--staged');
      expect(verificationArguments(args.slice(10)).staged).toBe(true);
      rmSync(setup.log);
      expect(
        setup.run(command, {
          ...outputs,
          MERKUR_VERIFICATION_CI_REPORT: outputs.MERKUR_VERIFICATION_REPORT,
        }).exitCode,
      ).not.toBe(0);
      expect(() => readFileSync(setup.log)).toThrow();
    } finally {
      setup.close();
    }
  }
});

test('every inactive editor task has an actual verification CLI contract and explicit boundaries', () => {
  const definition = JSON.parse(readFileSync('.vscode/tasks.bazel.json.in', 'utf8'));
  const inputs = new Map(
    definition.inputs.map((input: { id: string }) => [input.id, `/declared/${input.id}`]),
  );
  expect(definition.tasks.length).toBe(5);
  const verificationTasks = definition.tasks.filter(
    (task: { args: string[] }) => task.args[8] === '//tools:verify',
  );
  const formattingTasks = definition.tasks.filter(
    (task: { args: string[] }) => task.args[8] === '//tools:format',
  );
  expect(verificationTasks).toHaveLength(4);
  expect(formattingTasks).toHaveLength(1);
  for (const task of verificationTasks) {
    expect(task.type).toBe('process');
    expect(task.command).toBe(`\${env:MERKUR_VERIFICATION_BAZEL}`);
    expect(task.args.slice(0, 10)).toEqual([
      '--ignore_all_rc_files',
      '--host_jvm_args=-XX:+ExitOnOutOfMemoryError',
      'run',
      '--incompatible_strict_action_env',
      '--guard_against_concurrent_changes',
      '--remote_verify_downloads',
      '--remote_download_outputs=all',
      '--symlink_prefix=/',
      '//tools:verify',
      '--',
    ]);
    const args = task.args.slice(10).map((value: string) => {
      if (!value.startsWith('${input:')) return value;
      const replacement = inputs.get(value.slice(8, -1));
      if (typeof replacement !== 'string') throw new Error('Editor task references absent input');
      return replacement;
    });
    const parsed = verificationArguments(args);
    expect(parsed.ledgerClient).toBe('/declared/merkurVerificationLedger');
    expect(parsed.credentialFile).toBe('/declared/merkurVerificationCredential');
    expect(parsed.reportFile).toBe('/declared/merkurVerificationReport');
    expect(parsed.ciReportFile).toBe('/declared/merkurVerificationCiReport');
    expect(parsed.expectedContextFile).toBe('/declared/merkurVerificationExpectation');
  }
  const format = formattingTasks[0];
  expect(format.type).toBe('process');
  expect(format.command).toBe(`\${env:MERKUR_VERIFICATION_BAZEL}`);
  expect(format.options.cwd).toBe(`\${workspaceFolder}`);
  expect(format.args).toEqual([
    '--ignore_all_rc_files',
    '--host_jvm_args=-XX:+ExitOnOutOfMemoryError',
    'run',
    '--incompatible_strict_action_env',
    '--guard_against_concurrent_changes',
    '--remote_verify_downloads',
    '--remote_download_outputs=all',
    '--symlink_prefix=/',
    '//tools:format',
    '--',
    `\${file}`,
  ]);
  expect(format.detail).toContain('Inactive until formatter/tool qualification');
});

for (const kind of ['missing', 'relative', 'empty', 'directory', 'symlink'] as const) {
  test(`the complete native CI launch refuses ${kind} executor policy before execution`, () => {
    const command = workflowCommands(
      '.github/workflows/bazel-ci.yml.in',
      'Verify the complete fresh native platform batch through the owned controller',
    )[0];
    if (command === undefined) throw new Error('Expected native CI launch command');
    const setup = workflowFixture(0);
    try {
      const policy = path.join(setup.root, 'executor-policy.json');
      rmSync(policy);
      let input = policy;
      if (kind === 'relative') {
        writeFileSync(policy, '{}\n');
        input = 'executor-policy.json';
      } else if (kind === 'empty') writeFileSync(policy, '');
      else if (kind === 'directory') mkdirSync(policy);
      else if (kind === 'symlink') {
        const original = path.join(setup.root, 'original-policy.json');
        writeFileSync(original, '{}\n');
        symlinkSync(original, policy);
      }
      expect(
        setup.run(command, { MERKUR_VERIFICATION_EXECUTOR_POLICY_FILE: input }).exitCode,
      ).not.toBe(0);
      expect(() => readFileSync(setup.log)).toThrow();
    } finally {
      setup.close();
    }
  });
}

test('CI aggregation projects successful controller and retention jobs without uploaded admission', () => {
  const source = readFileSync('.github/workflows/bazel-ci.yml.in', 'utf8');
  const native = source.split('  native:\n')[1]?.split('  integration:\n')[0];
  const required = source.split('  required:\n')[1];
  if (native === undefined || required === undefined) throw new Error('Expected exact CI jobs');
  expect(native).toContain(`LEDGER_CLIENT: \${{ steps.engine.outputs.ledger-client }}`);
  expect(native).toContain(`CREDENTIAL_FILE: \${{ steps.engine.outputs.credential-file }}`);
  expect(native).toContain('name: Require all three retained controller diagnostic Files');
  expect(native).toContain('name: Retain the complete native controller diagnostics');
  expect(native).toContain('if-no-files-found: error');
  expect(
    workflowCommands(
      '.github/workflows/bazel-ci.yml.in',
      'Require all three retained controller diagnostic Files',
    ),
  ).toHaveLength(2);
  expect(required).toContain('needs: [plan, source, native, integration, transport]');
  expect(required).toContain('python3 -I scripts/ci/bazel_admission.py ci-results');
  expect(required).not.toContain('Missing authenticated hosted controller launch');
  expect(required).not.toContain('reconstruct-ci');
  expect(source).toContain(
    'Required: declared authenticated browser/service scenarios and receipts',
  );
  expect(source).toContain('Required: declared transport shard scenarios and receipts');
});

test('native runner frontend publishes all three diagnostics into the uploaded namespace', () => {
  const command = workflowCommands(
    '.github/workflows/bazel-native-qualification.yml.in',
    'Capture complete frontend result without clearing pending qualifications',
  )[0];
  if (command === undefined) throw new Error('Expected actual native frontend command');
  const setup = workflowFixture(0);
  try {
    const evidence = path.join(setup.root, 'merkur-native-fixture-run-1-macos_arm64');
    for (const directory of ['private', 'retained', 'home'])
      mkdirSync(path.join(evidence, directory), { recursive: true });
    expect(
      setup.run(command, {
        ENGINE: path.join(setup.root, 'declared-bazel'),
        PLATFORM: 'macos_arm64',
        CANDIDATE: head,
      }).exitCode,
    ).toBe(0);
    const observed = JSON.parse(readFileSync(setup.log, 'utf8'));
    for (const flag of ['--report-file', '--ci-report-file', '--expected-context-file']) {
      const file = observed.args[observed.args.indexOf(flag) + 1];
      expect(path.dirname(file)).toBe(path.join(evidence, 'retained'));
      expect(readFileSync(file, 'utf8')).toBe('{}\n');
    }
  } finally {
    setup.close();
  }
});

for (const kind of ['missing', 'empty', 'directory', 'symlink'] as const) {
  test(`native runner diagnostic retention rejects every ${kind} output`, () => {
    const file = '.github/workflows/bazel-native-qualification.yml.in';
    const command = workflowCommands(
      file,
      'Require all three retained native controller diagnostic Files',
    )[0];
    if (command === undefined) throw new Error('Expected actual native retention command');
    expect(readFileSync(file, 'utf8')).toContain(
      'name: Require all three retained native controller diagnostic Files\n        if: always()',
    );
    for (const name of [
      'verification.json',
      'reconstructed-verdict.json',
      'controller-expected.json',
    ]) {
      const setup = workflowFixture(0);
      try {
        const retained = path.join(
          setup.root,
          'merkur-native-fixture-run-1-macos_arm64',
          'retained',
        );
        mkdirSync(retained, { recursive: true });
        for (const output of [
          'verification.json',
          'reconstructed-verdict.json',
          'controller-expected.json',
        ])
          writeFileSync(path.join(retained, output), '{}\n');
        expect(setup.run(command, { PLATFORM: 'macos_arm64' }).exitCode).toBe(0);
        const output = path.join(retained, name);
        rmSync(output);
        if (kind === 'empty') writeFileSync(output, '');
        else if (kind === 'directory') mkdirSync(output);
        else if (kind === 'symlink') {
          const foreign = path.join(setup.root, 'foreign-diagnostic.json');
          writeFileSync(foreign, '{}\n');
          symlinkSync(foreign, output);
        }
        expect(setup.run(command, { PLATFORM: 'macos_arm64' }).exitCode).not.toBe(0);
      } finally {
        setup.close();
      }
    }
  });
}

test('native runner blocked diagnostics retain evidence while failed frontend status refuses acceptance', () => {
  const file = '.github/workflows/bazel-native-qualification.yml.in';
  const retention = workflowCommands(
    file,
    'Require all three retained native controller diagnostic Files',
  )[0];
  const acceptance = workflowCommands(
    file,
    'Require successful controls and owned frontend publication',
  )[0];
  if (retention === undefined || acceptance === undefined)
    throw new Error('Expected actual native workflow gates');
  const setup = workflowFixture(0);
  try {
    const retained = path.join(setup.root, 'merkur-native-fixture-run-1-macos_arm64', 'retained');
    mkdirSync(retained, { recursive: true });
    for (const output of [
      'verification.json',
      'reconstructed-verdict.json',
      'controller-expected.json',
    ])
      writeFileSync(path.join(retained, output), '{"phase":"blocked","expectations":[]}\n');
    const environment = {
      PLATFORM: 'macos_arm64',
      CONTROL_OUTCOME: 'success',
      RUNTIME_OUTCOME: 'success',
      SDK_OUTCOME: 'success',
    };
    expect(setup.run(retention, environment).exitCode).toBe(0);
    for (const outcome of ['failure', 'cancelled', 'skipped'])
      expect(
        setup.run(acceptance, { ...environment, FRONTEND_OUTCOME: outcome }).exitCode,
      ).not.toBe(0);
    expect(readFileSync(path.join(retained, 'controller-expected.json'), 'utf8')).toBe(
      '{"phase":"blocked","expectations":[]}\n',
    );
  } finally {
    setup.close();
  }
});

function assuranceSimulation(source: string): string {
  const simulation = source.split('  simulation:\n')[1]?.split('  kernel-tool:\n')[0];
  if (simulation === undefined) throw new Error('Expected the required simulation projection');
  return simulation;
}

for (const result of ['success', 'failure', 'cancelled', 'skipped'] as const) {
  test(`assurance simulation projects controller ${result} without a separate reservation`, () => {
    const source = readFileSync('.github/workflows/bazel-assurance.yml.in', 'utf8');
    const simulation = assuranceSimulation(source);
    const setup = workflowFixture(0);
    try {
      const command = simulation
        .split('\n')
        .find((line) => line.startsWith('        run: ') && line !== '        run: |')
        ?.slice('        run: '.length);
      if (command === undefined) throw new Error('Expected the actual simulation status command');
      expect(setup.run(command, { CONTROLLER_RESULT: result }).exitCode === 0).toBe(
        result === 'success',
      );
      expect(() => readFileSync(setup.log)).toThrow();
      expect(simulation).toContain('needs: controller');
      expect(simulation).not.toContain('if:');
      expect(simulation).not.toContain('//tools:verify');
      expect(simulation).not.toContain('bazel test');
    } finally {
      setup.close();
    }
  });
}

test('simulation retains the same three ordinary controller diagnostics on every event', () => {
  const source = readFileSync('.github/workflows/bazel-assurance.yml.in', 'utf8');
  const simulation = assuranceSimulation(source);
  expect(simulation).toContain(
    `name: assurance-controller-diagnostics-\${{ github.run_id }}-\${{ github.run_attempt }}`,
  );
  const setup = workflowFixture(0);
  try {
    const fragment = path.join(setup.root, 'simulation.yml');
    writeFileSync(fragment, simulation);
    const command = workflowCommands(fragment, 'Require complete ordinary diagnostic Files')[0];
    if (command === undefined) throw new Error('Expected the actual simulation retention command');
    const directory = path.join(setup.root, 'assurance-controller-diagnostics');
    mkdirSync(directory);
    for (const name of ['controller.json', 'ci.json', 'expected.json'])
      writeFileSync(path.join(directory, name), '{}\n');
    expect(setup.run(command).exitCode).toBe(0);
    for (const name of ['controller.json', 'ci.json', 'expected.json']) {
      const file = path.join(directory, name);
      rmSync(file);
      expect(setup.run(command).exitCode).not.toBe(0);
      writeFileSync(file, '{}\n');
    }
    expect(() => readFileSync(setup.log)).toThrow();
  } finally {
    setup.close();
  }
});

for (const event of ['pull_request', 'push', 'schedule', 'workflow_dispatch']) {
  test(`assurance ${event} executes the complete union through one forced controller`, () => {
    const file = '.github/workflows/bazel-assurance.yml.in';
    const commands = workflowCommands(
      file,
      'Verify the complete union through one nonce reservation and admission',
    );
    expect(commands).toHaveLength(1);
    const command = commands[0];
    if (command === undefined) throw new Error('Expected the one actual assurance controller');
    const setup = workflowFixture(0);
    try {
      expect(setup.run(command, { EVENT_NAME: event }).exitCode).toBe(0);
      const observed = JSON.parse(readFileSync(setup.log, 'utf8'));
      const parsed = verificationArguments(observed.args.slice(11));
      expect(parsed.assuranceEvent).toBe(event);
      expect(parsed.all).toBe(true);
      expect(parsed.force).toBe(true);
    } finally {
      setup.close();
    }
  });
}

test('required assurance includes simulation and keeps the parser campaign event distinction', () => {
  const source = readFileSync('.github/workflows/bazel-assurance.yml.in', 'utf8');
  const required = source.split('  required:\n')[1];
  const campaign = source.split('  fuzz-campaign:\n')[1]?.split('  required:\n')[0];
  if (required === undefined || campaign === undefined)
    throw new Error('Expected the exact required assurance and parser campaign jobs');
  expect(required).toContain(
    'needs: [controller, parser-smoke, ownership, bounded-proofs, simulation, kernel-tool, fuzz-campaign]',
  );
  expect(required).toContain(`SIMULATION_RESULT: \${{ needs.simulation.result }}`);
  expect(required).toContain('scripts/ci/bazel_admission.py assurance-results');
  expect(campaign).toContain(
    "if: github.event_name == 'schedule' || github.event_name == 'workflow_dispatch'",
  );
  expect(source).toContain('Schedule/manual additionally sweeps 200 random simulation seeds');
});

test('extended CI runs all five suites and Static8 through exactly one forced controller', () => {
  const file = '.github/workflows/bazel-extended-ci.yml.in';
  const source = readFileSync(file, 'utf8');
  const commands = workflowCommands(
    file,
    'Verify the complete fresh inventory through the owned controller',
  );
  expect(commands).toHaveLength(1);
  expect(source.match(/\/\/tools:verify --/g)).toHaveLength(1);
  const command = commands[0];
  if (command === undefined) throw new Error('Expected the one complete extended controller');
  const setup = workflowFixture(0);
  try {
    expect(setup.run(command).exitCode).toBe(0);
    const observed = JSON.parse(readFileSync(setup.log, 'utf8'));
    const selected = verificationArguments(observed.args.slice(11));
    expect(selected.extendedSuites).toBe(true);
    expect(selected.extendedSuite).toBeUndefined();
    expect(selected.all).toBe(true);
    expect(selected.force).toBe(true);
    expect(selected.ciReportFile).toBe(path.join(setup.root, 'extended-controller-1', 'ci.json'));
    expect(source).not.toContain('--extended-suite "$SUITE"');
    expect(source).toContain('suite: [test:natlab, test:tpm-sim, test:graphics:long]');
    expect(source).toContain(
      'suite: [test:e2e:transport:impaired:functional, test:e2e:edge-topology]',
    );
  } finally {
    setup.close();
  }
});

function extendedProjection(job: 'native' | 'browser'): string {
  const source = readFileSync('.github/workflows/bazel-extended-ci.yml.in', 'utf8');
  const projection = source.split(`  ${job}:\n`)[1]?.split('\n  browser:')[0];
  if (projection === undefined) throw new Error('Expected the original extended matrix projection');
  return projection;
}

for (const job of ['native', 'browser'] as const) {
  for (const result of ['success', 'failure', 'cancelled', 'skipped'] as const) {
    test(`extended ${job} projects ${result} without rotating any nonce`, () => {
      const projection = extendedProjection(job);
      const command = projection
        .split('\n')
        .find((line) => line.startsWith('        run: ') && line !== '        run: |')
        ?.slice('        run: '.length);
      if (command === undefined)
        throw new Error('Expected the actual controller status projection');
      const setup = workflowFixture(0);
      try {
        expect(setup.run(command, { CONTROLLER_RESULT: result }).exitCode === 0).toBe(
          result === 'success',
        );
        expect(() => readFileSync(setup.log)).toThrow();
        expect(projection).toContain('needs: controller');
        expect(projection).not.toContain('setup-bazel');
        expect(projection).not.toContain('//tools:verify');
        expect(projection).not.toContain('if:');
      } finally {
        setup.close();
      }
    });
  }
  test(`extended ${job} preserves the same complete diagnostic inventory without admission from JSON`, () => {
    const projection = extendedProjection(job);
    expect(projection).toContain(
      `name: extended-controller-diagnostics-\${{ github.run_id }}-\${{ github.run_attempt }}`,
    );
    const setup = workflowFixture(0);
    try {
      const fragment = path.join(setup.root, 'projection.yml');
      writeFileSync(fragment, projection);
      const command = workflowCommands(
        fragment,
        'Require complete ordinary extended diagnostic Files',
      )[0];
      if (command === undefined)
        throw new Error('Expected the exact original File retention command');
      const directory = path.join(setup.root, 'extended-controller-diagnostics');
      mkdirSync(directory);
      for (const name of ['controller.json', 'ci.json', 'expected.json'])
        writeFileSync(path.join(directory, name), '{"phase":"blocked"}\n');
      expect(setup.run(command).exitCode).toBe(0);
      for (const name of ['controller.json', 'ci.json', 'expected.json']) {
        const file = path.join(directory, name);
        rmSync(file);
        expect(setup.run(command).exitCode).not.toBe(0);
        writeFileSync(file, '{"phase":"blocked"}\n');
      }
      expect(() => readFileSync(setup.log)).toThrow();
    } finally {
      setup.close();
    }
  });
}

test('release forced controllers cannot overlap the same ledger test epochs', () => {
  const jobs = workflowJobs('.github/workflows/bazel-release.yml.in');
  const ancestors = (name: string) => workflowAncestors(jobs, name);
  expect(jobs.get('checks')).toContain('uses: ./.github/workflows/bazel-ci.yml');
  expect(jobs.get('extended')).toContain('uses: ./.github/workflows/bazel-extended-ci.yml');
  expect(jobs.get('unsigned-verification')).toContain(
    '--all --force --unsigned --native-platforms',
  );
  expect(ancestors('extended').has('checks')).toBe(true);
  expect(ancestors('unsigned-verification').has('checks')).toBe(true);
  expect(ancestors('unsigned-verification').has('extended')).toBe(true);
});

function workflowJobs(file: string): ReadonlyMap<string, string> {
  const jobs = new Map<string, string>();
  for (const match of readFileSync(file, 'utf8').matchAll(
    /^ {2}([a-z][a-z-]*):\n([\s\S]*?)(?=^ {2}[a-z][a-z-]*:\n|$(?![\s\S]))/gm,
  )) {
    if (match[1] === undefined || match[2] === undefined) throw new Error('Malformed workflow job');
    jobs.set(match[1], match[2]);
  }
  return jobs;
}

function workflowAncestors(
  jobs: ReadonlyMap<string, string>,
  name: string,
  seen = new Set<string>(),
): Set<string> {
  const job = jobs.get(name);
  if (job === undefined || seen.has(name)) throw new Error('Unknown or cyclic workflow job');
  const binding = /^ {4}needs: (.+)$/m.exec(job)?.[1];
  const needs = binding === undefined ? [] : binding.replaceAll(/[[\] ]/g, '').split(',');
  const previous = new Set([...seen, name]);
  return new Set(
    needs.flatMap((dependency) => [dependency, ...workflowAncestors(jobs, dependency, previous)]),
  );
}

test('CI native force waits for source completion and failure blocks its reservation', () => {
  const jobs = workflowJobs('.github/workflows/bazel-ci.yml.in');
  expect(workflowAncestors(jobs, 'native').has('source')).toBe(true);
  expect(workflowAncestors(jobs, 'native').has('plan')).toBe(true);
  const native = jobs.get('native');
  if (native === undefined) throw new Error('Expected the original native controller');
  expect(native).toContain("if: needs.plan.outputs.native == 'true'");
  expect(native).not.toMatch(/^ {4}if:.*(?:always\(\)|failure\(\)|cancelled\(\))/m);
  expect(native).toContain('--all --force');
  expect(native).toContain('--native-platforms --executor-policy-file');
  expect(jobs.get('required')).toContain('needs: [plan, source, native, integration, transport]');
});

for (const file of [
  '.github/actions/setup-bazel/action.yml',
  '.github/workflows/bazel-ci.yml.in',
  '.github/workflows/bazel-assurance.yml.in',
  '.github/workflows/bazel-dependency-audit.yml.in',
  '.github/workflows/bazel-extended-ci.yml.in',
  '.github/workflows/bazel-native-qualification.yml.in',
  '.github/workflows/bazel-release.yml.in',
  '.githooks/pre-commit.bazel.in',
]) {
  test(`${file} outer commands use matching startup OOM exit before every command`, () => {
    const lines = readFileSync(file, 'utf8').split('\n');
    let commands = 0;
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index];
      if (line === undefined || !line.includes('--ignore_all_rc_files')) continue;
      const command = `${line}\n${lines[index + 1] ?? ''}`;
      expect(command).toMatch(
        /--ignore_all_rc_files --host_jvm_args=-XX:\+ExitOnOutOfMemoryError(?: --output_user_root="\$BAZEL_OUTPUT_USER_ROOT")? (?:\\\n\s*)?(?:run|test|info|shutdown)\b/,
      );
      if (/\bshutdown\b/.test(line)) expect(line).not.toContain('--noexecution_log_sort');
      commands++;
    }
    expect(commands).toBeGreaterThan(0);
  });
}

test('signed release smoke uses every original native host and fails before unverified execution', () => {
  const file = '.github/workflows/bazel-release.yml.in';
  const job = workflowJobs(file).get('package-smoke');
  if (job === undefined) throw new Error('Expected the original post-signing package smoke job');
  expect(job).toContain('needs: [validate, sign]');
  expect(job).toContain(`runs-on: \${{ matrix.os }}`);
  expect(job).not.toContain('exit 1');
  const command = workflowCommands(file, 'Exercise the actual installer against signed bytes')[0];
  if (command === undefined) throw new Error('Expected the original signed installer consumer');
  for (const [platform, os] of [
    ['linux-x64', 'ubuntu-24.04'],
    ['linux-arm64', 'ubuntu-24.04-arm'],
    ['darwin-arm64', 'macos-15'],
    ['darwin-x64', 'macos-15-intel'],
  ] as const) {
    expect(job).toContain(`- os: ${os}\n            platform: ${platform}`);
    for (const failure of ['none', 'restore', 'extract']) {
      const setup = workflowFixture(0);
      try {
        mkdirSync(path.join(setup.root, 'dist'));
        const log = path.join(setup.root, 'smoke-arguments');
        const result = setup.run(
          `python3() { printf '%s\\t' python3 "$@" >> "$SMOKE_LOG"; printf '\\n' >> "$SMOKE_LOG"; ` +
            `if [[ "$1" == scripts/ci/release_assets.py ]]; then return "$RESTORE_EXIT"; fi; };\n` +
            `tar() { printf '%s\\t' tar "$@" >> "$SMOKE_LOG"; printf '\\n' >> "$SMOKE_LOG"; return "$EXTRACT_EXIT"; };\n` +
            command,
          {
            PLATFORM: platform,
            VERSION: 'v1.2.3',
            SEQUENCE: '7',
            SMOKE_LOG: log,
            RESTORE_EXIT: failure === 'restore' ? '19' : '0',
            EXTRACT_EXIT: failure === 'extract' ? '23' : '0',
          },
        );
        expect(result.exitCode).toBe(failure === 'restore' ? 19 : failure === 'extract' ? 23 : 0);
        const rows = readFileSync(log, 'utf8')
          .trimEnd()
          .split('\n')
          .map((line) => line.split('\t').filter((value) => value !== ''));
        const expected = [
          ['python3', 'scripts/ci/release_assets.py', 'restore', 'dist/ci-release'],
          ['tar', '-xzf', `dist/ci-release/merkur-daemon-${platform}.tar.gz`, '-C', 'dist/smoke'],
          [
            'python3',
            'scripts/ci/release_smoke.py',
            'dist/smoke',
            'v1.2.3',
            '7',
            'dist/ci-release',
            platform,
          ],
        ];
        expect(rows).toEqual(
          expected.slice(0, failure === 'restore' ? 1 : failure === 'extract' ? 2 : 3),
        );
        expect(() => readFileSync(setup.log)).toThrow();
      } finally {
        setup.close();
      }
    }
  }
});
