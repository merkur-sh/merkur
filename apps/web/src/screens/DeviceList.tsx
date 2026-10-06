import { OUT_EASE } from '@merkur/quicksilver/motion';
import type { Device, MachineUsage } from '@merkur/shared';
import { animate, stagger } from 'motion';
import {
  type Component,
  createEffect,
  createMemo,
  createSignal,
  For,
  Match,
  onCleanup,
  onSettled,
  Show,
  Switch,
} from 'solid-js';

import type {
  DeviceListStatus,
  DeviceOperation,
  LinkCommandStatus,
} from '../app/createDeviceListController';
import MerkurOrb from '../components/MerkurOrb';
import StatusGlyph, { type MachineStatus } from '../components/StatusGlyph';
import { createKeybinds } from '../hooks/createKeybinds';
import { ariaBool } from '../lib/aria';
import { stepIndex } from '../lib/keybinds';
import { hintMotion, motionDuration } from '../lib/motion';
import { createOwnedTimeout } from '../lib/owned-scheduled-callback';
import { formatExactTime, formatLastSeenCompact } from '../lib/relative-time';
import { isReleaseVersionBehind } from '../lib/release-version';
import type { DeviceActionKind } from './DeviceActionDialog';

/** Per-row entrance step, and the total the whole cascade may occupy. */
const ROW_STAGGER_MAX_S = 0.03;
const ROW_CASCADE_BUDGET_S = 0.09;

/**
 * How long a status keeps being presented as current after the stream carrying
 * it stops being live.
 *
 * A reconnect — a foregrounded tab, a network change, a stream the server
 * rotated — is normally answered within a few hundred milliseconds by a
 * zero-byte `resume` that confirms every row. Greying the whole list out for
 * that would make an ordinary blink look like an outage. Past this, the list no
 * longer has anyone telling it these machines are up, and says so.
 */
const PRESENCE_STALE_GRACE_MS = 4_000;

/** How often "last seen" figures are recomputed while the list is on screen. */
const LAST_SEEN_TICK_MS = 30_000;

interface Props {
  connecting: boolean;
  devices: Device[];
  error: string;
  /** Whether this screen's route is the one on show, so its keys are live. */
  keysActive: boolean;
  listStatus: DeviceListStatus;
  linkCommand: string;
  machineUsage: MachineUsage | null;
  linkCommandStatus: LinkCommandStatus;
  operation: DeviceOperation | null;
  selectedDeviceId: string | null;
  serverVersion: string | null;
  onSelect: (device: Device) => void;
  onLogout: () => void;
  onOpenCreateBox: () => void;
  onOpenDeviceAction: (action: DeviceActionKind, device: Device) => void;
  onOpenLinkApproval: () => void;
  onStartDevice: (deviceId: string) => Promise<boolean>;
  onOpenSettings: () => void;
  onRefreshLink: () => void;
}

/**
 * Whether a row's status is being confirmed, and if not, whether anything is
 * still trying to.
 *
 * The glyph looks the same for the last two — a list that has not been
 * confirmed must not assert a machine is up, whoever is working on confirming
 * it — but they are not the same sentence. A reload starts a stream and reaches
 * its first frame a few hundred milliseconds later; saying "paused" across that
 * window announces a fault to describe a startup, which is exactly what the
 * grace below exists to stop a reconnect doing.
 */
type RowPresence = 'confirmed' | 'checking' | 'paused';

/** The state in words, for the glyph's accessible name. */
function statusLabel(status: MachineStatus, presence: RowPresence): string {
  const word =
    status === 'working'
      ? 'Working'
      : status === 'online'
        ? 'Online'
        : status === 'degraded'
          ? 'Down'
          : 'Off';
  if (status === 'working' || presence === 'confirmed') return word;
  return presence === 'checking'
    ? `${word} — last known, checking now`
    : `${word} — not confirmed, live updates are paused`;
}

const DeviceList: Component<Props> = (props) => {
  let sectionEl!: HTMLElement;
  const [openMenuDeviceId, setOpenMenuDeviceId] = createSignal<string | null>(null);
  const [copyState, setCopyState] = createSignal<'idle' | 'command' | 'error'>('idle');
  const [startingDeviceId, setStartingDeviceId] = createSignal<string | null>(null);

  async function startDevice(deviceId: string): Promise<void> {
    setStartingDeviceId(deviceId);
    setOpenMenuDeviceId(null);
    try {
      await props.onStartDevice(deviceId);
    } finally {
      // The row returns to online through the device stream, not from here.
      setStartingDeviceId(null);
    }
  }
  const copyFeedbackTimeout = createOwnedTimeout(
    (callback, delayMs) => window.setTimeout(callback, delayMs),
    (handle) => window.clearTimeout(handle),
  );
  onCleanup(() => copyFeedbackTimeout.cancel());

  // Whether anything is currently confirming the statuses on screen. A list
  // hydrated from the persisted cache starts unconfirmed however recent it
  // looks — it is a record of what was true when the app was last open, which
  // on a phone can be days.
  const [presenceVerified, setPresenceVerified] = createSignal(props.listStatus === 'live');
  const presenceGrace = createOwnedTimeout(
    (callback, delayMs) => window.setTimeout(callback, delayMs),
    (handle) => window.clearTimeout(handle),
  );
  onCleanup(() => presenceGrace.cancel());
  // Plain mirror, not the signal: this decides control flow inside the same
  // tick as the write above it, and Solid 2 defers a setter's visibility.
  let everVerified = props.listStatus === 'live';

  createEffect(
    () => props.listStatus,
    (status) => {
      if (status === 'live') {
        presenceGrace.cancel();
        everVerified = true;
        setPresenceVerified(true);
        return;
      }
      // Nothing has ever confirmed this list, so there is nothing to hold.
      if (!everVerified) {
        setPresenceVerified(false);
        return;
      }
      if (!presenceGrace.isArmed()) {
        presenceGrace.arm(() => setPresenceVerified(false), PRESENCE_STALE_GRACE_MS);
      }
    },
  );

  // Only `offline` means nobody is confirming these rows. Every other
  // unconfirmed status has a stream opening behind it, including the one a
  // reload starts with, so the row says it is checking rather than paused.
  const rowPresence = createMemo<RowPresence>(() =>
    presenceVerified() ? 'confirmed' : props.listStatus === 'offline' ? 'paused' : 'checking',
  );

  // "4 m" has to keep being true while the screen sits open. One coarse ticker
  // for the whole list, armed only while a row could be showing one.
  const [nowMs, setNowMs] = createSignal(Date.now());
  const lastSeenTick = createOwnedTimeout(
    (callback, delayMs) => window.setTimeout(callback, delayMs),
    (handle) => window.clearTimeout(handle),
  );
  onCleanup(() => lastSeenTick.cancel());
  createEffect(
    () => props.devices.length > 0,
    (hasRows) => {
      if (!hasRows) {
        lastSeenTick.cancel();
        return;
      }
      const tick = (): void => {
        setNowMs(Date.now());
        lastSeenTick.arm(tick, LAST_SEEN_TICK_MS);
      };
      lastSeenTick.arm(tick, LAST_SEEN_TICK_MS);
      return () => lastSeenTick.cancel();
    },
  );

  const isConnecting = (device: Device): boolean =>
    props.connecting && props.selectedDeviceId === device.id;
  const operationFor = (device: Device): DeviceOperation['kind'] | null =>
    props.operation?.deviceId === device.id ? props.operation.kind : null;

  /**
   * Which glyph the row's status column carries.
   *
   * Anything this browser has in flight — a connect, a start, a rename, a
   * removal — outranks the machine's own presence, because it is the newer fact
   * and the one the reader is waiting on.
   */
  function rowStatus(device: Device): MachineStatus {
    if (isConnecting(device) || startingDeviceId() === device.id || operationFor(device) !== null) {
      return 'working';
    }
    return device.status;
  }

  /**
   * What the row says under the name: what this machine is, or what is
   * happening to it. The platform and the daemon build are the two facts that
   * do not change from second to second, which is what makes them worth a
   * permanent line; everything transient is in the glyph and the figure.
   */
  function rowSubtitle(device: Device): string {
    if (startingDeviceId() === device.id) return 'Starting…';
    // `isConnecting` is this browser's own connect attempt; `degraded` is the
    // daemon's link to the server. Distinct words for distinct facts.
    if (isConnecting(device)) return 'Connecting…';
    const operation = operationFor(device);
    if (operation === 'rename') return 'Renaming…';
    if (operation === 'remove') return 'Removing…';
    const custody = { hardware: 'hardware key', software: 'key on disk' }[
      device.identitySealBackend
    ];
    return `${device.platform}${device.version === null ? '' : ` · ${device.version}`} · ${custody}`;
  }

  /**
   * The row's right-hand figure: how long ago this machine was last heard from.
   *
   * A machine that is up right now is being seen, and its figure is small
   * rather than absent — one column, one meaning, read straight down. An em
   * dash is the only other value, and it means the server has never heard from
   * this daemon at all.
   */
  function rowAge(device: Device): string {
    return device.lastSeen === null ? '—' : formatLastSeenCompact(device.lastSeen, nowMs());
  }

  async function copyToClipboard(
    value: string,
    elementId: string,
    copied: 'command',
  ): Promise<void> {
    if (value.length === 0) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopyState(copied);
    } catch {
      const element = document.getElementById(elementId);
      if (element !== null) {
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(element);
        selection?.removeAllRanges();
        selection?.addRange(range);
      }
      setCopyState('error');
    }
    copyFeedbackTimeout.arm(() => setCopyState('idle'), 1_800);
  }

  const copyLinkCommand = (): Promise<void> =>
    copyToClipboard(props.linkCommand, 'link-command', 'command');

  const duplicateCounts = createMemo(() => {
    const counts = new Map<string, number>();
    for (const device of props.devices) {
      const key = deviceKey(device);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  });

  const hasDuplicate = (device: Device): boolean =>
    (duplicateCounts().get(deviceKey(device)) ?? 0) > 1;

  const hasUpdateAvailable = (device: Device): boolean =>
    isReleaseVersionBehind(device.version, props.serverVersion);

  createEffect(
    () => openMenuDeviceId(),
    (openId) => {
      if (openId === null) return;

      const closeFromOutside = (event: PointerEvent): void => {
        const target = event.target;
        if (!(target instanceof Element)) return;
        const menuRoot = target.closest<HTMLElement>('[data-device-menu-root]');
        if (menuRoot?.dataset.deviceMenuRoot !== openId) setOpenMenuDeviceId(null);
      };
      const closeFromEscape = (event: KeyboardEvent): void => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        setOpenMenuDeviceId(null);
        document.getElementById(`device-menu-button-${openId}`)?.focus();
      };

      document.addEventListener('pointerdown', closeFromOutside);
      document.addEventListener('keydown', closeFromEscape);
      return () => {
        document.removeEventListener('pointerdown', closeFromOutside);
        document.removeEventListener('keydown', closeFromEscape);
      };
    },
  );

  function toggleMenu(deviceId: string): void {
    const willOpen = openMenuDeviceId() !== deviceId;
    setOpenMenuDeviceId(willOpen ? deviceId : null);
    if (willOpen) {
      queueMicrotask(() => {
        document
          .getElementById(`device-menu-${deviceId}`)
          ?.querySelector<HTMLElement>('[role="menuitem"]')
          ?.focus();
      });
    }
  }

  // The open menu owns `j`/`k` for as long as it is open, and says so by
  // stopping propagation before the app's keyboard layer sees the press. Keys
  // it does not handle keep bubbling on purpose: `r` and `x` mean the same
  // thing here as they do on the row behind it.
  function onMenuKeyDown(event: KeyboardEvent): void {
    const delta = event.key === 'j' ? 1 : event.key === 'k' ? -1 : null;
    if (delta === null) return;
    const menu = event.currentTarget as HTMLElement;
    const items = Array.from(menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'));
    const nextIndex = stepIndex(
      items.length,
      items.indexOf(document.activeElement as HTMLButtonElement),
      delta,
    );
    if (nextIndex === null) return;
    event.preventDefault();
    event.stopPropagation();
    items[nextIndex]?.focus();
  }

  // The row cursor *is* DOM focus. Each row contributes its first enabled
  // control, so an online row hands over its connect button and an offline or
  // mid-operation row hands over its actions button — `j`/`k` never land on
  // something that cannot be activated, and `Enter`/`Space` stay native.
  function rowFocusTargets(): HTMLButtonElement[] {
    const rows = Array.from(sectionEl.querySelectorAll<HTMLElement>('[data-device-row]'));
    const targets: HTMLButtonElement[] = [];
    for (const row of rows) {
      const target = row.querySelector<HTMLButtonElement>('button:not(:disabled)');
      if (target !== null) targets.push(target);
    }
    return targets;
  }

  function moveCursor(delta: 1 | -1): void {
    const targets = rowFocusTargets();
    const current = focusedTarget();
    const nextIndex = stepIndex(
      targets.length,
      current === null ? -1 : targets.indexOf(current),
      delta,
    );
    if (nextIndex === null) return;
    targets[nextIndex]?.focus();
  }

  function jumpCursor(edge: 'first' | 'last'): void {
    const targets = rowFocusTargets();
    (edge === 'first' ? targets[0] : targets.at(-1))?.focus();
  }

  // Hover moves the cursor instead of drawing a second highlight — the same
  // bargain the command palette makes: exactly one row is "here", and the
  // pointer and `j`/`k` are two ways of saying which. `pointermove` rather than
  // `pointerenter`, so a row arriving under a still pointer (a cascade, a
  // status change resizing a row above) cannot take the cursor away from the
  // keys; it moves only when the pointer does.
  function moveCursorTo(row: HTMLElement): void {
    // An open menu owns focus until it closes. Pulling focus to the row behind
    // it on a stray pointer move would dismiss it mid-aim.
    if (openMenuDeviceId() !== null) return;
    if (cursorRowId() === row.dataset.deviceRow) return;
    // Hovered means on screen, so there is nothing to scroll into view and a
    // scroll here would only fight the pointer.
    row.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true });
  }

  function focusedTarget(): HTMLButtonElement | null {
    const active = document.activeElement;
    return active instanceof HTMLButtonElement && sectionEl.contains(active) ? active : null;
  }

  // The cursor is DOM focus, and the row tint is how it shows: mirror focus
  // into a signal so the row can wear the same highlight the pointer gets on
  // hover, instead of an outline drawn inside it. `focusin`/`focusout` bubble,
  // so one pair of listeners on the section covers every row and every control
  // inside one — including an open actions menu, which is still that row.
  const [cursorRowId, setCursorRowId] = createSignal<string | null>(null);

  onSettled(() => {
    const onFocusIn = (event: FocusEvent): void => {
      const target = event.target;
      const row =
        target instanceof Element ? target.closest<HTMLElement>('[data-device-row]') : null;
      setCursorRowId(row?.dataset.deviceRow ?? null);
    };
    const onFocusOut = (event: FocusEvent): void => {
      // A move within the list is answered by the `focusin` that follows.
      const next = event.relatedTarget;
      if (next instanceof Node && sectionEl.contains(next)) return;
      setCursorRowId(null);
    };

    sectionEl.addEventListener('focusin', onFocusIn);
    sectionEl.addEventListener('focusout', onFocusOut);
    return () => {
      sectionEl.removeEventListener('focusin', onFocusIn);
      sectionEl.removeEventListener('focusout', onFocusOut);
    };
  });

  /** The machine the cursor is on, which is the row containing focus. */
  function cursorDevice(): Device | null {
    const row = focusedTarget()?.closest<HTMLElement>('[data-device-row]');
    const id = row?.dataset.deviceRow;
    return props.devices.find((device) => device.id === id) ?? null;
  }

  function withCursorDevice(act: (device: Device) => void): () => void {
    return () => {
      const device = cursorDevice();
      if (device !== null) act(device);
    };
  }

  // A list without a cursor makes every row action a dead key, so the list
  // takes one as soon as it has rows and the route is showing.
  //
  // Deferred a microtask because the effect runs on the same turn as the write
  // that grew the list, before `For` has put the rows in the document — the
  // same reason `toggleMenu` defers reaching for its first menu item. And only
  // taken when nothing inside the list already holds focus, so it cannot yank
  // focus back from a header button the user just tabbed to.
  createEffect(
    () => props.keysActive && props.devices.length > 0,
    (ready) => {
      if (!ready) return;
      queueMicrotask(() => {
        const active = document.activeElement;
        if (active instanceof Element && sectionEl.contains(active)) return;
        // Prefer the machine this browser is connected to. Returning from a
        // terminal, that is the row the highlight belongs on and the one
        // `Enter` should reconnect; parking the cursor on the first row would
        // put the highlight somewhere the user never chose.
        const targets = rowFocusTargets();
        const selectedId = props.selectedDeviceId;
        const selected =
          selectedId === null
            ? undefined
            : targets.find(
                (target) =>
                  target.closest<HTMLElement>('[data-device-row]')?.dataset.deviceRow ===
                  selectedId,
              );
        (selected ?? targets[0])?.focus();
      });
    },
  );

  createKeybinds({
    title: 'Machines',
    active: () => props.keysActive,
    bindings: [
      { keys: 'j', label: 'Next machine', keyOnly: true, run: () => moveCursor(1) },
      { keys: 'k', label: 'Previous machine', keyOnly: true, run: () => moveCursor(-1) },
      { keys: 'g g', label: 'First machine', keyOnly: true, run: () => jumpCursor('first') },
      { keys: 'G', label: 'Last machine', keyOnly: true, run: () => jumpCursor('last') },
      {
        keys: 'o',
        label: 'Connect to machine',
        keyOnly: true,
        run: withCursorDevice((device) => {
          if (device.status === 'offline') void startDevice(device.id);
          else props.onSelect(device);
        }),
      },
      {
        keys: 's',
        label: 'Start machine',
        keyOnly: true,
        run: withCursorDevice((device) => void startDevice(device.id)),
      },
      {
        keys: 'r',
        label: 'Rename machine',
        keyOnly: true,
        run: withCursorDevice((device) => openDeviceAction('rename', device)),
      },
      {
        keys: 'x',
        label: 'Remove machine',
        keyOnly: true,
        run: withCursorDevice((device) => openDeviceAction('remove', device)),
      },
      { keys: 'n', label: 'New box', run: () => props.onOpenCreateBox() },
      { keys: 'a', label: 'Approve link code', run: () => props.onOpenLinkApproval() },
      { keys: 'y', label: 'Copy link command', run: () => void copyLinkCommand() },
      { keys: 'R', label: 'Refresh link command', run: () => props.onRefreshLink() },
    ],
  });

  function openDeviceAction(action: DeviceActionKind, device: Device): void {
    setOpenMenuDeviceId(null);
    // Focus the trigger before the overlay opens. The overlay host captures
    // the active element to restore focus to on close, and the menu item that
    // holds focus right now unmounts with the menu.
    document.getElementById(`device-menu-button-${device.id}`)?.focus();
    props.onOpenDeviceAction(action, device);
  }

  // True only while the section-wide fade below is still running.
  let entranceFading = true;

  // Screen entrance. Only the section animates opacity: nested opacity
  // animations multiply, so the rails and rows below move on transform alone
  // and inherit this one fade.
  onSettled(() => {
    const entrance = animate(
      sectionEl,
      {
        opacity: [0, 1],
        transform: ['translateY(14px)', 'translateY(0px)'],
      },
      {
        duration: motionDuration(0.18),
        ease: OUT_EASE,
      },
    );
    hintMotion([sectionEl], entrance);
    const clearFading = (): void => {
      entranceFading = false;
    };
    entrance.finished.then(clearFading, clearFading);

    const railTargets = Array.from(sectionEl.querySelectorAll<HTMLElement>('[data-rail-fade]'));
    const railMotion = animate(
      railTargets,
      {
        transform: ['translateY(8px)', 'translateY(0px)'],
      },
      {
        duration: motionDuration(0.16),
        ease: OUT_EASE,
        delay: stagger(motionDuration(0.025, 0)),
      },
    );
    hintMotion(railTargets, railMotion);

    return () => {
      entrance.stop();
      railMotion.stop();
    };
  });

  // Rows cannot be wired at mount: on a cold start the list is still a
  // skeleton then, so querying rows there finds nothing. Cascade them once,
  // the first render that actually has devices.
  let rowsAnimated = false;
  let rowMotion: ReturnType<typeof animate> | null = null;
  onCleanup(() => rowMotion?.stop());

  createEffect(
    () => props.devices.length,
    (deviceCount) => {
      if (rowsAnimated || deviceCount === 0) return;
      const rows = Array.from(sectionEl.querySelectorAll<HTMLElement>('.device-row'));
      if (rows.length === 0) return;

      rowsAnimated = true;
      // A fixed per-row step makes the cascade scale with the machine count: at
      // 30ms a ten-machine list finished 270ms after the first row, so the list
      // felt slower the more you owned. Divide a fixed budget across the rows
      // instead, so the whole cascade always lands within it.
      const rowStagger = Math.min(
        ROW_STAGGER_MAX_S,
        ROW_CASCADE_BUDGET_S / Math.max(1, rows.length - 1),
      );
      // Cached devices render during the section fade, so rows move on transform
      // alone to avoid multiplying it. On a cold start they arrive after that
      // fade has finished and need their own, or they pop in at full opacity.
      rowMotion = animate(
        rows,
        entranceFading
          ? { transform: ['translateX(-8px)', 'translateX(0px)'] }
          : { opacity: [0, 1], transform: ['translateX(-8px)', 'translateX(0px)'] },
        {
          duration: motionDuration(0.14),
          ease: OUT_EASE,
          delay: stagger(motionDuration(rowStagger, 0)),
        },
      );
      hintMotion(rows, rowMotion);
    },
  );

  return (
    <section ref={sectionEl} id="device-list" class="app-frame">
      <header
        class="flex h-14 shrink-0 items-center gap-2 border-b border-solid border-line1 pl-4 pr-3"
        data-rail-fade
      >
        {/* The mark and the name, both shared elements of the sign-in
            entrance and the sign-out exit: the orb and the wordmark on the
            sign-in card travel to these two slots rather than fading out and
            in, and travel back when the session ends. */}
        <span class="flex items-center gap-[10px]">
          <MerkurOrb size={22} class="vt-orb" />
          <span class="wordmark-sm vt-wordmark">Merkur</span>
        </span>
        <span class="flex-1" />
        <button type="button" onClick={props.onOpenSettings} class="btn-quiet btn-sm">
          {/* A cog, not a circle with eight ticks around it — at 13px that
              reads as a sun, which is what a brightness control looks like. */}
          <svg
            aria-hidden="true"
            viewBox="0 0 24 24"
            class="h-[14px] w-[14px]"
            fill="none"
            stroke="currentColor"
            stroke-width="1.9"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2Z" />
            <circle cx="12" cy="12" r="3" />
          </svg>
          Settings
        </button>
        {/* The way out is one press from the home screen rather than three taps
            into a settings tab: it is the only action here that ends the
            session. */}
        <button
          type="button"
          onClick={props.onLogout}
          aria-label="Log out"
          title="Log out"
          class="btn-icon h-[30px] w-[30px]"
        >
          <svg
            aria-hidden="true"
            viewBox="0 0 24 24"
            class="h-[15px] w-[15px]"
            fill="none"
            stroke="currentColor"
            stroke-width="1.8"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path d="M15 4H8a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h7" />
            <path d="M10 12h11m0 0-3.5-3.5M21 12l-3.5 3.5" />
          </svg>
        </button>
      </header>

      <div
        class="app-pane"
        data-rail-fade
        aria-busy={ariaBool(
          props.listStatus === 'initial-loading' || props.listStatus === 'refreshing',
        )}
      >
        {/* No badge here, deliberately. Whether these rows are being confirmed
            is a fact about each row, and each row already carries it: an
            unconfirmed glyph is hollow, and it waits out
            `PRESENCE_STALE_GRACE_MS` first, so an ordinary reconnect changes
            nothing on screen. A header chip read the raw status instead, which
            made it the one voice with no grace — it announced every foregrounded
            tab and every network change for the ~150 ms a reopen takes, several
            times an hour, which is how an indicator teaches people not to read
            it. A fault that is not merely a reconnect publishes the message
            below, where an explanation belongs. */}
        <div class="flex items-center justify-between pb-1 pl-4 pr-3 pt-[14px]">
          <p class="eyebrow">Machines</p>
          <button
            type="button"
            onClick={props.onOpenCreateBox}
            aria-label="New box"
            title="New box"
            class="btn-icon h-[26px] w-[26px] border-transparent"
          >
            <svg
              aria-hidden="true"
              viewBox="0 0 16 16"
              class="h-[13px] w-[13px]"
              fill="none"
              stroke="currentColor"
              stroke-width="1.6"
              stroke-linecap="round"
            >
              <path d="M8 3.5v9M3.5 8h9" />
            </svg>
          </button>
        </div>

        <Show when={props.error.length > 0}>
          <div class="alert-bad mx-4 mb-2">{props.error}</div>
        </Show>

        <Switch>
          <Match when={props.devices.length > 0}>
            {/* 3px of padding so a row's 2px focus ring is not sheared by the
                scroller's own edge. */}
            <div class="flex flex-col px-[5px] py-[3px]">
              <For each={props.devices}>
                {(device) => (
                  <div
                    data-device-row={device.id}
                    onPointerMove={(event) => moveCursorTo(event.currentTarget)}
                    class={[
                      'device-row pr-3',
                      {
                        'is-cursor bg-cursor shadow-cursor': cursorRowId() === device.id,
                        // The row's entrance animation leaves an identity
                        // transform on it, and any transform but `none` makes
                        // the row a stacking context — which traps its own
                        // menu inside it, so the rows BELOW painted their
                        // last-seen figure and their own dots straight over
                        // the open menu. Raising the whole row for as long as
                        // it owns a menu lifts the menu with it.
                        'z-20': openMenuDeviceId() === device.id,
                      },
                    ]}
                  >
                    <button
                      type="button"
                      // No focus ring: the row's own highlight is this button's
                      // focus indicator, and drawing both put a rectangle
                      // inside a bar that already says the same thing.
                      class="grid min-w-0 flex-1 cursor-pointer grid-cols-[14px_minmax(0,1fr)_auto] items-center gap-x-3 border-none bg-transparent px-3 py-[9px] text-left outline-none transition-opacity duration-fast active:opacity-75 motion-reduce:transition-none"
                      disabled={
                        isConnecting(device) ||
                        operationFor(device) !== null ||
                        startingDeviceId() === device.id
                      }
                      title={
                        device.status === 'offline'
                          ? `Start ${device.name}`
                          : `Connect to ${device.name}`
                      }
                      // One click does the obvious thing for the row's state:
                      // connect when it is reachable, start it when it is not. A
                      // stopped box otherwise looks dead, which is exactly how
                      // the reaper used to strand one.
                      //
                      // A degraded daemon connects rather than starts: its lease
                      // is still held, so the machine is running and starting it
                      // would POST against a box that is already up. Connecting
                      // while the carrier is away still fails with a 503 until it
                      // reattaches — the command is refused, not parked.
                      onClick={() =>
                        device.status === 'offline'
                          ? void startDevice(device.id)
                          : props.onSelect(device)
                      }
                    >
                      <StatusGlyph
                        status={rowStatus(device)}
                        confirmed={presenceVerified()}
                        label={statusLabel(rowStatus(device), rowPresence())}
                      />
                      <span class="flex min-w-0 flex-col gap-[2px]">
                        <span class="flex min-w-0 items-center gap-2">
                          <span class="row-name">{device.name}</span>
                          <Show when={hasDuplicate(device)}>
                            <span class="chip-warn h-[17px] shrink-0 px-[6px] text-[10px]">
                              duplicate
                            </span>
                          </Show>
                          <Show when={hasUpdateAvailable(device)}>
                            <span
                              class="chip-accent h-[17px] shrink-0 px-[6px] text-[10px]"
                              title={`Daemon ${device.version} · server ${props.serverVersion}. Run "merkur update" on the machine.`}
                            >
                              ↑ {props.serverVersion}
                            </span>
                          </Show>
                        </span>
                        <span class="row-meta">{rowSubtitle(device)}</span>
                      </span>
                      <span
                        class="row-num"
                        title={
                          device.lastSeen === null
                            ? undefined
                            : `Last seen ${formatExactTime(device.lastSeen)}`
                        }
                      >
                        {rowAge(device)}
                      </span>
                    </button>

                    <div class="relative shrink-0" data-device-menu-root={device.id}>
                      <button
                        id={`device-menu-button-${device.id}`}
                        type="button"
                        aria-haspopup="menu"
                        aria-expanded={ariaBool(openMenuDeviceId() === device.id)}
                        aria-controls={`device-menu-${device.id}`}
                        aria-label={`Machine actions for ${device.name}`}
                        disabled={isConnecting(device) || props.operation !== null}
                        class="focusable grid h-6 w-4 cursor-pointer place-items-center border-none bg-transparent text-[14px] leading-none text-faint transition-[color] duration-tint hover:text-ink motion-reduce:transition-none"
                        onClick={() => toggleMenu(device.id)}
                      >
                        ⋯
                      </button>
                      <Show when={openMenuDeviceId() === device.id}>
                        <div
                          id={`device-menu-${device.id}`}
                          role="menu"
                          aria-label={`Actions for ${device.name}`}
                          onKeyDown={onMenuKeyDown}
                          class="menu absolute right-0 top-6 z-10 origin-top-right animate-[menu-in_140ms_cubic-bezier(0.23,1,0.32,1)] motion-reduce:animate-none"
                        >
                          <button
                            type="button"
                            role="menuitem"
                            class="btn-menuitem"
                            onClick={() => openDeviceAction('rename', device)}
                          >
                            Rename <span class="kbd">r</span>
                          </button>
                          <div class="menu-sep" />
                          {/* A destructive action is not a row. Rows are
                              navigation, and a row that deletes something must
                              not look like a row that opens something, so it
                              leaves the row vocabulary for a formed button
                              below the separator. */}
                          {/* No horizontal inset, and the same 9px of padding
                              the rows above use: a formed button with the
                              menu-item's own padding puts its key cap on the
                              same vertical line as theirs, which is the only
                              thing in a two-item menu the eye has to compare. */}
                          <div class="pt-1">
                            <button
                              type="button"
                              role="menuitem"
                              class="btn-danger btn-sm w-full justify-between px-[9px]"
                              onClick={() => openDeviceAction('remove', device)}
                            >
                              Remove <span class="kbd">x</span>
                            </button>
                          </div>
                        </div>
                      </Show>
                    </div>
                  </div>
                )}
              </For>
            </div>
          </Match>

          <Match when={props.listStatus === 'initial-loading'}>
            <DeviceListSkeleton />
          </Match>

          {/* The two states with no rows are the two places the display
              register appears on this screen: one element, the lead sentence
              in the serif and the deck in meta, so the screen has a headline
              without a second block of type. */}
          <Match when={props.listStatus === 'offline'}>
            <div class="flex min-h-[240px] flex-col items-center justify-center px-8 text-center">
              <p class="display-md max-w-[24ch]">
                <span class="headline-lead">Machines are unavailable.</span>{' '}
                <span class="headline-deck">
                  Merkur will resume live updates when the connection returns.
                </span>
              </p>
            </div>
          </Match>

          <Match when={true}>
            <div class="flex min-h-[200px] flex-col items-center justify-center px-7 pb-9 pt-11 text-center">
              <p class="display-md max-w-[24ch]">
                <span class="headline-lead">Connect your first machine.</span>{' '}
                <span class="headline-deck">
                  Run the setup command below on the computer you want to access.
                </span>
              </p>
            </div>
          </Match>
        </Switch>
      </div>

      <Show when={props.machineUsage}>
        {(usage) => (
          <div class="shrink-0 px-3 py-2 text-[11px] text-meta" role="status" data-machine-usage>
            {usage().limit === null
              ? `${usage().used} machines · Unlimited`
              : `${usage().used} / ${usage().limit} machine slots used`}
          </div>
        )}
      </Show>
      <AddMachineFooter
        copyState={copyState()}
        hasDevices={props.devices.length > 0}
        linkCommand={props.linkCommand}
        linkCommandStatus={props.linkCommandStatus}
        onApprove={props.onOpenLinkApproval}
        onCopyCommand={() => void copyLinkCommand()}
        onRefresh={props.onRefreshLink}
      />
    </section>
  );
};

export default DeviceList;

function deviceKey(device: Device): string {
  return `${device.name}/${device.platform}`;
}

/**
 * The bottom edge of the machine list: what the keys do here, and — folded
 * behind it — how to add a machine.
 *
 * Linking is a once-a-month action that used to occupy a fifth of the screen
 * permanently, so it shares the hint bar's line as a disclosure rather than
 * standing as a panel of its own. It opens itself when there are no machines,
 * because then it is not a secondary action, it is the only one.
 */
const AddMachineFooter: Component<{
  readonly copyState: 'idle' | 'command' | 'error';
  readonly hasDevices: boolean;
  readonly linkCommand: string;
  readonly linkCommandStatus: LinkCommandStatus;
  onApprove(): void;
  onCopyCommand(): void;
  onRefresh(): void;
}> = (props) => (
  <details class="shrink-0" open={!props.hasDevices} data-rail-fade data-add-machine>
    <summary class="cursor-pointer select-none">
      <div class="hintbar">
        <Show
          when={props.hasDevices}
          fallback={
            <span class="hint">
              <span class="kbd">?</span> all
            </span>
          }
        >
          <span class="hint">
            <span class="kbd">j</span>
            <span class="kbd">k</span> move
          </span>
          <span class="hint">
            <span class="kbd">↵</span> connect
          </span>
          {/* Moving and connecting are what this screen is for, and `?` is how
              everything else is found. `n` stays bound and stays in the help
              sheet and the palette; making a box is not a thing anyone needs
              reminding of on every visit. */}
          <span class="hint">
            <span class="kbd">?</span> all
          </span>
        </Show>
        {/* The chevron turns to point at what it opened. A disclosure whose
            marker never moves reads as a link to somewhere else, so the panel
            appearing below is a surprise rather than the thing it just did. */}
        <span
          data-add-machine-summary
          class="ml-auto inline-flex items-center gap-[6px] text-[11.5px] font-medium text-body"
        >
          Add a machine
          <span class="add-machine-chevron text-[14px] leading-none text-faint" aria-hidden="true">
            ›
          </span>
        </span>
      </div>
    </summary>

    {/* One sunken block, continuous with the hint bar above it. The spacing
        lives inside the panel, between the buttons and the boxes, rather than
        between the hint bar and the panel — put there it showed the page ground
        through as a black band across the bottom of the screen. */}
    <div class="flex flex-col gap-[10px] bg-sunken px-3 pb-[14px] pt-[6px]">
      {/* Six pixels, not eight: measured at 360px — the narrowest phone this
          has to hold — the four controls need 326 of the 334 available, and at
          eight the row wrapped and dropped Refresh onto a line of its own. */}
      <div class="flex flex-wrap items-center gap-[6px]">
        {/* "Approve", not "Approve code": in this panel the three controls read
            as the sequence they are, the dialog it opens says what is being
            approved, and the word buys the 35px that keeps the row on one line
            at 360px. */}
        <button type="button" onClick={props.onApprove} class="btn-ghost btn-sm">
          Approve
        </button>
        {/* Disabled rather than absent until there is something to copy.
            Mounting them on arrival reflowed the whole row a second after the
            screen appeared, which moved the Refresh button out from under a
            pointer already travelling towards it. */}
        <button
          type="button"
          onClick={props.onCopyCommand}
          disabled={props.linkCommand.length === 0}
          class="btn-primary btn-sm min-w-[108px]"
        >
          {props.copyState === 'command'
            ? 'Command copied'
            : props.copyState === 'error'
              ? 'Selected'
              : 'Copy command'}
        </button>
        {/* An icon, because four text labels do not fit a phone and this is
            the label worth losing: it is the least-used control here, it has a
            keybind, and re-issuing a link command is idempotent. The
            accessible name stays "Refresh" in every state — a name that
            changes to "Refreshing…" is a moving target for a screen reader and
            for the suite, and `aria-busy` says the same thing without moving
            anything. */}
        <button
          type="button"
          onClick={props.onRefresh}
          disabled={
            props.linkCommandStatus === 'loading' || props.linkCommandStatus === 'refreshing'
          }
          aria-label="Refresh"
          aria-busy={ariaBool(props.linkCommandStatus === 'refreshing')}
          title="Refresh the link command"
          class="btn-icon btn-chrome ml-auto h-[26px] w-[26px] shrink-0 disabled:cursor-wait"
        >
          <Show
            when={props.linkCommandStatus === 'refreshing'}
            fallback={
              <svg
                aria-hidden="true"
                viewBox="0 0 24 24"
                class="h-[13px] w-[13px]"
                fill="none"
                stroke="currentColor"
                stroke-width="1.9"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
                <path d="M21 3v5h-5" />
                <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
                <path d="M8 16H3v5" />
              </svg>
            }
          >
            <span class="spinner h-3 w-3" />
          </Show>
        </button>
      </div>

      {/* The box is drawn at its final size before the command exists. It sits
          under a `flex-1` list, so a footer that grows when the command lands —
          a network round trip after the screen appears — takes rows out of the
          list above it and slides them under the reader. The box holds one line
          box of the type it will contain, so the reservation follows the type
          rather than a measured constant that drifts away from it, and the
          reservation is not made of characters: `#link-command` is how the
          suite waits for a real command, and invisible text is text to
          `textContent`. Failure keeps its own box for
          the same reason — it must not be mistaken for a command that
          arrived. */}
      <Show
        when={props.linkCommandStatus !== 'limited'}
        fallback={
          <p class="text-[12px] leading-[1.5] text-meta" role="status">
            Machine limit reached. Unlink a machine from its menu to add another. Hosted boxes do
            not count toward this limit.
          </p>
        }
      >
        <Show
          when={props.linkCommandStatus !== 'error'}
          fallback={
            <div class="flex min-h-10 items-center rounded-sm border border-solid border-line2 bg-panel px-3 py-[9px] font-mono text-[12px] leading-[1.5] text-badink">
              Link command unavailable. Refresh to try again.
            </div>
          }
        >
          <code
            id="link-command"
            class="block min-h-10 cursor-text select-all whitespace-pre-wrap break-all rounded-sm border border-solid border-line2 bg-panel px-3 py-[9px] font-mono text-[12px] leading-[1.5] text-body"
          >
            <Show
              when={props.linkCommand.length > 0}
              fallback={
                <span class="block h-3 w-[78%] animate-pulse rounded bg-white/7 motion-reduce:animate-none" />
              }
            >
              {props.linkCommand}
            </Show>
          </code>
        </Show>

        {/* One command installs (or reinstalls) Merkur and links this machine.
          The account's link token rides in the installer's environment, never
          its arguments, so `ps` cannot show it; the machine then prints a link
          and a QR code to open here, and only the password is asked for. */}
        <p class="text-[11px] leading-[1.55] text-meta">
          Run it on the machine, then open the link it prints.
        </p>
      </Show>

      <Show
        when={
          props.linkCommand.length === 0 &&
          props.linkCommandStatus !== 'error' &&
          props.linkCommandStatus !== 'limited'
        }
      >
        <span class="sr-only" role="status">
          Preparing link command
        </span>
      </Show>
    </div>
  </details>
);

/**
 * The list before it has any rows.
 *
 * Every box here is the box a real row will put in the same place: the same
 * grid, the same 14px status column, the same gaps, and two bars over line
 * boxes (`1lh`) of the type the name and the caption are set in. A skeleton
 * that only approximates a row is a shift with a loading animation on it, so
 * the first snapshot moved everything below it. Measuring the bars from the
 * type rather than from constants is what keeps them equal after someone
 * changes the type.
 */
const DeviceListSkeleton: Component = () => (
  <div role="status" aria-label="Loading machines" class="flex flex-col px-[5px] py-[3px]">
    <For each={[0, 1, 2]}>
      {(index) => (
        <div
          class="device-row pr-3"
          style={{ opacity: String(1 - index * 0.18) }}
          aria-hidden="true"
        >
          <span class="grid min-w-0 flex-1 grid-cols-[14px_minmax(0,1fr)_auto] items-center gap-x-3 px-3 py-[9px]">
            <span class="h-[9px] w-[9px] animate-pulse justify-self-center rounded-full bg-white/10 motion-reduce:animate-none" />
            <span class="flex min-w-0 flex-col gap-[2px]">
              <span class="relative block h-[1lh] text-[14px] font-medium">
                <span class="absolute inset-y-[3px] left-0 w-[42%] animate-pulse rounded bg-white/9 motion-reduce:animate-none" />
              </span>
              <span class="relative block h-[1lh] font-mono text-[11px]">
                <span class="absolute inset-y-[2px] left-0 w-[64%] animate-pulse rounded bg-white/5 motion-reduce:animate-none" />
              </span>
            </span>
            <span class="h-[9px] w-8 animate-pulse rounded bg-white/5 motion-reduce:animate-none" />
          </span>
          {/* The actions button's footprint, so the bars end where a real row's
              text does rather than running under it. */}
          <span class="h-6 w-4 shrink-0" />
        </div>
      )}
    </For>
  </div>
);
