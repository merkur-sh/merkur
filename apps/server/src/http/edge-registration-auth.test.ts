import { describe, expect, test } from 'bun:test';

import {
  computeEdgeRegistrationAuthentication,
  EDGE_REGISTRATION_METHOD,
  EDGE_REGISTRATION_PATH,
  encodeCanonicalEdgeRegistration,
} from './edge-registration-auth';

describe('edge registration authentication wire contract', () => {
  test('matches the Rust publisher canonical payload and HMAC vector', () => {
    const payload = {
      edgeId: 'iad-1',
      edgeRegion: 'iad',
      edgeWtUrl: 'https://iad-1.edge.example:4433/',
      certHash: 'Qr4ZuCBq6NiQejuKBH9LF4gS6GICM00rGduNd31OVXw=',
      certHashes: [
        'Qr4ZuCBq6NiQejuKBH9LF4gS6GICM00rGduNd31OVXw=',
        'QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkI=',
      ],
    };
    expect(encodeCanonicalEdgeRegistration(payload).toString('utf8')).toBe(
      '{"edgeId":"iad-1","edgeRegion":"iad","edgeWtUrl":"https://iad-1.edge.example:4433/","certHash":"Qr4ZuCBq6NiQejuKBH9LF4gS6GICM00rGduNd31OVXw=","certHashes":["Qr4ZuCBq6NiQejuKBH9LF4gS6GICM00rGduNd31OVXw=","QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkI="]}',
    );
    expect(
      computeEdgeRegistrationAuthentication({
        key: new Uint8Array(64).fill(0x41),
        edgeId: 'iad-1',
        method: EDGE_REGISTRATION_METHOD,
        path: EDGE_REGISTRATION_PATH,
        timestamp: '1700000000123',
        nonce: new Uint8Array(32).fill(0x23),
        payload,
      }).toString('base64url'),
    ).toBe(
      'yCmTEqKiCF2b9r6dzTcD9w38ZsHGrpE9eyVsOaAjovLj5xTzxnWNrQ1jwMhiGQw4JhtM6C5-Sf0mneLPlJdnjA',
    );
  });
});
