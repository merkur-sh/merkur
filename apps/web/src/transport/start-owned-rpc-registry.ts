interface PendingRpc<Result> {
  readonly owner: number;
  readonly resolve: (result: Result) => void;
  readonly reject: (error: Error) => void;
}

export interface StartOwnedRpcRegistry<Result> {
  beginOwner(owner: number): void;
  request(publish: (requestId: number, owner: number) => void): Promise<Result>;
  resolve(owner: number, requestId: number, result: Result): boolean;
  reject(owner: number, requestId: number, error: Error): boolean;
  closeOwner(reason: string): void;
}

/**
 * Owns worker→main RPC promises by one transport-start invocation.
 *
 * Replacing/closing the owner rejects and removes every old promise before the
 * successor can publish a request. A late reply therefore has no resolver to
 * borrow. Request ids wrap within the safe-integer domain and skip ids that are
 * still live, so a long-running worker cannot collide through numeric overflow.
 */
export function createStartOwnedRpcRegistry<Result>(
  maxRequestId = Number.MAX_SAFE_INTEGER,
): StartOwnedRpcRegistry<Result> {
  if (!Number.isSafeInteger(maxRequestId) || maxRequestId < 1) {
    throw new RangeError('maxRequestId must be a positive safe integer');
  }

  const pending = new Map<number, PendingRpc<Result>>();
  let activeOwner: number | null = null;
  let nextRequestId = 1;

  const rejectAll = (reason: string): void => {
    const error = new Error(reason);
    for (const rpc of pending.values()) rpc.reject(error);
    pending.clear();
  };

  const allocateRequestId = (): number | null => {
    if (pending.size >= maxRequestId) return null;
    for (let attempts = 0; attempts < maxRequestId; attempts += 1) {
      const requestId = nextRequestId;
      nextRequestId = requestId >= maxRequestId ? 1 : requestId + 1;
      if (!pending.has(requestId)) return requestId;
    }
    return null;
  };

  const takeCurrent = (owner: number, requestId: number): PendingRpc<Result> | null => {
    const rpc = pending.get(requestId);
    if (rpc === undefined) return null;
    if (rpc.owner !== owner) return null;
    pending.delete(requestId);
    if (activeOwner === rpc.owner) return rpc;
    rpc.reject(new Error('Session RPC owner was superseded'));
    return null;
  };

  return {
    beginOwner(owner): void {
      rejectAll('Session RPC owner was superseded');
      activeOwner = owner;
    },

    request(publish): Promise<Result> {
      return new Promise<Result>((resolve, reject) => {
        const owner = activeOwner;
        if (owner === null) {
          reject(new Error('No active session RPC owner'));
          return;
        }
        const requestId = allocateRequestId();
        if (requestId === null) {
          reject(new Error('Session RPC request-id space exhausted'));
          return;
        }
        pending.set(requestId, { owner, resolve, reject });
        try {
          publish(requestId, owner);
        } catch (error) {
          pending.delete(requestId);
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    },

    resolve(owner, requestId, result): boolean {
      const rpc = takeCurrent(owner, requestId);
      if (rpc === null) return false;
      rpc.resolve(result);
      return true;
    },

    reject(owner, requestId, error): boolean {
      const rpc = takeCurrent(owner, requestId);
      if (rpc === null) return false;
      rpc.reject(error);
      return true;
    },

    closeOwner(reason): void {
      activeOwner = null;
      rejectAll(reason);
    },
  };
}
