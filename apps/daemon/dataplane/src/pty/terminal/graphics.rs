//! Graphics jobs are driven by the terminal owner, never by the APC callback.
//! A decoder completion owns pixels, not permission to publish or answer a query.

use alacritty_terminal::grid::{Dimensions, GridAnchor, ImageAnchorBounds};
use std::collections::{BTreeMap, VecDeque};
use std::num::NonZeroU64;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, LazyLock};

use alacritty_terminal::term::Term;
use merkur_graphics::budget::{Aggregate, Budget, Usage};
use merkur_graphics::command::{Action, Control, Error, Format, Key};
use merkur_graphics::geometry::{CELL_UNIT, CellMetrics, CellRect, Geometry};
use merkur_graphics::ingest::{CommandId, Step};
use merkur_graphics::placements::{
    AnchorId, Origin, PlacementId, PlacementOrigin, PlacementRequest, Placements, Position,
};
use merkur_graphics::processing::{DecodeRequest, MAX_RGBA_BYTES, pixel_bytes};
use merkur_graphics::publication::{Fence, ImageIncarnation, TerminalIncarnation};
use merkur_graphics::reply::{Reply, ReplyError};
use merkur_graphics::scene::{Image, Published, Scene, SceneContent};
use merkur_image_worker::content::ImageContent;
use merkur_image_worker::retirement::Completion;
use merkur_image_worker::upload::{PushError, QUEUE_BYTES, QUEUE_CHUNKS, Upload};
use merkur_image_worker::{DecodedImage, Failure, Reservations, WORKSPACE_BYTES};
use tokio::sync::Notify;

use super::{EventForwarder, TerminalEvent};

mod animation;
mod native;
mod placeholders;
mod projector;
mod visibility;

pub(crate) use native::Endpoint as NativeEndpoint;

/// Storage resource bound, including admission for output, live image roots,
/// retired images a reader still holds, and the projector's own rows; a display
/// capture of a row holds no charge. Transient processing has a distinct bound so
/// storage accounting cannot silently borrow the decoder's workspace allowance.
const STORAGE_BYTES: usize = 128 * 1024 * 1024;
const STORAGE_OBJECTS: usize = 8192;

/// Shared admission across all terminals, including detached terminals and
/// retired images still held. These are resource ceilings, not scheduler heuristics.
const DAEMON_STORAGE_BYTES: usize = 512 * 1024 * 1024;
const DAEMON_STORAGE_OBJECTS: usize = 32768;
const DAEMON_DECODERS: usize = 2;

struct Resources {
    storage: Aggregate,
    processing: Aggregate,
}

impl Resources {
    fn new() -> Self {
        Self {
            storage: Aggregate::new(Usage {
                bytes: DAEMON_STORAGE_BYTES,
                objects: DAEMON_STORAGE_OBJECTS,
            }),
            processing: Aggregate::new(Usage {
                bytes: DAEMON_DECODERS * (WORKSPACE_BYTES + QUEUE_BYTES),
                objects: DAEMON_DECODERS * (QUEUE_CHUNKS + 2),
            }),
        }
    }
}

static RESOURCES: LazyLock<Resources> = LazyLock::new(Resources::new);

/// Process-local publication domains never repeat, even when a terminal is reset.
/// This is an ownership identity, not a cryptographic nonce or a wire identifier.
static NEXT_TERMINAL: AtomicU64 = AtomicU64::new(1);

struct Job {
    id: CommandId,
    control: Control,
    /// A frame command's target once its image resolves; see `frame_target`.
    frame: Option<u32>,
    fence: Option<Fence>,
    upload: Option<Upload>,
    /// A frame command's decoded patch until its edit is admitted, which sizes
    /// the edit's storage from it; a shortfall waits with the patch here.
    patch: Option<DecodedImage>,
    edit: Option<animation::Edit>,
    result: Option<Result<ImageContent, ReplyError>>,
    /// A transmit-and-place's placement metadata; see `PlacementMetadata`.
    placement: Option<PlacementMetadata>,
    command: bool,
    final_chunk: bool,
}

/// A transmit-and-place holds its placement's metadata from admission on: once
/// its image is published nothing can refuse the placement, and nothing after
/// publication could wait.
enum PlacementMetadata {
    /// Reserved with the upload.
    Admitted(merkur_graphics::budget::Lease),
    /// The upload replaces this placed image. Publication removes the image's
    /// placements before it places, and the first of them removed, then or
    /// earlier, hands its metadata over: the command needs no more storage than
    /// its final state holds.
    Replacing(ImageIncarnation),
}

impl Job {
    /// The frame transaction and every reply name the resolved target frame.
    fn frame_control(&self) -> Control {
        self.frame
            .map_or(self.control, |frame| self.control.with_frame_reply(frame))
    }

    /// A command refused before it started, holding its identity until its
    /// final chunk: a refusal never turns its suffix into a new upload.
    fn refused(id: CommandId, control: Control, frame: Option<u32>, error: ReplyError) -> Self {
        Self {
            id,
            control,
            frame,
            fence: None,
            upload: None,
            patch: None,
            result: Some(Err(error)),
            edit: None,
            placement: None,
            command: false,
            final_chunk: false,
        }
    }
}

/// Why a command did not start.
enum Refused {
    /// Storage is short while a removed source's physical release is in flight.
    /// Read after the releases land, the same command might fit, so the parser
    /// waits for them and answers only a shortfall they leave: the answer does
    /// not depend on when the retirement thread runs.
    Wait,
    Reply(ReplyError),
}

impl Refused {
    /// The answer to a refusal nothing will retry.
    fn reply(self) -> ReplyError {
        match self {
            Self::Wait => ReplyError::Quota,
            Self::Reply(error) => error,
        }
    }
}

// Storage refusals never convert: `Graphics::storage_refusal` decides between an
// answer and a wait, so scene and placement quota errors are mapped explicitly.
impl From<ReplyError> for Refused {
    fn from(error: ReplyError) -> Self {
        Self::Reply(error)
    }
}

impl From<merkur_graphics::geometry::GeometryError> for Refused {
    fn from(error: merkur_graphics::geometry::GeometryError) -> Self {
        Self::Reply(error.into())
    }
}

/// Record the physical release of a source this terminal removed; its storage
/// returns on the retirement thread once the last reader drops it. Releases land
/// oldest first unless a reader holds one, so dropping the landed front keeps the
/// queue to what is in flight in amortized constant time.
fn retire(releases: &mut VecDeque<Arc<Completion>>, image: Arc<Image<ImageContent>>) {
    while releases.front().is_some_and(|release| release.is_done()) {
        releases.pop_front();
    }
    releases.push_back(image.content.released());
}

pub(super) struct Graphics {
    /// Once image content enters this terminal, reconnect snapshots must never
    /// become disk-cache candidates, including after image deletion or RIS.
    pub(super) memory_only: bool,
    pub(super) projected: Vec<merkur_codec::PreparedGraphics>,
    /// Each `projected` row's charge, `None` for an empty row. A capture shares a
    /// row's bytes and version but never its charge, so superseding a row refunds
    /// it here whatever a slow or silent viewer still holds.
    projected_leases: Vec<Option<merkur_graphics::budget::Lease>>,
    projected_storage: Option<merkur_graphics::budget::Lease>,
    projection_workspace: Option<Box<projector::Workspace>>,
    projection_dirty: bool,
    projection_reset: bool,
    /// Physical releases of the sources this terminal removed, until each lands.
    /// A source's storage returns on the retirement thread, never synchronously:
    /// while any is in flight, a storage refusal waits for them rather than
    /// answering, and no source is evicted for the projection.
    releases: VecDeque<Arc<Completion>>,
    /// The parser waits on `releases`; the owner loop wakes it as they land.
    admission_waiting: bool,
    /// A projection deferred behind `releases`; the owner loop resumes it.
    projection_deferred: bool,
    /// A source root was published since the owner last took this. Graphics
    /// requests parked for an absent root re-resolve on it.
    pub(super) published: bool,
    placeholders: Option<Box<placeholders::Index>>,
    scene: Scene<ImageContent>,
    storage: Budget,
    placements: Placements,
    anchors: BTreeMap<AnchorId, GridAnchor>,
    last_anchor: u64,
    processing: Budget,
    executable: PathBuf,
    native: Option<native::Broker>,
    job: Option<Job>,
    pub(super) wake: Arc<Notify>,
}

impl Graphics {
    pub(super) fn new() -> Self {
        Self::with_resources(&RESOURCES)
    }

    /// Admission of a daemon of its own, for tests that stand in for separate
    /// daemons within one process.
    #[cfg(test)]
    pub(super) fn with_own_daemon() -> Self {
        Self::with_resources(&Resources::new())
    }

    fn with_resources(resources: &Resources) -> Self {
        let id = NEXT_TERMINAL
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |id| id.checked_add(1))
            .expect("terminal publication identity exhausted");
        let mut terminal = [0; 16];
        terminal[..8].copy_from_slice(&id.to_le_bytes());
        let storage = resources.storage.partition(Usage {
            bytes: STORAGE_BYTES,
            objects: STORAGE_OBJECTS,
        });
        Self {
            memory_only: false,
            projected: Vec::new(),
            projected_leases: Vec::new(),
            projected_storage: None,
            projection_workspace: None,
            projection_dirty: false,
            projection_reset: false,
            releases: VecDeque::new(),
            admission_waiting: false,
            projection_deferred: false,
            published: false,
            placeholders: None,
            scene: Scene::new(TerminalIncarnation(terminal), storage.clone()),
            placements: Placements::new(storage.clone()),
            anchors: BTreeMap::new(),
            last_anchor: 0,
            storage,
            processing: resources.processing.partition(Usage {
                bytes: WORKSPACE_BYTES + QUEUE_BYTES,
                objects: QUEUE_CHUNKS + 2,
            }),
            executable: std::env::current_exe()
                .expect("dataplane executable path")
                .with_file_name("merkur-image-worker"),
            native: None,
            job: None,
            wake: Arc::new(Notify::new()),
        }
    }

    /// The helper `bun run build:image-worker` builds, one level above the test
    /// binary's `deps` directory: the lane that runs real-helper tests builds it
    /// first, with the same profile and target directory. Production resolves
    /// the helper beside the dataplane binary.
    #[cfg(test)]
    pub(super) fn built_worker() -> PathBuf {
        let executable = std::env::current_exe()
            .expect("test executable path")
            .parent()
            .and_then(std::path::Path::parent)
            .expect("test binaries run from the target's deps directory")
            .join("merkur-image-worker");
        assert!(
            executable.is_file(),
            "{} is missing: run `bun run build:image-worker` first",
            executable.display()
        );
        executable
    }

    /// A test owner with its own resource ceilings that runs [`Self::built_worker`].
    /// Production runs the helper under daemon ceilings.
    #[cfg(test)]
    pub(super) fn with_built_worker() -> Self {
        let mut graphics = Self::with_resources(&Resources::new());
        graphics.executable = Self::built_worker();
        graphics
    }

    /// Whether any visible row carries a projected placement.
    pub(super) fn projects_any_row(&self) -> bool {
        self.projected.iter().any(|row| !row.is_empty())
    }

    pub(super) fn row(&self, row: usize) -> &merkur_codec::PreparedGraphics {
        self.projected
            .get(row)
            .unwrap_or(&merkur_codec::PreparedGraphics::EMPTY)
    }

    /// Replace the projection with rows whose charges stay with the caller; see
    /// `TerminalState::publish_graphics_projection`.
    #[cfg(test)]
    pub(super) fn publish_projection(&mut self, rows: Vec<merkur_codec::PreparedGraphics>) {
        self.memory_only |= rows.iter().any(|row| !row.is_empty());
        self.projected = rows;
        self.projected_leases.clear();
    }

    #[cfg(test)]
    pub(super) fn storage_used(&self) -> Usage {
        self.storage.used().expect("storage accounting")
    }

    /// Reserve all of this terminal's storage but `free`, so a test sees exactly
    /// what then fits.
    #[cfg(test)]
    pub(super) fn leave_storage(&self, free: Usage) -> merkur_graphics::budget::Lease {
        let used = self.storage_used();
        self.storage
            .reserve(Usage {
                bytes: STORAGE_BYTES - used.bytes - free.bytes,
                objects: STORAGE_OBJECTS - used.objects - free.objects,
            })
            .expect("the partition has room to leave")
    }

    pub(super) fn source(&self, root: &[u8; 32]) -> Option<Arc<Image<ImageContent>>> {
        self.scene.source(root).cloned()
    }

    #[cfg(test)]
    pub(super) fn image(&self, id: u32) -> Option<Arc<Image<ImageContent>>> {
        self.scene.image(self.scene.resolve_id(id)?).cloned()
    }

    fn release_pending(&self) -> bool {
        self.releases.iter().any(|release| !release.is_done())
    }

    /// A storage refusal is an answer only once no removed source's release is in
    /// flight; before that, the parser waits for the releases.
    fn storage_refusal(&self) -> Refused {
        if self.release_pending() {
            Refused::Wait
        } else {
            Refused::Reply(ReplyError::Quota)
        }
    }

    fn scene_refusal(&self, error: merkur_graphics::scene::SceneError) -> Refused {
        match error {
            merkur_graphics::scene::SceneError::Quota => self.storage_refusal(),
            error => Refused::Reply(error.into()),
        }
    }

    fn placement_refusal(&self, error: merkur_graphics::placements::PlacementError) -> Refused {
        match error {
            merkur_graphics::placements::PlacementError::Quota => self.storage_refusal(),
            error => Refused::Reply(error.into()),
        }
    }

    /// The release the owner loop waits on, while the parser or a deferred
    /// projection needs one; each wait ends at an actual landing.
    pub(super) fn release(&self) -> Option<Arc<Completion>> {
        if !self.admission_waiting && !self.projection_deferred {
            return None;
        }
        self.releases
            .iter()
            .find(|release| !release.is_done())
            .or(self.releases.front())
            .cloned()
    }

    /// A release landed: drop the landed ones. Returns whether a projection was
    /// deferred behind them and whether the parser waits on them; both retry, and
    /// either waits again if what it needs is still in flight.
    pub(super) fn observe_releases(&mut self) -> (bool, bool) {
        self.releases.retain(|release| !release.is_done());
        (
            std::mem::take(&mut self.projection_deferred),
            std::mem::take(&mut self.admission_waiting),
        )
    }

    pub(super) fn enable_native(&mut self) -> std::io::Result<NativeEndpoint> {
        if self.native.is_some() {
            return Err(std::io::Error::other("native ingress already installed"));
        }
        let (broker, endpoint) = native::Broker::start(
            self.storage.clone(),
            self.processing.clone(),
            self.executable.clone(),
        )?;
        self.native = Some(broker);
        Ok(endpoint)
    }

    /// Kitty's frame numbering: `r` naming an existing frame edits it; zero or
    /// any later number appends the next frame. Once the image resolves, every
    /// reply to the frame command names this frame, including failures.
    fn frame_target(&self, control: &Control) -> Option<u32> {
        if control.action() != Ok(Action::Frame) {
            return None;
        }
        let image = self.scene.image(self.scene.resolve(control).ok()?)?;
        let frames = image
            .content
            .animation()
            .map_or(1, |animation| animation.frames().len()) as u32;
        Some(
            control
                .get(Key::Rows)
                .filter(|frame| (1..=frames).contains(frame))
                .unwrap_or(frames + 1),
        )
    }

    /// Admit a transmission, query or frame command. Every storage admission a
    /// wait can retry precedes anything irreversible (a job, a fence, a consumed
    /// native reference), so a waiting command starts over from here. A frame's
    /// edit is admitted once its patch is decoded, and waits with its job.
    fn start(
        &mut self,
        id: CommandId,
        control: Control,
        frame: Option<u32>,
        encoded: &[u8],
    ) -> Result<Job, Refused> {
        if !matches!(
            control.action(),
            Ok(Action::Transmit | Action::TransmitAndPlace | Action::Query | Action::Frame)
        ) {
            return Err(ReplyError::Protocol(Error::UnsupportedAction).into());
        }
        // A transmit-and-place is admitted whole here; see `PlacementMetadata`.
        let placement = if control.action() == Ok(Action::TransmitAndPlace) {
            PlacementRequest::from_control(&control).map_err(ReplyError::Protocol)?;
            // The image this upload replaces, as `Scene::begin` resolves it: a
            // number names a new image.
            let replaced = control
                .get(Key::ImageId)
                .and_then(|id| self.scene.resolve_id(id))
                .filter(|image| self.placements.image_placements(*image).next().is_some());
            Some(match replaced {
                Some(image) => PlacementMetadata::Replacing(image),
                None => PlacementMetadata::Admitted(
                    self.storage
                        .reserve(Usage {
                            bytes: merkur_graphics::placements::PLACEMENT_METADATA_BYTES,
                            objects: 1,
                        })
                        .ok_or_else(|| self.storage_refusal())?,
                ),
            })
        } else {
            None
        };
        if control.native_reference() {
            if control.action() == Ok(Action::Frame) {
                let incarnation = self.scene.resolve(&control).map_err(ReplyError::from)?;
                let fence = self
                    .scene
                    .begin_edit(id, incarnation)
                    .map_err(|error| self.scene_refusal(error))?;
                // The one-use reference is consumed only once admission can no
                // longer start over; the edit's own admission waits with the job.
                let Some(image) = self
                    .native
                    .as_ref()
                    .and_then(|broker| broker.consume(encoded))
                else {
                    self.scene.cancel();
                    return Err(ReplyError::MissingImage.into());
                };
                let mut job = Job {
                    id,
                    control,
                    frame,
                    fence: Some(fence),
                    upload: None,
                    patch: Some(image),
                    result: None,
                    edit: None,
                    placement: None,
                    command: false,
                    final_chunk: false,
                };
                self.admission_waiting |= self.start_frame_edit(&mut job);
                return Ok(job);
            }
            let fence = self
                .scene
                .begin(id, &control)
                .map_err(|error| self.scene_refusal(error))?;
            // The one-use reference is consumed only once admission can no longer wait.
            let Some(image) = self
                .native
                .as_ref()
                .and_then(|broker| broker.consume(encoded))
            else {
                self.scene.cancel();
                return Err(ReplyError::MissingImage.into());
            };
            return Ok(Job {
                id,
                control,
                frame,
                fence: Some(fence),
                upload: None,
                patch: None,
                result: Some(Ok(ImageContent::Static(image))),
                edit: None,
                placement,
                command: false,
                final_chunk: false,
            });
        }
        let request = DecodeRequest::from_control(&control).map_err(ReplyError::Protocol)?;
        request
            .inflated_limit()
            .ok_or(ReplyError::Protocol(Error::InvalidControl))?;
        let output = if request.format == Format::Png {
            MAX_RGBA_BYTES
        } else {
            pixel_bytes(request.width, request.height, 4)
                .ok_or(ReplyError::Protocol(Error::InvalidControl))?
        };
        let reserve = |bytes, objects| {
            self.processing
                .reserve(Usage { bytes, objects })
                .ok_or(ReplyError::Quota)
        };
        let workspace = reserve(WORKSPACE_BYTES, 1)?;
        let output = self
            .storage
            .reserve(Usage {
                bytes: output + merkur_image_worker::OUTPUT_METADATA_BYTES,
                objects: 1,
            })
            .ok_or_else(|| self.storage_refusal())?;
        let queue = reserve(QUEUE_BYTES, QUEUE_CHUNKS + 1)?;
        let fence = if control.action() == Ok(Action::Frame) {
            let image = self.scene.resolve(&control).map_err(ReplyError::from)?;
            self.scene.begin_edit(id, image)
        } else {
            self.scene.begin(id, &control)
        }
        .map_err(|error| self.scene_refusal(error))?;
        let upload = match Upload::start(
            self.executable.clone(),
            request,
            Reservations { workspace, output },
            queue,
            fence,
            Arc::clone(&self.wake),
        ) {
            Ok(upload) => upload,
            Err(_) => {
                self.scene.cancel();
                return Err(ReplyError::Worker.into());
            }
        };
        Ok(Job {
            id,
            control,
            frame,
            fence: Some(fence),
            upload: Some(upload),
            patch: None,
            result: None,
            edit: None,
            placement,
            command: false,
            final_chunk: false,
        })
    }

    fn poll_job(&mut self) {
        let Some(job) = &mut self.job else {
            return;
        };
        if let Some(edit) = &mut job.edit {
            if let Some(result) = edit.poll() {
                job.result = Some(result);
                job.edit = None;
            }
            return;
        }
        if let Some(upload) = &mut job.upload {
            let result = match upload.try_completion() {
                Ok(None) => return,
                Ok(Some(completion)) if Some(completion.fence) == job.fence => {
                    completion.result.map_err(|error| match error {
                        Failure::Input | Failure::Decode => ReplyError::Decode,
                        Failure::Truncated => ReplyError::Truncated,
                        Failure::Png => ReplyError::Png,
                        Failure::Excess => ReplyError::Protocol(Error::UploadTooLarge),
                        _ => ReplyError::Worker,
                    })
                }
                _ => Err(ReplyError::Worker),
            };
            // Completion is sent after reaping, including every error/cancel path.
            job.upload = None;
            match result {
                Ok(image) if job.control.action() == Ok(Action::Frame) => job.patch = Some(image),
                other => job.result = Some(other.map(ImageContent::Static)),
            }
        }
        if job.patch.is_some() {
            let mut job = self.job.take().expect("polled graphics job");
            self.admission_waiting |= self.start_frame_edit(&mut job);
            self.job = Some(job);
        }
    }

    /// Returns true when the parser can resume. Every successful handoff clears
    /// exactly one boundary; a full queue preserves its original staging bytes.
    /// A command waiting on releases stays unacknowledged, and starts over when
    /// the owner loop observes one landing.
    pub(super) fn advance(&mut self, term: &mut Term<EventForwarder>) -> bool {
        self.admission_waiting = false;
        self.consume_anchor_events(term);
        self.poll_job();
        if term.event_listener().graphics_reset {
            if !self.cancel_job() {
                return false;
            }
            self.clear_placements(term);
            for image in self.scene.clear().into_values() {
                retire(&mut self.releases, image);
            }
            if let Some(native) = &self.native {
                native.reset();
            }
            term.event_listener_mut().graphics_reset = false;
        }
        let boundary = &mut term.event_listener_mut().graphics;
        match boundary.pending() {
            Some(Step::Data {
                id,
                control,
                first,
                last,
                encoded,
            }) => {
                if first && self.job.is_none() {
                    let frame = self.frame_target(&control);
                    match self.start(id, control, frame, encoded) {
                        Ok(job) => self.job = Some(job),
                        Err(Refused::Wait) => {
                            self.admission_waiting = true;
                            return false;
                        }
                        Err(Refused::Reply(error)) => {
                            self.job = Some(Job::refused(id, control, frame, error));
                        }
                    }
                }
                let job = self.job.as_mut().expect("admitted continuation has a job");
                debug_assert_eq!(job.id, id);
                job.control = control;
                if let Some(upload) = &mut job.upload {
                    match upload.try_push(encoded, last) {
                        Err(PushError::Full) => return false,
                        Err(_) => {
                            upload.request_cancel();
                            return false;
                        }
                        Ok(()) => {}
                    }
                }
                job.final_chunk = last;
                boundary.acknowledge();
            }
            Some(Step::Command { id, control }) => {
                if self.job.as_ref().is_none_or(|job| job.id != id) {
                    if !self.cancel_job() {
                        return false;
                    }
                    if animation::is_command(&control) {
                        match self.start_edit_command(term, id, control) {
                            Ok(Some(job)) => self.job = Some(job),
                            Err(Refused::Wait) => {
                                self.admission_waiting = true;
                                return false;
                            }
                            result => {
                                respond(term, &control, None, result.map(|_| ()).map_err(Refused::reply));
                                term.event_listener_mut().graphics.acknowledge();
                            }
                        }
                    } else {
                        let result = match self.command(term, &control) {
                            Err(Refused::Wait) => {
                                self.admission_waiting = true;
                                return false;
                            }
                            result => result.map_err(Refused::reply),
                        };
                        let resolved = result.as_ref().ok().copied().flatten();
                        respond(term, &control, resolved, result.map(|_| ()));
                        term.event_listener_mut().graphics.acknowledge();
                    }
                }
            }
            Some(Step::Rejected { error, control }) => {
                if !self.cancel_job() {
                    return false;
                }
                if error != Error::Cancelled
                    && let Some(control) = control
                {
                    respond(term, &control, None, Err(ReplyError::Protocol(error)));
                }
                term.event_listener_mut().graphics.acknowledge();
            }
            Some(Step::Ignored) => unreachable!("ignored APCs have no boundary"),
            None => {}
        }

        if self
            .job
            .as_ref()
            .is_some_and(|job| job.final_chunk && job.result.is_some())
        {
            let job = self.job.as_mut().expect("completed graphics job");
            let fence = job.fence;
            let result = job
                .result
                .take()
                .expect("completed result")
                .and_then(|image| {
                    self.scene
                        .publish(fence.ok_or(ReplyError::Worker)?, image)
                        .map_err(ReplyError::from)
                });
            // While the job is still held: the first of the replaced image's
            // placements hands its metadata to a transmit-and-place replacing it.
            if let Ok(Published::Image {
                replaced: Some(old),
                ..
            }) = &result
            {
                self.remove_image_placements(term, *old);
            }
            let mut job = self.job.take().expect("completed graphics job");
            let (resolved, result) = match result {
                Ok(Published::Query) => (None, Ok(())),
                Ok(Published::Image { image, retired, .. }) => {
                    self.memory_only = true;
                    self.published = true;
                    if job.command || job.control.action() == Ok(Action::Frame) {
                        self.placements.invalidate_image(image.incarnation);
                        self.projection_dirty = true;
                    }
                    // A static an edit superseded keeps its pixels in the new
                    // frames while any tile of it survives the edit: then nothing
                    // of it is released while that animation lives.
                    if let Some(retired) = retired
                        && !retired.content.storage_shared()
                    {
                        retire(&mut self.releases, retired);
                    }
                    let result = match job.placement.take() {
                        // Admitted before publication: no storage refusal follows it.
                        Some(PlacementMetadata::Admitted(metadata)) => self
                            .place(term, &job.control, image.incarnation, Some(metadata))
                            .map_err(Refused::reply),
                        Some(PlacementMetadata::Replacing(_)) => {
                            unreachable!("publication removed the replaced image's placements")
                        }
                        None => Ok(()),
                    };
                    // Anonymous content has no namespace entry from which a
                    // later command could recover it. Keep it only while placed.
                    if image.client_id == 0
                        && self
                            .placements
                            .image_placements(image.incarnation)
                            .next()
                            .is_none()
                        && let Some(removed) = self.scene.remove(image.incarnation)
                    {
                        retire(&mut self.releases, removed);
                    }
                    (Some(image.client_id), result)
                }
                Err(error) => {
                    self.scene.cancel();
                    (None, Err(error))
                }
            };
            respond(term, &job.frame_control(), resolved, result);
            if job.command {
                assert!(term.event_listener_mut().graphics.acknowledge());
            } else {
                assert!(term.event_listener_mut().graphics.finish_validation(job.id));
            }
        }
        !term.event_listener().graphics.paused()
    }

    fn command(
        &mut self,
        term: &mut Term<EventForwarder>,
        control: &Control,
    ) -> Result<Option<u32>, Refused> {
        // Commands may follow text in the same PTY read. Spatial deletion and
        // relative placement must see that prefix's current placeholder origins,
        // so this rebuilds the index even while a projection is deferred.
        self.refresh_placeholders(term);
        match control.action().map_err(ReplyError::Protocol)? {
            Action::Place => {
                let image = self.scene.resolve(control).map_err(ReplyError::from)?;
                let client_id = self
                    .scene
                    .image(image)
                    .ok_or(ReplyError::MissingImage)?
                    .client_id;
                self.place(term, control, image, None)?;
                Ok(Some(client_id))
            }
            Action::Delete => {
                self.delete(term, control)?;
                Ok(None)
            }
            _ => Err(ReplyError::Protocol(Error::UnsupportedAction).into()),
        }
    }

    /// `admitted` is a new placement's metadata the caller reserved beforehand;
    /// without it, a storage refusal can wait and the placement starts over.
    fn place(
        &mut self,
        term: &mut Term<EventForwarder>,
        control: &Control,
        image: ImageIncarnation,
        admitted: Option<merkur_graphics::budget::Lease>,
    ) -> Result<(), Refused> {
        let mut request = PlacementRequest::from_control(control).map_err(ReplyError::Protocol)?;
        let source = self.scene.image(image).ok_or(ReplyError::MissingImage)?;
        if source.client_id == 0 {
            request.client_id = 0;
        }
        let cell = term
            .event_listener()
            .viewport
            .and_then(|viewport| viewport.cell)
            .ok_or(ReplyError::GeometryUnavailable)?;
        let geometry = if request.origin == PlacementOrigin::Virtual {
            Some(Geometry::virtual_placement(
                source.width,
                source.height,
                request.layout.columns,
                request.layout.rows,
                cell,
            )?)
        } else {
            request.layout.geometry(source.width, source.height, cell)?
        };
        let cursor_advance = if request.move_cursor {
            geometry
                .map(|geometry| {
                    geometry
                        .cursor_advance()
                        .ok_or(ReplyError::Protocol(Error::InvalidControl))
                })
                .transpose()?
        } else {
            None
        };
        let bounds = geometry.map(image_bounds).transpose()?;
        let origin = match request.origin {
            PlacementOrigin::Virtual => Origin::Virtual,
            PlacementOrigin::Relative {
                image_id,
                placement_id,
                columns,
                rows,
            } => {
                let parent_image = self
                    .scene
                    .resolve_id(image_id)
                    .ok_or(ReplyError::MissingParent)?;
                let parent = self
                    .placements
                    .resolve(parent_image, placement_id)
                    .ok_or(ReplyError::MissingParent)?;
                Origin::Relative {
                    parent,
                    columns,
                    rows,
                }
            }
            // The identity is taken only with the placement: a refusal that
            // waits starts over with the same one.
            PlacementOrigin::Cursor => Origin::Direct(AnchorId(
                self.last_anchor
                    .checked_add(1)
                    .and_then(NonZeroU64::new)
                    .ok_or(ReplyError::Protocol(Error::IdentityExhausted))?,
            )),
        };
        let previous = (request.client_id != 0)
            .then(|| self.placements.resolve(image, request.client_id))
            .flatten()
            .and_then(|id| self.placements.get(id))
            .map(|placement| placement.origin);
        // Admission and graph validation precede grid allocation or cursor effects.
        match admitted {
            Some(metadata) => self.placements.put_admitted(
                image,
                request.client_id,
                origin,
                request.layout,
                metadata,
            ),
            None => self
                .placements
                .put(image, request.client_id, origin, request.layout),
        }
        .map_err(|error| self.placement_refusal(error))?;
        if let Origin::Direct(id) = origin {
            self.last_anchor = id.0.get();
            let point = term.grid().cursor.point;
            let anchor = match bounds {
                Some(bounds) => term.grid_mut().image_anchor(point, id.0, bounds),
                None => term.grid_mut().anchor_tagged(point, id.0),
            }
            .expect("validated image and live cursor form a valid grid attachment");
            self.anchors.insert(id, anchor);
        }
        if let Some(Origin::Direct(id)) = previous {
            self.remove_anchor(term, id);
        }
        if let Some((columns, rows)) = cursor_advance {
            term.advance_graphics_cursor(columns, rows);
        }
        self.projection_dirty = true;
        Ok(())
    }

    /// A viewport that states no cell pixels gives no placement a geometry:
    /// each anchored image is retired, as one a new cell size cannot hold is.
    pub(super) fn resize_geometry(
        &mut self,
        term: &mut Term<EventForwarder>,
        cell: Option<CellMetrics>,
    ) {
        self.projection_dirty = true;
        if self.anchors.is_empty() {
            return;
        }
        let mut retired = Vec::new();
        for placement in self.placements.iter() {
            let Origin::Direct(id) = placement.origin else {
                continue;
            };
            let Some(anchor) = self.anchors.get(&id) else {
                continue;
            };
            if anchor.image_clip().is_none() {
                continue;
            }
            let valid = cell
                .zip(self.scene.image(placement.image))
                .and_then(|(cell, source)| {
                    placement
                        .layout
                        .geometry(source.width, source.height, cell)
                        .ok()
                        .flatten()
                })
                .and_then(|geometry| image_bounds(geometry).ok())
                .is_some_and(|bounds| term.resize_graphics_anchor(anchor, bounds));
            if !valid {
                retired.push(placement.id);
            }
        }
        for id in retired {
            self.remove_placement(term, id);
        }
    }

    fn remove_anchor(&mut self, term: &mut Term<EventForwarder>, id: AnchorId) {
        if let Some(anchor) = self.anchors.remove(&id) {
            term.remove_graphics_anchor(&anchor);
        }
    }

    fn remove_placement(&mut self, term: &mut Term<EventForwarder>, id: PlacementId) {
        self.projection_dirty = true;
        let Self {
            placements,
            anchors,
            scene,
            projection_workspace,
            placeholders,
            releases,
            job,
            ..
        } = self;
        placements.remove(id, |removed, image_has_placements| {
            if let Some(index) = placeholders {
                index.remove(removed.id);
            }
            if let Some(workspace) = projection_workspace {
                workspace.remove(removed.id);
            }
            if let Origin::Direct(anchor) = removed.origin
                && let Some(anchor) = anchors.remove(&anchor)
            {
                term.remove_graphics_anchor(&anchor);
            }
            let cascaded = removed.id != id && matches!(removed.origin, Origin::Relative { .. });
            let anonymous = scene
                .image(removed.image)
                .is_some_and(|image| image.client_id == 0);
            if !image_has_placements
                && (cascaded || anonymous)
                && let Some(image) = scene.remove(removed.image)
            {
                retire(releases, image);
            }
            // The first placement removed of an image a transmit-and-place
            // replaces hands its metadata over instead of refunding it.
            if let Some(Job { placement, .. }) = job
                && matches!(placement, Some(PlacementMetadata::Replacing(image)) if *image == removed.image)
            {
                *placement = Some(PlacementMetadata::Admitted(removed.into_metadata()));
            }
        });
    }

    fn remove_image_placements(
        &mut self,
        term: &mut Term<EventForwarder>,
        image: ImageIncarnation,
    ) {
        loop {
            let next = self.placements.image_placements(image).next();
            let Some(id) = next else {
                break;
            };
            self.remove_placement(term, id);
        }
    }

    fn clear_placements(&mut self, term: &mut Term<EventForwarder>) {
        self.projection_dirty = true;
        self.consume_anchor_events(term);
        for (_, anchor) in std::mem::take(&mut self.anchors) {
            term.remove_graphics_anchor(&anchor);
        }
        self.placements.clear();
        self.clear_projection();
    }

    pub(super) fn consume_anchor_events(&mut self, term: &mut Term<EventForwarder>) {
        use alacritty_terminal::grid::AnchorEvent;
        let mut remapped = false;
        while let Some(event) = term.take_graphics_anchor_event() {
            self.projection_dirty = true;
            let tag = match event {
                AnchorEvent::Changed(tag) => {
                    if !remapped {
                        self.placements.invalidate_anchor(AnchorId(tag));
                    }
                    continue;
                }
                AnchorEvent::Remapped => {
                    remapped = true;
                    continue;
                }
                AnchorEvent::Retired(tag) => tag,
            };
            let anchor = AnchorId(tag);
            loop {
                let next = self.placements.anchored(anchor).next();
                let Some(id) = next else {
                    break;
                };
                self.remove_placement(term, id);
            }
        }
        if remapped {
            self.placements.invalidate_all();
        }
    }

    fn position(&self, term: &Term<EventForwarder>, id: PlacementId) -> Option<Position> {
        // A direct placement samples from its original, unclipped origin. Its
        // descendants instead follow the first surviving cell of the parent,
        // just as they do when the parent's placement is replaced or reflowed.
        let direct = matches!(self.placements.get(id)?.origin, Origin::Direct(_));
        self.placements.position(
            id,
            |id| {
                let anchor = self.anchors.get(&id)?;
                let point = term.grid().resolve_anchor(anchor)?;
                Some(Position {
                    column: point.column.0 as i64,
                    line: i64::from(point.line.0)
                        - if direct {
                            anchor
                                .image_clip()
                                .map_or(0, |clip| (clip.top >> 32) as i64)
                        } else {
                            0
                        },
                })
            },
            |id| self.placeholders.as_ref()?.origin(id),
        )
    }

    /// Deletion answers only an ambiguous image identity, which every command
    /// rejects. An unknown selector, absent image, reversed range or missing
    /// cell coordinate deletes nothing and stays silent, as in Kitty.
    fn delete(
        &mut self,
        term: &mut Term<EventForwarder>,
        control: &Control,
    ) -> Result<(), ReplyError> {
        let selector = control.get(Key::Delete).unwrap_or(u32::from(b'a')) as u8;
        let mode = selector.to_ascii_lowercase();
        if control.get(Key::ImageId).is_some() && control.get(Key::ImageNumber).is_some() {
            return Err(ReplyError::Protocol(Error::InvalidControl));
        }
        if !matches!(
            mode,
            b'a' | b'i' | b'n' | b'c' | b'p' | b'q' | b'r' | b'x' | b'y' | b'z'
        ) {
            return Ok(());
        }
        let image = if matches!(mode, b'i' | b'n') {
            let key = if mode == b'i' {
                Key::ImageId
            } else {
                Key::ImageNumber
            };
            if control.get(key).unwrap_or(0) == 0 {
                return Ok(());
            }
            match self.scene.resolve(control) {
                Ok(image) => Some(image),
                Err(merkur_graphics::scene::SceneError::MissingImage) => return Ok(()),
                Err(error) => return Err(error.into()),
            }
        } else {
            None
        };
        // Cell selectors are one-based; zero or an omitted coordinate names no cell.
        let coordinate = |key| {
            control
                .get(key)
                .filter(|v| *v != 0)
                .map(|v| i64::from(v - 1))
        };
        let x = if matches!(mode, b'p' | b'q' | b'x') {
            let Some(x) = coordinate(Key::SourceX) else {
                return Ok(());
            };
            x
        } else {
            0
        };
        let y = if matches!(mode, b'p' | b'q' | b'y') {
            let Some(y) = coordinate(Key::SourceY) else {
                return Ok(());
            };
            y
        } else {
            0
        };
        let range = (
            control.get(Key::SourceX).unwrap_or(0),
            control.get(Key::SourceY).unwrap_or(0),
        );
        if mode == b'r' && range.0 > range.1 {
            return Ok(());
        }
        let z = control.signed(Key::Z).unwrap_or(0);
        let placement_id = control.get(Key::PlacementId).unwrap_or(0);
        let cursor = term.grid().cursor.point;
        let mut selected: Vec<_> = self
            .placements
            .iter()
            .filter(|placement| {
                if matches!(mode, b'i' | b'n') {
                    return Some(placement.image) == image
                        && (placement_id == 0 || placement.client_id == placement_id);
                }
                let Some(source) = self.scene.image(placement.image) else {
                    return false;
                };
                if mode == b'r' {
                    return source.client_id != 0
                        && source.client_id >= range.0
                        && source.client_id <= range.1;
                }
                if placement.origin == Origin::Virtual {
                    return false;
                }
                if mode == b'z' {
                    return placement.layout.z == z;
                }
                let Some(position) = self.position(term, placement.id) else {
                    return false;
                };
                let Some(cell) = term
                    .event_listener()
                    .viewport
                    .and_then(|viewport| viewport.cell)
                else {
                    return false;
                };
                let Ok(Some(geometry)) =
                    placement.layout.geometry(source.width, source.height, cell)
                else {
                    return false;
                };
                let (ox, oy) = geometry.offset();
                let (width, height) = geometry.extent();
                let unit = i128::from(CELL_UNIT);
                let left = i128::from(position.column) * unit + i128::from(ox);
                let mut top = i128::from(position.line) * unit + i128::from(oy);
                let right = left + i128::from(width);
                let mut bottom = top + i128::from(height);
                if let Origin::Direct(id) = placement.origin
                    && let Some(clip) = self.anchors.get(&id).and_then(GridAnchor::image_clip)
                {
                    top = top.max(i128::from(position.line) * unit + i128::from(clip.top));
                    bottom = bottom.min(i128::from(position.line) * unit + i128::from(clip.bottom));
                }
                let Some(rect) = CellRect::fixed(left, top, right, bottom) else {
                    return false;
                };
                match mode {
                    b'a' => CellRect::new(0, 0, term.columns() as i64, term.screen_lines() as i64)
                        .is_some_and(|viewport| rect.intersects(viewport)),
                    b'c' => {
                        rect.intersects_column(cursor.column.0 as i64)
                            && rect.intersects_row(i64::from(cursor.line.0))
                    }
                    b'p' | b'q' => {
                        rect.intersects_column(x)
                            && rect.intersects_row(y)
                            && (mode != b'q' || placement.layout.z == z)
                    }
                    b'x' => rect.intersects_column(x),
                    b'y' => rect.intersects_row(y),
                    _ => false,
                }
            })
            .map(|placement| (placement.id, placement.image, 0_usize))
            .collect();
        // A selected descendant is deleted by the selector itself, not through
        // its selected ancestor: only a descendant deleted with its parent
        // releases an image the selector's case would keep. Delete deeper
        // placements first; depth, not identity order, survives reparenting.
        for entry in &mut selected {
            let mut next = entry.0;
            while let Some(Origin::Relative { parent, .. }) =
                self.placements.get(next).map(|placement| placement.origin)
            {
                entry.2 += 1;
                next = parent;
            }
        }
        selected.sort_unstable_by_key(|entry| std::cmp::Reverse(entry.2));
        for (id, image, _) in selected {
            self.remove_placement(term, id);
            if selector.is_ascii_uppercase()
                && self.placements.image_placements(image).next().is_none()
                && let Some(removed) = self.scene.remove(image)
            {
                retire(&mut self.releases, removed);
            }
        }
        // Uppercase id deletion also frees an image with no placements.
        if selector.is_ascii_uppercase()
            && let Some(image) = image
            && self.placements.image_placements(image).next().is_none()
            && let Some(removed) = self.scene.remove(image)
        {
            retire(&mut self.releases, removed);
        }
        if selector == b'R' {
            // Range deletion also addresses stored images which have never been
            // placed. Iterate the namespace, not the placement reverse index.
            loop {
                let next = self.scene.ids_in_range(range.0, range.1).next();
                let Some(image) = next else { break };
                if let Some(removed) = self.scene.remove(image) {
                    retire(&mut self.releases, removed);
                }
            }
        }
        Ok(())
    }

    fn cancel_job(&mut self) -> bool {
        if let Some(edit) = self.job.as_ref().and_then(|job| job.edit.as_ref()) {
            edit.request_cancel();
            return false;
        }
        if let Some(upload) = self.job.as_mut().and_then(|job| job.upload.as_mut()) {
            upload.request_cancel();
            return false;
        }
        self.job = None;
        self.scene.cancel();
        true
    }

    pub(super) async fn shutdown(&mut self, term: &mut Term<EventForwarder>) {
        self.clear_placements(term);
        self.scene.retire();
        self.clear_projection();
        self.placeholders = None;
        if let Some(native) = self.native.take() {
            native.shutdown().await;
        }
        if let Some(job) = self.job.take() {
            if let Some(upload) = job.upload {
                let _ = upload.cancel().await;
            }
            if let Some(edit) = job.edit {
                edit.cancel().await;
            }
        }
    }
}

fn image_bounds(geometry: Geometry) -> Result<ImageAnchorBounds, ReplyError> {
    let (left, top) = geometry.offset();
    let (width, height) = geometry.extent();
    Ok(ImageAnchorBounds {
        left,
        top,
        right: left
            .checked_add(width)
            .ok_or(ReplyError::Protocol(Error::InvalidControl))?,
        bottom: top
            .checked_add(height)
            .ok_or(ReplyError::Protocol(Error::InvalidControl))?,
    })
}

fn respond(
    term: &Term<EventForwarder>,
    control: &Control,
    resolved: Option<u32>,
    result: Result<(), ReplyError>,
) {
    if let Some(reply) = Reply::new(control, resolved, result) {
        let _ = term
            .event_listener()
            .event_tx
            .send(TerminalEvent::PtyWrite(reply.as_bytes().to_vec()));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pty::TerminalState;
    use alacritty_terminal::index::{Column, Line};
    use crossbeam_channel::Receiver;
    use std::time::Duration;

    fn terminal() -> (TerminalState, Receiver<TerminalEvent>) {
        let (tx, rx) = crossbeam_channel::unbounded();
        let mut terminal = TerminalState::new(80, 3, tx);
        terminal.graphics = Graphics::with_resources(&Resources::new());
        // Deliberate failed launch, not a substitute decoder. These tests prove
        // owner sequencing independently of the isolated decoder's own tests.
        terminal.graphics.executable = PathBuf::from("/merkur-test-nonexistent-image-worker");
        (terminal, rx)
    }

    /// Row fields in draw order: row, image id, z, then the eight slice
    /// endpoints. Order between different (row, z, image) keys is normative;
    /// the protocol leaves equal-z order within one image undefined. Contiguous
    /// slices sampling at one scale render identically whether a placeholder
    /// run was emitted as one slice or several. Slices meeting at a shared
    /// source edge with different scales render differently and stay apart.
    fn stacking(rows: Vec<Vec<f64>>) -> Vec<([i64; 3], Vec<[f64; 8]>)> {
        let close = |a: f64, b: f64| (a - b).abs() < 0.00002;
        let mut groups: Vec<([i64; 3], Vec<[f64; 8]>)> = Vec::new();
        for row in rows {
            let key = [row[0] as i64, row[2] as i64, row[1] as i64];
            let slice: [f64; 8] = row[3..].try_into().unwrap();
            match groups.last_mut() {
                Some((last, slices)) if *last == key => slices.push(slice),
                _ => groups.push((key, vec![slice])),
            }
        }
        for (_, slices) in &mut groups {
            slices.sort_by(|a, b| a.partial_cmp(b).unwrap());
            let mut merged: Vec<[f64; 8]> = Vec::with_capacity(slices.len());
            for slice in slices.drain(..) {
                match merged.last_mut() {
                    Some(last)
                        if close(last[1], slice[0])
                            && close(last[2], slice[2])
                            && close(last[3], slice[3])
                            && close(last[5], slice[4])
                            && close(last[6], slice[6])
                            && close(last[7], slice[7])
                            && close(
                                (last[1] - last[0]) * (slice[5] - slice[4]),
                                (slice[1] - slice[0]) * (last[5] - last[4]),
                            ) =>
                    {
                        last[1] = slice[1];
                        last[5] = slice[5];
                    }
                    _ => merged.push(slice),
                }
            }
            *slices = merged;
        }
        groups
    }

    #[test]
    fn stacking_merges_contiguous_slices_only_at_one_scale() {
        let row = |slice: [f64; 8]| [&[0.0, 1.0, 0.0][..], &slice].concat();
        let whole = stacking(vec![row([0.0, 2.0, 0.0, 1.0, 0.0, 3.0, 0.0, 16.0])]);
        let halves = vec![
            row([0.0, 1.0, 0.0, 1.0, 0.0, 1.5, 0.0, 16.0]),
            row([1.0, 2.0, 0.0, 1.0, 1.5, 3.0, 0.0, 16.0]),
        ];
        assert_eq!(stacking(halves), whole);
        // Sharing the source edge is not enough: two cells sampling two pixels
        // and then one render differently from one run sampling three evenly.
        let uneven = vec![
            row([0.0, 1.0, 0.0, 1.0, 0.0, 2.0, 0.0, 16.0]),
            row([1.0, 2.0, 0.0, 1.0, 2.0, 3.0, 0.0, 16.0]),
        ];
        assert_ne!(stacking(uneven), whole);
    }

    /// Decoded frames, gaps and playback state. A stopped animation has a
    /// current frame; a running one's frame is a function of elapsed time, which
    /// the headless reference never advances. Blend quantization is unspecified:
    /// Kitty truncates floating-point source-over, Merkur rounds the exact
    /// straight-alpha result, so blended cases admit one unit per channel.
    fn assert_images(
        graphics: &Graphics,
        expected: &serde_json::Value,
        tolerance: u8,
        context: &str,
    ) {
        use merkur_image_worker::frame::Raster;
        for (id, expected) in expected.as_object().unwrap() {
            let id: u32 = id.parse().unwrap();
            let image = graphics
                .scene
                .resolve_id(id)
                .and_then(|image| graphics.scene.image(image));
            if expected.is_null() {
                assert!(image.is_none(), "{context}: image {id} exists");
                continue;
            }
            let image = image.unwrap_or_else(|| panic!("{context}: image {id} is absent"));
            assert_eq!(
                serde_json::json!([image.width, image.height]),
                expected["size"],
                "{context}: image {id}"
            );
            let (state, current, gaps) = match image.content.animation() {
                Some(animation) => {
                    let playback = animation.manifest().playback();
                    (
                        playback.mode as u64 - 1,
                        u64::from(playback.frame),
                        animation
                            .manifest()
                            .entries()
                            .map(|entry| u64::from(entry.gap_ms))
                            .collect(),
                    )
                }
                None => (0, 0, vec![0]),
            };
            assert_eq!(
                state,
                expected["state"].as_u64().unwrap(),
                "{context}: image {id}"
            );
            if state == 0 {
                assert_eq!(
                    current,
                    expected["current"].as_u64().unwrap(),
                    "{context}: image {id}"
                );
            }
            let frames = expected["frames"].as_array().unwrap();
            assert_eq!(gaps.len(), frames.len(), "{context}: image {id}");
            for (index, (gap, frame)) in gaps.iter().zip(frames).enumerate() {
                assert_eq!(
                    *gap,
                    frame[0].as_u64().unwrap(),
                    "{context}: image {id} frame {index}"
                );
                let raster = image.content.raster(index as u32).unwrap();
                let mut pixels = Vec::new();
                for y in 0..raster.height() {
                    let mut x = 0;
                    while x < raster.width() {
                        let run = raster.run(x, y);
                        pixels.extend_from_slice(run);
                        x += (run.len() / 4) as u32;
                    }
                }
                let hex = frame[1].as_str().unwrap();
                let reference: Vec<u8> = (0..hex.len())
                    .step_by(2)
                    .map(|at| u8::from_str_radix(&hex[at..at + 2], 16).unwrap())
                    .collect();
                assert!(
                    pixels.len() == reference.len()
                        && pixels
                            .iter()
                            .zip(&reference)
                            .all(|(a, b)| a.abs_diff(*b) <= tolerance),
                    "{context}: image {id} frame {index}: {pixels:?} != {reference:?}"
                );
            }
        }
    }

    /// Resume the parser as the owner loop does: a helper completion, or the
    /// landing of a release the parser waits on, wakes it, and it continues from
    /// the first unaccepted byte.
    async fn resume(terminal: &mut TerminalState, bytes: &[u8], mut accepted: usize) {
        let wake = terminal.graphics_wake();
        tokio::time::timeout(Duration::from_secs(15), async {
            while terminal.graphics_pending() {
                match terminal.graphics_release() {
                    Some(release) => {
                        release.wait().await;
                        terminal.observe_graphics_release();
                    }
                    None => wake.notified().await,
                }
                accepted += terminal.apply_bytes(&bytes[accepted..]);
            }
        })
        .await
        .expect("graphics owner did not resume on completion or release");
        assert_eq!(accepted, bytes.len());
    }

    fn replies(rx: &Receiver<TerminalEvent>) -> Vec<Vec<u8>> {
        rx.try_iter()
            .filter_map(|event| match event {
                TerminalEvent::PtyWrite(bytes) => Some(bytes),
                _ => None,
            })
            .collect()
    }

    fn visible(terminal: &TerminalState) -> String {
        (0..80)
            .map(|column| terminal.term.grid()[Line(0)][Column(column)].c)
            .collect::<String>()
            .trim_end()
            .to_owned()
    }

    #[test]
    fn deletion_answers_only_an_ambiguous_identity() {
        let (mut terminal, rx) = terminal();
        // Unknown selectors, absent cells, reversed ranges and absent images
        // delete nothing, silently, as in Kitty.
        for command in [
            &b"\x1b_Ga=d,d=b,i=1\x1b\\"[..],
            b"\x1b_Ga=d,d=p,i=1\x1b\\",
            b"\x1b_Ga=d,d=x,i=1\x1b\\",
            b"\x1b_Ga=d,d=R,x=3,y=2,i=1\x1b\\",
            b"\x1b_Ga=d,d=F,i=99\x1b\\",
            b"\x1b_Ga=d,d=f,I=4\x1b\\",
        ] {
            terminal.apply_bytes(command);
            assert!(replies(&rx).is_empty(), "{command:?}");
        }
        terminal.apply_bytes(b"\x1b_Ga=d,d=i,i=1,I=3\x1b\\");
        assert_eq!(
            replies(&rx),
            [b"\x1b_Gi=1,I=3;EINVAL:invalid graphics command\x1b\\".to_vec()]
        );
    }

    #[test]
    fn text_only_erasure_retires_placement_dependencies_at_the_grid_event() {
        let (mut terminal, _rx) = terminal();
        let one = NonZeroU64::new(1).unwrap();
        let image = ImageIncarnation(one);
        let anchor = terminal
            .term
            .grid_mut()
            .anchor_tagged(
                alacritty_terminal::index::Point::new(Line(0), Column(0)),
                one,
            )
            .unwrap();
        terminal.graphics.anchors.insert(AnchorId(one), anchor);
        let parent = terminal
            .graphics
            .placements
            .put(image, 1, Origin::Direct(AnchorId(one)), Default::default())
            .unwrap();
        terminal
            .graphics
            .placements
            .put(
                image,
                2,
                Origin::Relative {
                    parent,
                    columns: 1,
                    rows: 1,
                },
                Default::default(),
            )
            .unwrap();
        let charged = terminal.graphics.storage.used();
        terminal.apply_bytes(b"text\x1b[2K");
        assert_eq!(terminal.graphics.placements.len(), 2);
        assert_eq!(terminal.graphics.storage.used(), charged);
        terminal.apply_bytes(b"\x1b[?1049h");
        assert_eq!(terminal.graphics.placements.len(), 2);
        terminal.apply_bytes(b"\x1b[?1049l\x1b[2J");
        assert!(terminal.graphics.placements.is_empty());
        assert!(terminal.graphics.anchors.is_empty());
        assert!(terminal.term.take_graphics_anchor_event().is_none());
        assert_eq!(
            terminal.graphics.storage.used(),
            Some(Usage {
                bytes: 0,
                objects: 0
            })
        );
    }

    #[test]
    fn grid_changes_reach_exact_placement_dependencies_before_display_capture() {
        let (mut terminal, _) = terminal();
        terminal.resize(80, 8);
        let mut roots = Vec::new();
        for (tag, line) in [(1, 2), (2, 0)] {
            let tag = NonZeroU64::new(tag).unwrap();
            let anchor = terminal
                .term
                .grid_mut()
                .anchor_tagged(
                    alacritty_terminal::index::Point::new(Line(line), Column(0)),
                    tag,
                )
                .unwrap();
            terminal.graphics.anchors.insert(AnchorId(tag), anchor);
            roots.push(
                terminal
                    .graphics
                    .placements
                    .put(
                        ImageIncarnation(tag),
                        1,
                        Origin::Direct(AnchorId(tag)),
                        Default::default(),
                    )
                    .unwrap(),
            );
        }
        let child = terminal
            .graphics
            .placements
            .put(
                ImageIncarnation(NonZeroU64::new(3).unwrap()),
                1,
                Origin::Relative {
                    parent: roots[0],
                    columns: 1,
                    rows: 1,
                },
                Default::default(),
            )
            .unwrap();
        terminal.graphics.placements.take_dirty();
        terminal.apply_bytes(b"ordinary text");
        assert!(terminal.graphics.placements.take_dirty().is_empty());
        terminal.apply_bytes(b"\x1b[2;7r\x1b[1T");
        assert_eq!(
            terminal.graphics.placements.take_dirty(),
            [roots[0], child].into()
        );
        assert_eq!(
            terminal
                .graphics
                .position(&terminal.term, roots[0])
                .unwrap()
                .line,
            3
        );
        terminal.apply_bytes(b"\x1b[?1049h");
        assert_eq!(
            terminal.graphics.placements.take_dirty(),
            [roots[0], roots[1], child].into()
        );
        assert!(terminal.graphics.position(&terminal.term, child).is_none());
        terminal.apply_bytes(b"\x1b[?1049l");
        assert_eq!(
            terminal.graphics.placements.take_dirty(),
            [roots[0], roots[1], child].into()
        );
        terminal.resize(79, 8);
        assert_eq!(
            terminal.graphics.placements.take_dirty(),
            [roots[0], roots[1], child].into()
        );
        assert!(terminal.term.take_graphics_anchor_event().is_none());
    }

    #[tokio::test]
    async fn shared_daemon_quota_survives_terminal_retirement_until_jobs_are_reaped() {
        let resources = Resources::new();
        let mut terminals = Vec::new();
        for _ in 0..=DAEMON_DECODERS {
            let (mut terminal, rx) = terminal();
            terminal.graphics = Graphics::with_resources(&resources);
            terminal.graphics.executable = PathBuf::from("/merkur-test-nonexistent-image-worker");
            terminals.push((terminal, rx));
        }
        // No task can run before this current-thread executor yields. Each open
        // upload therefore owns its reservations while the third owner admits.
        let input = b"\x1b_Ga=t,f=24,s=2,v=1,i=31,m=1;AAAA\x1b\\";
        for (terminal, _) in &mut terminals {
            assert_eq!(terminal.apply_bytes(input), input.len());
        }
        assert_eq!(
            resources.processing.used(),
            Some(Usage {
                bytes: DAEMON_DECODERS * (WORKSPACE_BYTES + QUEUE_BYTES),
                objects: DAEMON_DECODERS * (QUEUE_CHUNKS + 2),
            })
        );
        let (refused, replies_rx) = &mut terminals[DAEMON_DECODERS];
        assert!(matches!(
            refused.graphics.job.as_ref().unwrap().result,
            Some(Err(ReplyError::Quota))
        ));
        assert!(refused.graphics.scene.is_empty());
        assert!(replies(replies_rx).is_empty());
        let final_chunk = b"\x1b_Gm=0;AAAA\x1b\\";
        assert_eq!(refused.apply_bytes(final_chunk), final_chunk.len());
        assert!(refused.graphics.job.is_none());
        assert_eq!(
            replies(replies_rx),
            [b"\x1b_Gi=31;ENOSPC:graphics resource limit\x1b\\".to_vec()]
        );
        for (terminal, _) in &mut terminals {
            terminal.shutdown_graphics().await;
        }
        let empty = Some(Usage {
            bytes: 0,
            objects: 0,
        });
        assert_eq!(resources.processing.used(), empty);
        assert_eq!(resources.storage.used(), empty);
    }

    #[test]
    fn relative_projection_uses_live_grid_columns_and_retires_with_its_anchor() {
        use alacritty_terminal::index::Point;
        use merkur_graphics::placements::{
            AnchorId, Layout, Origin, PLACEMENT_METADATA_BYTES, Placements, Position,
        };
        use merkur_graphics::publication::ImageIncarnation;
        use std::num::NonZeroU64;

        let (mut terminal, _rx) = terminal();
        terminal.resize(8, 5);
        terminal.apply_bytes(b"abcdefghij");
        let anchor = terminal
            .term
            .grid_mut()
            .anchor(Point::new(Line(0), Column(6)))
            .unwrap();
        let one = NonZeroU64::new(1).unwrap();
        let mut placements = Placements::new(Budget::new(Usage {
            bytes: 2 * PLACEMENT_METADATA_BYTES,
            objects: 2,
        }));
        let parent = placements
            .put(
                ImageIncarnation(one),
                1,
                Origin::Direct(AnchorId(one)),
                Layout::default(),
            )
            .unwrap();
        let child = placements
            .put(
                ImageIncarnation(one),
                2,
                Origin::Relative {
                    parent,
                    columns: 1,
                    rows: 1,
                },
                Layout::default(),
            )
            .unwrap();
        let position = |terminal: &TerminalState| {
            placements.position(
                child,
                |id| {
                    assert_eq!(id, AnchorId(one));
                    terminal
                        .term
                        .grid()
                        .resolve_anchor(&anchor)
                        .map(|point| Position {
                            column: point.column.0 as i64,
                            line: i64::from(point.line.0),
                        })
                },
                |_| None,
            )
        };
        assert_eq!(position(&terminal), Some(Position { column: 7, line: 1 }));
        terminal.resize(4, 5);
        // Reflow preserves the cursor's viewport line; the leading wrapped row
        // enters history, so 'g' lands on line zero rather than line one.
        assert_eq!(position(&terminal), Some(Position { column: 3, line: 1 }));
        let point = terminal.term.grid().resolve_anchor(&anchor).unwrap();
        assert_eq!(terminal.term.grid()[point].c, 'g');
        terminal.resize(8, 5);
        assert_eq!(position(&terminal), Some(Position { column: 7, line: 1 }));
        terminal.apply_bytes(b"\x1b[?1049h");
        assert_eq!(position(&terminal), None);
        terminal.apply_bytes(b"\x1b[?1049l");
        assert_eq!(position(&terminal), Some(Position { column: 7, line: 1 }));
        terminal.apply_bytes(b"\x1b[2J");
        assert_eq!(position(&terminal), None);
    }

    #[test]
    fn relative_descendants_follow_the_clipped_parent_cell_without_changing_sampling() {
        let (mut terminal, _) = terminal();
        terminal.resize(80, 8);
        let tag = NonZeroU64::new(1).unwrap();
        let image = ImageIncarnation(tag);
        let anchor = terminal
            .term
            .grid_mut()
            .image_anchor(
                alacritty_terminal::index::Point::new(Line(1), Column(2)),
                tag,
                ImageAnchorBounds {
                    left: 0,
                    top: CELL_UNIT / 4,
                    right: 2 * CELL_UNIT,
                    bottom: 4 * CELL_UNIT,
                },
            )
            .unwrap();
        terminal.graphics.anchors.insert(AnchorId(tag), anchor);
        let parent = terminal
            .graphics
            .placements
            .put(image, 1, Origin::Direct(AnchorId(tag)), Default::default())
            .unwrap();
        let child = terminal
            .graphics
            .placements
            .put(
                image,
                2,
                Origin::Relative {
                    parent,
                    columns: 3,
                    rows: 1,
                },
                Default::default(),
            )
            .unwrap();
        let grandchild = terminal
            .graphics
            .placements
            .put(
                image,
                3,
                Origin::Relative {
                    parent: child,
                    columns: -1,
                    rows: -2,
                },
                Default::default(),
            )
            .unwrap();
        let position =
            |terminal: &TerminalState, id| terminal.graphics.position(&terminal.term, id).unwrap();
        assert_eq!(position(&terminal, child), Position { column: 5, line: 2 });
        terminal.apply_bytes(b"\x1b[2;6r\x1b[S");
        // The parent's first quarter-row and next three quarters were removed.
        // Source sampling still starts one row above the retained attachment.
        assert_eq!(position(&terminal, parent), Position { column: 2, line: 0 });
        assert_eq!(position(&terminal, child), Position { column: 5, line: 2 });
        assert_eq!(
            position(&terminal, grandchild),
            Position { column: 4, line: 0 }
        );
        terminal.apply_bytes(b"\x1b[S");
        assert_eq!(
            position(&terminal, parent),
            Position {
                column: 2,
                line: -1
            }
        );
        assert_eq!(position(&terminal, child), Position { column: 5, line: 2 });
        terminal.apply_bytes(b"\x1b[T");
        assert_eq!(position(&terminal, parent), Position { column: 2, line: 0 });
        assert_eq!(position(&terminal, child), Position { column: 5, line: 3 });
        terminal.apply_bytes(b"\x1b[?1049h");
        assert!(terminal.graphics.position(&terminal.term, child).is_none());
        terminal.apply_bytes(b"\x1b[?1049l");
        assert_eq!(position(&terminal, child), Position { column: 5, line: 3 });
        terminal.apply_bytes(b"\x1b[5S");
        assert!(terminal.graphics.placements.is_empty());
    }

    #[tokio::test]
    async fn failure_reply_precedes_da_and_unread_text_at_every_byte_split() {
        for synchronized in [false, true] {
            let input = [
                if synchronized {
                    b"\x1b[?2026h".as_slice()
                } else {
                    b""
                },
                b"before\x1b_Ga=q,f=24,s=1,v=1,i=31;AAAA\x1b\\\x1b[cafter",
                if synchronized {
                    b"\x1b[?2026l".as_slice()
                } else {
                    b""
                },
            ]
            .concat();
            for split in 0..=input.len() {
                let (mut terminal, rx) = terminal();
                let mut accepted = terminal.apply_bytes(&input[..split]);
                accepted += terminal.apply_bytes(&input[accepted..]);
                assert!(terminal.graphics_pending());
                assert_eq!(visible(&terminal), "before");
                assert!(replies(&rx).is_empty());
                resume(&mut terminal, &input, accepted).await;
                assert_eq!(visible(&terminal), "beforeafter");
                let replies = replies(&rx);
                assert_eq!(replies.len(), 2);
                assert!(replies[0].starts_with(b"\x1b_Gi=31;"));
                assert!(!replies[0].windows(3).any(|bytes| bytes == b";OK"));
                assert!(replies[1].starts_with(b"\x1b[?"));
                assert!(terminal.graphics.scene.is_empty());
                assert_eq!(terminal.graphics.processing.used().unwrap().bytes, 0);
                terminal.shutdown_graphics().await;
            }
        }
    }

    #[tokio::test]
    async fn buffered_prompt_cannot_regrant_after_input_or_resize_during_validation() {
        for synchronized in [false, true] {
            for resize in [false, true] {
                let (mut terminal, _rx) = terminal();
                let input = [
                    if synchronized {
                        b"\x1b[?2026h".as_slice()
                    } else {
                        b""
                    },
                    b"\x1b_Ga=q,f=24,s=1,v=1,i=31;AAAA\x1b\\\x1b[?2004h\x1b]133;B\x07",
                    if synchronized {
                        b"\x1b[?2026l".as_slice()
                    } else {
                        b""
                    },
                ]
                .concat();
                let accepted = terminal.apply_bytes(&input);
                assert!(terminal.graphics_pending());
                terminal.set_prediction_safe(true);
                assert!(!terminal.prediction_safe());
                if resize {
                    terminal.resize(80, 4);
                } else {
                    terminal
                        .observe_user_input(false, TerminalState::bytes_leave_line_editor(b"\r"));
                }
                resume(&mut terminal, &input, accepted).await;
                assert!(!terminal.shell_integration_input_active());
                assert!(!terminal.prediction_safe());
                terminal.apply_bytes(b"\x1b[?2004h\x1b]133;B\x07");
                assert!(terminal.shell_integration_input_active());
                terminal.shutdown_graphics().await;
            }
        }
    }

    #[tokio::test]
    async fn reset_reaps_an_interrupted_upload_before_new_semantics() {
        let (mut terminal, rx) = terminal();
        let input = b"\x1b_Ga=t,f=24,s=2,v=1,i=31,m=1;AAAA\x1b\\\x1bcafter\x1b[c";
        let accepted = terminal.apply_bytes(input);
        assert!(terminal.graphics_pending());
        assert_eq!(visible(&terminal), "");
        assert!(replies(&rx).is_empty());
        resume(&mut terminal, input, accepted).await;
        assert_eq!(visible(&terminal), "after");
        assert_eq!(replies(&rx).len(), 1);
        assert!(terminal.graphics.scene.is_empty());
        assert_eq!(terminal.graphics.storage.used().unwrap().bytes, 0);
        assert_eq!(terminal.graphics.processing.used().unwrap().bytes, 0);
        terminal.shutdown_graphics().await;
    }

    #[tokio::test]
    async fn quota_refusal_drains_continuations_and_respects_their_quiet_policy() {
        for quiet in [0, 1, 2] {
            let (mut terminal, rx) = terminal();
            terminal.graphics.storage = Budget::new(Usage {
                bytes: 0,
                objects: 0,
            });
            let input = format!(
                "\x1b_Ga=t,f=24,s=2,v=1,i=31,m=1;AAAA\x1b\\between\x1b_Gm=0,q={quiet};AAAA\x1b\\after\x1b[c"
            );
            assert_eq!(terminal.apply_bytes(input.as_bytes()), input.len());
            assert!(!terminal.graphics_pending());
            assert_eq!(visible(&terminal), "betweenafter");
            let output = replies(&rx);
            assert_eq!(output.len(), if quiet == 2 { 1 } else { 2 });
            if quiet != 2 {
                assert!(output[0].starts_with(b"\x1b_Gi=31;ENOSPC:"));
            }
            assert!(terminal.graphics.scene.is_empty());
            assert_eq!(terminal.graphics.processing.used().unwrap().bytes, 0);
            terminal.shutdown_graphics().await;
        }
    }

    /// Integrations that run the helper `bun run build:image-worker` builds, under
    /// each test's own resource ceilings. They are ignored in the default lane;
    /// `bun run gates` runs them with `--ignored real_helper::` after that build.
    mod real_helper {
        use super::*;

        fn terminal() -> (TerminalState, Receiver<TerminalEvent>) {
            let (tx, rx) = crossbeam_channel::unbounded();
            let mut terminal = TerminalState::new(80, 3, tx);
            terminal.graphics = Graphics::with_built_worker();
            (terminal, rx)
        }

        #[tokio::test]
        #[ignore = "real helper: bun run build:image-worker"]
        async fn matches_pinned_kitty_core_geometry_and_grid_trace() {
            use futures::FutureExt;
            let corpus: serde_json::Value = serde_json::from_str(include_str!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../../../tests/fixtures/kitty/reference.json"
            )))
            .unwrap();
            // Every case replays independently, so one run reports each divergence.
            let mut failed = Vec::new();
            for case in corpus["cases"].as_array().unwrap() {
                if std::panic::AssertUnwindSafe(replay_reference_case(case))
                    .catch_unwind()
                    .await
                    .is_err()
                {
                    failed.push(case["name"].as_str().unwrap());
                }
            }
            assert!(failed.is_empty(), "diverging cases: {failed:?}");
        }

        async fn replay_reference_case(case: &serde_json::Value) {
            let (mut terminal, rx) = terminal();
            let mut cols = 16;
            let mut rows = 8;
            let mut generation = 1;
            terminal.resize_viewport(crate::pty::Viewport {
                geometry_generation: generation,
                cols,
                rows,
                seq: generation as u32,
                cell: CellMetrics::new(8 << 16, 16 << 16),
                pixel_width: cols * 8,
                pixel_height: rows * 16,
            });
            for (index, step) in case["steps"].as_array().unwrap().iter().enumerate() {
                let context = format!("{} step {index}", case["name"]);
                if let Some(size) = step["resize"].as_array() {
                    cols = size[0].as_u64().unwrap() as u16;
                    rows = size[1].as_u64().unwrap() as u16;
                    generation += 1;
                    terminal.resize_viewport(crate::pty::Viewport {
                        geometry_generation: generation,
                        cols,
                        rows,
                        seq: generation as u32,
                        cell: CellMetrics::new(8 << 16, 16 << 16),
                        pixel_width: cols * 8,
                        pixel_height: rows * 16,
                    });
                } else {
                    // A repeated input is one step: its bytes, written that many times.
                    let bytes = step["input"].as_str().unwrap().as_bytes();
                    for _ in 0..step["repeat"].as_u64().unwrap_or(1) {
                        let accepted = terminal.apply_bytes(bytes);
                        resume(&mut terminal, bytes, accepted).await;
                    }
                }
                // A documented upstream deviation keeps Kitty's observation and
                // names the explicit normative oracle Merkur is held to.
                let normative = |key: &str| step.get(format!("normative_{key}")).unwrap_or(&step[key]);
                // Error descriptions are implementation-specific; protocol selectors
                // and success/error codes are the interoperable response contract.
                let normalize = |bytes: &[u8]| {
                    String::from_utf8(bytes.to_vec())
                        .unwrap()
                        .split("\x1b\\")
                        .filter(|part| !part.is_empty())
                        .map(|part| {
                            part.split_once(':')
                                .map_or(part, |(code, _)| code)
                                .to_owned()
                        })
                        .collect::<Vec<_>>()
                };
                assert_eq!(
                    normalize(&replies(&rx).concat()),
                    normalize(normative("replies").as_str().unwrap().as_bytes()),
                    "{context}"
                );
                let cursor = terminal.term.grid().cursor.point;
                assert_eq!(
                    serde_json::json!([cursor.column.0, cursor.line.0]),
                    step["cursor"],
                    "{context}"
                );
                if step.get("images").is_some() {
                    assert_images(
                        &terminal.graphics,
                        normative("images"),
                        case["tolerance"].as_u64().unwrap_or(0) as u8,
                        &context,
                    );
                }
                let mut actual = Vec::<Vec<f64>>::new();
                for row in 0..rows {
                    let bytes = terminal.graphics.row(usize::from(row)).bytes();
                    if bytes.is_empty() {
                        continue;
                    }
                    let mut fragments = Vec::new();
                    merkur_codec::decode_graphics(
                        &mut &bytes[4..],
                        bytes.len() - 4,
                        cols,
                        &mut fragments,
                        &mut Vec::new(),
                    )
                    .unwrap();
                    for fragment in fragments {
                        let s = fragment.slice;
                        let mut fields = vec![
                            f64::from(row),
                            f64::from(fragment.stack.image_id),
                            f64::from(fragment.stack.z),
                        ];
                        fields.extend(
                            [
                                s.left,
                                s.right,
                                s.top,
                                s.bottom,
                                s.source_left,
                                s.source_right,
                                s.source_top,
                                s.source_bottom,
                            ]
                            .map(|value| value as f64 / CELL_UNIT as f64),
                        );
                        actual.push(fields);
                    }
                }
                let expected: Vec<Vec<f64>> = normative("rows")
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|row| {
                        row.as_array()
                            .unwrap()
                            .iter()
                            .map(|value| value.as_f64().unwrap())
                            .collect()
                    })
                    .collect();
                let (actual, expected) = (stacking(actual), stacking(expected));
                assert_eq!(
                    actual.len(),
                    expected.len(),
                    "{context}: {actual:?} != {expected:?}"
                );
                for (actual, expected) in actual.iter().zip(&expected) {
                    assert!(
                        actual.0 == expected.0
                            && actual.1.len() == expected.1.len()
                            && actual.1.iter().zip(&expected.1).all(|(a, b)| {
                                a.iter().zip(b).all(|(a, b)| (a - b).abs() < 0.00002)
                            }),
                        "{context}: {actual:?} != {expected:?}"
                    );
                }
            }
            terminal.shutdown_graphics().await;
        }

        #[tokio::test]
        #[ignore = "real helper: bun run build:image-worker"]
        async fn a_viewport_without_cell_pixels_retires_placements_and_refuses_new_ones() {
            let (mut terminal, rx) = terminal();
            let viewport = |seq, cell: Option<CellMetrics>| crate::pty::Viewport {
                geometry_generation: 1,
                cols: 80,
                rows: 3,
                seq,
                cell,
                pixel_width: if cell.is_some() { 640 } else { 0 },
                pixel_height: if cell.is_some() { 48 } else { 0 },
            };
            terminal.resize_viewport(viewport(1, CellMetrics::new(8 << 16, 16 << 16)));
            let base = b"\x1b_Ga=T,i=41,f=32,s=2,v=1,c=2,r=1,C=1;/wAA//8AAP8=\x1b\\";
            let accepted = terminal.apply_bytes(base);
            resume(&mut terminal, base, accepted).await;
            assert_eq!(replies(&rx), [b"\x1b_Gi=41;OK\x1b\\".to_vec()]);
            let incarnation = terminal.graphics.scene.resolve_id(41).unwrap();
            assert!(terminal.graphics.projects_any_row());
            // A host that knows no cell pixels took the geometry.
            terminal.resize_viewport(viewport(2, None));
            assert!(
                terminal
                    .graphics
                    .placements
                    .image_placements(incarnation)
                    .next()
                    .is_none()
            );
            assert!(!terminal.graphics.projects_any_row());
            let again = b"\x1b_Ga=p,i=41,c=2,r=1,C=1\x1b\\";
            let accepted = terminal.apply_bytes(again);
            resume(&mut terminal, again, accepted).await;
            let output = replies(&rx);
            assert_eq!(output.len(), 1);
            assert!(output[0].starts_with(b"\x1b_Gi=41;EAGAIN:"));
            assert!(!terminal.graphics.projects_any_row());
            // One that states them again places as before.
            terminal.resize_viewport(viewport(3, CellMetrics::new(8 << 16, 16 << 16)));
            let accepted = terminal.apply_bytes(again);
            resume(&mut terminal, again, accepted).await;
            assert_eq!(replies(&rx), [b"\x1b_Gi=41;OK\x1b\\".to_vec()]);
            assert!(terminal.graphics.projects_any_row());
        }

        #[tokio::test]
        #[ignore = "real helper: bun run build:image-worker"]
        async fn animation_commands_preserve_placements_and_parser_order() {
            use merkur_image_worker::frame::Raster;
            let (mut terminal, rx) = terminal();
            terminal.resize_viewport(crate::pty::Viewport {
                geometry_generation: 1,
                cols: 80,
                rows: 3,
                seq: 1,
                cell: CellMetrics::new(8 << 16, 16 << 16),
                pixel_width: 640,
                pixel_height: 48,
            });
            let base = b"\x1b_Ga=T,i=41,f=32,s=2,v=1,c=2,r=1,C=1;/wAA//8AAP8=\x1b\\";
            let accepted = terminal.apply_bytes(base);
            resume(&mut terminal, base, accepted).await;
            assert_eq!(replies(&rx), [b"\x1b_Gi=41;OK\x1b\\".to_vec()]);
            let incarnation = terminal.graphics.scene.resolve_id(41).unwrap();
            let retained = Arc::clone(terminal.graphics.scene.image(incarnation).unwrap());
            let placement = terminal
                .graphics
                .placements
                .image_placements(incarnation)
                .next()
                .unwrap();
            let add = b"\x1b_Ga=f,i=41,f=32,s=1,v=1,c=1,x=1,z=50;AAD/gA==\x1b\\after\x1b[c";
            let accepted = terminal.apply_bytes(add);
            resume(&mut terminal, add, accepted).await;
            let output = replies(&rx);
            assert_eq!(output.len(), 2);
            assert_eq!(output[0], b"\x1b_Gi=41,r=2;OK\x1b\\");
            assert_eq!(visible(&terminal), "after");
            assert_eq!(terminal.graphics.scene.resolve_id(41), Some(incarnation));
            assert!(terminal.graphics.placements.get(placement).is_some());
            assert!(retained.content.is_retired());
            let image = terminal.graphics.scene.image(incarnation).unwrap();
            let animation = image.content.animation().unwrap();
            assert_eq!(animation.frames().len(), 2);
            assert_eq!(
                animation.frames()[0].run(0, 0),
                [255, 0, 0, 255, 255, 0, 0, 255]
            );
            assert_eq!(
                animation.frames()[1].run(0, 0),
                [255, 0, 0, 255, 127, 0, 128, 255]
            );
            let controls = b"\x1b_Ga=a,i=41,c=2,r=1,z=25,s=1\x1b\\\x1b_Ga=c,i=41,r=2,c=1,w=1,h=1,X=1,x=0,C=1\x1b\\\x1b[c";
            let accepted = terminal.apply_bytes(controls);
            resume(&mut terminal, controls, accepted).await;
            // Animation control is silent; composition is acknowledged before DA.
            let output = replies(&rx);
            assert_eq!(output.len(), 2);
            assert_eq!(output[0], b"\x1b_Gi=41;OK\x1b\\");
            let animation = terminal
                .graphics
                .scene
                .image(incarnation)
                .unwrap()
                .content
                .animation()
                .unwrap();
            assert_eq!(animation.manifest().playback().frame, 1);
            assert_eq!(animation.manifest().entry(0).unwrap().gap_ms, 25);
            assert_eq!(
                animation.frames()[0].run(0, 0),
                [127, 0, 128, 255, 255, 0, 0, 255]
            );
            let remove = b"\x1b_Ga=d,d=f,i=41,r=1\x1b\\\x1b[c";
            let accepted = terminal.apply_bytes(remove);
            resume(&mut terminal, remove, accepted).await;
            assert_eq!(replies(&rx).len(), 1);
            assert_eq!(
                terminal
                    .graphics
                    .scene
                    .image(incarnation)
                    .unwrap()
                    .content
                    .animation()
                    .unwrap()
                    .frames()
                    .len(),
                1
            );
            terminal.apply_bytes(b"\x1b_Ga=d,d=F,i=41\x1b\\");
            assert!(terminal.graphics.scene.is_empty());
            assert!(terminal.graphics.placements.is_empty());
            drop(retained);
            terminal.shutdown_graphics().await;
            merkur_image_worker::retirement::drain();
            assert_eq!(terminal.graphics.processing.used().unwrap().bytes, 0);
            assert_eq!(terminal.graphics.storage.used().unwrap().bytes, 0);
        }

        #[tokio::test]
        #[ignore = "real helper: bun run build:image-worker"]
        async fn frame_numbers_and_controls_follow_kitty() {
            use merkur_graphics::animation::Mode;
            let (mut terminal, rx) = terminal();
            terminal.resize_viewport(crate::pty::Viewport {
                geometry_generation: 1,
                cols: 80,
                rows: 3,
                seq: 1,
                cell: CellMetrics::new(8 << 16, 16 << 16),
                pixel_width: 640,
                pixel_height: 48,
            });
            let upload = b"\x1b_Ga=t,i=5,f=24,s=1,v=1,q=1;/wAA\x1b\\";
            let accepted = terminal.apply_bytes(upload);
            resume(&mut terminal, upload, accepted).await;
            // Any frame number after the last one appends, and every frame reply
            // names its target frame once the image resolves, including failures.
            for (command, reply) in [
                (
                    &b"\x1b_Ga=f,i=5,r=7,f=24,s=1,v=1;AP8A\x1b\\"[..],
                    &b"\x1b_Gi=5,r=2;OK\x1b\\"[..],
                ),
                (
                    b"\x1b_Ga=f,i=5,r=2,f=24,s=1,v=1;AAD/\x1b\\",
                    b"\x1b_Gi=5,r=2;OK\x1b\\",
                ),
                (
                    b"\x1b_Ga=f,i=5,c=9,f=24,s=1,v=1;AAD/\x1b\\",
                    b"\x1b_Gi=5,r=3;EINVAL:invalid graphics command\x1b\\",
                ),
                (
                    b"\x1b_Ga=f,i=5,f=24,s=2,v=1;AAD/AAD/\x1b\\",
                    b"\x1b_Gi=5,r=3;EINVAL:invalid graphics command\x1b\\",
                ),
            ] {
                let accepted = terminal.apply_bytes(command);
                resume(&mut terminal, command, accepted).await;
                assert_eq!(replies(&rx), [reply.to_vec()]);
            }
            let animation = |terminal: &TerminalState| {
                let image = terminal.graphics.scene.resolve_id(5).unwrap();
                let image = terminal.graphics.scene.image(image).unwrap();
                let animation = image.content.animation().unwrap();
                let playback = animation.manifest().playback();
                (playback.mode, playback.frame, animation.frames().len())
            };
            assert_eq!(animation(&terminal), (Mode::Stopped, 0, 2));
            // Control applies each valid field; absent frames and unknown states
            // are ignored without a reply.
            for (command, expected) in [
                (
                    &b"\x1b_Ga=a,i=5,s=2,c=9,r=9,z=5\x1b\\"[..],
                    (Mode::Loading, 0, 2),
                ),
                (b"\x1b_Ga=a,i=5,s=9,c=2\x1b\\", (Mode::Loading, 1, 2)),
                (b"\x1b_Ga=a,i=5,s=1,c=0\x1b\\", (Mode::Stopped, 1, 2)),
            ] {
                let accepted = terminal.apply_bytes(command);
                resume(&mut terminal, command, accepted).await;
                assert_eq!(animation(&terminal), expected);
            }
            assert!(replies(&rx).is_empty());
            terminal.shutdown_graphics().await;
        }

        #[tokio::test]
        #[ignore = "real helper: bun run build:image-worker"]
        async fn selectors_delete_selected_descendants_directly() {
            let (mut terminal, rx) = terminal();
            terminal.resize_viewport(crate::pty::Viewport {
                geometry_generation: 1,
                cols: 80,
                rows: 3,
                seq: 1,
                cell: CellMetrics::new(8 << 16, 16 << 16),
                pixel_width: 640,
                pixel_height: 48,
            });
            let upload =
                b"\x1b_Ga=t,i=1,f=24,s=1,v=1,q=1;/wAA\x1b\\\x1b_Ga=t,i=2,f=24,s=1,v=1,q=1;AP8A\x1b\\";
            let accepted = terminal.apply_bytes(upload);
            resume(&mut terminal, upload, accepted).await;
            let place = b"\x1b[1;1H\x1b_Ga=p,i=1,p=1,c=2,r=1,q=1\x1b\\\x1b_Ga=p,i=2,p=1,P=1,Q=1,H=3,c=1,r=1,q=1\x1b\\";
            // A child the selector matches itself is deleted by that selector:
            // lowercase keeps its image. A child deleted through its parent
            // releases an image left without placements, whatever the case.
            for (delete, retained) in [
                (&b"\x1b_Ga=d,d=a\x1b\\"[..], true),
                (b"\x1b_Ga=d,d=i,i=1\x1b\\", false),
            ] {
                terminal.apply_bytes(place);
                assert_eq!(terminal.graphics.placements.len(), 2);
                terminal.apply_bytes(delete);
                assert!(terminal.graphics.placements.is_empty());
                assert!(terminal.graphics.scene.resolve_id(1).is_some());
                assert_eq!(terminal.graphics.scene.resolve_id(2).is_some(), retained);
            }
            assert!(replies(&rx).is_empty());
            terminal.shutdown_graphics().await;
        }

        #[tokio::test]
        #[ignore = "real helper: bun run build:image-worker"]
        async fn graphics_damage_only_tracks_changed_rows() {
            let (mut terminal, rx) = terminal();
            terminal.resize_viewport(crate::pty::Viewport {
                geometry_generation: 1,
                cols: 80,
                rows: 8,
                seq: 1,
                cell: CellMetrics::new(8 << 16, 16 << 16),
                pixel_width: 640,
                pixel_height: 128,
            });
            let upload = b"\x1b_Ga=t,f=24,s=1,v=1,i=71;AAAA\x1b\\";
            let accepted = terminal.apply_bytes(upload);
            resume(&mut terminal, upload, accepted).await;
            assert_eq!(replies(&rx).len(), 1);
            terminal.apply_bytes(b"\x1b[3;1H");
            let place = b"\x1b_Ga=p,i=71,p=5,c=2,r=2,C=1;\x1b\\";
            for (command, expected) in [
                (place.as_slice(), vec![2, 3]),
                (place.as_slice(), vec![2]),
                (b"\x1b_Ga=d,d=i,i=71,p=5;\x1b\\".as_slice(), vec![2, 3]),
            ] {
                terminal.dirty_rows.clear();
                terminal.apply_bytes(command);
                let dirty: Vec<_> = terminal.dirty_rows.iter().collect();
                assert_eq!(dirty, expected);
            }
            terminal.shutdown_graphics().await;
        }

        #[tokio::test]
        #[ignore = "real helper: bun run build:image-worker"]
        async fn placeholder_rebinding_is_sparse_and_resolves_late_prototypes() {
            let (mut terminal, _rx) = terminal();
            terminal.resize_viewport(crate::pty::Viewport {
                geometry_generation: 1,
                cols: 8,
                rows: 6,
                seq: 1,
                cell: CellMetrics::new(8 << 16, 16 << 16),
                pixel_width: 64,
                pixel_height: 96,
            });
            let upload = b"\x1b_Ga=T,f=24,s=1,v=2,i=42,p=7,U=1,c=2,r=2;AAAA////\x1b\\";
            let accepted = terminal.apply_bytes(upload);
            resume(&mut terminal, upload, accepted).await;
            terminal.apply_bytes(b"\x1b_Ga=p,i=42,p=8,U=1,c=2,r=2;\x1b\\");
            terminal.apply_bytes(
                concat!(
                    "\x1b[1;1H\x1b[38;5;42;58;5;7m\u{10eeee}\u{305}\u{305}",
                    "\x1b[3;1H\x1b[58;5;8m\u{10eeee}\u{305}\u{305}",
                    "\x1b[5;1H\x1b[58;5;9m\u{10eeee}\u{305}\u{305}",
                )
                .as_bytes(),
            );
            let retained = terminal.graphics.row(0).clone();
            let other = terminal.graphics.row(2).clone();
            assert!(terminal.graphics.row(4).is_empty());
            terminal.apply_bytes(b"\x1b_Ga=p,i=42,p=8,U=1,c=3,r=3;\x1b\\");
            assert_eq!(
                retained.bytes().as_ptr(),
                terminal.graphics.row(0).bytes().as_ptr()
            );
            assert_ne!(other.bytes(), terminal.graphics.row(2).bytes());
            terminal.apply_bytes(b"\x1b_Ga=p,i=42,p=9,U=1,c=2,r=2;\x1b\\");
            assert!(!terminal.graphics.row(4).is_empty());
            assert_eq!(retained.bytes(), terminal.graphics.row(0).bytes());
            let retained = terminal.graphics.row(0).clone();
            // Removing a prototype must retire its reverse edges without disturbing
            // the other selectors, even though their source image is shared.
            terminal.apply_bytes(b"\x1b_Ga=d,d=i,i=42,p=8;\x1b\\");
            assert!(terminal.graphics.row(2).is_empty());
            assert_eq!(
                retained.bytes().as_ptr(),
                terminal.graphics.row(0).bytes().as_ptr()
            );
            assert!(!terminal.graphics.row(4).is_empty());
            terminal.shutdown_graphics().await;
        }

        #[tokio::test]
        #[ignore = "real helper: bun run build:image-worker"]
        async fn placeholders_follow_grid_edits_and_move_relative_descendants() {
            let (mut terminal, rx) = terminal();
            terminal.resize_viewport(crate::pty::Viewport {
                geometry_generation: 1,
                cols: 8,
                rows: 6,
                seq: 1,
                cell: CellMetrics::new(8 << 16, 16 << 16),
                pixel_width: 64,
                pixel_height: 96,
            });
            let upload = b"\x1b_Ga=T,f=24,s=1,v=2,i=42,p=7,U=1,c=2,r=2,z=5;AAAA////\x1b\\";
            let accepted = terminal.apply_bytes(upload);
            resume(&mut terminal, upload, accepted).await;
            assert_eq!(replies(&rx), [b"\x1b_Gi=42,p=7;OK\x1b\\".to_vec()]);
            assert!(terminal.graphics.projected.iter().all(|row| row.is_empty()));
            let text = "\x1b[1;1H\x1b[38;5;42;58;5;7m\u{10eeee}\u{305}\u{305}\u{10eeee}";
            terminal.apply_bytes(text.as_bytes());
            let image = terminal.graphics.scene.resolve_id(42).unwrap();
            let parent = terminal.graphics.placements.resolve(image, 7).unwrap();
            let index = terminal.graphics.placeholders.as_ref().unwrap();
            assert_eq!(index.origin(parent), Some(Position { column: 0, line: 0 }));
            assert_eq!(
                index.row(0).len(),
                1,
                "contiguous placeholders share one row descriptor"
            );
            assert_eq!(index.row(0)[0].slice.right, 2 * CELL_UNIT);
            // Placeholder images sit just beneath text, whatever z the virtual
            // placement requested, as in Kitty.
            assert_eq!(index.row(0)[0].stack.z, -1);
            assert!(terminal.graphics.row(0).matches(8, index.row(0)));
            let retained = terminal.graphics.row(0).clone();
            let retained_bytes = retained.bytes().to_vec();
            terminal.apply_bytes(b"\x1b_Ga=p,i=42,p=8,P=42,Q=7,H=3,V=1,c=1,r=1;\x1b\\");
            let child = terminal.graphics.placements.resolve(image, 8).unwrap();
            assert_eq!(
                terminal.graphics.position(&terminal.term, child),
                Some(Position { column: 3, line: 1 })
            );
            assert!(!terminal.graphics.row(1).is_empty());

            // Move a partial image cell through ordinary text. A virtual parent
            // sits at its placeholder cells, whichever image cell they show, as in
            // Kitty: the source cell is not subtracted.
            terminal.apply_bytes("\x1b[1;1H\x1b[2K\x1b[3;5H\u{10eeee}\u{30d}\u{30d}".as_bytes());
            assert_eq!(
                terminal.graphics.position(&terminal.term, child),
                Some(Position { column: 7, line: 3 })
            );
            assert!(terminal.graphics.row(0).is_empty());
            assert!(terminal.graphics.row(1).is_empty());
            assert!(!terminal.graphics.row(2).is_empty());
            assert!(!terminal.graphics.row(3).is_empty());
            assert_eq!(retained.bytes(), retained_bytes);

            // Alternate-screen replacement hides both the text-derived image and
            // descendants, then restores them from the grid's actual saved cells.
            terminal.apply_bytes(b"\x1b[?1049h");
            assert!(terminal.graphics.projected.iter().all(|row| row.is_empty()));
            assert!(terminal.graphics.position(&terminal.term, child).is_none());
            terminal.apply_bytes(b"\x1b[?1049l");
            assert_eq!(
                terminal.graphics.position(&terminal.term, child),
                Some(Position { column: 7, line: 3 })
            );

            // A spatial command following text in the same parser read must use
            // the updated virtual origin, before the final display capture runs.
            terminal.apply_bytes(b"\x1b[3;1H\x1b[1L\x1b_Ga=d,d=y,y=5;\x1b\\");
            assert!(terminal.graphics.placements.get(child).is_none());
            assert!(terminal.graphics.placements.get(parent).is_some());
            assert!(!terminal.graphics.row(3).is_empty());
            terminal.apply_bytes(b"\x1b_Ga=d,d=i,i=42,p=7;\x1b\\");
            assert!(terminal.graphics.projected.iter().all(|row| row.is_empty()));
            assert!(terminal.graphics.placeholders.is_none());
            terminal.shutdown_graphics().await;
            drop(retained);
            merkur_image_worker::retirement::drain();
            assert_eq!(
                terminal.graphics.storage.used(),
                Some(Usage {
                    bytes: 0,
                    objects: 0
                })
            );
        }

        /// A viewer that still holds every row it was sent holds their bytes and
        /// versions, never their storage. The same pressure and scroll leave the
        /// same scene and rows with and without those captures: releasing the
        /// projector's own rows covers the scroll, so no original is evicted.
        #[tokio::test]
        #[ignore = "real helper: bun run build:image-worker"]
        async fn retained_captures_never_evict_an_original() {
            let mut outcomes = Vec::new();
            for retain in [false, true] {
                let (mut terminal, rx) = terminal();
                terminal.resize_viewport(crate::pty::Viewport {
                    geometry_generation: 1,
                    cols: 80,
                    rows: 8,
                    seq: 1,
                    cell: CellMetrics::new(8 << 16, 16 << 16),
                    pixel_width: 640,
                    pixel_height: 128,
                });
                for upload in [
                    b"\x1b_Ga=T,f=24,s=1,v=1,i=71,c=2,r=8,C=1;AAAA\x1b\\".as_slice(),
                    b"\x1b_Ga=T,f=24,s=1,v=1,i=72,c=2,r=8,C=1;AQEB\x1b\\",
                ] {
                    let accepted = terminal.apply_bytes(upload);
                    resume(&mut terminal, upload, accepted).await;
                }
                assert_eq!(replies(&rx).len(), 2);
                let retained = retain.then(|| terminal.graphics.projected.clone());
                let first_bytes = terminal.graphics.row(0).bytes().to_vec();
                let used = terminal.graphics.storage.used().unwrap();
                let pressure = terminal
                    .graphics
                    .storage
                    .reserve(Usage {
                        bytes: STORAGE_BYTES - used.bytes,
                        objects: 0,
                    })
                    .unwrap();
                terminal.apply_bytes(b"\x1b[1S");
                outcomes.push((
                    terminal.graphics.scene.len(),
                    terminal.graphics.placements.len(),
                    (0..8)
                        .map(|row| terminal.graphics.row(row).bytes().to_vec())
                        .collect::<Vec<_>>(),
                ));
                if let Some(retained) = &retained {
                    assert_eq!(retained[0].bytes(), first_bytes);
                }
                drop(pressure);
                terminal.shutdown_graphics().await;
                drop(retained);
                merkur_image_worker::retirement::drain();
                assert_eq!(
                    terminal.graphics.storage.used(),
                    Some(Usage {
                        bytes: 0,
                        objects: 0
                    })
                );
            }
            let (images, placements, rows) = &outcomes[0];
            assert_eq!((*images, *placements), (2, 2));
            assert!(rows[..7].iter().all(|row| !row.is_empty()));
            assert!(rows[7].is_empty());
            assert_eq!(outcomes[1], outcomes[0]);
        }

        /// A placement that grows the projection workspace rebuilds it, and the
        /// rebuilt sweep still reuses every row whose content is unchanged: those
        /// rows keep their versions, so no viewer is sent their graphics again.
        #[tokio::test]
        #[ignore = "real helper: bun run build:image-worker"]
        async fn a_new_placement_keeps_the_versions_of_unchanged_rows() {
            let (mut terminal, rx) = terminal();
            terminal.resize_viewport(crate::pty::Viewport {
                geometry_generation: 1,
                cols: 80,
                rows: 8,
                seq: 1,
                cell: CellMetrics::new(8 << 16, 16 << 16),
                pixel_width: 640,
                pixel_height: 128,
            });
            let first = b"\x1b_Ga=T,f=24,s=1,v=1,i=71,c=2,r=2,C=1;AAAA\x1b\\";
            let accepted = terminal.apply_bytes(first);
            resume(&mut terminal, first, accepted).await;
            let before: Vec<_> = (0..8).map(|row| terminal.graphics.row(row).version()).collect();
            assert!(before[0].is_some() && before[1].is_some());
            // A second placement: the workspace sized for one is rebuilt for two.
            let second = b"\x1b[5;1H\x1b_Ga=T,f=24,s=1,v=1,i=72,c=2,r=2,C=1;AQEB\x1b\\";
            let accepted = terminal.apply_bytes(second);
            resume(&mut terminal, second, accepted).await;
            assert_eq!(replies(&rx).len(), 2);
            let after: Vec<_> = (0..8).map(|row| terminal.graphics.row(row).version()).collect();
            assert_eq!(after[..4], before[..4]);
            assert!(after[4].is_some() && after[5].is_some());
            assert_eq!(after[6..], before[6..]);
            terminal.shutdown_graphics().await;
        }

        /// Three sources over 64 rows, the oldest held as an in-flight transfer
        /// holds it. The alternate screen hides every placement, which releases
        /// the projection's own rows. With `defer`, the storage that leaves is
        /// then taken, all but one byte less than 64 rows of two fragments once
        /// the oldest placement's refund lands. Leaving the alternate screen
        /// brings back 64 rows of three with nothing of the projector's own left
        /// to release: the oldest source goes, and the next shortfall defers
        /// behind its physical release.
        async fn deferred_behind_the_oldest_source(
            defer: bool,
        ) -> (
            TerminalState,
            Receiver<TerminalEvent>,
            Arc<Image<ImageContent>>,
            Option<merkur_graphics::budget::Lease>,
        ) {
            use merkur_graphics::placements::PLACEMENT_METADATA_BYTES;
            let (mut terminal, rx) = terminal();
            terminal.resize_viewport(crate::pty::Viewport {
                geometry_generation: 1,
                cols: 80,
                rows: 64,
                seq: 1,
                cell: CellMetrics::new(8 << 16, 16 << 16),
                pixel_width: 640,
                pixel_height: 1024,
            });
            for upload in [
                b"\x1b_Ga=T,f=24,s=1,v=1,i=81,c=2,r=64,C=1;AAAA\x1b\\".as_slice(),
                b"\x1b_Ga=T,f=24,s=1,v=1,i=82,c=2,r=64,C=1;AQEB\x1b\\",
                b"\x1b_Ga=T,f=24,s=1,v=1,i=83,c=2,r=64,C=1;AgIC\x1b\\",
            ] {
                let accepted = terminal.apply_bytes(upload);
                resume(&mut terminal, upload, accepted).await;
            }
            assert_eq!(replies(&rx).len(), 3);
            let oldest = terminal.graphics.scene.resolve_id(81).unwrap();
            let held = Arc::clone(terminal.graphics.scene.image(oldest).unwrap());
            assert!(terminal.graphics.projected.iter().all(|row| !row.is_empty()));
            merkur_image_worker::retirement::drain();
            terminal.apply_bytes(b"\x1b[?1049h");
            assert!(terminal.graphics.projected.iter().all(|row| row.is_empty()));
            let pressure = defer.then(|| {
                let used = terminal.graphics.storage.used().unwrap();
                let row = merkur_codec::PreparedGraphics::reservation_bound(2).unwrap();
                terminal
                    .graphics
                    .storage
                    .reserve(Usage {
                        bytes: STORAGE_BYTES
                            - used.bytes
                            - (64 * row.bytes - PLACEMENT_METADATA_BYTES - 1),
                        objects: 0,
                    })
                    .unwrap()
            });
            terminal.apply_bytes(b"\x1b[?1049l");
            assert_eq!(terminal.graphics.projection_deferred, defer);
            assert_eq!(terminal.graphics.scene.image(oldest).is_none(), defer);
            (terminal, rx, held, pressure)
        }

        #[tokio::test]
        #[ignore = "real helper: bun run build:image-worker"]
        async fn projection_evicts_one_source_per_observed_release() {
            let (mut terminal, _rx, held, pressure) = deferred_behind_the_oldest_source(true).await;
            assert_eq!(terminal.graphics.scene.len(), 2);
            assert!(terminal.graphics.row(0).is_empty());
            // Deferred: later output neither evicts nor re-runs admission, and a
            // fetch lookup charges nothing.
            let used = terminal.graphics.storage.used();
            terminal.apply_bytes(b"\x1b[1S");
            terminal.apply_bytes(b"\x1b[1S");
            assert_eq!(terminal.graphics.scene.len(), 2);
            let newest = terminal.graphics.scene.resolve_id(83).unwrap();
            let source = terminal.graphics.scene.image(newest).unwrap();
            let root = source.content.descriptor().root;
            assert!(terminal.graphics_source(&root).is_some());
            assert_eq!(terminal.graphics.storage.used(), used);
            assert!(terminal.graphics.row(0).is_empty());
            drop(held);
            terminal.graphics_release().unwrap().wait().await;
            terminal.observe_graphics_release();
            assert!(!terminal.graphics.projection_deferred);
            assert!(terminal.graphics_release().is_none());
            assert_eq!(terminal.graphics.scene.len(), 2);
            let bytes = terminal.graphics.row(0).bytes();
            let mut fragments = Vec::new();
            merkur_codec::decode_graphics(
                &mut &bytes[4..],
                bytes.len() - 4,
                80,
                &mut fragments,
                &mut Vec::new(),
            )
            .unwrap();
            let mut images: Vec<_> = fragments.iter().map(|f| f.stack.image_id).collect();
            images.sort_unstable();
            assert_eq!(images, [82, 83]);
            drop(pressure);
            terminal.shutdown_graphics().await;
            merkur_image_worker::retirement::drain();
            assert_eq!(
                terminal.graphics.storage.used(),
                Some(Usage {
                    bytes: 0,
                    objects: 0
                })
            );
        }

        #[tokio::test]
        #[ignore = "real helper: bun run build:image-worker"]
        async fn spatial_deletion_sees_placeholder_origins_while_projection_is_deferred() {
            let mut outcomes = Vec::new();
            for deferred in [false, true] {
                let (mut terminal, rx, held, pressure) =
                    deferred_behind_the_oldest_source(deferred).await;
                // Storage no longer limits the index; only the deferral differs.
                drop(pressure);
                // The first virtual placement and its placeholder cell at (10, 5). Output
                // alone rebuilds no index while the projection is deferred.
                for bytes in [
                    b"\x1b_Ga=p,i=83,p=9,U=1,c=2,r=2;\x1b\\".as_slice(),
                    "\x1b[6;11H\x1b[38;5;83;58;5;9m\u{10eeee}\u{305}\u{305}\x1b[m".as_bytes(),
                ] {
                    assert_eq!(terminal.apply_bytes(bytes), bytes.len());
                }
                assert_eq!(terminal.graphics.placeholders.is_some(), !deferred);
                // A child three columns right and one row down, then a point deletion of
                // its cell. Commands rebuild the index on demand.
                for bytes in [
                    b"\x1b_Ga=p,i=83,p=10,P=83,Q=9,H=3,V=1,c=1,r=1;\x1b\\".as_slice(),
                    b"\x1b_Ga=d,d=p,x=14,y=7;\x1b\\",
                ] {
                    assert_eq!(terminal.apply_bytes(bytes), bytes.len());
                }
                assert_eq!(terminal.graphics.projection_deferred, deferred);
                assert_eq!(terminal.graphics.scene.len(), if deferred { 2 } else { 3 });
                let image = terminal.graphics.scene.resolve_id(83).unwrap();
                outcomes.push((
                    replies(&rx),
                    terminal.graphics.placements.resolve(image, 9).is_some(),
                    terminal.graphics.placements.resolve(image, 10).is_some(),
                ));
                drop(held);
                if deferred {
                    terminal.graphics_release().unwrap().wait().await;
                    terminal.observe_graphics_release();
                }
                terminal.shutdown_graphics().await;
                merkur_image_worker::retirement::drain();
                assert_eq!(
                    terminal.graphics.storage.used(),
                    Some(Usage {
                        bytes: 0,
                        objects: 0
                    })
                );
            }
            // The deletion removed the child and kept its virtual parent, deferred or not.
            assert_eq!(
                outcomes[0],
                (
                    vec![
                        b"\x1b_Gi=83,p=9;OK\x1b\\".to_vec(),
                        b"\x1b_Gi=83,p=10;OK\x1b\\".to_vec()
                    ],
                    true,
                    false
                )
            );
            assert_eq!(outcomes[1], outcomes[0]);
        }

        #[tokio::test]
        #[ignore = "real helper: bun run build:image-worker"]
        async fn source_authorization_revokes_retained_readers_at_scene_mutations() {
            let (mut terminal, rx) = terminal();
            let upload = b"\x1b_Ga=t,f=24,s=1,v=1,i=71;AAAA\x1b\\";
            let accepted = terminal.apply_bytes(upload);
            resume(&mut terminal, upload, accepted).await;
            assert_eq!(replies(&rx).len(), 1);
            let id = terminal.graphics.scene.resolve_id(71).unwrap();
            let original = Arc::clone(terminal.graphics.scene.image(id).unwrap());
            let root = original.content.descriptor().root;
            assert!(Arc::ptr_eq(
                terminal.graphics.scene.source(&root).unwrap(),
                &original
            ));
            assert!(!original.content.is_retired());
            // An identical source under another image id independently authorizes access.
            let same = b"\x1b_Ga=t,f=24,s=1,v=1,i=72;AAAA\x1b\\";
            let accepted = terminal.apply_bytes(same);
            resume(&mut terminal, same, accepted).await;
            let duplicate = Arc::clone(terminal.graphics.scene.source(&root).unwrap());
            assert_ne!(duplicate.incarnation, original.incarnation);
            terminal.apply_bytes(b"\x1b_Ga=d,d=I,i=72;\x1b\\");
            assert!(duplicate.content.is_retired());
            duplicate.content.retired().await;
            assert!(Arc::ptr_eq(
                terminal.graphics.scene.source(&root).unwrap(),
                &original
            ));
            let replacement = b"\x1b_Ga=t,f=24,s=1,v=1,i=71;AQID\x1b\\";
            let accepted = terminal.apply_bytes(replacement);
            resume(&mut terminal, replacement, accepted).await;
            assert!(original.content.is_retired());
            original.content.retired().await;
            assert!(terminal.graphics.scene.source(&root).is_none());
            assert_eq!(
                original.content.decoded().unwrap().pixels().rgba(),
                [0, 0, 0, 255]
            );
            let id = terminal.graphics.scene.resolve_id(71).unwrap();
            let replacement = Arc::clone(terminal.graphics.scene.image(id).unwrap());
            let new_root = replacement.content.descriptor().root;
            terminal.apply_bytes(b"\x1bc");
            assert!(replacement.content.is_retired());
            assert!(terminal.graphics.scene.source(&new_root).is_none());
            terminal.shutdown_graphics().await;
            assert!(terminal.graphics.storage.used().unwrap().bytes > 0);
            drop((original, duplicate, replacement));
            merkur_image_worker::retirement::drain();
            assert_eq!(terminal.graphics.storage.used().unwrap().bytes, 0);
        }

        #[tokio::test]
        #[ignore = "real helper: bun run build:image-worker"]
        async fn extent_clipping_controls_deletion_and_source_retention() {
            let (mut terminal, rx) = terminal();
            terminal.resize_viewport(crate::pty::Viewport {
                geometry_generation: 1,
                cols: 80,
                rows: 8,
                seq: 1,
                cell: CellMetrics::new(8 << 16, 16 << 16),
                pixel_width: 640,
                pixel_height: 128,
            });
            let upload = b"\x1b_Ga=t,f=24,s=1,v=1,i=71;AAAA\x1b\\";
            let accepted = terminal.apply_bytes(upload);
            resume(&mut terminal, upload, accepted).await;
            assert_eq!(replies(&rx), [b"\x1b_Gi=71;OK\x1b\\".to_vec()]);
            let source = terminal.graphics.scene.resolve_id(71).unwrap();
            terminal.apply_bytes(b"\x1b[2;1H\x1b_Ga=p,i=71,p=1,c=2,r=4,C=1;\x1b\\\x1b[2;6r\x1b[1S");
            assert_eq!(replies(&rx), [b"\x1b_Gi=71,p=1;OK\x1b\\".to_vec()]);
            let placement = terminal.graphics.placements.resolve(source, 1).unwrap();
            assert!(terminal.graphics.row(0).is_empty());
            for row in 1..4 {
                assert!(!terminal.graphics.row(row).is_empty());
            }
            for row in 4..8 {
                assert!(terminal.graphics.row(row).is_empty());
            }
            let mut hashes = Vec::new();
            let (mut snapshot, _) = terminal.encode_snapshot_state_into(
                Vec::new(),
                &mut Vec::new(),
                &mut hashes,
                &mut Vec::new(),
            );
            crate::display::encoder::patch_stream_header(
                &mut snapshot,
                1,
                1,
                0,
                1,
                1,
                false,
                true,
                0,
                1,
                0,
                0,
            )
            .unwrap();
            let mut receiver = term_wasm::Terminal::new_headless(80, 8);
            assert!(receiver.apply_delta_seq(&snapshot, 1));
            for (row, hash) in hashes.into_iter().enumerate() {
                assert_eq!(receiver.row_hash(row as u16), hash);
            }
            assert_eq!(
                terminal
                    .graphics
                    .position(&terminal.term, placement)
                    .unwrap()
                    .line,
                0
            );
            // The logical origin is now above the margin; its clipped pixels cannot
            // participate in spatial deletion. The remaining visible part can.
            terminal.apply_bytes(b"\x1b_Ga=d,d=y,y=1;\x1b\\");
            assert!(terminal.graphics.placements.get(placement).is_some());
            terminal.apply_bytes(b"\x1b_Ga=d,d=y,y=2;\x1b\\");
            assert!(terminal.graphics.placements.get(placement).is_none());
            assert!(terminal.graphics.projected.is_empty());
            assert!(terminal.graphics.scene.image(source).is_some());

            terminal.apply_bytes(b"\x1b[r\x1b[1;1H\x1b_Ga=p,i=71,p=2,c=2,r=4,C=1;\x1b\\\x1b[2S");
            let placement = terminal.graphics.placements.resolve(source, 2).unwrap();
            assert_eq!(
                terminal
                    .graphics
                    .position(&terminal.term, placement)
                    .unwrap()
                    .line,
                -2
            );
            terminal.apply_bytes(b"\x1b[3J");
            assert!(terminal.graphics.placements.get(placement).is_some());
            assert_eq!(
                terminal
                    .graphics
                    .position(&terminal.term, placement)
                    .unwrap()
                    .line,
                -2
            );
            terminal.apply_bytes(b"\x1b[2J");
            assert!(terminal.graphics.placements.is_empty());
            assert!(terminal.graphics.scene.image(source).is_some());
            terminal.shutdown_graphics().await;
            merkur_image_worker::retirement::drain();
            assert_eq!(
                terminal.graphics.storage.used().unwrap(),
                Usage {
                    bytes: 0,
                    objects: 0
                }
            );
        }

        #[tokio::test]
        #[ignore = "real helper: bun run build:image-worker"]
        async fn query_upload_replacement_and_reset() {
            let (mut terminal, rx) = terminal();
            let query = b"\x1b_Ga=q,f=24,s=1,v=1,i=31;AAAA\x1b\\\x1b[c";
            let accepted = terminal.apply_bytes(query);
            resume(&mut terminal, query, accepted).await;
            assert_eq!(replies(&rx)[0], b"\x1b_Gi=31;OK\x1b\\");
            assert!(terminal.graphics.scene.is_empty());

            let control = Control::parse(b"i=31").unwrap();
            assert!(!terminal.graphics.memory_only);
            let text_header_signal = terminal.current_display_header_signal();
            let mut retained = None;
            for (encoded, expected) in [(b"AAAA".as_slice(), [0, 0, 0, 255]), (b"////", [255; 4])] {
                let upload = [
                    b"\x1b_Ga=t,f=24,s=1,v=1,i=31;".as_slice(),
                    encoded,
                    b"\x1b\\",
                ]
                .concat();
                let accepted = terminal.apply_bytes(&upload);
                resume(&mut terminal, &upload, accepted).await;
                assert_eq!(replies(&rx), [b"\x1b_Gi=31;OK\x1b\\".to_vec()]);
                let image_id = terminal.graphics.scene.resolve(&control).unwrap();
                let image = terminal.graphics.scene.image(image_id).unwrap();
                assert_eq!(image.content.decoded().unwrap().pixels().rgba(), expected);
                assert_eq!(image.content.descriptor().width, image.width);
                assert_eq!(image.content.descriptor().height, image.height);
                if retained.is_none() {
                    retained = Some(Arc::clone(image));
                }
            }
            let image_id = terminal.graphics.scene.resolve(&control).unwrap();
            assert_ne!(
                terminal
                    .graphics
                    .scene
                    .image(image_id)
                    .unwrap()
                    .content
                    .descriptor(),
                retained.as_ref().unwrap().content.descriptor(),
            );
            assert!(terminal.graphics.memory_only);
            assert_ne!(terminal.current_display_header_signal(), text_header_signal);
            let (snapshot, _) = terminal.encode_snapshot_into(Vec::new());
            assert!(
                merkur_codec::parse_frame_header(&snapshot)
                    .unwrap()
                    .memory_only
            );
            assert_eq!(
                retained
                    .as_ref()
                    .unwrap()
                    .content
                    .decoded()
                    .unwrap()
                    .pixels()
                    .rgba(),
                [0, 0, 0, 255]
            );
            terminal.apply_bytes(b"\x1bc");
            assert!(terminal.graphics.memory_only);
            assert!(terminal.graphics.scene.is_empty());
            assert!(terminal.graphics.storage.used().unwrap().bytes > 0);
            drop(retained);
            merkur_image_worker::retirement::drain();
            assert_eq!(terminal.graphics.storage.used().unwrap().bytes, 0);
            terminal.resize_viewport(crate::pty::Viewport {
                geometry_generation: 1,
                cols: 80,
                rows: 3,
                seq: 1,
                cell: merkur_graphics::geometry::CellMetrics::new(8 << 16, 16 << 16),
                pixel_width: 640,
                pixel_height: 48,
            });
            for control in [
                "a=T,f=24,s=1,v=1,C=1,p=900",
                "a=t,f=24,s=1,v=1",
                "a=T,f=24,s=1,v=1,P=999",
            ] {
                let upload = format!("\x1b_G{control};AAAA\x1b\\");
                let accepted = terminal.apply_bytes(upload.as_bytes());
                resume(&mut terminal, upload.as_bytes(), accepted).await;
                assert!(replies(&rx).is_empty());
                if control.contains("C=1") {
                    assert_eq!(terminal.graphics.placements.len(), 1);
                    assert_eq!(
                        terminal
                            .graphics
                            .placements
                            .iter()
                            .next()
                            .unwrap()
                            .client_id,
                        0
                    );
                    terminal.apply_bytes(b"\x1b_Ga=d,d=a;\x1b\\");
                }
                assert!(terminal.graphics.placements.is_empty());
                assert!(terminal.graphics.scene.is_empty());
                merkur_image_worker::retirement::drain();
                assert_eq!(
                    terminal.graphics.storage.used().unwrap(),
                    Usage {
                        bytes: 0,
                        objects: 0
                    }
                );
            }
            terminal.shutdown_graphics().await;
        }

        #[tokio::test]
        #[ignore = "real helper: bun run build:image-worker"]
        async fn queue_backpressure_preserves_every_chunk_once() {
            let (mut terminal, rx) = terminal();
            // 64 encoded chunks are exactly one 256x256 RGB image. A current-thread
            // runtime cannot consume any chunk before the first owner call yields,
            // so the bounded 16-slot queue must stop at an intermediate command.
            let mut input = Vec::new();
            for chunk in 0..64 {
                input.extend_from_slice(if chunk == 0 {
                    b"\x1b_Ga=t,f=24,s=256,v=256,i=31,m=1;"
                } else if chunk == 63 {
                    b"\x1b_Gm=0;"
                } else {
                    b"\x1b_Gm=1;"
                });
                input.extend_from_slice(&[b'A'; merkur_graphics::command::MAX_CHUNK_BYTES]);
                input.extend_from_slice(b"\x1b\\");
            }
            input.extend_from_slice(b"after\x1b[c");
            let accepted = terminal.apply_bytes(&input);
            assert!(accepted < input.len());
            assert!(terminal.graphics_pending());
            assert!(matches!(
                terminal.term.event_listener().graphics.pending(),
                Some(Step::Data { last: false, .. })
            ));
            let fence = terminal.graphics.job.as_ref().unwrap().fence;
            assert_eq!(terminal.apply_bytes(&input[accepted..]), 0);
            assert_eq!(terminal.graphics.job.as_ref().unwrap().fence, fence);
            assert!(replies(&rx).is_empty());
            resume(&mut terminal, &input, accepted).await;
            assert_eq!(visible(&terminal), "after");
            let output = replies(&rx);
            assert_eq!(output.len(), 2);
            assert_eq!(output[0], b"\x1b_Gi=31;OK\x1b\\");
            let id = terminal
                .graphics
                .scene
                .resolve(&Control::parse(b"i=31").unwrap())
                .unwrap();
            let image = terminal.graphics.scene.image(id).unwrap();
            assert_eq!(
                image.content.decoded().unwrap().pixels().rgba().len(),
                256 * 256 * 4
            );
            assert!(
                image
                    .content
                    .decoded()
                    .unwrap()
                    .pixels()
                    .rgba()
                    .chunks_exact(4)
                    .all(|pixel| pixel == [0, 0, 0, 255])
            );
            assert_eq!(terminal.graphics.processing.used().unwrap().bytes, 0);
            terminal.shutdown_graphics().await;
        }

        /// A transmission of a `side` x `side` RGB image, no placement.
        fn transmit(id: u32, side: u32) -> Vec<u8> {
            let payload = "A".repeat((side * side * 4) as usize);
            format!("\x1b_Ga=t,f=24,s={side},v={side},i={id};{payload}\x1b\\").into_bytes()
        }

        const DELETE_71: &[u8] = b"\x1b_Ga=d,d=I,i=71\x1b\\";

        /// A terminal holding image 71, 16x16, with every other byte and object
        /// of its storage taken, and 71 held as a transfer in flight holds it.
        async fn full_but_for_71() -> (
            TerminalState,
            Receiver<TerminalEvent>,
            Arc<Image<ImageContent>>,
            merkur_graphics::budget::Lease,
        ) {
            let (mut terminal, rx) = terminal();
            let upload = transmit(71, 16);
            let accepted = terminal.apply_bytes(&upload);
            resume(&mut terminal, &upload, accepted).await;
            assert_eq!(replies(&rx), [b"\x1b_Gi=71;OK\x1b\\".to_vec()]);
            let image = terminal.graphics.scene.resolve_id(71).unwrap();
            let held = Arc::clone(terminal.graphics.scene.image(image).unwrap());
            merkur_image_worker::retirement::drain();
            let pressure = terminal.graphics.leave_storage(Usage {
                bytes: 0,
                objects: 0,
            });
            (terminal, rx, held, pressure)
        }

        /// A delete and an upload that fits only in the storage the delete frees
        /// answer alike whether they arrive in one read or two. In one read the
        /// upload waits, neither started nor answered, while its storage is still
        /// held, and starts over once the release lands.
        #[tokio::test]
        #[ignore = "real helper: bun run build:image-worker"]
        async fn an_upload_after_a_delete_answers_alike_in_one_read_or_two() {
            let mut outcomes = Vec::new();
            for split in [false, true] {
                let (mut terminal, rx, held, pressure) = full_but_for_71().await;
                let released = held.content.released();
                let upload = transmit(72, 16);
                if split {
                    assert_eq!(terminal.apply_bytes(DELETE_71), DELETE_71.len());
                    drop(held);
                    released.wait().await;
                    let accepted = terminal.apply_bytes(&upload);
                    resume(&mut terminal, &upload, accepted).await;
                } else {
                    let bytes = [DELETE_71, &upload].concat();
                    let accepted = terminal.apply_bytes(&bytes);
                    // The read is consumed; the upload's step waits at the boundary.
                    assert_eq!(accepted, bytes.len());
                    assert!(terminal.graphics_pending());
                    assert!(terminal.graphics.admission_waiting);
                    assert!(terminal.graphics.job.is_none());
                    assert!(replies(&rx).is_empty());
                    drop(held);
                    resume(&mut terminal, &bytes, accepted).await;
                }
                outcomes.push(replies(&rx));
                drop(pressure);
                terminal.shutdown_graphics().await;
            }
            assert_eq!(outcomes[0], [b"\x1b_Gi=72;OK\x1b\\".to_vec()]);
            assert_eq!(outcomes[1], outcomes[0]);
        }

        /// A shortfall the landed releases leave is answered, and only once they
        /// have landed.
        #[tokio::test]
        #[ignore = "real helper: bun run build:image-worker"]
        async fn a_shortfall_every_release_leaves_is_answered_once_they_land() {
            let (mut terminal, rx, held, pressure) = full_but_for_71().await;
            let bytes = [DELETE_71, &transmit(72, 24)].concat();
            let accepted = terminal.apply_bytes(&bytes);
            assert!(terminal.graphics.admission_waiting);
            assert!(replies(&rx).is_empty());
            drop(held);
            resume(&mut terminal, &bytes, accepted).await;
            assert_eq!(
                replies(&rx),
                [b"\x1b_Gi=72;ENOSPC:graphics resource limit\x1b\\".to_vec()]
            );
            assert!(terminal.graphics.scene.is_empty());
            drop(pressure);
            terminal.shutdown_graphics().await;
        }

        /// Every holder of a removed source outside the scene lets go without the
        /// parser's help: a transfer ends when the content retires, as `assets`
        /// does. A delete and an upload that waits on its storage always finish.
        #[tokio::test]
        #[ignore = "real helper: bun run build:image-worker"]
        async fn a_transfer_in_flight_releases_the_source_a_waiting_upload_needs() {
            let (mut terminal, rx, held, pressure) = full_but_for_71().await;
            let transfer = tokio::spawn(async move {
                held.content.retired().await;
                drop(held);
            });
            let bytes = [DELETE_71, &transmit(72, 16)].concat();
            let accepted = terminal.apply_bytes(&bytes);
            assert!(terminal.graphics.admission_waiting);
            resume(&mut terminal, &bytes, accepted).await;
            transfer.await.unwrap();
            assert_eq!(replies(&rx), [b"\x1b_Gi=72;OK\x1b\\".to_vec()]);
            drop(pressure);
            terminal.shutdown_graphics().await;
        }

        /// A quiet transmission of a `side` x `side` RGB image, in as many
        /// chunks as its payload needs.
        fn transmit_chunked(id: u32, side: u32) -> Vec<u8> {
            let payload = vec![b'A'; (side * side * 4) as usize];
            let chunks: Vec<_> = payload.chunks(4096).collect();
            let mut bytes = Vec::new();
            for (index, chunk) in chunks.iter().enumerate() {
                let more = u8::from(index + 1 < chunks.len());
                let control = if index == 0 {
                    format!("a=t,f=24,s={side},v={side},i={id},q=1,m={more}")
                } else {
                    format!("m={more}")
                };
                bytes.extend_from_slice(format!("\x1b_G{control};").as_bytes());
                bytes.extend_from_slice(chunk);
                bytes.extend_from_slice(b"\x1b\\");
            }
            bytes
        }

        const DELETE_42: &[u8] = b"\x1b_Ga=d,d=I,i=42\x1b\\";

        /// An edit's storage is admitted on the owner, exactly, so an edit that
        /// fits starts at once: an uploaded frame and a command after a delete
        /// are answered while the delete's release is still in flight.
        #[tokio::test]
        #[ignore = "real helper: bun run build:image-worker"]
        async fn an_edit_that_fits_never_waits_for_a_release_in_flight() {
            let (mut terminal, rx) = terminal();
            let setup =
                b"\x1b_Ga=t,i=41,f=24,s=1,v=1,q=1;/wAA\x1b\\\x1b_Ga=t,i=42,f=24,s=1,v=1,q=1;AP8A\x1b\\";
            let accepted = terminal.apply_bytes(setup);
            resume(&mut terminal, setup, accepted).await;
            let image = terminal.graphics.scene.resolve_id(42).unwrap();
            let held = Arc::clone(terminal.graphics.scene.image(image).unwrap());
            let released = held.content.released();
            let bytes = [
                DELETE_42,
                b"\x1b_Ga=f,i=41,f=24,s=1,v=1;AAD/\x1b\\\x1b_Ga=a,i=41,s=3\x1b\\",
            ]
            .concat();
            let accepted = terminal.apply_bytes(&bytes);
            assert!(!terminal.graphics.admission_waiting);
            resume(&mut terminal, &bytes, accepted).await;
            assert!(!released.is_done());
            assert_eq!(replies(&rx), [b"\x1b_Gi=41,r=2;OK\x1b\\".to_vec()]);
            let image = terminal.graphics.scene.resolve_id(41).unwrap();
            let animation = terminal.graphics.scene.image(image).unwrap();
            let playback = animation.content.animation().unwrap().manifest().playback();
            assert_eq!(playback.mode, merkur_graphics::animation::Mode::Loop);
            drop(held);
            terminal.shutdown_graphics().await;
        }

        /// An edit short of storage while a delete's release is in flight waits
        /// for it, holding its decoded patch, and answers as it would with the
        /// release landed: alike in one read or two, and a shortfall the release
        /// leaves is answered once it lands.
        #[tokio::test]
        #[ignore = "real helper: bun run build:image-worker"]
        async fn an_edit_short_of_storage_waits_for_the_releases_in_flight() {
            const FRAME: &[u8] = b"\x1b_Ga=f,i=41,f=24,s=1,v=1;AAD/\x1b\\";
            let mut outcomes = Vec::new();
            for (side, split) in [(512, false), (512, true), (16, false)] {
                let (mut terminal, rx) = terminal();
                // Appending a frame to a 256x256 image composes its whole canvas.
                for upload in [transmit_chunked(41, 256), transmit_chunked(42, side)] {
                    let accepted = terminal.apply_bytes(&upload);
                    resume(&mut terminal, &upload, accepted).await;
                }
                let image = terminal.graphics.scene.resolve_id(42).unwrap();
                let held = Arc::clone(terminal.graphics.scene.image(image).unwrap());
                let released = held.content.released();
                merkur_image_worker::retirement::drain();
                // Room for the frame's decoded patch, not for the composed canvas.
                let pressure = terminal.graphics.leave_storage(Usage {
                    bytes: 32 * 1024,
                    objects: 64,
                });
                if split {
                    assert_eq!(terminal.apply_bytes(DELETE_42), DELETE_42.len());
                    drop(held);
                    released.wait().await;
                    let accepted = terminal.apply_bytes(FRAME);
                    resume(&mut terminal, FRAME, accepted).await;
                } else {
                    let bytes = [DELETE_42, FRAME].concat();
                    let wake = terminal.graphics_wake();
                    let mut accepted = terminal.apply_bytes(&bytes);
                    // The upload fits; once its patch is decoded, the edit waits.
                    tokio::time::timeout(Duration::from_secs(15), async {
                        while !terminal.graphics.admission_waiting {
                            wake.notified().await;
                            accepted += terminal.apply_bytes(&bytes[accepted..]);
                        }
                    })
                    .await
                    .expect("the decoded frame waits for the release");
                    assert!(
                        terminal
                            .graphics
                            .job
                            .as_ref()
                            .is_some_and(|job| job.patch.is_some())
                    );
                    assert!(replies(&rx).is_empty());
                    drop(held);
                    resume(&mut terminal, &bytes, accepted).await;
                }
                outcomes.push(replies(&rx));
                drop(pressure);
                terminal.shutdown_graphics().await;
            }
            assert_eq!(outcomes[0], [b"\x1b_Gi=41,r=2;OK\x1b\\".to_vec()]);
            assert_eq!(outcomes[1], outcomes[0]);
            assert_eq!(
                outcomes[2],
                [b"\x1b_Gi=41,r=2;ENOSPC:graphics resource limit\x1b\\".to_vec()]
            );
        }

        /// A transmit-and-place that replaces a placed image admits no second
        /// placement: its own takes over the metadata of the first of the
        /// replaced image's placements to go, whether publication removes it or
        /// the grid retires it while the upload is in flight. Only the new
        /// image's output and scene metadata must fit.
        #[tokio::test]
        #[ignore = "real helper: bun run build:image-worker"]
        async fn a_retransmit_over_a_placed_image_admits_no_second_placement() {
            for retired_in_flight in [false, true] {
                let (mut terminal, rx) = terminal();
                terminal.resize_viewport(crate::pty::Viewport {
                    geometry_generation: 1,
                    cols: 80,
                    rows: 3,
                    seq: 1,
                    cell: CellMetrics::new(8 << 16, 16 << 16),
                    pixel_width: 640,
                    pixel_height: 48,
                });
                let first = b"\x1b_Ga=T,i=1,p=1,f=24,s=2,v=1,q=1;AAAAAAAA\x1b\\";
                let accepted = terminal.apply_bytes(first);
                resume(&mut terminal, first, accepted).await;
                let old = terminal.graphics.scene.resolve_id(1).unwrap();
                assert!(terminal.graphics.placements.resolve(old, 1).is_some());
                merkur_image_worker::retirement::drain();
                let pressure = terminal.graphics.leave_storage(Usage {
                    bytes: 1 << 20,
                    objects: 2,
                });
                let (head, tail): (&[u8], &[u8]) = if retired_in_flight {
                    (
                        b"\x1b_Ga=T,i=1,p=1,f=24,s=2,v=1,q=1,m=1;AAAA\x1b\\\x1b[2J",
                        b"\x1b_Gm=0;AAAA\x1b\\",
                    )
                } else {
                    (b"\x1b_Ga=T,i=1,p=1,f=24,s=2,v=1,q=1;AAAAAAAA\x1b\\", b"")
                };
                let accepted = terminal.apply_bytes(head);
                assert!(terminal.graphics.job.is_some());
                if retired_in_flight {
                    // The erased grid retired the placement; its metadata went
                    // to the upload, not back to the partition.
                    assert!(terminal.graphics.placements.is_empty());
                    assert!(matches!(
                        terminal.graphics.job.as_ref().unwrap().placement,
                        Some(PlacementMetadata::Admitted(_))
                    ));
                }
                drop(pressure);
                let bytes = [head, tail].concat();
                let accepted = accepted + terminal.apply_bytes(tail);
                resume(&mut terminal, &bytes, accepted).await;
                assert!(replies(&rx).is_empty());
                let new = terminal.graphics.scene.resolve_id(1).unwrap();
                assert_ne!(new, old);
                assert!(terminal.graphics.placements.resolve(new, 1).is_some());
                terminal.shutdown_graphics().await;
            }
        }

        /// A projection shortfall right after a delete evicts nothing while that
        /// delete's release is in flight: it may be what the release covers. Once
        /// it lands the projection fits, and the other original stays.
        #[tokio::test]
        #[ignore = "real helper: bun run build:image-worker"]
        async fn a_projection_right_after_a_delete_evicts_nothing_while_its_release_is_in_flight()
        {
            let (mut terminal, rx) = terminal();
            terminal.resize_viewport(crate::pty::Viewport {
                geometry_generation: 1,
                cols: 80,
                rows: 64,
                seq: 1,
                cell: CellMetrics::new(8 << 16, 16 << 16),
                pixel_width: 640,
                pixel_height: 1024,
            });
            for upload in [
                b"\x1b_Ga=t,f=24,s=1,v=1,i=81;AAAA\x1b\\".as_slice(),
                b"\x1b_Ga=T,f=24,s=1,v=1,i=82,c=2,r=64,C=1;AQEB\x1b\\",
            ] {
                let accepted = terminal.apply_bytes(upload);
                resume(&mut terminal, upload, accepted).await;
            }
            assert_eq!(replies(&rx).len(), 2);
            let first = terminal.graphics.scene.resolve_id(81).unwrap();
            let held = Arc::clone(terminal.graphics.scene.image(first).unwrap());
            merkur_image_worker::retirement::drain();
            // The alternate screen releases the projected rows; all but one byte
            // less than 64 rows of one fragment is then taken.
            terminal.apply_bytes(b"\x1b[?1049h");
            assert!(terminal.graphics.projected.iter().all(|row| row.is_empty()));
            let used = terminal.graphics.storage.used().unwrap();
            let row = merkur_codec::PreparedGraphics::reservation_bound(1).unwrap();
            let pressure = terminal
                .graphics
                .storage
                .reserve(Usage {
                    bytes: STORAGE_BYTES - used.bytes - (64 * row.bytes - 1),
                    objects: 0,
                })
                .unwrap();
            // One read: delete 81, then bring 82's rows back one byte short.
            let bytes = b"\x1b_Ga=d,d=I,i=81\x1b\\\x1b[?1049l";
            assert_eq!(terminal.apply_bytes(bytes), bytes.len());
            assert!(terminal.graphics.projection_deferred);
            assert_eq!(terminal.graphics.scene.len(), 1);
            assert!(terminal.graphics.scene.resolve_id(82).is_some());
            drop(held);
            terminal.graphics_release().unwrap().wait().await;
            terminal.observe_graphics_release();
            assert!(!terminal.graphics.projection_deferred);
            assert!(terminal.graphics_release().is_none());
            assert_eq!(terminal.graphics.scene.len(), 1);
            assert!((0..64).all(|row| !terminal.graphics.row(row).is_empty()));
            assert!(replies(&rx).is_empty());
            drop(pressure);
            terminal.shutdown_graphics().await;
        }
    }
}
