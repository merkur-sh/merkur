import { createLogger } from '@merkur/logger';
import {
  type Device,
  formatTraceparent,
  type MachineUsage,
  mintTraceContext,
  shouldPreserveInputOnDisconnect,
  type TraceContext,
} from '@merkur/shared';
import type { DaemonBinding } from '@merkur/shared/user-authorization';
import { type Accessor, createEffect, createMemo, createSignal, onSettled } from 'solid-js';
import {
  type BoxAccess,
  cancelSessionRequest,
  createBox,
  refreshAccessToken,
  renewSession,
  reportBrowserError,
  reportBrowserLink,
  reportBrowserUpgrade,
  requestSession,
  startDeviceBox,
} from '../api';
import type { BrowserSessionRecord } from '../auth/account-api';
import { requestAccountDeletion } from '../auth/account-deletion';
import { type ActiveBrowserAccount, resumeBrowserAccount } from '../auth/account-workflow';
import {
  approvePermanentDaemonLink,
  type DaemonLinkApprovalOutcome,
  previewDaemonLink,
} from '../auth/daemon-link-workflow';
import { changeBrowserAccountPassword } from '../auth/password-change';
import type { PasswordReset } from '../auth/password-reset';
import { createAuth } from '../hooks/createAuth';
import { type SwUpdateState, useServiceWorkerLifecycle } from '../hooks/useServiceWorkerLifecycle';
import { isApiError, shouldRefreshSessionRequest } from '../lib/api-error';
import { loadCachedDeviceList } from '../lib/device-list-cache';
import { createTransportAutotuner } from '../lib/transport-autotuner';
import {
  type BrowserErrorReporter,
  createBrowserErrorReporter,
  installGlobalErrorHandlers,
} from '../perf/error-reporter';
import type { LinkQualitySample } from '../perf/link-quality-aggregator';
import {
  clearMainPerfProducer,
  installMainPerfProducer,
  mainPerfInterner,
  mainPerfWriter,
} from '../perf/main-perf-writer';
import {
  browserMainThreadFrameMonitorHost,
  createMainThreadFrameMonitor,
  type MainThreadFrameMonitor,
} from '../perf/main-thread-frame-monitor';
import {
  emitMainFrameCadence,
  emitMainLongTask,
  emitStartupMilestone,
} from '../perf/perf-event-codec';
import {
  initializeTelemetryPreference,
  saveTelemetryEnabled,
  TELEMETRY_SESSION_BYTE_BUDGET,
} from '../perf/telemetry-preference';
import { createTelemetryReporter, type TelemetryReporter } from '../perf/telemetry-reporter';
import { type TerminalStartupMilestone, terminalPerfNowMs } from '../perf/terminal-latency';
import type { DeviceActionKind } from '../screens/DeviceActionDialog';
import type { TerminalPanelHandle, TerminalSize } from '../screens/TerminalPanel';
import { createPredictionRttForwarder } from '../session/prediction-rtt-forwarding';
import {
  createTelemetryWorkerClient,
  type TelemetryWorkerClient,
} from '../telemetry-worker-client';
import type { TelemetryWorkerStats } from '../telemetry-worker-protocol';
import {
  loadTerminalAppearance,
  saveTerminalAppearance,
  TERMINAL_LINE_HEIGHT,
  type TerminalAppearance,
  terminalAppearanceWithFontSize,
} from '../terminal/appearance';
import { TERMINAL_FONTS, type TerminalFontFamilyId } from '../terminal/fonts';
import {
  startKeyboardSettingsSync,
  stopKeyboardSettingsSync,
} from '../terminal/keyboard-settings-sync';
import { createLinkDefinitions } from '../terminal/link-definitions';
import { openableUrl } from '../terminal/link-detection';
import {
  disableTerminalNotifications,
  enableTerminalNotifications,
  loadTerminalNotificationState,
  type TerminalNotificationState,
} from '../terminal/notifications';
import { createTerminalRingBundle, type TerminalRingBundle } from '../terminal/ring-bundle';
import { terminalRuntimePolicyForUserAgent } from '../terminal/runtime-policy';
import {
  decideTerminalStartFailure,
  RECONNECT_OVERLAY_GRACE_MS,
  type TerminalStage,
  type TerminalStatusMode,
  terminalStatusModeForStage,
} from '../terminal/status-presentation';
import { TERMINAL_THEMES, type TerminalThemeId } from '../terminal/themes';
import type { TerminalWorkerClient } from '../terminal-worker-client';
import type { TerminalWorkerDiagnostics } from '../terminal-worker-protocol';
import { createTransportSession, type TerminalSession } from '../transport-worker-client';
import type {
  RenewSessionRequest,
  RenewSessionResult,
  RequestSessionResult,
} from '../transport-worker-protocol';
import { createBoxAccessController } from './box-access-controller';
import { createBrowserSessionsController } from './browser-sessions-controller';
import { createConnectionAttemptOwner } from './connection-attempt';
import {
  createDeviceListController,
  type DeviceListStatus,
  type DeviceOperation,
  type LinkCommandStatus,
} from './createDeviceListController';
import { documentTitle } from './document-title';
import { takeDaemonLinkCode } from './link-url';
import {
  type AppPhase,
  createNavigation,
  type Overlay,
  type Route,
  type SettingsTab,
} from './navigation';
import { createTerminalSessionEpochHandoff } from './terminal-session-epoch-handoff';

const logger = createLogger('web');
const LAST_DEVICE_ID_KEY = 'merkur:last-device-id';
/**
 * Handled `merkur open` ids remembered per session. A resource bound equal to
 * the daemon's `OPEN_URL_PENDING_MAX`: a repeat can only be a request still
 * pending there, and at most that many are.
 */
const OPEN_URL_REQUEST_IDS_KEPT = 16;

export interface AppController {
  readonly browserPresence: Accessor<readonly string[] | null>;
  readonly authError: Accessor<string>;
  readonly authPending: Accessor<boolean>;
  /** What the sign-in form asks for; null until the server has said. */
  readonly authIdentity: Accessor<'username' | 'email' | null>;
  /** The address a sign-up code went to, while the form waits for it. */
  readonly authCodeAddress: Accessor<string | null>;
  /** The password reset in progress, while the sign-in card carries it. */
  readonly authReset: Accessor<PasswordReset | null>;
  readonly browserSessions: Accessor<BrowserSessionRecord[]>;
  readonly browserSessionsError: Accessor<string>;
  readonly browserSessionsPending: Accessor<boolean>;
  readonly deviceError: Accessor<string>;
  readonly deviceListStatus: Accessor<DeviceListStatus>;
  readonly deviceOperation: Accessor<DeviceOperation | null>;
  readonly devices: Accessor<Device[]>;
  readonly isConnecting: Accessor<boolean>;
  readonly isDeviceList: Accessor<boolean>;
  readonly isSettings: Accessor<boolean>;
  readonly isShell: Accessor<boolean>;
  readonly isTerminal: Accessor<boolean>;
  /** Which of the four settings tabs the route is on. */
  readonly settingsTab: Accessor<SettingsTab>;
  /** The signed-in username, for the account tab. Null before sign-in. */
  readonly username: Accessor<string | null>;
  /** True when the sign-in that opened this session called off a scheduled erasure. */
  readonly deletionCancelled: Accessor<boolean>;
  /** The account's box waitlist standing; null until the first answer. */
  readonly boxAccess: Accessor<BoxAccess | null>;
  readonly linkCommand: Accessor<string>;
  readonly machineUsage: Accessor<MachineUsage | null>;
  readonly linkCommandStatus: Accessor<LinkCommandStatus>;
  readonly overlays: Accessor<readonly Overlay[]>;
  readonly phase: Accessor<AppPhase>;
  readonly selectedDeviceId: Accessor<string | null>;
  readonly selectedDeviceName: Accessor<string>;
  readonly serverVersion: Accessor<string | null>;
  readonly session: Accessor<TerminalSession | null>;
  readonly swUpdate: Accessor<SwUpdateState>;
  /** URLs programs in the terminal asked to open while the user was idle, oldest first. */
  readonly openUrlRequests: Accessor<readonly string[]>;
  /** Open the oldest request inside the click that asked for it. */
  onOpenUrlRequest(): void;
  onDismissOpenUrlRequest(): void;
  onApplySwUpdate(): void;
  readonly terminalAppearance: Accessor<TerminalAppearance>;
  readonly terminalDiagnostics: Accessor<TerminalWorkerDiagnostics | null>;
  /**
   * Chrome-free terminal. Held here rather than in `TerminalPanel` because the
   * panel is keyed on its ring bundle: selecting another machine from the
   * command palette replaces the panel, and panel-local state would drop the
   * user out of focus mode on a switch made from inside it.
   */
  readonly terminalFocusMode: Accessor<boolean>;
  readonly terminalNotificationState: Accessor<TerminalNotificationState>;
  readonly telemetryEnabled: Accessor<boolean>;
  /** Live profiling-shipment stats, or null when profiling is off or idle. */
  readonly telemetryStats: Accessor<TelemetryWorkerStats | null>;
  readonly terminalRings: Accessor<TerminalRingBundle | null>;
  readonly terminalStage: Accessor<TerminalStage>;
  readonly terminalStatus: Accessor<string>;
  readonly terminalStatusMode: Accessor<TerminalStatusMode>;
  loadAuthPolicy(): Promise<void>;
  onAuthSubmit(event: SubmitEvent): Promise<void>;
  onAuthCodeSubmit(event: SubmitEvent): Promise<void>;
  onAuthCodeResend(): Promise<void>;
  onAuthCodeCancel(): void;
  onAuthResetStart(address: string): Promise<void>;
  onAuthResetCodeSubmit(event: SubmitEvent): Promise<void>;
  onAuthResetCodeResend(): Promise<void>;
  onAuthResetConfirm(event: SubmitEvent): Promise<void>;
  onAuthResetCancel(): void;
  onBack(): Promise<void>;
  onDeviceSelected(device: Device): Promise<void>;
  onDeviceRename(device: Device, name: string): Promise<boolean>;
  onDeviceRemove(device: Device): Promise<boolean>;
  onLogout(): Promise<void>;
  onChangePassword(
    currentPassword: string,
    newPassword: string,
    signal: AbortSignal,
  ): Promise<void>;
  /** Schedules this account's erasure; resolves with the instant it falls due. */
  onDeleteAccount(password: string, signal: AbortSignal): Promise<number>;
  onApproveDaemonLink(code: string, password: string): Promise<DaemonLinkApprovalOutcome>;
  /** The machine a link code belongs to, verified against the code; `null` when it is not. */
  onPreviewDaemonLink(
    code: string,
  ): Promise<{ readonly name: string; readonly platform: string } | null>;
  /**
   * Creates a box and links it as its own device.
   *
   * Takes the password because the box's daemon can only be authorized by the
   * user root key, which nothing caches — the same reason linking any device
   * asks for it.
   */
  onCreateBox(boxId: string, password: string): Promise<boolean>;
  /** Joins the box waitlist; false when the request failed. */
  onJoinBoxWaitlist(): Promise<boolean>;
  /**
   * Restarts a box whose device is offline because the reaper stopped it. No
   * password: this starts an already-linked box rather than authorizing a new
   * daemon.
   */
  onStartDevice(deviceId: string): Promise<boolean>;
  onBrowserSessionsRefresh(): Promise<void>;
  onBrowserSessionRevoke(delegationId: string): Promise<void>;
  onBrowserSessionsRevokeOthers(): Promise<void>;
  onGoToDevices(): void;
  onOpenCommandPalette(): void;
  onOpenCreateBox(): void;
  onOpenKeyboardHelp(): void;
  onOpenDeviceAction(action: DeviceActionKind, device: Device): void;
  onOpenLinkApproval(): void;
  /** Opens Settings on `tab`, loading whatever that tab needs. */
  onOpenSettings(tab: SettingsTab): void;
  onSettingsBack(): void;
  onSettingsTabChange(tab: SettingsTab): void;
  /** Closes the topmost overlay. The host animates the departing node. */
  onOverlayDismiss(): void;
  /** A phase layer has left the screen; see `Navigation.departed`. */
  onPhaseDeparted(): void;
  onToggleTerminalFocusMode(): void;
  onRefreshLink(): Promise<void>;
  onTerminalRetry(): Promise<void>;
  onRegisterTerminalPanel(handle: TerminalPanelHandle | null): void;
  onTerminalResize(size: TerminalSize): void;
  /** The URI the connected daemon defined for an OSC 8 link id, if it has arrived. */
  resolveLink(id: number): string | undefined;
  onTerminalFontFamilyChange(fontFamilyId: TerminalFontFamilyId): void;
  onTerminalFontSizeChange(fontSize: number): void;
  onTerminalNotificationsDisable(): Promise<void>;
  onTerminalNotificationsEnable(): Promise<void>;
  onTelemetryEnabledChange(enabled: boolean): void;
  onTerminalThemeChange(themeId: TerminalThemeId): void;
  onWorkerClose(): void;
  onWorkerDiagnostics(diagnostics: TerminalWorkerDiagnostics): void;
  /** The first applied frame of an output burst. */
  onDisplayFrameReceived(): void;
  onDisplayFrameApplied(displayKind: 'display_snapshot' | 'display_delta'): void;
  onFirstDisplayGpuComplete(
    displayKind: 'display_snapshot' | 'display_delta' | 'display_resume',
  ): void;
  onWorkerFatal(message: string): void;
  onWorkerReady(client: TerminalWorkerClient): void;
}

interface TerminalStatusModel {
  readonly deviceName: string;
  readonly stage: TerminalStage;
  readonly transportLabel: string;
  readonly rttMs: number | null;
  readonly signalingReconnecting: boolean;
  readonly detail: string;
}

interface StartupTrace {
  readonly attemptId: number;
  readonly deviceId: string;
  readonly startedAtMs: number;
  readonly milestones: Set<TerminalStartupMilestone>;
  /**
   * Trace context for this connect attempt, minted before the session request goes out.
   *
   * The same value is sent as the `traceparent` on `POST /api/sessions/request` and carried
   * on every startup milestone, so the browser's derived bootstrap spans, the server's
   * `session_request` span and the daemon's command span all land in one trace. Its span id
   * is the id the browser's root bootstrap span claims, which is what makes the server's
   * route span a child rather than a sibling.
   */
  readonly traceContext: TraceContext;
  session: TerminalSession | null;
}

export function createAppController(): AppController {
  const nav = createNavigation();
  const [accessTokenSignal, setAccessTokenSignal] = createSignal<string | null>(null);
  const accessToken = accessTokenSignal;

  /**
   * Keep the telemetry worker's bearer token current.
   *
   * It holds its own copy because it posts from its own thread; a rotation that
   * did not reach it would silently 401 every profiling batch for the rest of
   * the session.
   */
  function setAccessToken(next: string | null): void {
    setAccessTokenSignal(next);
    if (next !== null) {
      telemetryWorker?.setAccessToken(next);
      return;
    }
    // `null` is the one funnel every session ending passes through — sign-out, a
    // failed refresh, a definitive 401 — so the keyboard sync is stopped here
    // rather than at each of them. An in-flight push must not land after the
    // account it belongs to is gone.
    stopKeyboardSettingsSync();
    deviceList.stop();
  }
  /**
   * A rotation the device-events loop performed on its own. The account keeps
   * its copy of the session in step: everything that reads
   * `account().session.accessToken` — revoking browsers, changing the password,
   * deleting the account — would otherwise present the token that just expired.
   * Only the token moves; the delegation, and the server-clock sample paired with
   * its receipt, are the ones the account was resumed with.
   */
  function adoptRotatedAccessToken(next: string): void {
    const current = account();
    if (current !== null && current.session.accessToken !== next) {
      setAccount({ ...current, session: { ...current.session, accessToken: next } });
    }
    setAccessToken(next);
  }
  const [account, setAccount] = createSignal<ActiveBrowserAccount | null>(null);
  let rejectedAccount: ActiveBrowserAccount | null = null;
  const [terminalStatus, setTerminalStatus] = createSignal('');
  const [terminalStatusMode, setTerminalStatusMode] = createSignal<TerminalStatusMode>('hidden');
  const [terminalDiagnostics, setTerminalDiagnostics] =
    createSignal<TerminalWorkerDiagnostics | null>(null);
  const [terminalNotificationState, setTerminalNotificationState] = createSignal(
    loadTerminalNotificationState(),
  );
  // Reads the stored choice and installs the perf recorder before any terminal
  // worker exists, so the first session of the page latches the right
  // `perfEnabled` rather than the one after it.
  const [telemetryEnabled, setTelemetryEnabled] = createSignal(initializeTelemetryPreference());
  const [telemetryStats, setTelemetryStats] = createSignal<TelemetryWorkerStats | null>(null);
  const [session, setSession] = createSignal<TerminalSession | null>(null);
  const [remoteTitle, setRemoteTitle] = createSignal('');
  const [swUpdate, setSwUpdate] = createSignal<SwUpdateState>('none');
  const [openUrlRequests, setOpenUrlRequests] = createSignal<readonly string[]>([]);
  const [terminalAppearance, setTerminalAppearance] = createSignal(loadTerminalAppearance());
  const [terminalRings, setTerminalRings] = createSignal<TerminalRingBundle | null>(null);
  const [terminalStage, setTerminalStage] = createSignal<TerminalStage>('idle');
  const [terminalFocusMode, setTerminalFocusMode] = createSignal(false);
  /** Pending overlay reveal, cancelled when the session recovers inside the grace. */
  let reconnectOverlayTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * The same grace, for the FIRST-FRAME half of a reconnect.
   *
   * `onSignalingStatus` delays the reconnecting flag so a fast rebind is
   * invisible, but `onConnected` then set `first-frame` outright — and
   * `terminalStatusModeForStage` renders that as `progress`, so every reconnect
   * painted a "Restoring display" card regardless of how quick it was. Worse,
   * the repaint hold suppresses rendering until the repair completes, so the
   * card was shown for the whole hold. Delaying this transition the same way is
   * what actually delivers the "a rebind the user does not notice" the grace
   * was introduced for.
   */
  let firstFrameOverlayTimer: ReturnType<typeof setTimeout> | null = null;
  const [selectedDevice, setSelectedDevice] = createSignal<Device | null>(null);
  /** Read by the terminal chrome and by the tab title, so it is named once. */
  const selectedDeviceName = (): string => selectedDevice()?.name ?? '';
  const browserSessions = createBrowserSessionsController({
    getAccount: () => account(),
    authorize: (signal, request) => withSessionAuthorization(signal, (token) => request(token)),
  });
  const boxAccess = createBoxAccessController({ getAccessToken: () => accessToken() });

  let workerClient: TerminalWorkerClient | null = null;
  const predictionRttForwarder = createPredictionRttForwarder();
  const connectionAttempts = createConnectionAttemptOwner(terminalPerfNowMs);
  let deviceListLifetime = 0;
  /** From a `/link#<code>` address; taken before anything can render the URL. */
  let pendingDaemonLinkCode = takeDaemonLinkCode(window.location, window.history);
  let startupTrace: StartupTrace | null = null;
  let terminalPanelHandle: TerminalPanelHandle | null = null;
  const linkDefinitions = createLinkDefinitions();
  // Ids of the `merkur open` requests this session has handled, newest last.
  const handledOpenUrlRequests: string[] = [];
  let latestTerminalSize: TerminalSize | null = null;
  let transportAutotuner: ReturnType<typeof createTransportAutotuner> | null = null;
  /**
   * Per-session link-quality reporting. Owned here because its lifetime is the
   * session's: created with the transport, flushed and released in teardown.
   */
  let telemetryReporter: TelemetryReporter | null = null;
  let telemetryWorker: TelemetryWorkerClient | null = null;
  let mainThreadFrameMonitor: MainThreadFrameMonitor | null = null;
  /**
   * Browser failure reporting.
   *
   * Unlike the reporters above, this one's lifetime is the *page*, not the session: the
   * failures worth knowing about are exactly the ones that stop a session from existing —
   * WASM that would not instantiate, a worker that would not start. Tying it to a session
   * would leave it uninstalled for the failures it exists to catch.
   */
  let errorReporter: BrowserErrorReporter | null = null;
  let removeGlobalErrorHandlers: (() => void) | null = null;
  let displayFrameAppliedForSession = false;

  function createProfilingWorker(rings: TerminalRingBundle): TelemetryWorkerClient | null {
    const token = accessToken();
    // No token means no authenticated session to attribute rows to, and the
    // worker holds no way to obtain one. Profiling starts with the next session.
    if (token === null) return null;
    return createTelemetryWorkerClient({
      rings,
      origin: window.location.origin,
      accessToken: token,
      byteBudget: TELEMETRY_SESSION_BYTE_BUDGET,
      flushMainThreadObservations: () => mainThreadFrameMonitor?.flush(),
      onStats: setTelemetryStats,
      onWorkerError: (error) => errorReporter?.record('telemetry_worker', error),
    });
  }

  /**
   * Start failure reporting, gated by the same "Performance reporting" preference as
   * everything else. No new setting and no new consent copy: the body carries two closed
   * unions and a count, which is a narrower disclosure than any surface already behind that
   * switch.
   */
  function startErrorReporting(): void {
    if (errorReporter !== null) return;
    errorReporter = createBrowserErrorReporter({
      send: (report) => {
        const token = accessToken();
        if (token === null) return;
        // Never awaited: reporting that something broke must not be able to break anything
        // else, and a failed report is a non-event.
        void reportBrowserError(token, report).catch(() => {});
      },
    });
    removeGlobalErrorHandlers = installGlobalErrorHandlers(errorReporter);
  }

  function stopErrorReporting(): void {
    removeGlobalErrorHandlers?.();
    removeGlobalErrorHandlers = null;
    errorReporter?.stop();
    errorReporter = null;
  }

  // Installed at boot rather than with the first session, because the failures worth
  // catching are the ones that stop a session from ever starting.
  if (telemetryEnabled()) {
    startErrorReporting();
  }

  function createLinkTelemetryReporter(): TelemetryReporter {
    return createTelemetryReporter({
      send: async (report) => {
        const token = accessToken();
        // No token means no authenticated session to attribute the window to.
        // Dropping it is correct: telemetry never triggers a token refresh.
        if (token === null) return;
        await reportBrowserLink(token, report);
      },
    });
  }

  let statusModel: TerminalStatusModel = {
    deviceName: '',
    stage: 'idle',
    transportLabel: '',
    rttMs: null,
    signalingReconnecting: false,
    detail: '',
  };

  const deviceList = createDeviceListController({
    setAccessToken: (next) => adoptRotatedAccessToken(next),
    onSessionRejected,
    onBrowserSessionsChanged,
    // Read lazily: the reporter comes and goes with the performance-reporting
    // preference, and a device-events lifetime outlives both.
    reportStreamFailure: (kind) => errorReporter?.count('device_events', kind),
  });
  const {
    authError,
    authPending,
    authIdentity,
    authCodeAddress,
    authReset,
    attemptSessionRefresh,
    loadAuthPolicy,
    onAuthSubmit,
    onAuthCodeSubmit,
    onAuthCodeResend,
    onAuthCodeCancel,
    onAuthResetStart,
    onAuthResetCodeSubmit,
    onAuthResetCodeResend,
    onAuthResetConfirm,
    onAuthResetCancel,
    onLogout: performLogout,
    onSessionRejected: rejectAccountSession,
  } = createAuth({
    enterAuth: () => nav.enterAuth(),
    endSignedInState: () => clearSignedInState(),
    setAccessToken: (next) => setAccessToken(next),
    setAccount: (next) => setAccount(next),
    getAccount: () => account(),
    loadDevices: async (token, userId) => {
      // Same edge as the device list: a credential just became live, whether by
      // sign-in or by resuming one. The keyboard arrangement is an account fact,
      // so this is where the device adopts it. It reads the token signal per
      // request rather than this one, so a rotation mid-lifetime is carried.
      startKeyboardSettingsSync(() => accessToken());
      // Also an account fact: whether this account may create boxes, and
      // whether it runs the waitlist, which decides if Settings has that tab.
      void boxAccess.load(token).catch(() => undefined);
      return loadDevices(token, userId);
    },
  });
  const terminalSessionEpochHandoff = createTerminalSessionEpochHandoff({
    getSession: () => session(),
    getWorker: () => workerClient,
    sendCurrentResize: (activeSession) => sendCurrentTerminalResize(activeSession),
  });

  createEffect(
    () => ({
      phase: nav.phase(),
      route: nav.route().k,
      connection: nav.connection(),
      devices: deviceList.deviceListStatus(),
      deviceAttempts: deviceList.deviceListAttempts(),
    }),
    ({ phase, route, connection, devices, deviceAttempts }) => {
      // Not diagnostic: `phase` and `connection` are the contract every e2e
      // assertion reads (`tests/e2e/app-state.ts`, and the iOS harness through
      // the same unions). They are typed by `navigation.ts`, so renaming a value
      // there fails the suite's type check rather than leaving it polling a
      // value nothing writes — which is how the previous `data-state` enum
      // stranded both readers. `route` is diagnostic. Layout is not written
      // here at all any more: each phase layer carries its own frame, so body
      // no longer changes shape a frame after the state that caused it — which
      // is also what lets two phases overlap while one dissolves into the other.
      document.body.dataset.phase = phase;
      document.body.dataset.route = route;
      document.body.dataset.connection = connection;
      // `devices` joins them for the same reason: what the machine list can say
      // about itself is a fact a test must be able to assert, and the badge that
      // renders it is a rendered string, not a contract.
      document.body.dataset.devices = devices;
      // Whether anything is being tried, which the status alone cannot say: a
      // loop attempting and getting nowhere and a loop that never started read
      // identically as `refreshing`, and only one of them leaves a trace
      // anywhere else.
      document.body.dataset.deviceAttempts = String(deviceAttempts);
      document.body.classList.add('app-body');
    },
  );

  /**
   * The tab's title. A separate effect from the body attributes above rather
   * than another field on that tuple: this one must not depend on `connection`,
   * which changes several times per reconnect, and it must depend on the
   * selected machine's name, which those attributes have no use for.
   *
   * The computation returns the finished string, so an equal title is not
   * rewritten — a device-list refresh that renames nothing leaves the tab
   * alone.
   */
  createEffect(
    () =>
      session() !== null && remoteTitle() !== ''
        ? `${remoteTitle()} · Merkur`
        : documentTitle(nav.phase(), nav.route(), selectedDeviceName()),
    (title) => {
      document.title = title;
    },
  );

  const onApplySwUpdate = useServiceWorkerLifecycle({
    setSwUpdate,
  });

  onSettled(() => {
    const fontSet = document.fonts;
    if (!fontSet?.ready) {
      return;
    }

    const refresh = (): void => {
      const appearance = terminalAppearance();
      workerClient?.updateFont(appearance.fontSize, TERMINAL_LINE_HEIGHT);
    };

    void fontSet.ready.then(refresh);
    if (typeof fontSet.addEventListener === 'function') {
      fontSet.addEventListener('loadingdone', refresh);
      return () => fontSet.removeEventListener('loadingdone', refresh);
    }
  });

  // Where this boot is going, guessed before the refresh round trip decides
  // it, so the splash can already look like its destination: on a phone the
  // paper desk shows behind the login and not behind the machine list, and a
  // splash that changed its ground on arrival would be the seam this exists
  // to remove. The device-list cache is the synchronous trace of a signed-in
  // account — written after every sign-in, cleared when the account goes —
  // and it is read here rather than awaited from the vault because the vault
  // is IndexedDB and the guess has to land before the first frame Solid
  // paints. A wrong guess costs one 160 ms fade on the login (see
  // `body::before` in `uno.config.ts`).
  document.body.dataset.boot = loadCachedDeviceList() === null ? 'fresh' : 'returning';

  onSettled(() => {
    void attemptSessionRefresh();
  });

  const isShell = createMemo(() => nav.phase() === 'shell');
  // A connect attempt is a connection fact, so the device list stays the route
  // while its selected row spins. Only the transition to `signaling` pushes the
  // terminal over it.
  const isConnecting = createMemo(() => nav.connection() === 'connecting');
  const routeIs = (k: Route['k']): (() => boolean) =>
    createMemo(() => isShell() && nav.route().k === k);
  const isDeviceList = routeIs('devices');
  const isSettings = routeIs('settings');
  const isTerminal = routeIs('terminal');
  // Held across a move off Settings so the screen keeps drawing its own tab
  // while the view layer animates it out, rather than snapping to a default.
  const [settingsTab, setSettingsTab] = createSignal<SettingsTab>('terminal');
  createEffect(
    () => nav.route(),
    (route) => {
      if (route.k === 'settings') setSettingsTab(route.tab);
    },
  );

  /**
   * Whatever a tab needs before it can draw. Only Sessions has anything to
   * fetch, and it is fetched on arrival rather than at sign-in: a list of other
   * browsers is worth a round trip when someone asks to see it and worth
   * nothing before that.
   */
  function loadSettingsTab(tab: SettingsTab): void {
    if (tab === 'sessions') void browserSessions.load().catch(() => undefined);
  }

  return {
    browserPresence: deviceList.browserPresence,
    authError,
    authPending,
    authIdentity,
    authCodeAddress,
    authReset,
    browserSessions: browserSessions.sessions,
    browserSessionsError: browserSessions.error,
    browserSessionsPending: browserSessions.pending,
    deviceError: deviceList.deviceError,
    deviceListStatus: deviceList.deviceListStatus,
    deviceOperation: deviceList.deviceOperation,
    devices: deviceList.devices,
    isConnecting,
    isDeviceList,
    isSettings,
    isShell,
    isTerminal,
    settingsTab,
    username: () => account()?.username ?? null,
    deletionCancelled: () => account()?.session.deletionCancelled ?? false,
    boxAccess: boxAccess.access,
    linkCommand: deviceList.linkCommand,
    machineUsage: deviceList.machineUsage,
    linkCommandStatus: deviceList.linkCommandStatus,
    overlays: nav.overlays,
    phase: nav.phase,
    selectedDeviceId: () => selectedDevice()?.id ?? null,
    selectedDeviceName,
    serverVersion: deviceList.serverVersion,
    session,
    swUpdate,
    openUrlRequests,
    onOpenUrlRequest() {
      const [url] = openUrlRequests();
      if (url === undefined) return;
      setOpenUrlRequests((requests) => requests.slice(1));
      window.open(url, '_blank', 'noopener,noreferrer');
    },
    onDismissOpenUrlRequest() {
      setOpenUrlRequests((requests) => requests.slice(1));
    },
    onApplySwUpdate,
    terminalAppearance,
    terminalDiagnostics,
    terminalFocusMode,
    terminalNotificationState,
    telemetryEnabled,
    telemetryStats,
    terminalRings,
    terminalStage,
    terminalStatus,
    terminalStatusMode,
    loadAuthPolicy,
    onAuthSubmit,
    onAuthCodeSubmit,
    onAuthCodeResend,
    onAuthCodeCancel,
    onAuthResetStart,
    onAuthResetCodeSubmit,
    onAuthResetCodeResend,
    onAuthResetConfirm,
    onAuthResetCancel,
    onBack,
    onDeviceSelected,
    onDeviceRename,
    onDeviceRemove,
    onLogout: performLogout,
    onPhaseDeparted: () => nav.departed(),
    async onChangePassword(currentPassword, newPassword, signal) {
      const current = account();
      if (current === null) throw new Error('No active browser account');
      const updated = await changeBrowserAccountPassword(
        current,
        currentPassword,
        newPassword,
        signal,
      );
      if (signal.aborted || account() !== current) return;
      setAccount(updated);
      setAccessToken(updated.session.accessToken);
      browserSessions.reset();
    },
    async onDeleteAccount(password, signal) {
      const current = account();
      if (current === null) throw new Error('No active browser account');
      // Nothing is cleared here. The request revoked this delegation server
      // side, so the session is already dead; the screen says so and signing
      // out is the user's next press.
      return await requestAccountDeletion(current, password, signal);
    },

    async onCreateBox(boxId, password) {
      const currentAccount = account();
      if (currentAccount === null) return false;
      try {
        const created = await createBox(currentAccount.session.accessToken, boxId);
        // The box's daemon is already polling for this approval; until it
        // lands, the container exists but is not a device.
        await approvePermanentDaemonLink(currentAccount, created.linkCode, password);
        // The new row arrives on the live stream as an `added` delta, in this
        // tab and every other one; nothing here needs to refetch.
        return true;
      } catch (error) {
        logger.warn('box_create_failed', { boxId, error: String(error) });
        return false;
      }
    },
    onJoinBoxWaitlist: boxAccess.join,
    async onStartDevice(deviceId) {
      const currentAccount = account();
      if (currentAccount === null) return false;
      try {
        await startDeviceBox(currentAccount.session.accessToken, deviceId);
        // The device returns to online through the events stream once its
        // daemon reconnects, so there is nothing to update optimistically.
        return true;
      } catch (error) {
        logger.warn('device_start_failed', { deviceId, error: String(error) });
        return false;
      }
    },
    async onApproveDaemonLink(code, password) {
      const currentAccount = account();
      if (currentAccount === null) return 'failed';
      try {
        await approvePermanentDaemonLink(currentAccount, code, password);
        void deviceList.refreshLink(currentAccount.session.accessToken).catch(() => undefined);
        // As above: the `added` delta and the daemon's own online edge arrive
        // over the stream.
        return 'approved';
      } catch (error) {
        if (isApiError(error) && error.code === 'machine_limit_reached') {
          return 'machine_limit_reached';
        }
        logger.warn('daemon_link_approval_failed', { error: String(error) });
        return 'failed';
      }
    },
    async onPreviewDaemonLink(code) {
      const currentAccount = account();
      if (currentAccount === null) return null;
      try {
        return await previewDaemonLink(currentAccount, code);
      } catch (error) {
        logger.warn('daemon_link_preview_failed', { error: String(error) });
        return null;
      }
    },
    onBrowserSessionsRefresh: browserSessions.load,
    onBrowserSessionRevoke: browserSessions.revoke,
    onBrowserSessionsRevokeOthers: browserSessions.revokeOthers,
    onGoToDevices() {
      nav.pop();
    },
    onOpenCommandPalette() {
      nav.pushOverlay({ k: 'command-palette' });
    },
    onOpenCreateBox() {
      // An operator may have approved the account since sign-in, so the dialog
      // asks again rather than trusting the answer from then.
      const token = accessToken();
      if (token !== null) void boxAccess.load(token).catch(() => undefined);
      nav.pushOverlay({ k: 'create-box' });
    },
    onOpenKeyboardHelp() {
      nav.pushOverlay({ k: 'keyboard-help' });
    },
    onOpenDeviceAction(action, device) {
      nav.pushOverlay({ k: 'device-action', action, deviceId: device.id });
    },
    onOpenLinkApproval() {
      nav.pushOverlay({ k: 'link-approval', code: null });
    },
    onOpenSettings(tab) {
      nav.push({ k: 'settings', tab });
      loadSettingsTab(tab);
    },
    onSettingsBack() {
      nav.pop();
    },
    onSettingsTabChange(tab) {
      // Replace, not push: the four tabs are one screen, and a stack that grew
      // per tab would make the way out depend on how much of Settings was read.
      nav.replace({ k: 'settings', tab });
      loadSettingsTab(tab);
    },
    onOverlayDismiss() {
      nav.popOverlay();
    },
    onToggleTerminalFocusMode() {
      setTerminalFocusMode((current) => !current);
    },
    onRefreshLink,
    resolveLink(id) {
      return linkDefinitions.uri(id);
    },
    onRegisterTerminalPanel(handle) {
      terminalPanelHandle = handle;
      if (handle === null) {
        latestTerminalSize = null;
      }
    },
    onTerminalResize(size) {
      // TerminalPanel has already observed two identical animation-frame
      // measurements. Forward that proven-stable size immediately; a second
      // controller-side stabilizer added two more frames of local/remote PTY
      // mismatch to every resize.
      latestTerminalSize = size;
      session()?.sendResize(size.cols, size.rows, size.cellWidth, size.cellHeight);
    },
    onTerminalFontSizeChange(fontSize) {
      const current = terminalAppearance();
      const next = terminalAppearanceWithFontSize(current, fontSize);
      // A drag emits an event per pixel of travel but only crosses a whole
      // font size every few of them; the rest would be a storage write and an
      // atlas rebuild for a value that did not move.
      if (next.fontSize === current.fontSize) return;
      setTerminalAppearance(next);
      saveTerminalAppearance(next);
      workerClient?.updateFont(next.fontSize, TERMINAL_LINE_HEIGHT);
    },
    async onTerminalNotificationsEnable() {
      const token = accessToken();
      if (token === null) return;
      setTerminalNotificationState(await enableTerminalNotifications(token));
    },
    async onTerminalNotificationsDisable() {
      const token = accessToken();
      if (token === null) return;
      setTerminalNotificationState(await disableTerminalNotifications(token));
    },
    onTelemetryEnabledChange(enabled) {
      if (enabled === telemetryEnabled()) return;
      setTelemetryEnabled(enabled);
      saveTelemetryEnabled(enabled);

      // The link report starts and stops with the switch. Deep profiling
      // cannot: both workers latch `perfEnabled` at init, so it follows from
      // the next terminal session. The preferences copy says so.
      if (!enabled) {
        // `discard`, not `stop` — the partial window accumulated before consent
        // was withdrawn is dropped rather than posted.
        telemetryReporter?.discard();
        telemetryReporter = null;
        telemetryWorker?.stop();
        telemetryWorker = null;
        mainThreadFrameMonitor?.stop();
        mainThreadFrameMonitor = null;
        setTelemetryStats(null);
        stopErrorReporting();
        return;
      }
      startErrorReporting();
      const rings = terminalRings();
      if (session() !== null && rings !== null) {
        telemetryReporter ??= createLinkTelemetryReporter();
        telemetryWorker ??= createProfilingWorker(rings);
      }
    },
    onTerminalFontFamilyChange(fontFamilyId) {
      if (!(fontFamilyId in TERMINAL_FONTS)) return;

      const next = { ...terminalAppearance(), fontFamilyId };
      setTerminalAppearance(next);
      saveTerminalAppearance(next);
      workerClient?.updateFontFamily(TERMINAL_FONTS[fontFamilyId]);
    },
    onTerminalRetry,
    onTerminalThemeChange(themeId) {
      if (!(themeId in TERMINAL_THEMES)) return;

      const next = { ...terminalAppearance(), themeId };
      setTerminalAppearance(next);
      saveTerminalAppearance(next);
      workerClient?.updateTheme(TERMINAL_THEMES[themeId]);
    },
    onWorkerClose() {
      // A replacement terminal worker starts with no authenticated display
      // epoch even while the transport remains connected. Retain a level-
      // triggered handoff for the next ready worker.
      if (session() !== null) {
        displayFrameAppliedForSession = false;
      }
      terminalSessionEpochHandoff.onWorkerClosed();
      predictionRttForwarder.setSink(null);
      workerClient = null;
      setTerminalDiagnostics(null);
    },
    onWorkerDiagnostics(diagnostics) {
      setTerminalDiagnostics(diagnostics);
    },
    onDisplayFrameReceived() {
      if (statusModel.stage === 'first-frame') {
        updateStatus({ detail: 'Display frame received' });
      }
    },
    onDisplayFrameApplied() {
      // CPU-side grid mutation is diagnostic only. The terminal is not usable
      // until the worker observes completion of the submitted GPU frame.
      const trace = startupTrace;
      if (trace !== null && trace.session === session()) {
        recordStartupMilestone(trace, 'first_display_applied');
      }
    },
    onFirstDisplayGpuComplete() {
      displayFrameAppliedForSession = true;
      // The repair is on screen, so a pending reveal has been overtaken.
      clearFirstFrameOverlayTimer();
      finishFirstDisplayPresentation();
    },
    onWorkerFatal(message) {
      // WebCrypto PBKDF2 cannot be interrupted, so revoke the startup
      // generation before publishing the worker failure. A late derivation
      // continuation must not create or start a transport after this point.
      connectionAttempts.invalidate(new Error(message));
      startupTrace = null;
      logger.error('terminal_worker_fatal', { message });
      updateStatus({ stage: 'failed', detail: 'Terminal worker failed' });
      nav.setConnection('disconnected');
      session()?.close();
    },
    onWorkerReady(client) {
      workerClient = client;
      if (startupTrace !== null) recordStartupMilestone(startupTrace, 'worker_ready');
      terminalSessionEpochHandoff.onWorkerReady(client);
      predictionRttForwarder.setSink(client);
      logger.info('terminal_worker_ready');
      const appearance = terminalAppearance();
      client.updateFontFamily(TERMINAL_FONTS[appearance.fontFamilyId]);
      client.updateFont(appearance.fontSize, TERMINAL_LINE_HEIGHT);
      client.updateTheme(TERMINAL_THEMES[appearance.themeId]);
    },
  };

  function finishFirstDisplayPresentation(): void {
    if (!displayFrameAppliedForSession || statusModel.stage !== 'first-frame') return;
    // Authentication and the authoritative GPU fence must both precede usable
    // input. A fast transport can finish under the device list: in that case
    // presentation joins this branch at the next visual frame.
    const trace = startupTrace;
    if (trace !== null && trace.session === session()) {
      if (!trace.milestones.has('terminal_view_presented')) return;
      recordStartupMilestone(trace, 'first_display_visible');
      startupTrace = null;
    }
    markTerminalUsable();
  }

  function onSessionRejected(): void {
    const activeAccount = account();
    if (activeAccount === null || activeAccount === rejectedAccount) return;
    rejectedAccount = activeAccount;
    rejectAccountSession();
    nav.pushOverlay({ k: 'session-ended' });
  }

  /**
   * The list on the Sessions tab is fetched on arrival, so only a tab that is
   * showing it has anything to refresh; the next arrival fetches for itself.
   */
  function onBrowserSessionsChanged(): void {
    const route = nav.route();
    if (route.k !== 'settings' || route.tab !== 'sessions') return;
    void browserSessions.load().catch(() => undefined);
  }

  async function refreshCurrentAccount(): Promise<Awaited<ReturnType<typeof refreshAccessToken>>> {
    const activeAccount = account();
    return refreshAccessToken().catch((error: unknown) => {
      // Session issuance can observe revocation before the live event stream.
      // Only the account that owned this request may be cleared by its answer.
      if (account() === activeAccount && isApiError(error) && error.status === 401) {
        onSessionRejected();
      }
      // The caller must receive this outcome, rather than its stale access
      // token's earlier 401, when refresh failed on network or server capacity.
      throw error;
    });
  }

  /**
   * Everything the shell was showing, dropped. Reached only through
   * `createAuth`, which calls it once the shell has left the screen: run on
   * the press instead, it empties the rows and blanks the link command while
   * the shell is still up, and the sign-out transition's old snapshot carries
   * that skeleton instead of the screen the user was looking at.
   */
  function clearSignedInState(): void {
    sessionStorage.removeItem(LAST_DEVICE_ID_KEY);
    browserSessions.reset();
    boxAccess.reset();
    setSelectedDevice(null);
    stopDeviceList();
    deviceList.clearDevices();
    teardown();
  }

  async function loadDevices(
    token: string,
    userId: string,
    opts: { refreshLink?: boolean } = {},
  ): Promise<void> {
    const lifetime = ++deviceListLifetime;
    const started = deviceList.start(token, userId, opts);
    if (!connectionAttempts.hasActive()) {
      // Paint the shell immediately. Cached rows remain in place while they
      // refresh; a first-time account gets an honest skeleton until the live
      // snapshot confirms its empty state.
      nav.enterShell();
    }
    // A machine's approval link, opened before or across sign-in: the shell
    // now exists to hold the dialog, and the code is consumed exactly once.
    if (pendingDaemonLinkCode !== null) {
      nav.pushOverlay({ k: 'link-approval', code: pendingDaemonLinkCode });
      pendingDaemonLinkCode = null;
    }
    try {
      await started;
      if (lifetime !== deviceListLifetime || connectionAttempts.hasActive()) return;
      nav.enterShell();
      reconnectLastDevice(opts);
    } catch (error) {
      // Selecting a cached device leaves the event stream running. The list's
      // stale completion must not unmount the terminal or replace the explicit
      // connection attempt with an auto-reconnect.
      if (lifetime !== deviceListLifetime || connectionAttempts.hasActive()) return;
      nav.enterShell();
      throw error;
    }
  }

  async function onRefreshLink(): Promise<void> {
    const token = accessToken();
    if (!token) {
      return;
    }

    await deviceList.refreshLink(token).catch(() => undefined);
  }

  async function onBack(): Promise<void> {
    sessionStorage.removeItem(LAST_DEVICE_ID_KEY);
    teardown();
    // Reveal the still-mounted list immediately. Live data and a fresh link
    // command can update in place without leaving a blank frame behind.
    nav.enterShell();
    const currentAccount = account();
    if (currentAccount !== null) {
      const token = accessToken();
      if (token !== null) await loadDevices(token, currentAccount.session.userId);
    }
  }

  async function onTerminalRetry(): Promise<void> {
    const device = selectedDevice();
    if (device === null) return;
    teardown();
    await onDeviceSelected(device);
  }

  async function onDeviceSelected(device: Device): Promise<void> {
    // Degraded is selectable: the daemon's lease is still held, so the device is
    // real and reachable again shortly. A start attempted before the carrier
    // reattaches is refused with a 503 rather than parked, so this is a bet on a
    // short reattach, not a queued command.
    if (device.status === 'offline' || connectionAttempts.isActiveFor(device.id)) {
      return;
    }

    const token = accessToken();
    if (token === null) {
      return;
    }

    const selectedAtMs = terminalPerfNowMs();
    // Claim the interaction before the first await. Teardown synchronously
    // revokes any older generation (including a different-device selection),
    // and the new generation owns every continuation below.
    // Keep the authenticated event connection across terminal navigation: it
    // carries browser presence too. Only the machine-list UI work is paused.
    deviceListLifetime += 1;
    deviceList.pauseLinkRefresh();
    teardown();
    const attempt = connectionAttempts.begin(device.id, selectedAtMs);
    if (attempt === null) return;
    setSelectedDevice(device);
    // Let the selected row acknowledge the interaction for one visual frame
    // before the terminal layer covers it. The route stays on the device list
    // until the terminal is actually presented below.
    nav.setConnection('connecting');
    const trace: StartupTrace = {
      attemptId: attempt.generation,
      deviceId: device.id,
      startedAtMs: attempt.startedAtMs,
      milestones: new Set(),
      // Per attempt, not per session: one id for the life of a tab would fuse every request
      // it ever makes into a single trace.
      traceContext: mintTraceContext(),
      session: null,
    };
    startupTrace = trace;

    // Mount the terminal underneath the still-active list. Its worker can fetch
    // the regular font, instantiate WASM, and initialize the renderer while the
    // selected row acknowledges the click.
    // The one place the wake policy is resolved: both workers receive this
    // verdict in `init`, and neither sniffs a user agent of its own.
    const rings = createTerminalRingBundle(
      terminalRuntimePolicyForUserAgent(navigator.userAgent).displayRingWakeMode,
    );
    // Before any worker starts, so the first startup milestone of this attempt
    // already has somewhere to go.
    installMainPerfProducer(rings.mainPerfRing, rings.perfStrings);
    if (telemetryEnabled()) {
      const writer = mainPerfWriter();
      if (writer !== null) {
        mainThreadFrameMonitor = createMainThreadFrameMonitor(browserMainThreadFrameMonitorHost(), {
          noteFrameGap(atMs, gapMs, longTaskObserverSupported): void {
            emitMainFrameCadence(writer, atMs, gapMs, longTaskObserverSupported);
          },
          noteLongTask(atMs, durationMs): void {
            emitMainLongTask(writer, atMs, durationMs);
          },
        });
        mainThreadFrameMonitor.start();
      }
    }
    // Emitted only now, though it is timestamped from the click. This ring is
    // where the attempt's records go, and `recordStartupMilestone` marks a
    // milestone used whether or not a writer existed to take it — so emitting
    // before installation dropped `device_selected` for good and left every
    // startup trace incomplete, which is the whole causal path these traces
    // exist to prove.
    recordStartupMilestone(trace, 'device_selected', selectedAtMs);
    setTerminalRings(rings);
    displayFrameAppliedForSession = false;
    transportAutotuner = createTransportAutotuner(
      `${device.id}:${navigator.hardwareConcurrency || 1}:${Math.round((window.devicePixelRatio || 1) * 100)}`,
    );
    // Opt-in. Disabled means neither is constructed at all: no interval, no
    // `visibilitychange` listener, no accumulator fold, and no worker draining
    // rings that nothing is writing to.
    // Dispose the previous session's pair before replacing them. Leaving the
    // terminal for the device list does not tear the app down, so arriving here
    // a second time can find both still live; a bare reassignment then orphans
    // an interval, a `visibilitychange` listener, and a worker that goes on
    // draining rings nothing writes to and posting every couple of seconds for
    // the rest of the page's life — pinning that session's SharedArrayBuffers
    // with it. `stop` rather than `discard`: consent has not been withdrawn, so
    // the window the old session accumulated is real data and is posted.
    telemetryReporter?.stop();
    telemetryWorker?.stop();
    telemetryReporter = telemetryEnabled() ? createLinkTelemetryReporter() : null;
    telemetryWorker = telemetryEnabled() ? createProfilingWorker(rings) : null;
    statusModel = {
      deviceName: device.name,
      stage: 'signaling',
      transportLabel: '',
      rttMs: null,
      signalingReconnecting: false,
      detail: 'Signaling',
    };
    recordStartupMilestone(trace, 'terminal_mount_requested');
    // `onWorkerReady` fires once per worker, and navigating back to the device
    // list does not close it, so a warm attempt would otherwise leave this
    // milestone unrecorded and its trace permanently incomplete. An already
    // ready worker is ready as of the mount, which is the honest elapsed value
    // for that attempt — the cold-boot cost belongs to the attempt that paid it.
    if (workerClient !== null) recordStartupMilestone(trace, 'worker_ready');

    nav.setConnection('signaling');
    renderStatus();

    sessionStorage.setItem(LAST_DEVICE_ID_KEY, device.id);

    let next: TerminalSession;
    // Link ids belong to one daemon session; the new one sends its own table.
    linkDefinitions.clear();
    handledOpenUrlRequests.length = 0;
    try {
      next = createTransportSession(
        {
          onDisplayLinkTable(reset, links) {
            if (session() !== next) return;
            linkDefinitions.apply(reset, links);
          },
          onTerminalUi(effect) {
            if (session() !== next) return;
            switch (effect.kind) {
              case 'title':
                setRemoteTitle(effect.title);
                break;
              case 'clipboard':
                // Web clipboard APIs have no primary selection. Only the focused
                // active session can copy; a terminal can never query it.
                if (effect.selection === 'c' && document.hasFocus() && navigator.clipboard) {
                  void navigator.clipboard.writeText(effect.text).catch(() => undefined);
                }
                break;
              case 'notification':
                if (terminalNotificationState() === 'enabled') {
                  void navigator.serviceWorker
                    .getRegistration()
                    .then((registration) => {
                      if (session() !== next || terminalNotificationState() !== 'enabled') return;
                      return registration?.showNotification(effect.title || selectedDeviceName(), {
                        body: effect.body,
                        data: { url: window.location.href },
                      });
                    })
                    .catch(() => undefined);
                }
                break;
              // Background BEL notifications already travel through the existing
              // daemon/coordinator push path, including when the page is suspended.
              case 'bell':
                break;
            }
          },
          onOpenUrl(epoch, seq, url) {
            if (session() !== next) return;
            // The daemon delivers a request again after a new Noise session if
            // this browser's acknowledgement may not have reached it.
            const requestId = `${epoch}:${seq}`;
            if (handledOpenUrlRequests.includes(requestId)) return;
            handledOpenUrlRequests.push(requestId);
            if (handledOpenUrlRequests.length > OPEN_URL_REQUEST_IDS_KEPT) {
              handledOpenUrlRequests.shift();
            }
            const openable = openableUrl(url);
            if (openable === null) return;
            // A key press or click in this page moments ago (the browser's
            // transient activation, 5 s in Chromium, Firefox and WebKit) is its
            // own evidence that the user is here and acting, and almost always
            // what the program answered (`gh`'s "Press Enter to open"). The
            // popup blocker admits exactly that, so the tab opens as it would
            // from a native terminal. Without it the request waits behind a click.
            const opened = navigator.userActivation.isActive;
            // No URL: which page a program opened is the user's business.
            logger.info('open_url_request', { opened });
            if (opened) {
              window.open(openable, '_blank', 'noopener,noreferrer');
              return;
            }
            setOpenUrlRequests((requests) =>
              requests.includes(openable) ? requests : [...requests, openable],
            );
          },
          onConnected(preserveDisplay, displayRingFenceToken) {
            if (session() !== next) {
              return;
            }
            if (startupTrace === trace) {
              recordStartupMilestone(trace, 'transport_connected');
            }

            // Resize is published first, then the terminal worker's
            // session-epoch fence resets its prediction state. Whether the
            // grid is repaired or replaced is the Rust viewer's resume claim to
            // decide, answered by the daemon; `preserveDisplay` only says which
            // of the two the overlay below should expect.
            const newLineage = terminalSessionEpochHandoff.onTransportConnected(
              next,
              displayRingFenceToken,
            );
            // A carrier rebind returns to ready on the lineage already fenced:
            // the worker keeps that grid and reports no second first display
            // for it, so what the terminal showed, or is about to show, stands.
            if (!newLineage) return;
            displayFrameAppliedForSession = false;
            // Keep the terminal panel mounted in SIGNALING while the worker
            // waits for its authoritative resume repair or snapshot. CONNECTED
            // means both transport-authenticated and display-ready.
            //
            // When the display is being PRESERVED the pre-outage screen is
            // still on the canvas and the daemon is sending row repairs for it,
            // so covering it is the interruption the grace exists to avoid. Let
            // the repair land underneath instead, and reveal the card only if
            // it does not arrive inside the grace. A snapshot resume keeps the
            // old behaviour: there, the screen really is about to be replaced
            // wholesale and saying so immediately is honest.
            clearFirstFrameOverlayTimer();
            if (preserveDisplay) {
              updateStatus({ signalingReconnecting: false });
              firstFrameOverlayTimer = setTimeout(() => {
                firstFrameOverlayTimer = null;
                if (session() !== next) return;
                if (displayFrameAppliedForSession) return;
                updateStatus({ stage: 'first-frame', detail: 'Display requested' });
              }, RECONNECT_OVERLAY_GRACE_MS);
            } else {
              updateStatus({
                stage: 'first-frame',
                signalingReconnecting: false,
                detail: 'Display requested',
              });
            }
          },
          onWorkerFailure() {
            if (session() !== next) return;
            teardown();
            void onDeviceSelected(device);
          },
          onDisconnected(reason: string) {
            if (session() !== next) {
              return;
            }

            logger.warn('terminal_session_disconnected', { reason });
            // Buffered-but-never-admitted input follows the same rule as the
            // worker's outbox. If the two disagreed, this buffer would replay
            // exactly the keystrokes the outbox was reset to discard —
            // delivering input typed under a dead identity, or re-overflowing
            // the queue that just failed.
            if (!shouldPreserveInputOnDisconnect(reason)) {
              terminalPanelHandle?.discardPendingInput();
            }
            if (reason === 'closed') {
              nav.setConnection('disconnected');
              updateStatus({ stage: 'disconnected', detail: 'Closed' });
              return;
            }

            startupTrace = null;
            nav.setConnection('disconnected');
            updateStatus({ stage: 'disconnected', detail: classifyDisconnectReason(reason) });
          },
          onMetrics(
            rttMs: number | null,
            pathType: 'direct' | 'relay' | 'unknown',
            _availableOutgoingBitrateMbps: number | null,
            networkRttMs: number | null,
            linkSample: LinkQualitySample,
          ) {
            if (session() !== next) {
              return;
            }

            // Folded in here rather than in the transport worker: this callback
            // already runs on the main thread at the same ~2s cadence and
            // already does strictly more work (autotuner, smoothed RTT, Solid
            // signal updates), while the worker thread drains inbound ctrl/pty
            // and seals datagrams.
            telemetryReporter?.observeLink(linkSample);

            const tuner = transportAutotuner;
            if (tuner !== null && rttMs !== null) {
              next.sendTransportHint(tuner.observeAndMaybeSample(rttMs, pathType));
            }
            const label = transportPathLabel(pathType);
            const pathChanged = label !== statusModel.transportLabel;
            predictionRttForwarder.observe(rttMs, pathChanged);

            const displayRttMs = networkRttMs ?? rttMs;
            if (displayRttMs === null) {
              // Labeled path has no sample yet (e.g. WT just registered, or
              // iOS where WT pongs don't round-trip). Keep the label honest,
              // drop the stale number rather than display the other path's
              // RTT under this path's label.
              updateStatus({ transportLabel: label, rttMs: null });
              return;
            }

            const currentRtt = pathChanged ? null : statusModel.rttMs;
            const smoothedRtt =
              currentRtt === null
                ? displayRttMs
                : Math.round(currentRtt * 0.5 + displayRttMs * 0.5);
            updateStatus({ transportLabel: label, rttMs: smoothedRtt });
          },
          onUpgradeOutcome(report) {
            if (session() !== next) {
              return;
            }

            // The same opt-in gate as the link window. Read live rather than
            // captured at session start, so switching reporting off stops this
            // surface mid-session too.
            if (!telemetryEnabled()) return;

            const token = accessToken();
            // No token means no authenticated session to attribute the attempt
            // to. Dropping it is correct: telemetry never triggers a refresh.
            if (token === null) return;
            void reportBrowserUpgrade(token, report).catch(() => {
              // Same contract as the link window: a dropped report is a
              // non-event, and a rejected promise escaping here is not.
            });
          },
          onSignalingStatus(status) {
            if (session() !== next) {
              return;
            }

            // Delay only the transition INTO the reconnecting state. A carrier
            // rebind restores the session faster than the grace period, so
            // surfacing an overlay immediately would turn a gap the user would
            // not have noticed into a visible interruption. Clearing it stays
            // immediate — there is no reason to keep covering a terminal that
            // is already back.
            if (reconnectOverlayTimer !== null) {
              clearTimeout(reconnectOverlayTimer);
              reconnectOverlayTimer = null;
            }
            if (status !== 'reconnecting') {
              updateStatus({ signalingReconnecting: false });
              return;
            }
            reconnectOverlayTimer = setTimeout(() => {
              reconnectOverlayTimer = null;
              if (session() !== next) return;
              updateStatus({ signalingReconnecting: true });
            }, RECONNECT_OVERLAY_GRACE_MS);
          },
          onDormant(isDormant: boolean) {
            if (session() !== next) {
              return;
            }

            if (isDormant) {
              // No detail: the stage label already reads "Reconnecting", and a
              // detail that repeats it produced "Reconnecting · Signaling
              // reconnecting · Reconnecting..." on one line. A detail here has
              // to add a fact the stage does not carry — an attempt count does,
              // a synonym does not.
              updateStatus({ stage: 'reconnecting', detail: '' });
            } else {
              updateStatus({
                stage: displayFrameAppliedForSession ? 'connected' : 'first-frame',
                detail: displayFrameAppliedForSession ? '' : 'Display requested',
              });
            }
          },
          onRecoverDisplayReader() {
            if (session() !== next) return;
            workerClient?.notifyDisplayAvailable();
          },
          onInputReady() {
            if (session() !== next) return;
            terminalPanelHandle?.drainPendingInput();
          },
        },
        rings,
        {
          getBrowserAuthorization: () => {
            const activeAccount = account();
            if (activeAccount === null) {
              throw new Error('Browser delegation is unavailable');
            }
            return {
              userId: activeAccount.session.userId,
              delegationId: activeAccount.session.delegationId,
            };
          },
          renewSession: renewSessionWithRefresh,
          requestSession: (
            daemonId,
            browserNodeId,
            issuanceId,
            supersedesIssuanceId,
            clientNonce,
            encapsulationKey,
            signal,
          ) =>
            requestSessionWithRefresh(
              daemonId,
              browserNodeId,
              issuanceId,
              supersedesIssuanceId,
              clientNonce,
              encapsulationKey,
              signal,
            ),
          cancelSessionRequest: async (issuanceId) => {
            await cancelSessionRequestWithRefresh(issuanceId);
          },
        },
        { onWorkerError: (error) => errorReporter?.record('transport_worker', error) },
      );
    } catch (error) {
      if (!attempt.isCurrent()) return;
      logger.error('terminal_session_create_failed', {
        error: String(error),
        deviceId: device.id,
      });
      // The one failure that makes a session not exist. Every other browser signal measures
      // a working session and is silent here by construction, which is why this was
      // invisible in the field.
      errorReporter?.record('session_start', error);
      teardown();
      nav.setConnection('disconnected');
      return;
    }
    if (!attempt.isCurrent()) {
      next.close();
      return;
    }
    trace.session = next;
    // The focused window owns the shared geometry, so this session needs the
    // fact now rather than at the first focus change: without it a window that
    // is already focused would wait for a blur to learn it is the one in use.
    next.setWindowFocused(document.hasFocus());
    setSession(next);

    try {
      // The transport and terminal workers are independent startup branches.
      // The epoch handoff below is level-triggered, so transport may connect
      // before the renderer is ready without losing the authoritative snapshot.
      updateStatus({ stage: 'connecting', detail: 'Connecting' });
      recordStartupMilestone(trace, 'transport_start');
      const presented = nextVisualFrame().then(() => {
        if (!attempt.isCurrent() || session() !== next) return;
        nav.push({ k: 'terminal', deviceId: device.id });
        renderStatus();
        recordStartupMilestone(trace, 'terminal_view_presented');
        finishFirstDisplayPresentation();
      });
      try {
        await next.start(device.id);
      } finally {
        // An immediate failure still needs a presented view for its status.
        // Keep this attempt current through reveal on success and failure alike.
        await presented;
      }
      if (!attempt.isCurrent() || session() !== next) return;
      logger.info('session_connected', { deviceId: device.id });
    } catch (err) {
      if (!attempt.isCurrent() || session() !== next) return;
      logger.error('terminal_session_start_failed', {
        error: String(err),
        deviceId: device.id,
      });
      const failure = decideTerminalStartFailure(statusModel.stage, startupTrace === trace);
      if (failure.publishFailure) {
        if (!failure.retainStartupTrace) startupTrace = null;
        nav.setConnection('disconnected');
        updateStatus({ stage: 'failed', detail: 'Start failed' });
      }
    } finally {
      connectionAttempts.complete(attempt);
    }
  }

  async function onDeviceRename(device: Device, name: string): Promise<boolean> {
    const token = accessToken();
    if (token === null) {
      return false;
    }

    const nextName = name.trim();
    if (nextName.length === 0) {
      return false;
    }
    if (nextName === device.name) return true;

    try {
      await deviceList.renameDevice(token, device.id, nextName);
      if (selectedDevice()?.id === device.id) {
        setSelectedDevice({ ...device, name: nextName });
      }
      return true;
    } catch {
      return false;
    }
  }

  async function onDeviceRemove(device: Device): Promise<boolean> {
    const token = accessToken();
    if (token === null) {
      return false;
    }

    try {
      await deviceList.removeDevice(token, device.id);
      if (sessionStorage.getItem(LAST_DEVICE_ID_KEY) === device.id) {
        sessionStorage.removeItem(LAST_DEVICE_ID_KEY);
      }
      if (selectedDevice()?.id === device.id) setSelectedDevice(null);
      return true;
    } catch {
      return false;
    }
  }

  function reconnectLastDevice(opts: { refreshLink?: boolean }): void {
    if (opts.refreshLink === false || session() !== null || connectionAttempts.hasActive()) {
      return;
    }

    const lastDeviceId = sessionStorage.getItem(LAST_DEVICE_ID_KEY);
    if (lastDeviceId === null) {
      return;
    }

    const lastDevice = deviceList.devices().find((device) => device.id === lastDeviceId);
    if (lastDevice === undefined || lastDevice.status !== 'online') {
      return;
    }

    queueMicrotask(() => {
      if (session() !== null || connectionAttempts.hasActive()) return;
      void onDeviceSelected(lastDevice);
    });
  }

  function stopDeviceList(): void {
    deviceListLifetime = deviceListLifetime >= Number.MAX_SAFE_INTEGER ? 1 : deviceListLifetime + 1;
    deviceList.stop();
  }

  function clearFirstFrameOverlayTimer(): void {
    if (firstFrameOverlayTimer === null) return;
    clearTimeout(firstFrameOverlayTimer);
    firstFrameOverlayTimer = null;
  }

  function teardown(): void {
    connectionAttempts.invalidate(new Error('Terminal teardown'));
    // A pending overlay reveal outliving its session would surface a
    // reconnecting state for a terminal that is already gone.
    if (reconnectOverlayTimer !== null) {
      clearTimeout(reconnectOverlayTimer);
      reconnectOverlayTimer = null;
    }
    clearFirstFrameOverlayTimer();
    mainThreadFrameMonitor?.stop();
    mainThreadFrameMonitor = null;
    // Flushes the partial window before releasing its timer and listener.
    telemetryReporter?.stop();
    telemetryReporter = null;
    telemetryWorker?.stop();
    telemetryWorker = null;
    setTelemetryStats(null);
    clearMainPerfProducer();
    startupTrace = null;
    session()?.close();
    setSession(null);
    setRemoteTitle('');
    predictionRttForwarder.setSink(null);
    predictionRttForwarder.clear();
    workerClient?.close();
    workerClient = null;
    setTerminalRings(null);
    latestTerminalSize = null;
    transportAutotuner = null;
    terminalSessionEpochHandoff.reset();
    displayFrameAppliedForSession = false;
    statusModel = { ...statusModel, stage: 'idle', detail: '' };
    setTerminalStage('idle');
    setTerminalStatus('');
    setTerminalStatusMode('hidden');
  }

  function updateStatus(next: Partial<TerminalStatusModel>): void {
    statusModel = { ...statusModel, ...next };
    renderStatus();
  }

  function recordStartupMilestone(
    trace: StartupTrace,
    milestone: TerminalStartupMilestone,
    atMs = terminalPerfNowMs(),
  ): void {
    if (startupTrace !== trace || trace.milestones.has(milestone)) return;
    trace.milestones.add(milestone);
    const writer = mainPerfWriter();
    const interner = mainPerfInterner();
    if (writer !== null && interner !== null) {
      emitStartupMilestone(
        writer,
        atMs,
        trace.attemptId,
        interner.intern(trace.deviceId),
        milestone,
        Math.max(0, atMs - trace.startedAtMs),
        trace.traceContext.traceId,
        trace.traceContext.spanId,
      );
    }
  }

  function markTerminalUsable(): void {
    // The worker's GPU fence has already proven the first display frame is on
    // screen, so the terminal itself is the readiness signal. `connected`
    // resolves to a hidden overlay: reaching this function is the only
    // condition, with no confirmation card and no timer deciding when to
    // dismiss one.
    nav.setConnection('connected');
    updateStatus({
      stage: 'connected',
      signalingReconnecting: false,
      detail: '',
    });
    terminalPanelHandle?.focus();
  }

  function renderStatus(): void {
    setTerminalStage(statusModel.stage);
    const stageLabel = terminalStageLabel(statusModel.stage);
    const parts = [statusModel.deviceName || 'Terminal', terminalPrimaryLabel(stageLabel)];
    if (statusModel.signalingReconnecting) parts.push('Signaling reconnecting');
    if (shouldShowStatusDetail(stageLabel)) parts.push(statusModel.detail);
    setTerminalStatus(parts.filter((part) => part.length > 0).join(' · '));
    setTerminalStatusMode(
      terminalStatusModeForStage(statusModel.stage, statusModel.signalingReconnecting),
    );
  }

  function terminalPrimaryLabel(stageLabel: string): string {
    // Connected needs no chip — the LinkStatus latency (green ms) conveys it.
    // Path + latency also live there now; the bullet keeps device name + stage.
    if (statusModel.stage === 'connected') return '';
    if (statusModel.stage === 'reconnecting' && /^\d+\/\d+$/.test(statusModel.detail)) {
      return `${stageLabel} ${statusModel.detail}`;
    }

    return stageLabel;
  }

  function shouldShowStatusDetail(stageLabel: string): boolean {
    if (statusModel.detail.length === 0) return false;
    if (statusModel.detail === stageLabel) return false;
    if (statusModel.stage === 'connected') return false;
    if (statusModel.stage === 'reconnecting' && /^\d+\/\d+$/.test(statusModel.detail)) {
      return false;
    }
    return true;
  }

  function terminalStageLabel(stage: TerminalStage): string {
    switch (stage) {
      case 'signaling':
        return 'Signaling';
      case 'connecting':
        return 'Connecting';
      case 'authenticating':
        return 'Terminal starting';
      case 'first-frame':
        return 'Connecting display';
      case 'connected':
        return 'Connected';
      case 'reconnecting':
        return 'Reconnecting';
      case 'disconnected':
        return 'Disconnected';
      case 'failed':
        return 'Failed';
      default:
        return 'Idle';
    }
  }

  function transportPathLabel(pathType: 'direct' | 'relay' | 'unknown'): string {
    if (pathType === 'direct') return 'Direct';
    if (pathType === 'relay') return 'Relay';
    return '';
  }

  function classifyDisconnectReason(reason: string): string {
    if (reason === 'auth-failed') return 'Authentication failed';
    if (reason === 'edge-unreachable') return 'Connection lost';
    if (reason.includes('protocol')) return 'Protocol error';
    if (reason.includes('queue')) return 'Backpressure disconnect';
    if (reason === 'failed') return 'Connection failed';
    if (reason === 'edge-failed') return 'Connection unavailable';
    if (reason === 'disconnected') return 'Connection lost';
    return reason;
  }

  function sendCurrentTerminalResize(targetSession: TerminalSession): void {
    const measuredSize = terminalPanelHandle?.syncSize() ?? null;
    const size = measuredSize ?? latestTerminalSize;
    if (size === null) return;
    latestTerminalSize = size;
    targetSession.sendResize(size.cols, size.rows, size.cellWidth, size.cellHeight);
  }

  // The transport worker requests a session by RPC; main answers using the
  // access token it holds (never handed to the worker). The token is read at
  // call time so a reconnect's refreshed token is picked up; on an expired-token
  // failure refresh once and retry. The reply carries the edge coords the worker
  // dials (no separate relay-config fetch).
  /**
   * The connect attempt's trace context, or `undefined` before one exists.
   *
   * Sending it on the session request is what makes the server's `session_request` span a
   * child of the browser's bootstrap root rather than the root of an unrelated trace.
   */
  function attemptTraceparent(): string | undefined {
    return startupTrace === null ? undefined : formatTraceparent(startupTrace.traceContext);
  }

  async function requestSessionWithRefresh(
    daemonId: string,
    browserNodeId: string,
    issuanceId: string,
    supersedesIssuanceId: string | undefined,
    clientNonce: string,
    encapsulationKey: string,
    signal: AbortSignal,
  ): Promise<RequestSessionResult> {
    return withSessionAuthorization(signal, async (token, delegationId) =>
      toRequestSessionResult(
        await requestSession(
          token,
          delegationId,
          daemonId,
          browserNodeId,
          issuanceId,
          supersedesIssuanceId,
          clientNonce,
          encapsulationKey,
          signal,
          attemptTraceparent(),
        ),
      ),
    );
  }

  function renewSessionWithRefresh(
    renewal: RenewSessionRequest,
    signal: AbortSignal,
  ): Promise<RenewSessionResult> {
    return withSessionAuthorization(signal, (token, delegationId) =>
      renewSession(token, delegationId, renewal, signal),
    );
  }

  async function withSessionAuthorization<T>(
    signal: AbortSignal,
    operation: (token: string, delegationId: string) => Promise<T>,
  ): Promise<T> {
    signal.throwIfAborted();
    const token = accessToken();
    const activeAccount = account();
    if (token === null || activeAccount === null) {
      throw new Error('No browser delegation for session request');
    }
    try {
      return await operation(token, activeAccount.session.delegationId);
    } catch (error) {
      signal.throwIfAborted();
      if (!shouldRefreshSessionRequest(error)) throw error;
      const refreshed = await refreshCurrentAccount();
      signal.throwIfAborted();
      const refreshedAccount = refreshed === null ? null : await resumeBrowserAccount(refreshed);
      signal.throwIfAborted();
      const nextToken = refreshedAccount?.session.accessToken;
      if (typeof nextToken !== 'string' || nextToken.length === 0 || refreshedAccount === null) {
        throw new Error('Browser delegation unavailable after session refresh');
      }
      setAccount(refreshedAccount);
      setAccessToken(nextToken);
      return operation(nextToken, refreshedAccount.session.delegationId);
    }
  }

  async function cancelSessionRequestWithRefresh(issuanceId: string): Promise<void> {
    let token = accessToken();
    if (token === null) {
      const refreshed = await refreshCurrentAccount();
      const refreshedAccount = refreshed === null ? null : await resumeBrowserAccount(refreshed);
      token = refreshedAccount?.session.accessToken ?? null;
      if (token === null || refreshedAccount === null) {
        throw new Error('No access token for session cancellation');
      }
      setAccount(refreshedAccount);
      setAccessToken(token);
    }
    try {
      await cancelSessionRequest(token, issuanceId);
    } catch (error) {
      if (!shouldRefreshSessionRequest(error)) throw error;
      const refreshed = await refreshCurrentAccount();
      const refreshedAccount = refreshed === null ? null : await resumeBrowserAccount(refreshed);
      const nextToken = refreshedAccount?.session.accessToken;
      if (typeof nextToken !== 'string' || nextToken.length === 0 || refreshedAccount === null) {
        throw error;
      }
      setAccount(refreshedAccount);
      setAccessToken(nextToken);
      await cancelSessionRequest(nextToken, issuanceId);
    }
  }
}

function nextVisualFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function toRequestSessionResult(response: {
  daemonId: string;
  daemonIdentityPublicKey: string;
  daemonIdentityP256PublicKey: string;
  daemonBinding: DaemonBinding;
  sessionToken: string;
  sessionTokenExpiresAtMs: number;
  sessionTokenExpiresInMs: number;
  sessionId: string;
  edgeWtUrl: string;
  edgeCertHashes: readonly string[];
  edgeAttachTicket: string;
}): RequestSessionResult {
  return {
    daemonId: response.daemonId,
    daemonIdentityPublicKey: response.daemonIdentityPublicKey,
    daemonIdentityP256PublicKey: response.daemonIdentityP256PublicKey,
    daemonBinding: response.daemonBinding,
    sessionToken: response.sessionToken,
    // Rust retains server expiry as public issuance metadata and schedules
    // renewal only from the server-clock lifetime on its monotonic clock.
    sessionTokenExpiresAtMs: response.sessionTokenExpiresAtMs,
    sessionTokenExpiresInMs: response.sessionTokenExpiresInMs,
    sessionId: response.sessionId,
    // Current session issuance always includes one healthy edge and its pins.
    edgeWtUrl: response.edgeWtUrl,
    edgeCertHashes: response.edgeCertHashes,
    edgeAttachTicket: response.edgeAttachTicket,
  };
}
