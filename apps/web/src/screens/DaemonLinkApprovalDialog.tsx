import { type Component, createSignal, Show } from 'solid-js';

import type { DaemonLinkApprovalOutcome } from '../auth/daemon-link-workflow';
import { OVERLAY_AUTOFOCUS_ATTRIBUTE, type OverlayControls } from '../components/overlay-controls';

interface Props {
  /**
   * From a `/link#<code>` address the machine printed: the code is already
   * known, so only the password is asked for. `null` when opened from the list,
   * where the code is typed or pasted.
   */
  code: string | null;
  controls: OverlayControls;
  onApprove(code: string, password: string): Promise<DaemonLinkApprovalOutcome>;
  onPreview(code: string): Promise<{ readonly name: string; readonly platform: string } | null>;
}

type Preview =
  | { readonly k: 'loading' }
  | { readonly k: 'ready'; readonly name: string; readonly platform: string }
  | { readonly k: 'invalid' };

const DaemonLinkApprovalDialog: Component<Props> = (props) => {
  let codeInputEl: HTMLInputElement | undefined;
  let passwordInputEl!: HTMLInputElement;
  const [pending, setPendingSignal] = createSignal(false);
  const [error, setError] = createSignal('');
  const [preview, setPreview] = createSignal<Preview>({ k: 'loading' });
  // The submit guard has to see the flag it just set; Solid 2 only makes that
  // visible to `pending()` after the next flush.
  let pendingNow = false;
  // Held here rather than in the DOM: the address it came from is already gone.
  let linkedCode = props.code;

  if (linkedCode !== null) {
    // Name the machine before asking for anything. The preview is verified
    // against the code's secret, so the name cannot be substituted.
    void props.onPreview(linkedCode).then((machine) => {
      setPreview(machine === null ? { k: 'invalid' } : { k: 'ready', ...machine });
    });
  }

  function setPending(next: boolean): void {
    pendingNow = next;
    setPendingSignal(next);
    props.controls.setBusy(next);
  }

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (pendingNow) return;
    const code = linkedCode ?? codeInputEl?.value.trim() ?? '';
    const password = passwordInputEl.value;
    if (code.length === 0 || password.length === 0) {
      setError(
        linkedCode === null
          ? 'Enter the daemon code and your Merkur password.'
          : 'Enter your Merkur password.',
      );
      return;
    }
    // Remove secrets from the DOM immediately. The workflow decodes the link
    // secret into owned bytes and wipes those bytes on every exit.
    if (codeInputEl !== undefined) codeInputEl.value = '';
    passwordInputEl.value = '';
    setPending(true);
    setError('');
    const outcome = await props.onApprove(code, password);
    setPending(false);
    if (outcome === 'approved') {
      linkedCode = null;
      props.controls.dismiss();
      return;
    }
    setError(
      outcome === 'machine_limit_reached'
        ? 'You can link up to 3 machines. Remove one to link this machine.'
        : 'The code or password was invalid, expired, or could not be verified.',
    );
    (codeInputEl ?? passwordInputEl).focus();
  }

  return (
    <form class="dialog" onSubmit={(event) => void submit(event)}>
      <h2
        id="daemon-link-approval-title"
        class="text-[16px] font-semibold leading-[1.35] tracking-[-0.018em] text-ink"
      >
        Approve a machine
      </h2>

      <Show
        when={props.code !== null}
        fallback={
          <label class="field-label">
            <span class="field-cap">Daemon code</span>
            <input
              ref={codeInputEl}
              disabled={pending()}
              autocomplete="off"
              autocapitalize="off"
              spellcheck={false}
              class="field font-mono"
              placeholder="claim-id.secret"
              {...{ [OVERLAY_AUTOFOCUS_ATTRIBUTE]: '' }}
            />
          </label>
        }
      >
        <p class="text-[13px] leading-[1.5] text-body" data-link-machine>
          {(() => {
            const current = preview();
            if (current.k === 'loading') return 'Checking the machine…';
            if (current.k === 'invalid') return 'This link is invalid or has expired.';
            return `Link ${current.name} (${current.platform}) to your account? Approve only a machine you just ran the link command on.`;
          })()}
        </p>
      </Show>
      <label class="field-label">
        <span class="field-cap">Merkur password</span>
        <input
          ref={passwordInputEl}
          type="password"
          disabled={pending()}
          autocomplete="current-password"
          class="field"
          {...(props.code === null ? {} : { [OVERLAY_AUTOFOCUS_ATTRIBUTE]: '' })}
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
        <button
          type="submit"
          disabled={pending()}
          class="btn-primary min-w-[132px] disabled:cursor-wait"
        >
          {pending() ? 'Verifying…' : 'Approve machine'}
        </button>
      </div>
    </form>
  );
};

export default DaemonLinkApprovalDialog;
