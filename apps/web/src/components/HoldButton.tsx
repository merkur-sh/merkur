import { OUT_EASE } from '@merkur/quicksilver/motion';
import { animate } from 'motion';
import { type Component, type Element, onCleanup } from 'solid-js';

import { hintMotion, motionDuration } from '../lib/motion';

/**
 * How long a hold takes to confirm. Long enough that a press on the way past —
 * a finger landing as the menu opens, a click meant for the item above — cannot
 * finish it; short enough that a deliberate hold is not a wait. Never shortened
 * for reduced motion: the fill is the confirmation's clock, not decoration, and
 * a reader who asked for less motion still asked for a moment to change their
 * mind.
 */
const HOLD_S = 1;

/** Letting go early hands the control back far faster than it filled. */
const DRAIN_S = 0.18;

interface Props {
  readonly id?: string;
  readonly class: string;
  readonly role?: 'menuitem';
  readonly label?: string;
  readonly disabled?: boolean;
  /** A key that holds as Enter and Space do: the action's own shortcut. */
  readonly holdKey?: string;
  readonly children: Element;
  onConfirm(): void;
}

/**
 * A destructive control confirmed by holding it, in place of a dialog that
 * asks again. The fill is the only thing that moves: it crosses the control at
 * a constant rate for as long as the press lasts, so how much is left is read
 * off it directly, and it drains the moment the press ends early.
 *
 * Confirmation is the fill's own `finished`, never a timer that has to agree
 * with it, so the control cannot act while it still looks short of full. A
 * click on its own does nothing; the fill starting and draining is what says
 * how this control is used.
 */
const HoldButton: Component<Props> = (props) => {
  let buttonEl!: HTMLButtonElement;
  let fillEl!: HTMLSpanElement;
  let fillMotion: ReturnType<typeof animate> | null = null;
  /** The pointer id or key holding the control, or null at rest. */
  let heldBy: number | string | null = null;
  /** Bumped by every press and release, so a stale `finished` cannot confirm. */
  let generation = 0;

  function begin(by: number | string): void {
    if (heldBy !== null) return;
    heldBy = by;
    const current = ++generation;
    // A press that lands mid-drain continues from where the fill is, at the
    // same rate, rather than jumping back to empty.
    const from = new DOMMatrixReadOnly(getComputedStyle(fillEl).transform).a;
    fillMotion?.stop();
    const fill = animate(
      fillEl,
      { scaleX: [from, 1] },
      { duration: HOLD_S * (1 - from), ease: 'linear' },
    );
    fillMotion = fill;
    hintMotion([fillEl], fill, 'transform');
    fill.finished.then(
      () => {
        if (current !== generation || heldBy === null) return;
        heldBy = null;
        props.onConfirm();
        // Back to rest once the action is under way: a control that outlives
        // its confirmation (a revoke that fails, say) must not stay full.
        drain();
      },
      () => undefined,
    );
  }

  function release(by: number | string): void {
    if (heldBy !== by) return;
    heldBy = null;
    drain();
  }

  function drain(): void {
    generation += 1;
    fillMotion?.stop();
    const emptying = animate(
      fillEl,
      { scaleX: 0 },
      { duration: motionDuration(DRAIN_S), ease: OUT_EASE },
    );
    fillMotion = emptying;
    hintMotion([fillEl], emptying, 'transform');
  }

  function onPointerDown(event: PointerEvent): void {
    if (event.button !== 0 || props.disabled === true) return;
    // A touch is captured by the control it lands on, which would keep a finger
    // that slides off it holding. Released, so leaving lets go.
    if (buttonEl.hasPointerCapture(event.pointerId)) {
      buttonEl.releasePointerCapture(event.pointerId);
    }
    begin(event.pointerId);
  }

  function onPointerEnd(event: PointerEvent): void {
    release(event.pointerId);
  }

  function isHoldKey(event: KeyboardEvent): boolean {
    if (event.ctrlKey || event.metaKey || event.altKey || props.disabled === true) return false;
    return event.key === 'Enter' || event.key === ' ' || event.key === props.holdKey;
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (!isHoldKey(event)) return;
    // Ours, repeats included: the key's own binding behind this control must
    // not run again while it is being held here.
    event.preventDefault();
    event.stopPropagation();
    if (!event.repeat) begin(event.key);
  }

  function onKeyUp(event: KeyboardEvent): void {
    release(event.key);
  }

  // A key released while focus is elsewhere never reaches this control, so
  // losing focus lets go of whatever was holding it.
  function onBlur(): void {
    if (heldBy !== null) release(heldBy);
  }

  onCleanup(() => {
    generation += 1;
    fillMotion?.stop();
  });

  return (
    <button
      ref={buttonEl}
      id={props.id}
      type="button"
      role={props.role}
      aria-label={props.label}
      disabled={props.disabled === true}
      class={['isolate [-webkit-touch-callout:none]', props.class]}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
      onPointerLeave={onPointerEnd}
      onKeyDown={onKeyDown}
      onKeyUp={onKeyUp}
      onBlur={onBlur}
      // A long press must not raise the context menu over the control it holds.
      onContextMenu={(event) => event.preventDefault()}
    >
      {/* Under the label, over the control's own fill: the button is its own
          stacking context, so a negative layer paints between the two. Empty
          at rest by class, not by a `style` attribute: a literal style is
          compiled into the template's markup, and the app's CSP has no
          'unsafe-inline' for attributes, so Firefox drops it and draws the
          fill full. */}
      <span
        ref={fillEl}
        aria-hidden="true"
        class="pointer-events-none absolute inset-0 -z-1 origin-left scale-x-0 rounded-[inherit] bg-[rgba(255,107,116,0.30)]"
      />
      {props.children}
    </button>
  );
};

export default HoldButton;
