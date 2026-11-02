import { describe, expect, jest, test } from 'bun:test';
import { reportStorageFailure, STORAGE_FAILURES } from '@merkur/browser-storage';
import {
  BROWSER_STORAGE_FAILURES,
  BROWSER_STORAGE_TARGETS,
  type BrowserStorageReportBody,
} from '@merkur/shared';

import { STORAGE_NAMES, storageTargetOf } from '../lib/storage-names';
import { startStorageFailureReporting } from './storage-failure-reporter';

const FLUSH_INTERVAL_MS = 10_000;

function startRecording() {
  const sent: BrowserStorageReportBody[] = [];
  const reporter = startStorageFailureReporting((report) => sent.push(report));
  return { reporter, sent };
}

describe('the storage failure contract', () => {
  // A failure the package names and the server's union does not list is refused with
  // a 422 and dropped: the silence this report exists to break. Both sides pin one list.
  test('the package reports exactly the failures the server accepts', () => {
    expect([...STORAGE_FAILURES]).toEqual([...BROWSER_STORAGE_FAILURES]);
  });

  test('every declared store is a target, and each name maps back to its own', () => {
    expect(Object.keys(STORAGE_NAMES).sort()).toEqual(
      BROWSER_STORAGE_TARGETS.filter((target) => target !== 'unlisted').sort(),
    );
    for (const [target, name] of Object.entries(STORAGE_NAMES)) {
      expect(String(storageTargetOf(name))).toBe(target);
    }
    expect(new Set(Object.values(STORAGE_NAMES)).size).toBe(Object.keys(STORAGE_NAMES).length);
  });

  test('a name the table does not hold is counted as unlisted rather than dropped', () => {
    expect(storageTargetOf('merkur:never-declared')).toBe('unlisted');
  });
});

describe('storage failure reporting', () => {
  test('coalesces failures per target and failure, and sends each once per window', () => {
    jest.useFakeTimers();
    const { reporter, sent } = startRecording();
    try {
      reportStorageFailure(STORAGE_NAMES.delegation_vault, 'aborted');
      reportStorageFailure(STORAGE_NAMES.delegation_vault, 'aborted');
      reportStorageFailure(STORAGE_NAMES.appearance, 'quota');
      reportStorageFailure('merkur:never-declared', 'unparseable');
      expect(sent).toEqual([]);
      jest.advanceTimersByTime(FLUSH_INTERVAL_MS);
      expect(sent).toEqual([
        { target: 'delegation_vault', failure: 'aborted', count: 2 },
        { target: 'appearance', failure: 'quota', count: 1 },
        { target: 'unlisted', failure: 'unparseable', count: 1 },
      ]);
      jest.advanceTimersByTime(FLUSH_INTERVAL_MS);
      expect(sent).toHaveLength(3);
    } finally {
      reporter.stop();
      jest.useRealTimers();
    }
  });

  test('stop discards what is unflushed and hears nothing after', () => {
    jest.useFakeTimers();
    const { reporter, sent } = startRecording();
    try {
      reportStorageFailure(STORAGE_NAMES.device_list, 'refused');
      reporter.stop();
      reportStorageFailure(STORAGE_NAMES.device_list, 'refused');
      jest.advanceTimersByTime(FLUSH_INTERVAL_MS);
      reporter.flush();
      expect(sent).toEqual([]);
    } finally {
      jest.useRealTimers();
    }
  });
});
