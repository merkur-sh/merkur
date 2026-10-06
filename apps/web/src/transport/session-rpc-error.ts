import type { SessionIssuanceErrorCode } from '../transport-worker-protocol';

/** A server rejection preserved across the main/worker RPC boundary. */
export class SessionRpcError extends Error {
  constructor(
    message: string,
    readonly code: SessionIssuanceErrorCode | undefined,
  ) {
    super(message);
    this.name = 'SessionRpcError';
  }
}
