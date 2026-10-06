//! Publication authority is separate from shared immutable animation pixels.
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

use merkur_graphics::{
    animation::Manifest,
    budget::{Lease, Usage},
    processing::Pixels,
    projection::Content,
    scene::SceneContent,
};

use crate::{
    DecodedImage,
    frame::{Frame, Raster},
    retirement::{Completion, Retained},
};

pub enum ImageContent {
    Static(DecodedImage),
    Animation(AnimatedImage),
}

pub struct AnimatedImage {
    descriptor: Content,
    data: Retained<AnimationStorage>,
    retired: AtomicBool,
    retirement: tokio::sync::Notify,
}

struct AnimationStorage {
    manifest: Manifest,
    frames: Box<[Frame]>,
}

impl AnimatedImage {
    /// The retained storage and frame-reference allocation of `frames` frames.
    pub fn charge(frames: usize) -> Usage {
        Usage {
            bytes: Retained::<AnimationStorage>::METADATA_BYTES
                + size_of::<AnimationStorage>()
                + size_of::<Self>()
                + frames * size_of::<Frame>(),
            objects: 2,
        }
    }

    /// The caller builds the frame catalogue off the terminal owner. Admission
    /// precedes the one exact frame-reference allocation, `charge`, split from
    /// storage the owner admitted; pixels remain shared.
    pub fn new(manifest: Manifest, frames: &[Frame], batch: &mut Lease) -> Option<Self> {
        if frames.len() != manifest.entries().len()
            || frames.iter().zip(manifest.entries()).any(|(frame, entry)| {
                let content = frame.content();
                content.root != entry.root
                    || content.width != manifest.width()
                    || content.height != manifest.height()
            })
        {
            return None;
        }
        let lease = batch.split(Self::charge(frames.len()))?;
        Some(Self {
            descriptor: manifest.content(),
            data: Retained::new(
                AnimationStorage {
                    manifest,
                    frames: frames.into(),
                },
                lease,
            )?,
            retired: AtomicBool::new(false),
            retirement: tokio::sync::Notify::new(),
        })
    }

    pub fn manifest(&self) -> &Manifest {
        &self.data.manifest
    }
    pub fn frames(&self) -> &[Frame] {
        &self.data.frames
    }
}

pub enum RasterRef<'a> {
    Pixels(&'a Pixels),
    Frame(&'a Frame),
}

impl Raster for RasterRef<'_> {
    fn width(&self) -> u32 {
        match self {
            Self::Pixels(pixels) => pixels.width(),
            Self::Frame(frame) => frame.width(),
        }
    }
    fn height(&self) -> u32 {
        match self {
            Self::Pixels(pixels) => pixels.height(),
            Self::Frame(frame) => frame.height(),
        }
    }
    fn run(&self, x: u32, y: u32) -> &[u8] {
        match self {
            Self::Pixels(pixels) => pixels.run(x, y),
            Self::Frame(frame) => frame.run(x, y),
        }
    }
}

impl ImageContent {
    pub fn decoded(&self) -> Option<&DecodedImage> {
        match self {
            Self::Static(image) => Some(image),
            Self::Animation(_) => None,
        }
    }
    pub fn animation(&self) -> Option<&AnimatedImage> {
        match self {
            Self::Animation(image) => Some(image),
            Self::Static(_) => None,
        }
    }
    pub fn raster(&self, index: u32) -> Option<RasterRef<'_>> {
        match self {
            Self::Static(image) if index == 0 => Some(RasterRef::Pixels(image.pixels())),
            Self::Static(_) => None,
            Self::Animation(image) => image.frames().get(index as usize).map(RasterRef::Frame),
        }
    }
    pub fn frame_root(&self, index: u32) -> Option<[u8; 32]> {
        match self {
            Self::Static(image) if index == 0 => Some(image.source().content().root),
            Self::Static(_) => None,
            Self::Animation(image) => image.frames().get(index as usize).map(|f| f.content().root),
        }
    }
    /// Physical release of the storage this content owns: a static's pixel allocation once
    /// its last holder drops it, or an animation's frame storage together with every frame
    /// root and pixel allocation that storage's destruction releases. A frame still shared
    /// with other live content is neither released nor waited for. A scene-live static
    /// shares its pixels only with an edit of that same image (`Frame::from_image`), which
    /// replaces it on publication and whose fence eviction revokes (`Scene::remove`).
    pub fn released(&self) -> Arc<Completion> {
        match self {
            Self::Static(image) => image.data.completion(),
            Self::Animation(image) => image.data.completion(),
        }
    }
    /// Whether frames other than this content hold the storage it owns: an edit
    /// of a static image builds its first frame from the static's pixels, and
    /// every tile the edit left unchanged keeps them. `released` then waits for
    /// that animation. Exact on the terminal owner once no edit of this image is
    /// in flight; an animation's frame storage is its own.
    pub fn storage_shared(&self) -> bool {
        match self {
            Self::Static(image) => Arc::strong_count(&image.data) > 1,
            Self::Animation(_) => false,
        }
    }
    pub fn is_retired(&self) -> bool {
        match self {
            Self::Static(image) => image.is_retired(),
            Self::Animation(image) => image.retired.load(Ordering::Acquire),
        }
    }
    pub async fn retired(&self) {
        match self {
            Self::Static(image) => image.retired().await,
            Self::Animation(image) => {
                let wake = image.retirement.notified();
                tokio::pin!(wake);
                wake.as_mut().enable();
                if !self.is_retired() {
                    wake.await;
                }
            }
        }
    }
}

impl SceneContent for ImageContent {
    fn descriptor(&self) -> Content {
        match self {
            Self::Static(image) => image.descriptor(),
            Self::Animation(image) => image.descriptor,
        }
    }
    fn retire(&self) {
        match self {
            Self::Static(image) => image.retire(),
            Self::Animation(image) => {
                if !image.retired.swap(true, Ordering::AcqRel) {
                    image.retirement.notify_waiters();
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use merkur_graphics::{
        animation::{Entry, Mode, Playback},
        budget::Budget,
        command::{Chunk, Control, Received},
        ingest::{Ingest, Step},
        publication::TerminalIncarnation,
        scene::{Image, Published, Scene},
    };

    use super::*;

    const EMPTY: Usage = Usage {
        bytes: 0,
        objects: 0,
    };

    fn pixels(storage: &Budget, value: u8) -> DecodedImage {
        let bytes = 4 + crate::OUTPUT_METADATA_BYTES;
        DecodedImage::new(
            Pixels::new(1, 1, vec![value; 4].into()).unwrap(),
            storage.reserve(Usage { bytes, objects: 1 }).unwrap(),
        )
        .unwrap()
    }

    fn publish(
        scene: &mut Scene<ImageContent>,
        ingest: &mut Ingest,
        storage: &Budget,
        header: &[u8],
    ) -> Arc<Image<ImageContent>> {
        let control = Control::parse(header).unwrap();
        let Step::Data { id, .. } = ingest.accept(Received::Chunk(Chunk {
            control,
            payload: b"G1Hzfw==",
        })) else {
            panic!("data")
        };
        assert!(ingest.finish_validation(id));
        let fence = scene.begin(id, &control).unwrap();
        let content = ImageContent::Static(pixels(storage, 7));
        let Published::Image { image, .. } = scene.publish(fence, content).unwrap() else {
            panic!("image")
        };
        image
    }

    #[tokio::test]
    async fn static_release_waits_for_every_pixel_holder_and_the_image_metadata() {
        let storage = Budget::new(Usage {
            bytes: 64 * 1024,
            objects: 8,
        });
        let frames = Budget::new(Usage {
            bytes: 64 * 1024,
            objects: 8,
        });
        let mut scene = Scene::new(TerminalIncarnation([1; 16]), storage.clone());
        let mut ingest = Ingest::new(4096);

        // An edit's frame outlives the image: the release waits for that holder.
        let image = publish(&mut scene, &mut ingest, &storage, b"i=1,s=1,v=1,f=32");
        let released = image.content.released();
        assert!(!image.content.storage_shared());
        let frame = Frame::from_image(
            image.content.decoded().unwrap(),
            &mut frames.reserve(Frame::tree_charge(1, 1)).unwrap(),
        )
        .unwrap();
        assert!(image.content.storage_shared());
        assert!(scene.remove(image.incarnation).is_some());
        drop(image);
        crate::retirement::drain();
        assert!(!released.is_done());
        assert_eq!(
            storage.used(),
            Some(Usage {
                bytes: 4 + crate::OUTPUT_METADATA_BYTES,
                objects: 1
            })
        );
        drop(frame);
        released.wait().await;
        assert_eq!(storage.used(), Some(EMPTY));

        // The image is the last holder and another thread drops it: its release
        // already implies the scene metadata refund, declared before the content.
        let image = publish(&mut scene, &mut ingest, &storage, b"i=2,s=1,v=1,f=32");
        let released = image.content.released();
        drop(
            Frame::from_image(
                image.content.decoded().unwrap(),
                &mut frames.reserve(Frame::tree_charge(1, 1)).unwrap(),
            )
            .unwrap(),
        );
        crate::retirement::drain();
        // The frame is gone: the image's pixels are its own again.
        assert!(!image.content.storage_shared());
        assert!(!released.is_done());
        assert!(scene.remove(image.incarnation).is_some());
        let holder = std::thread::spawn(move || drop(image));
        released.wait().await;
        assert_eq!(storage.used(), Some(EMPTY));
        holder.join().unwrap();
        crate::retirement::drain();
        assert_eq!(frames.used(), Some(EMPTY));
    }

    #[tokio::test]
    async fn animation_release_covers_exclusive_frames_but_not_shared_ones() {
        let storage = Budget::new(Usage {
            bytes: 1024 * 1024,
            objects: 64,
        });
        let frame = |value| {
            let mut tree = storage.reserve(Frame::tree_charge(1, 1)).unwrap();
            Frame::from_image(&pixels(&storage, value), &mut tree).unwrap()
        };
        let animation = |frames: &[Frame]| {
            let entries: Vec<_> = frames
                .iter()
                .map(|frame| Entry {
                    root: frame.content().root,
                    gap_ms: 40,
                })
                .collect();
            let playback = Playback {
                mode: Mode::Loop,
                anchor_us: 0,
                frame: 0,
                loops: 0,
                completed: 0,
                elapsed_us: 0,
            };
            let mut batch = storage
                .reserve(Manifest::charge(entries.len()).unwrap())
                .unwrap();
            let manifest = Manifest::new(1, 1, 1, playback, &entries, &mut batch).unwrap();
            let mut batch = storage
                .reserve(AnimatedImage::charge(frames.len()))
                .unwrap();
            ImageContent::Animation(AnimatedImage::new(manifest, frames, &mut batch).unwrap())
        };
        // Each frame alone holds its pixels; the decoded originals are gone.
        let shared = frame(1);
        let alone = storage.used().unwrap();
        let first = animation(&[shared.clone(), frame(2)]);
        let with_first = storage.used().unwrap();
        let second = animation(&[shared, frame(3)]);
        let with_both = storage.used().unwrap();
        // Queued behind the release, a stall holds the reclaimer until the state
        // that completion published has been read.
        struct Stall(std::sync::Mutex<std::sync::mpsc::Receiver<()>>);
        impl Drop for Stall {
            fn drop(&mut self) {
                if let Ok(resume) = self.0.lock() {
                    let _ = resume.recv();
                }
            }
        }
        let (resume, stalled) = std::sync::mpsc::channel();
        let charge = Usage {
            bytes: 4096,
            objects: 1,
        };
        let stall = Stall(std::sync::Mutex::new(stalled));
        let stall = Retained::new(stall, Budget::new(charge).reserve(charge).unwrap()).unwrap();
        let released = first.released();
        drop(first);
        drop(stall);
        released.wait().await;
        let observed = storage.used();
        resume.send(()).unwrap();
        // The first animation's storage, manifest and exclusive frame are gone at
        // its completion; the shared frame stays charged to the second.
        assert_eq!(
            observed,
            Some(Usage {
                bytes: alone.bytes + with_both.bytes - with_first.bytes,
                objects: alone.objects + with_both.objects - with_first.objects,
            })
        );
        let released = second.released();
        drop(second);
        released.wait().await;
        assert_eq!(storage.used(), Some(EMPTY));
    }
}
