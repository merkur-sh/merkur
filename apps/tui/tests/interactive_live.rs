//! Invoked by the edge harness with a fresh linked account. This runs the
//! shipped executable in a controlling PTY and interprets its output with
//! alacritty, independently of the native viewer and composer.
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use alacritty_terminal::event::VoidListener;
use alacritty_terminal::index::{Column, Line, Point};
use alacritty_terminal::term::test::TermSize;
use alacritty_terminal::term::{Config, Term};
use alacritty_terminal::vte::ansi::Processor;
use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use serde_json::{Value, json};
use zeroize::Zeroizing;

struct Pty {
    child: Child,
    input: Option<ChildStdin>,
    state_directory: std::path::PathBuf,
    binary: String,
    events: mpsc::Receiver<Value>,
    term: Term<VoidListener>,
    parser: Processor,
    bytes: Vec<u8>,
    cols: usize,
    rows: usize,
    exit: Option<i64>,
}
impl Pty {
    fn open() -> Self {
        let binary = std::env::var("MERKUR_TUI_TEST_BIN").expect("harness-built binary");
        let state_directory = std::env::temp_dir().join(format!(
            "merkur-live-account-{}",
            merkur_client::uuid_v4(&mut merkur_client_native::driver::OsEntropy)
        ));
        let mut command = Command::new("python3");
        command
            .arg(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/pty_bridge.py"))
            .arg(&binary)
            .arg("connect")
            .args([
                "--state-dir",
                state_directory.to_str().expect("test path"),
                "--identity-seal",
                "software",
            ]);
        for (flag, var) in [
            ("--origin", "MERKUR_TUI_TEST_ORIGIN"),
            ("--opaque-server-key", "MERKUR_TUI_TEST_PIN"),
            ("--username", "MERKUR_TUI_TEST_USERNAME"),
            ("--machine", "MERKUR_TUI_TEST_MACHINE"),
        ] {
            command.args([flag, &std::env::var(var).expect(var)]);
        }
        if let Ok(port) = std::env::var("EDGE_PROXY_BROWSER_PORT") {
            command.args(["--edge-port", &port]);
        }
        if std::env::var("FORCE_EDGE").as_deref() != Ok("0") {
            command.arg("--relay-only");
        }
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .expect("PTY bridge starts");
        let input = child.stdin.take().expect("bridge input");
        let output = child.stdout.take().expect("bridge output");
        let (send, events) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(output).lines() {
                let Ok(line) = line else { break };
                let Ok(event) = serde_json::from_str(&line) else {
                    break;
                };
                if send.send(event).is_err() {
                    break;
                }
            }
        });
        Self {
            child,
            input: Some(input),
            state_directory,
            binary,
            events,
            term: Term::new(Config::default(), &TermSize::new(80, 24), VoidListener),
            parser: Processor::new(),
            bytes: Vec::new(),
            cols: 80,
            rows: 24,
            exit: None,
        }
    }
    fn send(&mut self, bytes: &[u8]) {
        let encoded = Zeroizing::new(STANDARD.encode(bytes));
        // Write the encoded secret without materializing another JSON copy.
        writeln!(
            self.input.as_mut().expect("open bridge input"),
            "{{\"bytes\":\"{}\"}}",
            encoded.as_str()
        )
        .expect("host types");
        self.input
            .as_mut()
            .expect("open bridge input")
            .flush()
            .expect("host input flushes");
    }
    fn screen(&self) -> Vec<String> {
        (0..self.rows)
            .map(|row| {
                (0..self.cols)
                    .map(|col| self.term.grid()[Point::new(Line(row as i32), Column(col))].c)
                    .collect::<String>()
                    .trim_end()
                    .to_owned()
            })
            .collect()
    }
    fn until(&mut self, condition: impl Fn(&Self) -> bool) {
        let deadline = Instant::now() + Duration::from_secs(30);
        while !condition(self) {
            let event = self
                .events
                .recv_timeout(deadline.saturating_duration_since(Instant::now()))
                .unwrap_or_else(|error| {
                    panic!("PTY did not reach state: {error}; {:?}", self.screen())
                });
            if let Some(encoded) = event.get("bytes").and_then(Value::as_str) {
                let bytes = STANDARD.decode(encoded).expect("PTY bytes");
                self.parser.advance(&mut self.term, &bytes);
                self.bytes.extend_from_slice(&bytes);
            }
            if let Some(code) = event.get("exit").and_then(Value::as_i64) {
                self.exit = Some(code);
            }
        }
    }
    fn command(&mut self, text: &str) {
        let mut bytes = Vec::new();
        for c in text.chars() {
            let code = u32::from(c);
            bytes.extend_from_slice(format!("\x1b[{code};;{code}u").as_bytes());
        }
        bytes.extend_from_slice(b"\x1b[13u");
        self.send(&bytes);
    }
    fn resize(&mut self, cols: usize, rows: usize) {
        writeln!(
            self.input.as_mut().expect("open bridge input"),
            "{}",
            json!({ "resize": [cols, rows] })
        )
        .expect("resize");
        self.input
            .as_mut()
            .expect("open bridge input")
            .flush()
            .expect("resize sent");
        self.term.resize(TermSize::new(cols, rows));
        self.cols = cols;
        self.rows = rows;
    }
}
impl Drop for Pty {
    fn drop(&mut self) {
        // EOF tells the bridge to terminate the native client, keep draining its
        // PTY, and wait until the controlling supervisor proved restoration.
        // It also waits out a committed sign-in's durable publication.
        drop(self.input.take());
        let _ = self.child.wait();
        // The account is this fixture's own delegation. Prefer its real logout
        // so a passing gate proves server revocation as well as local cleanup.
        let _ = Command::new(&self.binary)
            .args(["logout", "--state-dir"])
            .arg(&self.state_directory)
            .output();
        // A failed test still removes its exact local fixture credential; the
        // server fixture removes its isolated account after this process ends.
        if let Ok(Some(store)) = merkur_tui::account_store::Store::open(&self.state_directory)
            && let Ok(runtime) = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
        {
            let _ = runtime.block_on(store.remove());
        }
        if self.state_directory.exists() {
            let _ = std::fs::remove_dir_all(&self.state_directory);
        }
    }
}

/// The endpoint is the independently interpreted host grid, after the real
/// remote raw-mode application echoes each input. Prediction cannot help here.
fn measure_authoritative_echo(pty: &mut Pty) {
    let path = if std::env::var("FORCE_EDGE").as_deref() == Ok("0") {
        "Direct"
    } else {
        "Relay"
    };
    pty.until(|pty| pty.screen().last().is_some_and(|row| row.contains(path)));
    let program = "import os,termios,tty\nold=termios.tcgetattr(0)\ntty.setraw(0)\nos.write(1,b'\\r\\necho-'+b'probe-ready\\r\\n')\ntry:\n for i in range(64):\n  key=os.read(0,1)\n  assert key==b'x',repr(key)\n  os.write(1,('\\r\\x1b[2Kecho-probe-%03d'%i).encode())\nfinally:\n termios.tcsetattr(0,termios.TCSANOW,old)\n os.write(1,b'\\r\\n')";
    let invocation = format!("exec({})", serde_json::to_string(program).unwrap());
    pty.command(&format!(
        "python3 -c '{}'",
        invocation.replace('\'', "'\\''")
    ));
    pty.until(|pty| {
        pty.screen()
            .iter()
            .any(|row| row.trim() == "echo-probe-ready")
    });
    let mut samples = Vec::with_capacity(64);
    for index in 0..64 {
        let marker = format!("echo-probe-{index:03}");
        let at = Instant::now();
        pty.send(b"x");
        pty.until(|pty| pty.screen().iter().any(|row| row.trim() == marker));
        samples.push(at.elapsed().as_secs_f64() * 1000.0);
        assert!(
            pty.screen().last().is_some_and(|row| row.contains(path)),
            "measured path changed"
        );
    }
    println!("{}", echo_report(&samples, path, &pty.binary));
}

fn echo_report(samples: &[f64], path: &str, binary: &str) -> Value {
    assert_eq!(samples.len(), 64);
    let mut ordered = samples.to_vec();
    ordered.sort_by(f64::total_cmp);
    json!({
        "benchmark": "tui-authoritative-echo",
        "binary": binary,
        "boundary": "host input to independently interpreted ANSI host grid",
        "prediction": false,
        "path": path,
        "quantile_method": "sorted[floor((n-1)*q)]",
        "samples_ms": samples,
        "p50_ms": ordered[31], "p95_ms": ordered[59], "p99_ms": ordered[62],
        "max_ms": ordered[63],
    })
}

#[test]
fn echo_report_preserves_sample_order_and_uses_lower_sample_quantiles() {
    let samples: Vec<f64> = (0..64).rev().map(f64::from).collect();
    let report = echo_report(&samples, "Direct", "fixture");
    assert_eq!(report["p50_ms"], 31.0);
    assert_eq!(report["p95_ms"], 59.0);
    assert_eq!(report["p99_ms"], 62.0);
    assert_eq!(report["max_ms"], 63.0);
    assert_eq!(report["samples_ms"], json!(samples));
}

fn paste_receiver(pasted: &str) -> String {
    let expected = STANDARD.encode(format!("\x1b[200~{pasted}\x1b[201~").as_bytes());
    let program = format!(
        "import os,termios,tty,base64\nold=termios.tcgetattr(0)\ntty.setraw(0)\nos.write(1,b'\\x1b[?2004h\\r\\n'+b'paste-'+b'receiver-ready\\r\\n')\ndata=b''\ntry:\n while not data.endswith(b'\\x1b[201~'):\n  data+=os.read(0,4096)\nfinally:\n termios.tcsetattr(0,termios.TCSANOW,old)\n os.write(1,b'\\x1b[?2004l')\nassert data==base64.b64decode('{expected}')\nprint('paste-'+'complete',flush=True)"
    );
    let invocation = format!("exec({})", serde_json::to_string(&program).unwrap());
    format!("python3 -c '{}'", invocation.replace('\'', "'\\''"))
}

#[test]
#[ignore = "needs the edge harness's fresh account, linked daemon and release binary"]
fn authenticated_interactive_session() {
    let mut password = Zeroizing::new(String::new());
    std::io::stdin()
        .lock()
        .read_line(&mut password)
        .expect("password on stdin");
    let mut pty = Pty::open();
    pty.until(|pty| pty.screen().iter().any(|row| row.contains("Password")));
    pty.send(password.trim_end_matches(['\r', '\n']).as_bytes());
    // A traditional host sends DEL for the Mac Delete key and CR for Enter.
    // The extra character must be erased before submitting the real password.
    pty.send(b"x\x7f\r");
    pty.until(|pty| pty.screen().iter().any(|row| row.contains("Ready")));
    assert!(
        !pty.bytes
            .windows(password.trim().len())
            .any(|part| part == password.trim().as_bytes()),
        "the password must never reach host output"
    );
    // This host states no cell pixels. The machine still takes its content
    // area at connect, leaving one row for client chrome.
    pty.command("stty size; printf '%s%s\\n' connect- sized");
    pty.until(|pty| {
        let screen = pty.screen();
        screen.iter().any(|row| row.trim() == "23 80")
            && screen.iter().any(|row| row.trim() == "connect-sized")
    });
    measure_authoritative_echo(&mut pty);
    // The receiving program owns raw mode and checks the exact remote bytes.
    // Ctrl-b must reach an inner tmux; double Ctrl-\ sends Merkur's own prefix.
    let receiver = "import os,termios,tty\nold=termios.tcgetattr(0)\ntty.setraw(0)\nos.write(1,b'\\r\\nraw-'+b'keys-ready\\r\\n')\ndata=b''\ntry:\n while len(data)<8:\n  data+=os.read(0,8-len(data))\nfinally:\n termios.tcsetattr(0,termios.TCSANOW,old)\nassert data==b'\\r\\x7f\\x1b[3~\\x02\\x1c',repr(data)\nprint('raw-'+'keys-complete',flush=True)";
    let invocation = format!("exec({})", serde_json::to_string(receiver).unwrap());
    pty.command(&format!(
        "python3 -c '{}'",
        invocation.replace('\'', "'\\''")
    ));
    pty.until(|pty| {
        pty.screen()
            .iter()
            .any(|row| row.trim() == "raw-keys-ready")
    });
    pty.send(b"\r\x7f\x1b[3~\x02\x1c\x1c");
    pty.until(|pty| {
        pty.screen()
            .iter()
            .any(|row| row.trim() == "raw-keys-complete")
    });
    // The receiver explicitly requests bracketed paste. A shell that happens
    // to inherit 2004h is not a paste consumer (notably macOS Bash 3.2).
    let pasted = "first line\nhéllo 世界\nlast line";
    pty.command(&paste_receiver(pasted));
    pty.until(|pty| {
        pty.screen()
            .iter()
            .any(|row| row.trim() == "paste-receiver-ready")
    });
    pty.send(format!("\x1b[200~{pasted}\x1b[201~").as_bytes());
    pty.until(|pty| {
        pty.screen()
            .iter()
            .any(|row| row.trim() == "paste-complete")
    });
    let marker = format!("interactive-{}", std::process::id());
    let half = marker.len() / 2;
    let print = format!(
        "seq 1 400; printf '%s%s\\n' {} {}",
        &marker[..half],
        &marker[half..]
    );
    pty.command(&print);
    pty.until(|pty| pty.screen().iter().any(|row| row.trim() == marker));
    // The machine adopts the content area, leaving one row for client chrome.
    pty.resize(100, 30);
    pty.command("stty size; printf '%s%s\\n' resize- complete");
    pty.until(|pty| {
        let screen = pty.screen();
        screen.iter().any(|row| row.trim() == "29 100")
            && screen.iter().any(|row| row.trim() == "resize-complete")
    });
    assert!(
        pty.screen()[29].contains("Ctrl-\\"),
        "content cannot overwrite chrome"
    );
    // Exercise the shifted shortcut through the real host parser, then return
    // to the same independently interpreted remote screen.
    pty.send(b"\x1c\x1b[47:63;2;63u\x1b[47:63;2:3u");
    pty.until(|pty| {
        pty.screen()
            .iter()
            .any(|row| row.contains("MERKUR / SHORTCUTS"))
    });
    pty.resize(36, 10);
    pty.until(|pty| {
        pty.screen()
            .last()
            .is_some_and(|row| row.contains("Esc return"))
    });
    pty.send(b"\x1b[27u");
    pty.until(|pty| pty.screen().last().is_some_and(|row| row.contains("Ready")));
    pty.resize(100, 30);
    pty.command("stty size; printf '%s%s\\n' guide- returned");
    pty.until(|pty| {
        let screen = pty.screen();
        screen.iter().any(|row| row.trim() == "29 100")
            && screen.iter().any(|row| row.trim() == "guide-returned")
    });
    pty.send(b"\x1b[92;5u\x1b[113;;113u");
    pty.until(|pty| pty.exit.is_some());
    assert_eq!(pty.exit, Some(0));
    assert!(
        pty.bytes
            .windows(b"HOST_RESTORED".len())
            .any(|part| part == b"HOST_RESTORED")
    );
    let logout = Command::new(&pty.binary)
        .args(["logout", "--state-dir"])
        .arg(&pty.state_directory)
        .output()
        .expect("native logout starts");
    assert!(
        logout.status.success(),
        "logout failed: {}",
        String::from_utf8_lossy(&logout.stderr)
    );
    assert!(!pty.state_directory.join("account.json").exists());
}

#[test]
fn paste_receiver_runs_in_bash_and_checks_exact_multiline_utf8() {
    let pasted = "first line\nhéllo 世界\nlast line";
    let input = STANDARD.encode(format!("\x1b[200~{pasted}\x1b[201~").as_bytes());
    let script = r#"
import base64, os, pty, select, subprocess, sys, termios, time
master, slave = pty.openpty()
original = termios.tcgetattr(slave)
child = subprocess.Popen(['/bin/bash', '-c', sys.argv[1]], stdin=slave, stdout=slave, stderr=slave)
seen = bytearray()
sent = False
deadline = time.monotonic() + 10
try:
    while child.poll() is None:
        assert time.monotonic() < deadline, bytes(seen)
        if select.select([master], [], [], .1)[0]:
            seen.extend(os.read(master, 65536))
            if not sent and b'paste-receiver-ready' in seen:
                os.write(master, base64.b64decode(sys.argv[2]))
                sent = True
    while select.select([master], [], [], 0)[0]:
        seen.extend(os.read(master, 65536))
    assert child.returncode == 0, bytes(seen)
    assert sent and b'paste-complete' in seen, bytes(seen)
    # Darwin schedules canonical reprocessing (PENDIN) when raw mode ends.
    # A read consumes that kernel work before comparing all termios bits.
    os.set_blocking(slave, False)
    try:
        assert os.read(slave, 1) == b''
    except BlockingIOError:
        pass
    assert termios.tcgetattr(slave) == original, (original, termios.tcgetattr(slave))
finally:
    if child.poll() is None: child.kill()
    child.wait()
    os.close(master)
    os.close(slave)
"#;
    let result = Command::new("python3")
        .args(["-c", script, &paste_receiver(pasted), &input])
        .output()
        .expect("paste receiver fixture");
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
}
