import type { Device } from '@merkur/shared';
import { type Component, createSignal } from 'solid-js';

import BusyLabel from '../components/BusyLabel';
import MessageSlot from '../components/MessageSlot';
import { OVERLAY_AUTOFOCUS_ATTRIBUTE, type OverlayControls } from '../components/overlay-controls';
import { ariaBool } from '../lib/aria';

const NAME_REQUIRED_ERROR = 'Enter a machine name.';
const CHANGE_FAILED_ERROR =
  'That change could not be completed. Check your connection and try again.';

interface Props {
  device: Device;
  controls: OverlayControls;
  onRename: (device: Device, name: string) => Promise<boolean>;
}

const RenameDeviceDialog: Component<Props> = (props) => {
  let primaryEl!: HTMLButtonElement;
  let renameInputEl: HTMLInputElement | undefined;
  const [name, setName] = createSignal(props.device.name);
  const [submitting, setSubmitting] = createSignal(false);
  const [error, setError] = createSignal('');
  // The submit guard has to see the flag it just set; Solid 2 only makes that
  // visible to `submitting()` after the next flush.
  let submittingNow = false;

  function setPending(pending: boolean): void {
    submittingNow = pending;
    setSubmitting(pending);
    props.controls.setBusy(pending);
  }

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (submittingNow) return;

    const nextName = name().trim();
    if (nextName.length === 0) {
      setError(NAME_REQUIRED_ERROR);
      renameInputEl?.focus();
      return;
    }

    setPending(true);
    setError('');
    const succeeded = await props.onRename(props.device, nextName);
    setPending(false);

    if (!succeeded) {
      setError(CHANGE_FAILED_ERROR);
      primaryEl.focus();
      return;
    }
    props.controls.dismiss();
  }

  return (
    <form class="dialog" onSubmit={(event) => void submit(event)}>
      <div class="flex flex-col gap-[5px]">
        <h2
          id="rename-device-title"
          class="text-[16px] font-semibold leading-[1.35] tracking-[-0.018em] text-ink"
        >
          Rename machine
        </h2>
        <MessageSlot
          id="rename-device-description"
          error={error()}
          reserve={[NAME_REQUIRED_ERROR, CHANGE_FAILED_ERROR]}
          class="text-[12.5px] leading-[1.55] text-meta"
        >
          Choose a short name that makes this machine easy to recognize.
        </MessageSlot>
      </div>

      <label class="field-label">
        <span class="field-cap">Machine name</span>
        <input
          ref={renameInputEl}
          value={name()}
          onInput={(event) => setName(event.currentTarget.value)}
          readonly={submitting()}
          aria-disabled={ariaBool(submitting())}
          autocomplete="off"
          class={['field', { 'field-bad': error() === NAME_REQUIRED_ERROR }]}
          {...{ [OVERLAY_AUTOFOCUS_ATTRIBUTE]: '' }}
        />
      </label>

      <div class="flex justify-end gap-2">
        <button
          type="button"
          disabled={submitting()}
          onClick={() => props.controls.dismiss()}
          class="btn-quiet disabled:cursor-wait"
        >
          Cancel
        </button>
        <button
          ref={primaryEl}
          type="submit"
          aria-busy={ariaBool(submitting())}
          aria-disabled={ariaBool(submitting())}
          class="btn-primary"
        >
          <BusyLabel
            busy={submitting()}
            idle="Save name"
            pending="Saving…"
            spinnerClass="h-3 w-3"
            onFill
          />
        </button>
      </div>
    </form>
  );
};

export default RenameDeviceDialog;
