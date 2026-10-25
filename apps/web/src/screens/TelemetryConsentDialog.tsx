import type { Component } from 'solid-js';

import { OVERLAY_AUTOFOCUS_ATTRIBUTE } from '../components/overlay-controls';
import { ariaBool } from '../lib/aria';

const SAVE_FAILED = 'Your choice was not saved. Try again.';
/** The question and the failure share one line, so both wear the same type. */
const TITLE_TYPE = 'text-[16px] font-semibold leading-[1.35] tracking-[-0.018em]';

/**
 * The account's one question about performance reports, and a required one.
 *
 * It opens over the machine list, before any terminal can, while the account
 * has not answered, and it cannot be dismissed: no close button, no Escape, no
 * backdrop. Either answer is one press, is stored on the account, and lets the
 * user straight through to the same app; once answered no browser asks again,
 * and Settings > Account changes it.
 *
 * The two answers sit in one row at one size. Share wears the primary style,
 * Don't share the secondary one, at full contrast and plainly a button. Focus
 * lands on the question itself rather than on either answer, so Enter accepts
 * nothing. While a choice saves both refuse a second press, and a failed save
 * takes the question's line, which is already as tall as the failure, so the
 * explanation stays readable and the buttons stay where the pointer left them.
 *
 * The copy is one line of why, one line of what is sent and one of what never is, so
 * it reads at a glance; it does not call the reports anonymous:
 * reports are tied to the account, and daemon spans carry daemon and session ids.
 */
const TelemetryConsentDialog: Component<{
  /** The answer being saved, or null. */
  pending: boolean | null;
  failed: boolean;
  onChoose(enabled: boolean): void;
}> = (props) => {
  const choose = (enabled: boolean) => (): void => {
    if (props.pending !== null) return;
    props.onChoose(enabled);
  };

  return (
    <div class="dialog" data-telemetry-consent="">
      <div class="flex flex-col gap-[5px]">
        <div class="swap">
          <h2
            id="telemetry-consent-title"
            tabindex={-1}
            class={`${TITLE_TYPE} text-balance text-ink outline-none`}
            data-on={!props.failed}
            {...{ [OVERLAY_AUTOFOCUS_ATTRIBUTE]: '' }}
          >
            Share performance reports?
          </h2>
          <p class={`${TITLE_TYPE} text-badink`} role="alert" data-on={props.failed}>
            {props.failed ? SAVE_FAILED : ''}
          </p>
          <p class={TITLE_TYPE} aria-hidden="true">
            {SAVE_FAILED}
          </p>
        </div>
        <p
          id="telemetry-consent-description"
          class="text-pretty text-[12.5px] leading-[1.55] text-meta"
        >
          They are how Merkur finds and fixes slow or dropped connections. You can change this any
          time in Settings.
        </p>
      </div>
      <ul class="m-0 flex list-none flex-col gap-[10px] p-0 text-[12.5px] leading-[1.55] text-body">
        <li class="flex items-start gap-[8px]">
          <ScopeMark path="M5 12.5l4.5 4.5L19 7.5" tone="text-ok" />
          <span class="text-pretty">Timings and counts from this browser and your machines</span>
        </li>
        <li class="flex items-start gap-[8px]">
          <ScopeMark path="m7 7 10 10m0-10L7 17" tone="text-bad" />
          <span class="text-pretty">Never what you type or see in your terminal</span>
        </li>
      </ul>
      {/* Share leads on a wide window, where the eye starts at the left, and sits under the
          right thumb on a phone; the DOM keeps the wide order, so Tab follows what a keyboard
          user sees. */}
      <div class="mt-[6px] grid grid-cols-2 gap-2">
        <button
          type="button"
          class="btn-primary order-2 frame:order-1"
          aria-busy={ariaBool(props.pending === true)}
          aria-disabled={ariaBool(props.pending !== null)}
          onClick={choose(true)}
        >
          Share
        </button>
        <button
          type="button"
          class="btn-secondary order-1 frame:order-2"
          aria-busy={ariaBool(props.pending === false)}
          aria-disabled={ariaBool(props.pending !== null)}
          onClick={choose(false)}
        >
          Don't share
        </button>
      </div>
    </div>
  );
};

/**
 * One scope line's mark, drawn in the header icons' hand: 24 grid, 1.8 stroke, round caps.
 * A bare glyph, not a ringed one: a ring is what a ticked control looks like, and nothing
 * here is preselected. The status colour marks what is sent and what never is; the words
 * beside it say the same, so colour is never the only signal.
 */
const ScopeMark: Component<{ path: string; tone: 'text-ok' | 'text-bad' }> = (props) => (
  <svg
    aria-hidden="true"
    viewBox="0 0 24 24"
    class={`mt-[2px] h-[14px] w-[14px] shrink-0 ${props.tone}`}
    fill="none"
    stroke="currentColor"
    stroke-width="1.8"
    stroke-linecap="round"
    stroke-linejoin="round"
  >
    <path d={props.path} />
  </svg>
);

export default TelemetryConsentDialog;
