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
 *
 * A setting saved elsewhere is `busy` while it saves: the knob already shows the
 * position asked for, and the switch keeps its focus and refuses another throw
 * until the answer lands.
 */
interface Props {
  readonly checked: boolean;
  readonly disabled?: boolean;
  readonly busy?: boolean;
  readonly label: string;
  onChange(next: boolean): void;
}

const ToggleSwitch: Component<Props> = (props) => (
  <button
    type="button"
    role="switch"
    aria-checked={ariaBool(props.checked)}
    aria-label={props.label}
    aria-busy={ariaBool(props.busy === true)}
    aria-disabled={ariaBool(props.busy === true)}
    disabled={props.disabled === true}
    onClick={() => {
      if (props.busy === true) return;
      props.onChange(!props.checked);
    }}
    class={[
      // The press area is 44 px tall and wider than the track, through the
      // same `after:` every `btn` carries: the drawn switch is 18 px.
      'focusable relative h-[18px] w-8 shrink-0 cursor-pointer rounded-full border border-solid p-0 tap-transparent transition-[background-color,border-color] duration-tint disabled:(cursor-not-allowed opacity-45) motion-reduce:transition-none after:(content-empty absolute left-1/2 top-1/2 h-11 w-12 -translate-x-1/2 -translate-y-1/2)',
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
