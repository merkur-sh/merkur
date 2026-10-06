import { daemonHttpProofHeaders, MAX_DAEMON_HTTP_BODY_BYTES } from '@merkur/auth';
import type { DaemonConfig } from '@merkur/config';
import { Effect } from 'effect';
import type { DaemonProofSigner } from './daemon-proof-signer';

const PATHS = new Set(['/api/daemon/perf', '/api/daemon/traces', '/api/daemon/terminal-bell']);

/** Sign the serialized request, after Eden/OTLP have produced its exact bytes. */
export function createDaemonFetch(
  config: Pick<DaemonConfig, 'daemon_id' | 'server_origin'>,
  signer: DaemonProofSigner,
): typeof globalThis.fetch {
  return Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (
        url.origin !== config.server_origin ||
        !PATHS.has(url.pathname) ||
        request.method !== 'POST'
      ) {
        throw new Error('Invalid daemon request destination');
      }
      const body = new Uint8Array(await request.arrayBuffer());
      if (body.byteLength > MAX_DAEMON_HTTP_BODY_BYTES)
        throw new Error('Daemon request is too large');
      const headers = new Headers(request.headers);
      headers.delete('authorization');
      if (headers.has('content-encoding')) throw new Error('Encoded daemon request is unsupported');
      const proof = await daemonHttpProofHeaders(
        config.daemon_id,
        (transcript) =>
          Effect.runPromise(signer.signEffect('http', transcript), { signal: request.signal }),
        request.method,
        request.url,
        headers.get('content-type') ?? '',
        body,
        Date.now(),
      );
      for (const [key, value] of Object.entries(proof)) headers.set(key, value);
      return globalThis.fetch(new Request(request, { body, headers, redirect: 'error' }));
    },
    { preconnect: globalThis.fetch.preconnect },
  );
}
