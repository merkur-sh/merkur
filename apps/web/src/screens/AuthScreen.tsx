import type { JSX } from '@solidjs/web';
import { animate } from 'motion';
import { type Component, createEffect, onSettled, Show } from 'solid-js';

import type { PasswordResetDevice } from '../auth/account-api';
import { warmAccountOpaque } from '../auth/account-opaque';
import MerkurOrb from '../components/MerkurOrb';
import { ariaBool } from '../lib/aria';
import { NAV_SPRING, springTransition } from '../lib/motion';

/** A password reset in progress: waiting for its mailed code, or proven and awaiting the new password. */
type ResetView =
  | { readonly step: 'code'; readonly address: string }
  | {
      readonly step: 'confirm';
      readonly address: string;
      readonly devices: readonly PasswordResetDevice[];
    };

interface Props {
  pending: boolean;
  error: string;
  /** What the account is named by; null until the server has said. */
  identity: 'username' | 'email' | null;
  /** Set while a sign-up waits for the code mailed to this address. */
  codeAddress: string | null;
  /** Set while a password reset is in progress; it takes the card over. */
  reset: ResetView | null;
  /** The screen is on: read what the form needs to ask for. */
  onShown: () => void;
  onSubmit: JSX.EventHandler<HTMLFormElement, SubmitEvent>;
  onCodeSubmit: JSX.EventHandler<HTMLFormElement, SubmitEvent>;
  onCodeResend: () => void;
  onCodeCancel: () => void;
  onResetStart: (address: string) => void;
  onResetCodeSubmit: JSX.EventHandler<HTMLFormElement, SubmitEvent>;
  onResetCodeResend: () => void;
  onResetConfirm: JSX.EventHandler<HTMLFormElement, SubmitEvent>;
  onResetCancel: () => void;
}

/**
 * Sign in: the mark, the name, two fields, one primary action.
 *
 * The orb and the wordmark are the whole identity of this screen; there is no
 * line of prose explaining what signing in leads to. The wordmark is the one
 * place the serif appears, and the button is the one control in the app that
 * glows at rest: this is the front door, and the front door gets the light.
 * Enter submits because this is a real form; the submit button disables itself
 * and re-enables only on failure.
 *
 * The orb and the wordmark carry `vt-orb` and `vt-wordmark`, the shared
 * elements of the sign-in entrance and the sign-out exit: once the session
 * exists, `PhaseHost` carries both from here to their slots in the machine
 * list header rather than fading one pair out and another in, and when it
 * ends they come back the same way.
 *
 * On a server that names accounts by email, a new address is not an account
 * until the code mailed to it comes back: the same card then asks for that
 * code instead of the password. The field that was wrong takes focus.
 *
 * Such a server also resets a forgotten password, in the same card: a code
 * mailed to the address in the form, then a second step that names every
 * machine the reset unlinks and every box it deletes before it takes the new
 * password. Nothing is destroyed until that step is submitted.
 */
const AuthScreen: Component<Props> = (props) => {
  let sectionEl!: HTMLElement;
  let usernameEl: HTMLInputElement | undefined;
  let passwordEl: HTMLInputElement | undefined;

  function startReset(): void {
    // The reset is for the address already in the form; the browser's own
    // validation says so when it is missing or is not an address.
    if (usernameEl === undefined || !usernameEl.reportValidity()) return;
    props.onResetStart(usernameEl.value.trim());
  }

  createEffect(
    () => props.error,
    (error) => {
      // A code step and a reset step each own their own field.
      if (error.length === 0 || props.codeAddress !== null || props.reset !== null) return;
      requestAnimationFrame(() => {
        passwordEl?.focus();
        passwordEl?.select();
      });
    },
  );

  onSettled(() => {
    // OPAQUE is loaded on demand so its inlined WASM stays out of the boot
    // bundle. Start that load now: the password is still being typed, so the
    // fetch costs nothing by the time submit needs it.
    warmAccountOpaque();
    props.onShown();

    // Transform only. The phase layer owns the fade for the whole surface, and
    // a nested opacity animation multiplies with it into something slower than
    // either was written to be — so the card rises against a fade it inherits.
    const sectionAnimation = animate(sectionEl, { y: [8, 0] }, springTransition(NAV_SPRING));

    return () => sectionAnimation.stop();
  });

  return (
    <section
      ref={sectionEl}
      id="auth-screen"
      class="slab flex w-full max-w-[400px] flex-col items-center gap-[14px] px-7 pb-7 pt-8 text-center"
      aria-busy={ariaBool(props.pending)}
    >
      <MerkurOrb size={72} class="vt-orb" />
      <p class="wordmark vt-wordmark">Merkur</p>

      <Show
        when={props.reset}
        fallback={
          <Show
            when={props.codeAddress}
            fallback={
              <form
                id="auth-form"
                class="mt-[6px] flex w-full flex-col gap-[14px] text-left"
                onSubmit={props.onSubmit}
              >
                {/* Nothing to fill in until the server has said what an account is
                named by; the button alone asks it again after a failed read. */}
                <Show when={props.identity}>
                  {(identity) => (
                    <>
                      <label class="field-label" for="field-username">
                        <span class="field-cap">
                          {identity() === 'email' ? 'Email' : 'Username'}
                        </span>
                        <input
                          ref={usernameEl}
                          id="field-username"
                          name="username"
                          type={identity() === 'email' ? 'email' : 'text'}
                          inputmode={identity() === 'email' ? 'email' : undefined}
                          autocomplete="username"
                          spellcheck={false}
                          required
                          disabled={props.pending}
                          class="field"
                        />
                      </label>

                      <label class="field-label" for="field-password">
                        <span class="field-cap">Password</span>
                        <input
                          ref={passwordEl}
                          id="field-password"
                          name="password"
                          type="password"
                          autocomplete="current-password"
                          minlength={12}
                          required
                          disabled={props.pending}
                          class={['field', { 'field-bad': props.error.length > 0 }]}
                        />
                      </label>
                      <Show when={identity() === 'email'}>
                        <button
                          type="button"
                          class="btn-quiet btn-sm -mt-1.5 self-end"
                          disabled={props.pending}
                          onClick={startReset}
                        >
                          Forgot password?
                        </button>
                      </Show>
                    </>
                  )}
                </Show>

                {/* Disabled while the request is in flight, and deliberately drawn at
                its own pressed colour rather than dimmed: the button has not become
                unavailable, it is busy doing the thing it was pressed for. */}
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
                  {props.pending ? 'Continuing…' : 'Continue'}
                </button>
                {/* Continue creates the account when the name is new, so the
                agreement sits under it rather than behind a checkbox. The
                pages are documents of their own; a new tab keeps the form. */}
                <p class="text-center text-[12px] leading-[1.5] text-meta">
                  By continuing you agree to the{' '}
                  <a class="text-body underline" href="/terms" target="_blank" rel="noopener">
                    Terms
                  </a>{' '}
                  and{' '}
                  <a class="text-body underline" href="/privacy" target="_blank" rel="noopener">
                    Privacy Policy
                  </a>
                  .
                </p>
              </form>
            }
          >
            {(address) => (
              <MailedCodeForm
                id="auth-code-form"
                fieldId="field-code"
                submitLabel="Create account"
                pendingLabel="Creating account…"
                cancelLabel="Use a different email"
                pending={props.pending}
                error={props.error}
                onSubmit={props.onCodeSubmit}
                onResend={props.onCodeResend}
                onCancel={props.onCodeCancel}
              >
                We sent a six-digit code to <span class="text-ink">{address()}</span>. Enter it to
                create your account; it expires in 10 minutes.
              </MailedCodeForm>
            )}
          </Show>
        }
      >
        {(reset) => (
          <Show
            when={confirmStep(reset())}
            fallback={
              // The sentence does not say a code was sent: the server gives the
              // same answer for an address with no account, and so does this.
              <MailedCodeForm
                id="auth-reset-code-form"
                fieldId="field-reset-code"
                submitLabel="Continue"
                pendingLabel="Checking…"
                cancelLabel="Back to sign in"
                pending={props.pending}
                error={props.error}
                onSubmit={props.onResetCodeSubmit}
                onResend={props.onResetCodeResend}
                onCancel={props.onResetCancel}
              >
                If <span class="text-ink">{reset().address}</span> has a Merkur account, we sent it
                a six-digit code. Enter it to reset the password; it expires in 10 minutes.
              </MailedCodeForm>
            }
          >
            {(confirm) => (
              <ResetConfirmForm
                address={confirm().address}
                devices={confirm().devices}
                pending={props.pending}
                error={props.error}
                onSubmit={props.onResetConfirm}
                onCancel={props.onResetCancel}
              />
            )}
          </Show>
        )}
      </Show>

      <p
        id="auth-feedback"
        class="min-h-[18px] text-[12.5px] leading-[1.55] text-badink"
        role="alert"
        aria-live="polite"
      >
        {props.error}
      </p>
    </section>
  );
};

export default AuthScreen;

function confirmStep(reset: ResetView) {
  return reset.step === 'confirm' ? reset : null;
}

interface MailedCodeProps {
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
 * The card while it waits for a six-digit code from a mailbox: a sign-up's, or
 * a password reset's. The field takes focus when the form appears and again,
 * selected, whenever an answer comes back wrong.
 */
const MailedCodeForm: Component<MailedCodeProps> = (props) => {
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

interface ResetConfirmProps {
  readonly address: string;
  readonly devices: readonly PasswordResetDevice[];
  readonly pending: boolean;
  readonly error: string;
  onSubmit: JSX.EventHandler<HTMLFormElement, SubmitEvent>;
  onCancel: () => void;
}

/**
 * The reset's last step: everything it destroys, by name, above the field that
 * commits it. A machine is only unlinked, and says so; a box is deleted with
 * its files, and says that in the colour of a loss.
 */
const ResetConfirmForm: Component<ResetConfirmProps> = (props) => {
  let passwordEl!: HTMLInputElement;
  onSettled(() => passwordEl.focus());
  createEffect(
    () => props.error,
    (error) => {
      if (error.length === 0) return;
      requestAnimationFrame(() => {
        passwordEl.focus();
        passwordEl.select();
      });
    },
  );
  const names = (box: boolean) =>
    props.devices
      .filter((device) => device.box === box)
      .map((device) => device.name)
      .join(', ');

  return (
    <form
      id="auth-reset-confirm-form"
      class="mt-[6px] flex w-full flex-col gap-[14px] text-left"
      onSubmit={props.onSubmit}
    >
      <p class="text-[13px] leading-[1.55] text-body">
        Set a new password for <span class="text-ink">{props.address}</span>. This cannot be undone:
      </p>
      <ul class="m-0 flex list-disc flex-col gap-[6px] pl-[18px] text-[13px] leading-[1.5] text-body">
        <li>Every browser is signed out.</li>
        <Show
          when={names(false)}
          fallback={<li id="auth-reset-machines">No machines are linked to this account.</li>}
        >
          {(machines) => (
            <li id="auth-reset-machines">
              These machines are unlinked. Their shells keep running; link each one again to reach
              it: <span class="text-ink">{machines()}</span>
            </li>
          )}
        </Show>
        <Show when={names(true)}>
          {(boxes) => (
            <li id="auth-reset-boxes" class="text-badink">
              These hosted boxes are deleted, with everything on them:{' '}
              <span class="font-medium">{boxes()}</span>
            </li>
          )}
        </Show>
      </ul>
      <p class="text-[12px] leading-[1.5] text-meta">
        Your account, box access and keyboard layout are kept.
      </p>
      {/* Tells a password manager which account the new password belongs to. */}
      <input type="hidden" name="username" autocomplete="username" value={props.address} />
      <label class="field-label" for="field-new-password">
        <span class="field-cap">New password</span>
        <input
          ref={passwordEl}
          id="field-new-password"
          name="password"
          type="password"
          autocomplete="new-password"
          minlength={12}
          required
          disabled={props.pending}
          class={['field', { 'field-bad': props.error.length > 0 }]}
        />
      </label>
      <button
        type="submit"
        disabled={props.pending}
        class="btn-danger btn-lg mt-1 w-full disabled:cursor-wait"
      >
        <Show when={props.pending}>
          <span class="spinner h-3.5 w-3.5" />
        </Show>
        {props.pending ? 'Resetting…' : 'Reset password'}
      </button>
      <button
        type="button"
        class="btn-quiet btn-sm self-center"
        disabled={props.pending}
        onClick={() => props.onCancel()}
      >
        Cancel
      </button>
    </form>
  );
};
