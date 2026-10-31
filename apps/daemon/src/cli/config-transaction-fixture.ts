import '@merkur/shared/e2e-wasm-bun';
import { readSync } from 'node:fs';
import { transactDaemonConfigAtPath, withDaemonEnrollmentLockAtPath } from '@merkur/config';
import { Effect } from 'effect';

const [configPath, delegationId, mode] = process.argv.slice(2);
if (configPath === undefined || delegationId === undefined)
  throw new Error('Missing transaction input');
process.stdout.write('starting\n');
const transaction = transactDaemonConfigAtPath(configPath, (current) => {
  if (current === null) throw new Error('Missing config');
  process.stdout.write('locked\n');
  if (mode?.endsWith('hold')) {
    const release = new Uint8Array(1);
    if (readSync(0, release, 0, 1, null) !== 1) throw new Error('Missing transaction release');
  }
  return {
    ...current,
    revoked_delegations: [...current.revoked_delegations, { delegationId, expiresAt: 100 }].sort(
      (left, right) => left.delegationId.localeCompare(right.delegationId),
    ),
  };
});
await Effect.runPromise(
  mode?.startsWith('enrollment-')
    ? withDaemonEnrollmentLockAtPath(configPath, transaction)
    : transaction,
);
process.stdout.write('committed\n');
