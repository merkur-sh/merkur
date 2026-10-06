"""Produce one stable test executable without consuming any test nonce."""
from pathlib import Path
import sys


def generate(source, destination, python, runfile, barriers):
    executable = Path(python)
    if not executable.is_absolute() or not executable.is_file():
        raise ValueError('Exact declared standalone Python File required')
    content = '#!' + python + ' -IB\n' + Path(source).read_text()
    content = content.replace('probe(sys.argv[1], sys.argv[2])',
        'probe(str(Path(os.environ["RUNFILES_DIR"]) / ' + repr(runfile) + '), ' + repr(barriers) + ')')
    Path(destination).write_text(content)
    Path(destination).chmod(0o755)


if __name__ == '__main__':
    generate(*sys.argv[1:])
