//! Bounded off-owner animation work and its exact completion event.
use super::*;
use merkur_graphics::scene::Image;
use merkur_image_worker::edit::{Cancellation, Plan, Transaction};
use tokio::{sync::oneshot, task::JoinHandle};

/// An edit's own bookkeeping, admitted beside what its plan builds.
const BOOKKEEPING: Usage = Usage {
    bytes: 8192,
    objects: 1,
};

/// An edit admitted on the terminal owner: its plan, exactly the storage the
/// plan builds and the edit's bookkeeping, and a processing slot.
pub(super) struct Admitted {
    plan: Plan,
    storage: merkur_graphics::budget::Lease,
    workspace: merkur_graphics::budget::Lease,
}

pub(super) struct Edit {
    result: oneshot::Receiver<Result<ImageContent, ReplyError>>,
    cancelled: Arc<Cancellation>,
    task: Option<JoinHandle<()>>,
    _lease: Arc<merkur_graphics::budget::Lease>,
}

struct Completion {
    result: Option<oneshot::Sender<Result<ImageContent, ReplyError>>>,
    wake: Arc<Notify>,
}
impl Drop for Completion {
    fn drop(&mut self) {
        self.result.take();
        self.wake.notify_one();
    }
}

impl Edit {
    /// Nothing here can be refused: the owner admitted the edit beforehand.
    pub(super) fn start(
        source: Arc<Image<ImageContent>>,
        control: Control,
        patch: Option<DecodedImage>,
        id: CommandId,
        admitted: Admitted,
        executable: &std::path::Path,
        wake: &Arc<Notify>,
    ) -> Self {
        let Admitted {
            plan,
            mut storage,
            workspace,
        } = admitted;
        let lease = Arc::new(
            storage
                .split(BOOKKEEPING)
                .expect("admitted beside the plan's charge"),
        );
        let cancelled = Arc::new(Cancellation::default());
        let transaction = Transaction {
            source,
            control,
            patch,
            plan,
            revision: id.get(),
            now_us: merkur_graphics::animation::monotonic_us(),
            executable: executable.to_owned(),
            storage,
            workspace,
            cancelled: Arc::clone(&cancelled),
        };
        let (sender, result) = oneshot::channel();
        let mut completion = Completion {
            result: Some(sender),
            wake: Arc::clone(wake),
        };
        let task_lease = Arc::clone(&lease);
        let task = tokio::spawn(async move {
            let result = transaction.run().await;
            if let Some(sender) = completion.result.take() {
                let _ = sender.send(result);
            }
            drop(task_lease);
            drop(completion);
        });
        Self {
            result,
            cancelled,
            task: Some(task),
            _lease: lease,
        }
    }

    pub(super) fn poll(&mut self) -> Option<Result<ImageContent, ReplyError>> {
        match self.result.try_recv() {
            Ok(result) => Some(result),
            Err(oneshot::error::TryRecvError::Empty) => None,
            Err(oneshot::error::TryRecvError::Closed) => Some(Err(ReplyError::Worker)),
        }
    }
    pub(super) fn request_cancel(&self) {
        self.cancelled.cancel();
    }
    pub(super) async fn cancel(mut self) {
        self.request_cancel();
        if let Some(task) = self.task.take() {
            let _ = task.await;
        }
    }
}
impl Drop for Edit {
    fn drop(&mut self) {
        self.request_cancel();
    }
}

pub(super) fn is_command(control: &Control) -> bool {
    matches!(control.action(), Ok(Action::Animate | Action::Compose))
        || (control.action() == Ok(Action::Delete)
            && matches!(control.get(Key::Delete), Some(value) if value == u32::from(b'f') || value == u32::from(b'F')))
}

impl Graphics {
    /// Validate and size an edit, then admit all of its storage here: its
    /// transaction runs off the owner, where a refusal could neither wait nor
    /// retry. A shortfall waits for the releases in flight like any storage
    /// refusal on the parser path, and an edit that fits never waits for them.
    fn admit_edit(
        &self,
        source: &Image<ImageContent>,
        control: &Control,
        patch: Option<[u32; 2]>,
    ) -> Result<Admitted, Refused> {
        let plan = Plan::new(source, control, patch)?;
        let storage = self
            .storage
            .reserve(Usage {
                bytes: plan.charge().bytes + BOOKKEEPING.bytes,
                objects: plan.charge().objects + BOOKKEEPING.objects,
            })
            .ok_or_else(|| self.storage_refusal())?;
        let workspace = self
            .processing
            .reserve(Usage {
                bytes: WORKSPACE_BYTES,
                objects: 1,
            })
            .ok_or(ReplyError::Quota)?;
        Ok(Admitted {
            plan,
            storage,
            workspace,
        })
    }

    /// Admit and start the edit of a frame command whose patch is decoded: its
    /// storage is sized from the patch. True while a shortfall waits for the
    /// releases in flight; the job keeps the patch, and admission starts over
    /// once they land.
    pub(super) fn start_frame_edit(&self, job: &mut Job) -> bool {
        let Some(patch) = job.patch.take() else {
            return false;
        };
        let control = job.frame_control();
        let size = [patch.pixels().width(), patch.pixels().height()];
        let admitted = job
            .fence
            .ok_or(ReplyError::Worker)
            .and_then(|fence| {
                self.scene
                    .image(fence.image)
                    .cloned()
                    .ok_or(ReplyError::MissingImage)
            })
            .map_err(Refused::from)
            .and_then(|source| Ok((self.admit_edit(&source, &control, Some(size))?, source)));
        match admitted {
            Ok((admitted, source)) => {
                job.edit = Some(Edit::start(
                    source,
                    control,
                    Some(patch),
                    job.id,
                    admitted,
                    &self.executable,
                    &self.wake,
                ));
                false
            }
            Err(Refused::Wait) => {
                job.patch = Some(patch);
                true
            }
            Err(Refused::Reply(error)) => {
                job.result = Some(Err(error));
                false
            }
        }
    }

    pub(super) fn start_edit_command(
        &mut self,
        term: &mut Term<EventForwarder>,
        id: CommandId,
        control: Control,
    ) -> Result<Option<Job>, Refused> {
        let incarnation = match self.scene.resolve(&control) {
            // Deleting frames of an absent image deletes nothing, silently.
            Err(merkur_graphics::scene::SceneError::MissingImage)
                if control.action() == Ok(Action::Delete) =>
            {
                return Ok(None);
            }
            result => result.map_err(ReplyError::from)?,
        };
        let source = Arc::clone(
            self.scene
                .image(incarnation)
                .ok_or(ReplyError::MissingImage)?,
        );
        if control.action() == Ok(Action::Delete)
            && source
                .content
                .animation()
                .is_none_or(|image| image.frames().len() == 1)
        {
            if control.get(Key::Delete) == Some(u32::from(b'F')) {
                self.remove_image_placements(term, incarnation);
                if let Some(removed) = self.scene.remove(incarnation) {
                    retire(&mut self.releases, removed);
                }
            }
            return Ok(None);
        }
        let admitted = self.admit_edit(&source, &control, None)?;
        let fence = self
            .scene
            .begin_edit(id, incarnation)
            .map_err(|error| self.scene_refusal(error))?;
        let edit = Edit::start(
            source,
            control,
            None,
            id,
            admitted,
            &self.executable,
            &self.wake,
        );
        Ok(Some(Job {
            id,
            control,
            frame: None,
            fence: Some(fence),
            upload: None,
            patch: None,
            edit: Some(edit),
            result: None,
            placement: None,
            final_chunk: true,
            command: true,
        }))
    }
}
