//! The edge relay's own contract: the routing preface every attachment opens
//! with, and the splice-control events the edge writes back on the reverse
//! direction of that stream.
//!
//! Both travel as `[u32 BE length][JSON]` records on the attachment's first
//! bidirectional stream. The edge reads the preface and writes the events; the
//! daemon and the client write the preface and read the events. They share
//! these types, so the three cannot disagree about a field.
//!
//! The edge treats the session id as an opaque routing label and derives no
//! trust from it: authentication and confidentiality are end to end, so a peer
//! that lies about a session id only reaches a counterpart that fails its Noise
//! handshake. Admission is the server-signed `ticket` for `daemon_id`, checked
//! before the peer reaches the splice registry. The relay is blind and
//! unauthenticated, so an event may only make a peer stop waiting sooner or
//! start waiting. It never makes a peer accept, admit, spend or discard
//! anything.

// The edge reads these records from peers it has not admitted, so a panic here
// is a remote denial of service: nothing in this crate may panic. `clippy.toml`
// switches the first four lints off inside tests; the other four hold in tests
// too, and a test that needs one carries an `#[expect]` with its reason.
#![deny(
    clippy::indexing_slicing,
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::unreachable,
    clippy::string_slice,
    clippy::unwrap_in_result,
    clippy::get_unwrap
)]

use std::net::IpAddr;

use serde::{Deserialize, Serialize};

/// Exact version of the preface envelope. A hard cut: the edge refuses any
/// other value, and a peer that does not know an event shape would lose every
/// later pairing signal on that stream, exactly when it needs them.
pub const PREFACE_VERSION: u16 = 8;
/// Bounds the memory a length prefix on the control stream can make a reader
/// allocate, in both directions.
pub const MAX_PREFACE_LEN: usize = 4096;
/// A dataplane process's incarnation: 16 random bytes it draws at start,
/// spelled in this many unpadded base64url characters. The edge compares it as
/// an opaque label.
pub const INCARNATION_CHARS: usize = 22;

/// The edge closes an attachment with this code and reason when the splice
/// registry replaced or detached its counterpart. Both must match: the edge
/// interprets no application payload, so only its own closes carry them.
pub const COUNTERPART_DETACHED_CLOSE_CODE: u32 = 0x4d01;
pub const COUNTERPART_DETACHED_CLOSE_REASON: &[u8] = b"counterpart-detached";
/// The edge closes an attachment with this code and reason when its relay
/// egress budget is spent. A client pauses its data attachments on it, as on
/// [`SpliceControlEvent::RelayDataPaused`]. Mirrored by `isEgressBudgetClose`.
pub const EGRESS_BUDGET_CLOSE_CODE: u32 = 0x4d03;
pub const EGRESS_BUDGET_CLOSE_REASON: &[u8] = b"egress-budget";
/// The edge closes an [`RoutingAttachment::Announce`] with this code and
/// reason once every slot an earlier incarnation of the announcing daemon held
/// is retired: the announcer's acknowledgement.
pub const INCARNATION_ANNOUNCED_CLOSE_CODE: u32 = 0x4d04;
pub const INCARNATION_ANNOUNCED_CLOSE_REASON: &[u8] = b"incarnation-announced";

/// Which end of a spliced session a connecting peer represents.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Role {
    /// A client: the browser, or the native client speaking as one.
    Browser,
    /// The daemon, holding a persistent outbound tunnel to the same edge.
    Daemon,
}

impl Role {
    /// The opposite end of the splice. A frame arriving from one role is
    /// forwarded to its peer role.
    pub fn peer(self) -> Self {
        match self {
            Self::Browser => Self::Daemon,
            Self::Daemon => Self::Browser,
        }
    }

    /// Stable, low-cardinality label for metric attributes.
    pub fn as_metric_label(self) -> &'static str {
        match self {
            Self::Browser => "browser",
            Self::Daemon => "daemon",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum RoutingAttachment {
    /// A client carrier that joins the splice.
    Primary,
    /// A client signaling attachment that proves a successor beside the
    /// incumbent and never joins the splice itself. `nonce` is base64url.
    Candidate { nonce: String },
    /// A daemon carrier that joins the splice, dialed by the dataplane process
    /// `incarnation` names ([`INCARNATION_CHARS`]). A carrier or announcement
    /// of another incarnation of the same daemon retires every slot this one
    /// holds: that process is gone, and so is every session it served.
    Tunnel { incarnation: String },
    /// A daemon process stating its incarnation at an edge before it holds a
    /// carrier there. The edge retires every slot another incarnation of the
    /// same daemon holds and closes the attachment with
    /// [`INCARNATION_ANNOUNCED_CLOSE_CODE`]. Its `session_id` is empty.
    Announce { incarnation: String },
}

/// The one record a peer writes before any data frame. Matching client and
/// daemon prefaces for one `session_id` are spliced together.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RoutingPreface {
    /// Opaque session routing label shared by exactly one client and one daemon.
    pub session_id: String,
    pub role: Role,
    pub version: u16,
    pub attachment: RoutingAttachment,
    /// The daemon this attachment serves: its own id for a daemon, the daemon
    /// the session was issued for from a client.
    pub daemon_id: String,
    /// Server-signed attach ticket, base64url.
    pub ticket: String,
}

impl RoutingPreface {
    /// The complete length-prefixed record.
    pub fn encode(&self) -> Vec<u8> {
        encode_record(self)
    }
}

/// The edge's pairing verdicts and relay state for one attachment, written on
/// the reverse direction of its preface stream. It names only pairing state,
/// never anything about the frames flowing through the splice.
///
/// The relay is blind and unauthenticated: anyone who knows the rendezvous id
/// can attach in either role. So a verdict may only make a peer stop waiting
/// sooner or start waiting; it never makes a peer accept, admit, spend or
/// discard anything. A `CounterpartAttached` may advance a request the client
/// was going to send anyway (the answer is still MAC-verified and the chaining
/// secret is spent only on commit), and a `CounterpartDetached` may start a
/// recovery the liveness path would have started later. None is authorization
/// or evidence of application delivery.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum SpliceControlEvent {
    /// Relay availability on signaling attachments, independent of counterpart
    /// presence: suspends data dialing, and `paused: false` resumes it without
    /// a peer timer.
    RelayDataPaused { paused: bool },
    /// Whether this peer's counterpart was already attached when this peer
    /// joined the slot. Written to the arriving peer, first and always: the
    /// other events describe transitions, so a peer arriving into a settled
    /// slot, as a client does on a carrier swap, learns its counterpart's
    /// presence only from this.
    CounterpartPresent {
        present: bool,
        counterpart_attachment_id: Option<u64>,
    },
    /// The counterpart attached; the splice is paired.
    CounterpartAttached { counterpart_attachment_id: u64 },
    /// Client only: a fresh empty stream's FIN to the daemon's attachment was
    /// acknowledged. Reachability evidence, never session authentication.
    CounterpartResponsive { counterpart_attachment_id: u64 },
    /// Client only: the edge is probing a silent daemon attachment, for one
    /// bounded wait derived from that attachment's QUIC recovery timers.
    CounterpartProbing {
        counterpart_attachment_id: u64,
        wait_ms: u64,
    },
    /// The counterpart detached and the slot is half-paired for this long.
    CounterpartDetached {
        counterpart_attachment_id: u64,
        rebind_window_remaining_ms: u64,
    },
    /// Client only: the source address this client's own signaling connection
    /// has proven to the relay, its handshake's and then each validated
    /// migration's. The client keys its network by it.
    ObservedPath { address: IpAddr },
    /// Daemon only: the client signaling attachment's proven source address,
    /// on attach and after each validated migration. The only client address
    /// the daemon offers against and punches toward.
    CounterpartPath {
        counterpart_attachment_id: u64,
        address: IpAddr,
    },
}

impl SpliceControlEvent {
    pub fn encode(&self) -> Vec<u8> {
        encode_record(self)
    }

    /// Decodes one record body, or `None` for a shape this build does not know.
    pub fn decode(body: &[u8]) -> Option<Self> {
        serde_json::from_slice(body).ok()
    }
}

/// Both record types are derived from strings, integers, booleans and
/// addresses, which `serde_json` cannot fail on. A value that did fail would
/// become an empty body, which is not JSON: no reader takes it for a record,
/// and [`SpliceControlEvent::decode`] reads it as no event.
fn encode_record<T: Serialize>(value: &T) -> Vec<u8> {
    let body = serde_json::to_vec(value).unwrap_or_default();
    debug_assert!(!body.is_empty() && body.len() <= MAX_PREFACE_LEN);
    let mut framed = Vec::with_capacity(4 + body.len());
    framed.extend_from_slice(&(body.len() as u32).to_be_bytes());
    framed.extend_from_slice(&body);
    framed
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_client_preface_is_the_exact_record_the_edge_reads() {
        let preface = RoutingPreface {
            session_id: "s-1".into(),
            role: Role::Browser,
            version: PREFACE_VERSION,
            attachment: RoutingAttachment::Primary,
            daemon_id: "d-1".into(),
            ticket: "t".into(),
        };
        let record = preface.encode();
        let body = &record[4..];
        assert_eq!(
            u32::from_be_bytes(record[..4].try_into().unwrap()) as usize,
            body.len()
        );
        assert_eq!(
            std::str::from_utf8(body).unwrap(),
            r#"{"session_id":"s-1","role":"browser","version":8,"attachment":{"kind":"primary"},"daemon_id":"d-1","ticket":"t"}"#
        );
        let candidate = RoutingPreface {
            attachment: RoutingAttachment::Candidate {
                nonce: "bm9uY2U".into(),
            },
            ..preface
        };
        let parsed: RoutingPreface = serde_json::from_slice(&candidate.encode()[4..]).unwrap();
        assert_eq!(parsed, candidate);
    }

    #[test]
    fn a_daemon_preface_names_its_incarnation() {
        let tunnel = RoutingPreface {
            session_id: "s-1#signaling".into(),
            role: Role::Daemon,
            version: PREFACE_VERSION,
            attachment: RoutingAttachment::Tunnel {
                incarnation: "AAAAAAAAAAAAAAAAAAAAAA".into(),
            },
            daemon_id: "d-1".into(),
            ticket: "t".into(),
        };
        assert_eq!(
            std::str::from_utf8(&tunnel.encode()[4..]).unwrap(),
            r#"{"session_id":"s-1#signaling","role":"daemon","version":8,"attachment":{"kind":"tunnel","incarnation":"AAAAAAAAAAAAAAAAAAAAAA"},"daemon_id":"d-1","ticket":"t"}"#
        );
        let announce = RoutingPreface {
            session_id: String::new(),
            attachment: RoutingAttachment::Announce {
                incarnation: "AAAAAAAAAAAAAAAAAAAAAA".into(),
            },
            ..tunnel
        };
        let parsed: RoutingPreface = serde_json::from_slice(&announce.encode()[4..]).unwrap();
        assert_eq!(parsed, announce);
    }

    #[test]
    fn events_decode_in_the_edge_spelling_and_unknown_shapes_are_ignored() {
        assert_eq!(
            SpliceControlEvent::decode(br#"{"type":"counterpart_detached","counterpart_attachment_id":4,"rebind_window_remaining_ms":59000}"#),
            Some(SpliceControlEvent::CounterpartDetached {
                counterpart_attachment_id: 4,
                rebind_window_remaining_ms: 59_000
            })
        );
        assert_eq!(
            SpliceControlEvent::decode(br#"{"type":"observed_path","address":"2001:db8::1"}"#),
            Some(SpliceControlEvent::ObservedPath {
                address: "2001:db8::1".parse().unwrap()
            })
        );
        assert_eq!(
            SpliceControlEvent::decode(br#"{"type":"future_event"}"#),
            None
        );
        assert_eq!(
            SpliceControlEvent::decode(br#"{"type":"relay_data_paused","paused":true,"extra":1}"#),
            None
        );
    }
}
