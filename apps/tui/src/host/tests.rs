//! A pseudo-terminal pair stands in for the host: the TUI takes the terminal
//! side, and the test reads and writes as the host application would. One test,
//! since a process restores one host at a time.

use std::time::Duration;

use rustix::fs::{OFlags, fcntl_setfl};
use rustix::pty::{OpenptFlags, grantpt, openpt, ptsname, unlockpt};
use rustix::termios::{LocalModes, Winsize, tcsetwinsize};

use super::*;

/// The host application's side, and the terminal side the TUI takes.
fn pair() -> (OwnedFd, OwnedFd) {
    let host = openpt(OpenptFlags::RDWR | OpenptFlags::NOCTTY).expect("a pseudo-terminal");
    grantpt(&host).expect("granted");
    unlockpt(&host).expect("unlocked");
    let name = ptsname(&host, Vec::new()).expect("its name");
    let terminal = open(
        name.as_c_str(),
        OFlags::RDWR | OFlags::NOCTTY | OFlags::NONBLOCK,
        Mode::empty(),
    )
    .expect("its terminal side");
    fcntl_setfl(&host, OFlags::NONBLOCK).expect("non-blocking");
    (host, terminal)
}

/// Reads what the terminal side wrote until `want` has arrived.
fn host_reads(host: &OwnedFd, want: &[u8]) {
    let mut got = Vec::new();
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while !got.windows(want.len()).any(|window| window == want) {
        assert!(
            std::time::Instant::now() < deadline,
            "never read {want:?}, got {got:?}"
        );
        let mut ready = [PollFd::new(host, PollFlags::IN)];
        let _ = poll(
            &mut ready,
            Some(&rustix::time::Timespec {
                tv_sec: 0,
                tv_nsec: 50_000_000,
            }),
        );
        let mut buf = [0; 4096];
        if let Ok(count) = rustix::io::read(host, &mut buf) {
            got.extend_from_slice(&buf[..count]);
        }
    }
}

#[tokio::test]
async fn the_host_is_taken_in_raw_mode_and_put_back_exactly() {
    let (host, terminal) = pair();
    tcsetwinsize(
        &terminal,
        Winsize {
            ws_row: 24,
            ws_col: 80,
            ws_xpixel: 800,
            ws_ypixel: 480,
        },
    )
    .expect("sized");
    let observer = terminal.try_clone().expect("a second descriptor");
    let before = tcgetattr(&observer).expect("its modes");

    let tui = Host::take(terminal).expect("taken");
    host_reads(&host, ENTER);
    let raw = tcgetattr(&observer).expect("its modes");
    assert!(
        !raw.local_modes
            .intersects(LocalModes::ICANON | LocalModes::ECHO | LocalModes::ISIG)
    );
    assert_eq!(
        tui.size().expect("its size"),
        HostSize {
            cols: 80,
            rows: 24,
            cell: Some((10.0, 20.0)),
        }
    );

    // A window extent with padding is not an exact cell metric. The host's
    // CSI 16 t reply must supply it rather than a fractional inferred cell.
    tcsetwinsize(
        &observer,
        Winsize {
            ws_row: 24,
            ws_col: 80,
            ws_xpixel: 801,
            ws_ypixel: 480,
        },
    )
    .unwrap();
    assert_eq!(tui.size().unwrap().cell, None);
    tcsetwinsize(
        &observer,
        Winsize {
            ws_row: 24,
            ws_col: 80,
            ws_xpixel: 800,
            ws_ypixel: 480,
        },
    )
    .unwrap();

    // Keys arrive byte for byte: nothing is cooked, echoed or signalled.
    let typed = b"\x1b[99;5u\x03\r";
    rustix::io::write(&host, typed).expect("typed");
    let mut buf = [0; 64];
    let mut got = Vec::new();
    while got.len() < typed.len() {
        let count = tokio::time::timeout(Duration::from_secs(5), tui.read(&mut buf))
            .await
            .expect("keys in time")
            .expect("keys");
        got.extend_from_slice(&buf[..count]);
    }
    assert_eq!(got, typed);
    // And frames leave untranslated.
    tui.write_all(b"a\nb").await.expect("written");
    host_reads(&host, b"a\nb");

    // A second owner must not replace the first owner's restoration state.
    assert!(
        matches!(Host::take(observer.try_clone().expect("descriptor")),
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists)
    );

    rustix::io::write(&host, b"unread-password\n").expect("unread input queued");
    drop(tui);
    host_reads(&host, LEAVE);
    assert!(matches!(
        rustix::io::read(&observer, &mut buf),
        Err(rustix::io::Errno::AGAIN)
    ));
    let after = tcgetattr(&observer).expect("its modes");
    assert_eq!(after.local_modes, before.local_modes);
    assert_eq!(after.input_modes, before.input_modes);
    assert_eq!(after.output_modes, before.output_modes);
    assert_eq!(after.control_modes, before.control_modes);

    // The panic hook restores before a diagnostic is printed, even when a
    // caller catches the unwind and continues using the process.
    let tui = Host::take(observer.try_clone().expect("descriptor")).expect("taken again");
    host_reads(&host, ENTER);
    assert!(std::panic::catch_unwind(|| panic!("restore test")).is_err());
    host_reads(&host, LEAVE);
    assert_eq!(
        tcgetattr(&observer).expect("restored").local_modes,
        before.local_modes
    );
    let replacement = Host::take(observer.try_clone().expect("descriptor")).expect("replacement");
    host_reads(&host, ENTER);
    drop(tui);
    assert!(
        !tcgetattr(&observer)
            .expect("still raw")
            .local_modes
            .contains(LocalModes::ICANON)
    );

    let notify = |signal: &str| {
        assert!(
            std::process::Command::new("/bin/kill")
                .args([signal, &std::process::id().to_string()])
                .status()
                .expect("signal sent")
                .success()
        );
    };
    notify("-WINCH");
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(5), replacement.read_event(&mut buf))
            .await
            .expect("resize in time")
            .expect("resize"),
        HostRead::Resize
    );
    notify("-TERM");
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(5), replacement.read_event(&mut buf))
            .await
            .expect("termination in time")
            .expect("termination"),
        HostRead::Exit(143)
    );
    host_reads(&host, LEAVE);
    assert_eq!(
        tcgetattr(&observer)
            .expect("restored on signal")
            .local_modes,
        before.local_modes
    );
    drop(replacement);
}
