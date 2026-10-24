import { type Device, hasExactKeys, readNonEmptyStringField } from '@merkur/shared';
import { createSignal, onCleanup } from 'solid-js';
import { notificationMachineId, notificationTarget } from '../notification-route';

interface NotificationMessageQueue extends EventTarget {
  readonly controller: MessageEventSource | null;
  startMessages(): void;
}

interface NotificationDestinationOptions {
  /** Null until this account's machine snapshot is confirmed. */
  readonly devices: () => readonly Device[] | null;
  readonly requested: (deviceId: string) => void;
  readonly open: (device: Device) => void;
  readonly unavailable: (device: Device | null) => void;
  readonly location: Pick<Location, 'origin' | 'pathname' | 'search' | 'hash'>;
  readonly history: Pick<History, 'replaceState' | 'state'>;
  readonly events: EventTarget;
  readonly messages: NotificationMessageQueue | null;
}

/** A notification owns one destination across boot, authentication and list recovery. */
export function createNotificationDestination(options: NotificationDestinationOptions) {
  const [error, setError] = createSignal('');
  let pendingId: string | null = null;

  function takeAddress(): void {
    const { pathname, search, hash } = options.location;
    if (pathname !== '/' && pathname !== '/index.html') return;
    if (!hash.startsWith('#machine=')) return;
    const id = notificationMachineId(hash);
    options.history.replaceState(options.history.state, '', `${pathname}${search}`);
    if (id === null) return;
    requestMachine(id);
  }

  function requestMachine(id: string): void {
    pendingId = id;
    setError('');
    options.requested(id);
    refresh();
  }

  function receiveMessage(event: Event): void {
    if (
      !(event instanceof MessageEvent) ||
      event.source === null ||
      event.source !== options.messages?.controller ||
      event.origin !== options.location.origin
    )
      return;
    const message: unknown = event.data;
    if (!hasExactKeys(message, ['kind', 'url']) || message.kind !== 'notification_destination')
      return;
    const url = readNonEmptyStringField(message, 'url');
    if (url === null) return;
    const target = notificationTarget(url, options.location.origin);
    const id = target === null ? null : notificationMachineId(target.hash);
    if (id !== null) requestMachine(id);
  }

  takeAddress();
  options.events.addEventListener('hashchange', takeAddress);
  onCleanup(() => options.events.removeEventListener('hashchange', takeAddress));
  if (options.messages !== null) {
    // The platform retains boot-time messages until this listener is installed.
    options.messages.addEventListener('message', receiveMessage);
    options.messages.startMessages();
    onCleanup(() => options.messages?.removeEventListener('message', receiveMessage));
  }

  function refresh(): void {
    const devices = options.devices();
    if (pendingId === null || devices === null) return;
    const id = pendingId;
    pendingId = null;
    const device = devices.find((entry) => entry.id === id);
    if (device === undefined || device.status === 'offline') {
      setError(
        device === undefined
          ? 'The notified machine is no longer linked to this account.'
          : `${device.name} is offline.`,
      );
      options.unavailable(device ?? null);
      return;
    }
    options.open(device);
  }

  return {
    error,
    hasPending: () => pendingId !== null,
    refresh,
    cancel() {
      pendingId = null;
      setError('');
    },
  };
}
