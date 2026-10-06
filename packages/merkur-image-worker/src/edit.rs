//! Off-owner animation transactions. A completed transaction still needs its
//! terminal's publication fence; none of these objects can publish themselves.
//! The terminal owner validates and sizes each one first (`Plan`) and admits
//! its storage there, so nothing a transaction allocates can be refused.
use std::{
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};

use merkur_graphics::{
    animation::{Entry, MAX_FRAMES, Manifest, Mode, Playback},
    budget::{Lease, Usage},
    command::{Action, Control, Error, Key},
    reply::ReplyError,
    scene::Image,
};
use tokio::sync::Notify;

use crate::{
    DecodedImage, OUTPUT_METADATA_BYTES, Reservations, WORKSPACE_BYTES, Worker,
    composition::Request,
    content::{AnimatedImage, ImageContent},
    frame::{Frame, Raster},
};

const INVALID: ReplyError = ReplyError::Protocol(Error::InvalidControl);
const NOTHING: Usage = Usage {
    bytes: 0,
    objects: 0,
};

#[derive(Default)]
pub struct Cancellation {
    cancelled: AtomicBool,
    wake: Notify,
}

impl Cancellation {
    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::Release);
        self.wake.notify_waiters();
    }
    fn check(&self) -> Result<(), ReplyError> {
        if self.cancelled.load(Ordering::Acquire) {
            Err(ReplyError::Protocol(Error::Cancelled))
        } else {
            Ok(())
        }
    }
    async fn cancelled(&self) {
        let wake = self.wake.notified();
        tokio::pin!(wake);
        wake.as_mut().enable();
        if self.check().is_ok() {
            wake.await;
        }
    }
}

/// A validated animation command and exactly the storage its transaction
/// allocates: the frame catalogue, a static source's first frame, a composed
/// region and the tree nodes that hold it, the manifest and the frame
/// references. The terminal owner builds it and admits `charge` before the
/// transaction starts, where a shortfall can still wait for releases in flight.
pub struct Plan {
    operation: Operation,
    charge: Usage,
}

#[derive(Clone, Copy)]
enum Operation {
    Control,
    Frame {
        /// An existing frame edited onto itself; otherwise the frame appends.
        edit: Option<usize>,
        /// The frame composed onto; without one, a solid background.
        base: Option<usize>,
        at: [u32; 2],
        overwrite: bool,
    },
    Compose {
        source: usize,
        destination: usize,
        to: [u32; 2],
        from: [u32; 2],
        extent: [u32; 2],
        overwrite: bool,
    },
    Delete,
}

impl Plan {
    /// `patch` is the size of a frame command's decoded patch.
    pub fn new(
        source: &Image<ImageContent>,
        control: &Control,
        patch: Option<[u32; 2]>,
    ) -> Result<Self, ReplyError> {
        let size = [source.width, source.height];
        let count = source
            .content
            .animation()
            .map_or(1, |image| image.frames().len());
        let (operation, frames, composed) = match control.action().map_err(ReplyError::Protocol)? {
            Action::Animate => (Operation::Control, count, NOTHING),
            Action::Frame => {
                let [width, height] = patch.ok_or(INVALID)?;
                // The terminal owner names the target frame: an existing frame
                // is edited onto itself; any later number appends a new frame.
                let edit = control
                    .get(Key::Rows)
                    .filter(|frame| *frame != 0)
                    .map(|frame| frame as usize - 1)
                    .filter(|index| *index < count);
                let base = match edit {
                    Some(index) => Some(index),
                    // An absent base frame is an invalid frame description.
                    None => control
                        .get(Key::Columns)
                        .filter(|index| *index != 0)
                        .map(|index| frame_index(count, index).map_err(|_| INVALID))
                        .transpose()?,
                };
                if edit.is_none() && count == MAX_FRAMES {
                    return Err(ReplyError::Quota);
                }
                let at = [
                    control.get(Key::SourceX).unwrap_or(0),
                    control.get(Key::SourceY).unwrap_or(0),
                ];
                let overwrite = boolean(control, Key::CellX)?;
                fits(size, at, [width, height])?;
                let composed = match base {
                    Some(_) => composition(size, at, [width, height]),
                    None => sum(output(size), Frame::tree_charge(size[0], size[1])),
                };
                let operation = Operation::Frame {
                    edit,
                    base,
                    at,
                    overwrite,
                };
                (operation, count + usize::from(edit.is_none()), composed)
            }
            Action::Compose => {
                // Kitty's executable behavior: r is source, c is destination;
                // X/Y name the source crop and x/y the destination rectangle.
                let source = frame_index(count, control.get(Key::Rows).unwrap_or(0))?;
                let destination = frame_index(count, control.get(Key::Columns).unwrap_or(0))?;
                let extent = [
                    control
                        .get(Key::SourceWidth)
                        .filter(|v| *v != 0)
                        .unwrap_or(size[0]),
                    control
                        .get(Key::SourceHeight)
                        .filter(|v| *v != 0)
                        .unwrap_or(size[1]),
                ];
                let from = [
                    control.get(Key::CellX).unwrap_or(0),
                    control.get(Key::CellY).unwrap_or(0),
                ];
                let to = [
                    control.get(Key::SourceX).unwrap_or(0),
                    control.get(Key::SourceY).unwrap_or(0),
                ];
                fits(size, from, extent)?;
                fits(size, to, extent)?;
                if source == destination && overlaps(from, to, extent) {
                    return Err(INVALID);
                }
                let operation = Operation::Compose {
                    source,
                    destination,
                    to,
                    from,
                    extent,
                    overwrite: boolean(control, Key::Cursor)?,
                };
                (operation, count, composition(size, to, extent))
            }
            // The last frame is never deleted.
            Action::Delete => (Operation::Delete, count - usize::from(count > 1), NOTHING),
            _ => return Err(INVALID),
        };
        // A static source becomes the first frame.
        let first = match &source.content {
            ImageContent::Static(_) => Frame::tree_charge(size[0], size[1]),
            ImageContent::Animation(_) => NOTHING,
        };
        let manifest = Manifest::charge(frames).expect("an animation keeps 1..=MAX_FRAMES frames");
        let charge = [
            Catalogue::charge(count),
            first,
            composed,
            manifest,
            AnimatedImage::charge(frames),
        ]
        .into_iter()
        .fold(NOTHING, sum);
        Ok(Self { operation, charge })
    }

    pub fn charge(&self) -> Usage {
        self.charge
    }
}

pub struct Transaction {
    pub source: Arc<Image<ImageContent>>,
    pub control: Control,
    pub patch: Option<DecodedImage>,
    pub plan: Plan,
    pub revision: u64,
    pub now_us: u64,
    pub executable: PathBuf,
    /// Exactly the plan's charge, admitted by the terminal owner. Every
    /// allocation below splits from it: none can be refused off the owner.
    pub storage: Lease,
    /// One admitted processing slot spans conversion, composition and hashing.
    pub workspace: Lease,
    pub cancelled: Arc<Cancellation>,
}

struct Catalogue {
    frames: Vec<Frame>,
    entries: Vec<Entry>,
    playback: Playback,
    _lease: Lease,
}

impl Catalogue {
    /// The catalogue of a `count`-frame source, with room to append a frame.
    fn charge(count: usize) -> Usage {
        Usage {
            bytes: (count + 1).min(MAX_FRAMES) * (size_of::<Frame>() + size_of::<Entry>())
                + size_of::<Self>(),
            objects: 2,
        }
    }

    fn capture(source: &ImageContent, now_us: u64, batch: &mut Lease) -> Result<Self, ReplyError> {
        let count = source.animation().map_or(1, |image| image.frames().len());
        let capacity = (count + 1).min(MAX_FRAMES);
        let lease = batch.split(Self::charge(count)).ok_or(ReplyError::Quota)?;
        let mut frames = Vec::with_capacity(capacity);
        let mut entries = Vec::with_capacity(capacity);
        let playback = match source {
            ImageContent::Static(image) => {
                let frame = Frame::from_image(image, batch).ok_or(ReplyError::Quota)?;
                entries.push(Entry {
                    root: frame.content().root,
                    gap_ms: 0,
                });
                frames.push(frame);
                Playback {
                    mode: Mode::Stopped,
                    anchor_us: now_us,
                    frame: 0,
                    loops: 0,
                    completed: 0,
                    elapsed_us: 0,
                }
            }
            ImageContent::Animation(image) => {
                frames.extend_from_slice(image.frames());
                entries.extend(image.manifest().entries());
                let sample = image.manifest().sample(now_us);
                Playback {
                    anchor_us: now_us,
                    frame: sample.frame,
                    completed: sample.completed,
                    elapsed_us: sample.elapsed_us,
                    ..image.manifest().playback()
                }
            }
        };
        Ok(Self {
            frames,
            entries,
            playback,
            _lease: lease,
        })
    }

    fn index(&self, value: u32) -> Result<usize, ReplyError> {
        frame_index(self.frames.len(), value)
    }

    /// Each field applies independently, as in Kitty: an unknown state or an
    /// absent frame leaves that field without effect and draws no reply.
    fn control(&mut self, control: &Control) {
        let was_stopped = self.playback.mode == Mode::Stopped;
        match control.get(Key::Width).unwrap_or(0) {
            1 => {
                self.playback.mode = Mode::Stopped;
                self.playback.completed = 0;
            }
            2 => self.playback.mode = Mode::Loading,
            3 => self.playback.mode = Mode::Loop,
            _ => {}
        }
        if was_stopped && self.playback.mode != Mode::Stopped {
            self.playback.elapsed_us = 0;
        }
        if let Some(loops) = control.get(Key::Height).filter(|v| *v != 0) {
            self.playback.loops = loops - 1;
            self.playback.completed = 0;
        }
        if let Some(index) = control
            .get(Key::Columns)
            .and_then(|frame| self.index(frame).ok())
        {
            self.playback.frame = index as u32;
            self.playback.elapsed_us = 0;
        }
        if let Some(gap) = control.signed(Key::Z).filter(|v| *v != 0)
            && let Some(index) = control
                .get(Key::Rows)
                .and_then(|frame| self.index(frame).ok())
        {
            self.entries[index].gap_ms = gap.max(0) as u32;
        }
        self.clamp_elapsed();
    }

    fn clamp_elapsed(&mut self) {
        self.playback.elapsed_us = self
            .playback
            .elapsed_us
            .min(u64::from(self.entries[self.playback.frame as usize].gap_ms) * 1000);
    }

    fn finish(
        self,
        width: u32,
        height: u32,
        revision: u64,
        batch: &mut Lease,
    ) -> Result<ImageContent, ReplyError> {
        let manifest = Manifest::new(width, height, revision, self.playback, &self.entries, batch)
            .ok_or(ReplyError::Quota)?;
        AnimatedImage::new(manifest, &self.frames, batch)
            .map(ImageContent::Animation)
            .ok_or(ReplyError::Quota)
    }
}

impl Transaction {
    pub async fn run(self) -> Result<ImageContent, ReplyError> {
        // Always join blocking work. Cancellation cannot refund a slot while its
        // hashing or tree construction still holds the pixels and reservation.
        let (mut transaction, mut catalogue) = tokio::task::spawn_blocking(move || {
            let mut transaction = self;
            transaction.cancelled.check()?;
            let catalogue = Catalogue::capture(
                &transaction.source.content,
                transaction.now_us,
                &mut transaction.storage,
            )?;
            Ok::<_, ReplyError>((transaction, catalogue))
        })
        .await
        .map_err(|_| ReplyError::Worker)??;
        transaction.cancelled.check()?;
        let control = transaction.control;
        let size = [transaction.source.width, transaction.source.height];
        match transaction.plan.operation {
            Operation::Control => catalogue.control(&control),
            Operation::Frame {
                edit,
                base,
                at,
                overwrite,
            } => {
                let patch = transaction.patch.take().ok_or(INVALID)?;
                let extent = [patch.pixels().width(), patch.pixels().height()];
                let frame = if let Some(index) = base {
                    transaction
                        .compose(
                            &catalogue.frames[index],
                            patch.pixels(),
                            at,
                            [0, 0],
                            extent,
                            overwrite,
                        )
                        .await?
                } else {
                    let background = Solid::new(size, control.get(Key::CellY).unwrap_or(0));
                    let request = Request {
                        width: size[0],
                        height: size[1],
                        x: at[0],
                        y: at[1],
                        patch_width: extent[0],
                        patch_height: extent[1],
                        overwrite,
                    };
                    let image = transaction
                        .compose_image(request, &background, [0, 0], patch.pixels(), [0, 0])
                        .await?;
                    let mut tree = transaction
                        .storage
                        .split(Frame::tree_charge(size[0], size[1]))
                        .ok_or(ReplyError::Quota)?;
                    tokio::task::spawn_blocking(move || Frame::from_image(&image, &mut tree))
                        .await
                        .map_err(|_| ReplyError::Worker)?
                        .ok_or(ReplyError::Quota)?
                };
                let gap = control
                    .signed(Key::Z)
                    .filter(|gap| *gap != 0)
                    .map(|gap| gap.max(0) as u32);
                let entry = Entry {
                    root: frame.content().root,
                    gap_ms: gap.unwrap_or_else(|| {
                        edit.map_or(40, |index| catalogue.entries[index].gap_ms)
                    }),
                };
                if let Some(index) = edit {
                    catalogue.frames[index] = frame;
                    catalogue.entries[index] = entry;
                } else {
                    catalogue.frames.push(frame);
                    catalogue.entries.push(entry);
                }
                catalogue.clamp_elapsed();
            }
            Operation::Compose {
                source,
                destination,
                to,
                from,
                extent,
                overwrite,
            } => {
                let frame = transaction
                    .compose(
                        &catalogue.frames[destination],
                        &catalogue.frames[source],
                        to,
                        from,
                        extent,
                        overwrite,
                    )
                    .await?;
                catalogue.entries[destination].root = frame.content().root;
                catalogue.frames[destination] = frame;
            }
            Operation::Delete => {
                let index = control
                    .get(Key::Rows)
                    .unwrap_or(1)
                    .max(1)
                    .min(catalogue.frames.len() as u32) as usize
                    - 1;
                if catalogue.frames.len() > 1 {
                    catalogue.frames.remove(index);
                    catalogue.entries.remove(index);
                    if index < catalogue.playback.frame as usize {
                        catalogue.playback.frame -= 1;
                    } else if index == catalogue.playback.frame as usize {
                        catalogue.playback.frame = catalogue
                            .playback
                            .frame
                            .min(catalogue.frames.len() as u32 - 1);
                        catalogue.playback.elapsed_us = 0;
                    }
                    catalogue.clamp_elapsed();
                }
            }
        }
        tokio::task::spawn_blocking(move || {
            transaction.cancelled.check()?;
            if transaction.source.content.is_retired() {
                return Err(ReplyError::Protocol(Error::Cancelled));
            }
            let result = catalogue.finish(
                size[0],
                size[1],
                transaction.revision,
                &mut transaction.storage,
            );
            // The plan's charge is exact: a complete transaction built all of it.
            debug_assert!(result.is_err() || transaction.storage.charge() == NOTHING);
            drop(transaction);
            result
        })
        .await
        .map_err(|_| ReplyError::Worker)?
    }

    async fn compose(
        &mut self,
        base: &Frame,
        patch: &impl Raster,
        to: [u32; 2],
        from: [u32; 2],
        extent: [u32; 2],
        overwrite: bool,
    ) -> Result<Frame, ReplyError> {
        let size = [base.width(), base.height()];
        let (origin, region) = region(size, to, extent);
        let request = Request {
            width: region[0],
            height: region[1],
            x: to[0] - origin[0],
            y: to[1] - origin[1],
            patch_width: extent[0],
            patch_height: extent[1],
            overwrite,
        };
        let image = self
            .compose_image(request, base, origin, patch, from)
            .await?;
        let mut tree = Frame::replacement_charge(size, origin[0], origin[1], region[0], region[1])
            .and_then(|charge| self.storage.split(charge))
            .ok_or(ReplyError::Quota)?;
        let base = base.clone();
        tokio::task::spawn_blocking(move || {
            base.replace_tiles(origin[0], origin[1], &image, &mut tree)
        })
        .await
        .map_err(|_| ReplyError::Worker)?
        .ok_or(ReplyError::Quota)
    }

    async fn compose_image(
        &mut self,
        request: Request,
        base: &impl Raster,
        base_origin: [u32; 2],
        patch: &impl Raster,
        patch_origin: [u32; 2],
    ) -> Result<DecodedImage, ReplyError> {
        self.cancelled.check()?;
        let output = self
            .storage
            .split(output([request.width, request.height]))
            .ok_or(ReplyError::Quota)?;
        // Keep the original admission throughout the transaction. The helper
        // borrows a split slot; no concurrent job can spend its workspace.
        let workspace = self
            .workspace
            .split(Usage {
                bytes: WORKSPACE_BYTES,
                objects: 1,
            })
            .ok_or(ReplyError::Quota)?;
        let mut worker = Worker::launch_composition(
            &self.executable,
            request,
            Reservations { workspace, output },
        )
        .await
        .map_err(|_| ReplyError::Worker)?;
        let result = tokio::select! {
            biased;
            _ = self.cancelled.cancelled() => Err(ReplyError::Protocol(Error::Cancelled)),
            result = async {
                worker.compose_input(request, base, base_origin, patch, patch_origin).await?;
                worker.finish_retaining_workspace().await
            } => result.map_err(|_| ReplyError::Worker),
        };
        worker.cancel().await;
        result.map(|(image, workspace)| {
            // The helper has exited and hashing has joined. Keep its slot until
            // the remaining immutable tree and manifest are committed.
            self.workspace = workspace;
            image
        })
    }
}

/// A one-based frame number in a catalogue of `count` frames.
fn frame_index(count: usize, value: u32) -> Result<usize, ReplyError> {
    let index = value.checked_sub(1).ok_or(ReplyError::MissingImage)? as usize;
    if index < count {
        Ok(index)
    } else {
        Err(ReplyError::MissingImage)
    }
}

/// The tile-aligned region of a `size` canvas that an edit of `extent` at `to`
/// recomposes: its origin and its size.
fn region(size: [u32; 2], to: [u32; 2], extent: [u32; 2]) -> ([u32; 2], [u32; 2]) {
    let origin = [to[0] / 256 * 256, to[1] / 256 * 256];
    let end = [
        (to[0] + extent[0]).div_ceil(256) * 256,
        (to[1] + extent[1]).div_ceil(256) * 256,
    ];
    (
        origin,
        [
            end[0].min(size[0]) - origin[0],
            end[1].min(size[1]) - origin[1],
        ],
    )
}

/// A recomposed region and the tree nodes that replace it.
fn composition(size: [u32; 2], to: [u32; 2], extent: [u32; 2]) -> Usage {
    let (origin, region) = region(size, to, extent);
    sum(
        output(region),
        Frame::replacement_charge(size, origin[0], origin[1], region[0], region[1])
            .expect("a region is tile-aligned and inside its canvas"),
    )
}

/// The helper's output for a composed image of `size`.
fn output(size: [u32; 2]) -> Usage {
    Usage {
        bytes: size[0] as usize * size[1] as usize * 4 + OUTPUT_METADATA_BYTES,
        objects: 1,
    }
}

fn sum(a: Usage, b: Usage) -> Usage {
    Usage {
        bytes: a.bytes + b.bytes,
        objects: a.objects + b.objects,
    }
}

fn boolean(control: &Control, key: Key) -> Result<bool, ReplyError> {
    match control.get(key).unwrap_or(0) {
        0 => Ok(false),
        1 => Ok(true),
        _ => Err(INVALID),
    }
}
fn fits(canvas: [u32; 2], origin: [u32; 2], extent: [u32; 2]) -> Result<(), ReplyError> {
    if extent.contains(&0)
        || (0..2).any(|i| {
            origin[i]
                .checked_add(extent[i])
                .is_none_or(|end| end > canvas[i])
        })
    {
        Err(INVALID)
    } else {
        Ok(())
    }
}
fn overlaps(a: [u32; 2], b: [u32; 2], size: [u32; 2]) -> bool {
    (0..2).all(|i| a[i] < b[i] + size[i] && b[i] < a[i] + size[i])
}

struct Solid {
    size: [u32; 2],
    run: [u8; 1024],
}
impl Solid {
    fn new(size: [u32; 2], color: u32) -> Self {
        let mut run = [0; 1024];
        for pixel in run.chunks_exact_mut(4) {
            pixel.copy_from_slice(&color.to_be_bytes());
        }
        Self { size, run }
    }
}
impl Raster for Solid {
    fn width(&self) -> u32 {
        self.size[0]
    }
    fn height(&self) -> u32 {
        self.size[1]
    }
    fn run(&self, x: u32, y: u32) -> &[u8] {
        assert!(x < self.size[0] && y < self.size[1]);
        &self.run[..(self.size[0] - x).min(256) as usize * 4]
    }
}
