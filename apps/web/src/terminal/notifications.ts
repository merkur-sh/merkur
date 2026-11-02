import { localValue } from '@merkur/browser-storage';

import {
  deletePushSubscription,
  getPushVapidPublicKey,
  type PushSubscriptionPayload,
  savePushSubscription,
} from '../api';

/** Whether this device asked for push. The subscription itself is the browser's and the server's. */
const notificationsEnabled = localValue('merkur:terminal-notifications-enabled', (value) =>
  value === true ? true : null,
);

export type TerminalNotificationState =
  | 'unsupported'
  | 'not-installed'
  | 'denied'
  | 'off'
  | 'enabled';

export function loadTerminalNotificationState(): TerminalNotificationState {
  if (!supportsTerminalNotifications()) return 'unsupported';
  if (!isInstalledPwa()) return 'not-installed';
  if (Notification.permission === 'denied') return 'denied';
  return notificationsEnabled.read() === true ? 'enabled' : 'off';
}

/** Rebind an existing browser subscription to the account's current delegation. */
export async function restoreTerminalNotifications(
  accessToken: string,
): Promise<TerminalNotificationState> {
  const preference = loadTerminalNotificationState();
  if (preference !== 'enabled') return preference;
  if (Notification.permission !== 'granted') return 'off';
  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.getSubscription();
  if (subscription === null) return 'off';
  await savePushSubscription(accessToken, serializePushSubscription(subscription));
  return 'enabled';
}

export async function enableTerminalNotifications(
  accessToken: string,
): Promise<TerminalNotificationState> {
  if (!supportsTerminalNotifications()) return 'unsupported';
  if (!isInstalledPwa()) return 'not-installed';

  const permission =
    Notification.permission === 'default'
      ? await Notification.requestPermission()
      : Notification.permission;
  if (permission === 'denied') {
    notificationsEnabled.remove();
    return 'denied';
  }
  if (permission !== 'granted') {
    notificationsEnabled.remove();
    return 'off';
  }

  const vapid = await getPushVapidPublicKey(accessToken);
  if (vapid === null) {
    notificationsEnabled.remove();
    return 'off';
  }

  const registration = await navigator.serviceWorker.ready;
  const applicationServerKey = urlBase64ToUint8Array(vapid.publicKey);
  const existing = await registration.pushManager.getSubscription();
  if (existing !== null && !subscriptionUsesApplicationServerKey(existing, vapid.publicKey)) {
    await deletePushSubscription(accessToken, existing.endpoint).catch(() => undefined);
    await existing.unsubscribe().catch(() => undefined);
  }

  const current = await registration.pushManager.getSubscription();
  const subscription =
    current ??
    (await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey,
    }));

  await savePushSubscription(accessToken, serializePushSubscription(subscription));
  notificationsEnabled.write(true);
  return 'enabled';
}

export async function disableTerminalNotifications(
  accessToken: string,
): Promise<TerminalNotificationState> {
  if (!supportsTerminalNotifications()) return 'unsupported';
  if (!isInstalledPwa()) return 'not-installed';

  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.getSubscription();
  if (subscription !== null) {
    const [, unsubscribed] = await Promise.all([
      deletePushSubscription(accessToken, subscription.endpoint),
      subscription.unsubscribe(),
    ]);
    if (!unsubscribed && (await registration.pushManager.getSubscription()) !== null) {
      throw new Error('Push subscription is still active');
    }
  }

  notificationsEnabled.remove();
  return Notification.permission === 'denied' ? 'denied' : 'off';
}

function supportsTerminalNotifications(): boolean {
  return 'Notification' in window && 'serviceWorker' in navigator && 'PushManager' in window;
}

function isInstalledPwa(): boolean {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    (navigator as Navigator & { readonly standalone?: boolean }).standalone === true
  );
}

function subscriptionUsesApplicationServerKey(
  subscription: PushSubscription,
  publicKey: string,
): boolean {
  const existingKey = subscription.options.applicationServerKey;
  if (existingKey === null) return false;
  return arrayBufferToUrlBase64(toArrayBuffer(existingKey)) === publicKey;
}

function serializePushSubscription(subscription: PushSubscription): PushSubscriptionPayload {
  const p256dh = subscription.getKey('p256dh');
  const auth = subscription.getKey('auth');
  if (p256dh === null || auth === null) {
    throw new Error('Push subscription is missing encryption keys');
  }

  return {
    endpoint: subscription.endpoint,
    keys: {
      p256dh: arrayBufferToUrlBase64(p256dh),
      auth: arrayBufferToUrlBase64(auth),
    },
  };
}

function urlBase64ToUint8Array(value: string): ArrayBuffer {
  const padded = `${value}${'='.repeat((4 - (value.length % 4)) % 4)}`;
  const base64 = padded.replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) {
    out[i] = raw.charCodeAt(i);
  }
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
}

function toArrayBuffer(value: BufferSource): ArrayBuffer {
  if (value instanceof ArrayBuffer) return value;
  return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
}

function arrayBufferToUrlBase64(value: ArrayBuffer): string {
  const bytes = new Uint8Array(value);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i += 1) {
    binary += String.fromCharCode(bytes[i] ?? 0);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
