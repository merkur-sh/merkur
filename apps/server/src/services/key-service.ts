import { Context, Data, Effect, Layer } from 'effect';
import { ServerConfigService } from '../config';
import { createLogger } from '../logger';
import {
  encodeRequest,
  OP_AUTH_START,
  OP_LOGIN_FINISH,
  OP_PUBLIC_KEYS,
  OP_REGISTRATION_RESPONSE,
  OP_SIGN_CAPABILITY,
  OP_VAPID_JWT,
  type RequestField,
  type ResponseReader,
  readResponse,
  STATUS_EXHAUSTED,
  STATUS_INVALID,
  STATUS_OK,
  STATUS_REFUSED,
  STATUS_UNAVAILABLE,
  takeFrames,
  textField,
} from './keyd-protocol';

const OPAQUE_PUBLIC_KEY_BYTES = 32;
const OPAQUE_REGISTRATION_REQUEST_BYTES = 32;
const OPAQUE_REGISTRATION_RESPONSE_BYTES = 64;
const OPAQUE_REGISTRATION_RECORD_BYTES = 192;
const OPAQUE_LOGIN_REQUEST_BYTES = 96;
const OPAQUE_LOGIN_RESPONSE_BYTES = 320;
const OPAQUE_LOGIN_STATE_BYTES = 128;
const OPAQUE_LOGIN_FINISH_BYTES = 64;
const CAPABILITY_PUBLIC_KEY_BYTES = 2_592;
const CAPABILITY_SIGNATURE_BYTES = 4_627;
const VAPID_PUBLIC_KEY_BYTES = 65;

/**
 * Why keyd did not do what was asked. `exhausted` is the account's attempt budget, spent;
 * `unreachable` is the socket, which fails every request in flight and reconnects on the next.
 */
export type KeyServiceFailure =
  | 'invalid'
  | 'exhausted'
  | 'refused'
  | 'unavailable'
  | 'internal'
  | 'unreachable';

export class KeyServiceError extends Data.TaggedError('KeyServiceError')<{
  readonly reason: KeyServiceFailure;
  readonly message: string;
  /** With `exhausted`: when the account's next attempt is allowed. */
  readonly retryAfterSeconds?: number;
}> {}

export interface KeydPublicKeys {
  /** Canonical base64url of the OPAQUE server's Ristretto255 key. */
  readonly opaque: string;
  /** Canonical base64url of the 2,592-byte ML-DSA-87 key daemons verify capabilities with. */
  readonly sessionCapability: string;
  /** Canonical base64url of the uncompressed P-256 VAPID key, or `null` without web push. */
  readonly vapid: string | null;
}

export interface KeydAuthStart {
  readonly serverLoginState: string;
  readonly loginResponse: string;
  readonly registrationResponse: string;
}

/**
 * `merkur-keyd`, which holds the OPAQUE server setup, the session-capability signing key and
 * the VAPID key. Every operation that needs one is a request here; no key reaches this process.
 * OPAQUE messages cross as the canonical base64url the routes carry.
 */
export interface KeyService {
  readonly publicKeys: KeydPublicKeys;
  /** One OPRF evaluation pair for a sign-in or sign-up start; spends the account's attempt. */
  authStart(input: {
    readonly userId: string;
    readonly serverIdentity: string;
    readonly registrationRecord: string | null;
    readonly startLoginRequest: string;
    readonly registrationRequest: string;
  }): Effect.Effect<KeydAuthStart, KeyServiceError>;
  /** A registration response for a reset's new password; spends the account's attempt. */
  registrationResponse(input: {
    readonly userId: string;
    readonly registrationRequest: string;
  }): Effect.Effect<string, KeyServiceError>;
  /** Whether the password was right; a right one hands the account's attempt back. */
  loginFinish(input: {
    readonly userId: string;
    readonly serverIdentity: string;
    readonly serverLoginState: string;
    readonly finishLoginRequest: string;
  }): Effect.Effect<boolean, KeyServiceError>;
  /** The ML-DSA-87 signature over a payload segment issued within keyd's skew of now. */
  signCapability(payloadSegment: string): Effect.Effect<Uint8Array, KeyServiceError>;
  /** An RFC 8292 VAPID JWT for one push service origin, and its expiry in Unix seconds. */
  vapidJwt(
    audience: string,
    subject: string,
  ): Effect.Effect<{ readonly jwt: string; readonly expiresAt: number }, KeyServiceError>;
}

export class KeyServiceTag extends Context.Service<KeyServiceTag, KeyService>()('KeyService') {}

export const KeyServiceLive = Layer.effect(
  KeyServiceTag,
  Effect.gen(function* () {
    const config = yield* ServerConfigService;
    const service = yield* connectKeyd(config.keydSocket);
    if (service.publicKeys.opaque !== config.opaqueServerPublicKey) {
      return yield* new KeyServiceError({
        reason: 'invalid',
        message: "keyd's OPAQUE key is not the one the web build pins",
      });
    }
    if ((service.publicKeys.vapid === null) !== (config.webPushContact === undefined)) {
      return yield* new KeyServiceError({
        reason: 'invalid',
        message: 'WEB_PUSH_CONTACT is set exactly when keyd holds a VAPID key',
      });
    }
    return service;
  }),
);

/**
 * keyd at `socketPath`, with no configuration to hold its keys to: the tests' and tools' layer.
 * The server's is `KeyServiceLive`.
 */
export const keydLayer = (socketPath: string) =>
  Layer.effect(KeyServiceTag, connectKeyd(socketPath));

/** One connection for the scope, and keyd's public keys read once over it. */
const connectKeyd = Effect.fnUntraced(function* (socketPath: string) {
  const connection = yield* Effect.acquireRelease(
    Effect.sync(() => createKeydConnection(socketPath)),
    (opened) => Effect.sync(() => opened.close()),
  );
  return yield* makeKeyService(connection);
});

/** The round trip one request makes: its framed bytes out, its response body back. */
interface KeydConnection {
  call(frame: Uint8Array): Promise<Uint8Array>;
  close(): void;
}

/** A service over `connection`, after reading keyd's public keys once. */
const makeKeyService = Effect.fnUntraced(function* (connection: KeydConnection) {
  const request = (op: number, fields: readonly RequestField[]) =>
    Effect.tryPromise({
      try: () => connection.call(encodeRequest(op, fields)),
      catch: (error) =>
        new KeyServiceError({
          reason: 'unreachable',
          message: error instanceof Error ? error.message : 'keyd is unreachable',
        }),
    }).pipe(Effect.flatMap(readStatus));

  const keys = yield* request(OP_PUBLIC_KEYS, []).pipe(
    Effect.flatMap((reader) =>
      read(() => {
        const opaque = exact(reader.bytes(), OPAQUE_PUBLIC_KEY_BYTES);
        const capability = exact(reader.bytes(), CAPABILITY_PUBLIC_KEY_BYTES);
        const vapid = reader.bytes();
        reader.end();
        return {
          opaque: encode(opaque),
          sessionCapability: encode(capability),
          vapid: vapid.byteLength === 0 ? null : encode(exact(vapid, VAPID_PUBLIC_KEY_BYTES)),
        } satisfies KeydPublicKeys;
      }),
    ),
  );

  return {
    publicKeys: keys,
    authStart: (input) =>
      Effect.gen(function* () {
        const fields = yield* canonical(() => [
          textField(input.userId),
          textField(input.serverIdentity),
          input.registrationRecord === null
            ? new Uint8Array(0)
            : decode(input.registrationRecord, OPAQUE_REGISTRATION_RECORD_BYTES),
          decode(input.startLoginRequest, OPAQUE_LOGIN_REQUEST_BYTES),
          decode(input.registrationRequest, OPAQUE_REGISTRATION_REQUEST_BYTES),
        ]);
        const reader = yield* request(OP_AUTH_START, fields);
        return yield* read(() => {
          const result = {
            serverLoginState: encode(exact(reader.bytes(), OPAQUE_LOGIN_STATE_BYTES)),
            loginResponse: encode(exact(reader.bytes(), OPAQUE_LOGIN_RESPONSE_BYTES)),
            registrationResponse: encode(exact(reader.bytes(), OPAQUE_REGISTRATION_RESPONSE_BYTES)),
          };
          reader.end();
          return result;
        });
      }),
    registrationResponse: (input) =>
      Effect.gen(function* () {
        const fields = yield* canonical(() => [
          textField(input.userId),
          decode(input.registrationRequest, OPAQUE_REGISTRATION_REQUEST_BYTES),
        ]);
        const reader = yield* request(OP_REGISTRATION_RESPONSE, fields);
        return yield* read(() => {
          const response = encode(exact(reader.bytes(), OPAQUE_REGISTRATION_RESPONSE_BYTES));
          reader.end();
          return response;
        });
      }),
    loginFinish: (input) =>
      Effect.gen(function* () {
        const fields = yield* canonical(() => [
          textField(input.userId),
          textField(input.serverIdentity),
          decode(input.serverLoginState, OPAQUE_LOGIN_STATE_BYTES),
          decode(input.finishLoginRequest, OPAQUE_LOGIN_FINISH_BYTES),
        ]);
        const reader = yield* request(OP_LOGIN_FINISH, fields);
        return yield* read(() => {
          const verified = reader.u8();
          reader.end();
          return verified === 1;
        });
      }),
    signCapability: (payloadSegment) =>
      request(OP_SIGN_CAPABILITY, [textField(payloadSegment)]).pipe(
        Effect.flatMap((reader) =>
          read(() => {
            const signature = exact(reader.bytes(), CAPABILITY_SIGNATURE_BYTES);
            reader.end();
            return signature;
          }),
        ),
      ),
    vapidJwt: (audience, subject) =>
      request(OP_VAPID_JWT, [textField(audience), textField(subject)]).pipe(
        Effect.flatMap((reader) =>
          read(() => {
            const jwt = reader.text();
            const expiresAt = reader.u64();
            reader.end();
            return { jwt, expiresAt };
          }),
        ),
      ),
  } satisfies KeyService;
});

function readStatus(body: Uint8Array): Effect.Effect<ResponseReader, KeyServiceError> {
  return read(() => readResponse(body)).pipe(
    Effect.flatMap((reader) => {
      switch (reader.status) {
        case STATUS_OK:
          return Effect.succeed(reader);
        case STATUS_EXHAUSTED:
          return read(() => reader.u32()).pipe(
            Effect.flatMap((retryAfterSeconds) =>
              Effect.fail(
                new KeyServiceError({
                  reason: 'exhausted',
                  message: "The account's attempts are spent",
                  retryAfterSeconds,
                }),
              ),
            ),
          );
        case STATUS_INVALID:
          return Effect.fail(
            new KeyServiceError({
              reason: 'invalid',
              message: 'keyd refused the request as malformed',
            }),
          );
        case STATUS_REFUSED:
          return Effect.fail(
            new KeyServiceError({
              reason: 'refused',
              message: 'keyd refused the capability times',
            }),
          );
        case STATUS_UNAVAILABLE:
          return Effect.fail(
            new KeyServiceError({ reason: 'unavailable', message: 'keyd holds no key for this' }),
          );
        default:
          return Effect.fail(
            new KeyServiceError({ reason: 'internal', message: `keyd failed (${reader.status})` }),
          );
      }
    }),
  );
}

function read<A>(decodeResponse: () => A): Effect.Effect<A, KeyServiceError> {
  return Effect.try({
    try: decodeResponse,
    catch: () => new KeyServiceError({ reason: 'internal', message: 'keyd answered out of shape' }),
  });
}

function canonical(
  build: () => readonly RequestField[],
): Effect.Effect<readonly RequestField[], KeyServiceError> {
  return Effect.try({
    try: build,
    catch: () =>
      new KeyServiceError({ reason: 'invalid', message: 'not a canonical OPAQUE message' }),
  });
}

function decode(value: string, bytes: number): Uint8Array {
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.byteLength !== bytes || decoded.toString('base64url') !== value) {
    throw new RangeError('not canonical base64url of the expected length');
  }
  return decoded;
}

function exact(value: Uint8Array, bytes: number): Uint8Array {
  if (value.byteLength !== bytes) throw new RangeError('keyd field of the wrong length');
  return value;
}

function encode(value: Uint8Array): string {
  return Buffer.from(value).toString('base64url');
}

interface Pending {
  readonly resolve: (body: Uint8Array) => void;
  readonly reject: (error: Error) => void;
}

/**
 * One socket to keyd, dialed on first use and again after it closes. Requests are written in
 * order and keyd answers in order, so a FIFO pairs each response with its request. A closed or
 * out-of-step socket fails every request in flight; nothing is retried.
 */
function createKeydConnection(socketPath: string): KeydConnection {
  const logger = createLogger('key-service');
  // Each dialed socket keeps its own queue, so a late event from a socket already given up on
  // can only fail what was sent on it, never what its successor carries.
  let active: Dialed | null = null;
  let closed = false;

  const dial = (): Dialed => {
    const dialed: Dialed = {
      open: null,
      pending: [],
      unsent: [],
      buffered: new Uint8Array(0),
      failed: false,
    };
    const fail = (error: Error) => {
      if (dialed.failed) return;
      dialed.failed = true;
      if (active === dialed) active = null;
      const pending = dialed.pending;
      dialed.pending = [];
      dialed.unsent = [];
      for (const request of pending) request.reject(error);
    };
    const socket = Bun.connect({
      unix: socketPath,
      socket: {
        data(open, chunk) {
          const joined = new Uint8Array(dialed.buffered.byteLength + chunk.byteLength);
          joined.set(dialed.buffered);
          joined.set(chunk, dialed.buffered.byteLength);
          let frames: ReturnType<typeof takeFrames>;
          try {
            frames = takeFrames(joined);
          } catch (error) {
            open.end();
            fail(error instanceof Error ? error : new Error('keyd stream out of step'));
            return;
          }
          dialed.buffered = frames.rest;
          for (const body of frames.bodies) {
            const request = dialed.pending.shift();
            if (request === undefined) {
              open.end();
              fail(new Error('keyd answered a request it was not sent'));
              return;
            }
            request.resolve(body);
          }
        },
        drain(open) {
          flush(dialed, open);
        },
        close() {
          if (dialed.pending.length > 0)
            logger.warn('keyd_connection_closed', { inFlight: dialed.pending.length });
          fail(new Error('keyd closed the connection'));
        },
        error(_open, error) {
          fail(error);
        },
      },
    });
    // Requests queue while the socket dials; a refused dial fails them all.
    void socket.then(
      (open) => {
        dialed.open = open;
        if (closed || dialed.failed) open.end();
        else flush(dialed, open);
      },
      (cause: Error) => fail(cause),
    );
    return dialed;
  };

  return {
    call(frame) {
      if (closed) return Promise.reject(new Error('the keyd connection is closed'));
      active ??= dial();
      const dialed = active;
      return new Promise<Uint8Array>((resolve, reject) => {
        dialed.pending.push({ resolve, reject });
        dialed.unsent.push(frame);
        if (dialed.open !== null) flush(dialed, dialed.open);
      });
    },
    close() {
      closed = true;
      const current = active;
      active = null;
      // A socket still dialing ends itself when it opens.
      current?.open?.end();
    },
  };
}

/** One dialed socket's requests: those sent and awaiting an answer, and bytes not yet written. */
interface DialState {
  pending: Pending[];
  unsent: Uint8Array[];
  buffered: Uint8Array;
  failed: boolean;
}

interface Dialed extends DialState {
  open: import('bun').Socket<undefined> | null;
}

/** Writes what the socket takes now; `drain` writes the rest. */
function flush(dialed: DialState, open: import('bun').Socket<undefined>): void {
  while (dialed.unsent.length > 0) {
    const [head] = dialed.unsent;
    if (head === undefined) return;
    const written = open.write(head);
    if (written < head.byteLength) {
      dialed.unsent[0] = head.subarray(Math.max(written, 0));
      return;
    }
    dialed.unsent.shift();
  }
}
