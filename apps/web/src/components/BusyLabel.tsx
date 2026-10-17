import type { Component, Element } from 'solid-js';

interface Props {
  readonly busy: boolean;
  /** What the control says at rest. */
  readonly idle: Element;
  /** What it says while the work it was pressed for runs. */
  readonly pending: Element;
  /** The spinner's box, e.g. `h-3 w-3`. */
  readonly spinnerClass: string;
  /** The spinner sits on a filled control, so its track clears the fill. */
  readonly onFill?: boolean;
}

/**
 * A busy control's two faces in one grid cell, so "Create box" becoming
 * "Creating…" with a spinner beside it cannot resize the button or shove the
 * one next to it. The spinner's box is held at rest too — it is what makes
 * the busy face as wide as it will be — but it only turns while busy, so an
 * idle form runs no animation.
 *
 * Pair it with `aria-busy` and `aria-disabled` on the control, never
 * `disabled`, and a guard in the handler.
 */
const BusyLabel: Component<Props> = (props) => (
  <span class="swap-inline">
    <span data-on={!props.busy}>{props.idle}</span>
    <span data-on={props.busy}>
      <span
        aria-hidden="true"
        class={[
          'block shrink-0',
          props.spinnerClass,
          { spinner: props.busy, 'spinner--on-fill': props.busy && props.onFill === true },
        ]}
      />
      {props.pending}
    </span>
  </span>
);

export default BusyLabel;
