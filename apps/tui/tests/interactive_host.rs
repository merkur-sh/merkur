//! A real controlling PTY exercises the executable, including cleanup after
//! cancellation, a signal, and an authentication transport failure.
use std::process::Command;

#[test]
fn password_is_masked_and_every_exit_restores_the_controlling_terminal() {
    // Darwin may validate a newly linked executable before its first write.
    // Prove it can start before measuring the fixture's terminal transitions.
    let startup = Command::new(env!("CARGO_BIN_EXE_merkur-tui"))
        .arg("--help")
        .output()
        .expect("interactive executable starts");
    assert!(
        startup.status.success(),
        "interactive executable failed to start"
    );
    let script = r#"
import os, pty, select, signal, struct, subprocess, sys, termios, time, fcntl, tempfile
binary = sys.argv[1]
for end in ('escape', 'signal', 'submit'):
    state = tempfile.TemporaryDirectory(prefix='merkur-pty-account-')
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 24, 80, 800, 480))
    original = termios.tcgetattr(slave)
    def take_terminal():
        os.setsid()
        fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
    # Keep the controlling session leader alive through the client's exit:
    # Darwin revokes a tty when that leader exits, making a later tcgetattr
    # incapable of checking cleanup. The supervisor verifies before exiting.
    supervisor = """
import os, signal, subprocess, sys, termios
original = termios.tcgetattr(0)
client = subprocess.Popen(sys.argv[1:])
signal.signal(signal.SIGTERM, lambda sig, frame: client.send_signal(sig))
code = client.wait()
assert termios.tcgetattr(0) == original, 'terminal was not restored'
os.write(1, b'HOST_RESTORED')
sys.exit(code)
"""
    child = subprocess.Popen([sys.executable, '-c', supervisor, binary, 'connect', '--origin', 'http://127.0.0.1:9',
        '--opaque-server-key', 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        '--username', 'pty-user', '--machine', 'pty-machine',
        '--state-dir', state.name, '--identity-seal', 'software'],
        stdin=slave, stdout=slave, stderr=slave, preexec_fn=take_terminal)
    seen = bytearray()
    queries = 0
    def read_until(predicate):
        global queries
        deadline = time.monotonic() + 10
        while not predicate():
            assert time.monotonic() < deadline, (end, bytes(seen))
            readable, _, _ = select.select([master], [], [], .1)
            if readable:
                data = os.read(master, 65536)
                seen.extend(data)
                # The fixture consumes bytes before answering DSR, exactly as
                # a host terminal's parser does. Split requests are supported.
                current = seen.count(b'\x1b[5n')
                if current > queries:
                    os.write(master, b'\x1b[0n' * (current - queries))
                    queries = current
    try:
        # A label can precede the rest of a split frame. Type only after the
        # initial frame's consumed query; the next query then belongs to editing.
        read_until(lambda: b'Password' in seen and seen.rfind(b'\x1b[5n') > seen.rfind(b'Password'))
        assert not termios.tcgetattr(slave)[3] & (termios.ECHO | termios.ICANON)
        # Idle motion repaints only the orb's changed cells, never another
        # password card and never a cleared screen, and hands the cursor back
        # to the field (row 14, column 11 on this 80x24 card).
        before = queries
        start = len(seen)
        read_until(lambda: queries >= before + 2)
        assert seen.count(b'Password') == 1, bytes(seen)
        idle = bytes(seen[start:seen.rfind(b'\x1b[5n')])
        assert b'\x1b[2J' not in idle, idle
        assert idle[idle.rfind(b'\x1b[?2026h'):].count(b'\x1b[14;11H') == 1, idle
        # Focus loss stops the animation; focus regain resumes it. The typed
        # character repaints only its masked cell, not the card.
        mark = len(seen)
        os.write(master, b'\x1b[Of')
        read_until(lambda: '•'.encode() in seen[mark:] and seen.rfind(b'\x1b[5n') > seen.rfind('•'.encode()))
        assert seen.count(b'Password') == 1, bytes(seen)
        paused = queries
        readable, _, _ = select.select([master], [], [], .25)
        if readable:
            seen.extend(os.read(master, 65536))
        assert seen.count(b'\x1b[5n') == paused, bytes(seen)
        os.write(master, b'\x1b[I')
        read_until(lambda: queries > paused)
        before = queries
        os.write(master, b'sensitive-pty-secret\xc3')
        # Complete the scalar before any DSR reply can be inserted into the
        # input stream; separate writes may still become separate tty reads.
        os.write(master, b'\xa9')
        read_until(lambda: queries > before)
        assert b'sensitive-pty-secret' not in seen
        assert '•'.encode() in seen
        if end == 'signal': child.send_signal(signal.SIGTERM)
        elif end == 'escape': os.write(master, b'\x1b[27u')
        else: os.write(master, b'\r')
        read_until(lambda: child.poll() is not None)
        assert child.returncode == {'escape': 0, 'signal': 143, 'submit': 1}[end], bytes(seen)
        assert b'HOST_RESTORED' in seen, bytes(seen)
        assert b'\x1b[?1049l' in seen, bytes(seen)
        assert b'sensitive-pty-secret' not in seen
    finally:
        if child.poll() is None:
            # Own the entire fixture session, and keep draining while it exits:
            # Darwin can wait for pending tty output when revoking the session.
            os.killpg(child.pid, signal.SIGKILL)
            while child.poll() is None:
                if select.select([master], [], [], .1)[0]:
                    try: os.read(master, 65536)
                    except OSError: pass
        child.wait()
        os.close(master)
        os.close(slave)
        state.cleanup()
"#;
    let output = Command::new("python3")
        .args(["-c", script, env!("CARGO_BIN_EXE_merkur-tui")])
        .output()
        .expect("PTY fixture starts");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}
