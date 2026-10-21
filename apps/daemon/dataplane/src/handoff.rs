//! The dataplane handoff: how one release's dataplane passes its terminal to the next across
//! `execve` at an upgrade, so the shell and everything it runs survive.
//!
//! This is one of the frozen cross-release contracts (docs/releases.md, Convergence): the
//! previous release writes it and this release reads it, so its shape never changes. The
//! environment names one descriptor, [`HANDOFF_FD_ENV`], of an unlinked file holding a
//! single JSON [`Header`] line and then the terminal's replay bytes to the end of the file.
//! The header names the other inherited descriptors by number. Everything else the new
//! process needs comes from its own owner, over the socket it accepts, in the same release.
//!
//! The pid does not change, so the shell stays this process's child and the Bun owner stays
//! its parent: only the parent may connect as the new owner.

use std::fs::File;
use std::io::{self, Read, Seek, Write};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::os::unix::fs::OpenOptionsExt;
use std::os::unix::net::{UnixListener, UnixStream};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

/// The environment variable naming the handoff file's descriptor.
pub const HANDOFF_FD_ENV: &str = "MERKUR_DATAPLANE_HANDOFF_FD";

/// The frozen header. Field names, types and meaning never change.
#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Header {
    /// The PTY master.
    pub pty_fd: RawFd,
    /// The shell, this process's child.
    pub child_pid: u32,
    /// The terminal's size, which the replay is laid out for.
    pub cols: u16,
    pub rows: u16,
    /// A listening socket on which the parent connects as the new owner.
    pub owner_listener_fd: RawFd,
    /// The native image broker's listening socket, its path and its credential as hex: the
    /// shell's `MERKUR_IMAGE_SOCKET` and `MERKUR_IMAGE_CREDENTIAL` name these.
    pub image_listener_fd: RawFd,
    pub image_path: String,
    pub image_credential: String,
}

/// What the new process takes over.
pub struct Adoption {
    pub pty: OwnedFd,
    pub child_pid: u32,
    pub cols: u16,
    pub rows: u16,
    pub image: crate::pty::terminal::NativeHandover,
    pub replay: Vec<u8>,
}

/// What this process hands over at an upgrade.
pub struct Outgoing<'a> {
    pub socket_path: &'a Path,
    pub pty_fd: RawFd,
    pub child_pid: u32,
    pub cols: u16,
    pub rows: u16,
    pub image: crate::pty::terminal::NativeHandover,
    pub replay: &'a [u8],
}

pub fn encode(header: &Header, replay: &[u8]) -> io::Result<Vec<u8>> {
    let mut bytes = serde_json::to_vec(header).map_err(io::Error::other)?;
    bytes.push(b'\n');
    bytes.extend_from_slice(replay);
    Ok(bytes)
}

pub fn decode(bytes: &[u8]) -> io::Result<(Header, &[u8])> {
    let end = bytes
        .iter()
        .position(|&byte| byte == b'\n')
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "handoff header unterminated"))?;
    let header = serde_json::from_slice(&bytes[..end])
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
    Ok((header, &bytes[end + 1..]))
}

/// Checks an upgrade's paths and binds the socket the parent will connect to as the new
/// owner. Done before the owner loop ends, so a refused upgrade leaves this process serving;
/// and before the upgrade is acknowledged, so the parent can connect the moment it has
/// replaced itself: until the successor accepts, the connection waits in the backlog.
pub fn prepare(executable: &Path, socket_path: &Path) -> io::Result<UnixListener> {
    use std::os::unix::fs::PermissionsExt;
    if !executable.is_absolute() || !socket_path.is_absolute() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "upgrade paths must be absolute",
        ));
    }
    let metadata = std::fs::metadata(executable)?;
    if !metadata.is_file() || metadata.permissions().mode() & 0o111 == 0 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "upgrade target is not executable",
        ));
    }
    UnixListener::bind(socket_path)
}

/// The handoff written and its descriptors marked to survive `execve`.
pub struct Staged {
    file: File,
    fds: [RawFd; 3],
    _image: crate::pty::terminal::NativeHandover,
}

/// Writes the handoff and marks every descriptor it names to survive `execve`.
pub fn stage(outgoing: Outgoing<'_>, owner_listener: &UnixListener) -> io::Result<Staged> {
    let header = Header {
        pty_fd: outgoing.pty_fd,
        child_pid: outgoing.child_pid,
        cols: outgoing.cols,
        rows: outgoing.rows,
        owner_listener_fd: owner_listener.as_raw_fd(),
        image_listener_fd: outgoing.image.listener.as_raw_fd(),
        image_path: outgoing.image.path.to_string_lossy().into_owned(),
        image_credential: hex(outgoing.image.credential.as_ref()),
    };
    let bytes = Zeroizing::new(encode(&header, outgoing.replay)?);
    let directory = outgoing
        .socket_path
        .parent()
        .ok_or_else(|| io::Error::other("owner socket path has no directory"))?;
    let mut file = unlinked_file(directory)?;
    file.write_all(&bytes)?;
    file.rewind()?;
    let fds = [
        header.pty_fd,
        header.owner_listener_fd,
        header.image_listener_fd,
    ];
    for fd in fds.into_iter().chain([file.as_raw_fd()]) {
        inherit(fd)?;
    }
    Ok(Staged {
        file,
        fds,
        _image: outgoing.image,
    })
}

impl Staged {
    /// Replaces this process with `executable`. Returns only if `execve` fails; the
    /// descriptors are then this process's again, and it ends as a crash would.
    pub fn exec(self, executable: &Path) -> io::Error {
        let error = std::process::Command::new(executable)
            .env(HANDOFF_FD_ENV, self.file.as_raw_fd().to_string())
            .exec();
        for fd in self.fds {
            let _ = close_on_exec(fd);
        }
        error
    }
}

/// An owner-only file nobody can open by name: created exclusively in the owner's private
/// directory and unlinked at once.
fn unlinked_file(directory: &Path) -> io::Result<File> {
    let path = directory.join(format!("handoff-{}", std::process::id()));
    let file = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&path)?;
    std::fs::remove_file(&path)?;
    Ok(file)
}

fn inherit(fd: RawFd) -> io::Result<()> {
    // SAFETY: `F_SETFD` takes an integer flag word and no pointer.
    if unsafe { libc::fcntl(fd, libc::F_SETFD, 0) } == -1 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

fn close_on_exec(fd: RawFd) -> io::Result<()> {
    // SAFETY: `F_SETFD` takes an integer flag word and no pointer.
    if unsafe { libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC) } == -1 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

/// Reads the handoff this process was started with, if it was.
pub fn incoming() -> io::Result<Option<(Adoption, UnixListener)>> {
    let Ok(text) = std::env::var(HANDOFF_FD_ENV) else {
        return Ok(None);
    };
    let fd: RawFd = text
        .parse()
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "handoff descriptor"))?;
    // SAFETY: the predecessor passed this descriptor open across `execve` for this process
    // alone; nothing else in this process knows its number.
    let mut file = unsafe { File::from_raw_fd(fd) };
    close_on_exec(fd)?;
    let mut bytes = Zeroizing::new(Vec::new());
    file.read_to_end(&mut bytes)?;
    drop(file);
    let (header, replay) = decode(&bytes)?;
    let credential = decode_credential(&header.image_credential)?;
    for fd in [
        header.pty_fd,
        header.owner_listener_fd,
        header.image_listener_fd,
    ] {
        close_on_exec(fd)?;
    }
    // SAFETY: each of these three descriptors was passed open across `execve` and named only
    // in the header, and each is taken here exactly once.
    let pty = unsafe { OwnedFd::from_raw_fd(header.pty_fd) };
    // SAFETY: as above.
    let owner = unsafe { UnixListener::from_raw_fd(header.owner_listener_fd) };
    // SAFETY: as above.
    let image = unsafe { OwnedFd::from_raw_fd(header.image_listener_fd) };
    Ok(Some((
        Adoption {
            pty,
            child_pid: header.child_pid,
            cols: header.cols,
            rows: header.rows,
            image: crate::pty::terminal::NativeHandover {
                listener: image,
                path: PathBuf::from(header.image_path),
                credential,
            },
            replay: replay.to_vec(),
        },
        owner,
    )))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn decode_credential(text: &str) -> io::Result<Zeroizing<[u8; 32]>> {
    let invalid = || io::Error::new(io::ErrorKind::InvalidData, "image credential");
    let bytes = text.as_bytes();
    if bytes.len() != 64 {
        return Err(invalid());
    }
    let mut credential = Zeroizing::new([0u8; 32]);
    for (index, [high, low]) in bytes.as_chunks::<2>().0.iter().enumerate() {
        let digit = |byte: u8| char::from(byte).to_digit(16).ok_or_else(invalid);
        credential[index] =
            u8::try_from(digit(*high)? * 16 + digit(*low)?).map_err(|_| invalid())?;
    }
    Ok(credential)
}

/// Accepts the new owner: a connection from this process's parent, the Bun owner, which
/// keeps its pid across its own `execve`. Any other peer is refused and the wait goes on.
/// Returns `None` once the parent is gone, which no longer leaves anyone to connect.
pub fn accept_owner(listener: &UnixListener) -> io::Result<Option<UnixStream>> {
    // SAFETY: `getppid` takes no pointer and cannot fail.
    let parent = unsafe { libc::getppid() };
    if parent == 1 {
        return Ok(None);
    }
    let parent_exit = ParentExit::watch(parent)?;
    loop {
        if !parent_exit.wait_readable(listener.as_raw_fd())? {
            return Ok(None);
        }
        let (stream, _) = match listener.accept() {
            Ok(accepted) => accepted,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(error),
        };
        if peer_pid(&stream)? == parent {
            stream.set_nonblocking(false)?;
            return Ok(Some(stream));
        }
    }
}

#[cfg(target_os = "linux")]
fn peer_pid(stream: &UnixStream) -> io::Result<libc::pid_t> {
    let mut credentials = std::mem::MaybeUninit::<libc::ucred>::uninit();
    let mut length = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
    // SAFETY: `SO_PEERCRED` writes one `ucred` and its length through the pointers, both
    // live slots of those types on this frame.
    let result = unsafe {
        libc::getsockopt(
            stream.as_raw_fd(),
            libc::SOL_SOCKET,
            libc::SO_PEERCRED,
            credentials.as_mut_ptr().cast(),
            &mut length,
        )
    };
    if result == -1 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: the call succeeded, so it filled the structure.
    Ok(unsafe { credentials.assume_init() }.pid)
}

#[cfg(target_os = "macos")]
fn peer_pid(stream: &UnixStream) -> io::Result<libc::pid_t> {
    let mut pid: libc::pid_t = 0;
    let mut length = std::mem::size_of::<libc::pid_t>() as libc::socklen_t;
    // SAFETY: `LOCAL_PEERPID` writes one `pid_t` and its length through the pointers, both
    // live locals.
    let result = unsafe {
        libc::getsockopt(
            stream.as_raw_fd(),
            libc::SOL_LOCAL,
            libc::LOCAL_PEERPID,
            (&raw mut pid).cast(),
            &mut length,
        )
    };
    if result == -1 {
        return Err(io::Error::last_os_error());
    }
    Ok(pid)
}

/// The parent's exit as a pollable event: a pidfd on Linux, a kqueue process filter on macOS.
struct ParentExit(OwnedFd);

impl ParentExit {
    #[cfg(target_os = "linux")]
    fn watch(parent: libc::pid_t) -> io::Result<Self> {
        // SAFETY: `pidfd_open` takes a pid and flags and returns a new descriptor or -1.
        let fd = unsafe { libc::syscall(libc::SYS_pidfd_open, parent, 0) };
        if fd == -1 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: the syscall returned a new descriptor this process owns.
        Ok(Self(unsafe { OwnedFd::from_raw_fd(fd as RawFd) }))
    }

    /// Blocks until `listener` is readable (`true`) or the parent has exited (`false`).
    #[cfg(target_os = "linux")]
    fn wait_readable(&self, listener: RawFd) -> io::Result<bool> {
        let mut fds = [
            libc::pollfd {
                fd: listener,
                events: libc::POLLIN,
                revents: 0,
            },
            libc::pollfd {
                fd: self.0.as_raw_fd(),
                events: libc::POLLIN,
                revents: 0,
            },
        ];
        loop {
            // SAFETY: `fds` is a live array of two `pollfd`s; -1 waits for an event.
            let result = unsafe { libc::poll(fds.as_mut_ptr(), 2, -1) };
            if result == -1 {
                let error = io::Error::last_os_error();
                if error.kind() == io::ErrorKind::Interrupted {
                    continue;
                }
                return Err(error);
            }
            if fds[1].revents != 0 {
                return Ok(false);
            }
            if fds[0].revents != 0 {
                return Ok(true);
            }
        }
    }

    #[cfg(target_os = "macos")]
    fn watch(parent: libc::pid_t) -> io::Result<Self> {
        // SAFETY: `kqueue` takes no argument and returns a new descriptor or -1.
        let queue = unsafe { libc::kqueue() };
        if queue == -1 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: `kqueue` returned a new descriptor this process owns.
        let queue = unsafe { OwnedFd::from_raw_fd(queue) };
        let change = libc::kevent {
            ident: parent as libc::uintptr_t,
            filter: libc::EVFILT_PROC,
            flags: libc::EV_ADD | libc::EV_ONESHOT,
            fflags: libc::NOTE_EXIT,
            data: 0,
            udata: std::ptr::null_mut(),
        };
        // SAFETY: one live `kevent` change, no event buffer, no timeout.
        let result = unsafe {
            libc::kevent(
                queue.as_raw_fd(),
                &change,
                1,
                std::ptr::null_mut(),
                0,
                std::ptr::null(),
            )
        };
        if result == -1 {
            return Err(io::Error::last_os_error());
        }
        Ok(Self(queue))
    }

    #[cfg(target_os = "macos")]
    fn wait_readable(&self, listener: RawFd) -> io::Result<bool> {
        let change = libc::kevent {
            ident: listener as libc::uintptr_t,
            filter: libc::EVFILT_READ,
            flags: libc::EV_ADD | libc::EV_ONESHOT,
            fflags: 0,
            data: 0,
            udata: std::ptr::null_mut(),
        };
        let mut event = std::mem::MaybeUninit::<libc::kevent>::uninit();
        loop {
            // SAFETY: one live change and room for one event; no timeout.
            let result = unsafe {
                libc::kevent(
                    self.0.as_raw_fd(),
                    &change,
                    1,
                    event.as_mut_ptr(),
                    1,
                    std::ptr::null(),
                )
            };
            if result == -1 {
                let error = io::Error::last_os_error();
                if error.kind() == io::ErrorKind::Interrupted {
                    continue;
                }
                return Err(error);
            }
            if result == 0 {
                continue;
            }
            // SAFETY: `kevent` reported one event, which it wrote.
            let event = unsafe { event.assume_init() };
            return Ok(event.filter != libc::EVFILT_PROC);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The frozen header as the previous release writes it. Never edit this: a release that
    /// cannot read it cannot take over from its predecessor.
    const FROZEN: &str = concat!(
        r#"{"pty_fd":7,"child_pid":4242,"cols":120,"rows":40,"owner_listener_fd":9,"#,
        r#""image_listener_fd":8,"image_path":"/tmp/merkur-image-00/socket","#,
        r#""image_credential":"000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"}"#,
    );

    #[test]
    fn the_frozen_header_still_reads_and_writes_byte_for_byte() {
        let mut bytes = FROZEN.as_bytes().to_vec();
        bytes.push(b'\n');
        bytes.extend_from_slice(b"\x1b[0mreplay\n\x00bytes");
        let (header, replay) = decode(&bytes).expect("frozen header");
        assert_eq!(replay, b"\x1b[0mreplay\n\x00bytes");
        assert_eq!(header.child_pid, 4242);
        assert_eq!(encode(&header, replay).expect("encode"), bytes);
        let credential = decode_credential(&header.image_credential).expect("credential");
        assert_eq!(credential[31], 0x1f);
    }

    #[test]
    fn a_header_with_any_other_shape_is_refused() {
        assert!(decode(b"{\"pty_fd\":7}\nrest").is_err());
        let mut surplus = FROZEN
            .replace("\"rows\":40", "\"rows\":40,\"extra\":1")
            .into_bytes();
        surplus.push(b'\n');
        assert!(decode(&surplus).is_err());
        assert!(decode(FROZEN.as_bytes()).is_err(), "an unterminated header");
        assert!(decode_credential("zz").is_err());
    }

    #[test]
    fn only_the_parent_is_accepted_as_owner() {
        let directory = std::env::temp_dir().join(format!("merkur-handoff-{}", std::process::id()));
        std::fs::create_dir_all(&directory).expect("directory");
        let path = directory.join("owner.sock");
        let _ = std::fs::remove_file(&path);
        let listener = UnixListener::bind(&path).expect("bind");
        // This test process is not its own parent, so a connection from it is refused and
        // the wait would go on: prove the refusal by checking the peer directly.
        let client = UnixStream::connect(&path).expect("connect");
        let (accepted, _) = listener.accept().expect("accept");
        // SAFETY: `getpid` takes no pointer.
        let own = unsafe { libc::getpid() };
        // SAFETY: `getppid` takes no pointer.
        let parent = unsafe { libc::getppid() };
        assert_eq!(peer_pid(&accepted).expect("peer pid"), own);
        assert_ne!(own, parent);
        drop(client);
        let _ = std::fs::remove_file(&path);
    }
}
