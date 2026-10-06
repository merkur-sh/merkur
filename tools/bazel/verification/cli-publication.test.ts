import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BazelVerificationEngine } from './bazel-engine';
import { verificationMain } from './cli';
import type { ControllerEngine } from './controller';
import type { EnginePlan } from './front-end';
import { captureGitContext } from './git-context';
import { type LedgerSnapshot, type RevocationStore, reserveTests } from './revocation';
import { BAZEL_STATIC_GATES as STATIC_GATES } from './static-gates';

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

function git() {
  return captureGitContext(
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
}

function events(invocation: string): string {
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

function readDocument(file: string): Record<string, unknown> {
  const document: unknown = JSON.parse(readFileSync(file, 'utf8'));
  if (document === null || typeof document !== 'object' || Array.isArray(document))
    throw new Error('Expected a retained report object');
  return document as Record<string, unknown>;
}

type Fault =
  | 'none'
  | 'source'
  | 'nonce'
  | 'output'
  | 'cancel'
  | 'shutdown'
  | 'shutdown-source'
  | 'shutdown-cancel';

async function publicationFixture(fault: Fault, workflowArgs: readonly string[] = []) {
  const parent = mkdtempSync(path.join(os.tmpdir(), 'merkur-cli-publication-'));
  const root = path.join(parent, 'live');
  mkdirSync(root);
  for (const name of inputs) writeFileSync(path.join(root, name), 'captured bytes');
  const reportFile = path.join(parent, 'report.json');
  const ciFile = path.join(parent, 'ci.json');
  let current: LedgerSnapshot = { revision: '0', ledger: {} };
  const store: RevocationStore = {
    read: () => current,
    compareExchange(previous, ledger) {
      if (previous.revision !== current.revision) return null;
      current = { revision: String(Number(current.revision) + 1), ledger };
      return current;
    },
  };
  let injected = false;
  let closed = false;
  let closeCalls = 0;
  const workflowRequests: { assuranceEvent: unknown; extendedSuite: unknown }[] = [];
  let beforeFault: { accepted: unknown; ciAdmitted: unknown; epoch: unknown } | undefined;
  const methods: Pick<
    ControllerEngine,
    | 'readGit'
    | 'plan'
    | 'execute'
    | 'completeTestInventory'
    | 'bindTestReservation'
    | 'selectedChecks'
    | 'testConfigurations'
  > & { initialize(): Promise<void>; close(): Promise<void>; ledgerStore(): RevocationStore } = {
    async initialize() {
      const request: unknown = Reflect.get(this, 'options');
      if (request === null || typeof request !== 'object')
        throw new Error('Expected production engine workflow options');
      workflowRequests.push({
        assuranceEvent: Reflect.get(request, 'assuranceEvent'),
        extendedSuite: Reflect.get(request, 'extendedSuite'),
      });
    },
    async close() {
      closeCalls++;
      if (!closed) {
        closed = true;
        if (fault.startsWith('shutdown')) {
          injected = true;
          beforeFault = {
            accepted: existsSync(reportFile) ? readDocument(reportFile).currentAccepted : undefined,
            ciAdmitted: existsSync(ciFile) ? readDocument(ciFile).admitted : undefined,
            epoch: store.read().ledger['//test:unit']?.state,
          };
          if (fault === 'shutdown-source')
            writeFileSync(path.join(root, 'input.ts'), 'changed during shutdown');
          if (fault === 'shutdown-cancel') process.emit('SIGTERM', 'SIGTERM');
        }
      }
      if (fault === 'shutdown') throw new Error('Reproduced private shutdown failure');
    },
    ledgerStore: () => store,
    async readGit() {
      // Source reconciliation after publication supplies a real awaited boundary, without
      // mocking the controller, root writer, nonce transition or production CLI callback.
      if (!injected && !fault.startsWith('shutdown') && existsSync(reportFile)) {
        injected = true;
        beforeFault = {
          accepted: readDocument(reportFile).currentAccepted,
          ciAdmitted: readDocument(ciFile).admitted,
          epoch: store.read().ledger['//test:unit']?.state,
        };
        if (fault === 'source') writeFileSync(path.join(root, 'input.ts'), 'changed source');
        if (fault === 'nonce') reserveTests(store, ['//test:unit'], true);
        if (fault === 'output') writeFileSync(ciFile, '{"admitted":true,"corrupted":true}\n');
        if (fault === 'cancel') process.emit('SIGTERM', 'SIGTERM');
      }
      return git();
    },
    async plan() {
      if (closed) throw new Error('Planning restarted a closed private engine');
      return plan;
    },
    execute: async (request) => ({ events: events(request.invocation), exitCode: 0 }),
    completeTestInventory: async () => required.map((check) => check.label),
    bindTestReservation() {},
    selectedChecks: async () => required,
    testConfigurations: () => new Map(required.map((check) => [check.label, 'config'])),
  };
  const prototype = BazelVerificationEngine.prototype;
  const descriptors = new Map(
    Object.keys(methods).map((name) => [name, Object.getOwnPropertyDescriptor(prototype, name)]),
  );
  const sdkPrefix = process.env.MERKUR_BAZEL_NATIVE_SDK_PREFIX;
  if (sdkPrefix === undefined) throw new Error('Publication controls require the declared Git SDK');
  const environment = {
    BUILD_WORKSPACE_DIRECTORY: root,
    MERKUR_VERIFICATION_BAZEL: path.join(parent, 'not-read-bazel'),
    MERKUR_VERIFICATION_BAZEL_ACQUISITION: path.join(parent, 'not-read-acquisition'),
    MERKUR_VERIFICATION_GIT: path.join(sdkPrefix, 'bin', 'git'),
    MERKUR_VERIFICATION_CREDENTIAL_HELPER: path.join(parent, 'not-read-helper'),
    MERKUR_BAZEL_RUNFILES_ROOT: parent,
    MERKUR_BAZEL_NATIVE_SDK_PREFIX: sdkPrefix,
    TMPDIR: parent,
  };
  const previousEnvironment = new Map(
    Object.keys(environment).map((name) => [name, process.env[name]]),
  );
  const previousListeners = new Map(
    (['SIGINT', 'SIGTERM'] as const).map((signal) => [signal, process.listeners(signal)]),
  );
  try {
    // Synthetic engine I/O isolates terminal publication policy. Declared dummy tool
    // and credential paths are never read. The actual declared SDK supplies trust Files;
    // this fixture does not qualify any native execution pool.
    for (const [name, value] of Object.entries(methods))
      Object.defineProperty(prototype, name, { value, writable: true, configurable: true });
    Object.assign(process.env, environment);
    const exitCode = await verificationMain([
      '--force',
      ...workflowArgs,
      '--ledger-client',
      path.join(parent, 'not-read-ledger'),
      '--credential-file',
      path.join(parent, 'not-read-credentials'),
      '--report-file',
      reportFile,
      '--ci-report-file',
      ciFile,
      '--expected-context-file',
      path.join(parent, 'expected.json'),
    ]);
    return {
      exitCode,
      workflowRequests,
      closeCalls,
      injected,
      beforeFault,
      report: readDocument(reportFile),
      ci: readDocument(ciFile),
      epoch: store.read().ledger['//test:unit']?.state,
    };
  } finally {
    for (const [name, descriptor] of descriptors) {
      if (descriptor === undefined) Reflect.deleteProperty(prototype, name);
      else Object.defineProperty(prototype, name, descriptor);
    }
    for (const [name, value] of previousEnvironment) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(parent, { recursive: true, force: true });
    for (const [name, descriptor] of descriptors)
      expect(Object.getOwnPropertyDescriptor(prototype, name)).toEqual(descriptor);
    for (const [name, value] of previousEnvironment) expect(process.env[name]).toBe(value);
    for (const [signal, listeners] of previousListeners)
      expect(process.listeners(signal)).toEqual(listeners);
  }
}

test('production CLI retains a clean terminal admission', async () => {
  const result = await publicationFixture('none');
  expect(result.injected).toBe(true);
  expect(result.beforeFault).toEqual({ accepted: true, ciAdmitted: true, epoch: 'ready' });
  expect(result.exitCode).toBe(0);
  expect(result.report.admitted).toBe(true);
  expect(result.report.currentAccepted).toBe(true);
  expect(result.ci.admitted).toBe(true);
  expect(result.epoch).toBe('ready');
});

for (const [fault, problem] of [
  ['source', 'Source changed during private engine shutdown'],
  ['nonce', 'A newer revocation superseded this controller admission'],
  ['output', 'Owned publication file facts changed'],
  ['cancel', 'Verification cancelled by SIGTERM'],
] as const)
  test(`production CLI retires accepted reports and the selected nonce after late ${fault} failure`, async () => {
    const result = await publicationFixture(fault);
    expect(result.injected).toBe(true);
    expect(result.beforeFault).toEqual({ accepted: true, ciAdmitted: true, epoch: 'ready' });
    expect(result.exitCode).toBe(1);
    expect(result.epoch).toBe('pending');
    expect(result.report.admitted).not.toBe(true);
    expect(result.report.currentAccepted).toBe(false);
    expect(result.report.snapshotAccepted).toBe(false);
    expect(result.report.phase).toBe('blocked');
    expect(result.report.problem).toContain(problem);
    expect(result.ci.admitted).toBe(false);
    expect(result.ci.corrupted).toBeUndefined();
    expect(result.ci.expectations).toBeUndefined();
    expect(result.ci.reports).toBeUndefined();
  });

for (const fault of ['shutdown', 'shutdown-source', 'shutdown-cancel'] as const)
  test(`production CLI retires admission after ${fault}`, async () => {
    const result = await publicationFixture(fault);
    expect(result.injected).toBe(true);
    expect(result.closeCalls).toBeGreaterThanOrEqual(1);
    expect(result.beforeFault).toEqual({
      accepted: undefined,
      ciAdmitted: undefined,
      epoch: 'pending',
    });
    expect(result.exitCode).toBe(1);
    expect(result.report.currentAccepted).toBe(false);
    expect(result.ci.admitted).toBe(false);
    expect(result.epoch).toBe('pending');
  });

test('production CLI forwards the requested assurance event to its engine', async () => {
  const result = await publicationFixture('none', ['--all', '--assurance-event', 'push']);
  expect(result.exitCode).toBe(0);
  expect(result.workflowRequests).toEqual([{ assuranceEvent: 'push', extendedSuite: undefined }]);
});

test('production CLI forwards the exact extended operation to its engine', async () => {
  const result = await publicationFixture('none', ['--all', '--extended-suite', 'test:natlab']);
  expect(result.exitCode).toBe(0);
  expect(result.workflowRequests).toEqual([
    { assuranceEvent: undefined, extendedSuite: 'test:natlab' },
  ]);
});
