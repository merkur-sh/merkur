import { expect, test } from 'bun:test';

import { waitForHarnessEdgeRegistration } from './global-setup';

test('edge readiness waits for the indexed registration serving this certificate', async () => {
  const expected = {
    edgeId: 'phase-edge',
    edgeUrl: 'https://[::1]:14433',
    certHash: 'certificate',
  };
  const registration = {
    edgeId: expected.edgeId,
    edgeWtUrl: expected.edgeUrl,
    activeCertHash: expected.certHash,
    certHashes: [expected.certHash, 'next-certificate'],
    updatedAt: 123,
  };
  const pending = [
    { record: null, score: null },
    { record: JSON.stringify(registration), score: null },
    {
      record: JSON.stringify({ ...registration, certHashes: ['previous', expected.certHash] }),
      score: 123,
    },
    { record: JSON.stringify({ ...registration, activeCertHash: 'other-edge' }), score: 123 },
    { record: JSON.stringify({ ...registration, edgeWtUrl: 'https://[::1]:14434' }), score: 123 },
    { record: JSON.stringify(registration), score: 122 },
    { record: JSON.stringify(registration), score: 123 },
  ];
  let reads = 0;
  await waitForHarnessEdgeRegistration(
    async () => {
      const next = pending[reads++];
      if (next === undefined) throw new Error('read beyond the ready registration');
      return next;
    },
    expected,
    AbortSignal.timeout(2_000),
  );
  expect(reads).toBe(pending.length);
});

test('an edge that never registers fails setup instead of releasing browser tests', async () => {
  await expect(
    waitForHarnessEdgeRegistration(
      async () => ({ record: null, score: null }),
      { edgeId: 'missing', edgeUrl: 'https://[::1]:14433', certHash: 'certificate' },
      AbortSignal.timeout(20),
    ),
  ).rejects.toThrow();
});
