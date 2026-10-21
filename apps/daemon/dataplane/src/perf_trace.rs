//! The dataplane's native boundary evidence over `merkur-trace`: the closed vocabulary the
//! e2e oracles join on, and the QUIC datagram observer that feeds it. Producers never
//! serialize, perform IO, allocate, or take the metadata lock; a refused record is counted.
//! Capture is cold work that writes one `.mtrace` file and never rides the display/control
//! lanes. Evidence times share a process-monotonic origin, NOT the browser's clock.

use std::fs::OpenOptions;
use std::io::{self, BufWriter, Write};
use std::os::unix::fs::OpenOptionsExt;
use std::path::Path;
use std::sync::Once;
use std::time::Instant;

use merkur_trace::Site;

use crate::pty::PtyTraceEvent;

pub use merkur_trace::Token as TraceToken;

pub(crate) static PTY_ENQUEUE: Site = Site::new("pty_enqueue");
pub(crate) static PTY_WRITE: Site = Site::new("pty_write");
pub(crate) static PTY_READ: Site = Site::new("pty_read");
pub(crate) static PTY_READ_HANDLED: Site = Site::new("pty_read_handled");
pub(crate) static PTY_BOUNDARY_DISCARD: Site = Site::new("pty_boundary_discard");
static DISPLAY_MEMBER: Site = Site::new("display_member");
static DISPLAY_ATTEMPT: Site = Site::new("display_attempt");
static CARRIER_STATE: Site = Site::new("carrier_state");
static QUIC_DATAGRAM: Site = Site::new("quic_datagram");

pub enum TraceEvent {
    Pty(PtyTraceEvent),
    /// seq, generation, frame, PID, member index/count, flags, row count,
    /// planned primary, path mask, wire bytes. Remaining words are zero.
    DisplayMember([u64; 16]),
    /// seq/group-start, generation, role, attempted carrier, start_us, accepted,
    /// bytes, reserved-space-before, budget-refused. Not a wire timestamp.
    DisplayAttempt([u64; 16]),
    /// carrier, RTT us, cwnd, in-flight, queued bytes, MTU, pacing bps,
    /// packets-sent count, packets-lost count. These are not loss rates.
    CarrierState([u64; 16]),
    /// phase, connection identity, packet+1 (zero absent), queued/payload bytes,
    /// four uint32 words of the sealed AEAD tag, then Merkur channel+1 (zero
    /// absent). No payload or keys retained.
    QuicDatagram([u64; 16]),
}

impl TraceEvent {
    fn fields(self) -> (&'static Site, [u64; 16]) {
        match self {
            Self::Pty(event) => event.trace_fields(),
            Self::DisplayMember(fields) => (&DISPLAY_MEMBER, fields),
            Self::DisplayAttempt(fields) => (&DISPLAY_ATTEMPT, fields),
            Self::CarrierState(fields) => (&CARRIER_STATE, fields),
            Self::QuicDatagram(fields) => (&QUIC_DATAGRAM, fields),
        }
    }
}

static DATAGRAM_OBSERVER: Once = Once::new();

pub fn begin(peer_id: &str, session_id: &str, epoch: u32) -> Option<TraceToken> {
    if epoch == 0 {
        return None;
    }
    DATAGRAM_OBSERVER.call_once(|| {
        let _ = quinn_proto::datagram_observer::install_datagram_observer(observe_quic_datagram);
    });
    let token = merkur_trace::begin(peer_id, session_id, epoch);
    quinn_proto::datagram_observer::set_datagram_observer_enabled(true);
    Some(token)
}

pub fn active_token() -> Option<TraceToken> {
    merkur_trace::active_token()
}

pub fn end(token: TraceToken) {
    if merkur_trace::end(token) {
        quinn_proto::datagram_observer::set_datagram_observer_enabled(false);
    }
}

pub fn elapsed_us(_token: TraceToken, at: Instant) -> u64 {
    merkur_trace::elapsed_us(at)
}

pub fn record_at(token: TraceToken, at: Instant, event: TraceEvent) {
    let (site, fields) = event.fields();
    merkur_trace::record(token, at, site, fields);
}

/// Drains the current observation into a new file at `path`, readable only by this user.
/// `Ok(false)` before any observation began. Cold work for a dedicated thread.
pub fn write_capture(path: &Path) -> io::Result<bool> {
    let Some(snapshot) = merkur_trace::capture() else {
        return Ok(false);
    };
    let file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)?;
    let mut out = BufWriter::new(file);
    snapshot.write_to(&mut out)?;
    out.flush()?;
    Ok(true)
}

fn observe_quic_datagram(observation: quinn_proto::datagram_observer::DatagramObservation<'_>) {
    use quinn_proto::datagram_observer::DatagramObservationKind;
    let Some(token) = active_token() else {
        return;
    };
    let at = Instant::now();
    let phase = match observation.kind {
        DatagramObservationKind::Queued => 0,
        DatagramObservationKind::Packetized => {
            crate::perf_timing::observe_ack_packetized(observation.payload, at);
            1
        }
        DatagramObservationKind::PacketAcknowledged => 2,
        DatagramObservationKind::PacketLost => 3,
    };
    let mut fields = [0; 16];
    fields[..5].copy_from_slice(&[
        phase,
        observation.connection,
        observation.packet.map_or(0, |packet| packet + 1),
        observation.queued_bytes as u64,
        observation.payload_len() as u64,
    ]);
    if observation.payload.len() >= 16 {
        let tag = &observation.payload[observation.payload.len() - 16..];
        for (index, word) in tag.as_chunks::<4>().0.iter().enumerate() {
            fields[5 + index] = u64::from(u32::from_le_bytes(*word));
        }
    }
    fields[9] = datagram_channel(observation.payload, observation.prefix.is_some())
        .map_or(0, |channel| u64::from(channel) + 1);
    record_at(token, at, TraceEvent::QuicDatagram(fields));
}

/// The Merkur channel byte of a DATAGRAM payload, so a capture can tell input
/// ACKs, pongs and display frames apart without retaining the payload. An
/// owned-prefix sender passes the HTTP/3 quarter-stream id as the prefix, so the
/// channel opens the payload; otherwise the payload starts with that QUIC
/// varint, whose two high bits give its length.
fn datagram_channel(payload: &[u8], prefixed: bool) -> Option<u8> {
    if prefixed {
        return payload.first().copied();
    }
    let varint_len = 1usize << (payload.first()? >> 6);
    payload.get(varint_len).copied()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The capture is the user's own diagnostic file: readable only by them, and never
    /// written over something already at the path.
    #[test]
    fn a_capture_is_a_new_owner_only_file() {
        use std::os::unix::fs::PermissionsExt;
        let directory = std::env::temp_dir().join(format!("perf-trace-{}", std::process::id()));
        if directory.exists() {
            std::fs::remove_dir_all(&directory).unwrap();
        }
        std::fs::create_dir_all(&directory).unwrap();
        let path = directory.join("capture.mtrace");
        let token = begin("peer", "session", 1).unwrap();
        record_at(token, Instant::now(), TraceEvent::DisplayAttempt([0; 16]));
        assert!(write_capture(&path).unwrap());
        let bytes = std::fs::read(&path).unwrap();
        assert_eq!(&bytes[..8], b"MRKTRACE");
        let mode = std::fs::metadata(&path).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
        assert_eq!(
            write_capture(&path).unwrap_err().kind(),
            io::ErrorKind::AlreadyExists
        );
        std::fs::remove_dir_all(&directory).unwrap();
    }

    /// Both admission framings name the same channel: the plain path carries
    /// the HTTP/3 quarter-stream varint in the payload, at every varint width;
    /// the owned-prefix path passes it separately. Payloads too short to hold
    /// a channel report none rather than reading past their end.
    #[test]
    fn a_datagram_channel_is_read_past_the_quarter_stream_varint() {
        use crate::network::protocol::{CHANNEL_CTRL, CHANNEL_DISPLAY_DATAGRAM, CHANNEL_PTY};
        assert_eq!(datagram_channel(&[0x00, CHANNEL_PTY, 9, 9], false), Some(CHANNEL_PTY));
        assert_eq!(datagram_channel(&[0x40, 0x41, CHANNEL_CTRL, 9], false), Some(CHANNEL_CTRL));
        assert_eq!(
            datagram_channel(&[0x80, 0, 0, 1, CHANNEL_PTY], false),
            Some(CHANNEL_PTY)
        );
        assert_eq!(
            datagram_channel(&[0xc0, 0, 0, 0, 0, 0, 0, 1, CHANNEL_CTRL], false),
            Some(CHANNEL_CTRL)
        );
        assert_eq!(
            datagram_channel(&[CHANNEL_DISPLAY_DATAGRAM, 9], true),
            Some(CHANNEL_DISPLAY_DATAGRAM)
        );
        assert_eq!(datagram_channel(&[0x40, 0x41], false), None);
        assert_eq!(datagram_channel(&[], false), None);
        assert_eq!(datagram_channel(&[], true), None);
    }
}
