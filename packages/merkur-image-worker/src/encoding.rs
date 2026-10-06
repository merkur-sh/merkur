//! Bounded native tile processing. Admission removes an actual reusable context;
//! there is no unbounded blocking-task queue and no work on the terminal owner.
//! Encoded tiles are transfer objects: the caller's credit admits each one, one
//! transfer owns it, and its bytes are wiped before that credit returns. There is
//! no daemon tile cache.

use crate::{
    content::ImageContent,
    tile::{self, Encoder},
};
use merkur_graphics::{
    budget::{Budget, Lease, Usage},
    scene::Image,
    tile::{TILE_ENCODED_BYTES, TileShape, object_root},
};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};
use tokio::{sync::Notify, task::JoinHandle};
use zeroize::Zeroize;

/// Resource bound on simultaneously executing/queued native tile jobs, shared
/// daemon-wide. Two contexts allow independent requests without saturating every
/// CPU available to PTY, crypto, packet and display work.
pub const ENCODERS: usize = 2;
/// Resource bound for pool synchronization and fixed context slots.
const POOL_METADATA_BYTES: usize = 4096;

/// One pool context: a reusable encoder and the output span libdeflate writes into.
struct Context {
    encoder: Encoder,
    output: WipeBuffer,
}

struct State {
    idle: Mutex<Vec<Context>>,
    available: Notify,
    _metadata: Lease,
}

#[derive(Clone)]
pub struct Pool(Arc<State>);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refusal {
    Retired,
    Tile,
    Worker,
}

impl Pool {
    pub const fn charge() -> Usage {
        Usage {
            bytes: ENCODERS * (tile::ENCODER_BYTES + TILE_ENCODED_BYTES) + POOL_METADATA_BYTES,
            objects: 2 * ENCODERS + 1,
        }
    }

    /// Allocation/initialization runs off the async owner. A cancelled constructor
    /// retains admission until the blocking initialization actually retires.
    pub async fn new(budget: &Budget) -> Option<Self> {
        let mut metadata = budget.reserve(Self::charge())?;
        tokio::task::spawn_blocking(move || {
            let mut idle = Vec::with_capacity(ENCODERS);
            for _ in 0..ENCODERS {
                idle.push(Context {
                    encoder: Encoder::new(metadata.split(Encoder::charge())?)?,
                    output: WipeBuffer(vec![0; TILE_ENCODED_BYTES]),
                });
            }
            // The remainder covers pool metadata and both output spans.
            Some(Self(Arc::new(State {
                idle: Mutex::new(idle),
                available: Notify::new(),
                _metadata: metadata,
            })))
        })
        .await
        .ok()
        .flatten()
    }

    /// Encodes one tile into the caller's transfer credit. A lost race for a context
    /// never consumes the credit; a cancelled job keeps it until its blocking worker
    /// actually stops. The caller first resolves `source` in its authorized live
    /// terminal scene; this preserves its storage/access lifetime but cannot authorize it.
    pub async fn encode<C: Send + 'static>(
        &self,
        source: Arc<Image<ImageContent>>,
        frame: u32,
        level: u8,
        x: u32,
        y: u32,
        credit: C,
    ) -> Result<Tile<C>, Refusal> {
        if source.content.is_retired() {
            return Err(Refusal::Retired);
        }
        if crate::pyramid::shape(
            &source.content.raster(frame).ok_or(Refusal::Tile)?,
            level,
            x,
            y,
        )
        .is_none()
        {
            return Err(Refusal::Tile);
        }
        let context = loop {
            self.available().await;
            if let Some(context) = self.checkout()? {
                break context;
            }
        };
        context
            .start(source, frame, level, [x, y], credit)
            .finish()
            .await
    }

    fn checkout(&self) -> Result<Option<CheckedOut>, Refusal> {
        let context = self.0.idle.lock().map_err(|_| Refusal::Worker)?.pop();
        Ok(context.map(|context| CheckedOut {
            context: Some(context),
            pool: self.clone(),
        }))
    }

    /// Readiness is an exact return-of-context event. Register before checking
    /// state so a context returned between observation and awaiting is not lost.
    pub async fn available(&self) {
        loop {
            let notified = self.0.available.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if self.0.idle.lock().map_or(true, |idle| !idle.is_empty()) {
                return;
            }
            notified.await;
        }
    }
}

struct CheckedOut {
    context: Option<Context>,
    pool: Pool,
}

impl CheckedOut {
    /// The blocking worker owns this context, the source and the credit until it
    /// stops. It rechecks cancellation and retirement around encoding; its one
    /// allocation, the tile's exact-length copy, is its final and infallible step.
    fn start<C: Send + 'static>(
        self,
        source: Arc<Image<ImageContent>>,
        frame: u32,
        level: u8,
        tile: [u32; 2],
        credit: C,
    ) -> Job<Tile<C>> {
        let cancelled = Arc::new(AtomicBool::new(false));
        let worker_cancelled = Arc::clone(&cancelled);
        let worker_source = Arc::clone(&source);
        let task = tokio::task::spawn_blocking(move || {
            let mut checked_out = self;
            let stopped =
                || worker_cancelled.load(Ordering::Acquire) || worker_source.content.is_retired();
            if stopped() {
                return Err(Refusal::Retired);
            }
            let Context { encoder, output } =
                checked_out.context.as_mut().ok_or(Refusal::Worker)?;
            let (shape, len) = encoder
                .encode_level(
                    &worker_source.content.raster(frame).ok_or(Refusal::Tile)?,
                    level,
                    tile,
                    &mut output.0,
                    &stopped,
                )
                .ok_or_else(|| {
                    if stopped() {
                        Refusal::Retired
                    } else {
                        Refusal::Tile
                    }
                })?;
            // Only a completed encode wrote the span, and only its encoded prefix:
            // libdeflate cannot overflow it, and a final word flush past the stream
            // lands in the Adler-32 and IDAT CRC. Every exit below wipes that prefix.
            let encoded = Encoded(&mut output.0[..len]);
            if stopped() {
                return Err(Refusal::Retired);
            }
            let source = worker_source
                .content
                .frame_root(frame)
                .ok_or(Refusal::Tile)?;
            let bytes = &*encoded.0;
            let root = object_root(bytes);
            Ok(Tile {
                shape,
                root,
                source,
                bytes: Box::from(bytes),
                _credit: credit,
            })
        });
        Job {
            task: Some(task),
            cancelled,
            source,
        }
    }
}

impl Drop for CheckedOut {
    fn drop(&mut self) {
        if let Some(mut context) = self.context.take() {
            // A returned encoder must retain neither source scanlines nor reduced
            // rows. Wipe on its worker, outside the pool lock, on every exit.
            context.encoder.clear_scratch();
            // No user code runs under this lock. A panic outside it still returns
            // the context and keeps its lease; cancellation cannot create credit.
            self.pool
                .0
                .idle
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .push(context);
            // One context wakes one waiter, never every credit holder queued
            // behind the pool. A woken waiter that is dropped forwards the wake,
            // and `available` registers before it checks, so none is lost.
            self.pool.0.available.notify_one();
        }
    }
}

struct WipeBuffer(Vec<u8>);
impl Drop for WipeBuffer {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}

/// The encoded prefix of a context's output span. It is wiped however the job ends, before
/// the context returns to the pool, so an idle context holds no tile.
struct Encoded<'a>(&'a mut [u8]);
impl Drop for Encoded<'_> {
    fn drop(&mut self) {
        wipe(self.0);
    }
}

/// Wipes image bytes with a vectorized fill; the barrier keeps it from being elided.
/// `zeroize`'s volatile byte loop takes about 50 times as long over a 66 KB tile.
pub(crate) fn wipe(bytes: &mut [u8]) {
    bytes.fill(0);
    zeroize::optimization_barrier(bytes);
}

/// One transfer's encoded tile. Its credit admitted every allocation behind it; fields drop
/// in declaration order, so the wiped bytes are freed before the credit returns.
pub struct Tile<C> {
    pub shape: TileShape,
    pub root: [u8; 32],
    pub source: [u8; 32],
    bytes: Box<[u8]>,
    _credit: C,
}
impl<C> Tile<C> {
    pub fn bytes(&self) -> &[u8] {
        &self.bytes
    }
}
impl<C> Drop for Tile<C> {
    fn drop(&mut self) {
        wipe(&mut self.bytes);
    }
}

/// Dropping a job signals cancellation. Its blocking worker retains source,
/// credit and context until it actually stops; no early refunds.
struct Job<T> {
    task: Option<JoinHandle<Result<T, Refusal>>>,
    cancelled: Arc<AtomicBool>,
    source: Arc<Image<ImageContent>>,
}
impl<T> Job<T> {
    async fn finish(mut self) -> Result<T, Refusal> {
        let task = self.task.take().ok_or(Refusal::Worker)?;
        let result = task.await.map_err(|_| Refusal::Worker)?;
        if self.source.content.is_retired() {
            return Err(Refusal::Retired);
        }
        result
    }
}
impl<T> Drop for Job<T> {
    fn drop(&mut self) {
        self.cancelled.store(true, Ordering::Release);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use merkur_graphics::{
        command::{Chunk, Control, Received},
        ingest::{Ingest, Step},
        processing::Pixels,
        publication::TerminalIncarnation,
        scene::{Published, Scene},
        tile::TileVerifier,
    };
    use tokio::sync::{OwnedSemaphorePermit, Semaphore};

    const EMPTY: Usage = Usage {
        bytes: 0,
        objects: 0,
    };

    /// Terminal storage as the daemon partitions it: scene metadata and pixels share it.
    fn storage() -> Budget {
        Budget::new(Usage {
            bytes: 128 * 1024 * 1024,
            objects: 8192,
        })
    }

    fn publish(
        scene: &mut Scene<ImageContent>,
        ingest: &mut Ingest,
        storage: &Budget,
        id: u32,
        pixels: Pixels,
    ) -> Arc<Image<ImageContent>> {
        let control = Control::parse(format!("i={id},s=1,v=1,f=32").as_bytes()).unwrap();
        let Step::Data { id, .. } = ingest.accept(Received::Chunk(Chunk {
            control,
            payload: b"G1Hzfw==",
        })) else {
            panic!("data")
        };
        assert!(ingest.finish_validation(id));
        let fence = scene.begin(id, &control).unwrap();
        let bytes = pixels.rgba().len() + crate::OUTPUT_METADATA_BYTES;
        let decoded = crate::DecodedImage::new(
            pixels,
            storage.reserve(Usage { bytes, objects: 1 }).unwrap(),
        )
        .unwrap();
        let Published::Image { image, .. } =
            scene.publish(fence, ImageContent::Static(decoded)).unwrap()
        else {
            panic!("image")
        };
        image
    }

    fn source(storage: &Budget, pixels: Pixels) -> (Scene<ImageContent>, Arc<Image<ImageContent>>) {
        let mut scene = Scene::new(TerminalIncarnation([1; 16]), storage.clone());
        let image = publish(&mut scene, &mut Ingest::new(4096), storage, 1, pixels);
        (scene, image)
    }

    fn pixel() -> Pixels {
        Pixels::new(1, 1, vec![27, 81, 243, 127].into()).unwrap()
    }

    /// Incompressible pixels: every tile is close to its maximum encoded length.
    fn noise(width: u32, height: u32, seed: u64) -> Pixels {
        let mut state = seed | 1;
        let mut rgba = vec![0; width as usize * height as usize * 4];
        for chunk in rgba.chunks_mut(8) {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            chunk.copy_from_slice(&state.to_le_bytes()[..chunk.len()]);
        }
        Pixels::new(width, height, rgba.into()).unwrap()
    }

    async fn credit(credits: &Arc<Semaphore>) -> OwnedSemaphorePermit {
        Arc::clone(credits).acquire_owned().await.unwrap()
    }

    #[tokio::test]
    async fn levels_keep_clipped_edge_gutters_and_refusals_return_the_credit() {
        let workspace = Budget::new(Pool::charge());
        let pool = Pool::new(&workspace).await.unwrap();
        let storage = storage();
        let rgba = [255, 0, 0, 255].repeat(513 * 3);
        let (_scene, source) = source(&storage, Pixels::new(513, 3, rgba.into()).unwrap());
        let charged = storage.used();
        let credits = Arc::new(Semaphore::new(2));
        let (left, right) = tokio::join!(
            async {
                pool.encode(Arc::clone(&source), 0, 1, 0, 0, credit(&credits).await)
                    .await
            },
            async {
                pool.encode(Arc::clone(&source), 0, 1, 1, 0, credit(&credits).await)
                    .await
            },
        );
        let (left, right) = (left.unwrap(), right.unwrap());
        assert_eq!(left.shape, TileShape::new(258, 4).unwrap());
        assert_eq!(right.shape, TileShape::new(3, 4).unwrap());
        // Each tile owns its credit. Neither it nor an image-sized intermediate
        // level is charged to the source's terminal storage.
        assert_eq!(credits.available_permits(), 0);
        assert_eq!(storage.used(), charged);
        drop((left, right));
        assert_eq!(credits.available_permits(), 2);
        for (level, x) in [(1, 2), (11, 0)] {
            let refused = pool.encode(Arc::clone(&source), 0, level, x, 0, credit(&credits).await);
            assert_eq!(refused.await.err(), Some(Refusal::Tile));
            assert_eq!(credits.available_permits(), 2);
        }
        assert_eq!(storage.used(), charged);
    }

    #[tokio::test]
    async fn four_hundred_resident_sources_serve_every_cold_tile() {
        let workspace = Budget::new(Pool::charge());
        let pool = Pool::new(&workspace).await.unwrap();
        let storage = storage();
        let mut scene = Scene::new(TerminalIncarnation([1; 16]), storage.clone());
        let mut ingest = Ingest::new(4096);
        let sources: Vec<_> = (1..=400)
            .map(|id| {
                publish(
                    &mut scene,
                    &mut ingest,
                    &storage,
                    id,
                    noise(256, 256, id.into()),
                )
            })
            .collect();
        // The diagnosed run: about 105.9 MB of resident originals, of which the
        // storage-charged tile cache served 91 cold tiles.
        let charged = storage.used();
        assert!(charged.unwrap().bytes > 400 * 256 * 256 * 4);
        let credits = Arc::new(Semaphore::new(64));
        let mut transfers = tokio::task::JoinSet::new();
        for source in sources {
            let (pool, storage, credits) = (pool.clone(), storage.clone(), Arc::clone(&credits));
            transfers.spawn(async move {
                let credit = credits.acquire_owned().await.unwrap();
                let tile = pool.encode(source, 0, 0, 0, 0, credit).await.unwrap();
                assert_eq!(tile.shape, TileShape::new(258, 258).unwrap());
                assert_eq!(tile.root, object_root(tile.bytes()));
                assert_eq!(storage.used(), charged);
            });
        }
        let mut served = 0;
        while let Some(transfer) = transfers.join_next().await {
            transfer.unwrap();
            served += 1;
        }
        assert_eq!(served, 400);
        assert_eq!(scene.len(), 400);
        assert_eq!(credits.available_permits(), 64);
        assert_eq!(storage.used(), charged);
    }

    #[tokio::test]
    async fn retirement_revokes_encoding_but_not_an_encoded_tile() {
        let too_small = Budget::new(Usage {
            bytes: Pool::charge().bytes - 1,
            objects: Pool::charge().objects,
        });
        assert!(Pool::new(&too_small).await.is_none());
        let workspace = Budget::new(Pool::charge());
        let pool = Pool::new(&workspace).await.unwrap();
        let storage = storage();
        let (mut scene, source) = source(&storage, pixel());
        let credits = Arc::new(Semaphore::new(2));
        let tile = pool
            .encode(Arc::clone(&source), 0, 0, 0, 0, credit(&credits).await)
            .await
            .unwrap();
        assert_eq!(tile.source, source.content.frame_root(0).unwrap());
        assert_eq!(tile.shape, TileShape::new(3, 3).unwrap());
        assert!(scene.remove(source.incarnation).is_some());
        let refused = pool.encode(Arc::clone(&source), 0, 0, 0, 0, credit(&credits).await);
        assert_eq!(refused.await.err(), Some(Refusal::Retired));
        assert_eq!(credits.available_permits(), 1);
        drop(source);
        crate::retirement::drain();
        // The source is physically gone while its transfer still owns the tile.
        assert_eq!(storage.used(), Some(EMPTY));
        let mut verify = TileVerifier::default();
        assert!(verify.begin(tile.bytes().len(), tile.shape, tile.root));
        assert!(verify.update(tile.bytes()));
        assert!(verify.finish());
        drop(tile);
        assert_eq!(credits.available_permits(), 2);
        drop(pool);
        assert_eq!(workspace.used(), Some(EMPTY));
    }

    #[tokio::test]
    async fn reencoding_is_byte_identical_across_contexts() {
        let workspace = Budget::new(Pool::charge());
        let pool = Pool::new(&workspace).await.unwrap();
        let storage = storage();
        let (_scene, source) = source(&storage, noise(300, 200, 7));
        let credits = Arc::new(Semaphore::new(3));
        let encode = |x| {
            let (pool, source, credits) = (pool.clone(), Arc::clone(&source), Arc::clone(&credits));
            async move {
                let credit = credit(&credits).await;
                pool.encode(source, 0, 0, x, 0, credit).await.unwrap()
            }
        };
        // Both contexts at once; then another tile leaves its rows in the most
        // recently returned context's scratch, which the sequential re-encode reuses.
        let (first, second) = tokio::join!(encode(0), encode(0));
        let other = encode(1).await;
        assert_ne!(other.root, first.root);
        drop(other);
        let third = encode(0).await;
        for tile in [&second, &third] {
            assert_eq!(tile.shape, first.shape);
            assert_eq!(tile.root, first.root);
            assert_eq!(tile.bytes(), first.bytes());
        }
    }

    #[tokio::test]
    async fn returned_contexts_keep_no_image_bytes() {
        let workspace = Budget::new(Pool::charge());
        let pool = Pool::new(&workspace).await.unwrap();
        let storage = storage();
        let gradient: Vec<u8> = (0..300 * 200)
            .flat_map(|i: u32| [(i % 300) as u8, (i / 300) as u8, 64, 255])
            .collect();
        let credits = Arc::new(Semaphore::new(2));
        // Stored, Huffman and passthrough blocks, at full and reduced resolution.
        for (pixels, level) in [
            (noise(300, 200, 11), 0),
            (noise(300, 200, 13), 1),
            (Pixels::new(300, 200, gradient.into()).unwrap(), 0),
            (pixel(), 0),
        ] {
            let (_scene, source) = source(&storage, pixels);
            let encode = || async {
                let credit = credit(&credits).await;
                pool.encode(Arc::clone(&source), 0, level, 0, 0, credit)
                    .await
                    .unwrap()
            };
            let (first, second) = tokio::join!(encode(), encode());
            for tile in [&first, &second] {
                let mut verify = TileVerifier::default();
                assert!(verify.begin(tile.bytes().len(), tile.shape, tile.root));
                assert!(verify.update(tile.bytes()));
                assert!(verify.finish());
            }
            // Both tiles are live, yet neither idle context's span holds a byte of them.
            let idle = pool.0.idle.lock().unwrap();
            assert_eq!(idle.len(), ENCODERS);
            assert!(idle.iter().all(|context| context.encoder.scratch_is_clear()));
            assert!(
                idle.iter()
                    .all(|context| context.output.0.iter().all(|byte| *byte == 0))
            );
        }
    }

    #[tokio::test]
    async fn interrupted_reduction_returns_no_source_rows_to_the_pool() {
        let workspace = Budget::new(Pool::charge());
        let pool = Pool::new(&workspace).await.unwrap();
        let pixels = noise(2048, 2048, 17);
        for panic in [false, true] {
            let context = pool.0.idle.lock().unwrap().pop().unwrap();
            let mut visits = 0;
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                let mut checked_out = CheckedOut {
                    context: Some(context),
                    pool: pool.clone(),
                };
                let Context { encoder, output } = checked_out.context.as_mut().unwrap();
                assert!(
                    encoder
                        .encode_level(&pixels, 11, [0, 0], &mut output.0, || {
                            visits += 1;
                            if visits != 20 {
                                return false;
                            }
                            assert!(!panic, "interrupted raster callback");
                            true
                        })
                        .is_none()
                );
            }));
            assert_eq!(result.is_err(), panic);
            assert_eq!(visits, 20);
            let idle = pool.0.idle.lock().unwrap();
            assert_eq!(idle.len(), ENCODERS);
            assert!(idle.iter().all(|context| context.encoder.scratch_is_clear()));
        }
    }

    #[test]
    fn waiting_for_a_context_keeps_the_credit_and_orphans_hold_theirs() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .max_blocking_threads(1)
            .build()
            .unwrap();
        let workspace = Budget::new(Pool::charge());
        let pool = runtime.block_on(Pool::new(&workspace)).unwrap();
        let storage = storage();
        let (mut scene, source) = source(&storage, pixel());
        let charged = storage.used();
        let credits = Arc::new(Semaphore::new(3));
        let credit = || Arc::clone(&credits).try_acquire_owned().unwrap();
        let (started_tx, started_rx) = std::sync::mpsc::sync_channel(0);
        let (release_tx, release_rx) = std::sync::mpsc::sync_channel(0);
        let blocker = runtime.spawn_blocking(move || {
            started_tx.send(()).unwrap();
            release_rx.recv().unwrap();
        });
        started_rx.recv().unwrap();
        let (first, second) = {
            let _entered = runtime.enter();
            let start = || {
                let context = pool.checkout().unwrap().unwrap();
                context.start(Arc::clone(&source), 0, 0, [0, 0], credit())
            };
            (start(), start())
        };
        assert!(pool.checkout().unwrap().is_none());
        // A request waiting for a context owns only its credit and returns it
        // the moment it is dropped.
        let mut waiting = Box::pin(pool.encode(Arc::clone(&source), 0, 0, 0, 0, credit()));
        let mut poll = std::task::Context::from_waker(std::task::Waker::noop());
        assert!(waiting.as_mut().poll(&mut poll).is_pending());
        assert_eq!(credits.available_permits(), 0);
        drop(waiting);
        assert_eq!(credits.available_permits(), 1);
        // A cancelled job keeps its credit, context and source until its queued
        // blocking worker actually stops.
        drop(first);
        assert!(scene.remove(source.incarnation).is_some());
        drop(source);
        crate::retirement::drain();
        assert_eq!(credits.available_permits(), 1);
        assert_eq!(workspace.used(), Some(Pool::charge()));
        assert_eq!(storage.used(), charged);
        release_tx.send(()).unwrap();
        runtime.block_on(blocker).unwrap();
        assert_eq!(
            runtime.block_on(second.finish()).err(),
            Some(Refusal::Retired)
        );
        runtime.block_on(pool.available());
        drop(runtime); // joins the cancelled detached blocking owner as well
        assert_eq!(credits.available_permits(), 3);
        crate::retirement::drain();
        assert_eq!(storage.used(), Some(EMPTY));
        drop(pool);
        assert_eq!(workspace.used(), Some(EMPTY));
    }
}
