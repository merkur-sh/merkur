import { expect, test } from 'bun:test';
import { Effect } from 'effect';

import {
  type BrowserPresenceSignal,
  createBrowserPresenceService,
  publishBrowserSessionChange,
} from './browser-session-presence';
import type { RedisCommandClient, RedisService } from './redis-service';

function count(
  frames: readonly BrowserPresenceSignal[],
  tag: BrowserPresenceSignal['_tag'],
): number {
  return frames.filter((frame) => frame._tag === tag).length;
}

test("a session change ends exact targets, tells the account's other browsers, and stops at release", async () => {
  const subscriptions = new Map<string, Set<(message: string) => void>>();
  const commands: RedisCommandClient = {
    async sendCommand<T>(args: string[]): Promise<T> {
      const operation = args[3 + Number(args[2])];
      if (operation === 'sweep') return null as T;
      if (operation === 'open') {
        return JSON.stringify({ seq: 0, activeDelegationIds: [] }) as T;
      }
      return 1 as T;
    },
  };
  const redis: RedisService = {
    useCommands: (run) => Effect.promise(() => Promise.resolve(run(commands))),
    publish: (channel, message) =>
      Effect.sync(() => {
        for (const listener of subscriptions.get(channel) ?? []) listener(message);
      }),
    subscribe: (channel, listener) =>
      Effect.sync(() => {
        const listeners = subscriptions.get(channel) ?? new Set();
        listeners.add(listener);
        subscriptions.set(channel, listeners);
      }),
    unsubscribe: (channel, listener) =>
      Effect.sync(() => {
        if (listener !== undefined) subscriptions.get(channel)?.delete(listener);
      }),
    healthSnapshot: () =>
      Effect.succeed({
        commandsReady: true,
        publisherReady: true,
        subscriberReady: true,
      }),
  };
  const seen: BrowserPresenceSignal[][] = [[], [], []];
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const presence = yield* createBrowserPresenceService(redis);
        const releases: Effect.Effect<void>[] = [];
        for (const [index, frames] of seen.entries()) {
          releases.push(
            yield* presence.open(
              {
                userId: index === 2 ? 'other-account' : 'account',
                delegationId: index === 1 ? 'survivor' : 'revoked',
                delegationExpiresAt: Date.now() + 60_000,
              },
              (frame) => frames.push(frame),
            ),
          );
        }
        yield* publishBrowserSessionChange(redis, 'account', {
          issuedDelegationIds: [],
          revokedDelegationIds: ['revoked'],
        });
        expect(seen.map((frames) => count(frames, 'session-ended'))).toEqual([1, 0, 0]);
        expect(seen.map((frames) => count(frames, 'sessions-changed'))).toEqual([0, 1, 0]);
        // A login on a new browser is news to every browser of the account and
        // to nobody else's.
        yield* publishBrowserSessionChange(redis, 'account', {
          issuedDelegationIds: ['newcomer'],
          revokedDelegationIds: [],
        });
        expect(seen.map((frames) => count(frames, 'sessions-changed'))).toEqual([1, 2, 0]);
        // Nothing to say is nothing published.
        yield* publishBrowserSessionChange(redis, 'account', {
          issuedDelegationIds: [],
          revokedDelegationIds: [],
        });
        expect(seen.map((frames) => count(frames, 'sessions-changed'))).toEqual([1, 2, 0]);
        yield* Effect.all(releases, { discard: true });
        yield* publishBrowserSessionChange(redis, 'account', {
          issuedDelegationIds: [],
          revokedDelegationIds: ['revoked', 'survivor'],
        });
        expect(seen.map((frames) => count(frames, 'session-ended'))).toEqual([1, 0, 0]);
        expect(seen.map((frames) => count(frames, 'sessions-changed'))).toEqual([1, 2, 0]);
      }),
    ),
  );
});
