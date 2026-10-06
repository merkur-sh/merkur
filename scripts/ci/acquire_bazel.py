"""CI control-plane bootstrap; verify the official native binary before execution."""
import hashlib
import json
from pathlib import Path
import platform
import subprocess
import sys
import urllib.request


def acquire(pins, directory):
    if set(pins) != {'version', 'binaries'} or pins['version'] != '9.2.0':
        raise ValueError('unexpected engine pin contract')
    if platform.system() not in ('Darwin', 'Linux'):
        raise ValueError('unsupported CI operating system')
    cpu = {'aarch64': 'arm64', 'arm64': 'arm64', 'x86_64': 'x86_64'}.get(platform.machine())
    if cpu is None:
        raise ValueError('unsupported native CI CPU')
    native = platform.system().lower() + '-' + cpu
    expected = pins['binaries'][native]
    root = Path(directory)
    root.mkdir(parents=True, exist_ok=True)
    output = root / 'bazel'
    url = f'https://github.com/bazelbuild/bazel/releases/download/{pins["version"]}/bazel-{pins["version"]}-{native}'
    digest = hashlib.sha256()
    created = False
    try:
        with urllib.request.urlopen(url) as source, output.open('xb') as target:
            created = True
            while chunk := source.read(1024 * 1024):
                digest.update(chunk)
                target.write(chunk)
        if digest.hexdigest() != expected:
            raise ValueError('official Bazel payload differs from the content pin')
        output.chmod(0o555)
        result = subprocess.run([str(output), '--version'], check=True, capture_output=True, text=True,
                                env={'PATH': '', 'HOME': str(root), 'TMPDIR': str(root)})
        if result.stdout.strip() != 'bazel ' + pins['version']:
            raise ValueError('pinned Bazel reported an unexpected version')
    except BaseException:
        if created:
            output.unlink(missing_ok=True)
        raise
    return output


if __name__ == '__main__':
    print(acquire(json.loads(Path(sys.argv[1]).read_bytes()), sys.argv[2]))
