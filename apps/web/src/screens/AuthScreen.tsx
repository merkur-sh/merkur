import type { JSX } from '@solidjs/web';
import { animate } from 'motion';
import { type Component, createEffect, onSettled, Show } from 'solid-js';

import { warmAccountOpaque } from '../auth/account-opaque';
import BusyLabel from '../components/BusyLabel';
import MailedCodeForm from '../components/MailedCodeForm';
import MerkurOrb from '../components/MerkurOrb';
import { ariaBool } from '../lib/aria';
import { NAV_SPRING, springTransition } from '../lib/motion';

interface Props {
  pending: boolean;
  error: string;
  /** What the account is named by; null until the server has said. */
  identity: 'username' | 'email' | null;
  /** Set while a sign-up waits for the code mailed to this address. */
  codeAddress: string | null;
  /** The screen is on: read what the form needs to ask for. */
  onShown: () => void;
  onSubmit: JSX.EventHandler<HTMLFormElement, SubmitEvent>;
  onCodeSubmit: JSX.EventHandler<HTMLFormElement, SubmitEvent>;
  onCodeResend: () => void;
  onCodeCancel: () => void;
  /** Leave for the password reset page, with whatever address is typed. */
  onResetOpen: (address: string) => void;
}

/**
 * Sign in: the mark, the name, two fields, one primary action.
 *
 * The orb and the wordmark are the whole identity of this screen; there is no
 * line of prose explaining what signing in leads to. The wordmark is the one
 * place the serif appears, and the button is the one control in the app that
 * glows at rest: this is the front door, and the front door gets the light.
 * Enter submits because this is a real form; the submit button turns busy and
 * answers no second press until the first has been answered.
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
 * Such a server also resets a forgotten password, on a page of its own:
 * `PasswordResetScreen`, which this one only links to.
 */
const AuthScreen: Component<Props> = (props) => {
  let sectionEl!: HTMLElement;
  let usernameEl: HTMLInputElement | undefined;
  let passwordEl: HTMLInputElement | undefined;

  createEffect(
    () => props.error,
    (error) => {
      // The code step owns its own field.
      if (error.length === 0 || props.codeAddress !== null) return;
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
        when={props.codeAddress}
        fallback={
          <form
            id="auth-form"
            class="mt-[6px] flex w-full flex-col gap-[14px] text-left"
            onSubmit={(event) => {
              // Busy is not `disabled`, so Enter still submits: the press that
              // started the request is the only one it answers.
              if (props.pending) {
                event.preventDefault();
                return;
              }
              props.onSubmit(event);
            }}
          >
            {/* Nothing to fill in until the server has said what an account is
            named by; the button alone asks it again after a failed read. */}
            <Show when={props.identity}>
              {(identity) => (
                <>
                  <label class="field-label" for="field-username">
                    <span class="field-cap">{identity() === 'email' ? 'Email' : 'Username'}</span>
                    <input
                      ref={usernameEl}
                      id="field-username"
                      name="username"
                      type={identity() === 'email' ? 'email' : 'text'}
                      inputmode={identity() === 'email' ? 'email' : undefined}
                      autocomplete="username"
                      autocapitalize="none"
                      autocorrect="off"
                      spellcheck={false}
                      required
                      readonly={props.pending}
                      aria-disabled={ariaBool(props.pending)}
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
                      readonly={props.pending}
                      aria-disabled={ariaBool(props.pending)}
                      class={['field', { 'field-bad': props.error.length > 0 }]}
                    />
                  </label>
                  <Show when={identity() === 'email'}>
                    {/* The reset page asks for the address itself, so nothing
                    has to be typed here first; what is typed goes along. */}
                    <button
                      type="button"
                      class="btn-quiet btn-sm -mt-1.5 self-end"
                      disabled={props.pending}
                      onClick={() => props.onResetOpen(usernameEl?.value.trim() ?? '')}
                    >
                      Forgot password?
                    </button>
                  </Show>
                </>
              )}
            </Show>

            {/* Busy while the request is in flight, and deliberately drawn at its
            own pressed colour rather than dimmed: the button has not become
            unavailable, it is busy doing the thing it was pressed for. It keeps
            focus, so a keyboard user is still on it when the answer lands. */}
            <button
              type="submit"
              aria-busy={ariaBool(props.pending)}
              aria-disabled={ariaBool(props.pending)}
              class={[
                'btn-primary btn-lg mt-1 w-full shadow-glow',
                { 'bg-accentdn': props.pending },
              ]}
            >
              <BusyLabel
                busy={props.pending}
                idle="Continue"
                pending="Continuing…"
                spinnerClass="h-3.5 w-3.5"
                onFill
              />
            </button>
            {/* Continue creates the account when the name is new, so the
            agreement sits under it rather than behind a checkbox. The
            pages are documents of their own; a new tab keeps the form. */}
            <p class="text-center text-[12px] leading-[1.5] text-meta">
              By continuing you accept the{' '}
              <a class="text-body underline" href="/terms" target="_blank" rel="noopener">
                Terms of Service
              </a>{' '}
              and confirm you have read the{' '}
              <a class="text-body underline" href="/privacy" target="_blank" rel="noopener">
                Privacy Policy
              </a>
              .
            </p>
            {/* Who operates the service, one step from the first screen. */}
            <p class="text-center text-[12px] leading-[1.5] text-meta">
              <a
                class="text-body underline"
                href="https://merkur.sh/contact"
                target="_blank"
                rel="noopener"
              >
                Contact / Impressum
              </a>
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
