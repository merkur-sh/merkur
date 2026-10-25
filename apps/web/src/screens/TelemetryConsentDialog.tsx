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
 * The copy says what is sent and what never is, without calling it anonymous:
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
        <p id="telemetry-consent-description" class="text-[12.5px] leading-[1.55] text-meta">
          These reports are how I find and fix slow or dropped connections in Merkur, and they shape
          what I work on next. They carry timings and counts from this browser and your linked
          machines, such as how long a keystroke takes to appear and when a connection drops. They
          never include what you type or what your terminal shows. You can turn them off any time in
          Settings.
        </p>
      </div>
      <div class="grid grid-cols-2 gap-2">
        <button
          type="button"
          class="btn-secondary"
          aria-busy={ariaBool(props.pending === false)}
          aria-disabled={ariaBool(props.pending !== null)}
          onClick={choose(false)}
        >
          Don't share
        </button>
        <button
          type="button"
          class="btn-primary"
          aria-busy={ariaBool(props.pending === true)}
          aria-disabled={ariaBool(props.pending !== null)}
          onClick={choose(true)}
        >
          Share
        </button>
      </div>
    </div>
  );
};

export default TelemetryConsentDialog;
