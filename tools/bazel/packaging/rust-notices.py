"""Declared Rust attribution intermediate; never claims complete release attribution."""
import hashlib
import importlib.util
import json
import os
import re
from pathlib import Path
import sys

def load(name):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

license_inputs = load('license-inputs')
metadata = load('rust-license-metadata')


def collect(spec):
    if not isinstance(spec, dict) or set(spec) != {'descriptor', 'compiler_root', 'target', 'packages', 'workspace_manifest', 'workspace_license'}:
        raise ValueError('Invalid Rust attribution producer schema')
    descriptor_path = Path(spec['descriptor'])
    descriptor_bytes = descriptor_path.read_bytes()
    descriptor = json.loads(descriptor_bytes)
    configuration = descriptor['configuration']
    if configuration['compiler_root'] != spec['compiler_root'] or configuration['target'] != spec['target']:
        raise ValueError('Rust attribution belongs to another compiler context')
    if len(descriptor['roots']) != 1 or not descriptor['units']:
        raise ValueError('Rust attribution lacks an exact selected compiler root')
    packages = descriptor['packages']
    if set(packages) != set(descriptor['package_sources']) or set(packages) != set(descriptor['package_manifests']) or set(packages) != set(spec['packages']):
        raise ValueError('Rust attribution source or manifest inventory is incomplete')
    reached, active, package_ids = set(), set(), set()
    def visit(unit_id):
        if unit_id in active or unit_id not in descriptor['units']:
            raise ValueError('Cyclic or incomplete selected compiler unit graph')
        if unit_id in reached:
            return
        active.add(unit_id)
        unit = descriptor['units'][unit_id]
        package_ids.add(unit['pkg_id'])
        for dependency in unit['dependencies']:
            visit(dependency['unit'])
        active.remove(unit_id)
        reached.add(unit_id)
    visit(descriptor['roots'][0])
    if reached != set(descriptor['units']) or package_ids != set(packages):
        raise ValueError('Attribution packages differ from the exact compiler dependency closure')
    workspace_manifest = Path(spec['workspace_manifest']).resolve(strict=True)
    if workspace_manifest.name != 'Cargo.toml':
        raise ValueError('Workspace manifest is not the declared Cargo.toml')
    workspace = license_inputs.read_regular(workspace_manifest.parent, workspace_manifest.name)
    workspace_license = Path(spec['workspace_license']).resolve(strict=True)
    if workspace_license != workspace_manifest.parent / 'LICENSE':
        raise ValueError('Repository license belongs to another declared workspace')
    repository_text = license_inputs.read_regular(workspace_manifest.parent, 'LICENSE')
    result = []
    for package_id, package in sorted(packages.items()):
        materialized = spec['packages'][package_id]
        fields = {'root', 'source_label', 'manifest_label'}
        if not isinstance(materialized, dict) or not fields.issubset(materialized) or set(materialized) - fields - {'publisher_sources', 'source_patches'}:
            raise ValueError('Invalid declared Rust package materialization')
        if materialized['source_label'] != descriptor['package_sources'][package_id] or materialized['manifest_label'] != descriptor['package_manifests'][package_id] or package['id'] != package_id:
            raise ValueError('Rust package materialization belongs to another source')
        # A TreeArtifact input may be materialized as individual sandbox file aliases.
        # Its exact Cargo.toml member identifies the regular source tree just produced.
        root = (Path(materialized['root']) / 'Cargo.toml').resolve(strict=True).parent
        manifest = license_inputs.read_regular(root, 'Cargo.toml')
        inherited = metadata.validate(package, manifest, workspace)
        publisher = None
        # Explicit repository ownership: the declared local Rust packages whose
        # effective manifest license is AGPL use this repository's root LICENSE.
        # Third-party/vendored packages must supply their own published texts.
        if 'publisher_sources' in materialized:
            texts, publisher = metadata.publisher_licenses(package, root, materialized['manifest_label'], materialized['publisher_sources'], license_inputs)
        elif package['source'] is None and package['license'] == 'AGPL-3.0-only':
            texts = [{'path': 'LICENSE', 'size': len(repository_text),
                      'sha256': hashlib.sha256(repository_text).hexdigest(),
                      'text': repository_text.decode('utf8'), 'label': '//:LICENSE'}]
            if package['license_file'] is not None or any(re.match(r'^(licen[cs]e|copying|notice|unlicense)', entry.name, re.I) for entry in root.iterdir()):
                texts += license_inputs.collect(root, package['license_file'])
        else:
            texts = license_inputs.collect(root, package['license_file'])
        result.append({key: package[key] for key in ['id', 'name', 'version', 'source', 'license', 'license_file', 'repository', 'archive_checksum']} | {
            'source_label': materialized['source_label'], 'manifest_label': materialized['manifest_label'],
            'manifest_sha256': hashlib.sha256(manifest).hexdigest(), 'inherited_fields': inherited,
            'texts': texts,
        })
        if publisher is not None:
            result[-1]['publisher_source'] = publisher
        if 'source_patches' in materialized:
            patch, license = metadata.maintained_patch(package, root, materialized['source_patches'], workspace_license, license_inputs)
            result[-1]['source_patch'] = patch
            result[-1]['texts'].append(license)
    return {'kind': 'rust-attribution-intermediate', 'configuration': configuration,
            'descriptor_sha256': hashlib.sha256(descriptor_bytes).hexdigest(),
            'workspace_manifest_sha256': hashlib.sha256(workspace).hexdigest(),
            'components': result,
            'pending': ['Complete Bun/compiler runtime attribution', 'Native release source/SDK/profile verification evidence']}


def publish(inventory, inventory_path, notices_path):
    """Create both outputs exclusively; remove only files created by this invocation."""
    lines = ['DECLARED RUST ATTRIBUTION', 'Compiler root: ' + inventory['configuration']['compiler_root'], '']
    for item in inventory['components']:
        lines += ['-' * 78, item['name'] + ' ' + item['version'], 'Package identity: ' + item['id'], '']
        for text in item['texts']:
            lines += [text['path'] + ' SHA-256 ' + text['sha256'], text['text'], '']
    payloads = [(Path(inventory_path), (json.dumps(inventory, sort_keys=True, separators=(',', ':'), ensure_ascii=False) + '\n').encode('utf8')),
                (Path(notices_path), '\n'.join(lines).encode('utf8'))]
    publish_bytes(payloads)


def publish_bytes(payloads):
    """Publish exact bytes through held parent capabilities; cleanup all owned outputs."""
    owned, handles, prepared, failures = [], [], [], []
    parents = {}
    def verify_parent(logical, physical, descriptor):
        current = logical.resolve(strict=True)
        pinned = os.fstat(descriptor)
        actual = current.stat()
        if current != physical or (actual.st_dev, actual.st_ino) != (pinned.st_dev, pinned.st_ino):
            raise ValueError('Attribution output parent ownership changed')
    try:
        # Capture BOTH output parent capabilities before any output side effect.
        # Later parent replacement cannot redirect another output or cleanup.
        for path, data in payloads:
            logical = path.absolute().parent
            physical = logical.resolve(strict=True)
            if physical not in parents:
                parent = os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
                handles.append(parent)
                for part in physical.parts[1:]:
                    parent = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
                    handles.append(parent)
                parents[physical] = parent
            parent = parents[physical]
            verify_parent(logical, physical, parent)
            prepared.append((logical, physical, parent, path.name, data))
        for logical, physical, parent, name, data in prepared:
            verify_parent(logical, physical, parent)
            descriptor = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644, dir_fd=parent)
            identity = os.fstat(descriptor)
            owned.append((parent, name, identity.st_dev, identity.st_ino))
            handles.append(descriptor)
            with os.fdopen(descriptor, 'wb', closefd=False) as stream:
                stream.write(data)
            verify_parent(logical, physical, parent)
        for parent, name, device, inode in owned:
            current = os.stat(name, dir_fd=parent, follow_symlinks=False)
            if (current.st_dev, current.st_ino) != (device, inode):
                raise ValueError('Attribution output identity changed during publication')
    except BaseException as primary:
        failures.append(primary)
        for parent, name, device, inode in reversed(owned):
            try:
                current = os.stat(name, dir_fd=parent, follow_symlinks=False)
                if (current.st_dev, current.st_ino) != (device, inode):
                    raise ValueError('Attribution output ownership changed during cleanup')
                os.unlink(name, dir_fd=parent)
            except BaseException as error:
                failures.append(error)
    finally:
        for descriptor in reversed(handles):
            try:
                os.close(descriptor)
            except BaseException as error:
                failures.append(error)
    if len(failures) > 1:
        raise BaseExceptionGroup('Attribution publication and cleanup failed', failures)
    if failures:
        raise failures[0]


if __name__ == '__main__':
    with open(sys.argv[1], encoding='utf8') as source:
        inventory = collect(json.load(source))
    publish(inventory, sys.argv[2], sys.argv[3])
