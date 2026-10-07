/**
 * The Boxes waitlist form.
 *
 * Without script it is a plain form that posts `email` to the app's
 * `/api/box-waitlist`; the browser marks that post as a navigation, and the
 * endpoint answers it with a 303 back to this page's `#waitlist-done` line,
 * which the stylesheet shows as the target. With script it posts the same body
 * with `fetch`, as a CORS simple
 * request (form-encoded, no credentials), and says what happened in the live
 * region under the field. The endpoint answers 204 for a new address and a
 * repeated one alike, so there is one "done" line for both.
 *
 * While a post is in flight the button stays focusable and says so with
 * `aria-disabled`: a disabled button that has focus drops it to the body.
 * Rybbit counts the button's click, which comes before the submit handler
 * checks the address, so the button names its event only while the field holds
 * an address the form will send.
 */
export type WaitlistOutcome = 'done' | 'refused' | 'limited' | 'unreached';

export const WAITLIST_MESSAGES = {
  idle: "We'll email you once when Boxes are available. Nothing else.",
  sending: 'Sending…',
  invalid: 'Enter the whole address, like name@example.com.',
  done: "You're on the list. I'll write when boxes open.",
  refused: 'That address was refused. Check it and try again.',
  limited: 'Too many tries from this network. Wait a minute, then try again.',
  unreached: "Couldn't reach merkur.sh. Nothing was sent.",
} as const;

const REFUSALS: ReadonlySet<unknown> = new Set(['email_refused', 'email_invalid']);

/** The Rybbit event a click on the submit button sends, when it will send an address. */
const SUBMIT_EVENT = 'cta_waitlist_submit';

/**
 * What an answer means for the visitor. 204 is on the list; a 400 naming the
 * address is a refused address; 429 is the rate limit. Anything else, a
 * malformed request or a server fault included, did not get the address onto
 * the list, which is what the "didn't reach me" line says.
 */
export function waitlistOutcome(status: number, body: unknown): WaitlistOutcome {
  if (status === 204) return 'done';
  if (status === 429) return 'limited';
  if (
    status === 400 &&
    typeof body === 'object' &&
    body !== null &&
    'error' in body &&
    REFUSALS.has(body.error)
  ) {
    return 'refused';
  }
  return 'unreached';
}

async function readBody(response: Response): Promise<unknown> {
  if (response.status !== 400) return null;
  try {
    return await response.json();
  } catch {
    return null;
  }
}

export function initWaitlist(form: HTMLFormElement): void {
  const input = form.querySelector('input[name="email"]');
  const button = form.querySelector('button[type="submit"]');
  const message = form.querySelector('[role="status"]');
  if (
    !(input instanceof HTMLInputElement) ||
    !(button instanceof HTMLButtonElement) ||
    !(message instanceof HTMLElement)
  ) {
    throw new Error('waitlist: the form needs an email field, a submit button and a status line');
  }
  const label = button.textContent ?? '';
  // Script says what is wrong with the address itself; without script the
  // browser's own validation stays on.
  form.noValidate = true;
  let sending = false;

  const say = (text: string, bad: boolean): void => {
    message.textContent = text;
    message.classList.toggle('bad', bad);
    input.setAttribute('aria-invalid', bad ? 'true' : 'false');
  };

  const arm = (): void => {
    if (!sending && input.value !== '' && input.checkValidity()) {
      button.dataset.rybbitEvent = SUBMIT_EVENT;
    } else {
      delete button.dataset.rybbitEvent;
    }
  };
  input.addEventListener('input', arm);
  arm();

  const busy = (on: boolean): void => {
    sending = on;
    button.setAttribute('aria-disabled', on ? 'true' : 'false');
    button.textContent = on ? 'Sending…' : label;
    arm();
  };

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (sending) return;
    input.value = input.value.trim();
    if (!input.checkValidity()) {
      say(WAITLIST_MESSAGES.invalid, true);
      input.focus();
      return;
    }
    busy(true);
    say(WAITLIST_MESSAGES.sending, false);
    let outcome: WaitlistOutcome;
    try {
      const response = await fetch(form.action, {
        method: 'POST',
        body: new URLSearchParams({ email: input.value }),
        credentials: 'omit',
      });
      outcome = waitlistOutcome(response.status, await readBody(response));
    } catch {
      outcome = 'unreached';
    }
    say(WAITLIST_MESSAGES[outcome], outcome !== 'done');
    message.classList.toggle('ok', outcome === 'done');
    busy(false);
    if (outcome === 'done') {
      // The address is on the list: the form has nothing left to send.
      form.classList.add('is-done');
      input.readOnly = true;
      button.textContent = 'On the list';
      button.setAttribute('aria-disabled', 'true');
      sending = true;
      // A click on it sends nothing now, so it names no event to count.
      arm();
    } else if (outcome === 'unreached') {
      button.textContent = 'Try again';
    }
  });
}
