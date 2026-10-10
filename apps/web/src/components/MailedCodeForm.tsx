import type { JSX } from '@solidjs/web';
import { type Component, createEffect, onSettled, Show } from 'solid-js';

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

/**
 * A card while it waits for a six-digit code from a mailbox: a sign-up's, or
 * a password reset's. The field takes focus when the form appears and again,
 * selected, whenever an answer comes back wrong.
 */
const MailedCodeForm: Component<Props> = (props) => {
  let codeEl!: HTMLInputElement;
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

  return (
    <form
      id={props.id}
      class="mt-[6px] flex w-full flex-col gap-[14px] text-left"
      onSubmit={props.onSubmit}
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
          maxlength={6}
          spellcheck={false}
          required
          disabled={props.pending}
          class={['field tracking-[0.3em]', { 'field-bad': props.error.length > 0 }]}
        />
      </label>
      <button
        type="submit"
        disabled={props.pending}
        class={[
          'btn-primary btn-lg mt-1 w-full shadow-glow disabled:cursor-wait',
          { 'bg-accentdn disabled:opacity-100': props.pending },
        ]}
      >
        <Show when={props.pending}>
          <span class="spinner spinner--on-fill h-3.5 w-3.5" />
        </Show>
        {props.pending ? props.pendingLabel : props.submitLabel}
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
