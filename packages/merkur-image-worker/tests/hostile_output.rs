//! The decoder is assumed compromised here. Executable fixtures deliberately
//! bypass it to exercise the trusted result boundary independently of PNG.
#![cfg(unix)]

use std::fmt::Write;
use std::os::unix::fs::PermissionsExt;

use merkur_graphics::budget::{Budget, Usage};
use merkur_graphics::command::Format;
use merkur_graphics::processing::{DecodeRequest, RESULT_BYTES};
use merkur_image_worker::{Failure, OUTPUT_METADATA_BYTES, Reservations, WORKSPACE_BYTES, Worker};

#[tokio::test]
async fn malformed_worker_results_never_publish_or_leak_reservations() {
    let mut valid = vec![0; RESULT_BYTES];
    valid[4..8].copy_from_slice(&1u32.to_le_bytes());
    valid[8..12].copy_from_slice(&1u32.to_le_bytes());
    valid[12..16].copy_from_slice(&4u32.to_le_bytes());
    valid.extend_from_slice(&[5, 7, 9, 255]);

    let mut cases = Vec::new();
    let mut reserved = valid.clone();
    reserved[1] = 1;
    cases.push((reserved, 0, Failure::Output));
    let mut dimensions = valid.clone();
    dimensions[4..8].copy_from_slice(&u32::MAX.to_le_bytes());
    cases.push((dimensions, 0, Failure::Output));
    let mut length = valid.clone();
    length[12..16].copy_from_slice(&u32::MAX.to_le_bytes());
    cases.push((length, 0, Failure::Output));
    cases.push((valid[..RESULT_BYTES - 1].to_vec(), 0, Failure::Output));
    cases.push((valid[..valid.len() - 1].to_vec(), 0, Failure::Output));
    let mut extra = valid.clone();
    extra.push(0);
    cases.push((extra, 0, Failure::Output));
    cases.push((valid, 1, Failure::Exit));
    // A rejection names one fixed class; any other class or trailing field is hostile.
    for (class, failure) in [
        (0, Failure::Decode),
        (1, Failure::Truncated),
        (2, Failure::Png),
        (3, Failure::Excess),
        (4, Failure::Output),
    ] {
        let mut rejection = vec![0; RESULT_BYTES];
        rejection[0] = 1;
        rejection[1] = class;
        cases.push((rejection, 0, failure));
    }
    let mut trailing = vec![0; RESULT_BYTES];
    trailing[..3].copy_from_slice(&[1, 1, 1]);
    cases.push((trailing, 0, Failure::Output));

    let dir = tempfile::tempdir().unwrap();
    let executable = dir.path().join("hostile-image-worker");
    for (output, status, failure) in cases {
        let mut script = String::from("#!/bin/sh\nprintf 'IMG!'\n/bin/cat >/dev/null\nprintf '");
        for byte in output {
            write!(script, "\\{byte:03o}").unwrap();
        }
        writeln!(script, "'\nexit {status}").unwrap();
        std::fs::write(&executable, script).unwrap();
        std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
        let jobs = Budget::new(Usage {
            bytes: WORKSPACE_BYTES,
            objects: 1,
        });
        let storage = Budget::new(Usage {
            bytes: 4 + OUTPUT_METADATA_BYTES,
            objects: 1,
        });
        let mut worker = Worker::launch(
            &executable,
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
        )
        .await
        .unwrap();
        worker.push(b"BQcJ", true).await.unwrap();
        assert_eq!(worker.finish().await.err(), Some(failure));
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
}
