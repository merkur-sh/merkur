//! The upgrade, end to end, against the real binary: a dataplane hands its live shell to its
//! successor across `execve`, and this test process plays the Bun owner, which keeps its pid
//! across its own `execve` and so stays the dataplane's parent.

use std::io::{Read, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

const CMD_UPGRADE: u8 = 0x15;
const CMD_ADOPT: u8 = 0x16;
const CMD_SHUTDOWN: u8 = 0x0f;
const EVT_PTY_READY: u8 = 0x82;
const EVT_COMMAND_ACK: u8 = 0x8f;

fn dataplane() -> PathBuf {
    let path = option_env!("CARGO_BIN_EXE_merkur-dataplane")
        .or(option_env!("MERKUR_DATAPLANE_BIN"))
        .expect("the dataplane binary this test drives");
    std::fs::canonicalize(path).expect("dataplane path")
}

fn frame(kind: u8, payload: &serde_json::Value) -> Vec<u8> {
    let payload = serde_json::to_vec(payload).expect("payload");
    let mut frame = vec![kind];
    frame.extend_from_slice(&u32::try_from(payload.len()).expect("length").to_be_bytes());
    frame.extend_from_slice(&payload);
    frame
}

/// The next event of `kind` on `reader`, skipping every other.
fn event(reader: &mut impl Read, kind: u8) -> serde_json::Value {
    loop {
        let mut header = [0u8; 5];
        reader.read_exact(&mut header).expect("event header");
        let length = u32::from_be_bytes(header[1..].try_into().expect("length")) as usize;
        let mut payload = vec![0u8; length];
        reader.read_exact(&mut payload).expect("event payload");
        if header[0] == kind {
            return serde_json::from_slice(&payload).expect("event json");
        }
    }
}

fn wait_for(what: &str, mut condition: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while !condition() {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn alive(pid: u32) -> bool {
    Command::new("kill")
        .args(["-0", &pid.to_string()])
        .status()
        .is_ok_and(|status| status.success())
}

fn shell_script(directory: &Path) -> PathBuf {
    let script = directory.join("shell.sh");
    let dir = directory.display();
    std::fs::write(
        &script,
        format!(
            "#!/bin/sh\necho $$ > '{dir}/shell.pid'\nenv > '{dir}/shell.env'\n\
             trap 'echo winch >> \"{dir}/winch\"' WINCH\nprintf 'before the upgrade\\n'\n\
             while :; do sleep 0.05; done\n"
        ),
    )
    .expect("script");
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).expect("chmod");
    script
}

struct Running(Child);

impl Drop for Running {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

#[test]
fn a_live_shell_survives_its_dataplane_replacing_itself() {
    let directory = std::env::temp_dir().join(format!("merkur-handoff-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&directory);
    std::fs::create_dir_all(&directory).expect("directory");
    let script = shell_script(&directory);
    let args = [
        "--shell",
        script.to_str().expect("utf-8 path"),
        "--wt-port",
        "0",
    ];
    let mut child = Running(
        Command::new(dataplane())
            .args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .expect("spawn the dataplane"),
    );
    let dataplane_pid = child.0.id();
    let mut commands = child.0.stdin.take().expect("stdin");
    let mut events = child.0.stdout.take().expect("stdout");

    let shell_pid = event(&mut events, EVT_PTY_READY)["pid"]
        .as_u64()
        .expect("pid");
    wait_for("the shell to start", || {
        directory.join("shell.pid").exists()
    });
    let environment = std::fs::read_to_string(directory.join("shell.env")).expect("env");
    let image_socket = environment
        .lines()
        .find_map(|line| line.strip_prefix("MERKUR_IMAGE_SOCKET="))
        .map(PathBuf::from)
        .expect("the shell names its image broker");

    let socket_path = directory.join("owner.sock");
    commands
        .write_all(&frame(
            CMD_UPGRADE,
            &serde_json::json!({
                "command_id": "upgrade-1",
                "executable": dataplane(),
                "socket_path": socket_path,
            }),
        ))
        .expect("upgrade");
    let ack = event(&mut events, EVT_COMMAND_ACK);
    assert_eq!(ack["command_id"], "upgrade-1");
    assert_eq!(ack["status"], "accepted", "{ack}");

    // This process is the dataplane's parent, as the replaced owner is.
    let mut owner = UnixStream::connect(&socket_path).expect("connect as the new owner");
    owner
        .write_all(&frame(CMD_ADOPT, &serde_json::json!({ "args": args })))
        .expect("adopt");
    let adopted = event(&mut owner, EVT_PTY_READY);
    assert_eq!(
        adopted["pid"].as_u64(),
        Some(shell_pid),
        "the same shell, adopted"
    );

    assert!(
        child.0.try_wait().expect("status").is_none(),
        "the dataplane kept running"
    );
    assert_eq!(child.0.id(), dataplane_pid);
    assert!(
        alive(u32::try_from(shell_pid).expect("pid")),
        "the shell survived"
    );
    wait_for("the redraw signal", || directory.join("winch").exists());
    assert!(image_socket.exists(), "the image broker kept its socket");
    assert!(
        !socket_path.exists(),
        "the owner socket is unlinked once taken"
    );

    owner
        .write_all(&frame(CMD_SHUTDOWN, &serde_json::json!({})))
        .expect("shutdown");
    let status = child.0.wait().expect("exit");
    assert!(status.success(), "{status}");
    wait_for("the shell to end with its terminal", || {
        !alive(u32::try_from(shell_pid).expect("pid"))
    });
    let _ = std::fs::remove_dir_all(&directory);
}
