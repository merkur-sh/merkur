"""Extract original shell utility archives and use the existing native SDK validator."""
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import tarfile

def load(path):
    spec = importlib.util.spec_from_file_location('native_sdk', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

def relocate_pc(root):
    for paths in sorted((root / '.package-metadata').glob('*/info/paths.json')):
        package = paths.parent.parent
        for item in json.loads(paths.read_text())['paths']:
            logical = Path(item['_path'])
            if item.get('file_mode') != 'text' or logical.suffix != '.pc':
                continue
            if len(logical.parts) != 3 or logical.parts[:2] not in [('lib', 'pkgconfig'), ('share', 'pkgconfig')]:
                raise ValueError('Original pkg-config text prefix has an unsupported declared SDK location')
            source = root / logical
            data = source.read_bytes()
            if hashlib.sha256(data).hexdigest() != item['sha256']:
                raise ValueError('Original pkg-config File differs from its package metadata')
            prefix = item['prefix_placeholder'].encode()
            retained = package / 'payload' / logical
            retained.parent.mkdir(parents=True, exist_ok=True)
            retained.write_bytes(data)
            source.write_bytes(data.replace(prefix, b'${pcfiledir}/../..'))


def extract(specification, destination, cpu, binaries, validator):
    root = Path(destination)
    modern = []
    legacy = []
    for item in specification:
        if not item['archive'].endswith('.tar.bz2'):
            modern.append(item)
            continue
        archive = Path(item['path'])
        if hashlib.sha256(archive.read_bytes()).hexdigest() != item['sha256']:
            raise ValueError('Original shell package digest mismatch')
        with tarfile.open(archive) as source:
            for member in source.getmembers():
                path = Path(member.name)
                if path.is_absolute() or not path.parts or '..' in path.parts or path.parts[0] in ('.bootstrap', '.archives', '.package-metadata'):
                    raise ValueError('Unsafe original shell package member')
            for member in source.getmembers():
                prefix = root / '.package-metadata' / item['name'] / 'payload' if Path(member.name).parts[0] == 'info' else root
                source.extract(member, prefix, filter='data')
        legacy.append({key: item[key] for key in ('name', 'url', 'sha256')})
    original = validator.extract(modern, root, cpu, binaries)
    relocate_pc(root)
    manifest = validator.extract([], root, cpu, binaries)
    manifest['packages'] = original['packages'] + legacy
    return manifest

if __name__ == '__main__':
    specification = json.loads(Path(sys.argv[1]).read_text())
    validator = load(sys.argv[6])
    manifest = extract(specification, sys.argv[2], int(sys.argv[4]), json.loads(sys.argv[5]), validator)
    Path(sys.argv[3]).write_text(json.dumps(manifest, sort_keys=True, indent=2) + '\n')
