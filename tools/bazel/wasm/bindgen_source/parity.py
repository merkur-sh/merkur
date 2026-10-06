"""Compare the actual source CLI and original published CLI on declared WASM."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess


def fact(file):
    return {'size': file.stat().st_size, 'sha256': hashlib.sha256(file.read_bytes()).hexdigest()}


def run(executable, name, arguments, directory):
    home = directory / 'home'
    home.mkdir(exist_ok=True)
    result = subprocess.run([name, *arguments], executable=str(executable),
        env={'PATH': '', 'LC_ALL': 'C', 'HOME': str(home)}, capture_output=True)
    if result.returncode:
        raise ValueError(name + ' actual CLI refused: ' + result.stderr.decode())
    return result.stdout, result.stderr


def compare(args):
    args.directory.mkdir(parents=True, exist_ok=False)
    records = []
    for name, source, reference in [
        ('wasm-bindgen', args.source_bindgen, args.reference_bindgen),
        ('wasm-bindgen-test-runner', args.source_runner, args.reference_runner),
    ]:
        for flag in ['--version', '--help']:
            expected = run(reference, name, [flag], args.directory)
            observed = run(source, name, [flag], args.directory)
            if observed != expected:
                raise ValueError('Source/published CLI output differs for ' + name + ' ' + flag)
            records.append({'name': name, 'argument': flag, 'argv0': name,
                            'source': fact(source), 'reference': fact(reference),
                            'stdout_sha256': hashlib.sha256(observed[0]).hexdigest(),
                            'stderr_sha256': hashlib.sha256(observed[1]).hexdigest()})
    outputs = []
    # These are the original wasm_bindings action's exact flags and module name.
    for name, executable in [('source', args.source_bindgen), ('reference', args.reference_bindgen)]:
        directory = args.directory / name
        directory.mkdir()
        run(executable, 'wasm-bindgen', [str(args.wasm), '--target', 'web',
            '--out-name', args.module_name, '--out-dir', str(directory)], args.directory)
        members = {}
        for file in sorted(directory.rglob('*')):
            if not file.is_file() or file.is_symlink():
                raise ValueError('CLI parity output is not an original regular member File')
            members[str(file.relative_to(directory))] = fact(file)
        if not members or not any(member.endswith('.wasm') for member in members):
            raise ValueError('Actual CLI output lacks its declared WASM member')
        outputs.append(members)
    if outputs[0] != outputs[1]:
        raise ValueError('Source/published original WASM binding member bytes differ')
    return {'cli_controls': records, 'wasm_input': fact(args.wasm),
            'arguments': ['--target', 'web', '--out-name', args.module_name],
            'members': outputs[0], 'scope': 'Darwin ARM original CLI and one real compiled production WASM input',
            'pending': ['Compiled generator source/license providers', 'Other native platforms',
                        'Browser/test-runner execution', 'Remaining production WASM package/PGO/profile parity']}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ['source-bindgen', 'source-runner', 'reference-bindgen', 'reference-runner', 'wasm', 'directory']:
        parser.add_argument('--' + name, type=Path, required=True)
    parser.add_argument('--module-name', required=True)
    args = parser.parse_args()
    value = compare(args)
    (args.directory / 'result.json').write_text(json.dumps(value, indent=2) + '\n')
    print(json.dumps(value, indent=2))
