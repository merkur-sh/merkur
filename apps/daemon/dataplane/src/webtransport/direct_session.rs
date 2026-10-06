//! The direct carrier a peer owns.
//!
//! An upgrade proves a WebTransport session and routes it to the peer; the
//! peer then holds that session and its reliable-lane senders here. Every
//! peer-level direct send admits through this handle, synchronously: no
//! registry lock and no await on the input, ACK or display path. The registry
//! only supervises the session's lifecycle, and every event that retires a
//! session from it (rotation, disconnect, rebind, replacement) clears or
//! replaces the peer's handle in the same owner turn. A handle whose session
//! has closed refuses admission like any closed carrier.

use std::sync::Arc;

use tokio::sync::mpsc;

use crate::network::peer::{ChannelSenders, ReliablePayload, select_channel_sender};

pub struct DirectSession {
    carrier: Carrier,
}

enum Carrier {
    Live {
        connection: Arc<wtransport::Connection>,
        senders: ChannelSenders,
    },
    /// Stands in for a session without a QUIC pair: datagrams and reliable
    /// records reach the harness in the shapes the transport tests read.
    #[cfg(test)]
    Capture {
        peer_id: Arc<str>,
        datagrams: mpsc::UnboundedSender<(String, Vec<u8>)>,
        reliable: Option<mpsc::UnboundedSender<(u8, String, Vec<u8>)>>,
    },
}

impl DirectSession {
    pub(crate) fn new(connection: Arc<wtransport::Connection>, senders: ChannelSenders) -> Self {
        Self {
            carrier: Carrier::Live {
                connection,
                senders,
            },
        }
    }

    /// The QUIC session, for the planner's quotes and blocked-state reads.
    #[cfg_attr(
        not(test),
        expect(
            clippy::unnecessary_wraps,
            reason = "the test-only capture carrier has no QUIC session, and callers are shared"
        )
    )]
    pub(crate) fn connection(&self) -> Option<&Arc<wtransport::Connection>> {
        match &self.carrier {
            Carrier::Live { connection, .. } => Some(connection),
            #[cfg(test)]
            Carrier::Capture { .. } => None,
        }
    }

    /// Queue one immutable framed datagram; carriers share the allocation until
    /// packetization. WTransport performs the exact final-length check and the
    /// non-dropping Quinn enqueue together, so a refusal here is backpressure
    /// or a closed session, never a partial send.
    pub(crate) fn send_datagram_owned(&self, data: &bytes::Bytes) -> bool {
        match &self.carrier {
            Carrier::Live { connection, .. } => {
                connection.send_datagram_owned(data.clone()).is_ok()
            }
            #[cfg(test)]
            Carrier::Capture {
                peer_id, datagrams, ..
            } => datagrams.send((peer_id.to_string(), data.to_vec())).is_ok(),
        }
    }

    /// Enqueue one sealed reliable record on its channel's lane, returning it
    /// untouched on refusal so the caller can fail over without re-sealing. A
    /// lane's writer learns of a close only at its next write, so a closed
    /// session refuses here, before a record can queue behind a dead writer.
    pub(crate) fn try_send_reliable(
        &self,
        channel_id: u8,
        payload: ReliablePayload,
    ) -> Result<(), ReliablePayload> {
        match &self.carrier {
            Carrier::Live {
                connection,
                senders,
            } => match select_channel_sender(senders, channel_id) {
                Some(sender) if !connection.is_closed() => {
                    sender.try_send(payload).map_err(|error| error.into_inner())
                }
                _ => Err(payload),
            },
            #[cfg(test)]
            Carrier::Capture {
                peer_id, reliable, ..
            } => match reliable {
                Some(reliable) => reliable
                    .send((channel_id, peer_id.to_string(), payload.into_vec()))
                    .map_err(|error| ReliablePayload::Heap(error.0.2)),
                None => Err(payload),
            },
        }
    }

    /// The open session and its CTRL queue, for a reply that waits for
    /// capacity after the owner turn has moved on.
    pub(crate) fn control_reply_sender(
        &self,
    ) -> Option<(Arc<wtransport::Connection>, mpsc::Sender<ReliablePayload>)> {
        match &self.carrier {
            Carrier::Live {
                connection,
                senders,
            } => (!connection.is_closed()).then(|| (Arc::clone(connection), senders.ctrl.clone())),
            #[cfg(test)]
            Carrier::Capture { .. } => None,
        }
    }

    /// Keep the session's QUIC connection from building packets until the
    /// guard drops, so the datagrams and records admitted meanwhile share
    /// packets. `None` without a connection.
    pub(crate) fn hold_egress(&self) -> Option<wtransport::quinn::EgressHold> {
        self.connection().map(|connection| connection.hold_egress())
    }

    #[cfg(test)]
    pub(crate) fn new_capture(
        peer_id: Arc<str>,
        datagrams: mpsc::UnboundedSender<(String, Vec<u8>)>,
        reliable: Option<mpsc::UnboundedSender<(u8, String, Vec<u8>)>>,
    ) -> Self {
        Self {
            carrier: Carrier::Capture {
                peer_id,
                datagrams,
                reliable,
            },
        }
    }

    /// A live session whose reliable lanes have no writer: datagrams and
    /// quotes are real, reliable records are refused.
    #[cfg(test)]
    pub(crate) fn from_connection(connection: Arc<wtransport::Connection>) -> Self {
        let lane = || mpsc::channel(1).0;
        Self::new(
            connection,
            ChannelSenders {
                ctrl: lane(),
                pty: lane(),
                display_commit: lane(),
                signaling: None,
            },
        )
    }
}

/// A daemon and browser WebTransport session over loopback, for tests that
/// need a real direct carrier.
#[cfg(test)]
pub(crate) struct LoopbackPair {
    pub(crate) daemon: Arc<wtransport::Connection>,
    pub(crate) browser: wtransport::Connection,
    _endpoints: (
        wtransport::Endpoint<wtransport::endpoint::endpoint_side::Server>,
        wtransport::Endpoint<wtransport::endpoint::endpoint_side::Client>,
    ),
}

#[cfg(test)]
pub(crate) async fn loopback_pair() -> LoopbackPair {
    let (config, cert) = super::build_server_config(0).expect("server config");
    let server = wtransport::Endpoint::server(config).expect("server");
    let url = format!(
        "https://127.0.0.1:{}",
        server.local_addr().expect("addr").port()
    );
    let client = wtransport::Endpoint::client(
        wtransport::ClientConfig::builder()
            .with_bind_default()
            .with_server_certificate_hashes([wtransport::tls::Sha256Digest::new(cert.cert_hash)])
            .build(),
    )
    .expect("client");
    let (daemon, browser) = tokio::join!(
        async {
            server
                .accept()
                .await
                .await
                .expect("request")
                .accept()
                .await
                .expect("accept")
        },
        client.connect(&url)
    );
    LoopbackPair {
        daemon: Arc::new(daemon),
        browser: browser.expect("browser"),
        _endpoints: (server, client),
    }
}

/// Reliable lanes whose records a test reads back instead of a stream writer.
#[cfg(test)]
pub(crate) struct CapturedLanes {
    pub(crate) ctrl: mpsc::Receiver<ReliablePayload>,
    pub(crate) pty: mpsc::Receiver<ReliablePayload>,
    pub(crate) _display_commit: mpsc::Receiver<ReliablePayload>,
}

#[cfg(test)]
pub(crate) fn captured_lanes() -> (ChannelSenders, CapturedLanes) {
    let (ctrl, ctrl_rx) = mpsc::channel(8);
    let (pty, pty_rx) = mpsc::channel(8);
    let (display_commit, display_commit_rx) = mpsc::channel(8);
    (
        ChannelSenders {
            ctrl,
            pty,
            display_commit,
            signaling: None,
        },
        CapturedLanes {
            ctrl: ctrl_rx,
            pty: pty_rx,
            _display_commit: display_commit_rx,
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::connection::{PathHealth, PeerDisplayState, PeerTransport, SendIntent, SentPaths};
    use crate::network::protocol::{CHANNEL_CTRL, CHANNEL_DISPLAY_DATAGRAM};
    use crate::transport::{send_display_wire_with_intent, transport_send_reliable_with_fallback};

    /// A handle outlives its session until the owner retires it. Once the
    /// session closes, the handle refuses datagrams and reliable records alike,
    /// and each send falls back to the edge with its exact bytes, as a registry
    /// that had dropped the session would. Before the close the same sends ride
    /// the direct session.
    #[tokio::test]
    async fn a_closed_session_refuses_admission_and_the_send_falls_back_to_the_edge() {
        let pair = loopback_pair().await;
        let (senders, mut lanes) = captured_lanes();
        let (edge_tx, mut edge_rx) = mpsc::unbounded_channel();
        let mut peer = PeerDisplayState::new("closing-browser".into(), PeerTransport::WebTransport);
        peer.direct_session = Some(DirectSession::new(Arc::clone(&pair.daemon), senders));
        peer.edge_tunnel = Some(Arc::new(crate::edge_tunnel::EdgeTunnel::new_capture(
            edge_tx,
        )));
        peer.paths.edge = PathHealth::fresh_available(0.0);
        let wire = bytes::Bytes::from_static(&[CHANNEL_DISPLAY_DATAGRAM, 0, 0, 0, 0, 0, 0, 0, 7]);

        let direct = peer.direct_session.as_ref();
        let accepted = transport_send_reliable_with_fallback(
            &mut peer.paths,
            PeerTransport::WebTransport,
            CHANNEL_CTRL,
            ReliablePayload::Heap(vec![1, 2, 3]),
            direct,
            peer.edge_tunnel.as_ref(),
            100.0,
        );
        assert_eq!(accepted, Some(PeerTransport::WebTransport));
        assert_eq!(lanes.ctrl.try_recv().unwrap().into_vec(), vec![1, 2, 3]);
        assert_eq!(
            send_display_wire_with_intent(&mut peer, &wire, 100.0, SendIntent::SinglePath),
            SentPaths::single(PeerTransport::WebTransport)
        );
        assert!(edge_rx.try_recv().is_err());

        pair.daemon
            .close(wtransport::VarInt::from_u32(0), b"retired");
        assert!(pair.daemon.is_closed());
        let direct = peer.direct_session.as_ref();
        let accepted = transport_send_reliable_with_fallback(
            &mut peer.paths,
            PeerTransport::WebTransport,
            CHANNEL_CTRL,
            ReliablePayload::Heap(vec![4, 5, 6]),
            direct,
            peer.edge_tunnel.as_ref(),
            100.0,
        );
        assert_eq!(accepted, Some(PeerTransport::Edge));
        assert_eq!(edge_rx.try_recv().unwrap(), (CHANNEL_CTRL, vec![4, 5, 6]));
        assert!(
            lanes.ctrl.try_recv().is_err(),
            "no record queued behind the closed session's writer"
        );
        assert_eq!(
            send_display_wire_with_intent(&mut peer, &wire, 100.0, SendIntent::SinglePath),
            SentPaths::single(PeerTransport::Edge)
        );
        assert_eq!(
            edge_rx.try_recv().unwrap(),
            (CHANNEL_DISPLAY_DATAGRAM, wire[1..].to_vec())
        );
        assert!(
            peer.direct_session
                .as_ref()
                .and_then(DirectSession::control_reply_sender)
                .is_none(),
            "a closed session offers no reply lane"
        );
    }
}
