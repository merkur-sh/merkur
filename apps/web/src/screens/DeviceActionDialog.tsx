import type { Device } from '@merkur/shared';
import { type Component, createMemo, createSignal, Show } from 'solid-js';

import { OVERLAY_AUTOFOCUS_ATTRIBUTE, type OverlayControls } from '../components/overlay-controls';

export type DeviceActionKind = 'rename' | 'remove';

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
      setError('Enter a machine name.');
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
      setError('That change could not be completed. Check your connection and try again.');
      primaryEl.focus();
      return;
    }
    props.controls.dismiss();
  }

  const primaryLabel = (): string => {
    if (submitting()) {
      if (props.action === 'rename') return 'Saving…';
      return 'Removing…';
    }
    if (props.action === 'rename') return 'Save name';
    return 'Remove machine';
  };

  return (
    <form class="dialog" onSubmit={(event) => void submit(event)}>
      <div class="flex flex-col gap-[5px]">
        <h2
          id="device-action-title"
          class="text-[16px] font-semibold leading-[1.35] tracking-[-0.018em] text-ink"
        >
          {title()}
        </h2>
        <p id="device-action-description" class="text-[12.5px] leading-[1.55] text-meta">
          {description()}
        </p>
      </div>

      <Show when={props.action === 'rename'}>
        <label class="field-label">
          <span class="field-cap">Machine name</span>
          <input
            ref={renameInputEl}
            value={name()}
            onInput={(event) => setName(event.currentTarget.value)}
            disabled={submitting()}
            autocomplete="off"
            class="field"
            {...{ [OVERLAY_AUTOFOCUS_ATTRIBUTE]: '' }}
          />
        </label>
      </Show>

      <Show when={error().length > 0}>
        <p class="alert-bad" role="alert">
          {error()}
        </p>
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
          disabled={submitting()}
          class={[
            'min-w-[112px] disabled:cursor-wait',
            {
              'btn-danger': props.action === 'remove',
              'btn-primary': props.action !== 'remove',
            },
          ]}
          {...(props.action === 'remove' ? { [OVERLAY_AUTOFOCUS_ATTRIBUTE]: '' } : {})}
        >
          <Show when={submitting()}>
            <span class="spinner spinner--on-fill h-3 w-3" aria-hidden="true" />
          </Show>
          {primaryLabel()}
        </button>
      </div>
    </form>
  );
};

export default DeviceActionDialog;
