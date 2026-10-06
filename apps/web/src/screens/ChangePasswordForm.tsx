import { type Component, createSignal, onCleanup, onSettled, Show } from 'solid-js';

import { warmAccountOpaque } from '../auth/account-opaque';
import { accountPasswordPolicyError } from '../auth/password-policy';
import { isApiError } from '../lib/api-error';
import { ariaBool } from '../lib/aria';

interface Props {
  readonly username: string | null;
  onChangePassword(
    currentPassword: string,
    newPassword: string,
    signal: AbortSignal,
  ): Promise<void>;
}

const FORM_ID = 'change-password-form';

/**
 * One row that discloses one form. The row's button is the disclosure and
 * stays put in both states — it reads "Change" closed and "Cancel" open — so
 * pressing it never removes the control that has focus, and closing the form
 * by any route (cancel, success) puts focus back on it.
 */
const ChangePasswordForm: Component<Props> = (props) => {
  const [open, setOpen] = createSignal(false);
  const [pending, setPending] = createSignal(false);
  const [error, setError] = createSignal('');
  const [success, setSuccess] = createSignal(false);
  let request: AbortController | null = null;
  let toggleEl!: HTMLButtonElement;
  onCleanup(() => request?.abort());

  function toggle(): void {
    if (open()) {
      request?.abort();
      request = null;
      setPending(false);
      setOpen(false);
      return;
    }
    warmAccountOpaque();
    setError('');
    setSuccess(false);
    setOpen(true);
  }

  async function submit(event: SubmitEvent & { currentTarget: HTMLFormElement }): Promise<void> {
    event.preventDefault();
    if (request !== null) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    const current = data.get('current-password');
    const next = data.get('new-password');
    if (typeof current !== 'string' || typeof next !== 'string') return;
    const validation =
      accountPasswordPolicyError(next) ??
      (next !== data.get('confirm-password')
        ? 'The new passwords do not match.'
        : current === next
          ? 'Choose a different new password.'
          : null);
    setError(validation ?? '');
    if (validation !== null) return;
    const controller = new AbortController();
    request = controller;
    setPending(true);
    try {
      await props.onChangePassword(current, next, controller.signal);
      form.reset();
      setSuccess(true);
      setOpen(false);
      toggleEl.focus();
    } catch (cause) {
      if (controller.signal.aborted) return;
      if (isApiError(cause)) {
        setError(
          cause.status === 429
            ? 'Too many attempts. Wait a moment, then try again.'
            : cause.status === 503
              ? 'Authentication is temporarily unavailable. Try again shortly.'
              : 'Unable to change the password. Check your current password and try again.',
        );
      } else {
        setError(
          cause instanceof Error && cause.message === 'The current password is incorrect.'
            ? cause.message
            : 'Unable to confirm the change. Check your connection; if it completed, use your new password.',
        );
      }
    } finally {
      request = null;
      setPending(false);
    }
  }

  return (
    <div class="pref-group shrink-0">
      <div class="pref-row">
        <span class="min-w-0 flex-1">
          <span class="pref-name">Password</span>
          <span class="pref-sub" role="status">
            <Show when={success()} fallback="Changing it signs out other browsers.">
              <span class="text-okink">Changed. Other browsers were signed out.</span>
            </Show>
          </span>
        </span>
        <button
          ref={toggleEl}
          type="button"
          class="btn-quiet btn-sm shrink-0"
          aria-expanded={ariaBool(open())}
          aria-controls={FORM_ID}
          onClick={toggle}
        >
          {open() ? 'Cancel' : 'Change'}
        </button>
      </div>
      <Show when={open()}>
        <PasswordFields
          username={props.username}
          pending={pending()}
          error={error()}
          onSubmit={submit}
        />
      </Show>
    </div>
  );
};

export default ChangePasswordForm;

interface FieldsProps {
  readonly username: string | null;
  readonly pending: boolean;
  readonly error: string;
  onSubmit(event: SubmitEvent & { currentTarget: HTMLFormElement }): Promise<void>;
}

/**
 * The disclosed form. Its own component so `onSettled` can put the caret in
 * the first field once the form is actually in the document — a `ref` fires
 * on a detached element, where focus is a no-op.
 */
const PasswordFields: Component<FieldsProps> = (props) => {
  let firstField!: HTMLInputElement;
  onSettled(() => firstField.focus());

  return (
    <form
      id={FORM_ID}
      class="relative flex flex-col gap-3 px-[14px] pb-[14px] pt-3 before:(content-empty absolute left-[14px] right-0 top-0 h-px bg-line1)"
      onSubmit={(event) => void props.onSubmit(event)}
      aria-busy={ariaBool(props.pending)}
    >
      <input type="hidden" name="username" autocomplete="username" value={props.username ?? ''} />
      <label class="field-label" for="current-password">
        <span class="field-cap">Current password</span>
        <input
          ref={firstField}
          class="field"
          id="current-password"
          name="current-password"
          type="password"
          autocomplete="current-password"
          required
          disabled={props.pending}
        />
      </label>
      <label class="field-label" for="new-password">
        <span class="field-cap flex items-baseline justify-between gap-2">
          New password
          <span class="font-mono text-[11px] font-normal text-meta frame:text-[12px]">
            12–256 characters
          </span>
        </span>
        <input
          class="field"
          id="new-password"
          name="new-password"
          type="password"
          autocomplete="new-password"
          required
          disabled={props.pending}
        />
      </label>
      <label class="field-label" for="confirm-password">
        <span class="field-cap">Confirm new password</span>
        <input
          class="field"
          id="confirm-password"
          name="confirm-password"
          type="password"
          autocomplete="new-password"
          required
          disabled={props.pending}
        />
      </label>
      <Show when={props.error}>
        <p role="alert" class="text-[12.5px] text-badink frame:text-[14px]">
          {props.error}
        </p>
      </Show>
      <div class="flex pt-1">
        <button type="submit" class="btn-primary" disabled={props.pending}>
          {props.pending ? 'Changing password…' : 'Save password'}
        </button>
      </div>
    </form>
  );
};
