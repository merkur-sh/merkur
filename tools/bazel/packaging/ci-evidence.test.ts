import { expect, test } from 'bun:test';
import { type ExpectedCiVerification, reconstructCiVerification } from './ci-evidence';
import { verificationFixture } from './evidence-fixture';

test('CI reconstructs execution with an independent complete source, Git, graph and invocation binding', async () => {
  await verificationFixture((evidence, context) => {
    const { commit, ...rest } = context;
    const expected: ExpectedCiVerification = { ...rest, head: commit };
    expect(
      reconstructCiVerification({ evidence, currentAccepted: false }, expected).currentAccepted,
    ).toBe(true);
    for (const change of [
      { invocation: '22222222-2222-4222-8222-222222222222' },
      { base: 'e'.repeat(40) },
      { candidate: 'e'.repeat(40) },
      { head: 'e'.repeat(40) },
      { gitDigest: 'e'.repeat(64) },
      { sourceDigest: 'e'.repeat(64) },
      { configuredDigest: 'e'.repeat(64) },
      { platform: 'linux-x86_64' },
      { admittedUntracked: ['invented.ts'] },
      {
        required: [
          ...expected.required,
          { label: '//static:missing', kind: 'test' as const, fresh: true },
        ],
      },
    ])
      expect(() => reconstructCiVerification({ evidence }, { ...expected, ...change })).toThrow();
  });
});

test('status-success, booleans, blocked or stale reports and coherent omissions cannot admit CI', async () => {
  await verificationFixture((evidence, context) => {
    const { commit, ...rest } = context;
    const expected: ExpectedCiVerification = { ...rest, head: commit };
    for (const candidate of [
      { result: 'success' },
      { currentAccepted: true, snapshotAccepted: true },
      { phase: 'blocked', evidence },
      { evidence: { ...evidence, pendingLiveChecks: ['SDK or engine receipt is unqualified'] } },
      { evidence: { ...evidence, processExitCode: 1 } },
      { evidence: { ...evidence, required: [] } },
      { evidence: { ...evidence, context: undefined } },
      Object.create({ evidence }),
    ])
      expect(() => reconstructCiVerification(candidate, expected)).toThrow();
    expect(() =>
      reconstructCiVerification({ evidence }, {
        ...expected,
        sourceDigest: true,
      } as unknown as ExpectedCiVerification),
    ).toThrow();
  });
});
