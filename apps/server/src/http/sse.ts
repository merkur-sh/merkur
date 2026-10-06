import {
  BROWSER_EVENT_PRESENCE,
  BROWSER_EVENT_SESSION_ENDED,
  BROWSER_EVENT_SESSIONS_CHANGED,
  DEVICE_EVENT_DELTA,
  DEVICE_EVENT_RESUME,
  DEVICE_EVENT_SNAPSHOT,
  type Device,
  type DeviceDeltaFrame,
  type DeviceEventsCursor,
  type DeviceResumeFrame,
  type DeviceSnapshotFrame,
} from '@merkur/shared';
import { Cause, Effect, Schedule } from 'effect';
import type { ServerRuntimeContext } from '../runtime';
import type { BrowserPresenceSignal } from '../services/browser-session-presence';
import type { DeviceEventSignal } from '../services/device-events-service';

/**
 * Deltas that arrive while the opening snapshot is still being read are held
 * here, then replayed against the snapshot's sequence. A client that cannot be
 * caught up within this many is cut off and reconnects into a fresh snapshot.
 */
const MAX_BUFFERED_DELTAS = 256;

// Native stream demand is measured in bytes. Admit one complete frame while
// credit remains, including a snapshot larger than the budget, then reject all
// further writes until the consumer drains it. Retained output is bounded by
// this budget plus one frame; a large account snapshot can still be delivered.
const OUTPUT_QUEUE_STRATEGY: QueuingStrategy<Uint8Array> = {
  highWaterMark: 64 * 1024,
  size: (chunk) => chunk?.byteLength ?? 0,
};
const encoder = new TextEncoder();

/**
 * Sent before anything else, and never referenced again.
 *
 * A device-events body is a few dozen bytes every few minutes, which is exactly
 * the shape a compressing or buffering proxy holds onto: the frames are written
 * and flushed here, the encoder keeps them because it has nothing worth
 * emitting yet, and the browser sits on an open connection that never yields a
 * byte until the hop's idle timeout closes it. The client cannot tell that from
 * a quiet stream — it has no frame to fault on — so it reconnects on its
 * fallback schedule and the list silently stops updating while every span on
 * the server says the stream was served.
 *
 * Two defences, because they cover different hops: `content-encoding: identity`
 * declares the body already encoded so an intermediary will not compress it,
 * and this padding pushes the first write past a plain byte-count buffer. It is
 * a comment, so any SSE parser discards it.
 */
const PROXY_FLUSH_PADDING = `:${' '.repeat(2048)}\n\n`;

/**
 * Open device-events streams, per user.
 *
 * A request abort or consumer cancellation ends its stream. An intermediary can hold that
 * request open long after the browser is: the body is a few bytes every few
 * minutes, so there is nothing for a write to fail against. Streams that outlive
 * their client are otherwise invisible here — each holds a listener and, in
 * front of this process, a connection — and one browser reloading a few times
 * can leave several behind. This is the count that makes that observable; it is
 * reported on the span every open writes and on the log every close writes.
 */
const openStreamsByUser = new Map<string, number>();

/** Open streams for this user, this replica only. */
export function openDeviceEventsStreams(userId: string): number {
  return openStreamsByUser.get(userId) ?? 0;
}

/** Why a stream ended. Closed set, so it can label a log without cardinality risk. */
export type DeviceEventsCloseReason =
  | 'client_gone'
  | 'consumer_cancelled'
  | 'resync'
  | 'session_ended'
  | 'sequence_gap'
  | 'buffer_overflow'
  | 'write_failed'
  | 'stream_failed'
  | 'server_shutdown';

/** One HTTP application's admission gate and owners for its long-lived streams. */
export function createDeviceEventsSseLifetime() {
  let stopped = false;
  let stopping: Promise<void> | undefined;
  const streams = new Set<() => Promise<void>>();
  return {
    isStopped: () => stopped,
    register(stop: () => Promise<void>): () => void {
      streams.add(stop);
      return () => {
        streams.delete(stop);
      };
    },
    stop(): Promise<void> {
      if (stopping !== undefined) return stopping;
      stopped = true;
      stopping = Promise.all(Array.from(streams, (stop) => stop())).then(() => undefined);
      return stopping;
    },
  };
}

export type DeviceEventsSseLifetime = ReturnType<typeof createDeviceEventsSseLifetime>;

interface DeviceEventsSseOptions<E, R> {
  readonly lifetime: DeviceEventsSseLifetime;
  readonly run: (
    program: Effect.Effect<void, never, R>,
    options: Effect.RunOptions,
  ) => Promise<void>;
  readonly request: Request;
  /** Whose streams this one counts against. */
  readonly userId: string;
  readonly keepAliveMs: number;
  /** The client's last applied cursor, or null on a first open. */
  readonly since: DeviceEventsCursor | null;
  readonly subscribe: (
    listener: (signal: DeviceEventSignal) => void,
  ) => Effect.Effect<Effect.Effect<void>, E, R>;
  readonly subscribePresence: (
    listener: (signal: BrowserPresenceSignal) => void,
  ) => Effect.Effect<Effect.Effect<void>, E, R>;
  readonly readCursor: Effect.Effect<DeviceEventsCursor, E, R>;
  readonly loadSnapshot: Effect.Effect<readonly Device[], E, R>;
  readonly onError: (error: unknown) => void;
  /** One record per ended stream: why, and how many this user still has open. */
  readonly onClosed: (reason: DeviceEventsCloseReason, openForUser: number, ageMs: number) => void;
}

/**
 * One device-events stream.
 *
 * Order of operations is the correctness argument: subscribe first, then read
 * the cursor `S`, then the snapshot. Any transition committed before `S` is
 * in the snapshot; any committed after arrives as a delta with `seq > S.seq`. A
 * transition that lands between the two reads appears in both, and deltas are
 * absolute, so applying it twice changes nothing. `S` — never the highest
 * buffered delta — is what the snapshot is stamped with and what the replay
 * filters against.
 *
 * When the client's `since` equals `S` in **both** halves — same epoch, same
 * sequence — nothing it holds is stale: it gets a `resume` frame and no
 * snapshot. The epoch is what makes that sound across a Redis restart, which
 * takes the counter back to zero; without it a browser holding a sequence the
 * rebuilt counter has since climbed back to would be told nothing had changed.
 * A gap in the delta sequence, a buffer overflow, or a pub/sub reconnect closes
 * the stream; the client reconnects and the same comparison decides what it
 * needs.
 */
export function createDeviceEventsSseResponse<E, R = ServerRuntimeContext>(
  options: DeviceEventsSseOptions<E, NoInfer<R>>,
): Response {
  if (options.lifetime.isStopped()) return new Response(null, { status: 503 });
  let closed = false;
  const streamController = new AbortController();
  let completed: Promise<void> | undefined;
  let abortClose: (() => void) | null = null;
  let released = false;
  let openedAtMs = 0;

  /**
   * Retire this stream from the census exactly once.
   *
   * Both endings reach it — the body closing and the consumer cancelling — and
   * neither is guaranteed to be the other, so the guard is what keeps the count
   * from drifting in either direction over a long-lived process.
   */
  function release(reason: DeviceEventsCloseReason): void {
    if (released) return;
    released = true;
    const remaining = (openStreamsByUser.get(options.userId) ?? 1) - 1;
    if (remaining > 0) {
      openStreamsByUser.set(options.userId, remaining);
    } else {
      openStreamsByUser.delete(options.userId);
    }
    options.onClosed(reason, remaining, Math.round(performance.now() - openedAtMs));
  }

  const stream = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        let lastSentSeq = -1;
        let buffered: DeviceDeltaFrame[] | null = [];
        openedAtMs = performance.now();
        openStreamsByUser.set(options.userId, (openStreamsByUser.get(options.userId) ?? 0) + 1);

        function write(payload: string): void {
          if (closed) return;
          if ((controller.desiredSize ?? 0) <= 0) {
            close('buffer_overflow');
            return;
          }
          try {
            controller.enqueue(encoder.encode(payload));
          } catch {
            close('write_failed');
          }
        }

        write(PROXY_FLUSH_PADDING);

        function close(reason: DeviceEventsCloseReason): void {
          if (closed) return;
          closed = true;
          options.request.signal.removeEventListener('abort', onAbort);
          abortClose = null;
          streamController.abort();
          release(reason);
          try {
            controller.close();
          } catch {
            // The client may already have closed the stream.
          }
        }
        function onAbort(): void {
          close('client_gone');
        }
        abortClose = onAbort;
        const unregister = options.lifetime.register(() => {
          close('server_shutdown');
          return completed ?? Promise.resolve();
        });

        function emitDelta(frame: DeviceDeltaFrame): void {
          if (frame.seq <= lastSentSeq) return;
          if (frame.seq !== lastSentSeq + 1) {
            // Something between the last frame and this one never reached us.
            // The client cannot tell either, so cut the stream and let it resync.
            close('sequence_gap');
            return;
          }
          lastSentSeq = frame.seq;
          write(`event: ${DEVICE_EVENT_DELTA}\ndata: ${JSON.stringify(frame)}\n\n`);
        }

        function onSignal(signal: DeviceEventSignal): void {
          if (closed) return;
          if (signal._tag === 'resync') {
            close('resync');
            return;
          }
          if (buffered !== null) {
            if (buffered.length >= MAX_BUFFERED_DELTAS) {
              close('buffer_overflow');
              return;
            }
            buffered.push(signal.frame);
            return;
          }
          emitDelta(signal.frame);
        }

        // One runtime-owned fiber, with a stream-local scope for subscriptions and
        // children. Setup operations have finite spans; this lifetime has no span.
        const program = Effect.scoped(
          Effect.gen(function* () {
            yield* Effect.acquireRelease(options.subscribe(onSignal), (unsubscribe) => unsubscribe);

            // Presence bootstraps alongside the machine snapshot, so adding it
            // never adds a Redis round trip to the first device-list paint.
            yield* Effect.acquireRelease(
              options.subscribePresence((signal) => {
                if (signal._tag === 'session-ended') {
                  write(`event: ${BROWSER_EVENT_SESSION_ENDED}\ndata: null\n\n`);
                  close('session_ended');
                } else if (signal._tag === 'sessions-changed') {
                  write(`event: ${BROWSER_EVENT_SESSIONS_CHANGED}\ndata: null\n\n`);
                } else if (signal._tag === 'resync') close('resync');
                else
                  write(
                    `event: ${BROWSER_EVENT_PRESENCE}\ndata: ${JSON.stringify(signal.frame)}\n\n`,
                  );
              }),
              (unsubscribe) => unsubscribe,
            ).pipe(
              Effect.andThen(Effect.never),
              Effect.catchCause((cause) =>
                Effect.sync(() => {
                  if (Cause.hasInterruptsOnly(cause)) return;
                  options.onError(Cause.squash(cause));
                  close('stream_failed');
                }),
              ),
              Effect.forkScoped,
            );

            const cursor = yield* options.readCursor;
            const { epoch, seq } = cursor;
            if (
              options.since !== null &&
              options.since.epoch === epoch &&
              options.since.seq === seq
            ) {
              const resume: DeviceResumeFrame = { epoch, seq };
              write(`event: ${DEVICE_EVENT_RESUME}\ndata: ${JSON.stringify(resume)}\n\n`);
            } else {
              const devices = yield* options.loadSnapshot;
              const snapshot: DeviceSnapshotFrame = { epoch, seq, devices };
              write(`event: ${DEVICE_EVENT_SNAPSHOT}\ndata: ${JSON.stringify(snapshot)}\n\n`);
            }
            lastSentSeq = seq;
            const pending = buffered ?? [];
            buffered = null;
            for (const frame of pending) {
              if (closed) break;
              emitDelta(frame);
            }

            yield* Effect.sleep(`${options.keepAliveMs} millis`).pipe(
              Effect.andThen(
                Effect.sync(() => write(': keep-alive\n\n')).pipe(
                  Effect.repeat(Schedule.spaced(`${options.keepAliveMs} millis`)),
                ),
              ),
              Effect.forkScoped,
            );

            yield* Effect.never;
          }),
        ).pipe(
          Effect.catchCause((cause) =>
            Effect.sync(() => {
              if (Cause.hasInterruptsOnly(cause)) return;
              options.onError(Cause.squash(cause));
              close('stream_failed');
            }),
          ),
          Effect.ensuring(Effect.sync(() => close('server_shutdown'))),
        );
        options.request.signal.addEventListener('abort', onAbort, { once: true });
        if (options.request.signal.aborted) onAbort();
        if (closed) {
          unregister();
          return;
        }
        completed = options
          .run(program, { signal: streamController.signal })
          .catch((error: unknown) => {
            if (closed) return;
            options.onError(error);
            close('stream_failed');
          })
          .finally(unregister);
      },
      cancel() {
        closed = true;
        if (abortClose !== null) {
          options.request.signal.removeEventListener('abort', abortClose);
          abortClose = null;
        }
        streamController.abort();
        release('consumer_cancelled');
        return completed;
      },
    },
    OUTPUT_QUEUE_STRATEGY,
  );

  return new Response(stream, {
    headers: {
      /**
       * `no-store`, not `no-cache`.
       *
       * `no-cache` still *stores*: it only forces revalidation before reuse. A
       * stored entry has one writer, and browsers serialise requests for the
       * same cache key behind that writer's lock — so a second request for this
       * URL waits for the first to finish. This body never finishes. A reload
       * therefore parked the new page's stream behind the previous page's,
       * invisible from both ends: no headers, no bytes, no error, the request
       * absent from the server until the browser's own lock timeout released
       * it (measured at 20.5 s in Firefox, whose default is 20 s), by which
       * point the list had been sitting unconfirmed the whole time.
       *
       * Nothing here was ever cacheable — it is one account's live presence —
       * so the entry that created the lock had no reason to exist.
       */
      'cache-control': 'no-store, no-transform',
      connection: 'keep-alive',
      // Already-encoded, as far as any intermediary is concerned. Compressing a
      // stream of tiny writes is what buffers them; `no-transform` asks for the
      // same thing and not every hop honours it.
      'content-encoding': 'identity',
      'content-type': 'text/event-stream; charset=utf-8',
      'x-accel-buffering': 'no',
    },
  });
}
