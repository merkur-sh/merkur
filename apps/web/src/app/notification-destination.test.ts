import { describe, expect, test } from 'bun:test';
import type { Device } from '@merkur/shared';
import { createRoot, createSignal, flush } from 'solid-js';
import { createNotificationDestination } from './notification-destination';

const machine: Device = {
  id: 'machine-b',
  userId: 'user-b',
  name: 'Workstation',
  platform: 'linux',
  status: 'online',
  lastSeen: 1,
  version: null,
  identitySealBackend: 'software',
};

function harness(initialHash = '#machine=machine-b') {
  const [devices, setDevices] = createSignal<readonly Device[] | null>(null);
  const location = {
    origin: 'https://app.merkur.test',
    pathname: '/',
    search: '?sw=on',
    hash: initialHash,
  };
  const events = new EventTarget();
  const controller = new MessageChannel().port1;
  const messages = Object.assign(new EventTarget(), { controller, startMessages() {} });
  const opened: string[] = [];
  const requested: string[] = [];
  const unavailable: (string | null)[] = [];
  const destination = createNotificationDestination({
    devices,
    location,
    events,
    messages,
    requested: (id) => requested.push(id),
    history: {
      state: { navigation: 'preserved' },
      replaceState: () => {
        location.hash = '';
      },
    },
    open: (device) => opened.push(device.id),
    unavailable: (device) => unavailable.push(device?.id ?? null),
  });
  return {
    destination,
    opened,
    requested,
    unavailable,
    location,
    events,
    message(id: string, source: MessagePort = controller) {
      messages.dispatchEvent(
        new MessageEvent('message', {
          origin: location.origin,
          source,
          data: { kind: 'notification_destination', url: `/#machine=${encodeURIComponent(id)}` },
        }),
      );
      flush();
    },
    setDevices(next: readonly Device[] | null) {
      setDevices(next);
      flush();
      destination.refresh();
    },
    click(hash: string) {
      location.hash = hash;
      events.dispatchEvent(new Event('hashchange'));
      flush();
    },
  };
}

describe('notification destination ownership', () => {
  test('worker messages retain the newest destination through boot and authentication', () => {
    createRoot((dispose) => {
      const state = harness('#machine=machine-a');
      state.message('machine-b');
      expect(state.requested).toEqual(['machine-a', 'machine-b']);
      expect(state.destination.hasPending()).toBe(true);
      expect(state.opened).toEqual([]);
      state.setDevices([machine]);
      expect(state.opened).toEqual(['machine-b']);
      dispose();
    });
  });

  test('only the controlling worker can publish a destination', () => {
    createRoot((dispose) => {
      const state = harness('');
      const other = new MessageChannel().port1;
      state.setDevices([machine]);
      state.message('machine-b', other);
      expect(state.opened).toEqual([]);
      state.message('machine-b');
      expect(state.opened).toEqual(['machine-b']);
      other.close();
      dispose();
      state.message('machine-b');
      expect(state.opened).toEqual(['machine-b']);
    });
  });

  test('retains a cold-launch destination across sign-in until the live account list exists', () => {
    createRoot((dispose) => {
      const state = harness();
      flush();
      expect(state.location.hash).toBe('');
      expect(state.destination.hasPending()).toBe(true);
      expect(state.opened).toEqual([]);
      state.setDevices([machine]);
      flush();
      expect(state.opened).toEqual(['machine-b']);
      expect(state.destination.hasPending()).toBe(false);
      state.setDevices([{ ...machine, name: 'Renamed' }]);
      flush();
      expect(state.opened).toEqual(['machine-b']);
      dispose();
    });
  });

  test('keeps the newest clicked destination while authentication or live updates are pending', () => {
    createRoot((dispose) => {
      const state = harness('#machine=machine-a');
      state.click('#machine=machine-b');
      state.setDevices([machine]);
      flush();
      expect(state.opened).toEqual(['machine-b']);
      dispose();
    });
  });

  test('does not open another account machine or silently replace an unavailable destination', () => {
    createRoot((dispose) => {
      const state = harness();
      state.setDevices([{ ...machine, id: 'machine-a', userId: 'user-a' }]);
      flush();
      expect(state.opened).toEqual([]);
      expect(state.unavailable).toEqual([null]);
      expect(state.destination.error()).toBe(
        'The notified machine is no longer linked to this account.',
      );
      expect(state.destination.hasPending()).toBe(false);
      state.setDevices([machine]);
      flush();
      expect(state.opened).toEqual([]);
      dispose();
    });
  });

  test('names an offline machine and permits a subsequent explicit notification after it returns', () => {
    createRoot((dispose) => {
      const state = harness();
      state.setDevices([{ ...machine, status: 'offline' }]);
      flush();
      expect(state.unavailable).toEqual(['machine-b']);
      expect(state.destination.error()).toBe('Workstation is offline.');
      state.setDevices([machine]);
      state.click('#machine=machine-b');
      expect(state.opened).toEqual(['machine-b']);
      expect(state.destination.error()).toBe('');
      dispose();
    });
  });

  test('explicit navigation cancels the pending destination and disposal removes its listener', () => {
    createRoot((dispose) => {
      const state = harness();
      state.destination.cancel();
      state.setDevices([machine]);
      flush();
      expect(state.opened).toEqual([]);
      dispose();
      state.click('#machine=machine-b');
      expect(state.destination.hasPending()).toBe(false);
    });
  });
});
