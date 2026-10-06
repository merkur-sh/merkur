use std::future::Future;
use std::io::Write;
use std::os::unix::net::UnixStream;
use std::process::{Command, Stdio};
use std::task::Poll;

use rustix::fs::{OFlags, fcntl_getfl};

use super::HeadlessInput;

#[tokio::test]
async fn cancelled_pipe_read_preserves_bytes_and_eof() {
    let (reader, mut writer) = UnixStream::pair().unwrap();
    let shared_flags = reader.try_clone().unwrap();
    let original_flags = fcntl_getfl(&shared_flags).unwrap();
    let mut input = HeadlessInput::from_fd(reader.into()).unwrap();
    assert!(
        fcntl_getfl(&shared_flags)
            .unwrap()
            .contains(OFlags::NONBLOCK)
    );
    let mut bytes = [0; 8];
    {
        let mut read = std::pin::pin!(input.read(&mut bytes));
        std::future::poll_fn(|cx| {
            assert!(read.as_mut().poll(cx).is_pending());
            Poll::Ready(())
        })
        .await;
    }
    writer.write_all(b"\xc3").unwrap();
    assert_eq!(input.read(&mut bytes).await.unwrap(), 1);
    let mut partial = bytes[..1].to_vec();
    assert!(crate::take_keys(&mut partial).is_empty());
    writer.write_all(b"\xa9\n").unwrap();
    assert_eq!(input.read(&mut bytes).await.unwrap(), 2);
    partial.extend_from_slice(&bytes[..2]);
    assert_eq!(crate::take_keys(&mut partial), ['é', '\n']);
    drop(writer);
    assert_eq!(input.read(&mut bytes).await.unwrap(), 0);
    drop(input);
    assert_eq!(fcntl_getfl(&shared_flags).unwrap(), original_flags);
}

#[tokio::test]
async fn regular_file_input_and_read_failure_have_finite_owners() {
    let path = std::env::temp_dir().join(format!("merkur-headless-input-{}", std::process::id()));
    let file = std::fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&path)
        .unwrap();
    std::fs::write(&path, b"file\n").unwrap();
    let mut invalid = HeadlessInput::from_fd(file.into()).unwrap();
    let mut bytes = [0; 8];
    assert!(invalid.read(&mut bytes).await.is_err());
    let file = std::fs::File::open(&path).unwrap();
    let mut input = HeadlessInput::from_fd(file.into()).unwrap();
    assert_eq!(input.read(&mut bytes).await.unwrap(), 5);
    assert_eq!(&bytes[..5], b"file\n");
    assert_eq!(input.read(&mut bytes).await.unwrap(), 0);
    std::fs::remove_file(path).unwrap();
}

/// Runs in its own process so runtime shutdown, with stdin still open, is proof.
#[test]
fn retirement_child() {
    if std::env::var_os("MERKUR_HEADLESS_INPUT_CHILD").is_none() {
        return;
    }
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(async {
        let mut input = HeadlessInput::stdin().unwrap();
        let mut byte = [0];
        assert_eq!(input.read(&mut byte).await.unwrap(), 1);
        // The authenticated close retires an already-polled keyboard read.
        let mut read = std::pin::pin!(input.read(&mut byte));
        std::future::poll_fn(|cx| {
            assert!(read.as_mut().poll(cx).is_pending());
            Poll::Ready(())
        })
        .await;
    });
    drop(runtime);
    println!("input owner retired");
}

#[test]
fn retirement_exits_with_the_stdin_writer_still_open() {
    let mut child = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "headless_input::tests::retirement_child",
            "--nocapture",
        ])
        .env("MERKUR_HEADLESS_INPUT_CHILD", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child.stdin.as_mut().unwrap().write_all(b"a").unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
    loop {
        if let Some(status) = child.try_wait().unwrap() {
            assert!(status.success());
            break;
        }
        if std::time::Instant::now() >= deadline {
            child.kill().unwrap();
            child.wait().unwrap();
            panic!("retired keyboard read prevented runtime exit while stdin stayed open");
        }
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
    let output = child.wait_with_output().unwrap();
    assert!(
        String::from_utf8(output.stdout)
            .unwrap()
            .contains("input owner retired")
    );
}
