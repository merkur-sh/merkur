// Browser host of the shared Rust Session. Terminal frame ownership and display
// policy belong to ClientViewer in the terminal worker.
import { createLogger } from '@merkur/logger';
import { type DisplayReceiverProfileMessage, encode } from '@merkur/protocol';
import { createTaskWake } from './lib/task-wake';
import { recordClientSessionObservation } from './perf/client-session-observation';
import {
  emitGraphicsAsset,
  emitInputAck,
  emitInputSeqEvent,
  PERF_KIND_INPUT_SENT,
} from './perf/perf-event-codec';
import { createPerfRingWriter, type PerfRingWriter } from './perf/perf-ring';
import { terminalPerfNowMs } from './perf/terminal-latency';
import { createDisplayReceiverProfileReader } from './terminal/display-receiver-profile';
import {
  createPresentationCadenceReader,
  PRESENTATION_PERIOD_CHANGED_EDGE,
} from './terminal/presentation-cadence';
import {
  createFrameRingWriterForMode,
  createInputRingReaderForMode,
  createViewerOutputRingReaderForMode,
} from './terminal/ring-wake-readers';
import { FRAME_RING_SPACE_EDGE } from './terminal/shared-ring';
import { wakeViewerOutputRingReader } from './terminal/viewer-output-ring';
import type { TerminalToTransportPeer } from './terminal/worker-peer-control';
import { createBrowserClientSession } from './transport/browser-client-session';
import { wakeInputRingReader } from './transport/input-ring';
import { SessionRpcError } from './transport/session-rpc-error';
import { createStartOwnedRpcRegistry } from './transport/start-owned-rpc-registry';
import { createTransportStartEvents } from './transport/transport-start-events';
import {
  INPUT_AVAILABLE_EDGE,
  type MainToTransport,
  type RenewSessionResult,
  type RequestSessionResult,
  type TransportToMain,
} from './transport-worker-protocol';

const logger = createLogger('transport-worker');
const inputWake = createTaskWake();
const viewerOutputWake = createTaskWake();
const requests = createStartOwnedRpcRegistry<RequestSessionResult>();
const renewals = createStartOwnedRpcRegistry<RenewSessionResult>();
const directDials = createStartOwnedRpcRegistry<boolean>();
let core: ReturnType<typeof createBrowserClientSession> | null = null;
let inputSab: SharedArrayBuffer | null = null;
let viewerOutputSab: SharedArrayBuffer | null = null;
let peer: MessagePort | null = null;
let profileReader: ReturnType<typeof createDisplayReceiverProfileReader> | null = null;
let profileTimer: ReturnType<typeof setInterval> | null = null;
let pendingProfile: DisplayReceiverProfileMessage | null = null;
let observationEpoch = 1;
let perfEnabled = false;
let perfWriter: PerfRingWriter | null = null;
let currentStart = 0;

function post(message: TransportToMain): void {
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(message);
}

function flushProfile(): void {
  pendingProfile = profileReader?.readIfChanged() ?? pendingProfile;
  if (pendingProfile !== null && core?.profile(pendingProfile)) pendingProfile = null;
}

function observation(): void {
  core?.observation(
    new Uint8Array(encode({ kind: 'perf_enable', enabled: perfEnabled, observationEpoch })),
  );
}

function init(message: Extract<MainToTransport, { kind: 'init' }>): void {
  if (core !== null) return;
  peer = message.ringWakePort;
  inputSab = message.inputRing;
  viewerOutputSab = message.viewerOutputRing;
  observationEpoch = message.perfObservationEpoch;
  perfEnabled = message.perfEnabled;
  perfWriter = createPerfRingWriter(message.perfRing);
  profileReader = createDisplayReceiverProfileReader(message.displayReceiverProfile);
  const input = createInputRingReaderForMode(
    message.displayRingWakeMode,
    message.inputRing,
    message.predictionAdmission,
    inputWake,
  );
  const frames = createFrameRingWriterForMode(
    message.displayRingWakeMode,
    message.frameRing,
    message.ringWakePort,
  );
  const viewerOutputs = createViewerOutputRingReaderForMode(
    message.displayRingWakeMode,
    message.viewerOutputRing,
    viewerOutputWake,
  );
  const cadence = createPresentationCadenceReader(message.presentationCadence);
  core = createBrowserClientSession({
    presentationPeriodUs: () => cadence.presentationPeriodUs(),
    input,
    frames,
    viewerOutputs,
    peer: message.ringWakePort,
    beginRequests(startId): void {
      requests.beginOwner(startId);
      renewals.beginOwner(startId);
      directDials.beginOwner(startId);
    },
    inputSent(sequence): void {
      if (perfEnabled && perfWriter !== null)
        emitInputSeqEvent(perfWriter, PERF_KIND_INPUT_SENT, terminalPerfNowMs(), sequence);
    },
    inputAcknowledged(sequence, atMs, floor): void {
      if (perfEnabled && perfWriter !== null) emitInputAck(perfWriter, atMs, sequence, floor);
    },
    ready(): void {
      observation();
      flushProfile();
    },
    observation(value): void {
      if (perfEnabled && perfWriter !== null && peer !== null)
        recordClientSessionObservation(
          perfWriter,
          value,
          terminalPerfNowMs(),
          observationEpoch,
          peer,
        );
    },
    graphicsJob(phase, jobId, bytes, failed): void {
      if (perfEnabled && perfWriter !== null)
        emitGraphicsAsset(perfWriter, terminalPerfNowMs(), phase, jobId, bytes, failed);
    },
    endRequests(): void {
      requests.closeOwner('session retired');
      renewals.closeOwner('session retired');
      directDials.closeOwner('session retired');
    },
    request(request): Promise<RequestSessionResult> {
      return requests.request((requestId, startId) =>
        post({
          kind: 'request_session',
          startId,
          requestId,
          daemonId: request.daemonId,
          browserNodeId: request.browserNodeId,
          issuanceId: request.issuanceId,
          ...(request.supersedesIssuanceId === undefined
            ? {}
            : { supersedesIssuanceId: request.supersedesIssuanceId }),
          clientNonce: request.clientNonce,
          encapsulationKey: request.encapsulationKey,
        }),
      );
    },
    renew(request): Promise<RenewSessionResult> {
      return renewals.request((requestId, startId) =>
        post({
          kind: 'renew_session',
          startId,
          requestId,
          daemonId: request.daemonId,
          browserNodeId: request.browserNodeId,
          sessionId: request.sessionId,
          commitment: request.commitment,
          edgeWtUrl: request.edgeWtUrl,
        }),
      );
    },
    async directDial(endpoint) {
      let requestId = 0;
      let startId = 0;
      const allowed = await directDials.request((id, owner) => {
        requestId = id;
        startId = owner;
        post({ kind: 'direct_dial', startId, requestId, endpoint });
      });
      if (!allowed) return null;
      let settled = false;
      return {
        settle(outcome): void {
          if (settled) return;
          settled = true;
          post({ kind: 'direct_dial_settle', startId, requestId, outcome });
        },
      };
    },
  });
  message.ringWakePort.onmessage = (
    event: MessageEvent<number | TerminalToTransportPeer>,
  ): void => {
    const data = event.data;
    // Wake edges are bare numbers; everything else is a peer message.
    if (typeof data === 'number') {
      // Task mode: 0 says the terminal worker published to the viewer-output ring.
      if (data === 0) viewerOutputWake.wake();
      else if (data === PRESENTATION_PERIOD_CHANGED_EDGE) core?.presentationChanged();
      else if (data === FRAME_RING_SPACE_EDGE) core?.space();
      return;
    }
    if (data.kind === 'perf_grid_convergence_request') {
      core?.observation(
        new Uint8Array(
          encode({
            kind: 'perf_grid_convergence_request',
            observationEpoch: data.observationEpoch,
            probeId: data.probeId,
          }),
        ),
      );
      return;
    }
    core?.peer(data);
  };
  profileTimer = setInterval(flushProfile, 1000);
  post({ kind: 'ready' });
}

function message(value: MainToTransport): void {
  if (value.kind === 'init') {
    init(value);
    return;
  }
  if (value.kind === 'request_session_result') {
    if (value.error !== undefined)
      requests.reject(
        value.startId,
        value.requestId,
        new SessionRpcError(value.error, value.errorCode),
      );
    else requests.resolve(value.startId, value.requestId, value.result);
    return;
  }
  if (value.kind === 'renew_session_result') {
    if (value.error !== undefined)
      renewals.reject(
        value.startId,
        value.requestId,
        new SessionRpcError(value.error, value.errorCode),
      );
    else renewals.resolve(value.startId, value.requestId, value.result);
    return;
  }
  if (value.kind === 'direct_dial_result') {
    if (!directDials.resolve(value.startId, value.requestId, value.allowed) && value.allowed)
      post({
        kind: 'direct_dial_settle',
        startId: value.startId,
        requestId: value.requestId,
        outcome: 'unused',
      });
    return;
  }
  if (value.kind === 'shutdown') {
    core?.dispose();
    core = null;
    currentStart = 0;
    if (inputSab !== null) wakeInputRingReader(inputSab);
    inputSab = null;
    inputWake.wake();
    if (viewerOutputSab !== null) wakeViewerOutputRingReader(viewerOutputSab);
    viewerOutputSab = null;
    viewerOutputWake.wake();
    peer?.close();
    peer = null;
    if (profileTimer !== null) clearInterval(profileTimer);
    profileTimer = null;
    profileReader = null;
    pendingProfile = null;
    perfWriter = null;
    post({ kind: 'shutdown_complete' });
    return;
  }
  if (core === null) return;
  switch (value.kind) {
    case 'start': {
      currentStart = value.startId;
      perfEnabled = value.perfEnabled;
      observationEpoch = value.perfObservationEpoch;
      const events = createTransportStartEvents(value.startId, post);
      void core
        .start(value, events)
        .then(observation)
        .catch((error: unknown) => {
          if (currentStart !== value.startId) return;
          logger.warn('session startup failed', { error: String(error) });
          core?.stop(false);
          events.disconnected('edge_failed');
        });
      break;
    }
    case 'resize':
      core.resize(value.cols, value.rows, value.cellWidth, value.cellHeight);
      break;
    case 'window_focus':
      core.focused(value.focused);
      break;
    case 'take_geometry_control':
      core.takeGeometry();
      break;
    case 'request_snapshot':
      core.snapshot();
      break;
    case 'hint':
      if (value.hint !== 'offline' && value.hint !== 'persist_on_hide') core.hint();
      break;
    case 'page_resumed':
      inputWake.wake();
      if (inputSab !== null) wakeInputRingReader(inputSab);
      viewerOutputWake.wake();
      if (viewerOutputSab !== null) wakeViewerOutputRingReader(viewerOutputSab);
      core.hint();
      break;
    case 'observe_link':
      core.observe(value.subscriptionId, value.enabled, value.columns);
      break;
    case 'link_tick_ack':
      core.acknowledge(value.subscriptionId, value.sequence);
      break;
    case 'transport_hint':
      core.transportHint(value.hint);
      break;
    case 'perf_observation_epoch':
      observationEpoch = value.perfObservationEpoch;
      observation();
      break;
    case 'stop_session':
      currentStart = 0;
      core.stop(value.preserveInput);
      inputWake.wake();
      if (inputSab !== null) wakeInputRingReader(inputSab);
      break;
  }
}

self.onmessage = (event: MessageEvent<typeof INPUT_AVAILABLE_EDGE | MainToTransport>): void => {
  const data = event.data;
  // The input ring's task wake is a bare number: nothing to clone.
  if (data === INPUT_AVAILABLE_EDGE) {
    inputWake.wake();
    return;
  }
  message(data);
};
