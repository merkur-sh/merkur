//! The Unix socket the application server reaches keyd on. The socket file's
//! mode and group are the only gate: whoever can open it is the server.

use std::fs;
use std::io::{self, Read, Write};
use std::os::unix::fs::{FileTypeExt, PermissionsExt};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use crate::ops::Service;
use crate::wire::MAX_FRAME_BYTES;

/// Resource bound: the server holds one connection; a few more cover a restart
/// that overlaps the old one's close.
const MAX_CONNECTIONS: usize = 8;
/// ML-DSA-87 signing in libcrux keeps its working arrays on the stack.
const CONNECTION_STACK_BYTES: usize = 2 << 20;

pub fn serve(service: Arc<Service>, socket: &Path) -> io::Result<()> {
    match fs::symlink_metadata(socket) {
        Ok(metadata) if metadata.file_type().is_socket() => fs::remove_file(socket)?,
        Ok(_) => {
            return Err(io::Error::new(
                io::ErrorKind::AlreadyExists,
                "the socket path holds something that is not a socket",
            ));
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }
    let listener = UnixListener::bind(socket)?;
    fs::set_permissions(socket, fs::Permissions::from_mode(0o660))?;
    tracing::info!(socket = %socket.display(), "listening");
    // The readiness signal its supervisors wait for: the only line keyd writes to stdout.
    let mut stdout = io::stdout().lock();
    writeln!(stdout, "keyd: listening")?;
    stdout.flush()?;
    drop(stdout);
    let open = Arc::new(AtomicUsize::new(0));
    for stream in listener.incoming() {
        let stream = match stream {
            Ok(stream) => stream,
            Err(error) => {
                tracing::warn!(%error, "keyd: accept failed");
                continue;
            }
        };
        if open.fetch_add(1, Ordering::AcqRel) >= MAX_CONNECTIONS {
            open.fetch_sub(1, Ordering::AcqRel);
            tracing::warn!("keyd: connection refused at the bound");
            continue;
        }
        let service = Arc::clone(&service);
        let held = Arc::clone(&open);
        let spawned = std::thread::Builder::new()
            .name("keyd-connection".into())
            .stack_size(CONNECTION_STACK_BYTES)
            .spawn(move || {
                if let Err(error) = connection(&service, stream) {
                    tracing::debug!(%error, "keyd: connection ended");
                }
                held.fetch_sub(1, Ordering::AcqRel);
            });
        if let Err(error) = spawned {
            open.fetch_sub(1, Ordering::AcqRel);
            tracing::warn!(%error, "keyd: connection thread failed to start");
        }
    }
    Ok(())
}

/// Answers each request in order until the peer closes or sends a frame
/// longer than any request: past that the stream cannot be read in step.
fn connection(service: &Service, mut stream: UnixStream) -> io::Result<()> {
    let mut body = Vec::with_capacity(MAX_FRAME_BYTES);
    loop {
        let mut length = [0u8; 4];
        match stream.read_exact(&mut length) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => return Ok(()),
            Err(error) => return Err(error),
        }
        let length = usize::try_from(u32::from_le_bytes(length)).unwrap_or(usize::MAX);
        if length == 0 || length > MAX_FRAME_BYTES {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "frame length out of bounds",
            ));
        }
        body.resize(length, 0);
        stream.read_exact(&mut body)?;
        let response = service.handle(&body);
        body.fill(0);
        stream.write_all(&response)?;
    }
}
