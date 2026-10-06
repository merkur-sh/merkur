import { describe, expect, test } from 'bun:test';

import {
  beginAsyncTask,
  claimAsyncTaskCompletion,
  createAsyncTaskOwnership,
  invalidateAsyncTask,
  isAsyncTaskCurrent,
} from './async-task-ownership';

describe('async task ownership', () => {
  test('a cancelled task cannot release the replacement slot', () => {
    const owner = createAsyncTaskOwnership();
    const cancelled = beginAsyncTask(owner);
    invalidateAsyncTask(owner);
    const replacement = beginAsyncTask(owner);
    let slot: 'replacement' | null = 'replacement';

    if (claimAsyncTaskCompletion(owner, cancelled)) {
      slot = null;
    }

    expect(slot).toBe('replacement');
    expect(isAsyncTaskCurrent(owner, replacement)).toBe(true);

    if (claimAsyncTaskCompletion(owner, replacement)) {
      slot = null;
    }

    expect(slot).toBeNull();
  });

  test('revocation suppresses stale completion side effects', () => {
    const owner = createAsyncTaskOwnership();
    const stale = beginAsyncTask(owner);
    invalidateAsyncTask(owner);
    let completions = 0;

    if (claimAsyncTaskCompletion(owner, stale)) {
      completions += 1;
    }

    expect(completions).toBe(0);
  });
});
