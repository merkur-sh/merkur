export const BROKER_PROTOCOL_VERSION = 1;
export const BROKER_BROADCAST_CHANNEL = 'merkur:daemon-control:broadcast';

export function revocationGenerationBroadcast(userId: string, generation: number): string {
  return JSON.stringify({
    type: 'revocation_generation',
    version: BROKER_PROTOCOL_VERSION,
    userId,
    generation,
  });
}
