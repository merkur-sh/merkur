//! Bounded, attachment-owned signaling for a tentative browser carrier.
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tokio::sync::{Semaphore, mpsc};
use wtransport::{Connection, RecvStream, SendStream};

const MAX_RECORD: usize = 64 * 1024;
const ATTEMPT_LIFETIME: Duration = Duration::from_secs(10);

pub(crate) struct CandidateReply {
    pub(crate) nonce: [u8; 32],
    /// The candidate carrier's proven source address, as the edge validated
    /// it. A rebind that commits this candidate offers against it.
    pub(crate) browser_address: std::net::IpAddr,
    closed: AtomicBool,
    committed: AtomicBool,
    responses: mpsc::Sender<(bool, Vec<u8>)>,
}

impl CandidateReply {
    #[cfg(test)]
    pub(crate) fn test_pair(nonce: [u8; 32]) -> (Arc<Self>, mpsc::Receiver<(bool, Vec<u8>)>) {
        let (responses, receiver) = mpsc::channel(2);
        (
            Arc::new(Self {
                nonce,
                browser_address: std::net::Ipv4Addr::new(203, 0, 113, 9).into(),
                closed: AtomicBool::new(false),
                committed: AtomicBool::new(false),
                responses,
            }),
            receiver,
        )
    }

    pub(crate) fn is_closed(&self) -> bool {
        self.closed.load(Ordering::Acquire)
    }
    pub(crate) fn commit(&self) {
        self.committed.store(true, Ordering::Release);
    }
    pub(crate) fn send(&self, bytes: Vec<u8>, select: bool) -> bool {
        !self.is_closed()
            && self
                .responses
                .try_send((select && self.committed.load(Ordering::Acquire), bytes))
                .is_ok()
    }
}

struct CloseReply(Arc<CandidateReply>);
impl Drop for CloseReply {
    fn drop(&mut self) {
        self.0.closed.store(true, Ordering::Release);
    }
}

pub(crate) struct CandidateMessage {
    pub(crate) reply: Arc<CandidateReply>,
    pub(crate) payload: Option<Vec<u8>>,
}

pub(crate) async fn reply(
    network: &Arc<tokio::sync::RwLock<crate::network::NetworkState>>,
    peer: &str,
    candidate: Option<&Arc<CandidateReply>>,
    bytes: Vec<u8>,
    select: bool,
) -> bool {
    match candidate {
        Some(candidate) => candidate.send(bytes, select),
        None => crate::network::send_signaling_to_peer(network, peer, bytes).await,
    }
}

async fn read_record(recv: &mut RecvStream) -> Result<Vec<u8>, ()> {
    let mut header = [0; 4];
    recv.read_exact(&mut header).await.map_err(|_| ())?;
    let length = u32::from_be_bytes(header) as usize;
    if length == 0 || length > MAX_RECORD {
        return Err(());
    }
    let mut bytes = vec![0; length];
    recv.read_exact(&mut bytes).await.map_err(|_| ())?;
    Ok(bytes)
}

async fn write_response(send: &mut SendStream, select: bool, bytes: &[u8]) -> Result<(), ()> {
    send.write_all(&[u8::from(select)]).await.map_err(|_| ())?;
    send.write_all(&(bytes.len() as u32).to_be_bytes())
        .await
        .map_err(|_| ())?;
    send.write_all(bytes).await.map_err(|_| ())
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct Metadata {
    candidate_nonce: String,
    browser_address: std::net::IpAddr,
}

async fn serve(mut send: SendStream, mut recv: RecvStream, events: mpsc::Sender<CandidateMessage>) {
    let deadline = tokio::time::Instant::now() + ATTEMPT_LIFETIME;
    let Ok(Ok(metadata)) = tokio::time::timeout_at(deadline, read_record(&mut recv)).await else {
        return;
    };
    let Ok(metadata) = serde_json::from_slice::<Metadata>(&metadata) else {
        return;
    };
    let Ok(nonce) = crate::auth::decode_canonical_array::<32>(&metadata.candidate_nonce) else {
        return;
    };
    let (responses, mut response_rx) = mpsc::channel(2);
    let reply = Arc::new(CandidateReply {
        nonce,
        browser_address: metadata.browser_address.to_canonical(),
        closed: AtomicBool::new(false),
        committed: AtomicBool::new(false),
        responses,
    });
    let _close_reply = CloseReply(reply.clone());
    send.set_priority(100);
    let mut readers = tokio::task::JoinSet::new();
    let reader_events = events.clone();
    let reader_reply = reply.clone();
    readers.spawn(async move {
        loop {
            let bytes = read_record(&mut recv).await?;
            reader_events
                .send(CandidateMessage {
                    reply: reader_reply.clone(),
                    payload: Some(bytes),
                })
                .await
                .map_err(|_| ())?;
        }
        #[expect(unreachable_code, reason = "the loop exits only through `?`; this types the task")]
        Ok::<(), ()>(())
    });
    loop {
        let response = tokio::select! {
            _ = tokio::time::sleep_until(deadline) => break,
            _ = readers.join_next() => break,
            response = response_rx.recv() => response,
        };
        let Some((select, bytes)) = response else {
            break;
        };
        if !matches!(
            tokio::time::timeout_at(deadline, write_response(&mut send, select, &bytes)).await,
            Ok(Ok(()))
        ) {
            break;
        }
        if select {
            break;
        }
    }
    reply.closed.store(true, Ordering::Release);
    readers.shutdown().await;
    let _ = events
        .send(CandidateMessage {
            reply,
            payload: None,
        })
        .await;
}

pub(crate) fn spawn(connection: Arc<Connection>) -> mpsc::Receiver<CandidateMessage> {
    // Two candidates per signaling attachment, one queued request per reader;
    // terminal ingress and incumbent signaling own independent queues.
    let (events, receiver) = mpsc::channel(2);
    tokio::spawn(async move {
        let slots = Arc::new(Semaphore::new(2));
        let mut tasks = tokio::task::JoinSet::new();
        loop {
            tokio::select! {
                _ = connection.closed() => break,
                _ = tasks.join_next(), if !tasks.is_empty() => {},
                accepted = connection.accept_bi() => {
                    let Ok((send, recv)) = accepted else { break; };
                    let Ok(permit) = slots.clone().try_acquire_owned() else { continue; };
                    let events = events.clone();
                    tasks.spawn(async move { let _permit = permit; serve(send, recv, events).await; });
                }
            }
        }
        tasks.shutdown().await;
    });
    receiver
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_this_candidates_commit_can_select_its_attachment() {
        let (responses, mut received) = mpsc::channel(2);
        let candidate = Arc::new(CandidateReply {
            nonce: [1; 32],
            browser_address: std::net::Ipv4Addr::new(203, 0, 113, 9).into(),
            closed: AtomicBool::new(false),
            committed: AtomicBool::new(false),
            responses,
        });
        assert!(candidate.send(vec![1], true));
        assert_eq!(received.try_recv().unwrap(), (false, vec![1]));
        candidate.commit();
        assert!(candidate.send(vec![2], true));
        assert_eq!(received.try_recv().unwrap(), (true, vec![2]));
        // Aborting the serving task revokes the exact reply owner even while
        // the serialized session loop still holds its Arc.
        drop(CloseReply(candidate.clone()));
        assert!(candidate.is_closed());
        assert!(!candidate.send(vec![3], true));
        assert!(received.try_recv().is_err());
    }

    #[test]
    fn a_blocked_candidate_has_bounded_response_credit() {
        let (responses, _received) = mpsc::channel(2);
        let candidate = CandidateReply {
            nonce: [1; 32],
            browser_address: std::net::Ipv4Addr::new(203, 0, 113, 9).into(),
            closed: AtomicBool::new(false),
            committed: AtomicBool::new(false),
            responses,
        };
        assert!(candidate.send(vec![1], false));
        assert!(candidate.send(vec![2], false));
        assert!(!candidate.send(vec![3], false));
    }
}
