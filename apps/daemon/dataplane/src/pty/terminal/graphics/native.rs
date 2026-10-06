//! Local descriptor submission. Only validated pixels cross into the terminal
//! namespace, at consumption of an authenticated, terminal-bound one-use token.

use std::collections::BTreeMap;
use std::io;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::os::unix::fs::DirBuilderExt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use merkur_graphics::budget::{Budget, Lease, Usage};
use merkur_graphics::command::Format;
use merkur_graphics::processing::{MAX_RGBA_BYTES, pixel_bytes};
use merkur_image_worker::descriptor::{REQUEST_LEN, Request};
use merkur_image_worker::{
    DecodedImage, OUTPUT_METADATA_BYTES, Reservations, WORKSPACE_BYTES, Worker,
};
use ring::rand::{SecureRandom, SystemRandom};
use subtle::ConstantTimeEq;
use tokio::io::{AsyncReadExt, AsyncWriteExt, Interest};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::{OwnedSemaphorePermit, Semaphore, watch};
use tokio::task::{JoinHandle, JoinSet};
use zeroize::Zeroizing;

#[cfg(test)]
mod tests;

/// Resource ceilings: accepted local connections and retained submissions.
/// The fixed broker reservation covers tasks, socket metadata and map nodes;
/// pixels and decoder workspace use the same admission as inline graphics.
const CONNECTIONS: usize = 8;
const SUBMISSIONS: usize = 32;
const BROKER_BYTES: usize = CONNECTIONS * 16384 + SUBMISSIONS * 1024 + 4096;
const BROKER_CHARGE: Usage = Usage {
    bytes: BROKER_BYTES,
    objects: CONNECTIONS + SUBMISSIONS + 4,
};

pub(crate) struct Endpoint {
    pub(crate) path: PathBuf,
    pub(crate) credential: Zeroizing<String>,
}

struct Ready {
    token: [u8; 32],
    image: DecodedImage,
    _slot: OwnedSemaphorePermit,
}

#[derive(Default)]
struct Entries {
    epoch: u64,
    next: u64,
    retired: bool,
    ready: BTreeMap<u64, Ready>,
}

struct Shared {
    entries: Mutex<Entries>,
    storage: Budget,
    processing: Budget,
    executable: PathBuf,
    credential: Zeroizing<[u8; 32]>,
    slots: Arc<Semaphore>,
    _charge: Lease,
}

pub(super) struct Broker {
    shared: Arc<Shared>,
    stop: watch::Sender<bool>,
    task: Option<JoinHandle<()>>,
}

impl Broker {
    pub(super) fn start(
        storage: Budget,
        processing: Budget,
        executable: PathBuf,
    ) -> io::Result<(Self, Endpoint)> {
        let charge = storage
            .reserve(BROKER_CHARGE)
            .ok_or_else(|| io::Error::other("native ingress quota"))?;
        let mut credential = Zeroizing::new([0; 32]);
        let mut name = [0; 16];
        SystemRandom::new()
            .fill(credential.as_mut())
            .map_err(|_| io::Error::other("native credential entropy"))?;
        SystemRandom::new()
            .fill(&mut name)
            .map_err(|_| io::Error::other("native endpoint entropy"))?;
        // A random, atomically-created private directory keeps the Unix path
        // below both Darwin and Linux limits. No caller supplies a filesystem path.
        let directory = Path::new("/tmp").join(format!("merkur-image-{}", hex(&name)));
        let path = directory.join("socket");
        std::fs::DirBuilder::new().mode(0o700).create(&directory)?;
        let listener = match UnixListener::bind(&path) {
            Ok(listener) => listener,
            Err(error) => {
                let _ = std::fs::remove_dir(&directory);
                return Err(error);
            }
        };
        let endpoint = Endpoint {
            path: path.clone(),
            credential: Zeroizing::new(hex(credential.as_ref())),
        };
        let shared = Arc::new(Shared {
            entries: Mutex::new(Entries::default()),
            storage,
            processing,
            executable,
            credential,
            slots: Arc::new(Semaphore::new(SUBMISSIONS)),
            _charge: charge,
        });
        let (stop, stopped) = watch::channel(false);
        let task = tokio::spawn(serve(
            listener,
            Arc::clone(&shared),
            stopped,
            stop.clone(),
            path,
            directory,
        ));
        Ok((
            Self {
                shared,
                stop,
                task: Some(task),
            },
            endpoint,
        ))
    }

    pub(super) fn consume(&self, encoded: &[u8]) -> Option<DecodedImage> {
        let token = token(encoded)?;
        let id = u64::from_le_bytes(token[..8].try_into().ok()?);
        let mut entries = self.shared.entries.lock().ok()?;
        if entries.retired || !bool::from(entries.ready.get(&id)?.token.ct_eq(&token)) {
            return None;
        }
        Some(entries.ready.remove(&id)?.image)
    }

    pub(super) fn reset(&self) {
        let mut entries = self
            .shared
            .entries
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        match entries.epoch.checked_add(1) {
            Some(epoch) => entries.epoch = epoch,
            None => entries.retired = true,
        }
        entries.ready.clear();
    }

    pub(super) async fn shutdown(mut self) {
        self.retire();
        if let Some(task) = self.task.take() {
            let _ = task.await;
        }
    }

    fn retire(&self) {
        let mut entries = self
            .shared
            .entries
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        entries.retired = true;
        entries.ready.clear();
        self.stop.send_replace(true);
    }
}

impl Drop for Broker {
    fn drop(&mut self) {
        self.retire();
    }
}

async fn stopped(stop: &mut watch::Receiver<bool>) {
    if !*stop.borrow_and_update() {
        let _ = stop.changed().await;
    }
}

async fn serve(
    listener: UnixListener,
    shared: Arc<Shared>,
    mut stop: watch::Receiver<bool>,
    stopping: watch::Sender<bool>,
    path: PathBuf,
    directory: PathBuf,
) {
    let mut clients = JoinSet::new();
    // SAFETY: geteuid takes no pointers and identifies this local broker's owner.
    let uid = unsafe { libc::geteuid() };
    loop {
        tokio::select! {
            biased;
            _ = stopped(&mut stop) => break,
            _ = clients.join_next(), if !clients.is_empty() => {},
            accepted = listener.accept(), if clients.len() < CONNECTIONS => {
                let Ok((stream, _)) = accepted else { break };
                if stream.peer_cred().is_ok_and(|peer| peer.uid() == uid) {
                    clients.spawn(client(stream, Arc::clone(&shared), stop.clone()));
                }
            }
        }
    }
    stopping.send_replace(true);
    drop(listener);
    // Cancellation is observed by each client; it reaps its own helper before
    // returning. Aborting the tasks would release their bookkeeping too early.
    while clients.join_next().await.is_some() {}
    let _ = std::fs::remove_file(path);
    let _ = std::fs::remove_dir(directory);
}

async fn client(mut stream: UnixStream, shared: Arc<Shared>, mut stop: watch::Receiver<bool>) {
    let mut header = Zeroizing::new([0; 33]);
    let authenticated = tokio::select! {
        biased;
        _ = stopped(&mut stop) => false,
        result = stream.read_exact(header.as_mut()) => result.is_ok()
            && bool::from(header[..32].ct_eq(shared.credential.as_ref())),
    };
    if !authenticated {
        return;
    }
    let mut reply = [0; 33];
    reply[0] = 1;
    match header[32] {
        1 => {
            if let Some(token) = submit(&mut stream, &shared, &mut stop).await {
                reply[0] = 0;
                reply[1..].copy_from_slice(&token);
            }
        }
        2 => {
            let mut token = [0; 32];
            let received = tokio::select! {
                biased;
                _ = stopped(&mut stop) => false,
                result = stream.read_exact(&mut token) => result.is_ok(),
            };
            if received && cancel(&shared, &token) {
                reply[0] = 0;
            }
        }
        _ => return,
    }
    let delivered = tokio::select! {
        biased;
        _ = stopped(&mut stop) => false,
        result = stream.write_all(&reply) => result.is_ok(),
    };
    if !delivered && header[32] == 1 && reply[0] == 0 {
        let token: &[u8; 32] = reply[1..].try_into().expect("fixed reply extent");
        cancel(&shared, token);
    }
}

async fn submit(
    stream: &mut UnixStream,
    shared: &Shared,
    stop: &mut watch::Receiver<bool>,
) -> Option<[u8; 32]> {
    let (request, descriptor) = tokio::select! {
        biased;
        _ = stopped(stop) => return None,
        input = receive_input(stream) => input.ok()?,
    };
    let slot = Arc::clone(&shared.slots).try_acquire_owned().ok()?;
    let epoch = shared.entries.lock().ok().filter(|e| !e.retired)?.epoch;
    let reservations = reserve(shared, request)?;
    // Startup has its own work bound and must finish so cancellation always
    // has an owned helper to reap. Neither the owner nor the parser waits here.
    let mut worker =
        Worker::launch_descriptor(&shared.executable, request, descriptor.into(), reservations)
            .await
            .ok()?;
    let mut disconnected = [0];
    let image = tokio::select! {
        biased;
        _ = stopped(stop) => None,
        _ = stream.read(&mut disconnected) => None,
        result = worker.finish() => result.ok(),
    };
    worker.cancel().await;
    publish(shared, epoch, image?, slot)
}

fn reserve(shared: &Shared, request: Request) -> Option<Reservations> {
    let bytes = if request.decode.format == Format::Png {
        MAX_RGBA_BYTES
    } else {
        pixel_bytes(request.decode.width, request.decode.height, 4)?
    };
    Some(Reservations {
        workspace: shared.processing.reserve(Usage {
            bytes: WORKSPACE_BYTES,
            objects: 1,
        })?,
        output: shared.storage.reserve(Usage {
            bytes: bytes + OUTPUT_METADATA_BYTES,
            objects: 1,
        })?,
    })
}

fn publish(
    shared: &Shared,
    epoch: u64,
    image: DecodedImage,
    slot: OwnedSemaphorePermit,
) -> Option<[u8; 32]> {
    let mut token = [0; 32];
    SystemRandom::new().fill(&mut token[8..]).ok()?;
    let mut entries = shared.entries.lock().ok()?;
    if entries.retired || entries.epoch != epoch {
        return None;
    }
    let id = entries.next.checked_add(1)?;
    entries.next = id;
    token[..8].copy_from_slice(&id.to_le_bytes());
    entries.ready.insert(
        id,
        Ready {
            token,
            image,
            _slot: slot,
        },
    );
    Some(token)
}

fn cancel(shared: &Shared, token: &[u8; 32]) -> bool {
    let id = u64::from_le_bytes(token[..8].try_into().expect("fixed token extent"));
    let Ok(mut entries) = shared.entries.lock() else {
        return false;
    };
    if entries
        .ready
        .get(&id)
        .is_some_and(|entry| bool::from(entry.token.ct_eq(token)))
    {
        entries.ready.remove(&id);
        true
    } else {
        false
    }
}

async fn receive_input(stream: &mut UnixStream) -> io::Result<(Request, OwnedFd)> {
    let mut bytes = [0; REQUEST_LEN];
    stream.read_exact(&mut bytes).await?;
    let request =
        Request::decode(&bytes).ok_or_else(|| io::Error::other("invalid native extent"))?;
    loop {
        stream.readable().await?;
        match stream.try_io(Interest::READABLE, || {
            receive_descriptor(stream.as_raw_fd())
        }) {
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => continue,
            result => return result.map(|descriptor| (request, descriptor)),
        }
    }
}

fn receive_descriptor(socket: i32) -> io::Result<OwnedFd> {
    // Kernel wire bounds: XNU sockargs limits MT_CONTROL to one 2048-byte
    // cluster (including pointer expansion); Linux normalizes at most 253
    // SCM_RIGHTS into one header. 4096 bytes covers either complete result.
    // Darwin installs all rights before copying ancillary bytes to userspace:
    // a deliberately undersized buffer would leak the unreported descriptors.
    let mut control = [0usize; 4096 / std::mem::size_of::<usize>()];
    let mut marker = 0u8;
    let mut descriptors = arrayvec::ArrayVec::<OwnedFd, 1024>::new();
    let mut iov = libc::iovec {
        iov_base: (&mut marker as *mut u8).cast(),
        iov_len: 1,
    };
    // SAFETY: `msghdr` holds only integers and raw pointers, for which all-zero
    // bytes are a valid value: null pointers and zero lengths.
    let mut message: libc::msghdr = unsafe { std::mem::zeroed() };
    message.msg_iov = &mut iov;
    message.msg_iovlen = 1;
    message.msg_control = control.as_mut_ptr().cast();
    message.msg_controllen = std::mem::size_of_val(&control) as _;
    #[cfg(target_os = "linux")]
    let flags = libc::MSG_CMSG_CLOEXEC;
    #[cfg(not(target_os = "linux"))]
    let flags = 0;
    // SAFETY: `message` names one byte of `marker` through `iov` and the whole
    // of `control`; all three are locals that outlive the call, and `recvmsg`
    // writes at most `iov_len` and `msg_controllen` bytes into them.
    let count = unsafe { libc::recvmsg(socket, &mut message, flags) };
    if count < 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: `message` is the header `recvmsg` just filled: `msg_control`
    // still points at `control` and `msg_controllen` is the extent the kernel
    // wrote, never more than `control` holds.
    let mut header = unsafe { libc::CMSG_FIRSTHDR(&message) };
    while !header.is_null() {
        // SAFETY: `CMSG_FIRSTHDR` and `CMSG_NXTHDR` return non-null only for a
        // header that lies wholly inside the control extent, which the kernel
        // initialized. They step by the platform's cmsg alignment from the
        // start of `control`, a `usize` array, so `header` is aligned.
        let record = unsafe { *header };
        if record.cmsg_level == libc::SOL_SOCKET && record.cmsg_type == libc::SCM_RIGHTS {
            // SAFETY: `CMSG_LEN` is arithmetic on its argument and reads nothing.
            let header_len = unsafe { libc::CMSG_LEN(0) } as usize;
            // SAFETY: `header` is a control header inside `control`; `CMSG_DATA`
            // offsets it by the fixed header size and dereferences nothing.
            let data = unsafe { libc::CMSG_DATA(header) };
            let available = (message.msg_control as usize + message.msg_controllen as usize)
                .saturating_sub(data as usize);
            let bytes = (record.cmsg_len as usize)
                .saturating_sub(header_len)
                .min(available);
            for index in 0..bytes / std::mem::size_of::<i32>() {
                // SAFETY: `index` counts whole `i32`s within `bytes`, which is
                // clamped to what the control extent holds past `data`, so the
                // element is inside `control`.
                let slot = unsafe { data.cast::<i32>().add(index) };
                // SAFETY: `slot` addresses four bytes the kernel wrote inside
                // `control`; the read is unaligned because a cmsg payload
                // promises no `i32` alignment.
                let fd = unsafe { slot.read_unaligned() };
                // SAFETY: an `SCM_RIGHTS` payload lists descriptors the kernel
                // installed in this process for this message. Nothing else
                // owns them, and each is adopted exactly once, here.
                descriptors.push(unsafe { OwnedFd::from_raw_fd(fd) });
            }
        }
        // SAFETY: `header` is the current header of `message`'s control extent;
        // `CMSG_NXTHDR` returns the next one inside that extent, or null.
        header = unsafe { libc::CMSG_NXTHDR(&message, header) };
    }
    for fd in &descriptors {
        // SAFETY: `fd` is an open descriptor `descriptors` owns; `F_SETFD` takes
        // an integer flag and no pointer.
        if unsafe { libc::fcntl(fd.as_raw_fd(), libc::F_SETFD, libc::FD_CLOEXEC) } == -1 {
            return Err(io::Error::last_os_error());
        }
    }
    if count != 1
        || marker != 1
        || message.msg_flags & libc::MSG_CTRUNC != 0
        || descriptors.len() != 1
    {
        return Err(io::Error::other("invalid descriptor handoff"));
    }
    descriptors
        .pop()
        .ok_or_else(|| io::Error::other("missing descriptor"))
}

pub(super) fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for &byte in bytes {
        output.push(char::from(DIGITS[usize::from(byte >> 4)]));
        output.push(char::from(DIGITS[usize::from(byte & 15)]));
    }
    output
}

fn token(bytes: &[u8]) -> Option<[u8; 32]> {
    if bytes.len() != 64 {
        return None;
    }
    let mut output = [0; 32];
    let digit = |byte| match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        _ => None,
    };
    for (byte, pair) in output.iter_mut().zip(bytes.chunks_exact(2)) {
        *byte = digit(pair[0])? << 4 | digit(pair[1])?;
    }
    Some(output)
}
