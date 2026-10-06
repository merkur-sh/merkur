import {
  createDaemonNonce,
  daemonControlTranscript,
  parseDaemonControlSignature,
} from '@merkur/auth';
import { MAX_DAEMON_CONTROL_FRAME_BYTES } from '@merkur/daemon-control-protocol';
import { Effect } from 'effect';
import { Elysia, status } from 'elysia';
import { websocket } from 'elysia/websocket';

import { errorLogContext, type Logger } from '../../logger';
import type { runServerProgram } from '../../runtime';
import {
  type ControlConnectionHandle,
  DAEMON_CONTROL_BACKPRESSURE_LIMIT_BYTES,
  DaemonControlServiceTag,
  type DaemonControlSocket,
  DaemonUnavailable,
} from '../../services/daemon-control-service';
import { DeviceServiceTag } from '../../services/device-service';
import { type IpZone, zoneForIp } from '../../services/ip-region';
import { enforceRateLimitFailClosed, RateLimitServiceTag } from '../../services/rate-limit-service';
import { resolveRateLimitSource } from '../client-ip';

const DAEMON_CONTROL_PATH = '/api/daemon/control';
const STATUS_UNAUTHORIZED = 401;
const STATUS_UPGRADE_REQUIRED = 426;
const STATUS_TOO_MANY_REQUESTS = 429;
const STATUS_SERVICE_UNAVAILABLE = 503;
const MAX_DAEMON_VERSION_CHARS = 128;
const AUTHENTICATION_TIMEOUT_MS = 5_000;
const MAX_PENDING_AUTHENTICATIONS = 1_024;
const DAEMON_RESUME_PRESENCE_HEADER = 'x-merkur-resume-presence';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// A linked daemon reconnects with backoff, so these only cap unauthenticated
// churn against signature verification. The daemon id is attacker-chosen, but
// keying on it still stops one identity from monopolising the check.
const UPGRADE_RATE_LIMIT_WINDOW_MS = 60_000;
const UPGRADE_IP_LIMIT = 60;
const UPGRADE_DAEMON_LIMIT = 30;

interface DaemonControlRoutesOptions {
  readonly runServerProgram: typeof runServerProgram;
  readonly logger: Logger;
  readonly publicOrigin: string;
  readonly trustedProxyHops: number;
}

export interface DaemonControlUpgradeCredentials {
  readonly daemonId: string;
  readonly daemonVersion: string;
  readonly resumePresenceId: string | null;
}

interface PendingAuthentication {
  readonly credentials: DaemonControlUpgradeCredentials;
  readonly zone: IpZone | null;
  readonly nonce: string;
  readonly deadline: number;
  readonly timer: ReturnType<typeof setTimeout>;
  consumed: boolean;
  closed: boolean;
}

export function daemonControlRoutesPlugin({
  runServerProgram,
  logger,
  publicOrigin,
  trustedProxyHops,
}: DaemonControlRoutesOptions) {
  const pending = new Map<Request, PendingAuthentication>();
  const connectionIdsByRequest = new WeakMap<Request, string>();
  const connectionHandlesByRequest = new WeakMap<Request, ControlConnectionHandle>();
  const secureControlOrigin = isSecureDaemonControlOrigin(publicOrigin);
  const controlUrl = new URL(DAEMON_CONTROL_PATH, publicOrigin).href;

  const retirePending = (request: Request): void => {
    const entry = pending.get(request);
    if (entry === undefined) return;
    entry.closed = true;
    clearTimeout(entry.timer);
    pending.delete(request);
  };
  const disconnect = async (connectionId: string, code: number | null): Promise<void> => {
    try {
      await runServerProgram(
        Effect.gen(function* () {
          const control = yield* DaemonControlServiceTag;
          yield* control.disconnect(connectionId, code);
        }),
      );
    } catch (error) {
      logger.warn('daemon_control_disconnect_failed', { connectionId, ...errorLogContext(error) });
    }
  };

  return (
    new Elysia({ name: 'daemon-control-routes' })
      .use(websocket())
      // Derive runs once at upgrade. beforeHandle also runs for every WS message,
      // which would charge authenticated commands against unauthenticated churn.
      .derive(async ({ request, server }) => {
        if (!secureControlOrigin) return status(STATUS_UPGRADE_REQUIRED, '');
        const credentials = parseDaemonControlUpgradeCredentials(request);
        if (credentials === null) return status(STATUS_UNAUTHORIZED, '');
        if (pending.size >= MAX_PENDING_AUTHENTICATIONS)
          return status(STATUS_SERVICE_UNAVAILABLE, '');
        const clientIp = resolveRateLimitSource(request, server, trustedProxyHops);
        try {
          const allowed = await runServerProgram(
            Effect.gen(function* () {
              const limits = yield* RateLimitServiceTag;
              return yield* enforceRateLimitFailClosed(limits, [
                {
                  key: `daemon-control:ip:${clientIp}`,
                  limit: UPGRADE_IP_LIMIT,
                  windowMs: UPGRADE_RATE_LIMIT_WINDOW_MS,
                },
                {
                  key: `daemon-control:daemon:${credentials.daemonId}`,
                  limit: UPGRADE_DAEMON_LIMIT,
                  windowMs: UPGRADE_RATE_LIMIT_WINDOW_MS,
                },
              ]).pipe(
                Effect.as(true),
                Effect.catchTag('RateLimitedError', () => Effect.succeed(false)),
              );
            }),
            { signal: request.signal },
          );
          if (!allowed) return status(STATUS_TOO_MANY_REQUESTS, '');
          return { daemonControlUpgrade: { credentials, zone: zoneForIp(clientIp) } };
        } catch {
          return status(STATUS_SERVICE_UNAVAILABLE, '');
        }
      })
      .ws(DAEMON_CONTROL_PATH, {
        maxPayloadLength: MAX_DAEMON_CONTROL_FRAME_BYTES,
        backpressureLimit: DAEMON_CONTROL_BACKPRESSURE_LIMIT_BYTES,
        closeOnBackpressureLimit: true,
        idleTimeout: 20,
        sendPings: false,
        perMessageDeflate: false,
        open(ws) {
          const upgrade = ws.daemonControlUpgrade;
          if (pending.size >= MAX_PENDING_AUTHENTICATIONS) {
            ws.close(1008, 'unauthorized');
            return;
          }
          const nonce = createDaemonNonce();
          const timer = setTimeout(() => {
            retirePending(ws.request);
            ws.close(1008, 'authentication_timeout');
          }, AUTHENTICATION_TIMEOUT_MS);
          pending.set(ws.request, {
            ...upgrade,
            nonce,
            timer,
            deadline: performance.now() + AUTHENTICATION_TIMEOUT_MS,
            consumed: false,
            closed: false,
          });
          // No presence claim, registered frame, STUN ticket or command precedes proof.
          if (ws.send(JSON.stringify({ type: 'auth_challenge', nonce })) <= 0) {
            retirePending(ws.request);
            ws.close(1008, 'authentication_failed');
          }
        },
        async message(ws, frame) {
          const entry = pending.get(ws.request);
          if (entry !== undefined && !connectionIdsByRequest.has(ws.request)) {
            if (entry.consumed || performance.now() >= entry.deadline) {
              retirePending(ws.request);
              ws.close(1008, 'unauthorized');
              return;
            }
            // Consume synchronously before yielding: concurrent copies get one attempt.
            entry.consumed = true;
            const signature = parseDaemonControlSignature(frame);
            if (signature === null) {
              retirePending(ws.request);
              ws.close(1008, 'unauthorized');
              return;
            }
            try {
              const { daemonId, daemonVersion, resumePresenceId } = entry.credentials;
              const transcript = daemonControlTranscript(
                daemonId,
                controlUrl,
                daemonVersion,
                resumePresenceId,
                entry.nonce,
              );
              const identity = await runServerProgram(
                Effect.gen(function* () {
                  const devices = yield* DeviceServiceTag;
                  return yield* devices.authenticateDaemonProof(
                    daemonId,
                    transcript,
                    signature.mldsa,
                    'control',
                    signature.p256,
                  );
                }),
              );
              if (entry.closed) return;
              if (
                identity === null ||
                identity.daemonId !== daemonId ||
                performance.now() >= entry.deadline
              ) {
                retirePending(ws.request);
                ws.close(1008, 'unauthorized');
                return;
              }
              const connectionId = crypto.randomUUID();
              const socket: DaemonControlSocket = {
                sendText: (payload) => ws.send(payload),
                close: (code, reason) => ws.close(code, reason),
              };
              connectionIdsByRequest.set(ws.request, connectionId);
              const handle = await runServerProgram(
                Effect.gen(function* () {
                  const control = yield* DaemonControlServiceTag;
                  return yield* control.acceptConnection({
                    ...identity,
                    daemonVersion,
                    resumePresenceId: resumePresenceId ?? undefined,
                    zone: entry.zone,
                    connectionId,
                    presenceId: crypto.randomUUID(),
                    socket,
                  });
                }),
              );
              if (entry.closed || performance.now() >= entry.deadline) {
                retirePending(ws.request);
                ws.close(1008, 'authentication_timeout');
                await disconnect(connectionId, null);
                return;
              }
              connectionHandlesByRequest.set(ws.request, handle);
              clearTimeout(entry.timer);
              pending.delete(ws.request);
            } catch (error) {
              retirePending(ws.request);
              logger.warn('daemon_control_authentication_failed', { ...errorLogContext(error) });
              ws.close(1008, 'authentication_failed');
            }
            return;
          }
          // Proof verification publishes the connection id before registration starts.
          // Registration awaits revocation acknowledgements after sending registered,
          // so receive must run concurrently with it. The service owns admission and
          // keeps session readiness gated on the completed revocation flush.
          try {
            const connectionId = connectionIdsByRequest.get(ws.request);
            if (connectionId === undefined) {
              ws.close(1008, 'connection_not_registered');
              return;
            }
            await runServerProgram(
              Effect.gen(function* () {
                const control = yield* DaemonControlServiceTag;
                yield* control.receive(connectionId, frame);
              }),
            );
          } catch (error) {
            if (error instanceof DaemonUnavailable) ws.close(1008, 'connection_not_registered');
            logger.warn('daemon_control_message_failed', { ...errorLogContext(error) });
          }
        },
        // Each hook gets its own context view; the upgrade Request is the connection key.
        ping(ws) {
          connectionHandlesByRequest.get(ws.request)?.observePing();
        },
        async close(ws, code) {
          retirePending(ws.request);
          const connectionId = connectionIdsByRequest.get(ws.request);
          connectionIdsByRequest.delete(ws.request);
          connectionHandlesByRequest.delete(ws.request);
          if (connectionId !== undefined)
            await disconnect(connectionId, typeof code === 'number' ? code : null);
        },
      })
  );
}

export function parseDaemonControlUpgradeCredentials(
  request: Request,
): DaemonControlUpgradeCredentials | null {
  const url = new URL(request.url);
  if (
    url.pathname !== DAEMON_CONTROL_PATH ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== '' ||
    request.headers.has('authorization')
  )
    return null;
  const daemonId = request.headers.get('x-merkur-daemon-id');
  const daemonVersion = request.headers.get('x-merkur-version');
  if (
    daemonId === null ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(daemonId) ||
    daemonVersion === null ||
    daemonVersion.length === 0 ||
    daemonVersion.length > MAX_DAEMON_VERSION_CHARS ||
    containsControlCharacter(daemonVersion)
  )
    return null;
  const resumePresenceId = request.headers.get(DAEMON_RESUME_PRESENCE_HEADER);
  if (resumePresenceId !== null && !UUID_PATTERN.test(resumePresenceId)) return null;
  return { daemonId, daemonVersion, resumePresenceId };
}

export function isSecureDaemonControlOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    if (url.protocol === 'https:') return true;
    return url.protocol === 'http:' && isLoopbackHostname(url.hostname);
  } catch {
    return false;
  }
}

function isLoopbackHostname(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '::1' || hostname === '[::1]') return true;
  const octets = hostname.split('.');
  return (
    octets.length === 4 &&
    octets[0] === '127' &&
    octets.every((octet) => /^(?:0|[1-9]\d{0,2})$/.test(octet) && Number(octet) <= 255)
  );
}

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const point = character.codePointAt(0);
    if (point !== undefined && (point <= 0x1f || point === 0x7f)) return true;
  }
  return false;
}
