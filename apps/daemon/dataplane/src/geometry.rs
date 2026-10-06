//! Explicit attachment ownership of the shared PTY's logical geometry.
//! Transport replacement does not transfer ownership. Only an authenticated
//! claim changes it; every resize names the exact grant that authorized it.

use std::sync::Arc;
use tokio::sync::{mpsc, oneshot};

use crate::assets::Carrier;
use crate::connection::{PeerDisplayState, PeerMap, PeerTransport};
use crate::network::peer::{DeliveryMode, PeerMessage, ReliablePayload};
use crate::network::protocol::{CHANNEL_CTRL, MSG_TYPE_GEOMETRY_STATE, encode_proto_frame};

#[derive(Default)]
pub(crate) struct Authority {
    generation: u64,
    owner: Option<(Arc<str>, String)>,
}

impl Authority {
    fn owns(&self, peer: &PeerDisplayState) -> bool {
        peer.authenticated
            && self.owner.as_ref().is_some_and(|(id, delegation)| {
                id == &peer.peer_id && delegation == &peer.delegation_id
            })
    }

    pub(crate) fn permits(&self, peer: &PeerDisplayState, generation: u64) -> bool {
        generation != 0 && generation == self.generation && self.owns(peer)
    }

    pub(crate) fn claim(&mut self, peer: &PeerDisplayState, action: u8, expected: u64) -> bool {
        if !peer.authenticated || self.owns(peer) {
            return false;
        }
        if !((action == 1 && self.owner.is_none()) || (action == 2 && expected == self.generation))
        {
            return false;
        }
        let Some(next) = self.generation.checked_add(1) else {
            return false;
        };
        self.generation = next;
        self.owner = Some((Arc::clone(&peer.peer_id), peer.delegation_id.clone()));
        true
    }

    pub(crate) fn release(&mut self, peer: &PeerDisplayState) -> bool {
        if !self.owns(peer) {
            return false;
        }
        // At exhaustion remain permanently vacant: no generation is reused.
        self.generation = self.generation.saturating_add(1);
        self.owner = None;
        true
    }

    fn state(&self, peer: &PeerDisplayState) -> [u8; 13] {
        let mut body = [0; 13];
        body[0] = if self.owner.is_none() {
            0
        } else if self.owns(peer) {
            1
        } else {
            2
        };
        body[1..9].copy_from_slice(&self.generation.to_be_bytes());
        if self.owns(peer) {
            body[9..13].copy_from_slice(&peer.last_resize_seq.to_be_bytes());
        }
        body
    }
}

enum Permit {
    Edge(crate::edge_tunnel::ReliablePermit),
    Direct(mpsc::OwnedPermit<ReliablePayload>),
}

struct Ready {
    carrier: Carrier,
    permit: Permit,
}

/// One capacity waiter per attachment, coalescing to the latest state. No image
/// resources, timer, or work on the input/display path are initialized here.
pub(crate) struct Reply {
    body: [u8; 13],
    via: PeerTransport,
    retry: Option<PeerTransport>,
    cancel: Option<oneshot::Sender<()>>,
    result: Option<oneshot::Receiver<Option<Ready>>>,
}

struct Wake;
impl Drop for Wake {
    fn drop(&mut self) {
        crate::assets::COMPLETED.notify_one();
    }
}

fn enqueue(peer: &mut PeerDisplayState, body: [u8; 13], via: PeerTransport) {
    if let Some(reply) = &mut peer.geometry_reply {
        reply.body = body;
        if reply.result.is_none() {
            reply.via = via;
        } else if reply.via != via || reply.retry.is_some() {
            reply.retry = Some(via);
            reply.cancel.take();
        }
    } else {
        peer.geometry_reply = Some(Box::new(Reply {
            body,
            via,
            retry: None,
            cancel: None,
            result: None,
        }));
    }
    start(peer);
}

/// A claim may overtake the DATA attachment rendezvous. Keep its unsealed reply
/// until that exact return path becomes usable; no timer or Noise nonce is spent.
pub(crate) fn edge_ready(peer: &mut PeerDisplayState) {
    if peer
        .geometry_reply
        .as_ref()
        .is_some_and(|reply| reply.via == PeerTransport::Edge)
    {
        start(peer);
    }
}

fn start(peer: &mut PeerDisplayState) {
    let Some(reply) = &peer.geometry_reply else {
        return;
    };
    if reply.result.is_some() {
        return;
    }
    let via = reply.via;
    let bytes = 4 + 13 + crate::e2e::FRAME_OVERHEAD;
    let task: std::pin::Pin<Box<dyn std::future::Future<Output = Option<Ready>> + Send>> = match via
    {
        PeerTransport::Edge => {
            let Some(tunnel) = peer.edge_tunnel.clone() else {
                return;
            };
            let Some(mut carrier) = tunnel.content_carrier() else {
                return;
            };
            Box::pin(async move {
                let permit = tokio::select! {
                    biased;
                    _ = carrier.retired() => return None,
                    permit = tunnel.reserve_control_reply(bytes) => permit?,
                };
                Some(Ready {
                    carrier,
                    permit: Permit::Edge(permit),
                })
            })
        }
        PeerTransport::WebTransport => {
            let Some((connection, sender)) = peer
                .direct_session
                .as_ref()
                .and_then(crate::webtransport::DirectSession::control_reply_sender)
            else {
                return;
            };
            Box::pin(async move {
                let mut carrier = Carrier {
                    connection,
                    counterpart: None,
                };
                let permit = tokio::select! {
                    biased;
                    _ = carrier.retired() => return None,
                    permit = sender.reserve_owned() => permit.ok()?,
                };
                Some(Ready {
                    carrier,
                    permit: Permit::Direct(permit),
                })
            })
        }
    };
    let (cancel, cancelled) = oneshot::channel();
    let (result, received) = oneshot::channel();
    let reply = peer
        .geometry_reply
        .as_mut()
        .expect("retained geometry reply");
    reply.cancel = Some(cancel);
    reply.result = Some(received);
    tokio::spawn(async move {
        let _wake = Wake;
        let ready = tokio::select! {
            biased;
            _ = cancelled => None,
            ready = task => ready,
        };
        let _ = result.send(ready);
    });
}

pub(crate) fn reap(peer: &mut PeerDisplayState) {
    let Some(reply) = &mut peer.geometry_reply else {
        return;
    };
    let Some(result) = &mut reply.result else {
        return;
    };
    let ready = match result.try_recv() {
        Ok(ready) => ready,
        Err(oneshot::error::TryRecvError::Empty) => return,
        Err(oneshot::error::TryRecvError::Closed) => None,
    };
    let reply = peer.geometry_reply.take().expect("owned geometry reply");
    if let Some(via) = reply.retry {
        drop(ready);
        enqueue(peer, reply.body, via);
        return;
    }
    let Some(Ready { carrier, permit }) = ready else {
        return;
    };
    if !peer.authenticated || !carrier.is_live() {
        return;
    }
    // Capacity and carrier are concrete before this owner's Noise counter moves.
    let frame = encode_proto_frame(MSG_TYPE_GEOMETRY_STATE, &reply.body);
    let Some(sealed) = peer.seal_stream(CHANNEL_CTRL, &frame) else {
        return;
    };
    let payload = ReliablePayload::Heap(sealed);
    match permit {
        Permit::Edge(permit) => permit.send(payload),
        Permit::Direct(permit) => {
            permit.send(payload);
        }
    }
}

pub(crate) fn publish(authority: &Authority, peers: &mut PeerMap, now_ms: f64) {
    for peer in peers.values_mut().filter(|peer| peer.authenticated) {
        let body = authority.state(peer);
        let via = peer.primary_path(now_ms);
        enqueue(peer, body, via);
    }
}

pub(crate) fn handle(
    msg: &PeerMessage,
    body: &[u8],
    pty_master: &(dyn portable_pty::MasterPty + Send),
    terminal: &mut crate::pty::TerminalState,
    peers: &mut PeerMap,
    now_ms: f64,
) {
    if msg.delivery != DeliveryMode::Stream || body.len() != 25 || body[0] > 2 {
        return;
    }
    let mut viewport = [0; 24];
    viewport[..16].copy_from_slice(&body[9..25]);
    let has_viewport = viewport[..16].iter().any(|byte| *byte != 0);
    // Validate the entire compound command before transferring any authority.
    viewport[16..].copy_from_slice(&1u64.to_be_bytes());
    if has_viewport && (body[0] == 0 || crate::pty::Viewport::decode(&viewport).is_none()) {
        return;
    }
    let Some(peer) = peers
        .get_mut(&*msg.peer_node_id)
        .filter(|peer| peer.authenticated)
    else {
        return;
    };
    let expected = u64::from_be_bytes(body[1..9].try_into().expect("checked geometry claim"));
    let authority = &mut terminal.geometry_authority;
    let changed = authority.claim(peer, body[0], expected);
    if changed {
        peer.last_resize_seq = 0;
    }
    let owns = authority.owns(peer);
    viewport[16..].copy_from_slice(&authority.generation.to_be_bytes());
    if owns && has_viewport {
        // Grant and first resize commit in one owner turn, without a round trip
        // or a second resize after the grant acknowledgement reaches the browser.
        crate::handle_resize_request(&msg.peer_node_id, &viewport, pty_master, terminal, peers);
    }
    if changed {
        publish(&terminal.geometry_authority, peers, now_ms);
    } else if let Some(peer) = peers.get_mut(&*msg.peer_node_id) {
        enqueue(
            peer,
            terminal.geometry_authority.state(peer),
            msg.via_transport,
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn peer(name: &str) -> PeerDisplayState {
        let mut peer = PeerDisplayState::new(name.into(), PeerTransport::Edge);
        peer.authenticated = true;
        peer.delegation_id = "delegation".into();
        peer
    }

    #[tokio::test]
    async fn reply_survives_a_claim_that_overtakes_its_data_rendezvous() {
        let mut peer = peer("early");
        enqueue(&mut peer, [1; 13], PeerTransport::Edge);
        let reply = peer.geometry_reply.as_ref().unwrap();
        assert_eq!(reply.body, [1; 13]);
        assert!(reply.result.is_none());
        assert!(reply.cancel.is_none());
        // Superseding authority is retained in the same bounded slot while no
        // concrete carrier exists. A premature readiness event cannot lose it.
        enqueue(&mut peer, [2; 13], PeerTransport::Edge);
        edge_ready(&mut peer);
        reap(&mut peer);
        let reply = peer.geometry_reply.as_ref().unwrap();
        assert_eq!(reply.body, [2; 13]);
        assert!(reply.result.is_none());
    }

    #[tokio::test]
    async fn compound_claim_commits_the_first_resize_atomically_and_refuses_observers() {
        let pair = portable_pty::native_pty_system()
            .openpty(portable_pty::PtySize::default())
            .unwrap();
        let (tx, _rx) = crossbeam_channel::unbounded();
        let mut terminal = crate::pty::TerminalState::new(80, 24, tx);
        let mut peers = PeerMap::from([("a".into(), peer("a")), ("b".into(), peer("b"))]);
        let mut body = [0; 25];
        body[0] = 1;
        body[9..11].copy_from_slice(&120u16.to_be_bytes());
        body[11..13].copy_from_slice(&48u16.to_be_bytes());
        body[13..17].copy_from_slice(&7u32.to_be_bytes());
        body[17..21].copy_from_slice(&(8u32 << 16).to_be_bytes());
        body[21..25].copy_from_slice(&(16u32 << 16).to_be_bytes());
        let mut msg = PeerMessage {
            input_permit: None,
            peer_node_id: "a".into(),
            channel_id: CHANNEL_CTRL,
            payload: bytes::Bytes::new(),
            via_transport: PeerTransport::Edge,
            delivery: DeliveryMode::Datagram,
            connection_id: 0,
            edge_ingress: None,
        };
        handle(&msg, &body, &*pair.master, &mut terminal, &mut peers, 0.0);
        assert_eq!(terminal.geometry_authority.generation, 0);
        msg.delivery = DeliveryMode::Stream;
        handle(&msg, &body, &*pair.master, &mut terminal, &mut peers, 0.0);
        assert_eq!((terminal.cols, terminal.rows), (120, 48));
        assert_eq!(pair.master.get_size().unwrap().pixel_width, 960);
        assert_eq!(peers["a"].last_resize_seq, 7);
        assert_eq!(
            terminal.geometry_authority.state(&peers["a"]),
            [1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 7]
        );
        // Reauthentication repeats the viewport with a fresh intent. It must
        // advance the acknowledgement without resetting display/prediction state.
        let revision = terminal.display_revision();
        for peer in peers.values_mut() {
            peer.needs_snapshot = false;
            peer.needs_full_diff = false;
        }
        body[13..17].copy_from_slice(&8u32.to_be_bytes());
        handle(&msg, &body, &*pair.master, &mut terminal, &mut peers, 0.0);
        assert_eq!(peers["a"].last_resize_seq, 8);
        assert_eq!(terminal.display_revision(), revision);
        assert!(
            peers
                .values()
                .all(|peer| !peer.needs_snapshot && !peer.needs_full_diff)
        );
        msg.peer_node_id = "b".into();
        body[9..11].copy_from_slice(&60u16.to_be_bytes());
        handle(&msg, &body, &*pair.master, &mut terminal, &mut peers, 0.0);
        assert_eq!(terminal.cols, 120);
        assert_eq!(peers["b"].last_resize_seq, 0);
        body[0] = 2;
        body[1..9].copy_from_slice(&1u64.to_be_bytes());
        // Even an otherwise authorized takeover cannot partially commit a
        // malformed viewport (or consume the compare-and-swap generation).
        body[17..21].fill(0);
        handle(&msg, &body, &*pair.master, &mut terminal, &mut peers, 0.0);
        assert_eq!(terminal.geometry_authority.generation, 1);
        body[17..21].copy_from_slice(&(8u32 << 16).to_be_bytes());
        handle(&msg, &body, &*pair.master, &mut terminal, &mut peers, 0.0);
        assert_eq!(terminal.geometry_authority.generation, 2);
        assert_eq!(terminal.cols, 60);
        assert_eq!(pair.master.get_size().unwrap().pixel_width, 480);
        let mut delayed = [0; 24];
        delayed[..16].copy_from_slice(&body[9..]);
        delayed[4..8].copy_from_slice(&9u32.to_be_bytes());
        delayed[16..].copy_from_slice(&1u64.to_be_bytes());
        delayed[..2].copy_from_slice(&100u16.to_be_bytes());
        crate::handle_resize_request("a", &delayed, &*pair.master, &mut terminal, &mut peers);
        assert_eq!(terminal.cols, 60);
        assert_eq!(peers["a"].last_resize_seq, 8);
    }

    #[tokio::test]
    async fn a_claim_without_cell_pixels_resizes_the_grid_and_states_no_pixel_extent() {
        let pair = portable_pty::native_pty_system()
            .openpty(portable_pty::PtySize::default())
            .unwrap();
        let (tx, _rx) = crossbeam_channel::unbounded();
        let mut terminal = crate::pty::TerminalState::new(80, 24, tx);
        let mut peers = PeerMap::from([("a".into(), peer("a"))]);
        let mut body = [0; 25];
        body[0] = 1;
        body[9..11].copy_from_slice(&100u16.to_be_bytes());
        body[11..13].copy_from_slice(&30u16.to_be_bytes());
        body[13..17].copy_from_slice(&1u32.to_be_bytes());
        let msg = PeerMessage {
            input_permit: None,
            peer_node_id: "a".into(),
            channel_id: CHANNEL_CTRL,
            payload: bytes::Bytes::new(),
            via_transport: PeerTransport::Edge,
            delivery: DeliveryMode::Stream,
            connection_id: 0,
            edge_ingress: None,
        };
        handle(&msg, &body, &*pair.master, &mut terminal, &mut peers, 0.0);
        assert_eq!((terminal.cols, terminal.rows), (100, 30));
        let size = pair.master.get_size().unwrap();
        assert_eq!((size.cols, size.rows), (100, 30));
        assert_eq!((size.pixel_width, size.pixel_height), (0, 0));
        assert_eq!(peers["a"].last_resize_seq, 1);
        // One metric alone is malformed: the claim commits nothing.
        body[0] = 2;
        body[1..9].copy_from_slice(&1u64.to_be_bytes());
        body[9..11].copy_from_slice(&60u16.to_be_bytes());
        body[13..17].copy_from_slice(&2u32.to_be_bytes());
        body[21..25].copy_from_slice(&(16u32 << 16).to_be_bytes());
        handle(&msg, &body, &*pair.master, &mut terminal, &mut peers, 0.0);
        assert_eq!(terminal.cols, 100);
        assert_eq!(peers["a"].last_resize_seq, 1);
    }

    #[tokio::test]
    async fn replacing_reply_carriers_retains_one_waiter_until_physical_retirement() {
        let mut peer = peer("a");
        let (cancel, mut cancelled) = oneshot::channel();
        let (result, received) = oneshot::channel();
        peer.geometry_reply = Some(Box::new(Reply {
            body: [0; 13],
            via: PeerTransport::Edge,
            retry: None,
            cancel: Some(cancel),
            result: Some(received),
        }));
        for generation in 1u64..100 {
            let mut body = [0; 13];
            body[1..9].copy_from_slice(&generation.to_be_bytes());
            enqueue(&mut peer, body, PeerTransport::WebTransport);
        }
        assert!(matches!(
            cancelled.try_recv(),
            Err(oneshot::error::TryRecvError::Closed)
        ));
        assert!(!result.is_closed());
        reap(&mut peer);
        let reply = peer.geometry_reply.as_ref().unwrap();
        assert_eq!(&reply.body[1..9], &99u64.to_be_bytes());
        assert_eq!(reply.retry, Some(PeerTransport::WebTransport));
        assert!(result.send(None).is_ok());
        reap(&mut peer);
        let reply = peer.geometry_reply.as_ref().unwrap();
        assert!(reply.result.is_none());
        assert!(reply.cancel.is_none());
        assert_eq!(reply.via, PeerTransport::WebTransport);
        assert_eq!(&reply.body[1..9], &99u64.to_be_bytes());
    }

    #[test]
    fn claims_are_explicit_and_old_grants_never_authorize_resizes() {
        let mut authority = Authority::default();
        let a = peer("a");
        let b = peer("b");
        assert!(!authority.permits(&a, 1));
        assert!(!authority.claim(&a, 0, 0));
        assert!(authority.claim(&a, 1, 0));
        assert!(authority.permits(&a, 1));
        assert!(!authority.claim(&b, 1, 0));
        assert!(!authority.claim(&b, 2, 0));
        assert!(authority.claim(&b, 2, 1));
        assert!(!authority.permits(&a, 1));
        assert!(!authority.permits(&a, 2));
        assert!(authority.permits(&b, 2));
        assert!(authority.claim(&a, 2, 2));
        assert!(!authority.permits(&a, 1));
        assert!(authority.permits(&a, 3));
    }

    #[test]
    fn identity_includes_authenticated_delegation_and_survives_carrier_replacement() {
        let mut authority = Authority::default();
        let mut a = peer("a");
        assert!(authority.claim(&a, 1, 0));
        a.authenticated = false;
        assert!(!authority.permits(&a, 1));
        assert!(!authority.release(&a));
        a.authenticated = true;
        a.delegation_id = "other".into();
        assert!(!authority.permits(&a, 1));
        a.delegation_id = "delegation".into();
        assert!(authority.permits(&a, 1));
        assert!(authority.release(&a));
        assert!(authority.claim(&a, 1, 0));
        assert!(authority.permits(&a, 3));
        assert!(!authority.permits(&a, 1));
        authority.generation = u64::MAX;
        authority.release(&a);
        assert!(!authority.claim(&a, 1, 0));
    }
}
