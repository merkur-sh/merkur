import type { JSX } from '@solidjs/web';
import { type Component, createEffect, onSettled } from 'solid-js';

import { ariaBool } from '../lib/aria';
import BusyLabel from './BusyLabel';

interface Props {
  readonly id: string;
  readonly fieldId: string;
  readonly submitLabel: string;
  readonly pendingLabel: string;
  readonly cancelLabel: string;
  readonly pending: boolean;
  readonly error: string;
  /** The sentence that says what was mailed and what entering it does. */
  readonly children: JSX.Element;
  onSubmit: JSX.EventHandler<HTMLFormElement, SubmitEvent>;
  onResend: () => void;
  onCancel: () => void;
}

const CODE_LENGTH = 6;

/**
 * A card while it waits for a six-digit code from a mailbox: a sign-up's, or
 * a password reset's. The field takes focus when the form appears and again,
 * selected, whenever an answer comes back wrong.
 *
 * The field keeps digits only, so a code pasted with a space or a line break
 * around it is the code rather than a truncated string. The sixth digit is the
 * submission: a complete code is the whole of what the form asks for, and on a
 * phone it arrives in one autofilled event with nothing left to type.
 */
const MailedCodeForm: Component<Props> = (props) => {
  let formEl!: HTMLFormElement;
  let codeEl!: HTMLInputElement;
  // The code as it stood before the latest input event, so only a change that
  // completes a new code submits — not a seventh keystroke the filter drops,
  // nor the same rejected code pasted back over itself.
  let previous = '';
  onSettled(() => codeEl.focus());
  createEffect(
    () => props.error,
    (error) => {
      if (error.length === 0) return;
      requestAnimationFrame(() => {
        codeEl.focus();
        codeEl.select();
      });
    },
  );

  function onInput(event: InputEvent & { currentTarget: HTMLInputElement }): void {
    const field = event.currentTarget;
    const digits = field.value.replace(/\D/g, '').slice(0, CODE_LENGTH);
    if (digits !== field.value) field.value = digits;
    const completed = digits.length === CODE_LENGTH && digits !== previous;
    previous = digits;
    if (completed && !props.pending) formEl.requestSubmit();
  }

  return (
    <form
      ref={formEl}
      id={props.id}
      class="mt-[6px] flex w-full flex-col gap-[14px] text-left"
      onSubmit={(event) => {
        if (props.pending) {
          event.preventDefault();
          return;
        }
        props.onSubmit(event);
      }}
    >
      <p class="text-[13px] leading-[1.55] text-body">{props.children}</p>
      <label class="field-label" for={props.fieldId}>
        <span class="field-cap">Code</span>
        <input
          ref={codeEl}
          id={props.fieldId}
          name="code"
          type="text"
          inputmode="numeric"
          autocomplete="one-time-code"
          pattern="[0-9]{6}"
          spellcheck={false}
          required
          readonly={props.pending}
          aria-disabled={ariaBool(props.pending)}
          onInput={onInput}
          class={['field tracking-[0.3em]', { 'field-bad': props.error.length > 0 }]}
        />
      </label>
      <button
        type="submit"
        aria-busy={ariaBool(props.pending)}
        aria-disabled={ariaBool(props.pending)}
        class={['btn-primary btn-lg mt-1 w-full shadow-glow', { 'bg-accentdn': props.pending }]}
      >
        <BusyLabel
          busy={props.pending}
          idle={props.submitLabel}
          pending={props.pendingLabel}
          spinnerClass="h-3.5 w-3.5"
          onFill
        />
      </button>
      <div class="flex justify-between gap-2">
        <button
          type="button"
          class="btn-quiet btn-sm"
          disabled={props.pending}
          onClick={() => props.onResend()}
        >
          Send a new code
        </button>
        <button
          type="button"
          class="btn-quiet btn-sm"
          disabled={props.pending}
          onClick={() => props.onCancel()}
        >
          {props.cancelLabel}
        </button>
      </div>
    </form>
  );
};

export default MailedCodeForm;
