//! Headless input belongs to the reactor, so an authorization close can retire it.

use std::io;
use std::os::fd::OwnedFd;

use rustix::fs::{FileType, OFlags, fcntl_getfl, fcntl_setfl, fstat};
use tokio::io::AsyncReadExt;
use tokio::io::unix::AsyncFd;

pub(super) enum HeadlessInput {
    /// A regular file is finite disk input, not a pipe waiting for its writer.
    File(tokio::fs::File),
    Evented(EventedInput),
}

pub(super) struct EventedInput {
    fd: AsyncFd<OwnedFd>,
    original_flags: OFlags,
}

impl HeadlessInput {
    pub(super) fn stdin() -> io::Result<Self> {
        Self::from_fd(rustix::io::dup(std::io::stdin())?)
    }

    fn from_fd(fd: OwnedFd) -> io::Result<Self> {
        if FileType::from_raw_mode(fstat(&fd)?.st_mode) == FileType::RegularFile {
            return Ok(Self::File(tokio::fs::File::from_std(fd.into())));
        }
        let original_flags = fcntl_getfl(&fd)?;
        let fd = AsyncFd::with_interest(fd, tokio::io::Interest::READABLE)?;
        fcntl_setfl(fd.get_ref(), original_flags | OFlags::NONBLOCK)?;
        Ok(Self::Evented(EventedInput { fd, original_flags }))
    }

    /// Cancelling a pipe read leaves no blocking task or retained input bytes.
    pub(super) async fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
        match self {
            Self::File(file) => file.read(bytes).await,
            Self::Evented(input) => loop {
                let mut ready = input.fd.readable().await?;
                match ready.try_io(|fd| Ok(rustix::io::read(fd, &mut *bytes)?)) {
                    Ok(Err(error)) if error.kind() == io::ErrorKind::Interrupted => {}
                    Ok(result) => return result,
                    Err(_would_block) => {}
                }
            },
        }
    }
}

impl Drop for EventedInput {
    fn drop(&mut self) {
        // dup shares file status flags with stdin. Retirement restores those
        // flags while the descriptor is still owned, before deregistering it.
        let _ = fcntl_setfl(self.fd.get_ref(), self.original_flags);
    }
}

#[cfg(test)]
mod tests;
