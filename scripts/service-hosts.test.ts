import { describe, expect, test } from 'bun:test';

import {
  type AppHost,
  loadServiceHosts,
  parseServiceHosts,
  renderEdgeEnvironment,
  renderStunEnvironment,
  type ServiceHost,
  stunServers,
} from './service-hosts';

const NBG: ServiceHost = {
  name: 'nbg-1',
  address: '46.225.209.73',
  sshHostKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHpfBkiT/GCaZEG7+QmvERioRt39+N+3k5it5l/fQolH',
  interface: 'eth0',
  edge: {
    edgeId: 'nbg-1',
    region: 'nbg',
    publicUrl: 'https://46.225.209.73:4433',
    egressRateMbit: 1000,
    egressBudgetGB: 19456,
    signalingReserveGB: 512,
  },
  stun: {
    addresses: ['46.225.209.73', '2a01:4f8:1c18:1eed::10', '2a01:4f8:1c18:1eed::11'],
    ports: [3478, 3479, 3480],
    changePorts: [3481],
  },
};

const ASH: ServiceHost = {
  ...NBG,
  name: 'ash-1',
  address: '198.51.100.7',
  edge: { ...NBG.edge, edgeId: 'ash-1', region: 'ash', publicUrl: 'https://198.51.100.7:4433' },
  stun: { ...NBG.stun, addresses: ['198.51.100.7', '2001:db8::10', '2001:db8::11'] },
};

const APP: AppHost = {
  name: 'app-1',
  address: '203.0.113.9',
  sshHostKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGECP9BCHWh6gTCPnKMCwY3030Nc7jKkBrtcTC52XMVI',
};

function manifest(...hosts: readonly object[]): string {
  return JSON.stringify({ hosts, app: APP });
}

describe('parseServiceHosts', () => {
  test('accepts a host and keeps its fields', () => {
    expect(parseServiceHosts(manifest(NBG))).toEqual({ hosts: [NBG], app: APP });
  });

  test('rejects an empty or malformed manifest', () => {
    expect(() => parseServiceHosts('{}')).toThrow('Missing key\n  at ["hosts"]');
    expect(() => parseServiceHosts(JSON.stringify({ hosts: [NBG] }))).toThrow(
      'Missing key\n  at ["app"]',
    );
    expect(() => parseServiceHosts(manifest())).toThrow('Missing key\n  at ["hosts"][0]');
    expect(() => parseServiceHosts('[')).toThrow(/JSON/);
  });

  test('rejects an unknown field at every level, so a typo is never silently dropped', () => {
    expect(() => parseServiceHosts(manifest({ ...NBG, size: 'cx23' }))).toThrow(
      'Expected no excess property\n  at ["hosts"][0]["size"]',
    );
    expect(() =>
      parseServiceHosts(manifest({ ...NBG, edge: { ...NBG.edge, ...{ vmMemory: '4gb' } } })),
    ).toThrow('Expected no excess property\n  at ["hosts"][0]["edge"]["vmMemory"]');
    expect(() =>
      parseServiceHosts(manifest({ ...NBG, stun: { ...NBG.stun, ...{ bind: [] } } })),
    ).toThrow('Expected no excess property\n  at ["hosts"][0]["stun"]["bind"]');
  });

  test('pins an ed25519 host key and an IPv4 address', () => {
    expect(() => parseServiceHosts(manifest({ ...NBG, sshHostKey: 'ssh-rsa AAAA' }))).toThrow(
      /ssh-ed25519/,
    );
    expect(() => parseServiceHosts(manifest({ ...NBG, address: 'nbg.example' }))).toThrow(
      /IPv4 literal/,
    );
  });

  test('requires an integer egress ceiling in range', () => {
    for (const egressRateMbit of [undefined, 0, -1, 1.5, '200', 10_001]) {
      expect(() =>
        parseServiceHosts(manifest({ ...NBG, edge: { ...NBG.edge, ...{ egressRateMbit } } })),
      ).toThrow(/egressRateMbit/);
    }
  });

  test('requires positive integer monthly budgets', () => {
    for (const field of ['egressBudgetGB', 'signalingReserveGB']) {
      for (const value of [undefined, 0, -1, 1.5, '100', Number.MAX_SAFE_INTEGER]) {
        expect(() =>
          parseServiceHosts(manifest({ ...NBG, edge: { ...NBG.edge, ...{ [field]: value } } })),
        ).toThrow(field);
      }
    }
  });

  test('rejects a combined budget that overflows the ledger', () => {
    expect(() =>
      parseServiceHosts(
        manifest({
          ...NBG,
          edge: { ...NBG.edge, ...{ egressBudgetGB: 17_179_869_183, signalingReserveGB: 1 } },
        }),
      ),
    ).toThrow('combined egress budget');
  });

  test('rejects a region the server cannot zone', () => {
    expect(() =>
      parseServiceHosts(manifest({ ...NBG, edge: { ...NBG.edge, ...{ region: 'zzz' } } })),
    ).toThrow(/ZONE_BY_EDGE_REGION/);
  });

  test('rejects a public URL that is not canonical on the listen port', () => {
    for (const publicUrl of [
      'http://46.225.209.73:4433',
      'https://46.225.209.73',
      'https://46.225.209.73:443',
      'https://46.225.209.73:4433/relay',
      'https://user@46.225.209.73:4433',
    ]) {
      expect(() =>
        parseServiceHosts(manifest({ ...NBG, edge: { ...NBG.edge, ...{ publicUrl } } })),
      ).toThrow(/publicUrl/);
    }
  });

  test('accepts a DNS name, so an edge is not pinned to an address literal', () => {
    // The browser pins the certificate hash rather than the name.
    const named = {
      ...NBG,
      edge: { ...NBG.edge, ...{ publicUrl: 'https://nbg-1.edge.example.com:4433' } },
    };
    expect(parseServiceHosts(manifest(named)).hosts[0]?.edge.publicUrl).toBe(
      'https://nbg-1.edge.example.com:4433',
    );
  });

  test('requires the host IPv4 and two distinct IPv6 addresses for STUN', () => {
    for (const addresses of [
      ['46.225.209.73'],
      ['198.51.100.7', '2001:db8::10', '2001:db8::11'],
      ['46.225.209.73', '2001:db8::10', '2001:db8::10'],
      ['46.225.209.73', '198.51.100.7', '2001:db8::11'],
    ]) {
      expect(() =>
        parseServiceHosts(manifest({ ...NBG, stun: { ...NBG.stun, ...{ addresses } } })),
      ).toThrow(/addresses/);
    }
  });

  test('keeps observer and change-only ports apart', () => {
    expect(() =>
      parseServiceHosts(manifest({ ...NBG, stun: { ...NBG.stun, ...{ changePorts: [3478] } } })),
    ).toThrow(/both an observer and a change-only port/);
    expect(() =>
      parseServiceHosts(manifest({ ...NBG, stun: { ...NBG.stun, ...{ ports: [] } } })),
    ).toThrow('Missing key\n  at ["hosts"][0]["stun"]["ports"][0]');
    expect(() =>
      parseServiceHosts(manifest({ ...NBG, stun: { ...NBG.stun, ...{ ports: [3478, 3478] } } })),
    ).toThrow(/repeats a port/);
  });

  test('rejects two hosts sharing a name, an address, an edge id, or a URL', () => {
    expect(parseServiceHosts(manifest(NBG, ASH)).hosts).toHaveLength(2);
    expect(() => parseServiceHosts(manifest(NBG, { ...ASH, name: NBG.name }))).toThrow(
      /duplicate name/,
    );
    expect(() =>
      parseServiceHosts(
        manifest(NBG, {
          ...ASH,
          address: NBG.address,
          stun: { ...ASH.stun, addresses: NBG.stun.addresses },
        }),
      ),
    ).toThrow(/duplicate address/);
    expect(() =>
      parseServiceHosts(manifest(NBG, { ...ASH, edge: { ...ASH.edge, edgeId: 'nbg-1' } })),
    ).toThrow(/duplicate edgeId/);
    expect(() =>
      parseServiceHosts(
        manifest(NBG, { ...ASH, edge: { ...ASH.edge, publicUrl: NBG.edge.publicUrl } }),
      ),
    ).toThrow(/duplicate publicUrl/);
  });

  test('pins the app host and keeps it apart from the service hosts', () => {
    const app = (fields: Readonly<Record<string, string>>) =>
      JSON.stringify({ hosts: [NBG], app: { ...APP, ...fields } });
    expect(() => parseServiceHosts(app({ sshHostKey: 'ssh-rsa AAAA' }))).toThrow(/ssh-ed25519/);
    expect(() => parseServiceHosts(app({ address: 'app.example' }))).toThrow(/IPv4 literal/);
    expect(() => parseServiceHosts(app({ name: NBG.name }))).toThrow(/duplicate name/);
    expect(() => parseServiceHosts(app({ address: NBG.address }))).toThrow(/duplicate address/);
    expect(() => parseServiceHosts(app({ role: 'server' }))).toThrow(
      'Expected no excess property\n  at ["app"]["role"]',
    );
  });
});

describe('rendered environments', () => {
  const edge = renderEdgeEnvironment(NBG, 'v0.74.2', 'https://app.merkur.sh');
  const stun = renderStunEnvironment(NBG);

  test('carry the edge identity the registry claims', () => {
    expect(edge).toContain('MERKUR_EDGE_ID=nbg-1\n');
    expect(edge).toContain('MERKUR_EDGE_REGION=nbg\n');
    expect(edge).toContain('MERKUR_EDGE_PUBLIC_URL=https://46.225.209.73:4433\n');
    expect(edge).toContain('MERKUR_EDGE_REGISTER_URL=https://app.merkur.sh/api/edge/register\n');
    expect(edge).toContain('MERKUR_EDGE_IDENTITY_DIR=/var/lib/merkur-edge/identity\n');
  });

  test('hand the egress cap and the ledger their limits', () => {
    expect(edge).toContain('MERKUR_EDGE_EGRESS_INTERFACE=eth0\n');
    expect(edge).toContain('MERKUR_EDGE_EGRESS_RATE_MBIT=1000\n');
    expect(edge).toContain('MERKUR_EDGE_DATA_BUDGET_GB=19456\n');
    expect(edge).toContain('MERKUR_EDGE_SIGNALING_RESERVE_GB=512\n');
  });

  test('take the version from the release and refuse anything else', () => {
    expect(edge).toContain('MERKUR_VERSION=v0.74.2\n');
    expect(() => renderEdgeEnvironment(NBG, '0.74.2', 'https://app.merkur.sh')).toThrow(
      /release version/,
    );
    expect(() => renderEdgeEnvironment(NBG, 'v0.74.2', 'https://app.merkur.sh/x')).toThrow(
      /canonical HTTPS origin/,
    );
  });

  test('never carry a secret', () => {
    for (const secret of ['TICKET_KEY', 'REGISTRATION_KEY', 'OTLP_TOKEN']) {
      expect(edge).not.toContain(secret);
      expect(stun).not.toContain(secret);
    }
  });

  test('bind STUN on every address and add the IPv6 pair to the interface', () => {
    expect(stun).toContain(
      'MERKUR_STUN_BIND=46.225.209.73,2a01:4f8:1c18:1eed::10,2a01:4f8:1c18:1eed::11\n',
    );
    expect(stun).toContain('MERKUR_STUN_PORTS=3478,3479,3480\n');
    expect(stun).toContain('MERKUR_STUN_CHANGE_PORTS=3481\n');
    expect(stun).toContain('MERKUR_STUN_ADDR_A=2a01:4f8:1c18:1eed::10/64\n');
    expect(stun).toContain('MERKUR_STUN_ADDR_B=2a01:4f8:1c18:1eed::11/64\n');
  });

  test('list the IPv4 observer ports and one bracketed observer per IPv6 address', () => {
    expect(stunServers([NBG]).split(',')).toEqual([
      '46.225.209.73:3478',
      '46.225.209.73:3479',
      '46.225.209.73:3480',
      '[2a01:4f8:1c18:1eed::10]:3478',
      '[2a01:4f8:1c18:1eed::11]:3478',
    ]);
  });
});

describe('the committed manifest', () => {
  test('parses, and every host renders', () => {
    const { hosts } = loadServiceHosts();
    expect(hosts.length).toBeGreaterThan(0);
    for (const host of hosts) {
      expect(renderEdgeEnvironment(host, 'v0.0.0', 'https://app.merkur.sh')).toContain(
        `MERKUR_EDGE_ID=${host.edge.edgeId}\n`,
      );
      expect(renderStunEnvironment(host)).toContain(`MERKUR_STUN_IFACE=${host.interface}\n`);
    }
  });
});
