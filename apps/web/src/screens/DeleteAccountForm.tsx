import { type Component, createSignal, onCleanup, onSettled, Show } from 'solid-js';

import { warmAccountOpaque } from '../auth/account-opaque';
import { isApiError } from '../lib/api-error';
import { ariaBool } from '../lib/aria';

interface Props {
  readonly username: string | null;
  /** True when the sign-in that opened this session called off a scheduled erasure. */
  readonly deletionCancelled: boolean;
  /** Resolves with the instant the erasure falls due. */
  onDeleteAccount(password: string, signal: AbortSignal): Promise<number>;
  onLogout(): Promise<void>;
}

const FORM_ID = 'delete-account-form';

/**
 * Erasing the account, from the account itself.
 *
 * The password is asked for because it is the only thing that can authorise
 * this: it unwraps the root key that signs the request, so no one holding a
 * session alone can destroy the account.
 *
 * Nothing is destroyed when this succeeds. The account goes dormant and the
 * erasure falls due a week later, which is what the confirmation says — the
 * way back is simply to sign in again.
 */
const DeleteAccountForm: Component<Props> = (props) => {
  const [open, setOpen] = createSignal(false);
  const [pending, setPending] = createSignal(false);
  const [error, setError] = createSignal('');
  const [scheduledFor, setScheduledFor] = createSignal<number | null>(null);
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
    setOpen(true);
  }

  async function submit(event: SubmitEvent & { currentTarget: HTMLFormElement }): Promise<void> {
    event.preventDefault();
    if (request !== null) return;
    const form = event.currentTarget;
    const password = new FormData(form).get('delete-account-password');
    if (typeof password !== 'string') return;
    const controller = new AbortController();
    request = controller;
    setPending(true);
    setError('');
    try {
      const due = await props.onDeleteAccount(password, controller.signal);
      form.reset();
      setScheduledFor(due);
      setOpen(false);
    } catch (cause) {
      if (controller.signal.aborted) return;
      setError(
        isApiError(cause)
          ? cause.status === 429
            ? 'Too many attempts. Wait a moment, then try again.'
            : cause.status === 503
              ? 'Authentication is temporarily unavailable. Try again shortly.'
              : 'Unable to schedule the deletion. Check your password and try again.'
          : 'Unable to confirm the request. Check your connection and try again.',
      );
    } finally {
      request = null;
      setPending(false);
    }
  }

  return (
    <div class="pref-group shrink-0">
      <Show
        when={scheduledFor()}
        fallback={
          <>
            <div class="pref-row">
              <span class="min-w-0 flex-1">
                <span class="pref-name">Delete account</span>
                <span class="pref-sub" role="status">
                  <Show
                    when={props.deletionCancelled}
                    fallback="Erases this account, its machines, and its boxes after 7 days. Signing in before then cancels it."
                  >
                    <span class="text-okink">
                      Signing in cancelled the deletion this account had scheduled. Nothing was
                      erased.
                    </span>
                  </Show>
                </span>
              </span>
              <button
                ref={toggleEl}
                type="button"
                class="btn-quiet btn-sm shrink-0 text-badink hover:(bg-badsoft text-badink)"
                aria-expanded={ariaBool(open())}
                aria-controls={FORM_ID}
                onClick={toggle}
              >
                {open() ? 'Cancel' : 'Delete'}
              </button>
            </div>
            <Show when={open()}>
              <DeleteFields
                username={props.username}
                pending={pending()}
                error={error()}
                onSubmit={submit}
              />
            </Show>
          </>
        }
      >
        {(due) => (
          <div class="flex flex-col gap-3 px-[14px] py-[14px]" role="status">
            <span class="pref-name">Deletion scheduled</span>
            <span class="pref-sub">
              This account and everything in it will be erased on{' '}
              <span class="font-mono">{formatDue(due())}</span>. Signing in before then cancels it.
              Every browser and machine has been signed out.
            </span>
            <div class="flex pt-1">
              <button type="button" class="btn-primary" onClick={() => void props.onLogout()}>
                Sign out
              </button>
            </div>
          </div>
        )}
      </Show>
    </div>
  );
};

export default DeleteAccountForm;

/** The deadline in the reader's own locale; the grace period is days, so the date carries it. */
function formatDue(due: number): string {
  return new Date(due).toLocaleString(undefined, {
    dateStyle: 'long',
    timeStyle: 'short',
  });
}

interface FieldsProps {
  readonly username: string | null;
  readonly pending: boolean;
  readonly error: string;
  onSubmit(event: SubmitEvent & { currentTarget: HTMLFormElement }): Promise<void>;
}

/**
 * The disclosed form. Its own component so `onSettled` can put the caret in the
 * field once it is actually in the document.
 */
const DeleteFields: Component<FieldsProps> = (props) => {
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
      <label class="field-label" for="delete-account-password">
        <span class="field-cap">Merkur password</span>
        <input
          ref={firstField}
          class="field"
          id="delete-account-password"
          name="delete-account-password"
          type="password"
          autocomplete="current-password"
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
        <button type="submit" class="btn-primary bg-badink" disabled={props.pending}>
          {props.pending ? 'Scheduling…' : 'Delete this account'}
        </button>
      </div>
    </form>
  );
};
