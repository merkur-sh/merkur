import { type Component, type Element, For } from 'solid-js';

interface Props {
  /** The description's id, for the dialog's `aria-describedby`. */
  readonly id?: string;
  /** The error to show in place of the description; empty when there is none. */
  readonly error: string;
  /** Every error this slot can show, so the slot is the height of the longest from the start. */
  readonly reserve: readonly string[];
  readonly class?: string;
  readonly children: Element;
}

/**
 * A dialog's description and its error in one grid cell.
 *
 * An error mounted below the fields grew a centred dialog from both edges, so
 * Cancel and the primary button moved out from under the pointer at the one
 * moment it was heading back to them. Here the error takes the description's
 * place, the slot is already as tall as the longest message it can hold, and
 * the swap is opacity and three pixels of travel. The description returns the
 * moment the error clears.
 */
const MessageSlot: Component<Props> = (props) => (
  <div class={['swap', props.class]}>
    <p id={props.id} data-on={props.error.length === 0}>
      {props.children}
    </p>
    <p class="text-badink" role="alert" data-on={props.error.length > 0}>
      {props.error}
    </p>
    <For each={props.reserve}>{(message) => <p aria-hidden="true">{message}</p>}</For>
  </div>
);

export default MessageSlot;
