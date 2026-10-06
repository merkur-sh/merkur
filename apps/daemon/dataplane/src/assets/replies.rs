//! Bounded, generation-owned CTRL refusals. Capacity is acquired by a task;
//! encryption and publication remain synchronous on the terminal owner. A reply
//! outlives the carriers it waits on: it is parked while no live interactive
//! tunnel exists and started again when its carrier retires before publication.

use super::*;
use crate::network::peer::ReliablePayload;
use tokio::sync::mpsc;

enum Permit {
    Edge(crate::edge_tunnel::ReliablePermit),
    Direct(mpsc::OwnedPermit<ReliablePayload>),
}

struct Ready {
    carrier: Carrier,
    permit: Permit,
}

struct Task {
    cancel: Option<oneshot::Sender<()>>,
    result: oneshot::Receiver<Option<Ready>>,
}

pub(super) struct Reply {
    pub(super) id: u64,
    via: PeerTransport,
    retry: Option<PeerTransport>,
    /// None while parked: no live interactive tunnel can carry it yet.
    task: Option<Task>,
}

impl Carrier {
    pub(crate) fn is_live(&self) -> bool {
        !self.connection.is_closed()
            && self.counterpart.as_ref().is_none_or(|(state, expected)| {
                *state.borrow()
                    == (CounterpartState::Attached {
                        attachment_id: *expected,
                    })
            })
    }
}

pub(super) fn reap(peer: &mut PeerDisplayState) {
    for index in 0..CONTENT_MAX_TRANSFERS as usize {
        let authenticated = peer.authenticated;
        let Some(requests) = &mut peer.graphics_requests else {
            return;
        };
        let Some(reply) = &mut requests.replies[index] else {
            continue;
        };
        let Some(task) = &mut reply.task else {
            continue;
        };
        let ready = match task.result.try_recv() {
            Ok(ready) => ready,
            Err(oneshot::error::TryRecvError::Empty) => continue,
            Err(oneshot::error::TryRecvError::Closed) => None,
        };
        reply.task = None;
        let (id, via) = (reply.id, reply.via);
        if let Some(retry) = reply.retry.take() {
            reply.via = retry;
            drop(ready);
            start(peer, index);
            continue;
        }
        if !authenticated {
            requests.replies[index] = None;
            continue;
        }
        let Some(Ready { carrier, permit }) = ready.filter(|ready| ready.carrier.is_live()) else {
            match via {
                // Its carrier retired before publication, or its tunnel closed.
                // The browser may still be waiting on this exact reply.
                PeerTransport::Edge => start(peer, index),
                // A lost direct path makes the browser re-send its cancels.
                PeerTransport::WebTransport => requests.replies[index] = None,
            }
            continue;
        };
        requests.replies[index] = None;
        drop(carrier);
        let frame = encode_proto_frame(MSG_TYPE_GRAPHICS_UNAVAILABLE, &id.to_be_bytes());
        let Some(sealed) = peer.seal_stream(CHANNEL_CTRL, &frame) else {
            continue;
        };
        let payload = ReliablePayload::Heap(sealed);
        match permit {
            Permit::Edge(permit) => permit.send(payload),
            Permit::Direct(permit) => {
                permit.send(payload);
            }
        }
    }
}

pub(super) fn enqueue(peer: &mut PeerDisplayState, id: u64, via: PeerTransport) {
    let requests = requests(peer);
    if let Some(index) = requests
        .replies
        .iter()
        .position(|reply| reply.as_ref().is_some_and(|reply| reply.id == id))
    {
        let Some(reply) = requests.replies[index].as_mut() else {
            return;
        };
        match &mut reply.task {
            // Coalesce carrier replacement without releasing admission until the
            // displaced task physically returns its reservations. Repeated CANCEL
            // cannot multiply tasks while the executor has not polled retirement.
            Some(task) => {
                reply.retry = Some(via);
                task.cancel.take();
            }
            None => {
                reply.via = via;
                start(peer, index);
            }
        }
        return;
    }
    let Some(index) = requests.replies.iter().position(Option::is_none) else {
        return;
    };
    requests.replies[index] = Some(Reply {
        id,
        via,
        retry: None,
        task: None,
    });
    start(peer, index);
}

/// Replies parked for want of an interactive tunnel start on the one just linked.
pub(super) fn edge_ready(peer: &mut PeerDisplayState) {
    for index in 0..CONTENT_MAX_TRANSFERS as usize {
        if peer
            .graphics_requests
            .as_ref()
            .and_then(|requests| requests.replies[index].as_ref())
            .is_some_and(|reply| reply.task.is_none() && reply.via == PeerTransport::Edge)
        {
            start(peer, index);
        }
    }
}

/// Give the parked reply at `index` a task on its carrier. An edge reply stays
/// parked while no live interactive tunnel exists. A direct reply with no direct
/// session is dropped: that path's loss makes the browser re-send its cancels
/// over the edge.
fn start(peer: &mut PeerDisplayState, index: usize) {
    let Some(via) = peer
        .graphics_requests
        .as_ref()
        .and_then(|requests| requests.replies[index].as_ref())
        .filter(|reply| reply.task.is_none())
        .map(|reply| reply.via)
    else {
        return;
    };
    // No sealing here: a full queue must not burn a counter and let later CTRL
    // records overtake an unsent ciphertext.
    let bytes = encode_proto_frame(MSG_TYPE_GRAPHICS_UNAVAILABLE, &0u64.to_be_bytes()).len()
        + crate::e2e::FRAME_OVERHEAD;
    let task: std::pin::Pin<Box<dyn std::future::Future<Output = Option<Ready>> + Send>> = match via
    {
        PeerTransport::Edge => {
            // Retirements use the interactive CTRL carrier, independently of
            // the bulk carrier selected for image/display payloads.
            let Some(tunnel) = peer.edge_tunnel.clone().filter(|tunnel| tunnel.can_pair()) else {
                return;
            };
            Box::pin(async move {
                // A cancel can arrive on a new pairing before the edge's report
                // of it. Wait for that exact pairing; the report is the signal.
                let mut counterpart = tunnel.counterpart_changes();
                let mut carrier = loop {
                    if let Some(carrier) = tunnel.content_carrier().filter(Carrier::is_live) {
                        break carrier;
                    }
                    counterpart.changed().await.ok()?;
                };
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
            let session = peer
                .direct_session
                .as_ref()
                .and_then(crate::webtransport::DirectSession::control_reply_sender);
            let Some((connection, sender)) = session else {
                requests(peer).replies[index] = None;
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
    // Only this owner can mutate the peer across the carrier read above.
    let Some(reply) = requests(peer).replies[index].as_mut() else {
        return;
    };
    reply.task = Some(Task {
        cancel: Some(cancel),
        result: received,
    });
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

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn repeated_cancellation_coalesces_without_refunding_a_live_waiter() {
        let mut peer = PeerDisplayState::new(Arc::from("graphics-peer"), PeerTransport::Edge);
        let mut requests = Requests::new();
        let (cancel, mut cancelled) = oneshot::channel();
        let (result, received) = oneshot::channel();
        requests.replies[0] = Some(Reply {
            id: 7,
            via: PeerTransport::Edge,
            retry: None,
            task: Some(Task {
                cancel: Some(cancel),
                result: received,
            }),
        });
        peer.graphics_requests = Some(Box::new(requests));
        for _ in 0..100 {
            enqueue(&mut peer, 7, PeerTransport::WebTransport);
        }
        assert!(matches!(
            cancelled.try_recv(),
            Err(oneshot::error::TryRecvError::Closed)
        ));
        assert!(
            !result.is_closed(),
            "retirement receiver still owns the task"
        );
        let requests = peer.graphics_requests.as_ref().unwrap();
        assert_eq!(requests.replies.iter().flatten().count(), 1);
        assert_eq!(
            requests.replies[0].as_ref().unwrap().retry,
            Some(PeerTransport::WebTransport)
        );
        reap(&mut peer);
        assert!(peer.graphics_requests.as_ref().unwrap().replies[0].is_some());
        assert!(result.send(None).is_ok());
        reap(&mut peer);
        // No replacement direct session exists in this fixture. Its physically
        // retired predecessor no longer retains queue or task admission.
        assert!(peer.graphics_requests.as_ref().unwrap().replies[0].is_none());
    }

    #[tokio::test]
    async fn an_edge_reply_without_a_tunnel_parks_and_coalesces() {
        let mut peer = PeerDisplayState::new(Arc::from("graphics-peer"), PeerTransport::Edge);
        peer.authenticated = true;
        for _ in 0..3 {
            enqueue(&mut peer, 9, PeerTransport::Edge);
        }
        let requests = peer.graphics_requests.as_ref().unwrap();
        let parked: Vec<_> = requests.replies.iter().flatten().collect();
        assert_eq!(parked.len(), 1);
        assert_eq!(parked[0].id, 9);
        assert!(
            parked[0].task.is_none(),
            "no interactive tunnel can carry it"
        );
        reap(&mut peer);
        edge_ready(&mut peer);
        let requests = peer.graphics_requests.as_ref().unwrap();
        assert_eq!(
            requests.replies.iter().flatten().count(),
            1,
            "never dropped"
        );
    }
}
