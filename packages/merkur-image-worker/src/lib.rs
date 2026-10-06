//! Trusted, asynchronous process supervision. Decoder code is private to the
//! separate executable and cannot be called or linked through this library.
#![deny(unsafe_code)]

#[expect(
    unsafe_code,
    reason = "the single FFI boundary supplies libdeflate's allocation from a pre-admitted \
              arena; the safe upstream wrapper hides an unaccounted C allocation"
)]
mod compressor;

pub mod composition;
pub mod content;
pub mod descriptor;
pub mod edit;
pub mod encoding;
pub mod frame;
mod pyramid;
pub mod retirement;
pub mod tile;
pub mod upload;

use merkur_graphics::budget::{Lease, Usage};
use merkur_graphics::command::MAX_CHUNK_BYTES;
use merkur_graphics::processing::{
    DecodeRequest, FINAL_CHUNK, Pixels, RESULT_BYTES, Rejection, WORKER_READY, pixel_bytes,
};
use merkur_graphics::source::SourceManifest;
use std::path::Path;
use std::process::Stdio;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Failure {
    Launch,
    Sandbox,
    Input,
    Decode,
    /// Uncompressed raw pixels ended before their declared extent.
    Truncated,
    /// The PNG stream failed to decode.
    Png,
    /// More input than the upload may hold; see `Rejection::Excess`.
    Excess,
    Output,
    Exit,
    WorkBudget,
}

/// Resource bound for the frozen writable address space, including the 384 MiB
/// decode arena, runtime mappings and stack. Read-only OS shared-cache mappings
/// are not private image storage. The helper audits its mappings before READY.
pub const WORKSPACE_BYTES: usize = 768 * 1024 * 1024;
/// Resource budget after the final input chunk, including result delivery.
/// This bounds a compromised worker blocked in a syscall without spending CPU.
pub const VALIDATION_WALL_BUDGET: std::time::Duration = std::time::Duration::from_secs(8);

pub struct Reservations {
    pub workspace: Lease,
    pub output: Lease,
}

/// An aborted cleanup task must not make a still-running process's allocation
/// budget available again. Normal shutdown joins cleanup; failed cleanup keeps
/// the finite reservation charged for the remaining lifetime of its budget:
/// only [`Self::reaped`] ever drops the leases.
struct ReapingReservation(std::mem::ManuallyDrop<Option<Reservations>>);

impl ReapingReservation {
    fn new(reservations: Option<Reservations>) -> Self {
        Self(std::mem::ManuallyDrop::new(reservations))
    }

    /// The process exited: its reservations return to their budgets.
    fn reaped(mut self) {
        self.0.take();
    }
}

struct ImageStorage {
    pixels: Pixels,
}

impl Drop for ImageStorage {
    fn drop(&mut self) {
        // Credit is returned only after this wipe. Use the same non-elidable,
        // vectorized fill as tile retirement so a large delete does not leave
        // admission waiting on a volatile store for every individual byte.
        encoding::wipe(self.pixels.rgba_mut());
    }
}

/// Resource charge for the source descriptor and preallocated retirement owner.
pub const OUTPUT_METADATA_BYTES: usize = retirement::Retained::<ImageStorage>::METADATA_BYTES
    + size_of::<retirement::Retained<ImageStorage>>()
    + size_of::<DecodedImage>()
    + 2 * size_of::<usize>();

pub struct DecodedImage {
    // Keep the immutable descriptor beside the publication/retirement state:
    // canonical row projection never follows the pixel-storage indirection.
    source: SourceManifest,
    data: Arc<retirement::Retained<ImageStorage>>,
    retired: AtomicBool,
    retirement: tokio::sync::Notify,
}

impl DecodedImage {
    fn new(pixels: Pixels, storage: Lease) -> Option<Self> {
        let admitted = (pixels, storage);
        if admitted.1.charge().bytes < admitted.0.rgba().len() + OUTPUT_METADATA_BYTES
            || admitted.1.charge().objects < 1
        {
            return None;
        }
        let (pixels, storage) = admitted;
        Some(Self {
            source: SourceManifest::from_pixels(&pixels),
            data: Arc::new(retirement::Retained::new(ImageStorage { pixels }, storage)?),
            retired: AtomicBool::new(false),
            retirement: tokio::sync::Notify::new(),
        })
    }

    pub fn pixels(&self) -> &Pixels {
        &self.data.pixels
    }

    pub fn source(&self) -> &SourceManifest {
        &self.source
    }

    pub fn is_retired(&self) -> bool {
        self.retired.load(Ordering::Acquire)
    }

    /// Event-driven cancellation for all transfer/processing owners holding this
    /// immutable image. Registration precedes the state check to prevent lost wakes.
    pub async fn retired(&self) {
        let wake = self.retirement.notified();
        tokio::pin!(wake);
        wake.as_mut().enable();
        if !self.is_retired() {
            wake.await;
        }
    }
}

impl merkur_graphics::scene::SceneContent for DecodedImage {
    fn descriptor(&self) -> merkur_graphics::projection::Content {
        self.source.content()
    }

    fn retire(&self) {
        if !self.retired.swap(true, Ordering::AcqRel) {
            self.retirement.notify_waiters();
        }
    }
}

/// One job's process, pipes, and publication-independent output ownership.
/// Dropping at any await cancels the process. Callers never reuse a failed job.
pub struct Worker {
    child: Option<Child>,
    input: Option<ChildStdin>,
    output: ChildStdout,
    finished_input: bool,
    received_bytes: usize,
    request: DecodeRequest,
    composition: Option<composition::Request>,
    reservations: Option<Reservations>,
    runtime: tokio::runtime::Handle,
}

enum Input {
    Inline,
    Descriptor(descriptor::Request, std::fs::File),
    Composition(composition::Request),
}

impl Worker {
    pub async fn launch(
        executable: &Path,
        request: DecodeRequest,
        reservations: Reservations,
    ) -> Result<Self, Failure> {
        Self::launch_input(executable, request, reservations, Input::Inline).await
    }

    /// The descriptor is inherited only as stdin by a clean confined helper.
    /// The supervisor never maps or reads mutable external storage.
    pub async fn launch_descriptor(
        executable: &Path,
        request: descriptor::Request,
        file: std::fs::File,
        reservations: Reservations,
    ) -> Result<Self, Failure> {
        if !request.valid() {
            return Err(Failure::Input);
        }
        Self::launch_input(
            executable,
            request.decode,
            reservations,
            Input::Descriptor(request, file),
        )
        .await
    }

    /// Composition runs under the same confinement, private output validation
    /// and process reservations as decoding. Only the edited region is sent.
    pub async fn launch_composition(
        executable: &Path,
        request: composition::Request,
        reservations: Reservations,
    ) -> Result<Self, Failure> {
        if !request.valid() {
            return Err(Failure::Input);
        }
        Self::launch_input(
            executable,
            request.output(),
            reservations,
            Input::Composition(request),
        )
        .await
    }

    async fn launch_input(
        executable: &Path,
        request: DecodeRequest,
        reservations: Reservations,
        operation: Input,
    ) -> Result<Self, Failure> {
        request.inflated_limit().ok_or(Failure::Input)?;
        let output = if request.format == merkur_graphics::command::Format::Png {
            merkur_graphics::processing::MAX_RGBA_BYTES
        } else {
            pixel_bytes(request.width, request.height, 4).ok_or(Failure::Input)?
        };
        if reservations.workspace.charge().bytes < WORKSPACE_BYTES
            || reservations.workspace.charge().objects < 1
            || reservations.output.charge().bytes < output + OUTPUT_METADATA_BYTES
            || reservations.output.charge().objects < 1
        {
            return Err(Failure::Input);
        }
        if !executable.is_absolute() {
            return Err(Failure::Launch);
        }
        let direct = matches!(&operation, Input::Descriptor(..));
        let composition = match &operation {
            Input::Composition(request) => Some(*request),
            _ => None,
        };
        let mut header = [0; composition::REQUEST_BYTES];
        let header_len = match &operation {
            Input::Inline => {
                header[..merkur_graphics::processing::REQUEST_BYTES]
                    .copy_from_slice(&request.encode());
                merkur_graphics::processing::REQUEST_BYTES
            }
            Input::Composition(request) => {
                header.copy_from_slice(&request.encode());
                header.len()
            }
            Input::Descriptor(..) => 0,
        };
        let mut command = Command::new(executable);
        let input = match operation {
            Input::Descriptor(request, file) => {
                command.arg("--descriptor").arg(request.argument());
                Stdio::from(file)
            }
            Input::Composition(_) => {
                command.arg("--compose");
                Stdio::piped()
            }
            Input::Inline => Stdio::piped(),
        };
        let mut child = command
            .env_clear()
            // This single-threaded helper needs neither Darwin's 512 MiB nano
            // zone nor per-CPU malloc magazines alongside its fixed Rust arena.
            .env("MallocNanoZone", "0")
            .env("MallocMaxMagazines", "1")
            .env("MallocMaxMediumMagazines", "1")
            .current_dir("/")
            .stdin(input)
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .map_err(|_| Failure::Launch)?;
        let input = child.stdin.take();
        let output = child.stdout.take().expect("explicitly piped worker stdout");
        let mut worker = Self {
            child: Some(child),
            input,
            output,
            finished_input: direct,
            received_bytes: 0,
            request,
            composition,
            reservations: Some(reservations),
            runtime: tokio::runtime::Handle::current(),
        };
        let result = tokio::time::timeout(
            VALIDATION_WALL_BUDGET,
            worker.initialize(&header[..header_len]),
        )
        .await
        .unwrap_or(Err(Failure::WorkBudget));
        if let Err(error) = result {
            worker.cancel().await;
            return Err(error);
        }
        Ok(worker)
    }

    async fn initialize(&mut self, header: &[u8]) -> Result<(), Failure> {
        let mut ready = [0; 4];
        self.output
            .read_exact(&mut ready)
            .await
            .map_err(|_| Failure::Sandbox)?;
        if ready != WORKER_READY {
            return Err(Failure::Sandbox);
        }
        if self.finished_input {
            return Ok(());
        }
        self.input
            .as_mut()
            .ok_or(Failure::Input)?
            .write_all(header)
            .await
            .map_err(|_| Failure::Input)?;
        Ok(())
    }

    /// Queue slots and bytes must already be reserved by the terminal owner.
    /// Pipe backpressure suspends this job, never the terminal owner or input.
    pub async fn push(&mut self, bytes: &[u8], last: bool) -> Result<(), Failure> {
        if self.finished_input || self.composition.is_some() || bytes.len() > MAX_CHUNK_BYTES {
            return Err(Failure::Input);
        }
        let total = self
            .received_bytes
            .checked_add(bytes.len())
            .ok_or(Failure::Input)?;
        let max = merkur_graphics::processing::MAX_INPUT_BYTES;
        let max = if self.request.base64 {
            max.div_ceil(3) * 4
        } else {
            max
        };
        if total > max {
            return Err(Failure::Input);
        }
        self.received_bytes = total;
        let prefix = bytes.len() as u32 | if last { FINAL_CHUNK } else { 0 };
        let input = self.input.as_mut().ok_or(Failure::Input)?;
        input
            .write_all(&prefix.to_le_bytes())
            .await
            .map_err(|_| Failure::Input)?;
        input.write_all(bytes).await.map_err(|_| Failure::Input)?;
        if last {
            self.finished_input = true;
            self.input.take();
        }
        Ok(())
    }

    /// Receives into trusted private memory: the helper never maps this buffer
    /// and cannot change it after validation or after its process is reaped.
    pub async fn finish(&mut self) -> Result<DecodedImage, Failure> {
        self.finish_retaining_workspace()
            .await
            .map(|(image, _workspace)| image)
    }

    async fn finish_retaining_workspace(&mut self) -> Result<(DecodedImage, Lease), Failure> {
        let result = tokio::time::timeout(VALIDATION_WALL_BUDGET, self.finish_inner())
            .await
            .unwrap_or(Err(Failure::WorkBudget));
        if result.is_err() {
            self.cancel_in_place().await;
        }
        result
    }

    async fn finish_inner(&mut self) -> Result<(DecodedImage, Lease), Failure> {
        if !self.finished_input {
            return Err(Failure::Input);
        }
        let mut header = [0; RESULT_BYTES];
        self.output
            .read_exact(&mut header)
            .await
            .map_err(|_| Failure::Output)?;
        if header[0] == 1 && header[2..].iter().all(|&byte| byte == 0) {
            return Err(match Rejection::from_byte(header[1]) {
                Some(Rejection::Invalid) => Failure::Decode,
                Some(Rejection::Truncated) => Failure::Truncated,
                Some(Rejection::Png) => Failure::Png,
                Some(Rejection::Excess) => Failure::Excess,
                None => Failure::Output,
            });
        }
        if header[..4] != [0; 4] {
            return Err(Failure::Output);
        }
        let word = |offset| {
            u32::from_le_bytes(
                header[offset..offset + 4]
                    .try_into()
                    .expect("fixed header extent"),
            )
        };
        let (width, height, size) = (word(4), word(8), word(12) as usize);
        if pixel_bytes(width, height, 4) != Some(size) {
            return Err(Failure::Output);
        }
        if self.request.format != merkur_graphics::command::Format::Png
            && (self.request.width != width || self.request.height != height)
        {
            return Err(Failure::Output);
        }
        let mut bytes = Vec::new();
        bytes.try_reserve_exact(size).map_err(|_| Failure::Output)?;
        bytes.resize(size, 0);
        self.output
            .read_exact(&mut bytes)
            .await
            .map_err(|_| Failure::Output)?;
        let mut tail = [0];
        if self
            .output
            .read(&mut tail)
            .await
            .map_err(|_| Failure::Output)?
            != 0
        {
            return Err(Failure::Output);
        }
        if !self
            .child
            .as_mut()
            .ok_or(Failure::Exit)?
            .wait()
            .await
            .map_err(|_| Failure::Exit)?
            .success()
        {
            return Err(Failure::Exit);
        }
        self.child.take();
        let pixels = Pixels::new(width, height, bytes.into_boxed_slice()).ok_or(Failure::Output)?;
        let mut reservations = self.reservations.take().ok_or(Failure::Output)?;
        if !reservations.output.shrink(Usage {
            bytes: size + OUTPUT_METADATA_BYTES,
            objects: 1,
        }) {
            return Err(Failure::Output);
        }
        // The blocking job owns both reservations. Dropping this future cannot
        // release processing capacity while a detached hash still runs, or
        // release the byte charge while it still owns the pixel allocation.
        commit_pixels(pixels, reservations)
            .await
            .map_err(|_| Failure::Output)
            .and_then(|image| image.ok_or(Failure::Output))
    }

    pub async fn cancel(mut self) {
        self.cancel_in_place().await;
    }

    async fn cancel_in_place(&mut self) {
        self.input.take();
        if let Some(child) = self.child.as_mut() {
            let _ = child.start_kill();
            if child.wait().await.is_err() {
                return;
            }
        }
        self.child.take();
        self.reservations.take();
    }
}

fn commit_pixels(
    pixels: Pixels,
    reservations: Reservations,
) -> tokio::task::JoinHandle<Option<(DecodedImage, Lease)>> {
    tokio::task::spawn_blocking(move || {
        let image = DecodedImage::new(pixels, reservations.output)?;
        Some((image, reservations.workspace))
    })
}

impl Drop for Worker {
    fn drop(&mut self) {
        if let Some(mut child) = self.child.take() {
            // Cancellation cannot refund a process slot before its actual exit.
            // The daemon keeps this runtime alive through graphics shutdown.
            let reservations = ReapingReservation::new(self.reservations.take());
            let _ = child.start_kill();
            self.runtime.spawn(async move {
                if child.wait().await.is_ok() {
                    reservations.reaped();
                }
            });
        }
    }
}

#[cfg(test)]
mod commitment_tests {
    use super::*;
    use merkur_graphics::budget::Budget;

    #[test]
    fn retirement_wakes_existing_and_late_waiters_without_refunding_readers() {
        use merkur_graphics::scene::SceneContent;
        use std::future::Future;
        use std::sync::{Arc, atomic::AtomicUsize};
        use std::task::{Context, Poll, Wake, Waker};
        struct Signal(AtomicUsize);
        impl Wake for Signal {
            fn wake(self: Arc<Self>) {
                self.0.fetch_add(1, Ordering::Relaxed);
            }
            fn wake_by_ref(self: &Arc<Self>) {
                self.0.fetch_add(1, Ordering::Relaxed);
            }
        }
        let signal = Arc::new(Signal(AtomicUsize::new(0)));
        let waker = Waker::from(Arc::clone(&signal));
        let mut cx = Context::from_waker(&waker);
        let usage = Usage {
            bytes: 4 + OUTPUT_METADATA_BYTES,
            objects: 1,
        };
        let storage = Budget::new(usage);
        let pixels = Pixels::new(1, 1, vec![1, 2, 3, 4].into()).unwrap();
        let image = DecodedImage::new(pixels, storage.reserve(usage).unwrap()).unwrap();
        assert!(!image.is_retired());
        let mut first = Box::pin(image.retired());
        let mut second = Box::pin(image.retired());
        assert_eq!(first.as_mut().poll(&mut cx), Poll::Pending);
        assert_eq!(second.as_mut().poll(&mut cx), Poll::Pending);
        image.retire();
        assert_eq!(signal.0.load(Ordering::Relaxed), 2);
        assert!(image.is_retired());
        assert_eq!(first.as_mut().poll(&mut cx), Poll::Ready(()));
        assert_eq!(second.as_mut().poll(&mut cx), Poll::Ready(()));
        assert_eq!(
            Box::pin(image.retired()).as_mut().poll(&mut cx),
            Poll::Ready(())
        );
        image.retire();
        assert_eq!(signal.0.load(Ordering::Relaxed), 2);
        assert_eq!(storage.used(), Some(usage));
        assert_eq!(image.pixels().rgba(), [1, 2, 3, 4]);
        drop((first, second));
        drop(image);
        retirement::drain();
        assert_eq!(
            storage.used(),
            Some(Usage {
                bytes: 0,
                objects: 0
            })
        );
    }

    #[test]
    fn cancelled_commitment_keeps_both_reservations_until_blocking_job_retires() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .max_blocking_threads(1)
            .build()
            .unwrap();
        let (started_tx, started_rx) = std::sync::mpsc::sync_channel(0);
        let (release_tx, release_rx) = std::sync::mpsc::sync_channel(0);
        // Occupy the only blocking worker: the commitment is definitely queued
        // when its caller disappears. No sleeps or racing hash durations.
        let blocker = runtime.spawn_blocking(move || {
            started_tx.send(()).unwrap();
            release_rx.recv().unwrap();
        });
        started_rx.recv().unwrap();
        let usage = Usage {
            bytes: 4 + OUTPUT_METADATA_BYTES,
            objects: 1,
        };
        let workspace = Budget::new(usage);
        let storage = Budget::new(usage);
        let job = {
            let _entered = runtime.enter();
            commit_pixels(
                Pixels::new(1, 1, vec![1, 2, 3, 4].into()).unwrap(),
                Reservations {
                    workspace: workspace.reserve(usage).unwrap(),
                    output: storage.reserve(usage).unwrap(),
                },
            )
        };
        drop(job);
        assert_eq!(workspace.used(), Some(usage));
        assert_eq!(storage.used(), Some(usage));
        assert!(workspace.reserve(usage).is_none());
        release_tx.send(()).unwrap();
        runtime.block_on(blocker).unwrap();
        // Runtime shutdown joins blocking jobs, including the detached owner.
        drop(runtime);
        retirement::drain();
        let empty = Some(Usage {
            bytes: 0,
            objects: 0,
        });
        assert_eq!(workspace.used(), empty);
        assert_eq!(storage.used(), empty);
    }
}
