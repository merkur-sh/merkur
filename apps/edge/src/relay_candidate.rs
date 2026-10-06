//! Proof-only bridges. They never enter the ordinary splice until the exact
//! daemon attachment selects them. Payloads are opaque to the edge.

use std::sync::Arc;
use std::time::Duration;
use tokio::time::{Instant, timeout_at};
use wtransport::{Connection, RecvStream, SendStream};

use crate::splice::{AttachHandle, SpliceControlEvent, SpliceRegistry};

// One bounded signaling record. This is independent of terminal-data credit.
const MAX_PROOF_RECORD: usize = 64 * 1024;
const PROOF_LIFETIME: Duration = Duration::from_secs(10);

async fn read_record(recv: &mut RecvStream) -> Result<Vec<u8>, ()> {
    let mut header = [0; 4];
    recv.read_exact(&mut header).await.map_err(|_| ())?;
    let length = u32::from_be_bytes(header) as usize;
    if length == 0 || length > MAX_PROOF_RECORD {
        return Err(());
    }
    let mut bytes = vec![0; length];
    recv.read_exact(&mut bytes).await.map_err(|_| ())?;
    Ok(bytes)
}

async fn write_record(send: &mut SendStream, bytes: &[u8]) -> Result<(), ()> {
    send.write_all(&(bytes.len() as u32).to_be_bytes())
        .await
        .map_err(|_| ())?;
    send.write_all(bytes).await.map_err(|_| ())
}

pub(super) async fn admit(
    browser: &Arc<Connection>,
    registry: &SpliceRegistry,
    session: &str,
    daemon_id: &str,
    nonce: &str,
    control: &mut SendStream,
) -> Result<AttachHandle, ()> {
    let deadline = Instant::now() + PROOF_LIFETIME;
    let mut budget = super::RelayDataControl::new(registry);
    let target = registry.candidate_target(session, daemon_id)?;
    let presence = SpliceControlEvent::CounterpartPresent {
        present: target.is_some(),
        counterpart_attachment_id: target.as_ref().map(|target| target.attachment_id.as_u64()),
    };
    timeout_at(deadline, super::write_splice_control(control, &presence))
        .await
        .map_err(|_| ())?
        .map_err(|_| ())?;
    let controls = async {
        loop {
            let paused = budget.next().await;
            super::write_splice_control(control, &SpliceControlEvent::RelayDataPaused { paused })
                .await
                .map_err(|_| ())?;
        }
    };
    let proof = async {
        let Some(crate::splice::CandidateTarget {
            attachment_id: daemon_attachment,
            connection: daemon,
            permits: _permits,
        }) = target
        else {
            // An absent daemon is this candidate's final answer, and the browser
            // escalates to issuance on it. A local close would discard the queued
            // presence record, so the browser closes; the proof lifetime bounds it.
            let _ = timeout_at(deadline, browser.closed()).await;
            return Err(());
        };
        let ((to_browser, mut from_browser), (to_daemon, mut from_daemon)) =
            timeout_at(deadline, async {
                let browser_stream = browser.accept_bi().await.map_err(|_| ())?;
                let daemon_stream = daemon
                    .open_bi()
                    .await
                    .map_err(|_| ())?
                    .await
                    .map_err(|_| ())?;
                Ok::<_, ()>((browser_stream, daemon_stream))
            })
            .await
            .map_err(|_| ())??;
        let mut to_browser = super::ContainedStream::new(to_browser);
        let mut to_daemon = super::ContainedStream::new(to_daemon);
        to_browser.get_mut().ok_or(())?.set_priority(100);
        to_daemon.get_mut().ok_or(())?.set_priority(100);
        // The candidate's proven source address travels with its nonce, so the
        // daemon can offer against the network this carrier came from the
        // moment it commits, before any promotion reports the attachment.
        let address = (*browser.quic_connection().validated_path().borrow())
            .map(|path| crate::splice::canonical_peer_address(path.remote.ip()))
            .ok_or(())?;
        let metadata = serde_json::json!({
            "candidate_nonce": nonce,
            "browser_address": address,
        })
        .to_string();
        timeout_at(
            deadline,
            write_record(to_daemon.get_mut().ok_or(())?, metadata.as_bytes()),
        )
        .await
        .map_err(|_| ())??;

        // JoinSet owns cancellation even if a peer disappears while the opposite
        // direction is blocked. No detached task can retain proof credit.
        let mut ingress = tokio::task::JoinSet::new();
        ingress.spawn(async move {
            loop {
                let bytes = read_record(&mut from_browser).await?;
                write_record(to_daemon.get_mut().ok_or(())?, &bytes).await?;
            }
            #[expect(unreachable_code, reason = "the loop exits only through `?`; this types the task")]
            Ok::<(), ()>(())
        });
        loop {
            let next = async {
                let mut kind = [0];
                from_daemon.read_exact(&mut kind).await.map_err(|_| ())?;
                let bytes = read_record(&mut from_daemon).await?;
                Ok::<_, ()>((kind[0], bytes))
            };
            let (kind, bytes) = tokio::select! {
                _ = browser.closed() => return Err(()),
                _ = daemon.closed() => return Err(()),
                _ = ingress.join_next() => return Err(()),
                received = timeout_at(deadline, next) => received.map_err(|_| ())??,
            };
            match kind {
                0 => timeout_at(
                    deadline,
                    write_record(to_browser.get_mut().ok_or(())?, &bytes),
                )
                .await
                .map_err(|_| ())??,
                1 => {
                    // Compare and attach under the registry's one write lock. A
                    // replaced daemon cannot select a browser for its successor.
                    let handle = registry
                        .promote_candidate(session, daemon_id, daemon_attachment)
                        .map_err(|_| ())?;
                    if !matches!(
                        timeout_at(
                            deadline,
                            write_record(to_browser.get_mut().ok_or(())?, &bytes)
                        )
                        .await,
                        Ok(Ok(()))
                    ) {
                        registry.detach(
                            session,
                            crate::splice::Role::Browser,
                            handle.attachment_id,
                        );
                        return Err(());
                    }
                    ingress.shutdown().await;
                    return Ok(handle);
                }
                _ => return Err(()),
            }
        }
    };
    tokio::select! {
        result = proof => result,
        result = controls => result,
    }
}
