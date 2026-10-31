//! The upgrade, end to end, against the real binary: a dataplane hands its live shell to its
//! successor across `execve`, and this test process plays the Bun owner, which keeps its pid
//! across its own `execve` and so stays the dataplane's parent.

use std::io::{Read, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

const CMD_PREPARE_UPGRADE: u8 = 0x15;
const CMD_ADOPT: u8 = 0x16;
const CMD_COMMIT_UPGRADE: u8 = 0x18;
const CMD_ABORT_UPGRADE: u8 = 0x19;
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

fn command(
    commands: &mut impl Write,
    events: &mut impl Read,
    kind: u8,
    payload: &serde_json::Value,
) -> serde_json::Value {
    commands.write_all(&frame(kind, payload)).expect("command");
    event(events, EVT_COMMAND_ACK)
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
            // The pid file is renamed into place last, so its appearance means the trap is
            // set and the environment is written whole.
            "#!/bin/sh\ntrap 'echo winch >> \"{dir}/winch\"' WINCH\nenv > '{dir}/shell.env'\n\
             echo $$ > '{dir}/shell.pid.new'\nmv '{dir}/shell.pid.new' '{dir}/shell.pid'\n\
             printf 'before the upgrade\\n'\nwhile :; do \
             if test -e '{dir}/query'; then rm '{dir}/query'; stty -echo -icanon min 1 time 0; \
             printf '\\033[6n'; dd bs=1 count=6 > '{dir}/reply' 2>/dev/null; fi; sleep 0.05; done\n"
        ),
    )
    .expect("script");
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).expect("chmod");
    script
}

fn assert_terminal_round_trip(directory: &Path) {
    let reply = directory.join("reply");
    if reply.exists() {
        std::fs::remove_file(&reply).unwrap();
    }
    std::fs::write(directory.join("query"), b"query").unwrap();
    wait_for("the original terminal's query reply", || {
        std::fs::metadata(&reply).is_ok_and(|metadata| metadata.len() == 6)
    });
    assert_eq!(std::fs::read(reply).unwrap(), b"\x1b[2;1R");
}

struct Running(Child);

impl Drop for Running {
    fn drop(&mut self) {
        // A test that already ended the dataplane leaves nothing to kill or reap.
        if self.0.try_wait().is_ok_and(|status| status.is_none()) {
            self.0.kill().expect("end the dataplane");
            self.0.wait().expect("reap the dataplane");
        }
    }
}

#[test]
fn a_live_shell_survives_its_dataplane_replacing_itself() {
    let directory = std::env::temp_dir().join(format!("merkur-handoff-{}", std::process::id()));
    if directory.exists() {
        std::fs::remove_dir_all(&directory).expect("remove a stale directory");
    }
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
            CMD_PREPARE_UPGRADE,
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

    assert!(
        child.0.try_wait().unwrap().is_none(),
        "prepared is still the original process"
    );
    commands
        .write_all(&frame(
            CMD_COMMIT_UPGRADE,
            &serde_json::json!({
                "command_id": "commit-1", "prepared_id": "upgrade-1",
            }),
        ))
        .expect("commit");
    let committed = event(&mut events, EVT_COMMAND_ACK);
    assert_eq!(committed["command_id"], "commit-1");
    assert_eq!(committed["status"], "accepted");

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
    std::fs::remove_dir_all(&directory).expect("remove the test directory");
}

#[test]
fn handoff_prepare_failure_preserves_session() {
    let directory =
        std::env::temp_dir().join(format!("merkur-handoff-failure-{}", std::process::id()));
    std::fs::create_dir_all(&directory).expect("directory");
    let script = shell_script(&directory);
    let mut child = Running(
        Command::new(dataplane())
            .args(["--shell", script.to_str().unwrap(), "--wt-port", "0"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .expect("spawn"),
    );
    let mut commands = child.0.stdin.take().unwrap();
    let mut events = child.0.stdout.take().unwrap();
    let shell_pid = event(&mut events, EVT_PTY_READY)["pid"].as_u64().unwrap();
    wait_for("shell ready", || directory.join("shell.pid").exists());
    let collision = directory.join(format!("handoff-{}", child.0.id()));
    std::fs::write(&collision, b"occupied").unwrap();
    let ack = command(
        &mut commands,
        &mut events,
        CMD_PREPARE_UPGRADE,
        &serde_json::json!({
            "command_id": "prepare-failure", "executable": dataplane(),
            "socket_path": directory.join("owner.sock"),
        }),
    );
    assert_eq!(ack["status"], "rejected", "{ack}");
    assert!(
        child.0.try_wait().unwrap().is_none(),
        "preparation must leave the owner running"
    );
    std::fs::remove_file(collision).unwrap();
    // A second command on the same IPC stream proves the original owner still serves.
    let ack = command(
        &mut commands,
        &mut events,
        CMD_PREPARE_UPGRADE,
        &serde_json::json!({
            "command_id": "prepare-retry", "executable": "/not-an-executable",
            "socket_path": directory.join("retry.sock"),
        }),
    );
    assert_eq!(ack["command_id"], "prepare-retry");
    assert_eq!(ack["status"], "rejected");
    assert!(alive(u32::try_from(shell_pid).unwrap()));
    assert_terminal_round_trip(&directory);
    let ack = command(
        &mut commands,
        &mut events,
        CMD_PREPARE_UPGRADE,
        &serde_json::json!({
            "command_id": "prepare-abort", "executable": dataplane(),
            "socket_path": directory.join("owner.sock"),
        }),
    );
    assert_eq!(ack["status"], "accepted");
    // Neither a second preparation nor a foreign token can take this preparation.
    for (kind, payload) in [
        (
            CMD_PREPARE_UPGRADE,
            serde_json::json!({"command_id":"duplicate","executable":dataplane(),"socket_path":directory.join("other.sock")}),
        ),
        (
            CMD_COMMIT_UPGRADE,
            serde_json::json!({"command_id":"foreign","prepared_id":"other"}),
        ),
    ] {
        commands.write_all(&frame(kind, &payload)).unwrap();
        assert_eq!(event(&mut events, EVT_COMMAND_ACK)["status"], "rejected");
    }
    commands
        .write_all(&frame(
            CMD_ABORT_UPGRADE,
            &serde_json::json!({
                "command_id": "abort", "prepared_id": "prepare-abort",
            }),
        ))
        .unwrap();
    assert_eq!(event(&mut events, EVT_COMMAND_ACK)["status"], "accepted");
    assert!(!directory.join("owner.sock").exists());
    assert!(child.0.try_wait().unwrap().is_none());
    assert!(alive(u32::try_from(shell_pid).unwrap()));
    assert_terminal_round_trip(&directory);
    commands
        .write_all(&frame(CMD_SHUTDOWN, &serde_json::json!({})))
        .unwrap();
    assert!(child.0.wait().unwrap().success());
    std::fs::remove_dir_all(directory).unwrap();
}
