import { OUT_EASE } from '@merkur/quicksilver/motion';
import { merkurVersion } from '@merkur/shared';
import { animate } from 'motion';
import {
  type Component,
  createEffect,
  createSignal,
  For,
  Match,
  onCleanup,
  onSettled,
  Switch,
} from 'solid-js';

import type { SettingsTab } from '../app/navigation';
import type { BrowserSessionRecord } from '../auth/account-api';
import { createKeybinds } from '../hooks/createKeybinds';
import { ariaBool } from '../lib/aria';
import { focusableWithin } from '../lib/focus-trap';
import { stepIndex } from '../lib/keybinds';
import { motionDuration } from '../lib/motion';
import type { TelemetryWorkerStats } from '../telemetry-worker-protocol';
import type { TerminalAppearance } from '../terminal/appearance';
import type { TerminalFontFamilyId } from '../terminal/fonts';
import type { TerminalNotificationState } from '../terminal/notifications';
import type { TerminalThemeId } from '../terminal/themes';
import {
  loadVirtualKeyboardPreferences,
  observeVirtualKeyboardPreferences,
  saveVirtualKeyboardPreferences,
  type VirtualKeyboardPreferences,
} from '../terminal/virtual-keyboard';
import AccountSettings from './AccountSettings';
import KeyboardPreferencesEditor from './KeyboardPreferencesEditor';
import SessionSettings from './SessionSettings';
import TerminalSettings from './TerminalSettings';

const TAB_LABEL: Record<SettingsTab, string> = {
  terminal: 'Terminal',
  keyboard: 'Keyboard',
  sessions: 'Sessions',
  account: 'Account',
};

interface Props {
  readonly browserPresence: readonly string[] | null;
  readonly browserSessions: readonly BrowserSessionRecord[];
  readonly browserSessionsError: string;
  readonly browserSessionsPending: boolean;
  /** Whether this screen's route is the one on show, so its keys are live. */
  readonly keysActive: boolean;
  readonly tab: SettingsTab;
  /** The tabs this account has: the four, plus Admin for an operator. */
  readonly tabs: readonly SettingsTab[];
  readonly telemetryEnabled: boolean;
  readonly telemetryStats: TelemetryWorkerStats | null;
  readonly terminalAppearance: TerminalAppearance;
  readonly terminalNotificationState: TerminalNotificationState;
  readonly username: string | null;
  onBack(): void;
  onBrowserSessionRevoke(delegationId: string): Promise<void>;
  onBrowserSessionsRevokeOthers(): Promise<void>;
  onLogout(): Promise<void>;
  readonly deletionCancelled: boolean;
  onDeleteAccount(password: string, signal: AbortSignal): Promise<number>;
  onChangePassword(
    currentPassword: string,
    newPassword: string,
    signal: AbortSignal,
  ): Promise<void>;
  onTabChange(tab: SettingsTab): void;
  onTelemetryEnabledChange(enabled: boolean): void;
  onTerminalFontFamilyChange(fontFamilyId: TerminalFontFamilyId): void;
  onTerminalFontSizeChange(fontSize: number): void;
  onTerminalNotificationsDisable(): Promise<void>;
  onTerminalNotificationsEnable(): Promise<void>;
  onTerminalThemeChange(themeId: TerminalThemeId): void;
}

/**
 * One settings screen, four tabs, one way back.
 *
 * Terminal and Keyboard used to be one long page and Sessions a second screen
 * entirely, so comparing two settings meant leaving one screen and entering
 * another. The tab bar puts every setting one press from every other, and the
 * chosen tab takes the ink line and nothing else — a tab that filled or grew
 * would read as a button rather than as where you are.
 */
const SettingsScreen: Component<Props> = (props) => {
  let sectionEl!: HTMLElement;
  let panelEl!: HTMLDivElement;
  const [keyboardPreferences, setKeyboardPreferences] = createSignal(
    loadVirtualKeyboardPreferences(),
  );
  onSettled(() => observeVirtualKeyboardPreferences(setKeyboardPreferences));

  function updateKeyboardPreferences(preferences: VirtualKeyboardPreferences): void {
    setKeyboardPreferences(preferences);
    saveVirtualKeyboardPreferences(preferences);
  }

  /**
   * `j`/`k` walk every control in the open tab, in document order. The old
   * screen collapsed a row of choices into one stop and gave `h`/`l` to
   * stepping through it, but the tabs need `h`/`l` more: a theme is chosen once
   * and the tab is switched constantly.
   *
   * Scoped to the panel, so neither the tab bar nor the way back is a stop.
   * A cursor that can wander onto the control that replaces everything under it
   * is not a cursor through the settings; `l` switches tabs and Escape leaves.
   */
  function moveSetting(delta: 1 | -1): void {
    const stops = focusableWithin(panelEl);
    const active = document.activeElement;
    const current = active instanceof HTMLElement ? stops.indexOf(active) : -1;
    const nextIndex = stepIndex(stops.length, current, delta);
    if (nextIndex === null) return;
    stops[nextIndex]?.focus();
  }

  function stepTab(delta: 1 | -1): void {
    const index = props.tabs.indexOf(props.tab);
    const nextIndex = stepIndex(props.tabs.length, index, delta);
    const next = nextIndex === null ? undefined : props.tabs[nextIndex];
    if (next !== undefined) props.onTabChange(next);
  }

  /**
   * Revoking is the one thing a settings tab does that is worth a key of its
   * own, and it only exists on one tab — bound in its own scope so `x` is not a
   * dead key on the other three, and so the `?` sheet only offers it where it
   * would work.
   */
  function revokeFocusedSession(): void {
    const active = document.activeElement;
    const row = active instanceof Element ? active.closest('[data-session-row]') : null;
    row?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.click();
  }

  createKeybinds({
    title: 'Sessions',
    active: () => props.keysActive && props.tab === 'sessions',
    bindings: [
      { keys: 'x', label: 'Revoke this browser', keyOnly: true, run: revokeFocusedSession },
      {
        keys: 'X',
        label: 'Revoke all other browsers',
        run: () => void props.onBrowserSessionsRevokeOthers().catch(() => undefined),
      },
    ],
  });

  createKeybinds({
    title: 'Settings',
    active: () => props.keysActive,
    bindings: [
      { keys: 'j', label: 'Next setting', keyOnly: true, run: () => moveSetting(1) },
      { keys: 'k', label: 'Previous setting', keyOnly: true, run: () => moveSetting(-1) },
      { keys: 'l', label: 'Next tab', keyOnly: true, run: () => stepTab(1) },
      { keys: 'h', label: 'Previous tab', keyOnly: true, run: () => stepTab(-1) },
      { keys: '1', label: 'Terminal tab', keyOnly: true, run: () => props.onTabChange('terminal') },
      { keys: '2', label: 'Keyboard tab', keyOnly: true, run: () => props.onTabChange('keyboard') },
      { keys: '3', label: 'Sessions tab', keyOnly: true, run: () => props.onTabChange('sessions') },
      { keys: '4', label: 'Account tab', keyOnly: true, run: () => props.onTabChange('account') },
      { keys: 'q', label: 'Back to machines', run: () => props.onBack() },
      { keys: 'Escape', label: 'Back to machines', keyOnly: true, run: () => props.onBack() },
    ],
  });

  onSettled(() => {
    const motion = animate(
      sectionEl,
      { opacity: [0, 1], transform: ['translateX(16px)', 'translateX(0px)'] },
      { duration: motionDuration(0.16), ease: OUT_EASE },
    );
    return () => motion.stop();
  });

  /**
   * The panel settles into the tab it is becoming rather than cutting to it.
   *
   * It travels; it does not fade. Every card here is opaque on a page ground
   * that is nearly black, so fading the panel in from zero shows that ground
   * straight through them — which reads as a black flash under the cards
   * rather than as a transition. Four pixels of travel says the same thing and
   * never makes anything see-through.
   *
   * The transform is cleared the moment it lands. An identity transform left
   * on this element would make it the containing block for the
   * `position: fixed` sheet the keyboard tab opens from inside it, so the
   * sheet would size and place itself against the panel instead of the
   * viewport — which is exactly how the row menu on the machine list ended up
   * painted over by the rows below it.
   *
   * The scroller also goes back to the top. A tab arriving already scrolled to
   * wherever the last one was left is the other half of what reads as a jump.
   */
  let panelMotion: ReturnType<typeof animate> | null = null;
  function releasePanelTransform(): void {
    panelEl.style.transform = '';
    panelEl.style.willChange = '';
  }
  createEffect(
    () => props.tab,
    () => {
      panelEl.scrollTop = 0;
      panelMotion?.stop();
      releasePanelTransform();
      const motion = animate(
        panelEl,
        { transform: ['translateY(4px)', 'translateY(0px)'] },
        { duration: motionDuration(0.14), ease: OUT_EASE },
      );
      panelMotion = motion;
      motion.finished.then(releasePanelTransform, releasePanelTransform);
    },
    { defer: true },
  );
  onCleanup(() => {
    panelMotion?.stop();
    releasePanelTransform();
  });

  return (
    <section ref={sectionEl} id="settings" class="app-frame lg:max-w-[560px]">
      <header class="flex h-14 shrink-0 items-center gap-2 border-b border-solid border-line1 px-3">
        <button
          type="button"
          onClick={props.onBack}
          aria-label="Back to machines"
          class="btn-icon h-[30px] w-[30px]"
        >
          <svg
            aria-hidden="true"
            viewBox="0 0 16 16"
            class="h-[14px] w-[14px]"
            fill="none"
            stroke="currentColor"
            stroke-width="1.6"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path d="M10 3 5 8l5 5" />
          </svg>
        </button>
        <h1 class="min-w-0 flex-1 truncate text-center text-[15px] font-semibold text-ink">
          Settings
        </h1>
        {/* The back button's footprint, so the title is centred on the screen
            rather than on what is left of it. */}
        <span class="w-[30px] shrink-0" />
      </header>

      <div class="tabbar" role="tablist" aria-label="Settings sections">
        <For each={props.tabs}>
          {(tab) => (
            <button
              type="button"
              role="tab"
              data-settings-tab={tab}
              id={`settings-tab-${tab}`}
              aria-selected={ariaBool(props.tab === tab)}
              aria-controls="settings-panel"
              onClick={() => props.onTabChange(tab)}
              class={['tab', { 'tab-on': props.tab === tab }]}
            >
              {TAB_LABEL[tab]}
            </button>
          )}
        </For>
      </div>

      <div
        ref={panelEl}
        id="settings-panel"
        role="tabpanel"
        aria-labelledby={`settings-tab-${props.tab}`}
        class="app-pane flex flex-col gap-[22px] px-4 pb-3 pt-5"
      >
        <Switch>
          <Match when={props.tab === 'terminal'}>
            <TerminalSettings
              terminalAppearance={props.terminalAppearance}
              terminalNotificationState={props.terminalNotificationState}
              onTerminalFontFamilyChange={props.onTerminalFontFamilyChange}
              onTerminalFontSizeChange={props.onTerminalFontSizeChange}
              onTerminalNotificationsDisable={props.onTerminalNotificationsDisable}
              onTerminalNotificationsEnable={props.onTerminalNotificationsEnable}
              onTerminalThemeChange={props.onTerminalThemeChange}
            />
          </Match>

          <Match when={props.tab === 'keyboard'}>
            <KeyboardPreferencesEditor
              preferences={keyboardPreferences()}
              onChange={updateKeyboardPreferences}
            />
          </Match>

          <Match when={props.tab === 'sessions'}>
            <SessionSettings
              activeDelegationIds={props.browserPresence}
              error={props.browserSessionsError}
              pending={props.browserSessionsPending}
              sessions={props.browserSessions}
              onRevoke={props.onBrowserSessionRevoke}
              onRevokeOthers={props.onBrowserSessionsRevokeOthers}
            />
          </Match>

          <Match when={props.tab === 'account'}>
            <AccountSettings
              telemetryEnabled={props.telemetryEnabled}
              telemetryStats={props.telemetryStats}
              username={props.username}
              onLogout={props.onLogout}
              onChangePassword={props.onChangePassword}
              deletionCancelled={props.deletionCancelled}
              onDeleteAccount={props.onDeleteAccount}
              onTelemetryEnabledChange={props.onTelemetryEnabledChange}
            />
          </Match>
        </Switch>

        {/* AGPL section 13: a user interacting with this build over a network is
            owed an offer of its corresponding source, so the offer sits on every
            settings tab rather than behind one of them. */}
        <p class="text-[11.5px] leading-[1.55] text-meta">
          Merkur {merkurVersion()} is free software under the{' '}
          <a
            class="underline"
            href="https://www.gnu.org/licenses/agpl-3.0.html"
            rel="noreferrer"
            target="_blank"
          >
            GNU AGPL v3
          </a>
          . The source of this build, and of the daemon it talks to, is at{' '}
          <a
            class="underline"
            href="https://github.com/merkur-sh/merkur"
            rel="noreferrer"
            target="_blank"
          >
            github.com/merkur-sh/merkur
          </a>
          ; a linked machine prints the same notices with <code>merkur licenses</code>.
        </p>
      </div>
    </section>
  );
};

export default SettingsScreen;
