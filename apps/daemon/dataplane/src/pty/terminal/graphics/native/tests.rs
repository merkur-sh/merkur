use super::*;
use merkur_graphics::processing::DecodeRequest;
use std::io::{Read, Write};

async fn image(shared: &Shared) -> DecodedImage {
    let charge = Usage {
        bytes: 4 + OUTPUT_METADATA_BYTES,
        objects: 1,
    };
    let request = DecodeRequest {
        format: Format::Rgba,
        compressed: false,
        base64: false,
        width: 1,
        height: 1,
        inflated_bytes: 0,
    };
    let mut worker = Worker::launch(
        &shared.executable,
        request,
        Reservations {
            workspace: shared
                .processing
                .reserve(Usage {
                    bytes: WORKSPACE_BYTES,
                    objects: 1,
                })
                .unwrap(),
            output: shared.storage.reserve(charge).unwrap(),
        },
    )
    .await
    .unwrap();
    worker.push(&[3, 7, 11, 255], true).await.unwrap();
    worker.finish().await.unwrap()
}

fn broker(executable: PathBuf) -> (Broker, Endpoint) {
    Broker::start(
        Budget::new(Usage {
            bytes: super::super::STORAGE_BYTES,
            objects: 8192,
        }),
        Budget::new(Usage {
            bytes: WORKSPACE_BYTES,
            objects: 1,
        }),
        executable,
    )
    .unwrap()
}

#[tokio::test]
async fn wrong_terminal_credential_cannot_reach_descriptor_admission() {
    // A credential check launches nothing, so no helper needs to exist.
    let (broker, endpoint) = broker(PathBuf::from("/merkur-test-nonexistent-image-worker"));
    let mut stream = UnixStream::connect(&endpoint.path).await.unwrap();
    stream.write_all(&[0; 33]).await.unwrap();
    assert_eq!(stream.read(&mut [0]).await.unwrap(), 0);
    assert_eq!(
        broker.shared.processing.used(),
        Some(Usage {
            bytes: 0,
            objects: 0
        })
    );
    broker.shutdown().await;
}

fn send_rights(stream: i32, marker: u8, descriptors: &[i32]) {
    let mut control = vec![0usize; 512];
    let mut marker = marker;
    let mut iov = libc::iovec {
        iov_base: (&mut marker as *mut u8).cast(),
        iov_len: 1,
    };
    // SAFETY: `msghdr` holds only integers and raw pointers, for which all-zero
    // bytes are a valid value.
    let mut message: libc::msghdr = unsafe { std::mem::zeroed() };
    message.msg_iov = &mut iov;
    message.msg_iovlen = 1;
    message.msg_control = control.as_mut_ptr().cast();
    let bytes = std::mem::size_of_val(descriptors) as u32;
    // SAFETY: `CMSG_SPACE` is arithmetic on its argument and reads nothing.
    let space = unsafe { libc::CMSG_SPACE(bytes) };
    assert!(space as usize <= control.len() * std::mem::size_of::<usize>());
    message.msg_controllen = space as _;
    // SAFETY: `msg_control` points at `control`, a live `usize` vector that the
    // assertion above shows is at least `msg_controllen` bytes long.
    let header = unsafe { libc::CMSG_FIRSTHDR(&message) };
    assert!(!header.is_null());
    // SAFETY: `CMSG_LEN` is arithmetic on its argument and reads nothing.
    let length = unsafe { libc::CMSG_LEN(bytes) };
    // SAFETY: `header` is the non-null first header of `control`: aligned,
    // because `control` is a `usize` vector, initialized, because the vector
    // was zeroed, and reachable through nothing but this pointer while
    // `record` lives.
    let record = unsafe { &mut *header };
    record.cmsg_level = libc::SOL_SOCKET;
    record.cmsg_type = libc::SCM_RIGHTS;
    record.cmsg_len = length as _;
    // SAFETY: `header` is a control header inside `control`; `CMSG_DATA` offsets
    // it by the fixed header size and dereferences nothing.
    let data = unsafe { libc::CMSG_DATA(header) };
    // SAFETY: `CMSG_SPACE(bytes)` bytes of `control` hold the header and
    // `bytes` of payload, so `descriptors.len()` `i32`s fit at `data`; the
    // source is a live slice that cannot overlap the local `control`. The copy
    // is bytewise because the payload promises no `i32` alignment.
    unsafe {
        std::ptr::copy_nonoverlapping(descriptors.as_ptr().cast::<u8>(), data, bytes as usize);
    }
    // SAFETY: `message` names `marker` through `iov` and `control`, all live
    // until the call returns; the kernel duplicates the rights it is sent.
    let sent = unsafe { libc::sendmsg(stream, &message, 0) };
    assert_eq!(sent, 1);
}

#[test]
fn malformed_or_surplus_ancillary_messages_close_every_received_right() {
    for (marker, count) in [(0, 1), (1, 2), (1, 253)] {
        let (sender, receiver) = std::os::unix::net::UnixStream::pair().unwrap();
        let (mut observer, transferred) = std::os::unix::net::UnixStream::pair().unwrap();
        observer.set_nonblocking(true).unwrap();
        send_rights(
            sender.as_raw_fd(),
            marker,
            &vec![transferred.as_raw_fd(); count],
        );
        drop(transferred);
        assert!(receive_descriptor(receiver.as_raw_fd()).is_err());
        // EOF is an exact kernel proof that no received copy of the endpoint
        // survives. A leaked right would return WouldBlock here.
        assert_eq!(observer.read(&mut [0]).unwrap(), 0);
    }
}

/// Integrations that run the helper `bun run build:image-worker` builds; see
/// `graphics::tests::real_helper`.
mod real_helper {
    use super::super::super::Graphics;
    use super::*;

    #[tokio::test]
    #[ignore = "real helper: bun run build:image-worker"]
    async fn references_are_bounded_one_use_terminal_bound_and_reset_fenced() {
        let (broker, endpoint) = broker(Graphics::built_worker());
        let (other, _) = self::broker(Graphics::built_worker());
        let mut tokens = Vec::new();
        for _ in 0..SUBMISSIONS {
            let slot = Arc::clone(&broker.shared.slots)
                .try_acquire_owned()
                .unwrap();
            tokens.push(publish(&broker.shared, 0, image(&broker.shared).await, slot).unwrap());
        }
        assert!(
            Arc::clone(&broker.shared.slots)
                .try_acquire_owned()
                .is_err()
        );
        let encoded = hex(&tokens[0]);
        assert!(other.consume(encoded.as_bytes()).is_none());
        let mut forged = tokens[0];
        forged[31] ^= 1;
        assert!(broker.consume(hex(&forged).as_bytes()).is_none());
        assert!(broker.consume(encoded.as_bytes()).is_some());
        assert!(broker.consume(encoded.as_bytes()).is_none());
        let slot = Arc::clone(&broker.shared.slots)
            .try_acquire_owned()
            .unwrap();
        let next = publish(&broker.shared, 0, image(&broker.shared).await, slot).unwrap();
        assert!(!tokens.contains(&next));
        assert!(cancel(&broker.shared, &next));
        assert!(!cancel(&broker.shared, &next));
        let pending = Arc::clone(&broker.shared.slots)
            .try_acquire_owned()
            .unwrap();
        broker.reset();
        assert!(publish(&broker.shared, 0, image(&broker.shared).await, pending).is_none());
        for token in tokens {
            assert!(broker.consume(hex(&token).as_bytes()).is_none());
        }
        assert_eq!(broker.shared.slots.available_permits(), SUBMISSIONS);
        let mut idle = UnixStream::connect(&endpoint.path).await.unwrap();
        broker.shutdown().await;
        assert!(!endpoint.path.exists());
        assert!(matches!(idle.read(&mut [0]).await, Ok(0) | Err(_)));
        other.shutdown().await;
    }

    #[tokio::test]
    #[ignore = "real helper: bun run build:image-worker"]
    async fn native_descriptor_is_invisible_until_its_parser_boundary_and_cannot_replay() {
        let (tx, rx) = crossbeam_channel::unbounded();
        let mut terminal = crate::pty::TerminalState::new(80, 3, tx);
        terminal.use_built_image_worker();
        let endpoint = terminal.enable_native_graphics().unwrap();
        let mut stream = UnixStream::connect(&endpoint.path).await.unwrap();
        let credential = token(endpoint.credential.as_bytes()).unwrap();
        stream.write_all(&credential).await.unwrap();
        stream.write_all(&[1]).await.unwrap();
        let request = Request {
            decode: DecodeRequest {
                format: Format::Rgba,
                compressed: false,
                base64: false,
                width: 1,
                height: 1,
                inflated_bytes: 0,
            },
            offset: 0,
            length: 4,
        };
        stream.write_all(&request.encode()).await.unwrap();
        let file_path = endpoint.path.with_file_name("test-source");
        let mut file = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .open(&file_path)
            .unwrap();
        std::fs::remove_file(file_path).unwrap();
        file.write_all(&[3, 7, 11, 255]).unwrap();
        send_rights(stream.as_raw_fd(), 1, &[file.as_raw_fd()]);
        let mut reply = [0; 33];
        stream.read_exact(&mut reply).await.unwrap();
        assert_eq!(reply[0], 0);
        assert!(terminal.graphics.scene.is_empty());
        file.set_len(0).unwrap();
        let command = format!("before\x1b_Ga=t,t=n,i=901;{}\x1b\\after", hex(&reply[1..]));
        assert_eq!(terminal.apply_bytes(command.as_bytes()), command.len());
        assert!(!terminal.graphics_pending());
        let incarnation = terminal.graphics.scene.resolve_id(901).unwrap();
        assert_eq!(
            terminal
                .graphics
                .scene
                .image(incarnation)
                .unwrap()
                .content
                .decoded()
                .unwrap()
                .pixels()
                .rgba(),
            &[3, 7, 11, 255]
        );
        let replay = format!("\x1b_Ga=t,t=n,i=902;{}\x1b\\", hex(&reply[1..]));
        assert_eq!(terminal.apply_bytes(replay.as_bytes()), replay.len());
        assert!(terminal.graphics.scene.resolve_id(902).is_none());
        let replies: Vec<_> = rx
            .try_iter()
            .filter_map(|event| match event {
                crate::pty::TerminalEvent::PtyWrite(bytes) => Some(bytes),
                _ => None,
            })
            .collect();
        assert_eq!(
            replies,
            [
                b"\x1b_Gi=901;OK\x1b\\".to_vec(),
                b"\x1b_Gi=902;ENOENT:image or frame does not exist\x1b\\".to_vec()
            ]
        );
        terminal.shutdown_graphics().await;
    }
}
