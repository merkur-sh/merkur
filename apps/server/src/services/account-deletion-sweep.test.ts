import { describe, expect, test } from 'bun:test';
import type { Logger } from '@merkur/logger';
import { Effect } from 'effect';

import { sweepDeletedAccountsEffect } from './account-deletion-sweep';
import { type AuthService, AuthServiceTag } from './auth-service';
import { BoxHostError, type BoxHostService, BoxHostServiceTag } from './box-host-service';
import { type AccountBoxes, type DeviceService, DeviceServiceTag } from './device-service';

interface SweepWorld {
  readonly due: readonly string[];
  readonly boxes: ReadonlyMap<string, AccountBoxes>;
  readonly refuse: ReadonlySet<string>;
}

interface SweepRecord {
  readonly removed: string[];
  readonly purged: string[];
  readonly logs: Array<{ readonly message: string; readonly context?: Record<string, unknown> }>;
}

function unexpected(name: string) {
  return () => Effect.die(new Error(`unexpected call: ${name}`));
}

function authService(world: SweepWorld, record: SweepRecord): AuthService {
  return {
    startAuth: unexpected('startAuth'),
    requestEmailCode: unexpected('requestEmailCode'),
    finishRegistration: unexpected('finishRegistration'),
    finishLogin: unexpected('finishLogin'),
    changePassword: unexpected('changePassword'),
    requestPasswordResetCode: unexpected('requestPasswordResetCode'),
    verifyPasswordResetCode: unexpected('verifyPasswordResetCode'),
    startPasswordReset: unexpected('startPasswordReset'),
    finishPasswordReset: unexpected('finishPasswordReset'),
    refresh: unexpected('refresh'),
    logout: unexpected('logout'),
    verifyBearerToken: unexpected('verifyBearerToken'),
    listBrowserSessions: unexpected('listBrowserSessions'),
    revokeBrowserSessions: unexpected('revokeBrowserSessions'),
    requireActiveDelegation: unexpected('requireActiveDelegation'),
    scheduleAccountDeletion: unexpected('scheduleAccountDeletion'),
    accountsDueForDeletion: () => Effect.succeed(world.due),
    purgeAccount: (userId) => Effect.sync(() => void record.purged.push(userId)),
  };
}

function deviceService(world: SweepWorld): DeviceService {
  return {
    listDevices: unexpected('listDevices'),
    getDevice: unexpected('getDevice'),
    createLinkToken: unexpected('createLinkToken'),
    resolveBox: unexpected('resolveBox'),
    listAccountBoxes: (userId) =>
      Effect.succeed(world.boxes.get(userId) ?? { owned: [], contested: [] }),
    getDaemonSessionIdentity: unexpected('getDaemonSessionIdentity'),
    renameDevice: unexpected('renameDevice'),
    deleteDevice: unexpected('deleteDevice'),
    authenticateDaemonProof: unexpected('authenticateDaemonProof'),
    touchDaemon: unexpected('touchDaemon'),
    touchDaemonsSeen: unexpected('touchDaemonsSeen'),
  };
}

function boxHostService(world: SweepWorld, record: SweepRecord): BoxHostService {
  return {
    createLinked: unexpected('createLinked'),
    start: unexpected('start'),
    remove: (boxId) =>
      world.refuse.has(boxId)
        ? Effect.fail(new BoxHostError({ operation: 'remove', message: 'down', status: 502 }))
        : Effect.sync(() => void record.removed.push(boxId)),
  };
}

function runSweep(world: SweepWorld): Promise<SweepRecord> {
  const record: SweepRecord = { removed: [], purged: [], logs: [] };
  const push = (message: string, context?: Record<string, unknown>): void => {
    record.logs.push({ message, ...(context === undefined ? {} : { context }) });
  };
  const logger: Logger = { info: push, warn: push, error: push };
  return Effect.runPromise(
    sweepDeletedAccountsEffect(logger).pipe(
      Effect.provideService(AuthServiceTag, authService(world, record)),
      Effect.provideService(DeviceServiceTag, deviceService(world)),
      Effect.provideService(BoxHostServiceTag, boxHostService(world, record)),
      Effect.as(record),
    ),
  );
}

describe('account deletion sweep', () => {
  test('an account whose machines are not boxes is erased without asking the host', async () => {
    const record = await runSweep({
      due: ['user-1'],
      boxes: new Map(),
      refuse: new Set(),
    });
    expect(record.removed).toEqual([]);
    expect(record.purged).toEqual(['user-1']);
  });

  test('owned boxes are destroyed before the rows; a contested box is left alone', async () => {
    const record = await runSweep({
      due: ['user-1'],
      boxes: new Map([['user-1', { owned: ['box-a'], contested: ['box-b'] }]]),
      refuse: new Set(),
    });
    expect(record.removed).toEqual(['box-a']);
    expect(record.purged).toEqual(['user-1']);
    expect(record.logs.map((log) => log.message)).toContain('account_deletion_box_contested');
  });

  test('a host that refuses a removal defers that account and only that account', async () => {
    const record = await runSweep({
      due: ['user-1', 'user-2'],
      boxes: new Map([
        ['user-1', { owned: ['box-a', 'box-down'], contested: [] }],
        ['user-2', { owned: ['box-c'], contested: [] }],
      ]),
      refuse: new Set(['box-down']),
    });
    expect(record.removed).toEqual(['box-a', 'box-c']);
    expect(record.purged).toEqual(['user-2']);
    expect(record.logs.map((log) => log.message)).toContain('account_deletion_deferred');
  });
});
