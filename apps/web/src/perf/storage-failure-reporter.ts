import { observeStorageFailures } from '@merkur/browser-storage';
import {
  BROWSER_STORAGE_FAILURES,
  BROWSER_STORAGE_TARGETS,
  type BrowserStorageFailure,
  type BrowserStorageReportBody,
  type BrowserStorageTarget,
} from '@merkur/shared';

import { storageTargetOf } from '../lib/storage-names';

/**
 * Counts browser storage failures and posts them, coalesced, on the terms of the
 * failure reporter (`error-reporter.ts`): one report per target and failure per
 * window, a bounded count, and a flush when the page is hidden. It hears this
 * page's failures directly and the workers' through their clients, which report
 * them into this realm.
 */
export interface StorageFailureReporter {
  readonly flush: () => void;
  /** Stops listening and discards anything unflushed. */
  readonly stop: () => void;
}

export type StorageFailureSender = (report: BrowserStorageReportBody) => void;

const FLUSH_INTERVAL_MS = 10_000;
const MAX_COUNT = 10_000;
const MAX_PENDING = BROWSER_STORAGE_TARGETS.length * BROWSER_STORAGE_FAILURES.length;

interface PendingFailure {
  readonly target: BrowserStorageTarget;
  readonly failure: BrowserStorageFailure;
  count: number;
}

export function startStorageFailureReporting(send: StorageFailureSender): StorageFailureReporter {
  const pending = new Map<string, PendingFailure>();

  const flush = (): void => {
    for (const entry of pending.values()) {
      send({
        target: entry.target,
        failure: entry.failure,
        count: Math.min(entry.count, MAX_COUNT),
      });
    }
    pending.clear();
  };

  const stopObserving = observeStorageFailures(({ target: name, failure }) => {
    const target = storageTargetOf(name);
    const key = `${target}:${failure}`;
    const existing = pending.get(key);
    if (existing !== undefined) {
      existing.count += 1;
    } else if (pending.size < MAX_PENDING) {
      pending.set(key, { target, failure, count: 1 });
    }
  });
  const interval = setInterval(flush, FLUSH_INTERVAL_MS);
  // A user who closes the tab does so inside the window; the hidden page is the
  // last moment a report reliably leaves.
  const host = typeof document === 'undefined' ? null : document;
  const onHidden = (): void => {
    if (host?.visibilityState === 'hidden') flush();
  };
  host?.addEventListener('visibilitychange', onHidden);

  return {
    flush,
    stop() {
      stopObserving();
      clearInterval(interval);
      host?.removeEventListener('visibilitychange', onHidden);
      pending.clear();
    },
  };
}
