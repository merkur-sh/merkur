import type { Component } from 'solid-js';

import { ariaBool } from '../lib/aria';

/**
 * The one switch. Every immediate on/off setting in the app wears it, so a
 * reader learns its shape once.
 *
 * A switch is not a checkbox: it takes effect the moment it is thrown, with no
 * form to submit and nothing to confirm. The knob is the only thing that moves,
 * and it moves on `transform` so the change costs the compositor a frame and
 * the main thread nothing.
 */
interface Props {
  readonly checked: boolean;
  readonly disabled?: boolean;
  readonly label: string;
  onChange(next: boolean): void;
}

const ToggleSwitch: Component<Props> = (props) => (
  <button
    type="button"
    role="switch"
    aria-checked={ariaBool(props.checked)}
    aria-label={props.label}
    disabled={props.disabled === true}
    onClick={() => props.onChange(!props.checked)}
    class={[
      'focusable relative h-[18px] w-8 shrink-0 cursor-pointer rounded-full border border-solid p-0 tap-transparent transition-[background-color,border-color] duration-tint disabled:(cursor-not-allowed opacity-45) motion-reduce:transition-none',
      {
        'border-accent bg-accent': props.checked,
        'border-line2 bg-lifted': !props.checked,
      },
    ]}
  >
    <span
      aria-hidden="true"
      class={[
        'absolute left-[2px] top-[2px] block h-3 w-3 rounded-full transition-[transform,background-color] duration-base ease-out motion-reduce:transition-none',
        {
          'translate-x-[14px] bg-white': props.checked,
          'translate-x-0 bg-meta': !props.checked,
        },
      ]}
    />
  </button>
);

export default ToggleSwitch;
