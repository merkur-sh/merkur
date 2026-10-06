//! Bounded upload handoff. The terminal owner never awaits a pipe write.

use std::path::PathBuf;
use std::sync::Arc;

use crossbeam_channel::{Sender, TryRecvError, TrySendError, bounded};
use merkur_graphics::budget::Lease;
use merkur_graphics::command::MAX_CHUNK_BYTES;
use merkur_graphics::processing::DecodeRequest;
use merkur_graphics::publication::Fence;
use tokio::sync::{Notify, oneshot};
use tokio::task::JoinHandle;

use crate::{DecodedImage, Failure, Reservations, Worker};

/// Resource bound: 16 Kitty chunks may wait behind the pipe writer. The byte
/// reservation also covers producer/consumer staging and the fixed channel
/// allocation. This is a capacity bound, not a timer.
pub const QUEUE_CHUNKS: usize = 16;
pub const QUEUE_BYTES: usize = (QUEUE_CHUNKS + 2) * (MAX_CHUNK_BYTES + 64) + 2048;

struct Chunk {
    bytes: [u8; MAX_CHUNK_BYTES],
    len: usize,
    last: bool,
}

pub struct Completion {
    pub fence: Fence,
    pub result: Result<DecodedImage, Failure>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PushError {
    Full,
    Closed,
    Invalid,
}

/// The owner checks capacity/completion after `wake.notified()`. Notifications
/// are hints to inspect exact state; they grant neither credit nor publication.
pub struct Upload {
    _queue: Arc<Lease>,
    input: Option<Sender<Chunk>>,
    input_ready: Arc<Notify>,
    completion: oneshot::Receiver<Completion>,
    cancel: Option<oneshot::Sender<()>>,
    task: Option<JoinHandle<()>>,
}

impl Upload {
    pub fn start(
        executable: PathBuf,
        request: DecodeRequest,
        reservations: Reservations,
        queue: Lease,
        fence: Fence,
        wake: Arc<Notify>,
    ) -> Result<Self, Failure> {
        if queue.charge().bytes < QUEUE_BYTES || queue.charge().objects < QUEUE_CHUNKS + 1 {
            return Err(Failure::Input);
        }
        let queue = Arc::new(queue);
        let worker_queue = Arc::clone(&queue);
        let (input, incoming) = bounded::<Chunk>(QUEUE_CHUNKS);
        let input_ready = Arc::new(Notify::new());
        let receiver_ready = Arc::clone(&input_ready);
        let (done, completion) = oneshot::channel();
        let (cancel, mut cancelled) = oneshot::channel();
        let task = tokio::spawn(async move {
            // Startup has its own work budget. Finish it before honoring cancel
            // so ordinary lifecycle cancellation always has an owned child to reap.
            let result = match Worker::launch(&executable, request, reservations).await {
                Err(error) => Err(error),
                Ok(mut worker) => {
                    let result = loop {
                        let chunk = match incoming.try_recv() {
                            Ok(chunk) => chunk,
                            Err(TryRecvError::Disconnected) => break Err(Failure::Input),
                            Err(TryRecvError::Empty) => {
                                tokio::select! {
                                    biased;
                                    _ = &mut cancelled => break Err(Failure::Input),
                                    _ = receiver_ready.notified() => continue,
                                }
                            }
                        };
                        wake.notify_one();
                        let pushed = tokio::select! {
                            biased;
                            _ = &mut cancelled => break Err(Failure::Input),
                            result = worker.push(&chunk.bytes[..chunk.len], chunk.last) => result,
                        };
                        if let Err(error) = pushed {
                            break Err(error);
                        }
                        if chunk.last {
                            break tokio::select! {
                                biased;
                                _ = &mut cancelled => Err(Failure::Input),
                                result = worker.finish() => result,
                            };
                        }
                    };
                    worker.cancel().await;
                    result
                }
            };
            // Release this task's queue ownership before completion. The owner
            // retains the shared charge while it can still retain a sender.
            drop(incoming);
            drop(worker_queue);
            let _ = done.send(Completion { fence, result });
            wake.notify_one();
        });
        Ok(Self {
            _queue: queue,
            input: Some(input),
            input_ready,
            completion,
            cancel: Some(cancel),
            task: Some(task),
        })
    }

    /// No allocation or copy happens when full. The canonical APC receiver keeps
    /// that one bounded payload and parks until capacity exists or the job ends.
    pub fn try_push(&mut self, bytes: &[u8], last: bool) -> Result<(), PushError> {
        if bytes.len() > MAX_CHUNK_BYTES {
            return Err(PushError::Invalid);
        }
        let sender = self.input.as_ref().ok_or(PushError::Closed)?;
        // This is the only producer; a consumer can only create capacity, so a
        // successful capacity check cannot race a second producer's send.
        if sender.is_full() {
            return Err(PushError::Full);
        }
        let mut chunk = Chunk {
            bytes: [0; MAX_CHUNK_BYTES],
            len: bytes.len(),
            last,
        };
        chunk.bytes[..bytes.len()].copy_from_slice(bytes);
        sender.try_send(chunk).map_err(|error| match error {
            TrySendError::Full(_) => PushError::Full,
            TrySendError::Disconnected(_) => PushError::Closed,
        })?;
        if last {
            self.input.take();
        }
        self.input_ready.notify_one();
        Ok(())
    }

    pub fn try_completion(&mut self) -> Result<Option<Completion>, Failure> {
        match self.completion.try_recv() {
            Ok(completion) => Ok(Some(completion)),
            Err(oneshot::error::TryRecvError::Empty) => Ok(None),
            Err(oneshot::error::TryRecvError::Closed) => Err(Failure::Exit),
        }
    }

    /// Request cancellation without blocking the terminal owner. Completion is
    /// published only after the child is reaped and its input queue is released.
    pub fn request_cancel(&mut self) {
        self.input.take();
        self.cancel.take();
    }

    /// Terminal shutdown and command cancellation join this task before the
    /// runtime exits. Dropping also cancels, but does not synchronously wait.
    pub async fn cancel(mut self) -> Result<(), Failure> {
        self.request_cancel();
        if let Some(task) = self.task.take() {
            task.await.map_err(|_| Failure::Exit)?;
        }
        Ok(())
    }
}

impl Drop for Upload {
    fn drop(&mut self) {
        self.input.take();
        self.cancel.take();
    }
}
