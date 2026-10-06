import { describe, expect, test } from 'bun:test';
import { treaty } from '@elysia/eden';
import {
  daemonBodyDigest,
  daemonHttpTranscript,
  deriveSessionAuthorizationKeyPair,
  deriveSoftwareDaemonP256PublicKey,
  parseDaemonHttpProof,
  signDaemonProof,
  verifyDaemonProof,
} from '@merkur/auth';
import type { App } from '@merkur/server';
import { Effect } from 'effect';

import { createDaemonFetch } from './daemon-fetch';

const seed = Buffer.alloc(32, 0x22);
const publicKey = Buffer.from(deriveSessionAuthorizationKeyPair(seed).verifyKey).toString(
  'base64url',
);

describe('daemon request signing', () => {
  test('signs Eden JSON and OTLP text after serialization and refuses redirects', async () => {
    const received: string[] = [];
    const nonces = new Set<string>();
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const body = new Uint8Array(await request.arrayBuffer());
        const proof = parseDaemonHttpProof(request.headers, Date.now());
        if (proof === null) return new Response('missing proof', { status: 401 });
        const transcript = daemonHttpTranscript(
          proof,
          request.method,
          request.url,
          request.headers.get('content-type') ?? '',
          daemonBodyDigest(body),
        );
        if (
          !verifyDaemonProof(
            publicKey,
            Buffer.from(deriveSoftwareDaemonP256PublicKey(seed)).toString('base64url'),
            'http',
            transcript,
            proof.signature,
            proof.p256Signature,
          )
        )
          return new Response('invalid proof', { status: 401 });
        nonces.add(proof.nonce);
        received.push(new TextDecoder().decode(body));
        if (new URL(request.url).search !== '') return Response.redirect('https://other.test/');
        return Response.json({ ok: true });
      },
    });
    const origin = `http://localhost:${server.port}`;
    const signedFetch = createDaemonFetch(
      {
        server_origin: origin,
        daemon_id: 'daemon-1',
      },
      {
        signEffect: (purpose, transcript) =>
          Effect.sync(() => signDaemonProof(seed.toString('base64url'), purpose, transcript)),
      },
    );
    try {
      const client = treaty<App>(origin, { fetcher: signedFetch });
      expect((await client.api.daemon['terminal-bell'].post({ occurredAt: 1 })).error).toBeNull();
      const otlp = '{ "resourceSpans": [] }';
      expect(
        (
          await signedFetch(`${origin}/api/daemon/traces`, {
            method: 'POST',
            body: otlp,
            headers: { 'content-type': 'application/json' },
          })
        ).status,
      ).toBe(200);
      expect(received).toEqual([JSON.stringify({ occurredAt: 1 }), otlp]);
      expect(nonces.size).toBe(2);
      await expect(
        signedFetch(`${origin}/api/daemon/perf?redirect=1`, { method: 'POST', body: '{}' }),
      ).rejects.toThrow();
      await expect(
        signedFetch('https://other.test/api/daemon/perf', { method: 'POST', body: '{}' }),
      ).rejects.toThrow('Invalid daemon request destination');
      await expect(
        signedFetch(`${origin}/api/sessions/request`, { method: 'POST', body: '{}' }),
      ).rejects.toThrow('Invalid daemon request destination');
      expect(received).toHaveLength(3);
    } finally {
      await server.stop(true);
    }
  });
});
