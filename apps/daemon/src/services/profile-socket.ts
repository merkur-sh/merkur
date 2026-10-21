/**
 * `merkur profile`'s channel to the running daemon: an owner-only Unix socket serving the
 * native trace commands. Each connection carries one newline-terminated JSON request and
 * receives one JSON reply line. The dataplane writes captures; nothing here reads them.
 */
import { chmod, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { Clock, Effect, Option, Schema } from 'effect';
import { daemonProfileSocketPath, daemonProfilesPath } from '../config';
import { logEffect } from '../logger';
import type { DataplaneClient } from './dataplane-client';

/** Resource bound: one request is a short JSON object. */
const MAX_REQUEST_BYTES = 4 * 1024;

const ProfileRequestSchema = Schema.Union([
  Schema.Struct({ op: Schema.Literal('sessions') }),
  Schema.Struct({ op: Schema.Literal('start'), sessionId: Schema.NonEmptyString }),
  Schema.Struct({ op: Schema.Literal('capture') }),
  Schema.Struct({ op: Schema.Literal('end') }),
]);

export type ProfileRequest = typeof ProfileRequestSchema.Type;

/** The socket's replies, which `merkur profile` decodes against the same schema. */
export const ProfileReplySchema = Schema.Union([
  Schema.Struct({
    ok: Schema.Literal(true),
    sessions: Schema.Array(
      Schema.Struct({
        sessionId: Schema.String,
        peerId: Schema.String,
        inputMsAgo: Schema.NullOr(Schema.Int),
      }),
    ),
    dataplanePid: Schema.NullOr(Schema.Int),
  }),
  Schema.Struct({ ok: Schema.Literal(true), path: Schema.String }),
  Schema.Struct({ ok: Schema.Literal(true) }),
  Schema.Struct({ ok: Schema.Literal(false), reason: Schema.String }),
]);

export type ProfileReply = typeof ProfileReplySchema.Type;

/** Exact shapes only: a surplus key rejects the request. */
const EXACT = { onExcessProperty: 'error' } as const;
const decodeRequestLine = Schema.decodeUnknownOption(
  Schema.fromJsonString(ProfileRequestSchema),
  EXACT,
);

/** One request line as JSON; `null` for anything but the four requests. */
export function decodeProfileRequest(line: string): ProfileRequest | null {
  return Option.getOrNull(decodeRequestLine(line));
}

let profileCommandSequence = 0;

/** Runs one request against the dataplane; every failure is a reply, never a throw. */
export const handleProfileRequest = Effect.fn('daemon.profile_request')(function* (
  request: ProfileRequest,
  daemonId: string,
  dataplaneClient: DataplaneClient,
) {
  const requestedAtMs = yield* Clock.currentTimeMillis;
  const commandId = `profile-${request.op}-${requestedAtMs}-${++profileCommandSequence}`;
  if (request.op === 'sessions') {
    const result = yield* dataplaneClient.profileSessionsEffect(commandId);
    return result.status === 'accepted'
      ? ({
          ok: true,
          sessions: result.sessions,
          dataplanePid: dataplaneClient.dataplanePid(),
        } satisfies ProfileReply)
      : ({ ok: false, reason: result.reason } satisfies ProfileReply);
  }
  if (request.op === 'start' || request.op === 'end') {
    const result =
      request.op === 'start'
        ? yield* dataplaneClient.profileStartEffect(commandId, request.sessionId)
        : yield* dataplaneClient.profileEndEffect(commandId);
    return result.status === 'accepted'
      ? ({ ok: true } satisfies ProfileReply)
      : ({ ok: false, reason: result.reason } satisfies ProfileReply);
  }
  const directory = daemonProfilesPath();
  const capturePath = path.join(directory, `${commandId}.mtrace`);
  yield* Effect.tryPromise(() => mkdir(directory, { recursive: true, mode: 0o700 }));
  const result = yield* dataplaneClient.capturePerfTraceEffect(commandId, capturePath);
  const captureCompletedAtMs = yield* Clock.currentTimeMillis;
  if (result.status !== 'accepted') {
    yield* logEffect('error', 'daemon', 'daemon_perf_trace_capture_failed', {
      daemonId,
      commandId,
      captureRequestedAtMs: requestedAtMs,
      captureCompletedAtMs,
      reason: result.reason,
    });
    return { ok: false, reason: result.reason } satisfies ProfileReply;
  }
  yield* logEffect('info', 'daemon', 'daemon_perf_trace_capture_complete', {
    daemonId,
    commandId,
    captureRequestedAtMs: requestedAtMs,
    captureCompletedAtMs,
    path: capturePath,
  });
  return { ok: true, path: capturePath } satisfies ProfileReply;
});

/** Serves the socket for the daemon's lifetime; the scope closes and removes it. */
export const serveProfileSocketScoped = Effect.fn('daemon.profile_socket')(function* (
  daemonId: string,
  dataplaneClient: DataplaneClient,
) {
  const socketPath = daemonProfileSocketPath();
  // The instance lock admits one daemon per home, so a file here is a dead daemon's.
  yield* Effect.tryPromise(() => rm(socketPath, { force: true }));
  const reply = (socket: Bun.Socket<{ buffer: string }>, value: ProfileReply) => {
    socket.end(`${JSON.stringify(value)}\n`);
  };
  yield* Effect.acquireRelease(
    Effect.try(() =>
      Bun.listen<{ buffer: string }>({
        unix: socketPath,
        socket: {
          open(socket) {
            socket.data = { buffer: '' };
          },
          data(socket, chunk) {
            socket.data.buffer += chunk.toString('utf8');
            if (socket.data.buffer.length > MAX_REQUEST_BYTES) {
              reply(socket, { ok: false, reason: 'request_too_large' });
              return;
            }
            const end = socket.data.buffer.indexOf('\n');
            if (end < 0) return;
            const request = decodeProfileRequest(socket.data.buffer.slice(0, end));
            if (request === null) {
              reply(socket, { ok: false, reason: 'invalid_request' });
              return;
            }
            // A socket callback is a runtime boundary: each request runs to its reply.
            void Effect.runPromise(
              handleProfileRequest(request, daemonId, dataplaneClient).pipe(
                Effect.catchCause(() =>
                  Effect.succeed({ ok: false, reason: 'daemon_error' } satisfies ProfileReply),
                ),
              ),
            ).then((value) => reply(socket, value));
          },
        },
      }),
    ),
    (listener) =>
      Effect.promise(async () => {
        listener.stop(true);
        await rm(socketPath, { force: true });
      }),
  );
  yield* Effect.tryPromise(() => chmod(socketPath, 0o600));
  yield* logEffect('info', 'daemon', 'daemon_profile_socket_ready', {
    daemonId,
    path: socketPath,
  });
});
