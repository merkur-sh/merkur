import { isDevice } from './api-contract';
import {
  DEVICE_STATUS_DEGRADED,
  DEVICE_STATUS_OFFLINE,
  DEVICE_STATUS_ONLINE,
  type Device,
  type DeviceStatus,
} from './domain';
import { isRecord, readNonEmptyStringField } from './parsing';

/**
 * The device-list event stream.
 *
 * Every change to a user's device list is one `delta` frame carrying a per-user
 * sequence number assigned atomically with the transition that caused it. A
 * delta is **absolute** — the new status, the new name, the removed id, the
 * added row — so applying one twice is a no-op and at-least-once delivery needs
 * no further bookkeeping. `seq` exists for two things only: detecting a gap, and
 * resuming a stream without a snapshot when nothing changed while it was down.
 *
 * That second use is only sound while a sequence number means the same thing to
 * both ends, and a bare counter does not: the counter lives in Redis, which is
 * deliberately not durable here, so a Dragonfly restart or an eviction takes it
 * back to zero and it climbs again through the very transitions that rebuild
 * presence. A browser holding `5` from before the reset is then answered
 * `resume` — "nothing has changed" — against a counter that reached `5` by an
 * entirely different route, and it keeps rendering machines as online for as
 * long as nothing else happens to that account. Hence the **epoch**: an opaque
 * id minted with the counter and destroyed with it, so a counter that restarted
 * can never be mistaken for one that never moved. A cursor is the pair, and
 * only an exact match on both may skip the snapshot.
 */
export const DEVICE_EVENT_SNAPSHOT = 'snapshot';
export const DEVICE_EVENT_DELTA = 'delta';
export const DEVICE_EVENT_RESUME = 'resume';

/**
 * How often a device-events stream writes a keep-alive comment.
 *
 * The stream is otherwise silent for as long as nothing about the account's
 * devices changes, which can be hours. Those bytes are the only thing that
 * distinguishes a healthy quiet stream from a dead one, so the cadence is a
 * wire contract between the server that writes them and the browser that times
 * them out — not a server-local tuning knob.
 */
export const DEVICE_EVENTS_KEEPALIVE_MS = 15_000;

/**
 * How long a browser waits for *any* byte before declaring its stream dead.
 *
 * A TCP connection can be half-open — a mobile handover, a NAT rebind, a VPN
 * flap, a proxy that dropped the far side — with no error surfacing to `fetch`
 * for as long as the browser keeps the socket. Nothing else in the device-list
 * path bounds that: the reader simply never yields again, and the list goes on
 * rendering the presence it last heard about, which is how a machine that was
 * powered off an hour ago keeps a live green dot.
 *
 * Two missed keep-alives plus a margin for timer throttling and mobile
 * scheduling jitter — derived, not chosen, because the two numbers only mean
 * anything against each other and a drift between them is silent in both
 * directions. A false positive costs one reconnect, and a reconnect that finds
 * nothing changed is answered with a zero-byte `resume`; a false negative costs
 * a badge that lies for as long as the socket is held.
 */
export const DEVICE_EVENTS_STALL_TIMEOUT_MS = 2 * DEVICE_EVENTS_KEEPALIVE_MS + 5_000;

/** The browser's last applied cursor, `<epoch>:<seq>`; absent on a first open. */
export const DEVICE_EVENTS_SINCE_HEADER = 'x-merkur-device-events-since';

/**
 * Where a device-list stream has got to: which counter, and how far along it.
 *
 * Two cursors describe the same list state only when both halves match. An
 * epoch is opaque to the browser — it is minted by whoever creates the counter
 * and never interpreted, only compared.
 */
export interface DeviceEventsCursor {
  readonly epoch: string;
  readonly seq: number;
}

/** Lowercase hex, so the cursor's `:` separator can never appear inside it. */
const DEVICE_EVENTS_EPOCH_PATTERN = /^[0-9a-f]{1,64}$/;
const DEVICE_EVENTS_SEQ_PATTERN = /^(?:0|[1-9]\d*)$/;

export function formatDeviceEventsCursor(cursor: DeviceEventsCursor): string {
  return `${cursor.epoch}:${cursor.seq}`;
}

/**
 * Parses a `since` header value.
 *
 * Anything but an exact, whole cursor reads as "no resume", which costs a
 * snapshot and nothing else — the snapshot is always correct, so this never has
 * to guess at a half-understood value.
 */
export function parseDeviceEventsCursor(raw: string | null): DeviceEventsCursor | null {
  if (raw === null) return null;
  const separator = raw.indexOf(':');
  if (separator === -1) return null;
  const epoch = raw.slice(0, separator);
  const seqText = raw.slice(separator + 1);
  if (!DEVICE_EVENTS_EPOCH_PATTERN.test(epoch) || !DEVICE_EVENTS_SEQ_PATTERN.test(seqText)) {
    return null;
  }
  const seq = Number(seqText);
  return Number.isSafeInteger(seq) ? { epoch, seq } : null;
}

export function isDeviceEventsEpoch(value: unknown): value is string {
  return typeof value === 'string' && DEVICE_EVENTS_EPOCH_PATTERN.test(value);
}

export type DeviceEventDelta =
  | { readonly kind: 'presence'; readonly daemonId: string; readonly status: DeviceStatus }
  | { readonly kind: 'rename'; readonly deviceId: string; readonly name: string }
  | { readonly kind: 'remove'; readonly deviceId: string }
  | { readonly kind: 'added'; readonly device: Device };

export type DeviceDeltaFrame = DeviceEventDelta & { readonly seq: number };

export interface DeviceSnapshotFrame {
  readonly epoch: string;
  readonly seq: number;
  readonly devices: readonly Device[];
}

export interface DeviceResumeFrame {
  readonly epoch: string;
  readonly seq: number;
}

const SNAPSHOT_KEYS = ['epoch', 'seq', 'devices'] as const;
const RESUME_KEYS = ['epoch', 'seq'] as const;
const PRESENCE_DELTA_KEYS = ['seq', 'kind', 'daemonId', 'status'] as const;
const RENAME_DELTA_KEYS = ['seq', 'kind', 'deviceId', 'name'] as const;
const REMOVE_DELTA_KEYS = ['seq', 'kind', 'deviceId'] as const;
const ADDED_DELTA_KEYS = ['seq', 'kind', 'device'] as const;

/**
 * The three lease dispositions the server tracks collapse onto the wire's three
 * device statuses. `silent` (pings stopped, carrier up) and `suspended`
 * (carrier gone, lease held for resume) both read as degraded: down, but with
 * a lease the daemon can still come back to. No entry at all is offline.
 */
export function presenceStateToDeviceStatus(
  state: 'online' | 'silent' | 'suspended' | undefined,
): DeviceStatus {
  if (state === 'online') return DEVICE_STATUS_ONLINE;
  if (state === undefined) return DEVICE_STATUS_OFFLINE;
  return DEVICE_STATUS_DEGRADED;
}

export function isDeviceStatus(value: unknown): value is DeviceStatus {
  return (
    value === DEVICE_STATUS_ONLINE ||
    value === DEVICE_STATUS_DEGRADED ||
    value === DEVICE_STATUS_OFFLINE
  );
}

export function isDeviceSnapshotFrame(value: unknown): value is DeviceSnapshotFrame {
  return (
    isExactRecord(value, SNAPSHOT_KEYS) &&
    isDeviceEventsEpoch(value.epoch) &&
    isSequence(value.seq) &&
    Array.isArray(value.devices) &&
    value.devices.every(isDevice)
  );
}

export function isDeviceResumeFrame(value: unknown): value is DeviceResumeFrame {
  return (
    isExactRecord(value, RESUME_KEYS) && isDeviceEventsEpoch(value.epoch) && isSequence(value.seq)
  );
}

export function isDeviceDeltaFrame(value: unknown): value is DeviceDeltaFrame {
  if (!isRecord(value) || !isSequence(value.seq)) return false;
  switch (value.kind) {
    case 'presence':
      return (
        isExactRecord(value, PRESENCE_DELTA_KEYS) &&
        readNonEmptyStringField(value, 'daemonId') !== null &&
        isDeviceStatus(value.status)
      );
    case 'rename':
      return (
        isExactRecord(value, RENAME_DELTA_KEYS) &&
        readNonEmptyStringField(value, 'deviceId') !== null &&
        readNonEmptyStringField(value, 'name') !== null
      );
    case 'remove':
      return (
        isExactRecord(value, REMOVE_DELTA_KEYS) &&
        readNonEmptyStringField(value, 'deviceId') !== null
      );
    case 'added':
      return isExactRecord(value, ADDED_DELTA_KEYS) && isDevice(value.device);
    default:
      return false;
  }
}

/**
 * Reduces one absolute delta into a device list.
 *
 * Returns the same array when nothing changed, and keeps every untouched row
 * identical, so a renderer keyed on row identity rebuilds only what moved.
 * A `presence` or `rename` for an unknown device is dropped rather than
 * inventing a row: the snapshot is the only source of a full record.
 */
export function reduceDeviceDelta(
  devices: readonly Device[],
  delta: DeviceEventDelta,
): readonly Device[] {
  switch (delta.kind) {
    case 'presence': {
      const index = devices.findIndex((device) => device.id === delta.daemonId);
      const current = devices[index];
      if (current === undefined || current.status === delta.status) return devices;
      return replaceAt(devices, index, { ...current, status: delta.status });
    }
    case 'rename': {
      const index = devices.findIndex((device) => device.id === delta.deviceId);
      const current = devices[index];
      if (current === undefined || current.name === delta.name) return devices;
      return replaceAt(devices, index, { ...current, name: delta.name });
    }
    case 'remove': {
      const index = devices.findIndex((device) => device.id === delta.deviceId);
      if (index === -1) return devices;
      return [...devices.slice(0, index), ...devices.slice(index + 1)];
    }
    case 'added': {
      const index = devices.findIndex((device) => device.id === delta.device.id);
      if (index === -1) return [...devices, delta.device];
      return replaceAt(devices, index, delta.device);
    }
  }
}

function replaceAt(devices: readonly Device[], index: number, next: Device): readonly Device[] {
  const copy = devices.slice();
  copy[index] = next;
  return copy;
}

function isSequence(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isExactRecord(
  value: unknown,
  expectedKeys: readonly string[],
): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const actualKeys = Object.keys(value);
  return (
    actualKeys.length === expectedKeys.length &&
    expectedKeys.every((key) => Object.hasOwn(value, key))
  );
}
