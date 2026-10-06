import { createLogger } from '@merkur/logger';
import type { Device, MachineUsage } from '@merkur/shared';
import { Effect } from 'effect';
import { type Accessor, createSignal, onCleanup, useContext } from 'solid-js';

import { createLinkTokenEffect, deleteDevice, fetchServerVersion, renameDevice } from '../api';
import type { DeviceListStatus } from '../hooks/device-events-atoms';
import {
  applyLocalDeviceChange,
  browserPresenceAtom,
  browserSessionsChangedAtom,
  type DeviceEventsStreamFailure,
  deviceCursorAtom,
  deviceEventsAttemptsAtom,
  deviceEventsErrorAtom,
  deviceEventsRejectedTokenAtom,
  deviceEventsRotatedTokenAtom,
  deviceEventsStreamFailureAtom,
  deviceListStatusAtom,
  devicesAtom,
  deviceUserIdAtom,
  hasDeviceSnapshotAtom,
  publishDeviceEventsError,
  startDeviceEvents,
  stopDeviceEvents,
} from '../hooks/device-events-atoms';
import { deviceEventsAtom } from '../hooks/device-events-recovery';
import { RegistryContext, useAtomMount, useAtomValue } from '../lib/atom-solid';
import { clearCachedDeviceList } from '../lib/device-list-cache';
import { createLinkCommandRefresh } from './link-command-refresh';

const logger = createLogger('web');
const LINK_TOKEN_REFRESH_MARGIN_MS = 5_000;

interface StartDeviceListOptions {
  readonly refreshLink?: boolean;
}

export type { DeviceListStatus };
export type LinkCommandStatus = 'loading' | 'ready' | 'refreshing' | 'limited' | 'error';
export interface DeviceOperation {
  readonly deviceId: string;
  readonly kind: 'rename' | 'remove';
}

interface DeviceListControllerOptions {
  setAccessToken(next: string): void;
  onSessionRejected(): void;
  /** Another browser of this account signed in or was revoked. */
  onBrowserSessionsChanged(): void;
  /**
   * A device-events attempt ended owing the screen a frame.
   *
   * Reporting needs the account's telemetry consent and an access token, so the
   * loop publishes the fact and the app controller — which holds both — decides
   * whether it leaves this browser.
   */
  reportStreamFailure(kind: DeviceEventsStreamFailure['kind']): void;
}

export interface DeviceListController {
  readonly browserPresence: Accessor<readonly string[] | null>;
  readonly devices: Accessor<Device[]>;
  readonly deviceError: Accessor<string>;
  readonly deviceListStatus: Accessor<DeviceListStatus>;
  /** Stream attempts this page has begun; zero means the loop never ran. */
  readonly deviceListAttempts: Accessor<number>;
  readonly deviceOperation: Accessor<DeviceOperation | null>;
  readonly linkCommand: Accessor<string>;
  readonly machineUsage: Accessor<MachineUsage | null>;
  readonly linkCommandStatus: Accessor<LinkCommandStatus>;
  readonly serverVersion: Accessor<string | null>;
  start(token: string, userId: string, opts?: StartDeviceListOptions): Promise<void>;
  stop(): void;
  pauseLinkRefresh(): void;
  /** Drop the in-memory list and the persisted last-known cache (logout). */
  clearDevices(): void;
  refreshLink(token: string): Promise<void>;
  removeDevice(token: string, deviceId: string): Promise<void>;
  renameDevice(token: string, deviceId: string, name: string): Promise<void>;
}

export function createDeviceListController(
  options: DeviceListControllerOptions,
): DeviceListController {
  // The device list, its status, its error, and the boot barrier all live in
  // the atom registry, written by the recovery loop and read here. Solid keeps
  // only the state the loop has no opinion about.
  const registry = useContext(RegistryContext);
  const devices = useAtomValue(() => devicesAtom);
  const browserPresence = useAtomValue(() => browserPresenceAtom);
  const deviceError = useAtomValue(() => deviceEventsErrorAtom);
  const deviceListStatus = useAtomValue(() => deviceListStatusAtom);
  const deviceListAttempts = useAtomValue(() => deviceEventsAttemptsAtom);
  // Mount rather than read: the loop is an atom whose value nothing renders.
  useAtomMount(() => deviceEventsAtom);
  // A rotated credential belongs to the whole app, not just the device list.
  onCleanup(
    registry.subscribe(deviceEventsRotatedTokenAtom, (next) => {
      if (next === null) return;
      options.setAccessToken(next);
      if (linkAccessToken !== null) void refreshLink(next).catch(() => undefined);
    }),
  );
  onCleanup(
    registry.subscribe(deviceEventsStreamFailureAtom, (failure) => {
      if (failure !== null) options.reportStreamFailure(failure.kind);
    }),
  );

  onCleanup(
    registry.subscribe(deviceEventsRejectedTokenAtom, (token) => {
      if (token !== null) options.onSessionRejected();
    }),
  );
  onCleanup(
    registry.subscribe(browserSessionsChangedAtom, () => options.onBrowserSessionsChanged()),
  );

  const [deviceOperation, setDeviceOperation] = createSignal<DeviceOperation | null>(null);
  const [linkCommand, setLinkCommand] = createSignal('');
  const [machineUsage, setMachineUsage] = createSignal<MachineUsage | null>(null);
  let currentMachineUsage: MachineUsage | null = null;
  let linkAccessToken: string | null = null;
  let machineIds = '';
  const [linkCommandStatus, setLinkCommandStatus] = createSignal<LinkCommandStatus>('loading');
  const [serverVersion, setServerVersion] = createSignal<string | null>(null);
  let startGeneration = 0;
  // Solid 2 defers a setter's visibility to the next flush, so a signal read is
  // not a safe guard for control flow that writes and re-reads within a tick.
  // These plain mirrors carry the synchronous truth; the signals stay the
  // render-facing state.
  let currentLinkCommand = '';
  let currentOperation: DeviceOperation | null = null;

  function publishLinkCommand(command: string): void {
    currentLinkCommand = command;
    setLinkCommand(command);
  }

  function publishOperation(operation: DeviceOperation | null): void {
    currentOperation = operation;
    setDeviceOperation(operation);
  }

  const linkRefresh = createLinkCommandRefresh({
    refreshMarginMs: LINK_TOKEN_REFRESH_MARGIN_MS,
    createToken: (accessToken) => Effect.runPromise(createLinkTokenEffect(accessToken)),
    onToken: (token) => {
      currentMachineUsage = token.machineUsage;
      setMachineUsage(token.machineUsage);
    },
    onCommand: (command) => {
      publishLinkCommand(command);
      setLinkCommandStatus(atMachineLimit() ? 'limited' : command.length > 0 ? 'ready' : 'loading');
    },
    onAutoRefreshError: (error) => {
      logger.warn('link_command_auto_refresh_failed', { error: String(error) });
      setLinkCommandStatus('error');
      reportLinkCommandFailure();
    },
  });

  function atMachineLimit(): boolean {
    return (
      currentMachineUsage !== null &&
      currentMachineUsage.limit !== null &&
      currentMachineUsage.used >= currentMachineUsage.limit
    );
  }

  // Presence/rename updates cost no requests; additions and removals invalidate
  // account capacity in every open browser, including a local unlink.
  onCleanup(
    registry.subscribe(devicesAtom, (next) => {
      const ids = JSON.stringify(next.map((device) => device.id).sort());
      if (ids === machineIds) return;
      machineIds = ids;
      if (linkAccessToken === null) return;
      linkRefresh.stop();
      publishLinkCommand('');
      void refreshLink(linkAccessToken).catch(() => undefined);
    }),
  );

  // A link-command failure is not a device-stream failure: it publishes the
  // message without taking the list offline.
  function reportLinkCommandFailure(): void {
    registry.set(
      deviceEventsErrorAtom,
      'Unable to refresh the link command. Check your connection, then try again.',
    );
  }

  async function start(
    token: string,
    userId: string,
    opts: StartDeviceListOptions = {},
  ): Promise<void> {
    startGeneration = nextGeneration(startGeneration);
    const generation = startGeneration;
    try {
      // Keep the current (hydrated or previous) list on screen; the live
      // snapshot replaces it in place instead of flashing an empty list.
      pauseLinkRefresh();
      publishLinkCommand('');
      setLinkCommandStatus('loading');
      const ready = startDeviceEvents(registry, token, userId);
      if (serverVersion() === null) {
        // Best-effort: the update badge is suppressed without it.
        fetchServerVersion()
          .then((version) => setServerVersion(version))
          .catch((error: unknown) => {
            logger.warn('server_version_fetch_failed', { error: String(error) });
          });
      }
      if (opts.refreshLink !== false) {
        linkAccessToken = token;
        // Fire-and-forget: the link command must not gate the device-list paint.
        void linkRefresh.refresh(token).catch((error: unknown) => {
          logger.warn('link_command_refresh_failed', { error: String(error) });
          setLinkCommandStatus('error');
          reportLinkCommandFailure();
        });
      }
      await ready;
      if (generation !== startGeneration) return;
      // Nothing to retract here any more: a published error holds the list
      // offline until something clears it, and the only thing entitled to is
      // the stream itself — which does, on the `open` that proves the endpoint
      // accepts this credential.
      logger.info('device_events_started');
    } catch (error) {
      // An account ending or a replacement start retires this initial wait.
      // Its rejection must not publish an error into a later lifetime.
      if (generation !== startGeneration) return;
      logger.warn('device_events_start_failed', { error: String(error) });
      publishDeviceEventsError(
        registry,
        'Unable to start live machine updates. Check your connection, then try again.',
      );
      throw error;
    }
  }

  function stop(): void {
    startGeneration = nextGeneration(startGeneration);
    pauseLinkRefresh();
    stopDeviceEvents(registry);
  }

  function pauseLinkRefresh(): void {
    linkAccessToken = null;
    linkRefresh.stop();
    publishLinkCommand('');
    setLinkCommandStatus('loading');
  }

  onCleanup(stop);

  function clearDevices(): void {
    pauseLinkRefresh();
    currentMachineUsage = null;
    setMachineUsage(null);
    registry.set(browserPresenceAtom, null);
    registry.set(hasDeviceSnapshotAtom, false);
    registry.set(devicesAtom, []);
    // A retained cursor would let the next account's first open answer
    // `resume` onto an empty list.
    registry.set(deviceCursorAtom, null);
    registry.set(deviceUserIdAtom, null);
    // The account this belonged to is gone, and so is anything it was told.
    publishDeviceEventsError(registry, '');
    publishOperation(null);
    clearCachedDeviceList();
  }

  async function refreshLink(token: string): Promise<void> {
    linkAccessToken = token;
    setLinkCommandStatus(currentLinkCommand.length > 0 ? 'refreshing' : 'loading');
    try {
      const applied = await linkRefresh.refresh(token);
      if (applied) {
        setLinkCommandStatus(
          atMachineLimit() ? 'limited' : currentLinkCommand.length > 0 ? 'ready' : 'error',
        );
        registry.set(deviceEventsErrorAtom, '');
      }
    } catch (error) {
      logger.warn('link_command_refresh_failed', { error: String(error) });
      setLinkCommandStatus('error');
      reportLinkCommandFailure();
      throw error;
    }
  }

  async function removeDevice(token: string, deviceId: string): Promise<void> {
    if (currentOperation !== null) return;
    publishOperation({ deviceId, kind: 'remove' });
    try {
      await deleteDevice(token, deviceId);
      // Rebase on the registry rather than the Solid mirror: a device-events
      // update may have landed during the await and not flushed yet.
      applyLocalDeviceChange(
        registry,
        registry.get(devicesAtom).filter((device) => device.id !== deviceId),
      );
      registry.set(deviceEventsErrorAtom, '');
    } catch (error) {
      logger.warn('device_delete_failed', { error: String(error), deviceId });
      registry.set(
        deviceEventsErrorAtom,
        'Unable to remove that machine. Check your connection, then try again.',
      );
      throw error;
    } finally {
      publishOperation(null);
    }
  }

  async function renameLinkedDevice(token: string, deviceId: string, name: string): Promise<void> {
    if (currentOperation !== null) return;
    publishOperation({ deviceId, kind: 'rename' });
    try {
      await renameDevice(token, deviceId, name);
      applyLocalDeviceChange(
        registry,
        registry
          .get(devicesAtom)
          .map((device) => (device.id === deviceId ? { ...device, name } : device)),
      );
      registry.set(deviceEventsErrorAtom, '');
    } catch (error) {
      logger.warn('device_rename_failed', { error: String(error), deviceId });
      registry.set(
        deviceEventsErrorAtom,
        'Unable to rename that machine. Check your connection, then try again.',
      );
      throw error;
    } finally {
      publishOperation(null);
    }
  }

  return {
    browserPresence,
    devices,
    deviceError,
    deviceListStatus,
    deviceListAttempts,
    deviceOperation,
    linkCommand,
    machineUsage,
    linkCommandStatus,
    serverVersion,
    start,
    stop,
    pauseLinkRefresh,
    clearDevices,
    refreshLink,
    removeDevice,
    renameDevice: renameLinkedDevice,
  };
}

function nextGeneration(current: number): number {
  return current >= Number.MAX_SAFE_INTEGER ? 1 : current + 1;
}
