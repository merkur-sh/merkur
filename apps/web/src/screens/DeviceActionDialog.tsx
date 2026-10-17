import type { Device } from '@merkur/shared';
import { type Component, createMemo, createSignal, Show } from 'solid-js';

import BusyLabel from '../components/BusyLabel';
import MessageSlot from '../components/MessageSlot';
import { OVERLAY_AUTOFOCUS_ATTRIBUTE, type OverlayControls } from '../components/overlay-controls';
import { ariaBool } from '../lib/aria';

export type DeviceActionKind = 'rename' | 'remove';

const NAME_REQUIRED_ERROR = 'Enter a machine name.';
const CHANGE_FAILED_ERROR =
  'That change could not be completed. Check your connection and try again.';

interface Props {
  action: DeviceActionKind;
  device: Device;
  controls: OverlayControls;
  onRemove: (device: Device) => Promise<boolean>;
  onRename: (device: Device, name: string) => Promise<boolean>;
}

const DeviceActionDialog: Component<Props> = (props) => {
  let primaryEl!: HTMLButtonElement;
  let renameInputEl: HTMLInputElement | undefined;
  const [name, setName] = createSignal(props.device.name);
  const [submitting, setSubmitting] = createSignal(false);
  const [error, setError] = createSignal('');
  // The submit guard has to see the flag it just set; Solid 2 only makes that
  // visible to `submitting()` after the next flush.
  let submittingNow = false;

  const title = createMemo(() => {
    if (props.action === 'rename') return 'Rename machine';
    return `Remove ${props.device.name}?`;
  });

  const description = createMemo(() => {
    if (props.action === 'remove') {
      return 'This machine will disappear from Merkur until it is linked again.';
    }
    return 'Choose a short name that makes this machine easy to recognize.';
  });

  function setPending(pending: boolean): void {
    submittingNow = pending;
    setSubmitting(pending);
    props.controls.setBusy(pending);
  }

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (submittingNow) return;

    const nextName = name().trim();
    if (props.action === 'rename' && nextName.length === 0) {
      setError(NAME_REQUIRED_ERROR);
      renameInputEl?.focus();
      return;
    }

    setPending(true);
    setError('');
    const succeeded =
      props.action === 'rename'
        ? await props.onRename(props.device, nextName)
        : await props.onRemove(props.device);
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
          id="device-action-title"
          class="text-[16px] font-semibold leading-[1.35] tracking-[-0.018em] text-ink"
        >
          {title()}
        </h2>
        <MessageSlot
          id="device-action-description"
          error={error()}
          reserve={[NAME_REQUIRED_ERROR, CHANGE_FAILED_ERROR]}
          class="text-[12.5px] leading-[1.55] text-meta"
        >
          {description()}
        </MessageSlot>
      </div>

      <Show when={props.action === 'rename'}>
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
      </Show>

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
          class={props.action === 'remove' ? 'btn-danger' : 'btn-primary'}
          {...(props.action === 'remove' ? { [OVERLAY_AUTOFOCUS_ATTRIBUTE]: '' } : {})}
        >
          <BusyLabel
            busy={submitting()}
            idle={props.action === 'rename' ? 'Save name' : 'Remove machine'}
            pending={props.action === 'rename' ? 'Saving…' : 'Removing…'}
            spinnerClass="h-3 w-3"
            onFill
          />
        </button>
      </div>
    </form>
  );
};

export default DeviceActionDialog;
