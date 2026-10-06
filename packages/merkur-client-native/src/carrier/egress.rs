//! Credits remain owned until the stream finishes writing each record.
use crate::credit::{Credit, Lease};
use tokio::sync::{mpsc, oneshot};

#[derive(Clone)]
pub(crate) struct Writer {
    sender: mpsc::UnboundedSender<Record>,
    credit: Credit,
}
pub(super) struct Record {
    pub payload: Vec<u8>,
    pub lease: Lease,
    pub completed: oneshot::Sender<()>,
}
pub(crate) struct Completion(oneshot::Receiver<()>);
impl Completion {
    /// A record no writer took: it resolves as not written.
    pub(super) fn unwritten() -> Self {
        Self(oneshot::channel().1)
    }

    pub(crate) async fn written(self) -> bool {
        self.0.await.is_ok()
    }
}
pub(crate) struct Pending {
    writer: Writer,
    payload: Vec<u8>,
}
impl Writer {
    pub(super) fn channel() -> (Self, mpsc::UnboundedReceiver<Record>) {
        let (sender, receiver) = mpsc::unbounded_channel();
        (
            Self {
                sender,
                credit: Credit::new(16, 32 * 1024 * 1024),
            },
            receiver,
        )
    }
    pub(crate) fn send(&self, payload: Vec<u8>) -> Result<Completion, Pending> {
        let bytes = payload.capacity() + std::mem::size_of::<Record>();
        match self.credit.try_reserve(bytes) {
            Ok(lease) => {
                let (completed, completion) = oneshot::channel();
                match self.sender.send(Record {
                    payload,
                    lease,
                    completed,
                }) {
                    Ok(()) => Ok(Completion(completion)),
                    Err(error) => Err(Pending {
                        writer: self.clone(),
                        payload: error.0.payload,
                    }),
                }
            }
            Err(_) => Err(Pending {
                writer: self.clone(),
                payload,
            }),
        }
    }
}
impl Pending {
    pub(crate) async fn admit(self) -> bool {
        let bytes = self.payload.capacity() + std::mem::size_of::<Record>();
        let lease = tokio::select! {
            lease = self.writer.credit.reserve(bytes) => lease,
            () = self.writer.sender.closed() => None,
        };
        let Some(lease) = lease else {
            return false;
        };
        let (completed, completion) = oneshot::channel();
        if self
            .writer
            .sender
            .send(Record {
                payload: self.payload,
                lease,
                completed,
            })
            .is_err()
        {
            return false;
        }
        completion.await.is_ok()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn stalled_writer_retains_credits_without_blocking_another_writer() {
        let (one, mut incoming) = Writer::channel();
        let (two, mut other) = Writer::channel();
        for _ in 0..16 {
            assert!(one.send(vec![1]).is_ok());
        }
        let pending = one.send(vec![2]).err().unwrap();
        let mut waiting = Box::pin(pending.admit());
        assert!(futures::poll!(&mut waiting).is_pending());
        assert!(two.send(vec![3]).is_ok());
        assert_eq!(other.recv().await.unwrap().payload, vec![3]);
        let writing = incoming.recv().await.unwrap();
        assert!(futures::poll!(&mut waiting).is_pending());
        drop(writing);
        assert!(futures::poll!(&mut waiting).is_pending());
        let mut last = None;
        while let Ok(record) = incoming.try_recv() {
            last = Some(record);
        }
        last.unwrap().completed.send(()).unwrap();
        assert!(waiting.await);
        drop(incoming);
        assert!(one.send(vec![4]).is_err());
    }
    #[tokio::test]
    async fn enqueue_and_dequeue_do_not_report_write_completion() {
        let (writer, mut receiver) = Writer::channel();
        let completion = writer.send(vec![9]).ok().unwrap();
        let mut written = Box::pin(completion.written());
        assert!(futures::poll!(&mut written).is_pending());
        let record = receiver.recv().await.unwrap();
        assert!(futures::poll!(&mut written).is_pending());
        record.completed.send(()).unwrap();
        assert!(written.await);
        drop(record.lease);
    }
    #[tokio::test]
    async fn retirement_releases_a_pending_writer_without_waiting_for_quic() {
        let (one, incoming) = Writer::channel();
        for _ in 0..16 {
            assert!(one.send(vec![1]).is_ok());
        }
        let pending = one.send(vec![2]).err().unwrap();
        drop(incoming);
        assert!(!pending.admit().await);
    }
}
