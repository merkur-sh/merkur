import { type Component, createSignal, Match, onSettled, Show, Switch } from 'solid-js';

import type { BoxAccess } from '../api';
import { OVERLAY_AUTOFOCUS_ATTRIBUTE, type OverlayControls } from '../components/overlay-controls';

/**
 * Creates a box, which becomes its own machine in the device list.
 *
 * Boxes are gated per account: until an operator approves it, the dialog is
 * the waitlist instead of the form. `access` is null while the answer is on
 * its way, and the dialog says so rather than guessing either way.
 *
 * The password is required because a box runs its own Merkur daemon, and a
 * daemon can only be authorized by the user root key — which is derived from
 * the password and never cached. This is the same reason linking any machine
 * asks for it.
 */

interface Props {
  access: BoxAccess | null;
  controls: OverlayControls;
  onCreate(boxId: string, password: string): Promise<boolean>;
  onJoinWaitlist(): Promise<boolean>;
}

/** Matches the server route and Incus instance naming. */
const BOX_NAME_PATTERN = /^[a-z][a-z0-9-]{0,62}$/;

const ADJECTIVES = [
  'amber',
  'brisk',
  'calm',
  'clever',
  'copper',
  'eager',
  'gentle',
  'hazel',
  'lucid',
  'mellow',
  'nimble',
  'olive',
  'quiet',
  'rapid',
  'silver',
  'vivid',
] as const;

const NOUNS = [
  'anchor',
  'beacon',
  'canyon',
  'delta',
  'ember',
  'harbor',
  'island',
  'kernel',
  'lagoon',
  'meadow',
  'orchard',
  'ridge',
  'summit',
  'thicket',
  'valley',
  'willow',
] as const;

/** Every pair is lowercase ASCII, so any suggestion is a valid box name. */
function suggestBoxName(): string {
  const pick = <T,>(items: readonly T[]): T =>
    items[Math.min(items.length - 1, Math.floor(Math.random() * items.length))] as T;
  return `${pick(ADJECTIVES)}-${pick(NOUNS)}`;
}

const CreateBoxDialog: Component<Props> = (props) => (
  <Switch>
    <Match when={props.access?.status === 'approved'}>
      <CreateBoxForm controls={props.controls} onCreate={props.onCreate} />
    </Match>
    <Match when={props.access?.status === 'waitlisted'}>
      <BoxAccessNotice
        title="You're on the waitlist"
        body="Boxes open for this account once an operator approves it. The waitlist records nothing beyond the account itself, so check back here."
        controls={props.controls}
      />
    </Match>
    <Match when={props.access?.status === 'none'}>
      <JoinWaitlist controls={props.controls} onJoin={props.onJoinWaitlist} />
    </Match>
    <Match when={props.access === null}>
      <BoxAccessNotice
        title="New box"
        body="Checking whether this account can create boxes…"
        controls={props.controls}
      />
    </Match>
  </Switch>
);

const BoxAccessNotice: Component<{
  readonly title: string;
  readonly body: string;
  readonly controls: OverlayControls;
}> = (props) => (
  <div class="dialog">
    <div class="flex flex-col gap-[5px]">
      <h2
        id="create-box-title"
        class="text-[16px] font-semibold leading-[1.35] tracking-[-0.018em] text-ink"
      >
        {props.title}
      </h2>
      <p class="text-[12.5px] leading-[1.55] text-meta">{props.body}</p>
    </div>
    <div class="flex justify-end gap-2">
      <button
        type="button"
        onClick={() => props.controls.dismiss()}
        class="btn-quiet"
        {...{ [OVERLAY_AUTOFOCUS_ATTRIBUTE]: '' }}
      >
        Close
      </button>
    </div>
  </div>
);

const JoinWaitlist: Component<{
  readonly controls: OverlayControls;
  onJoin(): Promise<boolean>;
}> = (props) => {
  const [pending, setPendingSignal] = createSignal(false);
  const [error, setError] = createSignal('');
  // Same reason as the form below: the guard must see the flag it just set.
  let pendingNow = false;

  async function join(): Promise<void> {
    if (pendingNow) return;
    pendingNow = true;
    setPendingSignal(true);
    props.controls.setBusy(true);
    setError('');
    const joined = await props.onJoin();
    pendingNow = false;
    setPendingSignal(false);
    props.controls.setBusy(false);
    // On success the account's standing changes and the dialog becomes the
    // waitlist notice by itself; only a failure needs saying here.
    if (!joined) setError('Could not join the waitlist. Try again.');
  }

  return (
    <div class="dialog">
      <div class="flex flex-col gap-[5px]">
        <h2
          id="create-box-title"
          class="text-[16px] font-semibold leading-[1.35] tracking-[-0.018em] text-ink"
        >
          New box
        </h2>
        <p class="text-[12.5px] leading-[1.55] text-meta">
          Boxes are sandboxes hosted for you, and they open account by account. Join the waitlist
          and an operator approves this account; nothing beyond the account is recorded.
        </p>
      </div>

      <Show when={error().length > 0}>
        <p class="alert-bad" role="alert">
          {error()}
        </p>
      </Show>

      <div class="flex justify-end gap-2">
        <button
          type="button"
          disabled={pending()}
          onClick={() => props.controls.dismiss()}
          class="btn-quiet disabled:cursor-wait"
        >
          Cancel
        </button>
        <button
          type="button"
          disabled={pending()}
          onClick={() => void join()}
          class="btn-primary disabled:cursor-wait"
          {...{ [OVERLAY_AUTOFOCUS_ATTRIBUTE]: '' }}
        >
          {pending() ? 'Joining…' : 'Join the waitlist'}
        </button>
      </div>
    </div>
  );
};

const CreateBoxForm: Component<{
  readonly controls: OverlayControls;
  onCreate(boxId: string, password: string): Promise<boolean>;
}> = (props) => {
  let nameInputEl!: HTMLInputElement;
  let passwordInputEl!: HTMLInputElement;
  const [pending, setPendingSignal] = createSignal(false);
  const [error, setError] = createSignal('');
  // The submit guard has to see the flag it just set; Solid 2 only makes that
  // visible to `pending()` after the next flush.
  let pendingNow = false;

  onSettled(() => {
    // Prefilled so creating a box is one field plus the password.
    nameInputEl.value = suggestBoxName();
  });

  function setPending(next: boolean): void {
    pendingNow = next;
    setPendingSignal(next);
    props.controls.setBusy(next);
  }

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (pendingNow) return;
    const boxId = nameInputEl.value.trim();
    const password = passwordInputEl.value;
    if (!BOX_NAME_PATTERN.test(boxId)) {
      setError('Use 1-63 characters of a-z, 0-9 or -, starting with a letter.');
      return;
    }
    if (password.length === 0) {
      setError('Enter your Merkur password.');
      return;
    }
    // Clear the password from the DOM before the await; the approval workflow
    // wipes the derived root bytes on every exit.
    passwordInputEl.value = '';
    setPending(true);
    setError('');
    const created = await props.onCreate(boxId, password);
    setPending(false);
    if (created) {
      props.controls.dismiss();
      return;
    }
    setError(
      'Could not create the box. The name may be taken, the host at capacity, or the password wrong.',
    );
    passwordInputEl.focus();
  }

  return (
    <form class="dialog" onSubmit={(event) => void submit(event)}>
      <div class="flex flex-col gap-[5px]">
        <h2
          id="create-box-title"
          class="text-[16px] font-semibold leading-[1.35] tracking-[-0.018em] text-ink"
        >
          New box
        </h2>
        <p class="text-[12.5px] leading-[1.55] text-meta">
          A sandbox that joins your machines. It runs its own Merkur, so linking it needs your
          password.
        </p>
      </div>

      <label class="field-label">
        <span class="field-cap">Name</span>
        <input
          ref={nameInputEl}
          disabled={pending()}
          autocomplete="off"
          autocapitalize="off"
          spellcheck={false}
          class="field font-mono"
          placeholder="quiet-harbor"
        />
      </label>
      <label class="field-label">
        <span class="field-cap">Merkur password</span>
        <input
          ref={passwordInputEl}
          type="password"
          disabled={pending()}
          autocomplete="current-password"
          class="field"
          {...{ [OVERLAY_AUTOFOCUS_ATTRIBUTE]: '' }}
        />
      </label>

      <Show when={error().length > 0}>
        <p class="alert-bad" role="alert">
          {error()}
        </p>
      </Show>

      <div class="flex justify-end gap-2">
        <button
          type="button"
          disabled={pending()}
          onClick={() => props.controls.dismiss()}
          class="btn-quiet disabled:cursor-wait"
        >
          Cancel
        </button>
        <button type="submit" disabled={pending()} class="btn-primary disabled:cursor-wait">
          {pending() ? 'Creating…' : 'Create box'}
        </button>
      </div>
    </form>
  );
};

export default CreateBoxDialog;
