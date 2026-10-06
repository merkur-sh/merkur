import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  type ControllerEngine,
  controllerExpectations,
  type PassRecords,
  type RecordedPass,
  verifyReservedBatch,
} from './controller';
import {
  type EnginePlan,
  executePreparedVerification,
  type FrontEndEngine,
  type PreparedVerification,
  prepareVerification,
  publishVerificationExpectations,
  rejectPreparedVerification,
  type VerificationExpectation,
  verifySnapshot,
  writeVerificationExpectations,
} from './front-end';
import { captureGitContext } from './git-context';
import { verificationReport } from './report';
import { openReportOutput, type ReportOutput } from './report-output';
import {
  type LedgerSnapshot,
  parseLedger,
  type RevocationStore,
  reserveTests,
  type TestReservation,
} from './revocation';
import { BAZEL_STATIC_GATES as STATIC_GATES } from './static-gates';

const retainedOutputs = new Map<string, ReportOutput[]>();

function publishBatch(prepared: readonly PreparedVerification[], root: string) {
  const outputs = retainedOutputs.get(root);
  if (outputs === undefined) throw new Error('Publication fixture is not open');
  const output = openReportOutput(path.join(path.dirname(root), `${randomUUID()}.json`), root);
  outputs.push(output);
  return writeVerificationExpectations(prepared, [output]);
}

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
  retainedOutputs.set(root, []);
  try {
    await run(root, {
      root,
      destination: path.join(parent, 'frozen'),
      admittedUntracked: [],
      publishExpectation: (_context, prepared) => publishBatch([prepared], root),
    });
  } finally {
    for (const output of retainedOutputs.get(root) ?? []) output.close();
    retainedOutputs.delete(root);
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

test('one merged execution reads physically frozen bytes and reconciles the live tree', async () => {
  await fixture(async (root, options) => {
    let executions = 0;
    const report = await verifySnapshot(
      options,
      engine({
        execute: async (request) => {
          executions += 1;
          expect(request.root).not.toBe(root);
          expect(request.required).toEqual(required);
          writeFileSync(path.join(root, 'input.ts'), 'edited during execution');
          expect(readFileSync(path.join(request.root, 'input.ts'), 'utf8')).toBe('captured bytes');
          return { events: events(request.invocation), exitCode: 0 };
        },
      }),
    );
    expect(executions).toBe(1);
    expect(report.snapshotAccepted).toBe(true);
    expect(report.currentAccepted).toBe(false);
    expect(report.changedInputs).toEqual(['input.ts']);
  });
});

test('unchanged admitted input with complete engine evidence is accepted', async () => {
  await fixture(async (_root, options) => {
    const report = await verifySnapshot(options, engine());
    expect(report.snapshotAccepted).toBe(true);
    expect(report.currentAccepted).toBe(true);
    const { evidence, ...summary } = report;
    expect(verificationReport(JSON.parse(JSON.stringify(evidence)))).toEqual(summary);
  });
});

test('copied byte corruption during planning or execution cannot produce acceptance', async () => {
  for (const phase of ['planning', 'execution']) {
    await fixture(async (root, options) => {
      let executions = 0;
      await expect(
        verifySnapshot(
          options,
          engine({
            plan: async (directory) => {
              if (phase === 'planning' && directory !== root)
                writeFileSync(path.join(directory, 'input.ts'), 'different compiler source');
              return plan;
            },
            execute: async (request) => {
              executions += 1;
              writeFileSync(path.join(request.root, 'input.ts'), 'different compiler source');
              return { events: events(request.invocation), exitCode: 0 };
            },
          }),
        ),
      ).rejects.toThrow(`Copied source changed ${phase === 'planning' ? 'before' : 'during'}`);
      expect(executions).toBe(phase === 'planning' ? 0 : 1);
    });
  }
});

test('already-dirty source changed in final Git capture is recaptured and remains pending', async () => {
  await fixture(async (root, options) => {
    let reads = 0;
    const report = await verifySnapshot(
      options,
      engine({
        readGit: async () => {
          reads += 1;
          if (reads === 6)
            writeFileSync(path.join(root, 'input.ts'), 'changed during final Git capture');
          return git(inputs, ['input.ts']);
        },
      }),
    );
    expect(report.snapshotAccepted).toBe(true);
    expect(report.currentAccepted).toBe(false);
    expect(report.changedInputs).toEqual(['input.ts']);
    expect(report.pendingLiveChecks).toContain('Source changed during final Git capture');
  });
});

test('unadmitted source and a changed copied plan prevent execution', async () => {
  await fixture(async (root, options) => {
    let executions = 0;
    const execute: FrontEndEngine['execute'] = async (request) => {
      executions += 1;
      return { events: events(request.invocation), exitCode: 0 };
    };
    await expect(
      verifySnapshot(options, engine({ readGit: async () => git(inputs.slice(0, 3)), execute })),
    ).rejects.toThrow('input.ts');
    await expect(
      verifySnapshot(
        options,
        engine({
          plan: async (directory) =>
            directory === root ? plan : { ...plan, contextDigest: 'c'.repeat(64) },
          execute,
        }),
      ),
    ).rejects.toThrow('Copied source');
    expect(executions).toBe(0);
  });
});

test('fresh Git changes before execution reject; changes during execution remain pending', async () => {
  await fixture(async (_root, options) => {
    let reads = 0;
    let executions = 0;
    await expect(
      verifySnapshot(
        options,
        engine({
          readGit: async () => git(inputs, reads++ === 0 ? [] : ['input.ts']),
          execute: async (request) => {
            executions += 1;
            return { events: events(request.invocation), exitCode: 0 };
          },
        }),
      ),
    ).rejects.toThrow('Git context changed before');
    expect(executions).toBe(0);
  });
  await fixture(async (_root, options) => {
    let reads = 0;
    const report = await verifySnapshot(
      options,
      engine({ readGit: async () => git(inputs, reads++ < 3 ? [] : ['input.ts']) }),
    );
    expect(report.snapshotAccepted).toBe(true);
    expect(report.currentAccepted).toBe(false);
    expect(report.pendingLiveChecks).toContain('Git context changed during execution');
  });
});

test('coverage additions, unresolved qualification and omitted results cannot pass current acceptance', async () => {
  await fixture(async (root, options) => {
    let plans = 0;
    const report = await verifySnapshot(
      options,
      engine({
        plan: async () => {
          plans += 1;
          if (plans <= 2) return plan;
          writeFileSync(path.join(root, 'new.ts'), 'newly configured source');
          return { ...plan, actionSources: [...plan.actionSources, 'new.ts'] };
        },
      }),
    );
    expect(report.snapshotAccepted).toBe(true);
    expect(report.currentAccepted).toBe(false);
    expect(report.changedInputs).toContain('new.ts');
    expect(report.pendingLiveChecks).toContain(
      'Configured graph or required coverage changed during execution',
    );
  });
  await fixture(async (_root, options) => {
    const report = await verifySnapshot(
      options,
      engine({
        plan: async () => ({ ...plan, pendingQualifications: ['SDK runtime unqualified'] }),
      }),
    );
    expect(report.snapshotAccepted).toBe(true);
    expect(report.currentAccepted).toBe(false);
    expect(report.pendingLiveChecks).toContain('SDK runtime unqualified');
  });
  await fixture(async (_root, options) => {
    const report = await verifySnapshot(
      options,
      engine({
        execute: async (request) => ({ events: events(request.invocation, true), exitCode: 0 }),
      }),
    );
    expect(report.snapshotAccepted).toBe(false);
    expect(report.currentAccepted).toBe(false);
  });
});

test('omitted, empty, aliased or unrequired static controls reject before execution', async () => {
  const first = staticOperations[0];
  const last = staticOperations[staticOperations.length - 1];
  if (first === undefined || last === undefined) throw new Error('Static fixture is empty');
  const variants = [
    { ...plan.coverage, staticOperations: staticOperations.slice(1) },
    {
      ...plan.coverage,
      staticOperations: staticOperations.map((operation) =>
        operation === first ? { ...operation, checks: [] } : operation,
      ),
    },
    {
      ...plan.coverage,
      staticOperations: staticOperations.map((operation) =>
        operation === first ? { ...operation, checks: last.checks } : operation,
      ),
    },
    { ...plan.coverage, required: required.filter((check) => check !== first.checks[0]) },
  ];
  for (const coverage of variants) {
    await fixture(async (_root, options) => {
      let executed = false;
      await expect(
        verifySnapshot(
          options,
          engine({
            plan: async () => ({ ...plan, coverage }),
            execute: async (request) => {
              executed = true;
              return { events: events(request.invocation), exitCode: 0 };
            },
          }),
        ),
      ).rejects.toThrow('static policy');
      expect(executed).toBe(false);
    });
  }
});

test('trusted expectation is immutable, confirmed before execution and binds the independent plan', async () => {
  await fixture(async (_root, options) => {
    let expected: VerificationExpectation | undefined;
    const result = await verifySnapshot(
      {
        ...options,
        publishExpectation: async (context, prepared) => {
          expected = context;
          await Promise.resolve();
          return options.publishExpectation(context, prepared);
        },
      },
      engine({
        execute: async (request) => {
          expect(expected?.invocation).toBe(request.invocation);
          expect(expected?.sourceDigest).toBe(request.source.digest);
          expect(expected?.gitDigest).toBe(request.git.digest);
          expect(expected?.configuredDigest).toBe(plan.contextDigest);
          expect(expected?.required).toEqual(required);
          expect(Object.isFrozen(expected)).toBe(true);
          expect(Object.isFrozen(expected?.required)).toBe(true);
          expect(expected?.required.every(Object.isFrozen)).toBe(true);
          return { events: events(request.invocation), exitCode: 0 };
        },
      }),
    );
    expect(expected?.invocation).toBe(result.invocation);
    expect(expected?.sourceDigest).toBe(result.source.digest);
    expect(expected?.base).toBe(head);
    expect(expected?.candidate).toBe(head);
    expect(expected?.head).toBe(head);
    expect(result.currentAccepted).toBe(true);
  });
});

test('failed expected-context publication prevents every engine execution', async () => {
  await fixture(async (_root, options) => {
    let executed = false;
    await expect(
      verifySnapshot(
        {
          ...options,
          publishExpectation: async () => {
            throw new Error('Expected context not retained');
          },
        },
        engine({
          execute: async (request) => {
            executed = true;
            return { events: events(request.invocation), exitCode: 0 };
          },
        }),
      ),
    ).rejects.toThrow('Expected context not retained');
    expect(executed).toBe(false);
  });
});

test('only owned, confirmed preparations dispatch once, even after execution fails', async () => {
  await fixture(async (_root, options) => {
    let executions = 0;
    const prepared = await prepareVerification(
      options,
      engine({
        execute: async () => {
          executions += 1;
          throw new Error('Engine execution failed');
        },
      }),
    );
    const serialized = JSON.parse(JSON.stringify(prepared));
    await expect(executePreparedVerification(serialized)).rejects.toThrow('owned preparation');
    await expect(executePreparedVerification(prepared)).rejects.toThrow('confirmed');
    await publishVerificationExpectations([prepared], () => publishBatch([prepared], options.root));
    await expect(executePreparedVerification(prepared)).rejects.toThrow('Engine execution failed');
    await expect(executePreparedVerification(prepared)).rejects.toThrow('unused');
    await expect(publishVerificationExpectations([prepared], () => {})).rejects.toThrow(
      'only once',
    );
    expect(executions).toBe(1);
  });
});

test('a batch publication failure prevents dispatch of every prepared platform', async () => {
  await fixture(async (_root, left) => {
    await fixture(async (_other, right) => {
      let executions = 0;
      const execute: FrontEndEngine['execute'] = async (request) => {
        executions += 1;
        return { events: events(request.invocation), exitCode: 0 };
      };
      const batch = await Promise.all([
        prepareVerification(left, engine({ platform: 'darwin-arm64', execute })),
        prepareVerification(right, engine({ platform: 'linux-arm64', execute })),
      ]);
      await expect(
        publishVerificationExpectations(batch, async (contexts) => {
          expect(contexts.map((context) => context.platform)).toEqual([
            'darwin-arm64',
            'linux-arm64',
          ]);
          expect(Object.isFrozen(contexts)).toBe(true);
          await Promise.resolve();
          throw new Error('Second expectation was not durably retained');
        }),
      ).rejects.toThrow('Second expectation');
      for (const prepared of batch)
        await expect(executePreparedVerification(prepared)).rejects.toThrow('confirmed');
      expect(executions).toBe(0);
    });
  });
});

test('publication is exclusive and cancellation cannot reactivate a preparation', async () => {
  await fixture(async (_root, options) => {
    let executions = 0;
    const prepared = await prepareVerification(
      options,
      engine({
        execute: async (request) => {
          executions += 1;
          return { events: events(request.invocation), exitCode: 0 };
        },
      }),
    );
    await expect(
      publishVerificationExpectations([prepared], async () => {
        const receipt = publishBatch([prepared], options.root);
        await expect(publishVerificationExpectations([prepared], () => {})).rejects.toThrow(
          'only once',
        );
        await expect(executePreparedVerification(prepared)).rejects.toThrow('confirmed');
        rejectPreparedVerification(prepared);
        return receipt;
      }),
    ).rejects.toThrow('rejected during publication');
    await expect(executePreparedVerification(prepared)).rejects.toThrow('confirmed');
    expect(executions).toBe(0);
  });
});

test('source and Git are checked again after confirmed publication and before dispatch', async () => {
  for (const phase of ['source', 'git']) {
    await fixture(async (root, options) => {
      let captured = '';
      let changed = false;
      let executions = 0;
      const prepared = await prepareVerification(
        options,
        engine({
          readGit: async () => git(inputs, changed && phase === 'git' ? ['input.ts'] : []),
          plan: async (directory) => {
            if (directory !== root) captured = directory;
            return plan;
          },
          execute: async (request) => {
            executions += 1;
            return { events: events(request.invocation), exitCode: 0 };
          },
        }),
      );
      await publishVerificationExpectations([prepared], () =>
        publishBatch([prepared], options.root),
      );
      changed = true;
      if (phase === 'source')
        writeFileSync(path.join(captured, 'input.ts'), 'changed after publication');
      await expect(executePreparedVerification(prepared)).rejects.toThrow(
        phase === 'source' ? 'Copied source changed before' : 'Git context changed before',
      );
      expect(executions).toBe(0);
    });
  }
});

test('cancellation during asynchronous pre-dispatch validation permanently prevents execution', async () => {
  await fixture(async (_root, options) => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let reads = 0;
    let executions = 0;
    const prepared = await prepareVerification(
      options,
      engine({
        readGit: async () => {
          reads += 1;
          if (reads === 3) {
            entered.resolve();
            await release.promise;
          }
          return git();
        },
        execute: async (request) => {
          executions += 1;
          return { events: events(request.invocation), exitCode: 0 };
        },
      }),
    );
    await publishVerificationExpectations([prepared], () => publishBatch([prepared], options.root));
    const execution = executePreparedVerification(prepared);
    await entered.promise;
    rejectPreparedVerification(prepared);
    release.resolve();
    await expect(execution).rejects.toThrow('rejected before dispatch');
    await expect(executePreparedVerification(prepared)).rejects.toThrow('unused');
    expect(executions).toBe(0);
  });
});

test('silent publishers and copied publication receipts cannot authorize dispatch', async () => {
  const publishers = [
    (_prepared: PreparedVerification, _root: string) => undefined,
    (prepared: PreparedVerification, root: string) =>
      structuredClone(publishBatch([prepared], root)),
    (prepared: PreparedVerification, root: string) =>
      JSON.parse(JSON.stringify(publishBatch([prepared], root))),
  ];
  for (const publish of publishers) {
    await fixture(async (root, options) => {
      let executions = 0;
      await expect(
        verifySnapshot(
          { ...options, publishExpectation: (_context, prepared) => publish(prepared, root) },
          engine({
            execute: async (request) => {
              executions += 1;
              return { events: events(request.invocation), exitCode: 0 };
            },
          }),
        ),
      ).rejects.toThrow('owned durable');
      expect(executions).toBe(0);
    });
  }
});

test('publication bytes are rechecked after asynchronous publisher completion', async () => {
  await fixture(async (root, options) => {
    let executions = 0;
    const file = path.join(path.dirname(root), 'published.json');
    const output = openReportOutput(file, root);
    try {
      await expect(
        verifySnapshot(
          {
            ...options,
            publishExpectation: async (_context, prepared) => {
              const receipt = writeVerificationExpectations([prepared], [output]);
              await Promise.resolve();
              writeFileSync(file, 'unrelated published bytes');
              return receipt;
            },
          },
          engine({
            execute: async (request) => {
              executions += 1;
              return { events: events(request.invocation), exitCode: 0 };
            },
          }),
        ),
      ).rejects.toThrow('facts changed');
      expect(executions).toBe(0);
    } finally {
      output.close();
    }
  });
});

test('a subset receipt cannot confirm a caller-mutated full batch', async () => {
  await fixture(async (root, left) => {
    await fixture(async (_other, right) => {
      let executions = 0;
      const execute: FrontEndEngine['execute'] = async (request) => {
        executions += 1;
        return { events: events(request.invocation), exitCode: 0 };
      };
      const original = await Promise.all([
        prepareVerification(left, engine({ platform: 'darwin-arm64', execute })),
        prepareVerification(right, engine({ platform: 'linux-arm64', execute })),
      ]);
      const supplied = [...original];
      await expect(
        publishVerificationExpectations(supplied, async () => {
          supplied.pop();
          await Promise.resolve();
          return publishBatch(supplied, root);
        }),
      ).rejects.toThrow('exact preparation batch');
      for (const prepared of original)
        await expect(executePreparedVerification(prepared)).rejects.toThrow('confirmed');
      expect(executions).toBe(0);
    });
  });
});

test('owned preparation roots prevent publication inside copied source', async () => {
  await fixture(async (root, options) => {
    let frozenRoot = '';
    let executions = 0;
    await expect(
      verifySnapshot(
        {
          ...options,
          publishExpectation: (_context, prepared) => {
            const output = openReportOutput(path.join(frozenRoot, 'expectations.json'), root);
            retainedOutputs.get(root)?.push(output);
            return writeVerificationExpectations([prepared], [output]);
          },
        },
        engine({
          plan: async (directory) => {
            if (directory !== root) frozenRoot = directory;
            return plan;
          },
          execute: async (request) => {
            executions += 1;
            return { events: events(request.invocation), exitCode: 0 };
          },
        }),
      ),
    ).rejects.toThrow('outside source inputs');
    expect(executions).toBe(0);
  });
});

test('every output stays verified across asynchronous source validation', async () => {
  for (const failure of ['tampered', 'closed']) {
    await fixture(async (root, options) => {
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      let reads = 0;
      let executions = 0;
      const prepared = await prepareVerification(
        options,
        engine({
          readGit: async () => {
            reads += 1;
            if (reads === 2) {
              entered.resolve();
              await release.promise;
            }
            return git();
          },
          execute: async (request) => {
            executions += 1;
            return { events: events(request.invocation), exitCode: 0 };
          },
        }),
      );
      const internal = openReportOutput(path.join(path.dirname(root), 'internal.json'), root);
      const externalFile = path.join(path.dirname(root), 'external.json');
      const external = openReportOutput(externalFile, root);
      try {
        const publication = publishVerificationExpectations([prepared], () =>
          writeVerificationExpectations([prepared], [internal, external]),
        );
        await entered.promise;
        if (failure === 'closed') external.close();
        else writeFileSync(externalFile, 'changed during source validation');
        release.resolve();
        await expect(publication).rejects.toThrow();
        await expect(executePreparedVerification(prepared)).rejects.toThrow('confirmed');
        expect(executions).toBe(0);
      } finally {
        release.resolve();
        internal.close();
        external.close();
      }
    });
  }
});

function controllerStore(): RevocationStore {
  let current: LedgerSnapshot = { revision: 'initial', ledger: parseLedger({}) };
  let revision = 0;
  return {
    read: () => current,
    compareExchange(previous, ledger) {
      if (previous !== current) return null;
      current = { revision: String(++revision), ledger: parseLedger(ledger) };
      return current;
    },
  };
}

test('a cancelled controller never queries, reserves or publishes a new attempt', async () => {
  await fixture(async (_root, options) => {
    const store = controllerStore();
    const initial = store.read();
    const cancellation = new AbortController();
    cancellation.abort(new Error('Verification cancelled'));
    let entered = false;
    const reserved: ControllerEngine = {
      ...engine(),
      completeTestInventory: async () => {
        entered = true;
        return required.map((check) => check.label);
      },
      bindTestReservation: () => {
        entered = true;
      },
      selectedChecks: async () => required,
      testConfigurations: () => new Map(),
    };
    await expect(
      verifyReservedBatch({
        signal: cancellation.signal,
        attempts: [{ options, engine: reserved }],
        store,
        force: true,
        expectationOutputs: [],
        retainReports: () => {
          entered = true;
        },
      }),
    ).rejects.toThrow('Verification cancelled');
    expect(entered).toBe(false);
    expect(store.read()).toBe(initial);
  });
});

test('controller reserves before dispatch, retains every report, then admits the complete native batch', async () => {
  await fixture(async (root, options) => {
    const store = controllerStore();
    const platforms = ['darwin-arm64', 'darwin-x86_64', 'linux-arm64', 'linux-x86_64'];
    let dispatched = 0;
    let retained = false;
    let published = 0;
    const attempts = platforms.map((platform) => {
      let bound: TestReservation | undefined;
      const reserved: ControllerEngine = {
        ...engine({ platform }),
        completeTestInventory: async () => required.map((check) => check.label),
        bindTestReservation: (reservation) => {
          bound = reservation;
        },
        selectedChecks: async () => required,
        testConfigurations: () => new Map(required.map((check) => [check.label, 'config'])),
        execute: async (request) => {
          if (bound === undefined) throw new Error('Execution did not receive nonce inputs');
          expect(bound.fresh).toEqual(required.map((check) => check.label).sort());
          expect(store.read().revision).toBe(bound.snapshot.revision);
          expect(
            required.every((check) => store.read().ledger[check.label]?.state === 'pending'),
          ).toBe(true);
          dispatched++;
          return { events: events(request.invocation), exitCode: 0 };
        },
      };
      return {
        engine: reserved,
        options: { ...options, destination: `${options.destination}-${platform}` },
      };
    });
    const output = openReportOutput(
      path.join(path.dirname(root), 'controller-expectations.json'),
      root,
    );
    try {
      const result = await verifyReservedBatch({
        signal: new AbortController().signal,
        attempts,
        store,
        force: true,
        expectationOutputs: [output],
        publishAdmission(result) {
          published++;
          expect(retained).toBe(true);
          expect(result.admitted).toBe(true);
          expect(controllerExpectations(result).map((entry) => entry.platform)).toEqual(platforms);
          expect(
            required.every((check) => store.read().ledger[check.label]?.state === 'ready'),
          ).toBe(true);
        },
        retainReports(reports) {
          expect(dispatched).toBe(4);
          expect(reports).toHaveLength(4);
          expect(
            required.every((check) => store.read().ledger[check.label]?.state === 'pending'),
          ).toBe(true);
          retained = true;
        },
      });
      expect(retained).toBe(true);
      expect(published).toBe(1);
      expect(result.admitted).toBe(true);
      expect(result.problems).toEqual([]);
      expect(controllerExpectations(result).map((entry) => entry.platform)).toEqual(platforms);
      expect(() => controllerExpectations(structuredClone(result))).toThrow('owned published');
      expect(required.every((check) => store.read().ledger[check.label]?.state === 'ready')).toBe(
        true,
      );
      const replacement = reserveTests(
        store,
        required.map((check) => check.label),
        true,
      );
      expect(() => controllerExpectations(result)).toThrow('superseded');
      expect(store.read()).toBe(replacement.snapshot);
    } finally {
      output.close();
    }
  });
});

test('controller settles a running sibling before failure retirement and refuses partial result inventory', async () => {
  for (const failure of [
    'process',
    'throw',
    'partial',
    'retention',
    'qualification-mutation',
    'platform-drift',
    'cancellation',
    'retention-cancellation',
    'admission-cancellation',
    'mutable-cancellation',
    'publication',
    'publication-cancellation',
    'publication-revocation',
    'publication-source',
    'publication-git',
    'publication-output',
    'retention-source',
    'retention-git',
  ]) {
    await fixture(async (root, options) => {
      const store = controllerStore();
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const cancellation = new AbortController();
      if (failure === 'admission-cancellation') {
        const exchange = store.compareExchange;
        store.compareExchange = (previous, ledger) => {
          const committed = exchange(previous, ledger);
          if (committed !== null && Object.values(ledger).some((epoch) => epoch.state === 'ready'))
            cancellation.abort(new Error('Verification cancelled'));
          return committed;
        };
      }
      let liveGitChanged = false;
      let reservedNonce = '';
      let publicationReplacement: TestReservation | undefined;
      const platforms = ['darwin-arm64', 'darwin-x86_64', 'linux-arm64', 'linux-x86_64'];
      const attempts = platforms.map((platform, index) => ({
        options: { ...options, destination: `${options.destination}-${platform}` },
        engine: {
          ...engine({
            platform,
            readGit: async () => git(inputs, liveGitChanged ? ['input.ts'] : []),
            plan: async () =>
              failure === 'qualification-mutation'
                ? { ...plan, pendingQualifications: ['SDK/pool unqualified'] }
                : plan,
          }),
          completeTestInventory: async () => required.map((check) => check.label),
          bindTestReservation(reservation: TestReservation) {
            reservedNonce = reservation.snapshot.ledger['//test:unit']?.nonce ?? '';
          },
          selectedChecks: async () => required,
          testConfigurations: () => new Map(required.map((check) => [check.label, 'config'])),
          execute: async (request: Parameters<FrontEndEngine['execute']>[0]) => {
            if (index === 1) {
              entered.resolve();
              await release.promise;
            }
            if (index === 0 && failure === 'throw') throw new Error('Engine cancelled');
            if (index === 0 && failure === 'platform-drift')
              Reflect.set(attempts[index]?.engine ?? {}, 'platform', 'linux-arm64');
            return {
              events: events(request.invocation, index === 0 && failure === 'partial'),
              exitCode: index === 0 && failure === 'process' ? 37 : 0,
            };
          },
        } satisfies ControllerEngine,
      }));
      const output = openReportOutput(
        path.join(path.dirname(root), 'controller-failure.json'),
        root,
      );
      try {
        const pending = verifyReservedBatch({
          signal: cancellation.signal,
          attempts,
          store,
          force: true,
          expectationOutputs: [output],
          admissionOutputs: [output],
          async publishAdmission(result) {
            await Promise.resolve();
            expect(result.admitted).toBe(true);
            expect(store.read().ledger['//test:unit']?.state).toBe('ready');
            if (failure === 'publication') {
              const file = path.join(path.dirname(root), 'caller-report.json');
              writeFileSync(file, 'caller-owned\n');
              const caller = openReportOutput(file, root);
              try {
                caller.write(JSON.stringify(result));
              } finally {
                caller.close();
                expect(readFileSync(file, 'utf8')).toBe('caller-owned\n');
              }
            }
            if (failure === 'publication-cancellation')
              cancellation.abort(new Error('Verification cancelled'));
            if (failure === 'publication-source')
              writeFileSync(path.join(root, 'input.ts'), 'changed during publication');
            if (failure === 'publication-git') liveGitChanged = true;
            if (failure === 'publication-output')
              writeFileSync(
                path.join(path.dirname(root), 'controller-failure.json'),
                'corrupted during publication',
              );
            if (failure === 'publication-revocation')
              publicationReplacement = reserveTests(
                store,
                required.map((check) => check.label),
                true,
              );
          },
          retainReports(reports) {
            if (failure === 'retention-source')
              writeFileSync(path.join(root, 'input.ts'), 'changed during retention');
            if (failure === 'retention-git') liveGitChanged = true;
            if (failure === 'retention') throw new Error('Report storage failed');
            if (failure === 'retention-cancellation')
              cancellation.abort(new Error('Verification cancelled'));
            if (failure === 'mutable-cancellation') {
              expect(Reflect.set(cancellation.signal, 'throwIfAborted', () => undefined)).toBe(
                true,
              );
              cancellation.abort(new Error('Verification cancelled'));
            }
            if (failure.endsWith('cancellation')) expect(reports).toHaveLength(4);
            if (failure === 'qualification-mutation')
              for (const report of reports) {
                expect(Reflect.set(report, 'currentAccepted', true)).toBe(false);
                expect(Reflect.set(report.evidence, 'pendingLiveChecks', [])).toBe(false);
                expect(report.currentAccepted).toBe(false);
              }
          },
        });
        if (platforms.length > 1) {
          await entered.promise;
          expect(store.read().ledger['//test:unit']?.nonce).toBe(reservedNonce);
          if (failure === 'cancellation') cancellation.abort(new Error('Verification cancelled'));
          release.resolve();
        }
        if (failure.endsWith('cancellation'))
          await expect(pending).rejects.toThrow('Verification cancelled');
        else if (failure === 'retention')
          await expect(pending).rejects.toThrow('Report storage failed');
        else if (failure === 'publication') await expect(pending).rejects.toThrow();
        else if (failure === 'publication-output')
          await expect(pending).rejects.toThrow('facts changed');
        else if (failure === 'publication-revocation')
          await expect(pending).rejects.toThrow('superseded');
        else if (failure.endsWith('-source') || failure.endsWith('-git'))
          await expect(pending).rejects.toThrow('changed before controller completion');
        else {
          const result = await pending;
          expect(result.admitted).toBe(false);
          if (failure === 'platform-drift')
            expect(result.problems).toContain(
              'Engine platform or version differs from its captured preparation',
            );
          if (failure === 'qualification-mutation')
            expect(result.problems).toContain(
              'Declared qualifications are outstanding: the passes are reusable, the batch is not admitted',
            );
        }
        if (failure === 'qualification-mutation') {
          // A declared qualification withholds admission; the passes stay reusable.
          expect(store.read().ledger['//test:unit']?.nonce).toBe(reservedNonce);
          expect(store.read().ledger['//test:unit']?.state).toBe('ready');
        } else {
          expect(store.read().ledger['//test:unit']?.nonce).not.toBe(reservedNonce);
          expect(store.read().ledger['//test:unit']?.state).toBe('pending');
        }
        if (failure === 'publication-revocation') {
          if (publicationReplacement === undefined)
            throw new Error('Missing competing reservation');
          expect(store.read()).toBe(publicationReplacement.snapshot);
        }
      } finally {
        release.resolve();
        output.close();
      }
    });
  }
});

test('a batch whose engines recorded a pass for the same checks and epochs does not execute', async () => {
  await fixture(async (root, options) => {
    const store = controllerStore();
    const kept = required.map((check) => ({ ...check, fresh: false }));
    const keptPlan: EnginePlan = {
      ...plan,
      coverage: {
        ...plan.coverage,
        required: kept,
        staticOperations: staticOperations.map((operation) => ({
          ...operation,
          checks: operation.checks.map((check) => ({ ...check, fresh: false })),
        })),
      },
      pendingQualifications: ['SDK/pool unqualified'],
    };
    let executions = 0;
    const reserved: ControllerEngine = {
      ...engine({
        platform: 'darwin-arm64',
        plan: async () => keptPlan,
        execute: async (request) => {
          executions++;
          return { events: events(request.invocation), exitCode: 0 };
        },
      }),
      completeTestInventory: async () => kept.map((check) => check.label),
      bindTestReservation: () => undefined,
      selectedChecks: async () => kept,
      testConfigurations: () => new Map(kept.map((check) => [check.label, 'config'])),
    };
    const records = new Map<string, readonly RecordedPass[]>();
    const passes: PassRecords = {
      recorded: async (epochs) => records.get(JSON.stringify(epochs)) ?? [undefined],
      record: async (epochs, batch) => {
        records.set(JSON.stringify(epochs), batch);
      },
    };
    async function run(force = false) {
      const file = path.join(path.dirname(root), `${randomUUID()}.json`);
      const output = openReportOutput(file, root);
      const retained: unknown[] = [];
      try {
        const result = await verifyReservedBatch({
          signal: new AbortController().signal,
          attempts: [
            {
              options: { ...options, destination: `${options.destination}-${randomUUID()}` },
              engine: reserved,
            },
          ],
          store,
          force,
          expectationOutputs: [output],
          retainReports(reports) {
            retained.push(...reports);
          },
          passes,
        });
        return { result, retained, expectations: readFileSync(file, 'utf8') };
      } finally {
        output.close();
      }
    }

    const executed = await run();
    expect(executions).toBe(1);
    expect(executed.result.recorded).toBe(false);
    expect(executed.result.admitted).toBe(false);
    expect(records.size).toBe(1);
    const admitted = store.read();
    expect(kept.every((check) => admitted.ledger[check.label]?.state === 'ready')).toBe(true);

    // The same bytes, Git facts and epochs: the recorded pass is the batch.
    const recorded = await run();
    expect(executions).toBe(1);
    expect(recorded.result.recorded).toBe(true);
    expect(recorded.result.admitted).toBe(false);
    expect(recorded.result.problems).toEqual(executed.result.problems);
    expect(recorded.result.results).toEqual(executed.result.results);
    expect(recorded.retained).toEqual([...executed.result.results]);
    expect(recorded.expectations).toBe(executed.expectations);
    expect(controllerExpectations(recorded.result)).toEqual(
      controllerExpectations(executed.result),
    );
    expect(store.read()).toBe(admitted);

    // A record whose evidence no longer states a complete pass is not an answer.
    const [key, batch] = [...records][0] ?? [];
    const pass = batch?.[0];
    if (key === undefined || pass === undefined) throw new Error('Missing recorded pass');
    records.set(key, [{ ...pass, evidence: { ...pass.evidence, buildEvents: '' } }]);
    expect((await run()).result.recorded).toBe(false);
    expect(executions).toBe(2);
    records.set(key, [{ ...pass, expectation: { ...pass.expectation, required: [] } }]);
    expect((await run()).result.recorded).toBe(false);
    expect(executions).toBe(3);

    // A revoked epoch has a new nonce and is pending: its test runs again.
    expect((await run()).result.recorded).toBe(true);
    reserveTests(store, ['//test:unit'], true);
    expect((await run()).result.recorded).toBe(false);
    expect(executions).toBe(4);

    // A forced run executes whatever is recorded.
    expect((await run()).result.recorded).toBe(true);
    expect((await run(true)).result.recorded).toBe(false);
    expect(executions).toBe(5);
  });
});
