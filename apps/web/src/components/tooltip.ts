import { createEffect, onCleanup } from 'solid-js';

/**
 * The app's one tooltip, attached as a ref directive:
 * `<button ref={tooltip(() => 'Log out')} aria-label="Log out">`.
 *
 * It replaces the `title` attribute, which waited about a second per control
 * in the system's own chrome on a desktop and never appeared at all on a
 * phone, where an icon-only button then had no name anyone could see.
 *
 * - The wait is charged once per visit. After one tooltip has opened, every
 *   other trigger opens on contact until the pointer has been away from all
 *   of them for `SKIP_DELAY_MS`, so sweeping a toolbar is one wait, not five.
 * - One tooltip exists, so two can never overlap; crossing the gap between
 *   two triggers hands it over without a flicker.
 * - A press closes it and keeps it closed until the pointer leaves, so a
 *   clicked button is not left with a label parked over it. Escape does the
 *   same. Keyboard focus opens it only when the browser reports
 *   `:focus-visible`.
 * - On touch a long press shows it for as long as the finger stays down, and
 *   the click that the lift would otherwise fire is swallowed: holding Log out
 *   to read its name must not sign out.
 *
 * A trigger whose accessible name already says what the tooltip says (an
 * icon button with `aria-label`) is not described by it; one that adds a fact
 * passes `describe` and is described while the tooltip is up.
 */

const OPEN_DELAY_MS = 500;
const SKIP_DELAY_MS = 300;
/** Long enough to cross the gap to a neighbouring trigger. */
const CLOSE_DELAY_MS = 60;
const LONG_PRESS_MS = 450;
/** A finger that drifts further than this is scrolling, not holding. */
const LONG_PRESS_SLOP_PX = 8;
const GAP_PX = 6;
const EDGE_PX = 8;
const TOOLTIP_ID = 'merkur-tooltip';

interface Trigger {
  readonly element: HTMLElement;
  readonly text: () => string;
  readonly describe: boolean;
}

let tip: HTMLDivElement | null = null;
let active: Trigger | null = null;
let pending: Trigger | null = null;
let openTimer: number | undefined;
let closeTimer: number | undefined;
/** Until when a trigger opens on contact rather than after the delay. */
let warmUntil = 0;
/** The trigger a press or Escape closed, held shut until the pointer leaves it. */
let blocked: HTMLElement | null = null;

function tipElement(): HTMLDivElement {
  if (tip !== null) return tip;
  const element = document.createElement('div');
  element.id = TOOLTIP_ID;
  element.className = 'tooltip';
  element.setAttribute('role', 'tooltip');
  document.body.append(element);
  tip = element;
  return element;
}

function clearTimers(): void {
  window.clearTimeout(openTimer);
  window.clearTimeout(closeTimer);
  openTimer = undefined;
  closeTimer = undefined;
  pending = null;
}

/** Below the trigger, centred on it; above when there is no room below. */
function place(element: HTMLDivElement, trigger: HTMLElement): void {
  const rect = trigger.getBoundingClientRect();
  const width = element.offsetWidth;
  const height = element.offsetHeight;
  const viewportWidth = document.documentElement.clientWidth;
  const left = Math.min(
    Math.max(rect.left + rect.width / 2 - width / 2, EDGE_PX),
    viewportWidth - width - EDGE_PX,
  );
  const below = rect.bottom + GAP_PX;
  const top = below + height + EDGE_PX > window.innerHeight ? rect.top - GAP_PX - height : below;
  element.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
}

function onWindowKeyDown(event: KeyboardEvent): void {
  if (event.key !== 'Escape' || active === null) return;
  blocked = active.element;
  hide();
}

function show(trigger: Trigger, instant: boolean): void {
  clearTimers();
  // A trigger with nothing to say right now (a machine never seen) shows nothing.
  const text = trigger.text();
  if (text.length === 0) {
    hide();
    return;
  }
  const element = tipElement();
  if (active !== null && active !== trigger) active.element.removeAttribute('aria-describedby');
  if (active === null) {
    window.addEventListener('keydown', onWindowKeyDown, true);
    window.addEventListener('scroll', hide, { capture: true, passive: true });
  }
  active = trigger;
  element.textContent = text;
  element.toggleAttribute('data-instant', instant);
  place(element, trigger.element);
  element.setAttribute('data-open', '');
  if (trigger.describe) trigger.element.setAttribute('aria-describedby', TOOLTIP_ID);
}

function hide(): void {
  clearTimers();
  if (active === null) return;
  active.element.removeAttribute('aria-describedby');
  active = null;
  warmUntil = performance.now() + SKIP_DELAY_MS;
  window.removeEventListener('keydown', onWindowKeyDown, true);
  window.removeEventListener('scroll', hide, true);
  tip?.removeAttribute('data-open');
}

function approach(trigger: Trigger): void {
  if (blocked === trigger.element) return;
  if (active === trigger) {
    window.clearTimeout(closeTimer);
    closeTimer = undefined;
    return;
  }
  if (active !== null || performance.now() < warmUntil) {
    show(trigger, true);
    return;
  }
  if (pending === trigger) return;
  clearTimers();
  pending = trigger;
  openTimer = window.setTimeout(() => show(trigger, false), OPEN_DELAY_MS);
}

function withdraw(trigger: Trigger): void {
  if (pending === trigger) clearTimers();
  if (active !== trigger) return;
  window.clearTimeout(closeTimer);
  closeTimer = window.setTimeout(hide, CLOSE_DELAY_MS);
}

export function tooltip(
  read: () => string,
  options: { readonly describe?: boolean } = {},
): (element: HTMLElement) => void {
  let trigger: Trigger | null = null;

  // A label that changes while it is up (a copy button's outcome) is
  // rewritten in place, and the tooltip re-centred on its new width.
  createEffect(read, (value) => {
    if (trigger === null || active !== trigger || tip === null) return;
    tip.textContent = value;
    place(tip, trigger.element);
  });
  onCleanup(() => {
    if (trigger === null) return;
    if (pending === trigger) clearTimers();
    if (active === trigger) hide();
    if (blocked === trigger.element) blocked = null;
  });

  return (element) => {
    const current: Trigger = { element, text: read, describe: options.describe === true };
    trigger = current;
    let pressTimer: number | undefined;
    let pressOrigin: { readonly x: number; readonly y: number } | null = null;
    let swallowClick = false;

    const endPress = (): void => {
      window.clearTimeout(pressTimer);
      pressTimer = undefined;
      pressOrigin = null;
      if (active === current) hide();
    };

    element.addEventListener('pointerenter', (event) => {
      if (event.pointerType !== 'touch') approach(current);
    });
    element.addEventListener('pointerleave', (event) => {
      if (event.pointerType === 'touch') return;
      if (blocked === element) blocked = null;
      withdraw(current);
    });
    element.addEventListener('pointerdown', (event) => {
      if (event.pointerType !== 'touch') {
        if (pending === current) clearTimers();
        if (active === current) hide();
        blocked = element;
        return;
      }
      swallowClick = false;
      pressOrigin = { x: event.clientX, y: event.clientY };
      window.clearTimeout(pressTimer);
      pressTimer = window.setTimeout(() => {
        pressTimer = undefined;
        swallowClick = true;
        show(current, true);
      }, LONG_PRESS_MS);
    });
    element.addEventListener('pointermove', (event) => {
      if (pressOrigin === null) return;
      if (
        Math.hypot(event.clientX - pressOrigin.x, event.clientY - pressOrigin.y) >
        LONG_PRESS_SLOP_PX
      ) {
        swallowClick = false;
        endPress();
      }
    });
    element.addEventListener('pointerup', endPress);
    element.addEventListener('pointercancel', () => {
      swallowClick = false;
      endPress();
    });
    // The lift after a completed hold must not act. Captured on the trigger and
    // stopped there, so it reaches neither the trigger's own handler nor the
    // control the trigger sits inside.
    element.addEventListener(
      'click',
      (event) => {
        if (!swallowClick) return;
        swallowClick = false;
        event.preventDefault();
        event.stopImmediatePropagation();
      },
      true,
    );
    element.addEventListener('contextmenu', (event) => {
      if (swallowClick) event.preventDefault();
    });
    element.addEventListener('focus', () => {
      if (element.matches(':focus-visible')) approach(current);
    });
    element.addEventListener('blur', () => {
      if (pending === current) clearTimers();
      if (active === current) hide();
    });
  };
}
