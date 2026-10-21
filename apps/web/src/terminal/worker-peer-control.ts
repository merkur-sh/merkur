import type { DisplayLinkDefinition } from '@merkur/protocol';

/**
 * The transport and terminal workers' private port. Numbers on it are the
 * allocation-free hot-path wake edges; everything else is one of the messages
 * below. Each publication names the session lineage and the display-ring
 * fence it was made under, which its receiver compares against its own. The
 * fence itself never crosses this port: it travels in the frame ring, ordered
 * with the frames, and nothing on either side waits for a message here to
 * learn of it.
 */
interface PeerPublication {
  readonly lineage: number;
  readonly frameFenceToken: number;
}

/** Rare diagnostic control: request a measurement-only grid observation. */
export interface PerfGridConvergenceRequestEdge {
  readonly kind: 'perf_grid_convergence_request';
  readonly observationEpoch: number;
  readonly probeId: number;
}

export interface PerfGridConvergenceResponseEdge {
  readonly kind: 'perf_grid_convergence_response';
  readonly observationEpoch: number;
  readonly probeId: number;
  readonly generation: number;
  readonly lastAdmittedDisplaySeq: number;
  readonly cols: number;
  readonly rows: number;
  /** Dense term-wasm-compatible `(lo, hi)` u32 pairs, transferred once. */
  readonly rowHashes: ArrayBuffer;
}

/** This client's geometry authority: vacant, owner or observer. */
export interface ClientGeometry extends PeerPublication {
  readonly kind: 'client_geometry';
  readonly status: 0 | 1 | 2;
}

export interface ClientGraphicsClock extends PeerPublication {
  readonly kind: 'client_graphics_clock';
  readonly monotonicUs: bigint;
  readonly rttMs: number;
}

export interface ClientGraphicsAsset extends PeerPublication {
  readonly kind: 'client_graphics_asset';
  readonly epoch: number;
  readonly asset: number;
  readonly key: string;
  readonly bytes: Uint8Array;
}

/** The delivered asset's credit returns; `taken` is false for one dropped as stale. */
export interface ClientGraphicsConsumed extends PeerPublication {
  readonly kind: 'client_graphics_consumed';
  readonly key: string;
  readonly taken: boolean;
}

export interface ClientLinkDefinitions extends PeerPublication {
  readonly kind: 'client_link_definitions';
  readonly entries: readonly DisplayLinkDefinition[];
  readonly reset: boolean;
}

export type TransportToTerminalPeer =
  | ClientGeometry
  | ClientGraphicsClock
  | ClientGraphicsAsset
  | PerfGridConvergenceResponseEdge;

/**
 * What the terminal worker posts on the peer port. What its viewer asks the
 * session to send is not here: those cross on the viewer-output ring.
 */
export type TerminalToTransportPeer =
  | ClientGraphicsConsumed
  | ClientLinkDefinitions
  | PerfGridConvergenceRequestEdge;
