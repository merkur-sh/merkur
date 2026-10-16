import type { DaemonSignaturePair } from '@merkur/auth';
import { Data, Effect } from 'effect';
import type { DataplaneClient } from './dataplane-client';

export class DaemonProofSigningError extends Data.TaggedError('DaemonProofSigningError')<{
  readonly reason: string;
}> {}

export interface DaemonProofSigner {
  signEffect(
    purpose: 'http' | 'control',
    transcript: Uint8Array,
  ): Effect.Effect<DaemonSignaturePair, DaemonProofSigningError>;
}

/** What a bound signer asks of the dataplane. */
export type DaemonProofSigningClient = Pick<DataplaneClient, 'signDaemonProofEffect'>;

/** The exporter is constructed before the scoped dataplane becomes available. */
export function createDaemonProofSigner(): DaemonProofSigner & {
  bind(client: DaemonProofSigningClient): () => void;
} {
  let bound: DaemonProofSigningClient | null = null;
  return {
    bind(client) {
      bound = client;
      return () => {
        if (bound === client) bound = null;
      };
    },
    // Signing an exporter request must not create another exportable span.
    signEffect: Effect.fnUntraced(function* (purpose, transcript) {
      const client = bound;
      if (client === null)
        return yield* new DaemonProofSigningError({ reason: 'identity_unconfigured' });
      const result = yield* client.signDaemonProofEffect(crypto.randomUUID(), purpose, transcript);
      if (result.status === 'rejected')
        return yield* new DaemonProofSigningError({ reason: result.reason });
      return { mldsa: result.signature, p256: result.p256Signature };
    }),
  };
}
