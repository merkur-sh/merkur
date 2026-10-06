import { describe, expect, test } from 'bun:test';
import type { TerminalPerfEvent } from '../../../apps/web/src/perf/terminal-latency';
import { summarizeDisplayIngressRoutes } from './display-ingress-routes';

type Io = Extract<TerminalPerfEvent, { kind: 'browser_display_io' }>;
type Receipt = Extract<TerminalPerfEvent, { kind: 'display_received' }>;

function ingress(overrides: Partial<Io> = {}): Io {
  return {
    kind: 'browser_display_io',
    atMs: 10,
    stage: 'transport_ingress',
    ingressRoute: 'direct-datagram',
    displaySeq: 1,
    generation: 1,
    frameId: 7,
    chunkIndex: 0,
    chunkCount: 1,
    payloadByteLength: 100,
    admitted: true,
    fecRecovered: false,
    explicitCopyCount: 1,
    explicitCopiedBytes: 100,
    explicitAllocationRequestCount: 0,
    explicitAllocationRequestedBytes: 0,
    explicitObjectAllocationRequestCount: 0,
    ...overrides,
  };
}

function received(overrides: Partial<Receipt> = {}): Receipt {
  return {
    kind: 'display_received',
    atMs: 11,
    displaySeq: 1,
    generation: 1,
    inputSeq: 3,
    frameId: 7,
    chunkIndex: 0,
    chunkCount: 1,
    presentationId: 5,
    presentationMemberIndex: 0,
    presentationMemberCount: 1,
    rowPredecessorPresentationId: 0,
    presentationTransactionSeq: 0,
    presentationCoherent: true,
    presentationEnd: true,
    fecRecovered: false,
    authoritativeVisualMutation: null,
    workerReceiptToDecodeMs: 0.1,
    decodeToApplyMs: null,
    byteLength: 100,
    rowCount: 1,
    displayKind: 'display_delta',
    ...overrides,
  };
}

describe('exact display ingress route census', () => {
  test('joins exact identity despite interleaving and retains late mixed replicas as ambiguous', () => {
    const result = summarizeDisplayIngressRoutes([
      ingress(),
      ingress({ generation: 2, ingressRoute: 'relay-reliable' }),
      received(),
      ingress({ atMs: 30, ingressRoute: 'relay-datagram' }),
    ]);
    expect(result.complete).toBe(true);
    expect(result.units[0]).toMatchObject({
      attribution: 'ambiguous-multiple-routes',
      soleAdmittedRoute: null,
      admittedRoutes: ['direct-datagram', 'relay-datagram'],
      inputSeq: 3,
      presentationId: 5,
    });
    expect(result.units[0]?.attempts).toHaveLength(2);
    expect(result.unmatchedIngressAttempts).toHaveLength(1);
  });

  test('refused attempts cannot own receipt and are retained alongside the admitted route', () => {
    const result = summarizeDisplayIngressRoutes([
      ingress({ admitted: false }),
      ingress({ ingressRoute: 'relay-reliable' }),
      received(),
    ]);
    expect(result.units[0]).toMatchObject({
      attribution: 'sole-admitted-route',
      soleAdmittedRoute: 'relay-reliable',
    });
    expect(result.units[0]?.attempts).toHaveLength(2);
    const missing = summarizeDisplayIngressRoutes([ingress({ admitted: false }), received()]);
    expect(missing.complete).toBe(false);
    expect(missing.units[0]?.soleAdmittedRoute).toBeNull();
  });

  test('does not use frame proximity, current generation, or a different snapshot chunk', () => {
    for (const mismatch of [
      { generation: 2 },
      { displaySeq: 2 },
      { frameId: 8 },
      { chunkIndex: 1, chunkCount: 2 },
    ]) {
      const result = summarizeDisplayIngressRoutes([ingress(mismatch), received()]);
      expect(result.complete).toBe(false);
      expect(result.unmatchedIngressAttempts).toHaveLength(1);
      expect(result.units[0]?.attribution).toBe('missing-ingress');
    }
  });

  test('keeps FEC parity and reconstructed original attribution separate', () => {
    const result = summarizeDisplayIngressRoutes([
      ingress({ stage: 'transport_fec_ingress', frameId: 0, ingressRoute: 'relay-datagram' }),
      received({ fecRecovered: true }),
    ]);
    expect(result.complete).toBe(true);
    expect(result.units[0]).toMatchObject({
      attribution: 'fec-reconstructed',
      soleAdmittedRoute: null,
      admittedRoutes: [],
    });
    expect(result.fecIngress).toHaveLength(1);
  });

  test('retains repeated receives, same-route attempts and payload conflicts', () => {
    const result = summarizeDisplayIngressRoutes([
      ingress(),
      ingress({ atMs: 12 }),
      received(),
      received({ atMs: 13 }),
    ]);
    expect(result.units).toHaveLength(2);
    expect(result.complete).toBe(false);
    expect(result.errors).toEqual(['display 1:1:7:0:1 has duplicate terminal receipt evidence']);
    expect(result.units[0]?.soleAdmittedRoute).toBe('direct-datagram');
    expect(result.units[1]?.attempts).toHaveLength(2);
    expect(
      summarizeDisplayIngressRoutes([ingress({ payloadByteLength: 101 }), received()]).complete,
    ).toBe(false);
  });

  test('does not require cross-worker timestamp order and refuses absent ingress route', () => {
    // Accounting is published after SAB admission: a receiver can run before
    // its producer records that admission. Identity, not timestamp, owns this join.
    expect(summarizeDisplayIngressRoutes([received(), ingress({ atMs: 12 })]).complete).toBe(true);
    expect(() =>
      summarizeDisplayIngressRoutes([ingress({ ingressRoute: null }), received()]),
    ).toThrow('exact route');
  });
});
