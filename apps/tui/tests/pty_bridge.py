"""A controlling PTY for interactive e2e tests; stdin/stdout are JSON lines.

The test supplies typed bytes over stdin. PTY output is forwarded intact and
DSR is answered after consumption. No credential travels in process arguments.
The host starts as a tmux popup is: its window size states no pixels and
`CSI 16 t` goes unanswered. A resize states them.
"""
import base64
import fcntl
import json
import os
import pty
import select
import signal
import struct
import subprocess
import sys
import termios

master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 24, 80, 0, 0))

def take_terminal():
    os.setsid()
    fcntl.ioctl(slave, termios.TIOCSCTTY, 0)

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
child = subprocess.Popen([sys.executable, '-c', supervisor, *sys.argv[1:]],
    stdin=slave, stdout=slave, stderr=slave, preexec_fn=take_terminal)
stdin = bytearray()
tail = b''
watch_stdin = True
try:
    while True:
        readable, _, _ = select.select([master] + ([sys.stdin.buffer] if watch_stdin else []), [], [], .1)
        if master in readable:
            data = os.read(master, 65536)
            print(json.dumps({'bytes': base64.b64encode(data).decode()}), flush=True)
            joined = tail + data
            consumed = joined.count(b'\x1b[5n')
            tail = joined[-3:]
            if consumed:
                os.write(master, b'\x1b[0n' * consumed)
        if sys.stdin.buffer in readable:
            data = os.read(sys.stdin.fileno(), 65536)
            if not data:
                child.send_signal(signal.SIGTERM)
                watch_stdin = False
                continue
            stdin.extend(data)
            while b'\n' in stdin:
                line, _, rest = stdin.partition(b'\n')
                stdin = bytearray(rest)
                command = json.loads(line)
                if 'bytes' in command:
                    os.write(master, base64.b64decode(command['bytes']))
                if 'resize' in command:
                    cols, rows = command['resize']
                    fcntl.ioctl(slave, termios.TIOCSWINSZ,
                        struct.pack('HHHH', rows, cols, cols * 10, rows * 20))
                    child.send_signal(signal.SIGWINCH)
        if child.poll() is not None:
            # Drain output already queued, including the restoration proof.
            while select.select([master], [], [], 0)[0]:
                data = os.read(master, 65536)
                if not data: break
                print(json.dumps({'bytes': base64.b64encode(data).decode()}), flush=True)
            print(json.dumps({'exit': child.returncode}), flush=True)
            break
finally:
    if child.poll() is None: child.send_signal(signal.SIGTERM)
    child.wait()
    os.close(master)
    os.close(slave)
