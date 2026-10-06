"""Exercise the emitted fish launcher through an isolated, attached tmux client."""

import fcntl
import os
import pathlib
import select
import shlex
import struct
import subprocess
import sys
import tempfile
import termios
import time


PROGRAM = r'''import json, os, pathlib, sys, termios, tty
root = pathlib.Path(os.environ['MERKUR_POPUP_PROBE'])
old = termios.tcgetattr(0)
tty.setraw(0)
try:
    # Merkur's renderer must receive tmux's host-consumption fence response.
    os.write(1, b'\x1b[5n')
    fence = b''
    while len(fence) < 4:
        fence += os.read(0, 4 - len(fence))
    assert fence == b'\x1b[0n', fence
    assert os.get_terminal_size(0) == (80, 24)
    (root / 'launched').write_text(json.dumps({'argv': sys.argv[1:], 'cwd': os.getcwd()}))
    data = b''
    while len(data) < 9:
        data += os.read(0, 9 - len(data))
    (root / 'received').write_text(data.hex())
finally:
    termios.tcsetattr(0, termios.TCSANOW, old)
sys.exit(37)
'''


def controlling_terminal():
    os.setsid()
    fcntl.ioctl(0, termios.TIOCSCTTY, 0)


def run(snippet):
    import json

    original_cwd = os.getcwd()
    with tempfile.TemporaryDirectory(prefix='merkur-fish-popup-') as temporary:
        root = pathlib.Path(temporary)
        socket = 'socket'
        # UNIX socket addresses are relative to this fixture's owned cwd.
        # Keep the original cwd-preservation assertion against that actual cwd.
        os.chdir(root)
        # A declaring runner names every tool and nothing else is on PATH. A source run
        # names the host's tools and passes the host PATH they find their own data through.
        host_path = os.environ.get('MERKUR_SHELL_TEST_HOST_PATH')
        tools = {}
        for name in ('fish', 'tmux', 'python', 'bash', 'zsh', 'sh', 'env', 'cat', 'touch'):
            value = os.environ.get('MERKUR_SHELL_TEST_' + name.upper())
            if value is None and host_path is not None:
                continue
            if value is None:
                raise ValueError('Missing executable declared shell test utility: ' + name)
            path = pathlib.Path(value)
            if not path.is_absolute() or not path.is_file() or not os.access(path, os.X_OK):
                raise ValueError('Missing executable declared shell test utility: ' + name)
            tools[name] = str(path)
        tmux, fish = tools['tmux'], tools['fish']
        fish_args = ['--no-config', '--init-command',
                     'if set -q MERKUR_SHELL_TEST_DYLD_LIBRARY_PATH; set -gx DYLD_FALLBACK_LIBRARY_PATH "$MERKUR_SHELL_TEST_DYLD_LIBRARY_PATH"; end']
        env = {name: os.environ[name] for name in ('LD_LIBRARY_PATH', 'DYLD_FALLBACK_LIBRARY_PATH', 'TERMINFO', 'TERMINFO_DIRS', 'FPATH', 'MERKUR_SHELL_TEST_DYLD_LIBRARY_PATH') if name in os.environ}
        env.update(HOME=str(root), TMPDIR=str(root), SHELL=tools['bash'], MERKUR_TMUX_SHELL=tools['sh'])
        for name in ['TMUX', 'TMUX_PANE', 'MERKUR_SHELL_TOKEN']:
            env.pop(name, None)
        env['TERM'] = 'xterm-256color'
        bin_path = root / 'bin with spaces'
        bin_path.mkdir()
        executable = bin_path / 'merkur'
        executable.write_text('#!' + str(pathlib.Path(tools['env']).resolve(strict=True)) + ' python3\n' + PROGRAM)
        executable.chmod(0o755)
        if host_path is None:
            for name, value in tools.items():
                (bin_path / ('python3' if name == 'python' else name)).symlink_to(value)
            env['PATH'] = str(bin_path)
        else:
            env['PATH'] = str(bin_path) + ':' + host_path
        config = root / 'tmux.conf'
        config.write_text('set -g default-shell ' + shlex.quote(tools['bash']) + '\n')
        env['MERKUR_POPUP_PROBE'] = str(root)
        env['MERKUR_POPUP_SNIPPET'] = str(snippet)
        driver = root / 'driver.fish'
        driver.write_text('''tmux wait-for probe-client-ready
source "$MERKUR_POPUP_SNIPPET"
merkur connect 'machine with spaces' --state-dir 'state with spaces'
printf '%s' $status > "$MERKUR_POPUP_PROBE/status"
exec fish --no-config
''')

        def ctl(*args):
            return subprocess.check_output([tmux, '-S', socket, *args], env=env).decode()

        master, slave = os.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 24, 80, 480, 800))
        output = bytearray()
        child = None

        def wait(condition):
            deadline = time.monotonic() + 10
            while not condition():
                if time.monotonic() > deadline:
                    raise AssertionError(('timeout waiting for fixture event', output[-2000:]))
                if select.select([master], [], [], .025)[0]:
                    output.extend(os.read(master, 65536))

        try:
            ctl('-f', str(config), 'new-session', '-d', '-s', 'fixture', fish, *fish_args, str(driver))
            ctl('bind-key', '-n', 'F6', 'run-shell', shlex.quote(tools['touch']) + ' "' + str(root / 'outer-F6') + '"')
            original = (ctl('show-options', '-A', '-t', 'fixture'), ctl('list-keys'))
            child = subprocess.Popen(
                [tmux, '-S', socket, 'attach-session', '-t', 'fixture'],
                stdin=slave, stdout=slave, stderr=slave, env=env,
                preexec_fn=controlling_terminal,
            )
            wait(lambda: bool(ctl('list-clients', '-t', 'fixture').strip()))
            ctl('wait-for', '-S', 'probe-client-ready')
            wait(lambda: (root / 'launched').exists())
            launch = json.loads((root / 'launched').read_text())
            assert launch == {
                'argv': ['connect', 'machine with spaces', '--state-dir', 'state with spaces'],
                'cwd': os.getcwd(),
            }, launch
            os.write(master, b'\x02c\x03\x1b\x1b[17~')
            wait(lambda: (root / 'status').exists() and (root / 'status').stat().st_size > 0)
            assert (root / 'status').read_text() == '37'
            assert (root / 'received').read_text() == '0263031b1b5b31377e'
            assert not (root / 'outer-F6').exists(), 'outer root binding consumed popup input'
            assert len(ctl('list-windows', '-t', 'fixture').splitlines()) == 1
            assert original == (ctl('show-options', '-A', '-t', 'fixture'), ctl('list-keys'))
            os.write(master, b'\x1b[17~')
            wait(lambda: (root / 'outer-F6').exists())
            os.write(master, b'\x02c')
            wait(lambda: len(ctl('list-windows', '-t', 'fixture').splitlines()) == 2)
            print('popup input, host fence, arguments and restoration passed')
        finally:
            # Only this fixture's private server and attachment are owned here.
            subprocess.run([tmux, '-S', socket, 'kill-server'], env=env,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            # Closing the PTY releases a client blocked draining its final output.
            os.close(master)
            os.close(slave)
            if child is not None:
                child.kill()
                child.wait(timeout=5)
            os.chdir(original_cwd)


if __name__ == '__main__':
    run(pathlib.Path(sys.argv[1]))
