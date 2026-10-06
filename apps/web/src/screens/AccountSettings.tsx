import { type Component, Show } from 'solid-js';

import BuildVerification from '../components/BuildVerification';
import ToggleSwitch from '../components/ToggleSwitch';
import type { TelemetryWorkerStats } from '../telemetry-worker-protocol';
import ChangePasswordForm from './ChangePasswordForm';
import DeleteAccountForm from './DeleteAccountForm';

interface Props {
  readonly telemetryEnabled: boolean;
  readonly telemetryStats: TelemetryWorkerStats | null;
  readonly username: string | null;
  onLogout(): Promise<void>;
  onChangePassword(
    currentPassword: string,
    newPassword: string,
    signal: AbortSignal,
  ): Promise<void>;
  readonly deletionCancelled: boolean;
  onDeleteAccount(password: string, signal: AbortSignal): Promise<number>;
  onTelemetryEnabledChange(enabled: boolean): void;
}

/**
 * Who is signed in, the one reporting switch, and the way out.
 *
 * Logging out is also one press from the machine list — this is the second
 * place it lives rather than the only one, because a settings screen is where
 * people look for it and the home header is where they need it.
 */
const AccountSettings: Component<Props> = (props) => (
  <>
    <div class="pref-group shrink-0">
      <div class="pref-row">
        <span class="min-w-0 flex-1">
          <span class="pref-name truncate">{props.username ?? 'Signed in'}</span>
          <span class="pref-sub">Browser delegation renews 30 days from sign-in</span>
        </span>
      </div>
      <div class="pref-row">
        <span class="min-w-0 flex-1">
          <span class="pref-name">Performance reporting</span>
          <Show
            when={props.telemetryStats}
            fallback={
              <span class="pref-sub">Ships timing samples from this browser to Merkur</span>
            }
          >
            {(stats) => (
              <span class="pref-sub font-mono frame:text-[16px]">
                {formatBytes(stats().bytesShipped)} shipped · {stats().rowsShipped.toLocaleString()}{' '}
                rows
                <Show when={stats().recordsLost > 0}>
                  {' '}
                  · {stats().recordsLost.toLocaleString()} lost
                </Show>
                <Show when={stats().sendFailures > 0}> · {stats().sendFailures} failed</Show>
                <Show when={stats().budgetExhausted}>
                  <span class="text-warn"> · budget reached, stopped</span>
                </Show>
              </span>
            )}
          </Show>
        </span>
        <ToggleSwitch
          label="Performance reporting"
          checked={props.telemetryEnabled}
          onChange={props.onTelemetryEnabledChange}
        />
      </div>
    </div>

    <ChangePasswordForm username={props.username} onChangePassword={props.onChangePassword} />

    <DeleteAccountForm
      username={props.username}
      deletionCancelled={props.deletionCancelled}
      onDeleteAccount={props.onDeleteAccount}
      onLogout={props.onLogout}
    />

    <BuildVerification />

    <div class="pref-group shrink-0">
      <div class="pref-row min-h-[44px] p-0">
        <button
          type="button"
          onClick={() => void props.onLogout()}
          class="btn-quiet w-full justify-start gap-[10px] px-[14px] text-badink hover:(bg-badsoft text-badink)"
        >
          <svg
            aria-hidden="true"
            viewBox="0 0 24 24"
            class="h-[15px] w-[15px]"
            fill="none"
            stroke="currentColor"
            stroke-width="1.8"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path d="M15 4H8a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h7" />
            <path d="M10 12h11m0 0-3.5-3.5M21 12l-3.5 3.5" />
          </svg>
          Log out
        </button>
      </div>
    </div>
  </>
);

export default AccountSettings;

/** Binary units, because a shipment budget is compared against an allowance. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KiB', 'MiB', 'GiB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}
