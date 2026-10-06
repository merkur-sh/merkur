import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { PACKING_RUNTIME_FILES } from '../tests/e2e/fixtures/packing-delivery-provenance';
import {
  assertPackingArmEquivalence,
  packingDeliveryConfigOverlay,
  wholeSpanDeliveryOverlay,
} from './run-terminal-packing-delivery';

test('detached whole-span hardcut retains interactive selection and shared header promotion', () => {
  const source = readFileSync(
    new URL('../apps/daemon/dataplane/src/display/send.rs', import.meta.url),
    'utf8',
  );
  const candidate = wholeSpanDeliveryOverlay(source);
  expect(candidate).toContain('#[cfg(not(test))]\n    let whole_span_delivery = true;');
  expect(candidate).toContain(
    'whole_span_delivery && presentation_workload != DisplayWorkload::Interactive',
  );
  expect(candidate).toContain(
    'let whole_span_delivery = *experiment == PackingExperiment::WholeSpan;',
  );
  expect(candidate).not.toContain('#[cfg(test)]\nfn pack_whole_span_candidate(');
  // The rest of the very large sender stays byte-identical, including the
  // shared promotion, admission, membership, FEC, ACK and security contracts.
  expect(candidate.slice(candidate.indexOf('fn prepare_display_off_loop('))).toBe(
    source.slice(source.indexOf('fn prepare_display_off_loop(')),
  );
  expect(() => wholeSpanDeliveryOverlay(candidate)).toThrow('source anchor drift');
});

test('experiment config uses one explicit browser with no trace/video or retries', () => {
  const source = readFileSync(new URL('../playwright.edge.config.mjs', import.meta.url), 'utf8');
  const candidate = packingDeliveryConfigOverlay(source);
  expect(candidate).toContain("testMatch: ['**/terminal-packing-delivery.e2e.ts']");
  expect(candidate).toContain("trace: 'off', video: 'off'");
  expect(candidate).toContain('retries: 0, workers: 1');
  expect(candidate).toContain('PACKING_BROWSER_BINARY');
  expect(() => packingDeliveryConfigOverlay(candidate)).toThrow('source anchor drift');
});

test('sealed pair accepts only native policy inequality with shared artifact equality', () => {
  const identity = (directory: string, native: string) => ({
    directory,
    checkpoint: 'a'.repeat(40),
    sourceSha256: 'b'.repeat(64),
    overlaySha256: 'c'.repeat(64),
    nativeAndWasm: PACKING_RUNTIME_FILES.map((file) => ({
      path: file,
      sha256: file === 'apps/daemon/dist/merkur-dataplane' ? native : 'd'.repeat(64),
    })),
    webBundleSha256: 'e'.repeat(64),
    browser: {
      path: '/browser',
      executableSha256: 'f'.repeat(64),
      bundlePath: '/browser.app',
      bundleSha256: '0'.repeat(64),
    },
    testTools: [{ path: `${directory}/node_modules/playwright`, sha256: '1'.repeat(64) }],
    node: { path: '/node', version: '24', sha256: '2'.repeat(64) },
    bun: { path: '/bun', version: '1.4', sha256: '3'.repeat(64) },
  });
  const adaptive = identity('/owned/adaptive', '4'.repeat(64));
  const candidate = identity('/owned/whole-span', '5'.repeat(64));
  expect(() => assertPackingArmEquivalence(adaptive, candidate)).not.toThrow();
  expect(() =>
    assertPackingArmEquivalence(adaptive, identity('/owned/whole-span', '4'.repeat(64))),
  ).toThrow();
  for (const key of ['webBundleSha256', 'checkpoint'] as const)
    expect(() =>
      assertPackingArmEquivalence(adaptive, { ...candidate, [key]: 'changed' }),
    ).toThrow();
  expect(() =>
    assertPackingArmEquivalence(adaptive, {
      ...candidate,
      browser: { ...candidate.browser, bundleSha256: 'changed' },
    }),
  ).toThrow();
  expect(() =>
    assertPackingArmEquivalence(adaptive, {
      ...candidate,
      nativeAndWasm: candidate.nativeAndWasm.map((artifact, index) =>
        index === 1 ? { ...artifact, sha256: 'changed' } : artifact,
      ),
    }),
  ).toThrow();
  expect(() =>
    assertPackingArmEquivalence(adaptive, {
      ...candidate,
      testTools: [{ path: '/package', sha256: 'changed' }],
    }),
  ).toThrow();
});
