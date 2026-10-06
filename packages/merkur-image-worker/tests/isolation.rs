#[path = "../src/sandbox.rs"]
mod sandbox;

use base64::Engine;
use merkur_graphics::budget::{Budget, Usage};
use merkur_graphics::command::Format;
use merkur_graphics::command::{Chunk, Control, Received};
use merkur_graphics::ingest::{Ingest, Step};
use merkur_graphics::processing::{DecodeRequest, FINAL_CHUNK, WORKER_READY};
use merkur_graphics::publication::{Fence, ImageIncarnation, TerminalIncarnation};
use merkur_image_worker::upload::{PushError, QUEUE_BYTES, QUEUE_CHUNKS, Upload};
use merkur_image_worker::{OUTPUT_METADATA_BYTES, Reservations, WORKSPACE_BYTES, Worker};
use std::sync::Arc;
use tokio::sync::Notify;

#[tokio::test]
async fn all_inline_formats_decode_inside_the_actual_sandbox() {
    let mut png = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut png, 1, 1);
        encoder.set_color(png::ColorType::Rgba);
        let mut writer = encoder.write_header().unwrap();
        writer.write_image_data(&[5, 7, 9, 255]).unwrap();
    }
    for format in [Format::Rgb, Format::Rgba, Format::Png] {
        for compressed in [false, true] {
            let bytes = match format {
                Format::Rgb => vec![5, 7, 9],
                Format::Rgba => vec![5, 7, 9, 255],
                Format::Png => png.clone(),
            };
            let inflated_bytes = bytes.len() as u32;
            let bytes = if compressed {
                let mut encoder =
                    flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::fast());
                encoder.write_all(&bytes).unwrap();
                encoder.finish().unwrap()
            } else {
                bytes
            };
            let encoded = base64::prelude::BASE64_STANDARD.encode(bytes);
            let output_bytes = if format == Format::Png {
                merkur_graphics::processing::MAX_RGBA_BYTES
            } else {
                4
            };
            let jobs = Budget::new(Usage {
                bytes: WORKSPACE_BYTES,
                objects: 1,
            });
            let storage = Budget::new(Usage {
                bytes: output_bytes + OUTPUT_METADATA_BYTES,
                objects: 1,
            });
            let mut worker = Worker::launch(
                &std::fs::canonicalize(env!("CARGO_BIN_EXE_merkur-image-worker")).unwrap(),
                DecodeRequest {
                    format,
                    compressed,
                    base64: true,
                    width: 1,
                    height: 1,
                    inflated_bytes,
                },
                Reservations {
                    workspace: jobs
                        .reserve(Usage {
                            bytes: WORKSPACE_BYTES,
                            objects: 1,
                        })
                        .unwrap(),
                    output: storage
                        .reserve(Usage {
                            bytes: output_bytes + OUTPUT_METADATA_BYTES,
                            objects: 1,
                        })
                        .unwrap(),
                },
            )
            .await
            .unwrap();
            worker.push(encoded.as_bytes(), true).await.unwrap();
            let image = worker.finish().await.unwrap();
            assert_eq!(
                *image.source(),
                merkur_graphics::source::SourceManifest::from_pixels(image.pixels()),
                "{format:?}, compressed={compressed}"
            );
            assert_eq!(
                image.pixels().rgba(),
                &[5, 7, 9, 255],
                "{format:?}, compressed={compressed}"
            );
        }
    }
}

fn fence() -> Fence {
    let mut ingest = Ingest::new(4096);
    let Step::Data { id, .. } = ingest.accept(Received::Chunk(Chunk {
        control: Control::parse(b"s=1,v=1").unwrap(),
        payload: b"AAAAAA==",
    })) else {
        panic!("data command")
    };
    Fence {
        terminal: TerminalIncarnation([1; 16]),
        command: id,
        image: ImageIncarnation(std::num::NonZeroU64::new(1).unwrap()),
        predecessor: None,
    }
}

#[tokio::test]
async fn bounded_upload_backpressures_and_wakes_without_losing_a_chunk() {
    let jobs = Budget::new(Usage {
        bytes: WORKSPACE_BYTES,
        objects: 1,
    });
    let output_bytes = (QUEUE_CHUNKS + 1) * 4;
    let storage = Budget::new(Usage {
        bytes: output_bytes + OUTPUT_METADATA_BYTES,
        objects: 1,
    });
    let queue = Budget::new(Usage {
        bytes: QUEUE_BYTES,
        objects: QUEUE_CHUNKS + 1,
    });
    let wake = Arc::new(Notify::new());
    let mut upload = Upload::start(
        std::fs::canonicalize(env!("CARGO_BIN_EXE_merkur-image-worker")).unwrap(),
        DecodeRequest {
            format: Format::Rgb,
            compressed: false,
            base64: true,
            width: (QUEUE_CHUNKS + 1) as u32,
            height: 1,
            inflated_bytes: 0,
        },
        Reservations {
            workspace: jobs
                .reserve(Usage {
                    bytes: WORKSPACE_BYTES,
                    objects: 1,
                })
                .unwrap(),
            output: storage
                .reserve(Usage {
                    bytes: output_bytes + OUTPUT_METADATA_BYTES,
                    objects: 1,
                })
                .unwrap(),
        },
        queue
            .reserve(Usage {
                bytes: QUEUE_BYTES,
                objects: QUEUE_CHUNKS + 1,
            })
            .unwrap(),
        fence(),
        Arc::clone(&wake),
    )
    .unwrap();
    // A current-thread runtime has not polled the receiver yet: this proves the
    // exact admission bound without sleeps or a scheduler race.
    for _ in 0..QUEUE_CHUNKS {
        upload.try_push(b"BQcJ", false).unwrap();
    }
    assert_eq!(upload.try_push(b"BQcJ", true), Err(PushError::Full));
    loop {
        wake.notified().await;
        match upload.try_push(b"BQcJ", true) {
            Ok(()) => break,
            Err(PushError::Full) => continue,
            error => panic!("unexpected admission: {error:?}"),
        }
    }
    let completion = loop {
        if let Some(completion) = upload.try_completion().unwrap() {
            break completion;
        }
        wake.notified().await;
    };
    assert_eq!(completion.fence, fence());
    let image = completion.result.unwrap();
    assert_eq!(
        image.pixels().rgba(),
        [5, 7, 9, 255].repeat(QUEUE_CHUNKS + 1)
    );
    upload.cancel().await.unwrap();
    assert_eq!(
        queue.used(),
        Some(Usage {
            bytes: 0,
            objects: 0
        })
    );
    assert_eq!(
        jobs.used(),
        Some(Usage {
            bytes: 0,
            objects: 0
        })
    );
    drop(image);
    merkur_image_worker::retirement::drain();
    assert_eq!(
        storage.used(),
        Some(Usage {
            bytes: 0,
            objects: 0
        })
    );
}

#[tokio::test]
async fn cancelling_a_queued_upload_joins_cleanup_and_returns_all_reservations() {
    let jobs = Budget::new(Usage {
        bytes: WORKSPACE_BYTES,
        objects: 1,
    });
    let storage = Budget::new(Usage {
        bytes: 4 + OUTPUT_METADATA_BYTES,
        objects: 1,
    });
    let queue = Budget::new(Usage {
        bytes: QUEUE_BYTES,
        objects: QUEUE_CHUNKS + 1,
    });
    let mut upload = Upload::start(
        std::fs::canonicalize(env!("CARGO_BIN_EXE_merkur-image-worker")).unwrap(),
        DecodeRequest {
            format: Format::Rgb,
            compressed: false,
            base64: true,
            width: 1,
            height: 1,
            inflated_bytes: 0,
        },
        Reservations {
            workspace: jobs
                .reserve(Usage {
                    bytes: WORKSPACE_BYTES,
                    objects: 1,
                })
                .unwrap(),
            output: storage
                .reserve(Usage {
                    bytes: 4 + OUTPUT_METADATA_BYTES,
                    objects: 1,
                })
                .unwrap(),
        },
        queue
            .reserve(Usage {
                bytes: QUEUE_BYTES,
                objects: QUEUE_CHUNKS + 1,
            })
            .unwrap(),
        fence(),
        Arc::new(Notify::new()),
    )
    .unwrap();
    upload.try_push(b"BQcJ", false).unwrap();
    upload.cancel().await.unwrap();
    for budget in [&jobs, &storage, &queue] {
        assert_eq!(
            budget.used(),
            Some(Usage {
                bytes: 0,
                objects: 0
            })
        );
    }
}
use std::io::{Read, Write};
use std::process::{Command, Stdio};

#[tokio::test]
async fn supervisor_keeps_pixel_storage_charged_until_last_owner_releases_it() {
    let jobs = Budget::new(Usage {
        bytes: WORKSPACE_BYTES,
        objects: 1,
    });
    let storage = Budget::new(Usage {
        bytes: 4 + OUTPUT_METADATA_BYTES,
        objects: 1,
    });
    let reservations = Reservations {
        workspace: jobs
            .reserve(Usage {
                bytes: WORKSPACE_BYTES,
                objects: 1,
            })
            .unwrap(),
        output: storage
            .reserve(Usage {
                bytes: 4 + OUTPUT_METADATA_BYTES,
                objects: 1,
            })
            .unwrap(),
    };
    let mut worker = Worker::launch(
        &std::fs::canonicalize(env!("CARGO_BIN_EXE_merkur-image-worker")).unwrap(),
        DecodeRequest {
            format: Format::Rgb,
            compressed: false,
            base64: true,
            width: 1,
            height: 1,
            inflated_bytes: 0,
        },
        reservations,
    )
    .await
    .unwrap();
    worker.push(b"BQcJ", true).await.unwrap();
    let image = worker.finish().await.unwrap();
    assert_eq!(image.pixels().rgba(), &[5, 7, 9, 255]);
    assert_eq!(
        jobs.used(),
        Some(Usage {
            bytes: 0,
            objects: 0
        })
    );
    assert_eq!(
        storage.used(),
        Some(Usage {
            bytes: 4 + OUTPUT_METADATA_BYTES,
            objects: 1
        })
    );
    drop(image);
    merkur_image_worker::retirement::drain();
    assert_eq!(
        storage.used(),
        Some(Usage {
            bytes: 0,
            objects: 0
        })
    );
}

#[tokio::test]
async fn explicit_cancellation_reaps_before_refunding_process_budget() {
    let jobs = Budget::new(Usage {
        bytes: WORKSPACE_BYTES,
        objects: 1,
    });
    let storage = Budget::new(Usage {
        bytes: 4 + OUTPUT_METADATA_BYTES,
        objects: 1,
    });
    let reservations = Reservations {
        workspace: jobs
            .reserve(Usage {
                bytes: WORKSPACE_BYTES,
                objects: 1,
            })
            .unwrap(),
        output: storage
            .reserve(Usage {
                bytes: 4 + OUTPUT_METADATA_BYTES,
                objects: 1,
            })
            .unwrap(),
    };
    let worker = Worker::launch(
        &std::fs::canonicalize(env!("CARGO_BIN_EXE_merkur-image-worker")).unwrap(),
        DecodeRequest {
            format: Format::Rgb,
            compressed: false,
            base64: true,
            width: 1,
            height: 1,
            inflated_bytes: 0,
        },
        reservations,
    )
    .await
    .unwrap();
    assert!(
        jobs.reserve(Usage {
            bytes: 1,
            objects: 1
        })
        .is_none()
    );
    worker.cancel().await;
    assert_eq!(
        jobs.used(),
        Some(Usage {
            bytes: 0,
            objects: 0
        })
    );
    assert_eq!(
        storage.used(),
        Some(Usage {
            bytes: 0,
            objects: 0
        })
    );
}

#[test]
fn real_executable_confines_before_accepting_pixels() {
    let mut child = Command::new(env!("CARGO_BIN_EXE_merkur-image-worker"))
        .env_clear()
        .env("MallocNanoZone", "0")
        .env("MallocMaxMagazines", "1")
        .env("MallocMaxMediumMagazines", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let mut input = child.stdin.take().unwrap();
    let mut output = child.stdout.take().unwrap();
    let mut ready = [0; 4];
    output.read_exact(&mut ready).unwrap();
    assert_eq!(ready, WORKER_READY);
    input
        .write_all(
            &DecodeRequest {
                format: Format::Rgb,
                compressed: false,
                base64: true,
                width: 1,
                height: 1,
                inflated_bytes: 0,
            }
            .encode(),
        )
        .unwrap();
    input.write_all(&(FINAL_CHUNK | 4).to_le_bytes()).unwrap();
    input.write_all(b"BQcJ").unwrap();
    drop(input);
    let mut result = Vec::new();
    output.read_to_end(&mut result).unwrap();
    assert!(child.wait().unwrap().success());
    assert_eq!(
        result,
        [0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 4, 0, 0, 0, 5, 7, 9, 255]
    );
}

#[test]
fn operating_system_denies_ambient_authority() {
    let output = Command::new(std::env::current_exe().unwrap())
        .env_clear()
        .env("MallocNanoZone", "0")
        .env("MallocMaxMagazines", "1")
        .env("MallocMaxMediumMagazines", "1")
        .env("MERKUR_SANDBOX_TEST_CHILD", "1")
        .args([
            "--exact",
            "confinement_child",
            "--test-threads=1",
            "--nocapture",
        ])
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "sandbox denial probe: {}\n{}\n{}",
        output.status,
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn confinement_child() {
    if std::env::var_os("MERKUR_SANDBOX_TEST_CHILD").is_none() {
        return;
    }
    // This subprocess is solely a denial oracle. No test harness threads or
    // output are used after confinement, and no child assertion can be skipped.
    // Allocate two private pages while authority still exists. Testing changes
    // to valid mappings distinguishes policy denial from an invalid argument.
    // SAFETY: sysconf has no pointer arguments.
    let page_size = unsafe { libc::sysconf(libc::_SC_PAGESIZE) } as usize;
    // SAFETY: an anonymous private mapping at an address the kernel chooses; no
    // existing memory is named, so nothing this process holds can be affected.
    let memory = unsafe {
        libc::mmap(
            std::ptr::null_mut(),
            page_size * 2,
            libc::PROT_READ,
            libc::MAP_PRIVATE | libc::MAP_ANON,
            -1,
            0,
        )
    };
    assert_ne!(memory, libc::MAP_FAILED);
    if let Err(error) = sandbox::enter() {
        eprintln!("sandbox startup: {error}");
        std::process::exit(20);
    }
    /// Ends the oracle with its verdict.
    fn exit(code: i32) -> ! {
        // SAFETY: `_exit` takes an integer and ends the process without running
        // destructors or exit handlers, which a confined oracle must not need.
        unsafe { libc::_exit(code) }
    }
    // Every call below must be denied. Each takes integers, or pointers to
    // live locals it could write only if the denial under test failed, so a
    // call that is refused changes nothing in this process.
    #[cfg(target_os = "macos")]
    {
        unsafe extern "C" {
            fn mach_vm_allocate(task: u32, address: *mut u64, size: u64, flags: i32) -> i32;
            fn mach_vm_deallocate(task: u32, address: u64, size: u64) -> i32;
            fn mach_vm_protect(
                task: u32,
                address: u64,
                size: u64,
                maximum: i32,
                protection: i32,
            ) -> i32;
            fn mach_port_allocate(task: u32, right: i32, port: *mut u32) -> i32;
        }
        #[expect(
            deprecated,
            reason = "libc prefers a Mach wrapper crate; this denial oracle needs only the \
                      stable C ABI"
        )]
        // SAFETY: `mach_task_self` takes no argument and returns this task's
        // own port name by value.
        let task = unsafe { libc::mach_task_self() };
        // SAFETY: `getppid` takes no argument and cannot fail.
        let parent_pid = unsafe { libc::getppid() };
        let mut parent = 0;
        // SAFETY: `parent` is a live port-name slot; a refused call leaves it.
        if unsafe { libc::task_for_pid(task, parent_pid, &mut parent) } == 0 {
            exit(27);
        }
        let mut address = 0;
        // SAFETY: `address` is a live `u64` the kernel would fill with a fresh
        // region's address; no existing memory is named.
        if unsafe { mach_vm_allocate(task, &mut address, page_size as u64, 1) } == 0 {
            exit(32);
        }
        // SAFETY: the range is the first page of `memory`, mapped above and
        // referenced by no Rust object, so a protection change that did succeed
        // would invalidate nothing.
        let protected = unsafe {
            mach_vm_protect(
                task,
                memory as u64,
                page_size as u64,
                0,
                libc::VM_PROT_READ | libc::VM_PROT_WRITE,
            )
        };
        if protected == 0 {
            exit(33);
        }
        // SAFETY: the same page of `memory`, which no Rust object refers to and
        // which is never read, so unmapping it could not leave a dangling use.
        if unsafe { mach_vm_deallocate(task, memory as u64, page_size as u64) } == 0 {
            exit(34);
        }
        let mut port = 0;
        // MACH_PORT_RIGHT_RECEIVE is 1; even own-task port allocation is denied.
        // SAFETY: `port` is a live port-name slot; a refused call leaves it.
        if unsafe { mach_port_allocate(task, 1, &mut port) } == 0 {
            exit(35);
        }
        let mut mib = [libc::CTL_KERN, libc::KERN_PROCARGS2, parent_pid];
        let mut arguments = [0u8; 4096];
        let mut size = arguments.len();
        // SAFETY: `mib` names three live integers, and `size` is exactly the
        // length of `arguments`, the only buffer the kernel may write.
        let read = unsafe {
            libc::sysctl(
                mib.as_mut_ptr(),
                3,
                arguments.as_mut_ptr().cast(),
                &mut size,
                std::ptr::null_mut(),
                0,
            )
        };
        if read == 0 {
            exit(28);
        }
    }
    // SAFETY: the path is a NUL-terminated literal; a descriptor that did open
    // is never used, because the oracle exits at once.
    if unsafe { libc::open(c"/etc/passwd".as_ptr(), libc::O_RDONLY) } >= 0 {
        exit(21);
    }
    // SAFETY: `socket` takes three integers.
    if unsafe { libc::socket(libc::AF_INET, libc::SOCK_STREAM, 0) } >= 0 {
        exit(22);
    }
    // SAFETY: `socket` takes three integers.
    if unsafe { libc::socket(libc::AF_UNIX, libc::SOCK_STREAM, 0) } >= 0 {
        exit(23);
    }
    // SAFETY: `fork` takes no argument. A child that did start calls only
    // `_exit`, which is async-signal-safe, so it touches no lock or allocator
    // state copied from this process.
    let child = unsafe { libc::fork() };
    if child == 0 {
        exit(24);
    }
    if child > 0 {
        // SAFETY: `child` is the process just forked; a null status pointer
        // asks `waitpid` to store nothing.
        unsafe { libc::waitpid(child, std::ptr::null_mut(), 0) };
        exit(24);
    }
    // SAFETY: the range is the first page of `memory`, which no Rust object
    // refers to, so a protection change that did succeed invalidates nothing.
    if unsafe { libc::mprotect(memory, page_size, libc::PROT_READ | libc::PROT_WRITE) } == 0 {
        exit(30);
    }
    // SAFETY: the same page of `memory`, never read and referenced by no Rust
    // object, so unmapping it could not leave a dangling use.
    if unsafe { libc::munmap(memory, page_size) } == 0 {
        exit(31);
    }
    // SAFETY: an anonymous private mapping at an address the kernel chooses; no
    // existing memory is named.
    let allocation = unsafe {
        libc::mmap(
            std::ptr::null_mut(),
            page_size,
            libc::PROT_READ | libc::PROT_WRITE,
            libc::MAP_PRIVATE | libc::MAP_ANON,
            -1,
            0,
        )
    };
    if allocation != libc::MAP_FAILED {
        exit(25);
    }
    // If exec is incorrectly permitted, false exits nonzero and the parent
    // still fails the test. No outside process or user file is changed.
    // SAFETY: both strings are NUL-terminated literals, and the variadic list
    // ends with the null `char` pointer `execl` requires.
    unsafe {
        libc::execl(
            c"/usr/bin/false".as_ptr(),
            c"false".as_ptr(),
            std::ptr::null::<libc::c_char>(),
        );
    }
    let unlimited = libc::rlimit {
        rlim_cur: libc::RLIM_INFINITY,
        rlim_max: libc::RLIM_INFINITY,
    };
    // SAFETY: `unlimited` is an initialized `rlimit` that `setrlimit` only reads.
    if unsafe { libc::setrlimit(libc::RLIMIT_AS, &unlimited) } == 0 {
        exit(26);
    }
    exit(0);
}
