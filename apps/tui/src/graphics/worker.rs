//! One lazy CPU worker per graphics owner. Buffers retain their reservations
//! through cancellation and completion queues; the UI never decodes or samples.
use std::sync::mpsc::{self, Receiver, Sender, TryRecvError};
use std::thread::{self, JoinHandle};

use super::*;

static COMPLETED: tokio::sync::Notify = tokio::sync::Notify::const_new();
pub(crate) async fn completed() {
    COMPLETED.notified().await;
}

pub(super) struct Source {
    pub png: Zeroizing<Vec<u8>>,
    pub pixels: Zeroizing<Vec<u8>>,
    pub width: u32,
    pub height: u32,
    pub _storage: Lease,
}
pub(super) enum Prepared {
    Tile {
        key: String,
        source: Source,
    },
    Raster {
        key: RasterKey,
        cancel: Arc<AtomicBool>,
        pixels: Zeroizing<Vec<u8>>,
        storage: Lease,
    },
    Cancelled,
}
pub(super) struct Result {
    pub generation: Arc<AtomicBool>,
    pub prepared: io::Result<Prepared>,
}
enum Job {
    Tile {
        generation: Arc<AtomicBool>,
        key: String,
        png: Zeroizing<Vec<u8>>,
        storage: Lease,
    },
    Raster {
        generation: Arc<AtomicBool>,
        cancel: Arc<AtomicBool>,
        key: RasterKey,
        quad: Quad,
        source: Arc<Source>,
        storage: Lease,
    },
}
impl Job {
    fn run(self) -> Result {
        match self {
            Self::Tile {
                generation,
                key,
                png,
                storage,
            } => {
                let prepared = if generation.load(Ordering::Acquire) {
                    Ok(Prepared::Cancelled)
                } else {
                    decode(png, storage).map(|source| Prepared::Tile { key, source })
                };
                Result {
                    generation,
                    prepared,
                }
            }
            Self::Raster {
                generation,
                cancel,
                key,
                quad,
                source,
                storage,
            } => {
                let cancelled =
                    || generation.load(Ordering::Acquire) || cancel.load(Ordering::Acquire);
                let prepared = if cancelled() {
                    Ok(Prepared::Cancelled)
                } else {
                    match rasterize(&source, &quad, key.rect, cancelled) {
                        Ok(pixels) => Ok(Prepared::Raster {
                            key,
                            cancel,
                            pixels,
                            storage,
                        }),
                        Err(error) if error.kind() == io::ErrorKind::Interrupted => {
                            Ok(Prepared::Cancelled)
                        }
                        Err(error) => Err(error),
                    }
                };
                Result {
                    generation,
                    prepared,
                }
            }
        }
    }
}

pub(super) struct Worker {
    jobs: Option<Sender<Job>>,
    results: Receiver<Result>,
    thread: Option<JoinHandle<()>>,
}
impl Worker {
    pub fn new() -> io::Result<Self> {
        let (jobs, incoming) = mpsc::channel::<Job>();
        let (finished, results) = mpsc::channel();
        let thread = thread::Builder::new()
            .name("merkur-graphics".into())
            .spawn(move || {
                // A panic still wakes the owner; a disconnected channel is an error.
                struct Wake;
                impl Drop for Wake {
                    fn drop(&mut self) {
                        COMPLETED.notify_one();
                    }
                }
                let _wake = Wake;
                while let Ok(job) = incoming.recv() {
                    if finished.send(job.run()).is_err() {
                        break;
                    }
                    COMPLETED.notify_one();
                }
            })?;
        Ok(Self {
            jobs: Some(jobs),
            results,
            thread: Some(thread),
        })
    }
    pub fn tile(
        &self,
        generation: Arc<AtomicBool>,
        key: String,
        png: Zeroizing<Vec<u8>>,
        storage: Lease,
    ) -> io::Result<()> {
        self.send(Job::Tile {
            generation,
            key,
            png,
            storage,
        })
    }
    pub fn raster(
        &self,
        cancellation: (Arc<AtomicBool>, Arc<AtomicBool>),
        key: RasterKey,
        quad: Quad,
        source: Arc<Source>,
        storage: Lease,
    ) -> io::Result<()> {
        let (generation, cancel) = cancellation;
        self.send(Job::Raster {
            generation,
            cancel,
            key,
            quad,
            source,
            storage,
        })
    }
    fn send(&self, job: Job) -> io::Result<()> {
        self.jobs
            .as_ref()
            .expect("live worker")
            .send(job)
            .map_err(|_| io::Error::other("graphics worker stopped"))
    }
    pub fn receive(&self) -> io::Result<Option<Result>> {
        match self.results.try_recv() {
            Ok(result) => Ok(Some(result)),
            Err(TryRecvError::Empty) => Ok(None),
            Err(TryRecvError::Disconnected) => Err(io::Error::other("graphics worker stopped")),
        }
    }
}
impl Drop for Worker {
    fn drop(&mut self) {
        self.jobs.take();
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

fn decode(png: Zeroizing<Vec<u8>>, storage: Lease) -> io::Result<Source> {
    let mut decoder = png::Decoder::new_with_limits(
        std::io::Cursor::new(&*png),
        png::Limits {
            bytes: 4 * 258 * 258 + 264 * 1024,
        },
    );
    decoder.set_ignore_text_chunk(true);
    decoder.set_ignore_iccp_chunk(true);
    let mut reader = decoder.read_info().map_err(io::Error::other)?;
    let info = reader.info();
    let (width, height) = (info.width, info.height);
    if !(3..=258).contains(&width)
        || !(3..=258).contains(&height)
        || info.color_type != png::ColorType::Rgba
        || info.bit_depth != png::BitDepth::Eight
    {
        return Err(io::Error::other(
            "verified graphics tile has a noncanonical PNG shape",
        ));
    }
    let mut pixels = Zeroizing::new(vec![0; width as usize * height as usize * 4]);
    let decoded = reader.next_frame(&mut pixels).map_err(io::Error::other)?;
    if decoded.buffer_size() != pixels.len() {
        return Err(io::Error::other(
            "verified graphics tile has an invalid pixel extent",
        ));
    }
    reader.finish().map_err(io::Error::other)?;
    drop(reader);
    Ok(Source {
        png,
        pixels,
        width,
        height,
        _storage: storage,
    })
}
