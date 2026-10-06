import { type Component, createEffect, type Element, Show } from 'solid-js';

import { shellCommands } from './app/commands';
import { createAppController } from './app/createAppController';
import { type AppPhase, SETTINGS_TABS } from './app/navigation';
import NoticeRail from './components/NoticeRail';
import OpenUrlToast from './components/OpenUrlToast';
import OverlayHost from './components/OverlayHost';
import PhaseHost from './components/PhaseHost';
import SwUpdateBanner from './components/SwUpdateBanner';
import TerminalHost from './components/TerminalHost';
import ViewLayer from './components/ViewLayer';
import { createKeybinds, suspendKeybinds } from './hooks/createKeybinds';
import AuthScreen from './screens/AuthScreen';
import DeviceList from './screens/DeviceList';
import SettingsScreen from './screens/SettingsScreen';
import SplashScreen from './screens/SplashScreen';

const App: Component = () => {
  const controller = createAppController();

  // An open dialog owns the keyboard outright. Held here for the whole stack
  // rather than as a clause in every screen's `active()`: the screens must not
  // have to agree about a fact that belongs to the app.
  createEffect(
    () => controller.overlays().length > 0,
    (open) => (open ? suspendKeybinds() : undefined),
  );

  // Reachable from every route, the terminal included. The *right* ⌘ only, so
  // left ⌘ combinations still reach the browser, the OS, and the terminal's own
  // Alt mapping untouched.
  createKeybinds({
    title: 'Anywhere',
    active: controller.isShell,
    bindings: [
      {
        // Not offered inside the palette itself, where it would be an entry
        // that reopens the thing already open.
        keys: 'rcmd+k',
        label: 'Search machines and actions',
        keyOnly: true,
        run: () => controller.onOpenCommandPalette(),
      },
    ],
  });

  createKeybinds({
    title: 'Terminal',
    active: controller.isTerminal,
    bindings: [
      {
        keys: 'rcmd+f',
        label: 'Fit terminal to this window',
        run: () => controller.session()?.takeGeometryControl(),
      },
    ],
  });

  // Everything else stays out of the terminal, where an unmodified key is a
  // keystroke the shell is waiting for.
  createKeybinds({
    title: 'Go to',
    active: () => controller.isShell() && !controller.isTerminal(),
    bindings: [
      { keys: 'g d', label: 'Machines', run: () => controller.onGoToDevices() },
      { keys: 'g s', label: 'Settings', run: () => controller.onOpenSettings('terminal') },
      { keys: '?', label: 'Keyboard shortcuts', run: () => controller.onOpenKeyboardHelp() },
    ],
  });

  const renderPhase = (phase: AppPhase): Element => {
    switch (phase) {
      case 'bootstrapping':
        return <SplashScreen />;
      case 'auth':
        return (
          <AuthScreen
            pending={controller.authPending()}
            error={controller.authError()}
            identity={controller.authIdentity()}
            codeAddress={controller.authCodeAddress()}
            reset={controller.authReset()}
            onShown={controller.loadAuthPolicy}
            onSubmit={controller.onAuthSubmit}
            onCodeSubmit={controller.onAuthCodeSubmit}
            onCodeResend={controller.onAuthCodeResend}
            onCodeCancel={controller.onAuthCodeCancel}
            onResetStart={controller.onAuthResetStart}
            onResetCodeSubmit={controller.onAuthResetCodeSubmit}
            onResetCodeResend={controller.onAuthResetCodeResend}
            onResetConfirm={controller.onAuthResetConfirm}
            onResetCancel={controller.onAuthResetCancel}
          />
        );
      case 'shell':
        return (
          <main id="app-shell" class="relative h-full w-full overflow-hidden">
            <ViewLayer active={controller.isDeviceList()} depth="base">
              <DeviceList
                connecting={controller.isConnecting()}
                error={controller.deviceError()}
                devices={controller.devices()}
                keysActive={controller.isDeviceList()}
                listStatus={controller.deviceListStatus()}
                linkCommand={controller.linkCommand()}
                machineUsage={controller.machineUsage()}
                linkCommandStatus={controller.linkCommandStatus()}
                operation={controller.deviceOperation()}
                selectedDeviceId={controller.selectedDeviceId()}
                serverVersion={controller.serverVersion()}
                onSelect={controller.onDeviceSelected}
                onLogout={controller.onLogout}
                onOpenCreateBox={controller.onOpenCreateBox}
                onOpenDeviceAction={controller.onOpenDeviceAction}
                onOpenLinkApproval={controller.onOpenLinkApproval}
                onStartDevice={controller.onStartDevice}
                onOpenSettings={() => controller.onOpenSettings('terminal')}
                onRefreshLink={controller.onRefreshLink}
              />
            </ViewLayer>

            <ViewLayer active={controller.isSettings()} depth="raised">
              <SettingsScreen
                browserPresence={controller.browserPresence()}
                browserSessions={controller.browserSessions()}
                browserSessionsError={controller.browserSessionsError()}
                browserSessionsPending={controller.browserSessionsPending()}
                keysActive={controller.isSettings()}
                tab={controller.settingsTab()}
                tabs={SETTINGS_TABS}
                telemetryEnabled={controller.telemetryEnabled()}
                telemetryStats={controller.telemetryStats()}
                terminalAppearance={controller.terminalAppearance()}
                terminalNotificationState={controller.terminalNotificationState()}
                username={controller.username()}
                onBack={controller.onSettingsBack}
                onBrowserSessionRevoke={controller.onBrowserSessionRevoke}
                onBrowserSessionsRevokeOthers={controller.onBrowserSessionsRevokeOthers}
                onChangePassword={controller.onChangePassword}
                deletionCancelled={controller.deletionCancelled()}
                onDeleteAccount={controller.onDeleteAccount}
                onLogout={controller.onLogout}
                onTabChange={controller.onSettingsTabChange}
                onTelemetryEnabledChange={controller.onTelemetryEnabledChange}
                onTerminalFontFamilyChange={controller.onTerminalFontFamilyChange}
                onTerminalFontSizeChange={controller.onTerminalFontSizeChange}
                onTerminalNotificationsDisable={controller.onTerminalNotificationsDisable}
                onTerminalNotificationsEnable={controller.onTerminalNotificationsEnable}
                onTerminalThemeChange={controller.onTerminalThemeChange}
              />
            </ViewLayer>

            {/* The terminal is the one route whose contents come and go, so it
                owns a host rather than a bare layer: the panel must survive its
                own exit long enough to be animated out, and must not be able to
                reach the controller once it has. */}
            <TerminalHost
              active={controller.isTerminal()}
              rings={controller.terminalRings()}
              deviceName={controller.selectedDeviceName()}
              status={controller.terminalStatus()}
              statusMode={controller.terminalStatusMode()}
              stage={controller.terminalStage()}
              diagnostics={controller.terminalDiagnostics()}
              terminalAppearance={controller.terminalAppearance()}
              session={controller.session}
              focusMode={controller.terminalFocusMode()}
              onToggleFocusMode={controller.onToggleTerminalFocusMode}
              onBack={controller.onBack}
              onRetry={controller.onTerminalRetry}
              onDisplayFrameReceived={controller.onDisplayFrameReceived}
              onDisplayFrameApplied={controller.onDisplayFrameApplied}
              onFirstDisplayGpuComplete={controller.onFirstDisplayGpuComplete}
              onWorkerReady={controller.onWorkerReady}
              onWorkerClose={controller.onWorkerClose}
              onWorkerDiagnostics={controller.onWorkerDiagnostics}
              onWorkerFatal={controller.onWorkerFatal}
              onRegisterTerminalPanel={controller.onRegisterTerminalPanel}
              onTerminalResize={controller.onTerminalResize}
              resolveLink={controller.resolveLink}
            />
          </main>
        );
    }
  };

  return (
    <>
      <PhaseHost phase={controller.phase()} onDeparted={controller.onPhaseDeparted}>
        {renderPhase}
      </PhaseHost>

      {/* Mounted outside every phase and view layer: an overlay belongs to the
          app, not to the screen that happened to open it, and its lifetime must
          not be tied to that screen staying mounted. */}
      <OverlayHost
        boxAccess={controller.boxAccess()}
        overlays={controller.overlays()}
        devices={controller.devices()}
        commands={shellCommands(controller)}
        onDismiss={controller.onOverlayDismiss}
        onApproveDaemonLink={controller.onApproveDaemonLink}
        onPreviewDaemonLink={controller.onPreviewDaemonLink}
        onCreateBox={controller.onCreateBox}
        onJoinBoxWaitlist={controller.onJoinBoxWaitlist}
        onRemove={controller.onDeviceRemove}
        onRename={controller.onDeviceRename}
      />

      <NoticeRail>
        {/* First, so a notice that arrives never moves the Reload button a
            reader may already be reaching for. */}
        <Show when={controller.swUpdate() !== 'none'}>
          <SwUpdateBanner
            applying={controller.swUpdate() === 'applying'}
            onReload={controller.onApplySwUpdate}
          />
        </Show>

        {/* Keyed: each request mounts its own toast, so the next one visibly arrives
            rather than swapping its URL under a pointer that was aimed at the last. */}
        <Show when={controller.openUrlRequests()[0]} keyed>
          {(url) => (
            <OpenUrlToast
              url={url}
              pending={controller.openUrlRequests().length - 1}
              onOpen={controller.onOpenUrlRequest}
              onDismiss={controller.onDismissOpenUrlRequest}
            />
          )}
        </Show>
      </NoticeRail>
    </>
  );
};

export default App;
