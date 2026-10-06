pub mod path_watch;
pub mod peer;

/// The wire a client and this dataplane share, one implementation for both.
pub use merkur_wire::{input_record, protocol};

#[cfg(test)]
mod daemon_io_profile;

use std::collections::HashMap;
use std::sync::Arc;

use tokio::sync::RwLock;

use self::peer::ReliablePayload;
use self::protocol::{CHANNEL_SIGNALING, EdgeLane};
use crate::edge_tunnel::EdgeTunnel;

/// Browser-facing transport registry.
///
/// Daemon control is owned by the TypeScript runtime's authenticated WebSocket.
/// The Rust dataplane retains only edge-relayed and direct WebTransport state.
pub struct NetworkState {
    /// Bootstrap-only connections. Display can never consume their queue or cwnd.
    pub edge_signaling: HashMap<String, Arc<EdgeTunnel>>,
    /// Per-session interactive edge tunnels keyed by canonical browser peer id.
    pub edge_interactive: HashMap<String, Arc<EdgeTunnel>>,
    /// Per-session bulk edge tunnels keyed by the same browser peer id.
    pub edge_bulk: HashMap<String, Arc<EdgeTunnel>>,
}

impl NetworkState {
    pub fn new() -> Self {
        Self {
            edge_signaling: HashMap::new(),
            edge_interactive: HashMap::new(),
            edge_bulk: HashMap::new(),
        }
    }
}

/// The proven address of the browser attachment paired with `peer_id`'s
/// signaling tunnel, as the edge reported it; `None` before the edge has.
pub async fn signaling_browser_address(
    state: &Arc<RwLock<NetworkState>>,
    peer_id: &str,
) -> Option<std::net::IpAddr> {
    state
        .read()
        .await
        .edge_signaling
        .get(peer_id)
        .and_then(|tunnel| tunnel.browser_address())
}

pub async fn register_edge_signaling(
    state: &Arc<RwLock<NetworkState>>,
    peer_id: &str,
    tunnel: Arc<EdgeTunnel>,
) -> Option<Arc<EdgeTunnel>> {
    state
        .write()
        .await
        .edge_signaling
        .insert(peer_id.to_string(), tunnel)
}

pub async fn register_edge_interactive(
    state: &Arc<RwLock<NetworkState>>,
    peer_id: &str,
    tunnel: Arc<EdgeTunnel>,
) -> Option<Arc<EdgeTunnel>> {
    let mut state = state.write().await;
    state.edge_interactive.insert(peer_id.to_string(), tunnel)
}

/// Register the completed per-session bulk edge tunnel under the browser peer id.
pub async fn register_edge_bulk(
    state: &Arc<RwLock<NetworkState>>,
    peer_id: &str,
    tunnel: Arc<EdgeTunnel>,
) -> Option<Arc<EdgeTunnel>> {
    let mut state = state.write().await;
    state.edge_bulk.insert(peer_id.to_string(), tunnel)
}

/// Drop all three edge connections for a peer.
pub async fn remove_edge_connections(state: &Arc<RwLock<NetworkState>>, peer_id: &str) {
    let (signaling, interactive, bulk) = {
        let mut state = state.write().await;
        (
            state.edge_signaling.remove(peer_id),
            state.edge_interactive.remove(peer_id),
            state.edge_bulk.remove(peer_id),
        )
    };
    if let Some(tunnel) = signaling {
        tunnel.close();
    }
    if let Some(tunnel) = interactive {
        tunnel.close();
    }
    if let Some(tunnel) = bulk {
        tunnel.close();
    }
}

/// Remove only the edge lanes owned by a terminally cancelled dial generation.
pub async fn remove_edge_lanes(
    state: &Arc<RwLock<NetworkState>>,
    peer_id: &str,
    signaling: bool,
    interactive: bool,
    bulk: bool,
) {
    let (signaling_tunnel, interactive_tunnel, bulk_tunnel) = {
        let mut state = state.write().await;
        (
            signaling
                .then(|| state.edge_signaling.remove(peer_id))
                .flatten(),
            interactive
                .then(|| state.edge_interactive.remove(peer_id))
                .flatten(),
            bulk.then(|| state.edge_bulk.remove(peer_id)).flatten(),
        )
    };
    if let Some(tunnel) = signaling_tunnel {
        tunnel.close();
    }
    if let Some(tunnel) = interactive_tunnel {
        tunnel.close();
    }
    if let Some(tunnel) = bulk_tunnel {
        tunnel.close();
    }
}

/// Remove one edge lane only when the registry still owns `expected`.
pub async fn remove_edge_lane_if_current(
    state: &Arc<RwLock<NetworkState>>,
    peer_id: &str,
    lane: EdgeLane,
    expected: &Arc<EdgeTunnel>,
) -> bool {
    let removed = {
        let mut state = state.write().await;
        let lanes = match lane {
            EdgeLane::Signaling => &mut state.edge_signaling,
            EdgeLane::Interactive => &mut state.edge_interactive,
            EdgeLane::Bulk => &mut state.edge_bulk,
        };
        if lanes
            .get(peer_id)
            .is_some_and(|current| Arc::ptr_eq(current, expected))
        {
            lanes.remove(peer_id)
        } else {
            None
        }
    };
    if let Some(tunnel) = removed {
        tunnel.close();
        true
    } else {
        false
    }
}

/// Close and detach every edge lane during dataplane shutdown.
pub async fn remove_all_edge_connections(state: &Arc<RwLock<NetworkState>>) {
    let tunnels = {
        let mut state = state.write().await;
        let mut tunnels = state
            .edge_interactive
            .drain()
            .map(|(_, tunnel)| tunnel)
            .collect::<Vec<_>>();
        tunnels.extend(state.edge_bulk.drain().map(|(_, tunnel)| tunnel));
        tunnels.extend(state.edge_signaling.drain().map(|(_, tunnel)| tunnel));
        tunnels
    };
    for tunnel in tunnels {
        tunnel.close();
    }
}

/// Send plaintext signaling to a browser over its reliable edge lane.
pub async fn send_signaling_to_peer(
    state: &Arc<RwLock<NetworkState>>,
    peer_id: &str,
    payload: Vec<u8>,
) -> bool {
    let tunnel = {
        let state = state.read().await;
        state.edge_signaling.get(peer_id).cloned()
    };
    match tunnel {
        Some(tunnel) => tunnel
            .send_reliable(CHANNEL_SIGNALING, ReliablePayload::Heap(payload))
            .is_ok(),
        None => false,
    }
}

pub enum PeerEvent {
    Disconnected {
        peer_id: String,
        connection_id: u64,
        reason: String,
    },
    WebTransportSession {
        temp_peer_id: String,
        connection_id: u64,
    },
    Datagram {
        /// Interned at connection setup, so the carrier task stamps each
        /// datagram with a refcount bump rather than a fresh String.
        peer_id: std::sync::Arc<str>,
        connection_id: u64,
        /// The QUIC datagram exactly as the carrier delivered it, still
        /// `[channel_id || sealed]`. Held as `Bytes` so the owner loop can
        /// split the channel prefix off by refcount instead of copying the
        /// frame a second time.
        data: bytes::Bytes,
        via_transport: crate::connection::PeerTransport,
    },
}
