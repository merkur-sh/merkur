use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::mpsc::error::TrySendError;
use tokio::sync::{OwnedSemaphorePermit, Semaphore, mpsc};
use tracing::warn;

use crate::connection::PeerTransport;

static NEXT_CONNECTION_ID: AtomicU64 = AtomicU64::new(1);
pub const MAX_INBOUND_FRAME_BYTES: usize = 64 * 1024;
/// Bound how long a continuously-refilled reliable channel can postpone its
/// explicit flush. Without this cap, `try_recv` could keep succeeding forever
/// under sustained traffic and strand the oldest buffered control/input frame.
const MAX_SEND_BATCH_FRAMES: usize = 8;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum DatagramEnqueueResult {
    Enqueued,
    DroppedFull,
    Closed,
}

/// Enqueue one best-effort ingress datagram without ever backpressuring the
/// transport receive loop.
///
/// A full bounded queue deliberately drops the datagram and records the drop.
/// Warnings are logarithmically rate-limited so overload remains observable
/// without turning a packet flood into a logging flood. A closed receiver tells
/// the caller to stop its receive task.
pub(crate) fn try_enqueue_datagram<T>(
    tx: &mpsc::Sender<T>,
    value: T,
    dropped: &AtomicU64,
    lane: &'static str,
) -> DatagramEnqueueResult {
    match tx.try_send(value) {
        Ok(()) => DatagramEnqueueResult::Enqueued,
        Err(TrySendError::Full(_)) => {
            let dropped_count = dropped.fetch_add(1, Ordering::Relaxed).wrapping_add(1);
            if dropped_count == 1 || dropped_count.is_power_of_two() {
                warn!(
                    lane,
                    dropped_count,
                    "dropping inbound datagram because the bounded ingress queue is full"
                );
            }
            DatagramEnqueueResult::DroppedFull
        }
        Err(TrySendError::Closed(_)) => DatagramEnqueueResult::Closed,
    }
}

pub fn next_connection_id() -> u64 {
    NEXT_CONNECTION_ID.fetch_add(1, Ordering::Relaxed)
}

/// The largest record the reliable lanes carry without a heap allocation:
/// exactly one sealed input ack. Const-asserted below so the ack can never
/// silently outgrow its inline slot and start allocating again.
pub const INLINE_RELIABLE_PAYLOAD_BYTES: usize = 32;
const _: () = assert!(
    INLINE_RELIABLE_PAYLOAD_BYTES
        == crate::network::protocol::INPUT_ACK_FRAME_BYTES + crate::e2e::FRAME_OVERHEAD,
    "the inline reliable payload is sized for exactly one sealed input ack"
);

/// One already-sealed record for a persistent reliable lane.
///
/// A record the size of an input ack lives inline, so the per-keystroke control
/// path allocates nothing on the owner loop and the send task frees nothing on
/// its side; everything larger keeps the heap allocation it was sealed into
/// and moves it, as before. Rejection hands back the same value either way,
/// so carrier fallback never clones or reseals.
#[derive(Debug)]
pub enum ReliablePayload {
    Inline {
        len: u8,
        bytes: [u8; INLINE_RELIABLE_PAYLOAD_BYTES],
    },
    Heap(Vec<u8>),
}

impl ReliablePayload {
    /// Wrap a record sealed into a caller's stack array; `len` is the sealed
    /// length inside `bytes`.
    pub fn inline(len: usize, bytes: [u8; INLINE_RELIABLE_PAYLOAD_BYTES]) -> Self {
        debug_assert!(len <= INLINE_RELIABLE_PAYLOAD_BYTES);
        Self::Inline {
            len: len as u8,
            bytes,
        }
    }

    pub fn as_slice(&self) -> &[u8] {
        match self {
            Self::Inline { len, bytes } => &bytes[..usize::from(*len)],
            Self::Heap(bytes) => bytes,
        }
    }

    /// Test captures keep their `(channel, Vec<u8>)` shape; production never
    /// copies an inline record back onto the heap.
    #[cfg(test)]
    pub fn into_vec(self) -> Vec<u8> {
        match self {
            Self::Inline { .. } => self.as_slice().to_vec(),
            Self::Heap(bytes) => bytes,
        }
    }
}

#[derive(Clone)]
pub struct ChannelSenders {
    pub ctrl: mpsc::Sender<ReliablePayload>,
    pub pty: mpsc::Sender<ReliablePayload>,
    pub display_commit: mpsc::Sender<ReliablePayload>,
    pub signaling: Option<mpsc::Sender<ReliablePayload>>,
}

pub struct ChannelPeerConnection {
    pub senders: ChannelSenders,
    pub connection_id: u64,
}

pub fn spawn_channel_recv_task<R: tokio::io::AsyncRead + Unpin + Send + 'static>(
    mut recv_stream: R,
    peer_node_id: Arc<str>,
    channel_id: u8,
    connection_id: u64,
    via_transport: PeerTransport,
    message_tx: mpsc::Sender<PeerMessage>,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        // PTY records retain this local credit through application admission.
        // Other channels keep their independent readers and never wait for it.
        let input_credit =
            (channel_id == super::protocol::CHANNEL_PTY).then(|| Arc::new(Semaphore::new(1)));
        loop {
            let input_permit = match &input_credit {
                Some(credit) => match Arc::clone(credit).acquire_owned().await {
                    Ok(permit) => Some(permit),
                    Err(_) => break,
                },
                None => None,
            };
            let mut len_buf = [0u8; 4];
            if recv_stream.read_exact(&mut len_buf).await.is_err() {
                break;
            }
            let msg_len = u32::from_be_bytes(len_buf) as usize;
            if msg_len == 0 {
                continue;
            }
            if !is_valid_inbound_frame_len(msg_len) {
                break;
            }
            // Fill the final exact-size payload straight from the stream. The
            // previous shape resized a retained buffer to `msg_len` — zeroing
            // every byte immediately before the network overwrote it — and then
            // handed that buffer away and allocated a fresh 4 KiB one for the
            // next frame, so a 32 KiB record paid a 32 KiB memset and a
            // wrong-sized allocation. This mirrors the edge reliable reader:
            // `try_reserve_exact` bounds the allocation, and a `Take` keeps
            // spare capacity from swallowing the next frame's header.
            let mut payload = Vec::new();
            if payload.try_reserve_exact(msg_len).is_err() {
                break;
            }
            let filled = async {
                while payload.len() < msg_len {
                    let remaining = msg_len - payload.len();
                    let mut limited = (&mut recv_stream).take(remaining as u64);
                    if limited.read_buf(&mut payload).await? == 0 {
                        return Err(std::io::Error::from(std::io::ErrorKind::UnexpectedEof));
                    }
                }
                Ok::<(), std::io::Error>(())
            }
            .await;
            if filled.is_err() {
                break;
            }
            if message_tx
                .send(PeerMessage {
                    peer_node_id: peer_node_id.clone(),
                    channel_id,
                    payload: bytes::Bytes::from(payload),
                    via_transport,
                    delivery: DeliveryMode::Stream,
                    connection_id,
                    edge_ingress: None,
                    input_permit,
                })
                .await
                .is_err()
            {
                break;
            }
        }
    })
}

pub fn spawn_send_task<W: tokio::io::AsyncWrite + Unpin + Send + 'static>(
    send_stream: W,
    mut send_rx: mpsc::Receiver<ReliablePayload>,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut buffered = tokio::io::BufWriter::with_capacity(65536, send_stream);
        while let Some(data) = send_rx.recv().await {
            if write_send_batch(&mut buffered, &mut send_rx, data)
                .await
                .is_err()
            {
                break;
            }
        }
    })
}

async fn write_send_batch<W: tokio::io::AsyncWrite + Unpin>(
    buffered: &mut tokio::io::BufWriter<W>,
    send_rx: &mut mpsc::Receiver<ReliablePayload>,
    first: ReliablePayload,
) -> std::io::Result<usize> {
    let mut next = Some(first);
    let mut written_frames = 0;
    while let Some(data) = next.take() {
        let data = data.as_slice();
        let len = (data.len() as u32).to_be_bytes();
        buffered.write_all(&len).await?;
        buffered.write_all(data).await?;
        written_frames += 1;
        if written_frames >= MAX_SEND_BATCH_FRAMES {
            break;
        }
        next = send_rx.try_recv().ok();
    }
    buffered.flush().await?;
    Ok(written_frames)
}

pub fn select_channel_sender(
    senders: &ChannelSenders,
    channel_id: u8,
) -> Option<&mpsc::Sender<ReliablePayload>> {
    match channel_id {
        crate::network::protocol::CHANNEL_SIGNALING => senders.signaling.as_ref(),
        crate::network::protocol::CHANNEL_CTRL => Some(&senders.ctrl),
        crate::network::protocol::CHANNEL_PTY => Some(&senders.pty),
        crate::network::protocol::CHANNEL_DISPLAY_COMMIT => Some(&senders.display_commit),
        _ => None,
    }
}

/// How a `PeerMessage` reached the daemon. The E2E open path keys the Noise
/// nonce sub-lane on this: a given logical channel (e.g. PTY, CTRL) can travel
/// as BOTH a reliable stream and an unreliable datagram, and the stream vs
/// datagram nonce sub-lanes are disjoint — so the open call must pick the same
/// sub-lane the sender sealed under, which is determined by HOW the frame was
/// delivered, not by channel id alone.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum DeliveryMode {
    Stream,
    Datagram,
}

/// Exact owner of one edge-relayed ingress frame.
///
/// Edge frames use `PeerTransport::Edge` for independent health/RTT selection;
/// this identity additionally binds queued work to one session and one
/// independently supervised edge lane.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EdgeIngressIdentity {
    pub session_id: Arc<str>,
    pub generation: u64,
    pub lane: super::protocol::EdgeLane,
}

pub struct PeerMessage {
    /// PTY-stream read credit. Retained with a refused plaintext suffix, released
    /// on admission/drop. No per-record channel, allocation or network ACK.
    pub input_permit: Option<OwnedSemaphorePermit>,
    pub peer_node_id: Arc<str>,
    pub channel_id: u8,
    /// Sealed on arrival, plaintext after the single open at dispatch. `Bytes`
    /// either way: ingress slices it from the carrier's buffer without copying,
    /// and the open moves its own output buffer in without one.
    pub payload: bytes::Bytes,
    /// Which transport delivered this message. Used by display-layer code
    /// to attribute per-path RTT samples, decide which path is healthy,
    /// and (under the dual-transport refactor) avoid double-counting acks
    /// when the same frame arrives on both paths.
    pub via_transport: PeerTransport,
    /// Stream vs datagram delivery. Set structurally at the two inbound
    /// sources (reliable channel recv task = `Stream`; the datagram event
    /// path in `run` = `Datagram`). Selects the Noise nonce sub-lane the
    /// inbound open must use.
    pub delivery: DeliveryMode,
    /// Exact browser-carrier generation that produced this frame. For direct-WT
    /// ingress this is the connection id; for edge ingress this repeats
    /// `edge_ingress.generation`. Zero is reserved for synthetic, unowned
    /// messages in tests.
    pub connection_id: u64,
    /// Edge-specific session/lane ownership. `None` denotes direct
    /// WebTransport or an unowned synthetic message.
    pub edge_ingress: Option<EdgeIngressIdentity>,
}

pub fn is_valid_inbound_frame_len(msg_len: usize) -> bool {
    msg_len <= MAX_INBOUND_FRAME_BYTES
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::pin::Pin;
    use std::task::{Context, Poll};
    use tokio::io::ReadBuf;

    /// Delivers `bytes` in at most `fragment_bytes` per poll so the reader's
    /// partial-fill loop is exercised rather than short-circuited by a single
    /// complete read.
    struct FragmentedReader {
        bytes: Vec<u8>,
        cursor: usize,
        fragment_bytes: usize,
    }

    impl FragmentedReader {
        fn new(bytes: Vec<u8>, fragment_bytes: usize) -> Self {
            Self {
                bytes,
                cursor: 0,
                fragment_bytes: fragment_bytes.max(1),
            }
        }
    }

    impl tokio::io::AsyncRead for FragmentedReader {
        fn poll_read(
            mut self: Pin<&mut Self>,
            _context: &mut Context<'_>,
            destination: &mut ReadBuf<'_>,
        ) -> Poll<std::io::Result<()>> {
            let remaining = self.bytes.len().saturating_sub(self.cursor);
            if remaining == 0 {
                return Poll::Ready(Ok(()));
            }
            let copied = remaining
                .min(destination.remaining())
                .min(self.fragment_bytes);
            destination.put_slice(&self.bytes[self.cursor..self.cursor + copied]);
            self.cursor += copied;
            Poll::Ready(Ok(()))
        }
    }

    fn framed(payloads: &[&[u8]]) -> Vec<u8> {
        let mut wire = Vec::new();
        for payload in payloads {
            wire.extend_from_slice(&(payload.len() as u32).to_be_bytes());
            wire.extend_from_slice(payload);
        }
        wire
    }

    async fn read_frames(wire: Vec<u8>, fragment_bytes: usize) -> Vec<Vec<u8>> {
        let (tx, mut rx) = mpsc::channel(16);
        let handle = spawn_channel_recv_task(
            FragmentedReader::new(wire, fragment_bytes),
            Arc::from("browser-1"),
            crate::network::protocol::CHANNEL_CTRL,
            7,
            PeerTransport::WebTransport,
            tx,
        );
        handle.await.expect("recv task");
        let mut frames = Vec::new();
        while let Ok(msg) = rx.try_recv() {
            assert_eq!(&*msg.peer_node_id, "browser-1");
            assert_eq!(msg.delivery, DeliveryMode::Stream);
            assert_eq!(msg.connection_id, 7);
            frames.push(msg.payload.to_vec());
        }
        frames
    }

    #[tokio::test]
    async fn framed_reader_splits_records_exactly_under_fragmentation() {
        // The payload buffer is filled through a bounded `Take`, so spare
        // capacity must never swallow the following frame's length header no
        // matter how the stream fragments.
        let first = vec![0xA1u8; 300];
        let second = vec![0xB2u8; 17];
        let third = vec![0xC3u8; 4096];
        let wire = framed(&[&first, &second, &third]);
        for fragment_bytes in [1, 7, 64, 1024, usize::MAX] {
            let frames = read_frames(wire.clone(), fragment_bytes).await;
            assert_eq!(frames, vec![first.clone(), second.clone(), third.clone()]);
        }
    }

    #[tokio::test]
    async fn input_read_credit_stops_only_its_lane_until_application_admission() {
        use crate::network::protocol::{CHANNEL_CTRL, CHANNEL_PTY};
        let (mut input_send, input_recv) = tokio::io::duplex(64);
        let (mut ctrl_send, ctrl_recv) = tokio::io::duplex(64);
        let (tx, mut rx) = mpsc::channel(4);
        let input_reader = spawn_channel_recv_task(
            input_recv,
            Arc::from("peer"),
            CHANNEL_PTY,
            1,
            PeerTransport::WebTransport,
            tx.clone(),
        );
        let ctrl_reader = spawn_channel_recv_task(
            ctrl_recv,
            Arc::from("peer"),
            CHANNEL_CTRL,
            1,
            PeerTransport::WebTransport,
            tx,
        );
        input_send
            .write_all(b"\0\0\0\x01a\0\0\0\x01b")
            .await
            .unwrap();
        let first = rx.recv().await.unwrap();
        assert_eq!(first.payload.as_ref(), b"a");
        assert!(first.input_permit.is_some());
        ctrl_send.write_all(b"\0\0\0\x01c").await.unwrap();
        let control = tokio::time::timeout(std::time::Duration::from_secs(1), rx.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(control.channel_id, CHANNEL_CTRL);
        assert!(control.input_permit.is_none());
        assert!(rx.try_recv().is_err(), "second input remains in the stream");
        drop(first);
        let second = tokio::time::timeout(std::time::Duration::from_secs(1), rx.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(second.payload.as_ref(), b"b");
        drop(second);
        drop(input_send);
        drop(ctrl_send);
        tokio::time::timeout(std::time::Duration::from_secs(1), async {
            input_reader.await.unwrap();
            ctrl_reader.await.unwrap();
        })
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn framed_reader_drops_a_truncated_final_record() {
        let complete = vec![0xA1u8; 64];
        let mut wire = framed(&[&complete]);
        wire.extend_from_slice(&(64u32).to_be_bytes());
        wire.extend_from_slice(&[0xB2u8; 63]); // one byte short
        assert_eq!(read_frames(wire, 9).await, vec![complete]);
    }

    #[tokio::test]
    async fn framed_reader_stops_on_an_oversized_length() {
        let complete = vec![0xA1u8; 8];
        let mut wire = framed(&[&complete]);
        wire.extend_from_slice(&((MAX_INBOUND_FRAME_BYTES as u32) + 1).to_be_bytes());
        wire.extend_from_slice(&[0u8; 16]);
        assert_eq!(read_frames(wire, 5).await, vec![complete]);
    }

    #[tokio::test]
    async fn framed_reader_skips_zero_length_records() {
        let payload = vec![0xA1u8; 24];
        let mut wire = (0u32).to_be_bytes().to_vec();
        wire.extend_from_slice(&framed(&[&payload]));
        assert_eq!(read_frames(wire, 3).await, vec![payload]);
    }

    /// Superseded reader buffer shape: resize a retained buffer to the frame
    /// length (zeroing every byte the network is about to overwrite), read into
    /// it, then hand the buffer away and allocate a fresh 4 KiB one.
    async fn legacy_read_frames<R>(recv: &mut R, count: usize) -> usize
    where
        R: tokio::io::AsyncRead + Unpin,
    {
        let mut msg_buf: Vec<u8> = Vec::with_capacity(4096);
        let mut total = 0usize;
        for _ in 0..count {
            let mut len_buf = [0u8; 4];
            if recv.read_exact(&mut len_buf).await.is_err() {
                break;
            }
            let msg_len = u32::from_be_bytes(len_buf) as usize;
            msg_buf.resize(msg_len, 0);
            if recv.read_exact(&mut msg_buf).await.is_err() {
                break;
            }
            let payload =
                bytes::Bytes::from(std::mem::replace(&mut msg_buf, Vec::with_capacity(4096)));
            total ^= payload.len();
            std::hint::black_box(payload);
        }
        total
    }

    /// Production reader buffer shape: exact-size reservation filled straight
    /// from the stream through a bounded `Take`.
    async fn exact_read_frames<R>(recv: &mut R, count: usize) -> usize
    where
        R: tokio::io::AsyncRead + Unpin,
    {
        let mut total = 0usize;
        for _ in 0..count {
            let mut len_buf = [0u8; 4];
            if recv.read_exact(&mut len_buf).await.is_err() {
                break;
            }
            let msg_len = u32::from_be_bytes(len_buf) as usize;
            let mut payload = Vec::new();
            if payload.try_reserve_exact(msg_len).is_err() {
                break;
            }
            while payload.len() < msg_len {
                let remaining = msg_len - payload.len();
                let mut limited = (&mut *recv).take(remaining as u64);
                if limited.read_buf(&mut payload).await.unwrap_or(0) == 0 {
                    break;
                }
            }
            let payload = bytes::Bytes::from(payload);
            total ^= payload.len();
            std::hint::black_box(payload);
        }
        total
    }

    /// Buffer-management cost of the direct-WebTransport reliable stream
    /// reader, across the record sizes it carries: a small control frame, a
    /// default-capacity frame, and a jumbo record that used to force both a
    /// reallocation and a full-size memset.
    ///
    /// Component scope: the timed region is the framing and buffer handling
    /// over an in-memory reader, not QUIC scheduling. Both shapes run in one
    /// process, alternating order.
    #[tokio::test(flavor = "current_thread")]
    #[ignore = "production performance workload"]
    async fn production_reliable_stream_reader_benchmark() {
        let samples = std::env::var("BENCH_SAMPLES")
            .ok()
            .and_then(|value| value.parse::<usize>().ok())
            .filter(|value| *value > 0)
            .unwrap_or(100);
        let batch_size = std::env::var("BENCH_BATCH_SIZE")
            .ok()
            .and_then(|value| value.parse::<usize>().ok())
            .filter(|value| *value > 0)
            .unwrap_or(256);
        let mut checksum = 0usize;

        for record_len in [64usize, 4096, 32 * 1024] {
            let record = vec![0xA5u8; record_len];
            let refs: Vec<&[u8]> = (0..batch_size).map(|_| record.as_slice()).collect();
            let wire = framed(&refs);
            let mut legacy_samples = Vec::with_capacity(samples);
            let mut exact_samples = Vec::with_capacity(samples);

            for sample in 0..samples {
                let mut legacy_reader = FragmentedReader::new(wire.clone(), usize::MAX);
                let mut exact_reader = FragmentedReader::new(wire.clone(), usize::MAX);
                let run_legacy = async |reader: &mut FragmentedReader| {
                    let started = std::time::Instant::now();
                    let total = legacy_read_frames(reader, batch_size).await;
                    (
                        started.elapsed().as_nanos() as f64 / batch_size as f64,
                        total,
                    )
                };
                let run_exact = async |reader: &mut FragmentedReader| {
                    let started = std::time::Instant::now();
                    let total = exact_read_frames(reader, batch_size).await;
                    (
                        started.elapsed().as_nanos() as f64 / batch_size as f64,
                        total,
                    )
                };
                if sample % 2 == 0 {
                    let (ns, total) = run_legacy(&mut legacy_reader).await;
                    legacy_samples.push(ns);
                    checksum ^= total;
                    let (ns, total) = run_exact(&mut exact_reader).await;
                    exact_samples.push(ns);
                    checksum ^= total;
                } else {
                    let (ns, total) = run_exact(&mut exact_reader).await;
                    exact_samples.push(ns);
                    checksum ^= total;
                    let (ns, total) = run_legacy(&mut legacy_reader).await;
                    legacy_samples.push(ns);
                    checksum ^= total;
                }
            }

            emit_reader_metric(
                &format!("reliable-stream-reader-legacy-{record_len}b"),
                &mut legacy_samples,
                samples,
            );
            emit_reader_metric(
                &format!("reliable-stream-reader-exact-{record_len}b"),
                &mut exact_samples,
                samples,
            );
        }
        std::hint::black_box(checksum);
    }

    fn emit_reader_metric(name: &str, samples: &mut [f64], sample_size: usize) {
        samples.sort_by(f64::total_cmp);
        let percentile = |ratio: f64| {
            let index = ((samples.len() as f64 * ratio).ceil() as usize)
                .saturating_sub(1)
                .min(samples.len().saturating_sub(1));
            samples[index]
        };
        for ratio in [0.50, 0.95, 0.99] {
            let value = percentile(ratio);
            println!(
                "@@merkur-perf {{\"name\":\"{name}\",\"value\":{value},\"unit\":\"ns/op\",\"direction\":\"lower\",\"percentile\":{ratio},\"sampleSize\":{sample_size}}}"
            );
        }
    }

    #[test]
    fn inbound_frame_len_accepts_bounded_frames() {
        assert!(is_valid_inbound_frame_len(1));
        assert!(is_valid_inbound_frame_len(MAX_INBOUND_FRAME_BYTES));
    }

    #[test]
    fn inbound_frame_len_rejects_oversized_frames() {
        assert!(!is_valid_inbound_frame_len(MAX_INBOUND_FRAME_BYTES + 1));
    }

    #[test]
    fn peer_message_preserves_delivery_mode() {
        // The two inbound sources set `delivery` structurally (stream recv =>
        // Stream, datagram event => Datagram); the E2E open picks the nonce
        // sub-lane from it, so the field must round-trip on the message.
        let stream = PeerMessage {
            input_permit: None,
            peer_node_id: std::sync::Arc::from("p"),
            channel_id: crate::network::protocol::CHANNEL_PTY,
            payload: bytes::Bytes::from_static(&[1, 2, 3]),
            via_transport: PeerTransport::Edge,
            delivery: DeliveryMode::Stream,
            connection_id: 0,
            edge_ingress: None,
        };
        assert_eq!(stream.delivery, DeliveryMode::Stream);
        let datagram = PeerMessage {
            delivery: DeliveryMode::Datagram,
            ..stream
        };
        assert_eq!(datagram.delivery, DeliveryMode::Datagram);
    }

    #[test]
    fn channel_sender_selection_is_channel_specific() {
        let (ctrl_tx, mut ctrl_rx) = mpsc::channel(1);
        let (pty_tx, mut pty_rx) = mpsc::channel(1);
        let (display_snapshot_tx, mut display_snapshot_rx) = mpsc::channel(1);
        let (signaling_tx, mut signaling_rx) = mpsc::channel(1);
        let senders = ChannelSenders {
            ctrl: ctrl_tx,
            pty: pty_tx,
            display_commit: display_snapshot_tx,
            signaling: Some(signaling_tx),
        };

        select_channel_sender(&senders, crate::network::protocol::CHANNEL_SIGNALING)
            .unwrap()
            .try_send(ReliablePayload::Heap(vec![0]))
            .unwrap();
        select_channel_sender(&senders, crate::network::protocol::CHANNEL_CTRL)
            .unwrap()
            .try_send(ReliablePayload::Heap(vec![1]))
            .unwrap();
        select_channel_sender(&senders, crate::network::protocol::CHANNEL_PTY)
            .unwrap()
            .try_send(ReliablePayload::inline(
                1,
                [2; INLINE_RELIABLE_PAYLOAD_BYTES],
            ))
            .unwrap();
        select_channel_sender(&senders, crate::network::protocol::CHANNEL_DISPLAY_COMMIT)
            .unwrap()
            .try_send(ReliablePayload::Heap(vec![3]))
            .unwrap();

        assert_eq!(signaling_rx.try_recv().unwrap().into_vec(), vec![0]);
        assert_eq!(ctrl_rx.try_recv().unwrap().into_vec(), vec![1]);
        assert_eq!(pty_rx.try_recv().unwrap().into_vec(), vec![2]);
        assert_eq!(display_snapshot_rx.try_recv().unwrap().into_vec(), vec![3]);
        assert!(select_channel_sender(&senders, 0xff).is_none());
    }

    /// The inline arm exists for exactly one record — a sealed input ack —
    /// and must fit it with no slack to grow into. The enum must also stay
    /// no wider than the queue slot the heap arm already paid for plus the
    /// inline bytes, so a 64-deep channel does not balloon.
    #[test]
    fn an_input_ack_fills_the_inline_reliable_payload_exactly() {
        assert_eq!(
            INLINE_RELIABLE_PAYLOAD_BYTES,
            crate::network::protocol::INPUT_ACK_FRAME_BYTES + crate::e2e::FRAME_OVERHEAD
        );
        assert!(std::mem::size_of::<ReliablePayload>() <= 40);
        let ack = ReliablePayload::inline(
            INLINE_RELIABLE_PAYLOAD_BYTES,
            [0xA5; INLINE_RELIABLE_PAYLOAD_BYTES],
        );
        assert_eq!(ack.as_slice().len(), INLINE_RELIABLE_PAYLOAD_BYTES);
        assert_eq!(ack.as_slice(), &[0xA5; INLINE_RELIABLE_PAYLOAD_BYTES]);
        let short = ReliablePayload::inline(3, [0x11; INLINE_RELIABLE_PAYLOAD_BYTES]);
        assert_eq!(short.as_slice(), &[0x11, 0x11, 0x11]);
        assert!(ReliablePayload::Heap(Vec::new()).as_slice().is_empty());
    }

    #[test]
    fn channel_sender_without_signaling() {
        let (ctrl_tx, _) = mpsc::channel(1);
        let (pty_tx, _) = mpsc::channel(1);
        let (display_snapshot_tx, _) = mpsc::channel(1);
        let senders = ChannelSenders {
            ctrl: ctrl_tx,
            pty: pty_tx,
            display_commit: display_snapshot_tx,
            signaling: None,
        };

        assert!(
            select_channel_sender(&senders, crate::network::protocol::CHANNEL_SIGNALING).is_none()
        );
        assert!(select_channel_sender(&senders, crate::network::protocol::CHANNEL_CTRL).is_some());
    }

    #[test]
    fn datagram_queue_stays_bounded_and_counts_every_overflow() {
        let (tx, mut rx) = mpsc::channel(2);
        let dropped = AtomicU64::new(0);

        assert_eq!(
            try_enqueue_datagram(&tx, 1, &dropped, "test"),
            DatagramEnqueueResult::Enqueued
        );
        assert_eq!(
            try_enqueue_datagram(&tx, 2, &dropped, "test"),
            DatagramEnqueueResult::Enqueued
        );
        for value in 0..100_000 {
            assert_eq!(
                try_enqueue_datagram(&tx, value, &dropped, "test"),
                DatagramEnqueueResult::DroppedFull
            );
        }

        assert_eq!(dropped.load(Ordering::Relaxed), 100_000);
        assert_eq!(tx.capacity(), 0);
        assert_eq!(rx.try_recv(), Ok(1));
        assert_eq!(rx.try_recv(), Ok(2));
        assert!(rx.try_recv().is_err());
    }

    #[test]
    fn datagram_queue_distinguishes_closed_from_full_without_counting_a_drop() {
        let (tx, rx) = mpsc::channel::<u8>(1);
        let dropped = AtomicU64::new(0);
        drop(rx);

        assert_eq!(
            try_enqueue_datagram(&tx, 1, &dropped, "test"),
            DatagramEnqueueResult::Closed
        );
        assert_eq!(dropped.load(Ordering::Relaxed), 0);
    }

    #[tokio::test]
    async fn reliable_send_batch_flushes_before_draining_a_sustained_queue() {
        let (writer, mut reader) = tokio::io::duplex(4096);
        let mut buffered = tokio::io::BufWriter::with_capacity(4096, writer);
        let queued = MAX_SEND_BATCH_FRAMES + 4;
        let (tx, mut rx) = mpsc::channel(queued);
        for sequence in 0..queued {
            tx.try_send(ReliablePayload::Heap(vec![sequence as u8]))
                .unwrap();
        }

        let first = rx.recv().await.unwrap();
        let written = write_send_batch(&mut buffered, &mut rx, first)
            .await
            .unwrap();

        assert_eq!(written, MAX_SEND_BATCH_FRAMES);
        assert_eq!(
            rx.len(),
            4,
            "one turn must leave later work for a fair flush"
        );
        for sequence in 0..MAX_SEND_BATCH_FRAMES {
            let mut len = [0u8; 4];
            reader.read_exact(&mut len).await.unwrap();
            assert_eq!(u32::from_be_bytes(len), 1);
            let mut payload = [0u8; 1];
            reader.read_exact(&mut payload).await.unwrap();
            assert_eq!(payload, [sequence as u8]);
        }
    }
}
