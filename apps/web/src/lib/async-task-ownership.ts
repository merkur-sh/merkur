/**
 * Generation ownership for cancel-and-replace asynchronous work.
 *
 * Interrupting an Effect fiber is itself asynchronous. A cancelled task can
 * therefore reach a completion/finalizer after its replacement has already
 * been installed. Every task captures the token returned by `beginAsyncTask`;
 * only that token may mutate the shared slot or perform completion side
 * effects.
 */
export interface AsyncTaskOwnership {
  generation: number;
}

export function createAsyncTaskOwnership(): AsyncTaskOwnership {
  return { generation: 0 };
}

/** Install a new owner, revoking every older token. */
export function beginAsyncTask(owner: AsyncTaskOwnership): number {
  owner.generation += 1;
  return owner.generation;
}

/** Revoke the current owner before dispatching its asynchronous interruption. */
export function invalidateAsyncTask(owner: AsyncTaskOwnership): void {
  owner.generation += 1;
}

export function isAsyncTaskCurrent(owner: AsyncTaskOwnership, expectedGeneration: number): boolean {
  return owner.generation === expectedGeneration;
}

/**
 * Atomically consume a current token.
 *
 * A stale completion returns false without clearing state owned by a newer
 * task. A successful claim also revokes duplicate completion callbacks.
 */
export function claimAsyncTaskCompletion(
  owner: AsyncTaskOwnership,
  expectedGeneration: number,
): boolean {
  if (!isAsyncTaskCurrent(owner, expectedGeneration)) {
    return false;
  }
  owner.generation += 1;
  return true;
}
