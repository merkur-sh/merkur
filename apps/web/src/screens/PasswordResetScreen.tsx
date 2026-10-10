import type { JSX } from '@solidjs/web';
import { animate } from 'motion';
import { type Component, createEffect, onSettled, Show } from 'solid-js';

import type { PasswordResetDevice } from '../auth/account-api';
import MailedCodeForm from '../components/MailedCodeForm';
import MerkurOrb from '../components/MerkurOrb';
import { ariaBool } from '../lib/aria';
import { NAV_SPRING, springTransition } from '../lib/motion';

/** The step the page is on: asking which account, waiting for its mailed code, or proven and awaiting the new password. */
type ResetView =
  | { readonly step: 'address'; readonly address: string }
  | { readonly step: 'code'; readonly address: string }
  | {
      readonly step: 'confirm';
      readonly address: string;
      readonly devices: readonly PasswordResetDevice[];
    };

interface Props {
  pending: boolean;
  error: string;
  reset: ResetView;
  /** The first step was submitted with this address. */
  onStart: (address: string) => void;
  onCodeSubmit: JSX.EventHandler<HTMLFormElement, SubmitEvent>;
  onCodeResend: () => void;
  onConfirm: JSX.EventHandler<HTMLFormElement, SubmitEvent>;
  /** Back to sign-in, from any step. */
  onCancel: () => void;
}

/**
 * Reset a forgotten password: a page of its own, reached from sign-in and left
 * for it again, on a server that names accounts by email.
 *
 * Three steps in one card. The first asks which account and mails nothing
 * until it is submitted; it starts with whatever address sign-in had typed.
 * The second takes the mailed code. The third names every machine the reset
 * unlinks and every box it deletes before it takes the new password, and
 * nothing is destroyed until that step is submitted. A reset the server has
 * ended comes back to the first step, which is where another one starts.
 *
 * The orb and the wordmark carry `vt-orb` and `vt-wordmark` as they do on
 * sign-in: the last step signs this browser in, and `PhaseHost` carries both
 * to the machine list header from whichever of the two pages is showing.
 */
const PasswordResetScreen: Component<Props> = (props) => {
  let sectionEl!: HTMLElement;

  onSettled(() => {
    // Transform only, as on sign-in: the phase layer owns every fade.
    const sectionAnimation = animate(sectionEl, { y: [8, 0] }, springTransition(NAV_SPRING));

    return () => sectionAnimation.stop();
  });

  return (
    <section
      ref={sectionEl}
      id="auth-reset-screen"
      class="slab flex w-full max-w-[400px] flex-col items-center gap-[14px] px-7 pb-7 pt-8 text-center"
      aria-busy={ariaBool(props.pending)}
    >
      <MerkurOrb size={72} class="vt-orb" />
      <p class="wordmark vt-wordmark">Merkur</p>
      <h1 class="text-[15px] font-medium text-ink">Reset password</h1>

      <Show
        when={addressStep(props.reset)}
        fallback={
          <Show
            when={confirmStep(props.reset)}
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
                onSubmit={props.onCodeSubmit}
                onResend={props.onCodeResend}
                onCancel={props.onCancel}
              >
                If <span class="text-ink">{props.reset.address}</span> has a Merkur account, we sent
                it a six-digit code. Enter it to reset the password; it expires in 10 minutes.
              </MailedCodeForm>
            }
          >
            {(confirm) => (
              <ResetConfirmForm
                address={confirm().address}
                devices={confirm().devices}
                pending={props.pending}
                error={props.error}
                onSubmit={props.onConfirm}
                onCancel={props.onCancel}
              />
            )}
          </Show>
        }
      >
        {(address) => (
          <ResetAddressForm
            address={address().address}
            pending={props.pending}
            error={props.error}
            onSubmit={props.onStart}
            onCancel={props.onCancel}
          />
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

export default PasswordResetScreen;

function addressStep(reset: ResetView) {
  return reset.step === 'address' ? reset : null;
}

function confirmStep(reset: ResetView) {
  return reset.step === 'confirm' ? reset : null;
}

interface ResetAddressProps {
  /** What the field starts with. */
  readonly address: string;
  readonly pending: boolean;
  readonly error: string;
  onSubmit: (address: string) => void;
  onCancel: () => void;
}

/**
 * The reset's first step: which account. The field takes focus when the form
 * appears and again, selected, whenever an answer comes back wrong.
 */
const ResetAddressForm: Component<ResetAddressProps> = (props) => {
  let addressEl!: HTMLInputElement;
  onSettled(() => addressEl.focus());
  createEffect(
    () => props.error,
    (error) => {
      if (error.length === 0) return;
      requestAnimationFrame(() => {
        addressEl.focus();
        addressEl.select();
      });
    },
  );

  return (
    <form
      id="auth-reset-address-form"
      class="mt-[6px] flex w-full flex-col gap-[14px] text-left"
      onSubmit={(event) => {
        event.preventDefault();
        props.onSubmit(addressEl.value.trim());
      }}
    >
      <p class="text-[13px] leading-[1.55] text-body">
        Enter the email address of your account. We mail it a six-digit code that lets you set a new
        password.
      </p>
      <label class="field-label" for="field-reset-address">
        <span class="field-cap">Email</span>
        <input
          ref={addressEl}
          id="field-reset-address"
          name="username"
          type="email"
          inputmode="email"
          autocomplete="username"
          spellcheck={false}
          required
          disabled={props.pending}
          value={props.address}
          class={['field', { 'field-bad': props.error.length > 0 }]}
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
        {props.pending ? 'Sending…' : 'Send code'}
      </button>
      <button
        type="button"
        class="btn-quiet btn-sm self-center"
        disabled={props.pending}
        onClick={() => props.onCancel()}
      >
        Back to sign in
      </button>
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
        Back to sign in
      </button>
    </form>
  );
};
