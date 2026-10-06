import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { STATIC_GATES } from '../../../scripts/gate-policy';
import type { OwnedDirectory } from '../bun/owned-files';
import { type EngineArtifact, readEngineArtifact } from '../verification/artifacts';
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
import { manifestFromInventory } from '../verification/snapshot';
import { bindControllerCiArtifacts, type PreparedCiArtifactInputs } from './ci-preparation';
import releaseContract from './release-contract.json';
import { type ReleaseArtifactSource, stageReleaseArtifacts } from './release-staging';
import type { ProducerOutputs } from './shipping-evidence';

const head = 'a'.repeat(40);
const inputs = ['.bazelversion', 'BUILD.bazel', 'MODULE.bazel', 'input.ts'];
const nativePlatforms = {
  'darwin-arm64': 'darwin-arm64',
  'darwin-x86_64': 'darwin-x64',
  'linux-arm64': 'linux-arm64',
  'linux-x86_64': 'linux-x64',
};
const targets: Readonly<Record<string, string>> = {
  'NOTICES.txt': 'release_notices',
  'deployment.tar.gz': 'deployment_unsigned',
  'edge-image.tar.gz': 'edge_image_unsigned',
  'stun-image.tar.gz': 'stun_image_unsigned',
};
const staticOperations = STATIC_GATES.map((name) => ({
  name,
  checks: [{ label: `//test:${name.replaceAll(':', '_')}`, kind: 'test', fresh: true } as const],
}));
const tests: readonly RequiredCheck[] = [
  { label: '//test:unit', kind: 'test', fresh: true },
  ...staticOperations.flatMap((operation) => operation.checks),
];

function bytesFact(root: string, relative: string): EngineArtifact {
  const bytes = readFileSync(path.join(root, relative));
  return {
    path: relative,
    digest: createHash('sha256').update(bytes).digest('hex'),
    length: String(bytes.length),
  };
}

function fileEvent(artifact: EngineArtifact) {
  return {
    name: path.posix.basename(artifact.path),
    pathPrefix: path.posix.dirname(artifact.path).split('/'),
    digest: artifact.digest,
    length: artifact.length,
  };
}

type Fault =
  | 'none'
  | 'nonce'
  | 'source'
  | 'missing-output'
  | 'descriptor'
  | 'after-staging-source'
  | 'after-staging-nonce';

async function exercise(fault: Fault): Promise<void> {
  const parent = mkdtempSync(path.join(os.tmpdir(), 'release-controller-'));
  const root = path.join(parent, 'source');
  mkdirSync(root);
  for (const input of inputs) writeFileSync(path.join(root, input), 'captured source bytes');
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
  let current: LedgerSnapshot = { revision: '0', ledger: {} };
  const store: RevocationStore = {
    read: () => current,
    compareExchange(previous, ledger) {
      if (previous.revision !== current.revision) return null;
      current = { revision: String(Number(current.revision) + 1), ledger };
      return current;
    },
  };
  const captured: PreparedCiArtifactInputs[] = [];
  const sources: ReleaseArtifactSource[] = [];
  const ordinary: { root: string; facts: readonly EngineArtifact[] }[] = [];
  const outputs = Object.keys(nativePlatforms).map((platform) =>
    openReportOutput(path.join(parent, `${platform}.expected.json`), root),
  );
  const releaseRoot = path.join(parent, 'release');
  const evidenceRoot = path.join(parent, 'evidence');
  let publication: readonly OwnedDirectory[] = [];
  const attempts = Object.entries(nativePlatforms).map(([platform, shippingPlatform]) => {
    const materializedRoot = path.join(parent, `engine-${platform}`);
    const prefix = 'bazel-out/native/bin/tools/bazel/packaging';
    mkdirSync(path.join(materializedRoot, prefix), { recursive: true });
    const producers: ProducerOutputs[] = [];
    const retainedFiles: EngineArtifact[] = [];
    const ordinaryFiles: EngineArtifact[] = [];
    for (const artifact of releaseContract.artifacts) {
      if (
        artifact.platform !== shippingPlatform &&
        !(artifact.platform === 'all' && shippingPlatform === 'linux-x64')
      )
        continue;
      const target = targets[artifact.name] ?? artifact.name.replace(/\.tar\.gz$/, '');
      const label = `//tools/bazel/packaging:${target}`;
      const shipping = `${prefix}/${artifact.name}`;
      writeFileSync(
        path.join(materializedRoot, shipping),
        `synthetic shipping fixture: ${artifact.name}`,
      );
      const outputs: ProducerOutputs['outputs'][number][] = [
        { path: shipping, destination: artifact.name },
      ];
      if (artifact.name !== 'NOTICES.txt') {
        const signing = `${prefix}/${target}.signing-inputs.json`;
        writeFileSync(
          path.join(materializedRoot, signing),
          `original signing fixture: ${artifact.name}`,
        );
        outputs.push({ path: signing, destination: `${target}.signing-inputs.json` });
      }
      const descriptor = `${prefix}/${target}.unsigned-contract.json`;
      writeFileSync(
        path.join(materializedRoot, descriptor),
        JSON.stringify({ label, group: 'default', outputs }),
      );
      retainedFiles.push(bytesFact(materializedRoot, descriptor));
      ordinaryFiles.push(...outputs.map((output) => bytesFact(materializedRoot, output.path)));
      producers.push({ label, configuration: 'native', group: 'default', outputs });
    }
    ordinary.push({ root: materializedRoot, facts: ordinaryFiles });
    const checks: readonly RequiredCheck[] = [
      ...tests,
      ...producers.map(
        (producer) => ({ label: producer.label, kind: 'build', fresh: false }) as const,
      ),
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
    const engine: ControllerEngine = {
      version: '9.2.0',
      platform,
      readGit: async () => git(),
      plan: async () => plan,
      completeTestInventory: async () => tests.map((test) => test.label),
      bindTestReservation: () => {},
      selectedChecks: async () => checks,
      testConfigurations: () => new Map(checks.map((check) => [check.label, 'native'])),
      async execute(request) {
        // These are actual ordinary descriptor Files captured in this synthetic engine fixture,
        // not a caller-submitted inventory or a readiness claim about production providers.
        const original: ProducerOutputs[] = [];
        for (const descriptor of retainedFiles) {
          const bytes = await readEngineArtifact(materializedRoot, descriptor);
          const value = JSON.parse(bytes.toString()) as Omit<ProducerOutputs, 'configuration'>;
          original.push({ ...value, configuration: 'native' });
        }
        captured.push({ invocation: request.invocation, materializedRoot, producers: original });
        sources.push({ invocation: request.invocation, materializedRoot, retainedFiles });
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
        ];
        for (const producer of original) {
          const id = producer.label;
          const descriptor = retainedFiles.find((file) =>
            file.path.endsWith(`${id.split(':')[1]}.unsigned-contract.json`),
          );
          if (descriptor === undefined) throw new Error('Fixture descriptor absent');
          events.push(
            {
              id: { namedSet: { id } },
              namedSetOfFiles: {
                files: producer.outputs.map((output) =>
                  fileEvent(bytesFact(materializedRoot, output.path)),
                ),
              },
            },
            {
              id: { namedSet: { id: `${id}-descriptor` } },
              namedSetOfFiles: { files: [fileEvent(descriptor)] },
            },
            {
              id: { targetCompleted: { label: id, configuration: { id: 'native' } } },
              completed: {
                success: true,
                outputGroup: [
                  { name: 'default', fileSets: [{ id }] },
                  { name: 'unsigned_contract', fileSets: [{ id: `${id}-descriptor` }] },
                ],
              },
            },
          );
        }
        events.push({
          id: { buildFinished: {} },
          finished: { exitCode: { code: 0 } },
          lastMessage: true,
        });
        return { events: events.map((event) => JSON.stringify(event)).join('\n'), exitCode: 0 };
      },
    };
    return {
      options: {
        root,
        destination: path.join(parent, `frozen-${platform}`),
        base: head,
        candidate: head,
        admittedUntracked: [],
      },
      engine,
    };
  });
  try {
    const run = verifyReservedBatch({
      signal: new AbortController().signal,
      attempts,
      store,
      force: true,
      expectationOutputs: outputs,
      retainReports: () => {},
      async publishAdmission(result) {
        const bound = await bindControllerCiArtifacts(result, captured);
        const expectation = controllerExpectations(result)[0];
        if (expectation === undefined) throw new Error('Missing original controller expectation');
        let checks = 0;
        publication = await stageReleaseArtifacts({
          batches: bound,
          sources,
          releaseRoot,
          evidenceRoot,
          assertCurrent() {
            if (++checks === 5) {
              if (fault === 'nonce') reserveTests(store, ['//test:unit'], true);
              if (fault === 'source') writeFileSync(path.join(root, 'input.ts'), 'changed source');
              if (fault === 'missing-output') {
                const last = ordinary.at(-1);
                const file = last?.facts.at(-1);
                if (last === undefined || file === undefined)
                  throw new Error('Missing fixture output');
                rmSync(path.join(last.root, file.path));
              }
              if (fault === 'descriptor') {
                const last = sources.at(-1);
                const file = last?.retainedFiles?.at(-1);
                if (last === undefined || file === undefined)
                  throw new Error('Missing fixture descriptor');
                writeFileSync(
                  path.join(last.materializedRoot, file.path),
                  'changed original descriptor',
                );
              }
            }
            controllerExpectations(result);
            if (manifestFromInventory(root, inputs, head).digest !== expectation.sourceDigest)
              throw new Error('Captured controller source changed during staging');
          },
        });
        if (fault === 'after-staging-source')
          writeFileSync(path.join(root, 'input.ts'), 'changed after staging returned');
        if (fault === 'after-staging-nonce') reserveTests(store, ['//test:unit'], true);
      },
    }).catch((error: unknown) => {
      const failures = [error];
      for (const directory of publication) {
        try {
          directory.removeCreated();
        } catch (cleanup) {
          failures.push(cleanup);
        }
      }
      if (failures.length !== 1)
        throw new AggregateError(failures, 'Release publication cleanup failed');
      throw error;
    });
    if (fault === 'none') {
      const result = await run;
      expect(result.admitted).toBe(true);
      expect(store.read().ledger['//test:unit']?.state).toBe('ready');
      expect(readdirSync(releaseRoot).sort()).toEqual(
        releaseContract.artifacts.map((artifact) => artifact.name).sort(),
      );
      for (const source of sources) {
        const descriptor = source.retainedFiles?.[0];
        if (descriptor === undefined) throw new Error('Missing fixture descriptor');
        expect(
          readFileSync(path.join(evidenceRoot, source.invocation, 'engine', descriptor.path)),
        ).toEqual(readFileSync(path.join(source.materializedRoot, descriptor.path)));
      }
      expect(readdirSync(releaseRoot).some((name) => name.endsWith('.json'))).toBe(false);
    } else {
      await expect(run).rejects.toThrow();
      expect(store.read().ledger['//test:unit']?.state).toBe('pending');
      expect(existsSync(releaseRoot)).toBe(true);
      expect(readdirSync(releaseRoot)).toEqual([]);
      expect(readdirSync(evidenceRoot)).toEqual([]);
    }
  } finally {
    for (const directory of publication) directory.close();
    for (const output of outputs) output.close();
    rmSync(parent, { recursive: true, force: true });
  }
}

test('owned four-platform controller binds captured descriptors and stages exact ten-file release', () =>
  exercise('none'));
for (const fault of [
  'nonce',
  'source',
  'missing-output',
  'descriptor',
  'after-staging-source',
  'after-staging-nonce',
] as const)
  test(`controller publication retires admitted pass and staged files after ${fault} changes`, () =>
    exercise(fault));
