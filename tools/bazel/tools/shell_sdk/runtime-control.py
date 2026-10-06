"""Run original tmux jobs with declared native tools, including failing shell bindings."""
import importlib.util
import json
import os
from pathlib import Path
import shlex
import subprocess
import sys
import tempfile


def controls(engine, shell, sdk, builder, specification, action_root):
    engine, shell, sdk = Path(engine), Path(shell), Path(sdk)
    with tempfile.TemporaryDirectory(prefix='merkur-tmux-control-') as temporary:
        root = Path(temporary)
        socket = 'socket'
        environment = {'HOME': str(root), 'TMPDIR': str(root), 'PATH': str(sdk / 'bin'),
                       'TERM': 'xterm-256color', 'TERMINFO': str(sdk / 'share/terminfo'),
                       'TERMINFO_DIRS': str(sdk / 'share/terminfo'),
                       'MERKUR_TMUX_SHELL': str(shell), 'SHELL': str(shell)}
        environment['DYLD_FALLBACK_LIBRARY_PATH' if sys.platform == 'darwin' else 'LD_LIBRARY_PATH'] = str(sdk / 'lib')
        def command(*args, env=environment):
            return subprocess.run([str(engine), '-S', str(socket), *args], env=env,
                                  text=True, capture_output=True, cwd=root)
        for invalid in [None, 'bash', str(root / 'absent-shell')]:
            changed = dict(environment)
            if invalid is None:
                del changed['MERKUR_TMUX_SHELL']
            else:
                changed['MERKUR_TMUX_SHELL'] = invalid
            result = command('-f', '/dev/null', 'new-session', '-d', '-s', 'fixture', env=changed)
            assert result.returncode != 0, (invalid, result.stdout, result.stderr)
            assert 'declared MERKUR_TMUX_SHELL' in result.stderr, result.stderr
        configuration = root / 'tmux.conf'
        configuration.write_text('set -g default-shell ' + shlex.quote(str(shell)) + '\n')
        launched = False
        try:
            result = command('-f', str(configuration), 'new-session', '-d', '-s', 'fixture')
            assert result.returncode == 0, result.stderr
            launched = True
            output = root / 'job-result'
            result = command('run-shell', 'printf declared-job > ' + shlex.quote(str(output)))
            assert result.returncode == 0 and result.stderr == '', (result.stdout, result.stderr)
            assert output.read_text() == 'declared-job'
        finally:
            if launched:
                result = command('kill-server')
                assert result.returncode == 0, result.stderr
    module_spec = importlib.util.spec_from_file_location('tmux_source_build', builder)
    module = importlib.util.module_from_spec(module_spec)
    module_spec.loader.exec_module(module)
    original = json.loads(Path(specification).read_text())
    module.tool_paths(original, Path(action_root))
    foreign = dict(original, shell='/bin/sh')
    try:
        module.tool_paths(foreign, Path(action_root))
    except ValueError as error:
        assert 'declared executable File closure' in str(error)
    else:
        raise AssertionError('foreign shell File admitted to the actual configured source producer')
    print('tmux original source: three failing shell bindings, original job, checked cleanup and foreign File controls passed')


if __name__ == '__main__':
    controls(*sys.argv[1:])
