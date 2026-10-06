// Session owns the protocol. This host supplies native I/O, monotonic time,
// account RPCs, input/frame SABs and immutable UI publication callbacks.
import { createLogger } from '@merkur/logger';
import {
  type DisplayReceiverProfileMessage,
  encode,
  type TerminalUiEffect,
} from '@merkur/protocol';
import { ClientSession } from '../../../../packages/e2e-wasm/pkg/e2e_wasm.js';
import { loadBrowserDelegation } from '../auth/delegation-vault';
import { loadE2eWasmModule } from '../lib/e2e-wasm-module';
import { createOwnedTimeout, yieldToFairTask } from '../lib/owned-scheduled-callback';
import type { GraphicsAssetPhase } from '../perf/terminal-latency';
import { FRAME_KIND_CLIENT_INGRESS_BASE, type FrameRingWriter } from '../terminal/shared-ring';
import {
  VIEWER_OUTPUT_SPACE_EDGE,
  type ViewerOutputRingReader,
} from '../terminal/viewer-output-ring';
import type {
  PerfGridConvergenceRequestEdge,
  TerminalToTransportPeer,
  TransportToTerminalPeer,
} from '../terminal/worker-peer-control';
import type {
  MainToTransport,
  RenewSessionRequest,
  RenewSessionResult,
  RequestSessionResult,
  TransportHintParams,
} from '../transport-worker-protocol';
import { createCarrierDatagramLanes } from './carrier-datagram-lanes';
import { type ClientCarrier, dialClientCarrier } from './client-carrier';
import { isCurrentViewerPublication, isCurrentViewerStamp } from './client-viewer-publication';
import type { InputRingReader } from './input-ring';
import {
  createLinkActivityPublisher,
  isTerminalTrafficChannel,
  linkActivityNow,
} from './link-activity';
import { SessionRpcError } from './session-rpc-error';
import { createTransportHintPublisher } from './transport-hint-publisher';
import type { TransportStartEvents } from './transport-start-events';

const logger = createLogger('client-session-host');
type Start = Extract<MainToTransport, { kind: 'start' }>;

/** Viewer output kind 6: the resume claim that confirms the viewer's lineage. */
const VIEWER_OUTPUT_RESUME = 6;

/**
 * `merkur_client::session::graphics::GraphicsPhase`, as `e2e-wasm`'s
 * `poll_action` numbers it. `consumed` is not the session's to report.
 */
const SESSION_GRAPHICS_PHASES: readonly GraphicsAssetPhase[] = [
  'demanded',
  'requested',
  'first_byte',
  'fin',
  'published',
  'retired',
  'refused',
  'unavailable',
  'cancelled',
  'interrupted',
  'resumed',
];

export interface BrowserSessionHost {
  readonly input: InputRingReader;
  readonly frames: FrameRingWriter;
  /** What the terminal worker's viewer asks this session to send. */
  readonly viewerOutputs: ViewerOutputRingReader;
  readonly peer: MessagePort;
  presentationPeriodUs(): number;
  beginRequests(startId: number): void;
  endRequests(): void;
  ready(): void;
  observation(value: import('../perf/client-session-observation').ClientSessionObservation): void;
  /** One transition of a graphics job the session reports while this host records. */
  graphicsJob(phase: GraphicsAssetPhase, jobId: number, bytes: number, failed: boolean): void;
  inputSent(sequence: number): void;
  inputAcknowledged(sequence: number, atMs: number, networkRttMs: number | null): void;
  request(request: {
    daemonId: string;
    browserNodeId: string;
    issuanceId: string;
    supersedesIssuanceId?: string;
    clientNonce: string;
    encapsulationKey: string;
  }): Promise<RequestSessionResult>;
  renew(request: RenewSessionRequest): Promise<RenewSessionResult>;
  directDial(
    endpoint: string,
  ): Promise<{ settle(outcome: 'ready' | 'failed' | 'unused'): void } | null>;
}

export function createBrowserClientSession(host: BrowserSessionHost) {
  let session: ClientSession | null = null;
  let memory: WebAssembly.Memory | null = null;
  let words = new Uint32Array(0);
  let active = false;
  let disposed = false;
  let generation = 0;
  let events: TransportStartEvents | null = null;
  let lineage = 0;
  let confirmedViewerLineage = 0;
  let newViewerSession = false;
  let frameToken = 0;
  let txBytes = 0;
  let rxBytes = 0;
  let path: 'direct' | 'relay' | 'unknown' = 'unknown';
  let measuredRevision = 0;
  let metricsChanged = false;
  let acknowledgedProjection = 0;
  let status: 'connecting' | 'ready' | 'reconnecting' | 'closed' | 'relay-paused' = 'closed';
  let identity = '';
  let viewport: readonly [number, number, number, number] | null = null;
  let focused = false;
  let released = 0;
  let issuanceRequest = 0;
  let renewalRequest = 0;
  let interactiveQueueDatagrams = 0;
  let directQueueDatagrams = 0;
  const hints = createTransportHintPublisher(
    (hint, receiveQueueDatagrams, presentationPeriodUs) => {
      if (
        session?.host_observation(
          new Uint8Array(
            encode({
              kind: 'transport_hint',
              ...hint,
              receiveQueueDatagrams,
              presentationPeriodUs,
            }),
          ),
        )
      )
        void drive().catch(failed);
    },
  );
  function publishHostHints(): void {
    hints.notePresentationPeriod(
      path === 'direct' ? directQueueDatagrams : interactiveQueueDatagrams,
      host.presentationPeriodUs(),
    );
  }
  const draining: [Promise<void> | null, Promise<void> | null] = [null, null];
  const requested = [false, false];
  let resumeSpace: (() => void) | null = null;
  let spacePromise: Promise<void> | null = null;
  let hostCreditWake: (() => void) | null = null;
  let hostCreditPromise: Promise<void> | null = null;
  let controlCreditWake: (() => void) | null = null;
  let controlCreditPromise: Promise<void> | null = null;
  let pendingViewport = false;
  let pendingFocus = false;
  let pendingGeometry = false;
  let fenceCredit: { lineage: number; release: () => void } | null = null;
  /** `job` is the session's job for the asset when this host records it, else zero. */
  let assetCredit: { lineage: number; key: string; job: number; release: () => void } | null = null;

  /**
   * The delivered asset left this host's hands: the terminal worker took it,
   * dropped it as stale, or its lineage or session ended first. A recorded
   * job ends here, as the session's own record of it ended at `published`.
   */
  function settleAsset(outcome: 'taken' | 'dropped' | 'cancelled'): void {
    const credit = assetCredit;

    if (credit === null) return;

    assetCredit = null;

    if (credit.job !== 0) {
      if (outcome === 'taken') host.graphicsJob('consumed', credit.job, 0, false);

      if (outcome === 'cancelled') host.graphicsJob('cancelled', credit.job, 0, false);

      host.graphicsJob('retired', credit.job, 0, outcome === 'cancelled');
    }

    credit.release();
  }
  const carriers = new Map<bigint, ClientCarrier | null>();
  const datagrams = createCarrierDatagramLanes<ClientCarrier>(
    (conn, carrier, sent, inputTop, channel, byteLength) => {
      // `stop` retires every lane, so a datagram that settles here belongs to
      // the running session.
      if (!active || session === null || carriers.get(conn) !== carrier) return;
      if (!sent) {
        carriers.delete(conn);
        datagrams.retire(conn);
        carrier.close();
        session.closed(performance.now(), conn, false);
        void drive().catch(failed);
        return;
      }
      if (inputTop !== 0) {
        session.input_datagram_sent(performance.now(), conn, inputTop);
        schedule();
      }
      txBytes += byteLength;
      if (isTerminalTrafficChannel(channel)) activity.record(byteLength, 0, session.is_ready());
    },
  );
  const deadline = createOwnedTimeout(setTimeout, clearTimeout);
  const activity = createLinkActivityPublisher({
    now: linkActivityNow,
    timer: createOwnedTimeout(setTimeout, clearTimeout),
    totals: () => ({ txBytes, rxBytes }),
    publish: (tick) => events?.linkTick(tick),
  });

  // One view of WASM linear memory, replaced only when growth detaches it, so
  // copying a received record or a keystroke into the core mints no view.
  let heap = new Uint8Array(0);
  function heapView(linear: WebAssembly.Memory): Uint8Array {
    if (heap.buffer !== linear.buffer) heap = new Uint8Array(linear.buffer);
    return heap;
  }

  function ingress(bytes: Uint8Array): number {
    if (session === null || memory === null) throw new Error('session ingress before start');
    const pointer = session.reserve_ingress(bytes.byteLength);
    if (pointer === 0) throw new Error('session ingress exceeds its byte bound');
    heapView(memory).set(bytes, pointer);
    return bytes.byteLength;
  }

  function actionWords(): Uint32Array {
    if (session === null || memory === null) throw new Error('session words before start');
    if (words.byteLength === 0)
      words = new Uint32Array(memory.buffer, session.action_words_ptr(), 12);
    return words;
  }

  function actionBytes(): Uint8Array {
    if (session === null || memory === null) throw new Error('session bytes before start');
    return new Uint8Array(memory.buffer, session.action_bytes_ptr(), session.action_bytes_len());
  }

  function signalSpace(): void {
    const resume = resumeSpace;
    resumeSpace = null;
    spacePromise = null;
    resume?.();
  }

  function waitSpace(): Promise<void> {
    spacePromise ??= new Promise<void>((resolve) => {
      resumeSpace = resolve;
    });
    return spacePromise;
  }

  function signalControlCredit(): void {
    const wake = controlCreditWake;
    controlCreditWake = null;
    controlCreditPromise = null;
    wake?.();
  }

  async function waitControlCredit(owner: number, conn: bigint): Promise<void> {
    while (
      active &&
      owner === generation &&
      carriers.has(conn) &&
      session !== null &&
      !session.has_reliable_capacity(2)
    ) {
      controlCreditPromise ??= new Promise<void>((resolve) => {
        controlCreditWake = resolve;
      });
      await controlCreditPromise;
    }
  }

  function flushHostIntents(): void {
    if (session === null || !session.has_reliable_capacity(2)) return;
    if (pendingViewport && viewport !== null) {
      pendingViewport = false;
      session.viewport(...viewport);
    }
    if (pendingFocus) {
      pendingFocus = false;
      session.focused(focused);
    }
    if (pendingGeometry) {
      pendingGeometry = false;
      session.take_geometry();
    }
  }

  function ownsCarrier(
    owner: number,
    current: ClientSession,
    conn: bigint,
    carrier: ClientCarrier,
  ): boolean {
    return active && owner === generation && session === current && carriers.get(conn) === carrier;
  }

  function retireCarriers(): void {
    for (const carrier of carriers.values()) carrier?.close();
    carriers.clear();
    datagrams.clear();
  }

  function metrics(): void {
    if (session === null || events === null) return;
    const quality = JSON.parse(session.quality(performance.now())) as {
      rttMs: number | null;
      networkRttMs: number | null;
      inputAckRttMs: number | null;
      inputAckMs: number | null;
      inputAckSeq: number;
      resyncCount: number;
      degraded: boolean;
    };
    events.metrics({
      rttMs: quality.rttMs,
      networkRttMs: quality.networkRttMs,
      pathType: path,
      availableOutgoingBitrateMbps: null,
      inputAckRttMs: quality.inputAckRttMs,
      inputAckMs: quality.inputAckMs,
      inputAckSeq: quality.inputAckSeq,
      resyncCount: quality.resyncCount,
      txBytes,
      rxBytes,
      degraded: quality.degraded || status === 'reconnecting',
      linkState: status,
    });
  }

  function releaseInput(): void {
    if (session === null) return;
    const acknowledged = session.input_ack_local();
    if (acknowledged !== 0 && acknowledged !== acknowledgedProjection) {
      acknowledgedProjection = acknowledged;
      const floor = session.network_rtt_ms();
      host.inputAcknowledged(
        acknowledged,
        performance.timeOrigin + performance.now(),
        floor < 0 ? null : floor,
      );
    }
    const latest = session.released_input();
    if (latest === released) return;
    released = latest;
    let ordinal = host.input.releasedOrdinal();
    while (ordinal < host.input.consumedOrdinal()) {
      const sequence = host.input.localSeq(ordinal);
      // Ring records are contiguous serial inputs; core alone chooses the
      // authenticated release frontier. This comparison handles u32 wrap.
      if (sequence !== latest && (latest - sequence) >>> 0 >= 0x8000_0000) break;
      ordinal += 1;
    }
    host.input.release(ordinal);
    // The terminal only wakes on a release: the allocation-free numeric edge.
    host.peer.postMessage(0);
  }

  let scheduledAt = Number.NaN;
  function schedule(): void {
    const at = active && session !== null ? session.next_deadline() : Number.NaN;
    if (Object.is(at, scheduledAt)) return;
    scheduledAt = at;
    deadline.cancel();
    if (!Number.isFinite(at)) return;
    const owner = generation;
    deadline.arm(
      () => {
        if (!active || owner !== generation || session === null) return;
        scheduledAt = Number.NaN;
        session.timeout(performance.now());
        void drive().catch(failed);
      },
      Math.max(0, at - performance.now()),
    );
  }

  function failed(error: unknown): void {
    if (!active) return;
    logger.warn('session host operation failed', { error: String(error) });
    stop(false);
    events?.disconnected('edge_failed');
  }

  function signalHostCredit(): void {
    const wake = hostCreditWake;
    hostCreditWake = null;
    hostCreditPromise = null;
    wake?.();
  }
  async function waitHostCredit(owner: number): Promise<void> {
    while (
      active &&
      owner === generation &&
      session !== null &&
      (session.host_actions_len() >= 16 || session.host_actions_bytes() >= 32 * 1024 * 1024)
    ) {
      hostCreditPromise ??= new Promise<void>((resolve) => {
        hostCreditWake = resolve;
      });
      await hostCreditPromise;
    }
  }

  async function deliver(
    owner: number,
    conn: bigint,
    operation: (value: ClientSession) => void,
    control = false,
  ): Promise<void> {
    if (!active || owner !== generation || !carriers.has(conn) || session === null) return;
    const before = session.host_actions_len();
    operation(session);
    // Observe authenticated ACK progress on the host clock in this receipt turn.
    // The core's integer scheduling clock can round an ACK before input_sent.
    releaseInput();
    if (control) {
      // Authenticated pulses that produce no host output never borrow UI credit.
      const producesHostOutput = session.host_actions_len() > before;
      void drive().catch(failed);
      if (producesHostOutput) await waitHostCredit(owner);
    } else await drive();
  }

  const pendingDials = new Map<bigint, AbortController>();

  async function dial(
    owner: number,
    conn: bigint,
    direct: boolean,
    candidate: boolean,
    lane: number,
    metadata: { url: string; certHashes: readonly (readonly number[])[] },
    preface: Uint8Array,
  ): Promise<void> {
    const cancellation = new AbortController();
    pendingDials.set(conn, cancellation);
    const admitted = Promise.withResolvers<void>();
    const receive = async (
      operation: (value: ClientSession) => void,
      control = false,
    ): Promise<void> => {
      await admitted.promise;
      return deliver(owner, conn, operation, control);
    };
    let claim: Awaited<ReturnType<BrowserSessionHost['directDial']>> = null;
    try {
      if (direct) {
        claim = await host.directDial(metadata.url);
        if (!active || owner !== generation || !carriers.has(conn)) {
          claim?.settle('unused');
          return;
        }
        if (claim === null) throw new Error('direct endpoint is already being dialed');
      }
      const carrier = await dialClientCarrier(
        metadata.url,
        metadata.certHashes,
        preface,
        candidate,
        direct,
        {
          splice: (json) =>
            receive((value) => {
              value.splice(performance.now(), conn, json);
            }, true),
          reliable: async (source, channel, bytes) => {
            await admitted.promise;
            if (channel === 2) await waitControlCredit(owner, conn);
            return receive(
              (value) => {
                rxBytes += bytes.byteLength + 4;
                if (isTerminalTrafficChannel(channel))
                  activity.record(0, bytes.byteLength + 4, value.is_ready());
                value.receive(performance.now(), 0, conn, source, channel, ingress(bytes));
              },
              channel === 0 || channel === 1 || channel === 2 || channel === 6,
            );
          },
          datagram: (bytes) =>
            receive(
              (value) => {
                rxBytes += bytes.byteLength;
                if (isTerminalTrafficChannel(bytes[0] ?? null))
                  activity.record(0, bytes.byteLength, value.is_ready());
                value.receive(performance.now(), 1, conn, 0n, 0, ingress(bytes));
              },
              bytes[0] === 1 || bytes[0] === 2,
            ),
          proof: (bytes) =>
            receive((value) => {
              value.receive(performance.now(), 2, conn, 0n, 0, ingress(bytes));
            }, true),
          finite: (stream, kind, channel, total, bytes) =>
            receive((value) => {
              value.receive(
                performance.now(),
                kind,
                conn,
                stream,
                channel,
                kind === 3 ? total : bytes.byteLength === 0 ? 0 : ingress(bytes),
              );
            }),
          closed: (egressBudget) => {
            if (!active || owner !== generation || !carriers.has(conn) || session === null) return;
            const pending = carriers.get(conn) === null;
            carriers.delete(conn);
            datagrams.retire(conn);
            if (pending) session.dial_failed(performance.now(), conn);
            else session.closed(performance.now(), conn, egressBudget);
            admitted.resolve();
            signalControlCredit();
            void drive().catch(failed);
          },
        },
        cancellation.signal,
      );
      if (!active || owner !== generation || !carriers.has(conn) || session === null) {
        carrier.close();
        claim?.settle('unused');
        return;
      }
      carriers.set(conn, carrier);
      if (direct) directQueueDatagrams = carrier.receiveQueueDatagrams;
      else if (lane === 1) interactiveQueueDatagrams = carrier.receiveQueueDatagrams;
      claim?.settle('ready');
      session.connected(performance.now(), conn);
      admitted.resolve();
      await drive();
    } catch (error) {
      claim?.settle('failed');
      if (!active || owner !== generation || !carriers.has(conn) || session === null) return;
      carriers.delete(conn);
      session.dial_failed(performance.now(), conn);
      logger.info('carrier dial ended', { error: String(error) });
      await drive();
    } finally {
      admitted.resolve();
      if (pendingDials.get(conn) === cancellation) pendingDials.delete(conn);
    }
  }

  function drainIoAction(owner: number, kind: number, conn: bigint, w: Uint32Array): void {
    if (session === null) return;
    switch (kind) {
      case 1: {
        const request = JSON.parse(session.action_metadata()) as Parameters<
          BrowserSessionHost['request']
        >[0];
        const requestOwner = ++issuanceRequest;
        void host.request(request).then(
          (issued) => {
            if (
              active &&
              owner === generation &&
              requestOwner === issuanceRequest &&
              session !== null
            ) {
              session.issued(performance.now(), JSON.stringify(issued));
              void drive().catch(failed);
            }
          },
          (error: unknown) => {
            if (
              active &&
              owner === generation &&
              requestOwner === issuanceRequest &&
              session !== null
            ) {
              logger.warn('session account request failed', {
                operation: 'issuance',
                issuanceId: request.issuanceId,
                error: String(error),
                code: error instanceof SessionRpcError ? error.code : undefined,
              });
              if (error instanceof SessionRpcError && error.code === 'authorization_rejected')
                session.authorization_denied(performance.now());
              else if (error instanceof SessionRpcError && error.code === 'daemon_unlinked')
                session.daemon_unlinked(performance.now());
              else if (
                error instanceof SessionRpcError &&
                (error.code === 'invalid_session_response' || error.code === 'request_rejected')
              )
                session.issued(performance.now(), '');
              else session.issuance_failed(performance.now());
              void drive().catch(failed);
            }
          },
        );
        break;
      }
      case 2: {
        const request = JSON.parse(session.action_metadata()) as RenewSessionRequest;
        const requestOwner = ++renewalRequest;
        void host.renew(request).then(
          (renewed) => {
            if (
              active &&
              owner === generation &&
              requestOwner === renewalRequest &&
              session !== null
            ) {
              session.renewed(performance.now(), JSON.stringify(renewed));
              void drive().catch(failed);
            }
          },
          (error: unknown) => {
            if (
              active &&
              owner === generation &&
              requestOwner === renewalRequest &&
              session !== null
            ) {
              logger.warn('session account request failed', {
                operation: 'renewal',
                sessionId: request.sessionId,
                error: String(error),
                code: error instanceof SessionRpcError ? error.code : undefined,
              });
              if (error instanceof SessionRpcError && error.code === 'authorization_rejected')
                session.authorization_denied(performance.now());
              else session.renewed(performance.now(), '');
              void drive().catch(failed);
            }
          },
        );
        break;
      }
      case 3:
      case 4: {
        const metadata = JSON.parse(session.action_metadata()) as {
          url: string;
          certHashes: readonly (readonly number[])[];
        };
        const preface = actionBytes().slice();
        carriers.set(conn, null);
        void dial(owner, conn, kind === 4, w[3] === 1, w[2] ?? 0, metadata, preface).catch(failed);
        break;
      }
      case 5:
      case 6: {
        const carrier = carriers.get(conn);
        if (carrier === null || carrier === undefined) break;
        const current = session;
        const payload = actionBytes().slice();
        const channel = kind === 5 ? (w[2] ?? 0) : 0;
        // One native write owns the exact lane credit until writer.write resolves.
        current.reliable_blocked(performance.now(), conn, channel, true);
        const write = kind === 5 ? carrier.reliable(channel, payload) : carrier.proof(payload);
        void write
          .then(
            () => {
              if (!ownsCarrier(owner, current, conn, carrier)) return;
              txBytes += payload.byteLength + 4;
              if (isTerminalTrafficChannel(channel))
                activity.record(payload.byteLength, 0, current.is_ready());
              current.reliable_blocked(performance.now(), conn, channel, false);
              signalControlCredit();
              flushHostIntents();
              void drive().catch(failed);
            },
            () => {
              if (!ownsCarrier(owner, current, conn, carrier)) return;
              carriers.delete(conn);
              datagrams.retire(conn);
              carrier.close();
              current.closed(performance.now(), conn, false);
              void drive().catch(failed);
            },
          )
          .finally(() => payload.fill(0));
        break;
      }
      case 7: {
        const carrier = carriers.get(conn);
        if (carrier === null || carrier === undefined) break;
        // Offered, never awaited here: this drain also starts dials and
        // account requests, which a carrier's stalled write must not hold.
        datagrams.offer(conn, carrier, actionBytes().slice(), w[2] ?? 0);
        break;
      }
      case 8:
        pendingDials.get(conn)?.abort();
        pendingDials.delete(conn);
        carriers.get(conn)?.close();
        carriers.delete(conn);
        datagrams.retire(conn);
        break;
      // Its words are a phase and a job, not a connection.
      case 20:
        reportGraphicsJob(w);
        break;
    }
  }

  /** Action 20: one transition of a graphics job the session reports to a recording host. */
  function reportGraphicsJob(w: Uint32Array): void {
    const phase = SESSION_GRAPHICS_PHASES[w[0] ?? 0];

    if (phase === undefined) throw new Error(`graphics phase ${String(w[0])} is unknown`);

    host.graphicsJob(phase, (w[1] ?? 0) + (w[2] ?? 0) * 0x1_0000_0000, w[3] ?? 0, w[4] === 1);
  }

  function applyStatus(w: Uint32Array): void {
    if (session === null) return;

    metricsChanged = true;
    const state = w[0] ?? 0;
    if (state === 0 || state === 1) {
      status = 'connecting';
    } else if (state === 2) {
      status = 'ready';
      events?.signalingStatus('connected');
      events?.connected(lineage > 1, frameToken, session.session_id() ?? '');
      host.ready();
      signalControlCredit();
      flushHostIntents();
      hints.resetDelivery();
      publishHostHints();
    } else if (state === 3) {
      status = 'reconnecting';
      events?.signalingStatus('reconnecting');
    } else if (state === 4) {
      status = 'relay-paused';
    } else {
      status = 'closed';
      events?.disconnected(session.action_metadata());
      stop(false);
    }
  }

  // The ring reads a mapping synchronously, so one object serves every frame;
  // only a write that must wait for space keeps its own copy.
  const frameMapping = { epoch: 0, localMinusWire: 0, wireMin: 0, wireMax: 0 };
  async function deliverFrame(owner: number, w: Uint32Array): Promise<void> {
    const channel = w[0] ?? 0;
    const allowLarge = w[1] === 0;
    frameMapping.epoch = w[2] ?? 0;
    frameMapping.localMinusWire = w[3] ?? 0;
    frameMapping.wireMin = w[4] ?? 0;
    frameMapping.wireMax = w[5] ?? 0;
    // The common path copies once from reusable WASM output into the SAB.
    if (
      !host.frames.write(
        actionBytes(),
        FRAME_KIND_CLIENT_INGRESS_BASE + channel,
        allowLarge,
        frameMapping,
      )
    ) {
      const mapping = { ...frameMapping };
      const payload = actionBytes().slice();
      do {
        await waitSpace();
        if (!active || owner !== generation) break;
      } while (
        !host.frames.write(payload, FRAME_KIND_CLIENT_INGRESS_BASE + channel, allowLarge, mapping)
      );
      payload.fill(0);
    }
  }

  async function deliverGraphics(kind: number, w: Uint32Array): Promise<void> {
    if (session === null) return;
    switch (kind) {
      case 13: {
        const status = w[0];
        if (status !== 0 && status !== 1 && status !== 2) {
          throw new Error(`geometry status ${String(status)} is not vacant, owner or observer`);
        }
        host.peer.postMessage({
          kind: 'client_geometry',
          lineage,
          frameFenceToken: frameToken,
          status,
        } satisfies TransportToTerminalPeer);
        break;
      }
      case 14:
        host.peer.postMessage({
          kind: 'client_graphics_clock',
          lineage,
          frameFenceToken: frameToken,
          monotonicUs: BigInt(w[0] ?? 0) | (BigInt(w[1] ?? 0) << 32n),
          rttMs: Number(BigInt(w[2] ?? 0) | (BigInt(w[3] ?? 0) << 32n)),
        } satisfies TransportToTerminalPeer);
        break;
      case 15: {
        const epoch = w[0] ?? 0;
        if (epoch !== session.display_lineage()) break;
        const bytes = actionBytes().slice();
        const key = session.action_metadata();
        const job = (w[2] ?? 0) + (w[3] ?? 0) * 0x1_0000_0000;

        const acknowledged = new Promise<void>((resolve) => {
          assetCredit = { lineage: epoch, key, job, release: resolve };
        });
        host.peer.postMessage(
          {
            kind: 'client_graphics_asset',
            lineage,
            frameFenceToken: frameToken,
            epoch,
            asset: w[1] ?? 0,
            key,
            bytes,
          } satisfies TransportToTerminalPeer,
          [bytes.buffer],
        );
        await acknowledged;
        break;
      }
    }
  }

  async function drain(owner: number, io: boolean): Promise<void> {
    while (active && owner === generation && session !== null) {
      releaseInput();
      const kind = session.poll_action(io);
      if (!io) signalHostCredit();
      if (kind === 0) break;
      const w = actionWords();
      if (io) {
        drainIoAction(owner, kind, BigInt(w[0] ?? 0) | (BigInt(w[1] ?? 0) << 32n), w);
        continue;
      }
      switch (kind) {
        case 9:
          await deliverFrame(owner, w);
          break;
        case 10: {
          lineage = w[0] ?? 0;
          host.input.revokeShadowProvenance();
          frameToken = host.frames.fenceSessionLineage();
          const fenced = new Promise<void>((resolve) => {
            fenceCredit = { lineage, release: resolve };
          });
          host.peer.postMessage({
            kind: 'client_session_fence',
            lineage,
            frameFenceToken: frameToken,
            newSession: newViewerSession,
          } satisfies TransportToTerminalPeer);
          newViewerSession = false;
          await fenced;
          break;
        }
        case 11:
          applyStatus(w);
          break;
        case 12:
          metricsChanged = true;
          path = w[0] === 1 ? 'direct' : 'relay';
          publishHostHints();
          break;
        case 13:
        case 14:
        case 15:
          await deliverGraphics(kind, w);
          break;
        case 16:
          events?.openUrl(w[0] ?? 0, w[1] ?? 0, session.action_metadata());
          session.acknowledge_open_url(w[0] ?? 0, w[1] ?? 0);
          break;
        case 19:
          host.observation(
            JSON.parse(
              session.action_metadata(),
            ) as import('../perf/client-session-observation').ClientSessionObservation,
          );
          break;
        case 18:
          events?.observedPath(session.action_metadata());
          break;
        case 17:
          events?.terminalUi(JSON.parse(session.action_metadata()) as TerminalUiEffect);
          break;
      }
    }
    if (!io && active && owner === generation && session !== null) {
      const revision = session.quality_revision();
      if (metricsChanged || revision !== measuredRevision) {
        metricsChanged = false;
        measuredRevision = revision;
        metrics();
      }
    }
  }

  function runLane(io: boolean): Promise<void> {
    const lane = io ? 1 : 0;
    requested[lane] = true;
    const prior = draining[lane];
    if (prior !== null) return prior;
    const owner = generation;
    const operation = (async (): Promise<void> => {
      while (active && owner === generation && requested[lane]) {
        requested[lane] = false;
        await drain(owner, io);
      }
    })();
    draining[lane] = operation;
    void operation
      .finally(() => {
        if (draining[lane] !== operation) return;
        draining[lane] = null;
        // A receipt can request another drain after the loop's final check but
        // before this promise retires. It joined the old owner, so the pending
        // request must hand ownership to a successor without another receipt.
        if (active && owner === generation && requested[lane]) void runLane(io).catch(failed);
      })
      .catch(() => undefined);
    return operation;
  }

  function drive(): Promise<void> {
    if (
      fenceCredit !== null &&
      session !== null &&
      fenceCredit.lineage !== session.display_lineage()
    ) {
      const credit = fenceCredit;
      fenceCredit = null;
      credit.release();
    }
    if (active && session !== null) {
      for (;;) {
        const conn = session.poll_close(performance.now());
        if (conn === undefined) break;
        // Remove ownership before native close callbacks can re-enter Session.
        const carrier = carriers.get(conn);
        carriers.delete(conn);
        datagrams.retire(conn);
        pendingDials.get(conn)?.abort();
        pendingDials.delete(conn);
        carrier?.close();
        signalControlCredit();
      }
      if (session.has_reliable_capacity(2)) {
        signalControlCredit();
        flushHostIntents();
      }
    }
    if (
      assetCredit !== null &&
      session !== null &&
      assetCredit.lineage !== session.display_lineage()
    ) {
      settleAsset('cancelled');
    }
    schedule();
    void runLane(true).catch(failed);
    return runLane(false);
  }

  async function readInput(owner: number): Promise<void> {
    let count = 0;
    while (active && generation === owner && session !== null && memory !== null) {
      const ordinal = host.input.tryReadNext();
      if (ordinal < 0) {
        count = 0;
        const wake = host.input.waitAsync();
        if (wake !== 'not-equal') await wake;
        continue;
      }
      const length = host.input.payloadLength(ordinal);
      const pointer = session.reserve_ingress(length);
      if (pointer === 0) throw new Error('input record exceeds Session ingress');
      host.input.copyPayload(ordinal, heapView(memory), pointer);
      session.input(
        performance.now(),
        host.input.localSeq(ordinal),
        length,
        host.input.shadowModelled(ordinal) &&
          confirmedViewerLineage > 0 &&
          confirmedViewerLineage === session.display_lineage(),
      );
      host.inputSent(host.input.localSeq(ordinal));
      void drive().catch(failed);
      await runLane(true);
      count += 1;
      if (count === 64) {
        count = 0;
        await yieldToFairTask();
      }
    }
  }

  /**
   * Hand the ring's next entry to the session, unless it was polled under
   * another lineage or fence, or there is no session to take it. True when the
   * session was offered it.
   */
  function ingestViewerOutput(length: number): boolean {
    const outputs = host.viewerOutputs;
    if (!active || session === null || memory === null) return false;
    if (!isCurrentViewerStamp(outputs.lineage(), outputs.frameFenceToken(), lineage, frameToken))
      return false;
    const pointer = session.reserve_ingress(length);
    if (pointer === 0) throw new Error('viewer output exceeds Session ingress');
    outputs.copyPayload(heapView(memory), pointer);
    const kind = outputs.kind();
    const accepted = session.ingest_viewer_output(performance.now(), lineage, kind, length);
    if (accepted && kind === VIEWER_OUTPUT_RESUME) confirmedViewerLineage = lineage;
    return true;
  }

  /**
   * Read what the terminal worker's viewer asks this session to send, for the
   * life of this host: the ring outlives every session. An entry no session
   * can take is consumed and dropped, as its port message was. A ring this
   * drain found refusing owes the terminal worker the edge that resumes it.
   */
  async function readViewerOutputs(): Promise<void> {
    const outputs = host.viewerOutputs;
    while (!disposed) {
      let offered = false;
      for (let length = outputs.nextLength(); length >= 0; length = outputs.nextLength()) {
        // A session that fails on an output ends as any failed operation
        // does; this reader outlives it for the session that follows.
        try {
          if (ingestViewerOutput(length)) offered = true;
        } catch (error) {
          failed(error);
        }
        outputs.consume();
      }
      if (outputs.takeRefusal()) host.peer.postMessage(VIEWER_OUTPUT_SPACE_EDGE);
      if (offered) void drive().catch(failed);
      const wake = outputs.waitAsync();
      if (wake !== 'not-equal') await wake;
    }
  }

  function stop(preserveInput: boolean): void {
    active = false;
    lineage = 0;
    confirmedViewerLineage = 0;
    generation += 1;
    draining[0] = null;
    draining[1] = null;
    requested[0] = false;
    requested[1] = false;
    deadline.cancel();
    scheduledAt = Number.NaN;
    activity.stop();
    for (const cancellation of pendingDials.values()) cancellation.abort();
    pendingDials.clear();
    retireCarriers();
    session?.suspend();
    signalSpace();
    signalHostCredit();
    const fence = fenceCredit;
    fenceCredit = null;
    fence?.release();
    settleAsset('cancelled');
    host.endRequests();
    signalControlCredit();
    if (!preserveInput) {
      session?.free();
      session = null;
      words = new Uint32Array(0);
      identity = '';
      released = 0;
      host.input.release(host.input.consumedOrdinal());
      host.input.discardQueuedEntries();
    }
  }

  void readViewerOutputs().catch(failed);

  return {
    async start(message: Start, publication: TransportStartEvents): Promise<void> {
      stop(true);
      const owner = generation;
      events = publication;
      host.beginRequests(message.startId);
      active = true;
      const nextIdentity = `${message.userId}/${message.delegationId}/${message.browserPeerId}`;
      const loaded = await loadE2eWasmModule();
      if (!active || owner !== generation) return;
      memory = loaded.memory;
      if (session === null || identity !== nextIdentity) {
        if (identity !== '' && identity !== nextIdentity) {
          host.input.release(host.input.consumedOrdinal());
          host.input.discardQueuedEntries();
        }
        session?.free();
        session = null;
        words = new Uint32Array(0);
        const delegation = await loadBrowserDelegation(message.userId);
        if (delegation === null) throw new Error('browser session delegation is locked');
        try {
          if (!active || owner !== generation) return;
          if (delegation.certificate.delegationId !== message.delegationId)
            throw new Error('browser delegation changed');
          session = new ClientSession(
            JSON.stringify(delegation.certificate),
            delegation.rootPublicKey,
            self.location.origin,
            message.browserPeerId,
            import.meta.env.VITE_FORCE_EDGE === '1',
            delegation.delegateSeed,
          );
          identity = nextIdentity;
          newViewerSession = true;
        } finally {
          delegation.delegateSeed.fill(0);
          delegation.rootPublicKey.fill(0);
        }
      }
      if (session === null) throw new Error('session construction failed');
      measuredRevision = 0;
      metricsChanged = true;
      acknowledgedProjection = 0;
      released = session.released_input();
      if (viewport !== null) session.viewport(...viewport);
      session.focused(focused);
      session.connect(message.daemonId);
      activity.start();
      publication.inputReady();
      await drive();
      if (active && owner === generation) void readInput(owner).catch(failed);
    },
    stop,
    dispose(): void {
      disposed = true;
      stop(false);
      events = null;
      memory = null;
    },
    /** A guarded terminal publication; one made under another lineage or fence is stale. */
    peer(message: Exclude<TerminalToTransportPeer, PerfGridConvergenceRequestEdge>): void {
      if (!active || session === null) return;
      if (!isCurrentViewerPublication(message, lineage, frameToken)) return;
      switch (message.kind) {
        case 'client_viewer_fenced': {
          if (lineage !== session.display_lineage()) return;
          confirmedViewerLineage = lineage;
          const credit = fenceCredit;
          fenceCredit = null;
          credit?.release();
          return;
        }
        case 'client_graphics_consumed': {
          if (
            assetCredit === null ||
            message.lineage !== assetCredit.lineage ||
            message.key !== assetCredit.key
          )
            return;
          settleAsset(message.taken ? 'taken' : 'dropped');
          return;
        }
        case 'client_link_definitions':
          events?.displayLinkTable(message.reset, message.entries);
          return;
      }
    },
    space: signalSpace,
    resize(cols: number, rows: number, cellWidth: number, cellHeight: number): void {
      // The terminal measures a cell in 16.16 fixed point; the session takes
      // one cell in logical pixels and fixes it itself.
      viewport = [cols, rows, cellWidth / 65_536, cellHeight / 65_536];
      pendingViewport = true;
      flushHostIntents();
      void drive().catch(failed);
    },
    focused(value: boolean): void {
      focused = value;
      pendingFocus = true;
      flushHostIntents();
      void drive().catch(failed);
    },
    takeGeometry(): void {
      pendingGeometry = true;
      flushHostIntents();
      void drive().catch(failed);
    },
    snapshot(): void {
      session?.snapshot(performance.now());
      void drive().catch(failed);
    },
    hint(): void {
      if (!active) return;
      session?.connectivity_hint(performance.now());
      void drive().catch(failed);
    },
    observation(frame: Uint8Array): boolean {
      const sent = session?.host_observation(frame) ?? false;
      if (sent) void drive().catch(failed);
      return sent;
    },
    profile(profile: DisplayReceiverProfileMessage): boolean {
      return this.observation(new Uint8Array(encode(profile)));
    },
    transportHint(hint: TransportHintParams): void {
      hints.noteNetworkHint(
        hint,
        path === 'direct' ? directQueueDatagrams : interactiveQueueDatagrams,
        host.presentationPeriodUs(),
      );
    },
    presentationChanged: publishHostHints,
    observe(subscriptionId: number, enabled: boolean, columns: number): void {
      activity.subscribe(subscriptionId, enabled, columns);
    },
    acknowledge(subscriptionId: number, sequence: number): void {
      activity.acknowledge(subscriptionId, sequence);
    },
  };
}
