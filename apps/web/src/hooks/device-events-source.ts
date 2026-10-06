import {
  BROWSER_EVENT_PRESENCE,
  BROWSER_EVENT_SESSION_ENDED,
  BROWSER_EVENT_SESSIONS_CHANGED,
  type BrowserPresenceFrame,
  DEVICE_EVENT_DELTA,
  DEVICE_EVENT_RESUME,
  DEVICE_EVENT_SNAPSHOT,
  DEVICE_EVENTS_SINCE_HEADER,
  type DeviceDeltaFrame,
  type DeviceEventsCursor,
  type DeviceSnapshotFrame,
  formatDeviceEventsCursor,
  isBrowserPresenceFrame,
  isDeviceDeltaFrame,
  isDeviceResumeFrame,
  isDeviceSnapshotFrame,
} from '@merkur/shared';
import { Data, Effect, Queue, Stream } from 'effect';
import { openAuthenticatedEventStream } from '../event-stream-worker-client';
import { EventStreamHttpError, type SseEvent } from '../lib/authenticated-transport';

const DEVICE_EVENTS_PATH = '/api/devices/events';

/**
 * One SSE lifetime reported as a stream of events rather than as callbacks.
 *
 * `open` is carried in-band instead of as an `onOpen` side channel so the
 * consumer observes it in the same order as the frames that follow it. That
 * ordering is what lets the recovery loop reset its one-use refresh latch at
 * exactly the point the server proved the credential is accepted, without
 * needing a generation guard to tell a stale callback from a live one — an
 * interrupted stream simply stops producing.
 *
 * The server opens every stream with exactly one of `snapshot` (the full list
 * stamped with its sequence) or `resume` (nothing changed since `since`), then
 * forwards sequenced absolute `delta` frames.
 *
 * `activity` is in-band for the same reason `open` is: the consumer's stall
 * deadline is about this lifetime, and an out-of-band callback would need a
 * generation guard to tell a stale one from a live one.
 */
export type DeviceStreamEvent =
  | { readonly _tag: 'browser-presence'; readonly frame: BrowserPresenceFrame }
  | { readonly _tag: 'open' }
  | { readonly _tag: 'session-ended' }
  /** The account's browser-session list changed; this session is still in it. */
  | { readonly _tag: 'sessions-changed' }
  /** Bytes arrived. Carries no content: it exists to prove the socket lives. */
  | { readonly _tag: 'activity' }
  | { readonly _tag: 'snapshot'; readonly frame: DeviceSnapshotFrame }
  | { readonly _tag: 'resume'; readonly cursor: DeviceEventsCursor }
  | { readonly _tag: 'delta'; readonly frame: DeviceDeltaFrame };

/** The endpoint definitively rejected this credential; only a 401 proves that. */
export class DeviceStreamUnauthorized extends Data.TaggedError('DeviceStreamUnauthorized')<{
  readonly status: number;
}> {}

/** Any other transport, HTTP, or reader failure. Retryable with the same token. */
export class DeviceStreamFailed extends Data.TaggedError('DeviceStreamFailed')<{
  readonly cause: unknown;
}> {}

/**
 * The attempt was aborted rather than answered.
 *
 * Kept apart from a failure because it is not one: this stream is only ever
 * aborted by whoever owns it — the scope closing, or the page being unloaded
 * out from under it — so it says nothing about the endpoint, and counting it as
 * a stream that produced no frame would report one failure per page load.
 */
export class DeviceStreamAborted extends Data.TaggedError('DeviceStreamAborted')<
  Record<string, never>
> {}

export type DeviceStreamError = DeviceStreamUnauthorized | DeviceStreamFailed | DeviceStreamAborted;

export type OpenEventStream = typeof openAuthenticatedEventStream;

/**
 * A single connection attempt as a `Stream`.
 *
 * The stream ends when the server closes the response body and fails when the
 * fetch, the reader, or the HTTP status rejects. Reconnect policy deliberately
 * lives in the consumer: this stream models one lifetime only, so interrupting
 * it is the whole of its teardown.
 *
 * `since` is the last cursor this browser applied, or null when it holds no
 * list at all. The server answers an up-to-date `since` with a `resume` frame
 * and no snapshot — zero bytes for the common background/foreground cycle.
 *
 * The `AbortController` is released through the stream's own `Scope`, which is
 * what makes cancellation structural. An interrupted pull aborts the fetch on
 * the way out rather than relying on the consumer to remember to do it, and a
 * callback the host had already queued cannot reach a replacement lifetime
 * because it can only ever offer into this lifetime's queue.
 */
export function deviceEventStream(
  token: string,
  since: DeviceEventsCursor | null,
  openEventStream: OpenEventStream = openAuthenticatedEventStream,
): Stream.Stream<DeviceStreamEvent, DeviceStreamError> {
  return Stream.callback<DeviceStreamEvent, DeviceStreamError>((queue) =>
    Effect.gen(function* () {
      const controller = new AbortController();
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          if (!controller.signal.aborted) {
            controller.abort();
          }
        }),
      );

      // The queue, not this fiber's exit, is what terminates the stream: the
      // channel forks this effect and never observes its failure. Both
      // outcomes must therefore be written into the queue, or a rejected fetch
      // would leave the consumer parked on a stream that can never end.
      yield* Effect.tryPromise({
        try: () =>
          openEventStream(token, DEVICE_EVENTS_PATH, {
            signal: controller.signal,
            headers:
              since === null
                ? undefined
                : { [DEVICE_EVENTS_SINCE_HEADER]: formatDeviceEventsCursor(since) },
            onOpen() {
              Queue.offerUnsafe(queue, { _tag: 'open' });
            },
            onEvent(event) {
              const parsed = parseDeviceStreamEvent(event);
              if (parsed !== null) {
                Queue.offerUnsafe(queue, parsed);
              }
            },
            onActivity() {
              Queue.offerUnsafe(queue, { _tag: 'activity' });
            },
          }),
        catch: toDeviceStreamError,
      }).pipe(
        Effect.matchEffect({
          onFailure: (error) => Queue.fail(queue, error),
          // A clean end-of-body is not a failure: the consumer treats it as a
          // recovery edge and reconnects with the current credential.
          onSuccess: () => Queue.end(queue),
        }),
      );
    }),
  );
}

function toDeviceStreamError(error: unknown): DeviceStreamError {
  if (error instanceof EventStreamHttpError && error.status === 401) {
    return new DeviceStreamUnauthorized({ status: error.status });
  }
  // Matched on the name rather than the type: a reader rejects with a
  // `DOMException` here and with a plain `Error` in other runtimes, and both
  // mean the same thing.
  if (error instanceof Error && error.name === 'AbortError') {
    return new DeviceStreamAborted({});
  }
  return new DeviceStreamFailed({ cause: error });
}

/**
 * A frame is accepted only if it validates whole. A mixed-schema snapshot is
 * dropped rather than partially applied, so a malformed element cannot
 * silently truncate the rendered list or satisfy a boot wait, and an unknown
 * event name is ignored.
 */
function parseDeviceStreamEvent(event: SseEvent): DeviceStreamEvent | null {
  if (event.data.length === 0) return null;
  const parsed = parseJson(event.data);
  switch (event.event) {
    case BROWSER_EVENT_SESSION_ENDED:
      return event.data.trim() === 'null' ? { _tag: 'session-ended' } : null;
    case BROWSER_EVENT_SESSIONS_CHANGED:
      return event.data.trim() === 'null' ? { _tag: 'sessions-changed' } : null;
    case BROWSER_EVENT_PRESENCE:
      return isBrowserPresenceFrame(parsed) ? { _tag: 'browser-presence', frame: parsed } : null;
    case DEVICE_EVENT_SNAPSHOT:
      return isDeviceSnapshotFrame(parsed) ? { _tag: 'snapshot', frame: parsed } : null;
    case DEVICE_EVENT_DELTA:
      return isDeviceDeltaFrame(parsed) ? { _tag: 'delta', frame: parsed } : null;
    case DEVICE_EVENT_RESUME:
      return isDeviceResumeFrame(parsed)
        ? { _tag: 'resume', cursor: { epoch: parsed.epoch, seq: parsed.seq } }
        : null;
    default:
      return null;
  }
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}
