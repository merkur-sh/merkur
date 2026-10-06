import type { BoxHostConfig } from '@merkur/config';
import { Context, Data, Effect, Layer, Redacted } from 'effect';

import { ServerConfigService } from '../config';

/**
 * Client for the box host's lifecycle service.
 *
 * Deliberately thin: the box host owns every policy decision (image, TTL, quotas,
 * limits, capacity), so this forwards and normalizes and nothing else. Keeping
 * box policy off the wire is what stops a TTL change from becoming a server
 * deployment.
 *
 * A box runs its own Merkur daemon and appears as its own device, so there is
 * no per-box command channel here — only lifecycle: create, start, delete.
 */

export class BoxHostError extends Data.TaggedError('BoxHostError')<{
  readonly operation: string;
  readonly message: string;
  readonly status?: number;
}> {}

/** Set when the deployment has no box host configured at all. */
export class BoxHostUnconfiguredError extends Data.TaggedError('BoxHostUnconfiguredError')<{
  readonly operation: string;
}> {}

export interface CreatedBox {
  readonly boxId: string;
  /**
   * Code the box's daemon emitted. The browser approves it with the account
   * password; nothing server-side can, since approval needs the user root key.
   */
  readonly linkCode: string;
}

export interface BoxHostService {
  createLinked(
    boxId: string,
    linkToken: string,
  ): Effect.Effect<CreatedBox, BoxHostError | BoxHostUnconfiguredError>;
  /**
   * Starts a stopped box.
   *
   * The TTL reaper stops idle boxes, which takes their device offline. Without
   * this the box is unreachable for good: nothing else can restart it, and the
   * device row is the only handle the user has on it.
   */
  start(boxId: string): Effect.Effect<void, BoxHostError | BoxHostUnconfiguredError>;
  /**
   * Destroys a box. A box the host does not have is already removed: its
   * exact 404 is the proof, and any other refusal is an error the caller must
   * not read as absence.
   */
  remove(boxId: string): Effect.Effect<void, BoxHostError | BoxHostUnconfiguredError>;
}

export class BoxHostServiceTag extends Context.Service<BoxHostServiceTag, BoxHostService>()(
  'BoxHostService',
) {}

export const BoxHostServiceLive = Layer.effect(
  BoxHostServiceTag,
  Effect.gen(function* () {
    const config = yield* ServerConfigService;
    return createBoxHostService({
      boxHost: config.boxHost,
      serverOrigin: config.publicOrigin,
    });
  }),
);

export interface BoxHostOptions {
  readonly boxHost: BoxHostConfig | undefined;
  readonly serverOrigin: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function createBoxHostService(options: BoxHostOptions): BoxHostService {
  const boxHost = options.boxHost;
  const token = boxHost === undefined ? undefined : Redacted.value(boxHost.token);
  const request = (
    operation: string,
    path: string,
    init: { method: string; body?: unknown },
  ): Effect.Effect<unknown, BoxHostError | BoxHostUnconfiguredError> => {
    if (boxHost === undefined) {
      return new BoxHostUnconfiguredError({ operation });
    }
    return Effect.tryPromise({
      try: async (signal) => {
        const response = await fetch(new URL(path, boxHost.url), {
          method: init.method,
          headers: {
            authorization: `Bearer ${token}`,
            ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          body: init.body === undefined ? undefined : JSON.stringify(init.body),
          signal,
        });
        const text = await response.text();

        if (!response.ok) {
          // The box host returns a stable machine code; surface it rather than the body,
          // so the route can map "at capacity" differently from "host is down".
          let reason = text.slice(0, 200);
          try {
            const parsed: unknown = JSON.parse(text);
            if (isRecord(parsed) && typeof parsed.error === 'string') reason = parsed.error;
          } catch {
            // Non-JSON body; the truncated text is the best available detail.
          }
          throw new BoxHostError({ operation, message: reason, status: response.status });
        }

        try {
          const body: unknown = JSON.parse(text);
          return body;
        } catch {
          return null;
        }
      },
      catch: (cause) =>
        cause instanceof BoxHostError
          ? cause
          : new BoxHostError({
              operation,
              message: cause instanceof Error ? cause.message : String(cause),
            }),
    }).pipe(
      Effect.timeoutOrElse({
        duration: boxHost.timeoutMs,
        orElse: () => new BoxHostError({ operation, message: 'box host request timed out' }),
      }),
    );
  };

  return {
    createLinked(boxId, linkToken) {
      return request('createLinked', '/boxes/linked', {
        method: 'POST',
        body: { name: boxId, serverOrigin: options.serverOrigin, linkToken },
      }).pipe(
        Effect.flatMap((body) => {
          const linkCode = isRecord(body) && typeof body.linkCode === 'string' ? body.linkCode : '';
          if (linkCode === '') {
            return new BoxHostError({
              operation: 'createLinked',
              message: 'box host returned no link code',
            });
          }
          return Effect.succeed({ boxId, linkCode });
        }),
      );
    },

    start(boxId) {
      return request('start', `/boxes/${encodeURIComponent(boxId)}/start`, {
        method: 'POST',
      }).pipe(Effect.asVoid);
    },

    remove(boxId) {
      return request('remove', `/boxes/${encodeURIComponent(boxId)}`, {
        method: 'DELETE',
      }).pipe(
        Effect.asVoid,
        Effect.catchTag('BoxHostError', (error) =>
          error.status === 404 ? Effect.void : Effect.fail(error),
        ),
      );
    },
  };
}
