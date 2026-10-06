import { expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { verificationFixture } from './evidence-fixture';
import { bindProducerArtifacts, reconstructProducerVerification } from './shipping-evidence';

test('producer verification is reconstructed from exact evidence and independent context', async () => {
  await verificationFixture((evidence, context) => {
    expect(reconstructProducerVerification(evidence, context).currentAccepted).toBe(true);
    for (const change of [
      { platform: 'linux_x64' },
      { commit: 'b'.repeat(40) },
      { sourceDigest: 'c'.repeat(64) },
      {
        required: [
          ...context.required,
          { label: '//gates:static', kind: 'test' as const, fresh: false },
        ],
      },
    ]) {
      expect(() => reconstructProducerVerification(evidence, { ...context, ...change })).toThrow();
    }
  });
});

test('qualified booleans, malformed shapes and pending receipts cannot replace raw evidence', async () => {
  await verificationFixture((evidence, context) => {
    for (const candidate of [
      { currentAccepted: true, snapshotAccepted: true },
      { ...evidence, qualified: true },
      { ...evidence, processExitCode: false },
      { ...evidence, expectedBuildToolVersion: '9.1.0' },
      {
        ...evidence,
        required: [{ label: '//scripts:release_verifier', kind: 'build', fresh: 'false' }],
      },
      { ...evidence, pendingLiveChecks: ['native SDK context remains unqualified'] },
      { ...evidence, buildEvents: '' },
      {
        ...evidence,
        buildEvents: (evidence.buildEvents as string).replace('"success":true', '"success":false'),
      },
    ]) {
      expect(() => reconstructProducerVerification(candidate, context)).toThrow();
    }
  });
});

const producer = {
  label: '//scripts:release_verifier',
  configuration: 'fixture',
  group: 'default',
  outputs: [{ path: 'bazel-out/native/bin/verify.bin', destination: 'verify' }],
};

test('shipping bytes bind to an exact verified producer configuration and complete output group', async () => {
  await verificationFixture(async (evidence, context, root) => {
    const bound = await bindProducerArtifacts(evidence, context, root, [producer]);
    expect(bound).toHaveLength(1);
    expect(bound[0]?.destination).toBe('verify');
    expect(bound[0]?.producer).toBe('//scripts:release_verifier');
    for (const invalid of [
      { ...producer, configuration: 'unverified-config' },
      { ...producer, group: 'missing-group' },
      { ...producer, label: '//apps/server:server' },
      {
        ...producer,
        outputs: [...producer.outputs, { path: 'missing.bin', destination: 'extra' }],
      },
      {
        ...producer,
        outputs: [{ path: 'bazel-out/native/bin/verify.bin', destination: '../verify' }],
      },
    ]) {
      await expect(bindProducerArtifacts(evidence, context, root, [invalid])).rejects.toThrow();
    }
    await expect(
      bindProducerArtifacts(evidence, context, root, [producer, producer]),
    ).rejects.toThrow();
  });
});

test('corrupt engine-materialized output and failed verification cannot become shipping inputs', async () => {
  await verificationFixture(async (evidence, context, root) => {
    await expect(
      bindProducerArtifacts(
        { ...evidence, pendingLiveChecks: ['profile unqualified'] },
        context,
        root,
        [producer],
      ),
    ).rejects.toThrow();
    writeFileSync(path.join(root, producer.outputs[0]?.path ?? ''), 'corrupt engine output');
    await expect(bindProducerArtifacts(evidence, context, root, [producer])).rejects.toThrow();
  });
});
