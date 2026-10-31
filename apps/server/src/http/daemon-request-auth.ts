import {
  DAEMON_PROOF_REPLAY_TTL_MS,
  daemonBodyDigest,
  daemonHttpTranscript,
  MAX_DAEMON_HTTP_BODY_BYTES,
  parseDaemonHttpProof,
} from '@merkur/auth';
import { Clock, Effect } from 'effect';
import { ParseError } from 'elysia';
import { ServerConfigService } from '../config';
import type { Logger } from '../logger';
import { UnauthorizedRequestError } from '../middleware/authenticated-user';
import type { runServerProgram } from '../runtime';
import { DeviceServiceTag } from '../services/device-service';
import { enforceRateLimitFailClosed, RateLimitServiceTag } from '../services/rate-limit-service';
import { RedisServiceTag } from '../services/redis-service';
import { runLoggedEffect } from './effect-route';

interface DaemonIdentity {
  readonly daemonId: string;
  readonly userId: string;
}

const requestIdentities = new WeakMap<Request, DaemonIdentity>();
const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

/** Read once, with a byte bound even for chunked requests, before schema parsing. */
async function readDaemonBody(request: Request): Promise<Uint8Array> {
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader !== undefined) {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_DAEMON_HTTP_BODY_BYTES) {
          await reader.cancel();
          throw new Error('Daemon request is too large');
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
  }
  return chunks.length === 1 && chunks[0] !== undefined ? chunks[0] : Buffer.concat(chunks, size);
}

/** With automatic parsing disabled, authenticate before decoding or schema validation. */
export function createDaemonRequestAuth(runProgram: typeof runServerProgram, logger: Logger) {
  async function readAuthenticatedText(request: Request): Promise<string> {
    const bytes = await runLoggedEffect(runProgram, authorizeDaemonRequestEffect(request), {
      logger,
      eventName: 'daemon_authorize_failed',
      request,
      signal: request.signal,
    });
    // An invalid proof is a successful null return from the verifier, not an
    // Effect failure. Record the refusal independently of sampled route spans.
    if (bytes === null) {
      logger.warn('daemon_http_authentication_rejected');
      throw new UnauthorizedRequestError();
    }
    return utf8Decoder.decode(bytes);
  }

  return {
    async json(context: { request: Request; body: unknown }): Promise<void> {
      context.body = JSON.parse(await readAuthenticatedText(context.request));
    },
    async text(context: { request: Request; body: unknown }): Promise<void> {
      context.body = await readAuthenticatedText(context.request);
    },
  };
}

export function authorizeDaemonRequest(request: Request): DaemonIdentity | null {
  const identity = requestIdentities.get(request) ?? null;
  requestIdentities.delete(request);
  return identity;
}

const authorizeDaemonRequestEffect = Effect.fnUntraced(function* (request: Request) {
  const now = yield* Clock.currentTimeMillis;
  const proof = parseDaemonHttpProof(request.headers, now);
  if (proof === null) return null;
  const bytes = yield* Effect.tryPromise({
    try: () => readDaemonBody(request),
    catch: (cause) => new ParseError(cause instanceof Error ? cause : undefined),
  });
  const bodyDigest = daemonBodyDigest(bytes);
  const limits = yield* RateLimitServiceTag;
  yield* enforceRateLimitFailClosed(limits, [
    { key: `daemon-proof:${proof.daemonId}`, limit: 120, windowMs: 60_000 },
  ]);
  const config = yield* ServerConfigService;
  const incoming = new URL(request.url);
  // The configured public origin is authoritative behind a reverse proxy.
  // Host and forwarded headers cannot select a different signature audience.
  const destination = `${config.publicOrigin}${incoming.pathname}${incoming.search}`;
  const transcript = daemonHttpTranscript(
    proof,
    request.method,
    destination,
    request.headers.get('content-type') ?? '',
    bodyDigest,
  );
  const devices = yield* DeviceServiceTag;
  const identity = yield* devices.authenticateDaemonProof(
    proof.daemonId,
    transcript,
    proof.signature,
    'http',
    proof.p256Signature,
  );
  if (identity === null) return null;
  const redis = yield* RedisServiceTag;
  const claimed = yield* redis.useCommands((client) =>
    client.sendCommand([
      'SET',
      `merkur:daemon-proof:${proof.daemonId}:${proof.nonce}`,
      '1',
      'NX',
      'PX',
      String(DAEMON_PROOF_REPLAY_TTL_MS),
    ]),
  );
  const completedAt = yield* Clock.currentTimeMillis;
  if (claimed !== 'OK' || parseDaemonHttpProof(request.headers, completedAt) === null) return null;
  requestIdentities.set(request, identity);
  return bytes;
});
