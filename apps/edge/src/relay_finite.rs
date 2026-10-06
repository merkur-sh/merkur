//! Finite, attachment-bound blind forwarding. No retries or destination rotation.
//!
//! Ingress: [lifecycle/tag:u8][sealed byte count:u32 BE][sealed bytes][FIN].
//! Egress adds the registry's source attachment u64 before that prefix. Only
//! lifecycle and size are interpreted; tags and body remain opaque.
//!
//! Credit is hop by hop. The relay reads a source batch only once its write to
//! the destination returns, and QUIC credits the source only for what the
//! relay has read, so on the daemon's bulk hop the edge grants credit only as
//! the browser hop drains. The browser's model bounds its image send window;
//! `SourceCredit` sizes the upstream window on completed writes and keeps a stream that cannot move from holding the credit its
//! connection's other streams need.

use bytes::Bytes;
use std::future::{Future, pending};
use std::sync::Arc;
use std::time::Duration;
use wtransport::quinn::{StreamId, WriteError};
use wtransport::{RecvStream, SendStream, VarInt};

use super::{RELIABLE_READ_MAX_BYTES, RELIABLE_READ_MAX_CHUNKS};
use crate::splice::{
    MAX_FINITE_STREAM_BYTES, ReliableOpenRequest, ReliableRecordBudget, Role, RoutedReliableLane,
};

/// Four relay read batches cover the relay's copy and credit-return pipeline.
pub(super) const BULK_CREDIT_FLOOR: u64 = 4 * RELIABLE_READ_MAX_BYTES as u64;
/// Credit beyond a whole finite transfer could never be spent.
const BULK_CREDIT_CEILING: u64 = MAX_FINITE_STREAM_BYTES as u64;

/// The browser egress model's current rate times the daemon hop's observed RTT,
/// plus the relay pipeline. Recomputed when a downstream write completes.
pub(super) fn bulk_credit(pacing_rate: u64, srtt: Duration) -> u64 {
    let product = u128::from(pacing_rate).saturating_mul(srtt.as_nanos()) / 1_000_000_000;
    u64::try_from(product)
        .unwrap_or(u64::MAX)
        .saturating_add(BULK_CREDIT_FLOOR)
        .min(BULK_CREDIT_CEILING)
}

/// Only daemon bulk ingress is receive-clocked by its browser egress. The
/// browser's image send credit belongs to its egress model, not a second cap.
pub(super) fn attach_receive_credit(
    connection: &wtransport::quinn::Connection,
    role: Role,
    bulk: bool,
) -> bool {
    let daemon_bulk = bulk && role == Role::Daemon;
    if !daemon_bulk {
        connection.set_receive_window(wtransport::quinn::VarInt::MAX);
    }
    daemon_bulk
}

/// A relayed source stream's share of its connection's credit. While the
/// stream cannot move for a reason of its own (admission waiting on budget or
/// a stream slot another transfer holds, or a destination stream its reader
/// has not drained), its arrivals return their connection credit at once:
/// otherwise its unread bytes could fill the daemon hop's window, and the
/// transfers that would free what it waits on could never finish. Its own
/// stream window still bounds what it buffers. A wait on the destination
/// connection's shared credit keeps the source's: that is the drain the
/// source is clocked to.
pub(super) struct SourceCredit {
    connection: Arc<wtransport::Connection>,
    stream: StreamId,
    parked: bool,
    bulk: bool,
}

impl SourceCredit {
    pub(super) fn new(
        connection: Arc<wtransport::Connection>,
        recv: &RecvStream,
        bulk: bool,
    ) -> Self {
        Self {
            connection,
            stream: recv.quic_stream().id(),
            parked: false,
            bulk,
        }
    }

    fn completed_write(&mut self, destination: &wtransport::quinn::Connection) {
        if !self.bulk {
            return;
        }
        let Some(group) = destination.egress_group() else {
            return;
        };
        let source = self.connection.quic_connection();
        let credit = bulk_credit(group.stats().pacing_rate, source.delivery_state().rtt);
        // The connection owns the current window. Concurrent finite streams
        // must not cache their own last-applied value and miss each other's
        // updates. Setting the same window grants no new credit.
        source.set_receive_window(
            wtransport::quinn::VarInt::from_u64(credit).expect("finite credit fits QUIC varint"),
        );
    }

    pub(super) fn park(&mut self, parked: bool) {
        if std::mem::replace(&mut self.parked, parked) != parked {
            // A stream that already closed holds no credit to return.
            let _ = self
                .connection
                .quic_connection()
                .set_credit_on_arrival(self.stream, parked);
        }
    }
}

/// Write one batch to a relay destination, parking the source's credit while
/// the destination stream's own flow control refuses it.
pub(super) async fn write_parking(
    send: &mut wtransport::quinn::SendStream,
    destination: &wtransport::quinn::Connection,
    chunks: &mut [Bytes],
    source: &mut SourceCredit,
) -> Result<(), WriteError> {
    let id = send.id();
    let mut write = std::pin::pin!(send.write_all_chunks(chunks));
    let written = std::future::poll_fn(|cx| {
        let poll = write.as_mut().poll(cx);
        if poll.is_pending() {
            source.park(destination.is_blocked_by_stream_credit(id).unwrap_or(false));
        }
        poll
    })
    .await;
    source.park(false);
    if written.is_ok() {
        source.completed_write(destination);
    }
    written
}

/// Dropping an unfinished writer must send RESET, not Quinn's implicit FIN.
/// This also runs when its task is aborted while blocked in read/write/open.
struct Output {
    stream: SendStream,
    delivered: bool,
}

impl Drop for Output {
    fn drop(&mut self) {
        if !self.delivered {
            let _ = self.stream.reset(VarInt::from_u32(0));
        }
    }
}

/// Observe upstream RESET even while flow control blocks the downstream write.
/// Normal source FIN is not cancellation: buffered source bytes still need forwarding.
pub(super) async fn upstream<T>(recv: &mut RecvStream, work: impl Future<Output = T>) -> Option<T> {
    let reset = async {
        if matches!(recv.quic_stream_mut().received_reset().await, Ok(None)) {
            pending::<()>().await;
        }
    };
    tokio::select! {
        biased;
        _ = reset => None,
        value = work => Some(value),
    }
}

pub(super) async fn forward(lane: RoutedReliableLane, prefix: [u8; 1], daemon_bulk: bool) {
    let RoutedReliableLane {
        source_attachment_id,
        mut recv,
        source_connection,
        _lane_permit,
        direction_budget: _,
        global_budget: _,
        finite_budgets,
        mut destinations,
    } = lane;

    // Pin to the exact current attachment before any wait. A transfer opened
    // without a destination is refused rather than replayed after a rebind.
    let Some(destination) = destinations.borrow_and_update().clone() else {
        return;
    };
    let Some(requests) = destination.upgrade() else {
        return;
    };

    let mut credit = SourceCredit::new(Arc::clone(&source_connection), &recv, daemon_bulk);
    // Every wait ends on an exact event and nothing else: the source's RESET
    // (`upstream`) or close, a destination replacement, the destination's
    // STOP_SENDING or close, or the acknowledgment of FIN. A transfer both of
    // whose pairings stay up keeps its budget until one of those happens; a
    // clock would only abandon a response nothing then re-asks for.
    let transfer = async {
        let mut length = [0; 4];
        recv.read_exact(&mut length).await.ok()?;
        let bytes = u32::from_be_bytes(length) as usize;
        if bytes == 0 || bytes > MAX_FINITE_STREAM_BYTES {
            return None;
        }

        // Reserve the whole transfer before reading any body, including bytes
        // that may move into QUIC's send queue. Reads still own at most one batch;
        // no whole-object buffer is allocated. Keep credit through final delivery.
        // Budget another transfer holds frees only as that transfer finishes.
        let _bytes = match ReliableRecordBudget::try_acquire_finite(&finite_budgets, bytes) {
            Some(budget) => budget,
            None => {
                credit.park(true);
                upstream(
                    &mut recv,
                    ReliableRecordBudget::acquire_finite(&finite_budgets, bytes),
                )
                .await??
            }
        };
        let (reply, opened) = tokio::sync::oneshot::channel();
        let (waiting, out_of_streams) = tokio::sync::oneshot::channel();
        upstream(
            &mut recv,
            requests.send(ReliableOpenRequest {
                finite: true,
                reply,
                waiting: Some(waiting),
            }),
        )
        .await?
        .ok()?;
        let opened = upstream(&mut recv, async {
            tokio::pin!(opened);
            tokio::select! {
                biased;
                opened = &mut opened => return opened,
                // The destination has no stream credit left: another
                // transfer's stream has to close first.
                Ok(()) = out_of_streams => credit.park(true),
            }
            opened.await
        })
        .await?
        .ok()??;
        credit.park(false);
        let destination = opened.connection;
        let mut output = Output {
            stream: opened.send,
            delivered: false,
        };
        // Packet admission shares the concrete data egress group. This priority
        // also prevents direct image streams spending its interactive reserve.
        output
            .stream
            .set_priority(wtransport::quinn::EGRESS_IMAGE_PRIORITY);
        // Created once per stream, never once per read/chunk.
        let stopped = output.stream.quic_stream().stopped();
        tokio::pin!(stopped);
        let pipe = async {
            let mut header = [0; 13];
            header[..8].copy_from_slice(&source_attachment_id.as_u64().to_be_bytes());
            header[8] = prefix[0];
            header[9..].copy_from_slice(&length);
            upstream(&mut recv, output.stream.write_all(&header))
                .await?
                .ok()?;

            let mut remaining = bytes;
            while remaining != 0 {
                let mut chunks = [const { Bytes::new() }; RELIABLE_READ_MAX_CHUNKS];
                let count = recv
                    .quic_stream_mut()
                    .read_chunks_bounded(&mut chunks, remaining.min(RELIABLE_READ_MAX_BYTES))
                    .await
                    .ok()??;
                remaining -= chunks[..count].iter().map(Bytes::len).sum::<usize>();
                upstream(
                    &mut recv,
                    write_parking(
                        output.stream.quic_stream_mut(),
                        destination.quic_connection(),
                        &mut chunks[..count],
                        &mut credit,
                    ),
                )
                .await?
                .ok()?;
            }
            // FIN is part of the finite contract. A short body, reset, extra byte
            // or trailing record resets the output instead of publishing a FIN.
            if recv.read(&mut [0; 1]).await.ok()?.is_some() {
                return None;
            }
            output.stream.quic_stream_mut().finish().ok()?;
            Some(())
        };
        let complete = tokio::select! {
            biased;
            _ = &mut stopped => None,
            complete = pipe => complete,
        };
        complete?;
        // A completed write is only native queue admission. Retain the stream
        // slots and byte permit until its FIN and bytes are actually ACKed.
        output.delivered = matches!((&mut stopped).await, Ok(None));
        Some(())
    };
    tokio::select! {
        biased;
        _ = source_connection.closed() => {},
        _ = destinations.changed() => {},
        _ = transfer => {},
    }
    // RecvStream drop propagates STOP_SENDING upstream on every incomplete exit.
}

#[cfg(test)]
mod credit_tests {
    use super::*;

    #[test]
    fn credit_uses_downstream_rate_and_upstream_rtt_with_pipeline_room() {
        assert_eq!(bulk_credit(0, Duration::from_secs(1)), BULK_CREDIT_FLOOR);
        assert_eq!(
            bulk_credit(1_000_000, Duration::from_millis(20)),
            BULK_CREDIT_FLOOR + 20_000
        );
        assert_eq!(
            bulk_credit(10_000_000, Duration::from_millis(20)),
            BULK_CREDIT_FLOOR + 200_000
        );
        assert_eq!(
            bulk_credit(u64::MAX, Duration::from_secs(1)),
            BULK_CREDIT_CEILING
        );
    }
}
