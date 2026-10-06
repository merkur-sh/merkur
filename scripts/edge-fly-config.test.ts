import { describe, expect, test } from 'bun:test';

import {
  type EdgeReplica,
  loadReplicas,
  parseReplicaManifest,
  renderEdgeFlyConfig,
} from './edge-fly-config';

const FRA: EdgeReplica = {
  edgeId: 'fra-1',
  app: 'mercury-edge-tntcl',
  region: 'fra',
  publicUrl: 'https://37.16.4.174:4433',
  egressRateMbit: 200,
  egressBudgetGB: 2400,
  signalingReserveGB: 100,
};

function manifest(...replicas: readonly object[]): string {
  return JSON.stringify({ replicas });
}

describe('parseReplicaManifest', () => {
  test('accepts a replica and keeps its fields', () => {
    expect(parseReplicaManifest(manifest(FRA))).toEqual([FRA]);
  });

  test('rejects an empty or malformed manifest', () => {
    expect(() => parseReplicaManifest('{}')).toThrow(/non-empty/);
    expect(() => parseReplicaManifest(manifest())).toThrow(/non-empty/);
    expect(() => parseReplicaManifest('[')).toThrow(/not valid JSON/);
  });

  test('rejects an unknown field, so a typo is never silently dropped', () => {
    expect(() => parseReplicaManifest(manifest({ ...FRA, vmMemory: '4gb' }))).toThrow(
      /unknown replica field `vmMemory`/,
    );
  });

  test('requires an integer egress ceiling in range', () => {
    const { egressRateMbit: _, ...uncapped } = FRA;
    expect(() => parseReplicaManifest(manifest(uncapped))).toThrow(/egressRateMbit/);
    for (const egressRateMbit of [0, -1, 1.5, '200', 10_001]) {
      expect(() => parseReplicaManifest(manifest({ ...FRA, egressRateMbit }))).toThrow(
        /egressRateMbit/,
      );
    }
  });

  test('requires positive integer monthly budgets', () => {
    for (const field of ['egressBudgetGB', 'signalingReserveGB']) {
      for (const value of [undefined, 0, -1, 1.5, '100', Number.MAX_SAFE_INTEGER]) {
        expect(() => parseReplicaManifest(manifest({ ...FRA, [field]: value }))).toThrow(field);
      }
    }
  });

  test('rejects a combined budget that overflows the ledger', () => {
    expect(() =>
      parseReplicaManifest(
        manifest({
          ...FRA,
          egressBudgetGB: 17_179_869_183,
          signalingReserveGB: 1,
        }),
      ),
    ).toThrow('combined egress budget');
  });

  test('rejects a region the server cannot zone', () => {
    expect(() => parseReplicaManifest(manifest({ ...FRA, region: 'zzz' }))).toThrow(
      /ZONE_BY_FLY_REGION/,
    );
  });

  test('rejects a public URL that is not canonical on the listen port', () => {
    const bad = [
      'http://37.16.4.174:4433',
      'https://37.16.4.174',
      'https://37.16.4.174:443',
      'https://37.16.4.174:4433/relay',
      'https://user@37.16.4.174:4433',
    ];
    for (const publicUrl of bad) {
      expect(() => parseReplicaManifest(manifest({ ...FRA, publicUrl }))).toThrow(/publicUrl/);
    }
  });

  test('accepts a DNS name, so a replica is not pinned to an address literal', () => {
    // `normalizeEdgeWebTransportUrl` (packages/shared/src/edge-webtransport.ts)
    // accepts any https host, and the browser pins the certificate hash rather
    // than the name, so a record pointing at the replica's anycast address
    // survives the address changing under it.
    const named = { ...FRA, publicUrl: 'https://fra-1.edge.example.com:4433' };
    expect(parseReplicaManifest(manifest(named))).toEqual([named]);
  });

  test('rejects two replicas sharing an id, an app, or a URL', () => {
    const iad: EdgeReplica = {
      edgeId: 'iad-1',
      app: 'merkur-edge-iad',
      region: 'iad',
      publicUrl: 'https://198.51.100.7:4433',
      egressRateMbit: 200,
      egressBudgetGB: 2400,
      signalingReserveGB: 100,
    };
    expect(parseReplicaManifest(manifest(FRA, iad))).toHaveLength(2);
    expect(() => parseReplicaManifest(manifest(FRA, { ...iad, edgeId: FRA.edgeId }))).toThrow(
      /duplicate edgeId/,
    );
    expect(() => parseReplicaManifest(manifest(FRA, { ...iad, app: FRA.app }))).toThrow(
      /duplicate app/,
    );
    expect(() => parseReplicaManifest(manifest(FRA, { ...iad, publicUrl: FRA.publicUrl }))).toThrow(
      /duplicate publicUrl/,
    );
  });
});

describe('renderEdgeFlyConfig', () => {
  const rendered = renderEdgeFlyConfig(FRA, 'v0.60.2');

  test('carries the replica identity the registry claims', () => {
    expect(rendered).toContain('app = "mercury-edge-tntcl"');
    expect(rendered).toContain('primary_region = "fra"');
    expect(rendered).toContain('MERKUR_EDGE_ID = "fra-1"');
    expect(rendered).toContain('MERKUR_EDGE_REGION = "fra"');
    expect(rendered).toContain('MERKUR_EDGE_PUBLIC_URL = "https://37.16.4.174:4433"');
  });

  test('hands the entrypoint its egress ceiling', () => {
    expect(rendered).toContain('MERKUR_EDGE_DATA_BUDGET_GB = "2400"');
    expect(rendered).toContain('MERKUR_EDGE_SIGNALING_RESERVE_GB = "100"');
    expect(rendered).toContain('MERKUR_EDGE_EGRESS_INTERFACE = "eth0"');
    expect(rendered).toContain('MERKUR_EDGE_EGRESS_RATE_MBIT = "200"');
  });

  test('takes the version from the release, not from a committed literal', () => {
    expect(rendered).toContain('MERKUR_VERSION = "v0.60.2"');
    expect(renderEdgeFlyConfig(FRA, 'v1.0.0')).toContain('MERKUR_VERSION = "v1.0.0"');
    expect(() => renderEdgeFlyConfig(FRA, '0.60.2')).toThrow(/release version/);
  });

  test('states the running machine size instead of taking whatever Fly defaults to', () => {
    expect(rendered).toContain('[[vm]]');
    expect(rendered).toContain('size = "shared-cpu-1x"');
    expect(rendered).toContain('memory = "256mb"');
  });

  test('binds one UDP service on the port the public URL names', () => {
    expect(rendered).toContain('protocol = "udp"');
    expect(rendered).toContain('internal_port = 4433');
    expect(rendered).toContain('port = 4433');
  });

  test('marks itself generated so nobody edits or commits it', () => {
    expect(rendered.startsWith('# GENERATED by scripts/edge-fly-config.ts')).toBe(true);
  });
});

describe('the committed manifest', () => {
  test('parses, and every replica renders', () => {
    const replicas = loadReplicas();
    expect(replicas.length).toBeGreaterThan(0);
    for (const replica of replicas) {
      expect(renderEdgeFlyConfig(replica, 'v0.0.0')).toContain(
        `MERKUR_EDGE_ID = "${replica.edgeId}"`,
      );
    }
  });
});
