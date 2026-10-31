import { hasExactKeys, isRecord } from '@merkur/shared';
import { Predicate } from 'effect';

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

export interface BrokerDaemonWork {
  readonly type: 'daemon_work';
  readonly version: number;
  readonly daemonId: string;
  readonly ownerInstanceId: string;
}

export function daemonControlChannel(instanceId: string): string {
  return `merkur:daemon-control:instance:${instanceId}`;
}

export function parseDaemonWork(frame: string): BrokerDaemonWork | null {
  let value: ReturnType<typeof JSON.parse>;
  try {
    value = JSON.parse(frame);
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['type', 'version', 'daemonId', 'ownerInstanceId']) ||
    value.type !== 'daemon_work' ||
    value.version !== BROKER_PROTOCOL_VERSION ||
    !Predicate.isString(value.daemonId) ||
    value.daemonId.length === 0 ||
    !Predicate.isString(value.ownerInstanceId) ||
    value.ownerInstanceId.length === 0
  )
    return null;
  return {
    type: 'daemon_work',
    version: BROKER_PROTOCOL_VERSION,
    daemonId: value.daemonId,
    ownerInstanceId: value.ownerInstanceId,
  };
}
