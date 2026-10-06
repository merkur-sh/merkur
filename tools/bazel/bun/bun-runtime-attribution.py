"""Bind declared Bun compiler/runtime Files to original source and license bytes.

This is source custody, not selected embedded-runtime attribution. Original
publisher linked-object/source and generator facts remain required separately.
"""
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import sys
import tarfile
import zipfile


def load(name, path):
    specification = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(module)
    return module


def digest(data):
    return hashlib.sha256(data).hexdigest()


def captured(path, owned, executable=False):
    pinned, size, sha = owned.file(owned.presentation(path), executable=executable)
    return owned.read(pinned), {'size': size, 'sha256': sha}


def source_archive_members(data, pins, relative):
    if digest(data) != pins['source']['sha256']:
        raise ValueError('Bun source differs from the pinned original commit archive')
    prefix = pins['source']['prefix'] + '/'
    members, facts = {}, []
    with tarfile.open(fileobj=io.BytesIO(data)) as archive:
        seen = set()
        for entry in archive:
            if entry.name.rstrip('/') == pins['source']['prefix'] and entry.isdir():
                continue
            if not entry.name.startswith(prefix):
                raise ValueError('Bun original archive has a foreign source prefix')
            name = relative(entry.name[len(prefix):].rstrip('/'))
            if name in seen:
                raise ValueError('Bun original archive has a duplicate source member')
            seen.add(name)
            if entry.isdir():
                continue
            if entry.isfile():
                body = archive.extractfile(entry).read()
                members[name] = body
                facts.append({'path': name, 'kind': 'file', 'mode': entry.mode & 0o777,
                              'size': len(body), 'sha256': digest(body)})
            elif entry.issym():
                # Original aliases are inventoried literally and never followed.
                facts.append({'path': name, 'kind': 'symlink', 'target': entry.linkname})
            else:
                raise ValueError('Bun original archive has unsupported source member kind')
    return members, sorted(facts, key=lambda fact: fact['path'])


def source_members(data, pins, relative):
    members, facts = source_archive_members(data, pins, relative)
    manifest = json.loads(members['package.json'])
    if manifest.get('name') != 'bun' or manifest.get('version') != pins['version']:
        raise ValueError('Original source package is not the declared Bun release')
    return members, facts


def collect(specification, pins, owned, deployment):
    if set(specification) != {'producer', 'compile_target', 'configuration', 'runtime', 'runtime_archive', 'source_archive'}:
        raise ValueError('Exact declared Bun compiler/runtime source custody required')
    context_bytes, context_fact = captured(specification['configuration'], owned)
    context = json.loads(context_bytes)
    producer = deployment.descriptor({'input': specification['configuration'], 'label': specification['producer']})['label']
    if context.get('producer') != producer or context.get('compile_target') != specification['compile_target']:
        raise ValueError('Bun source custody differs from its original compiler context')
    target = specification['compile_target']
    if target not in pins['runtimes']:
        raise ValueError('Bun source custody requires one of the four declared native runtimes')
    runtime_pin = pins['runtimes'][target]
    archive_bytes, archive_fact = captured(specification['runtime_archive'], owned)
    if archive_fact['sha256'] != runtime_pin['sha256']:
        raise ValueError('Bun runtime archive differs from original publisher release')
    with zipfile.ZipFile(io.BytesIO(archive_bytes)) as archive:
        names = archive.namelist()
        if len(names) != len(set(names)) or names.count(runtime_pin['member']) != 1:
            raise ValueError('Original Bun ZIP has ambiguous runtime member custody')
        member = archive.getinfo(runtime_pin['member'])
        if member.is_dir() or not (member.external_attr >> 16) & 0o111:
            raise ValueError('Original Bun ZIP runtime member is not executable')
        original_runtime = archive.read(member)
    runtime_bytes, runtime_fact = captured(specification['runtime'], owned, executable=True)
    if runtime_bytes != original_runtime:
        raise ValueError('Compiler runtime File differs from its original release member')
    source_bytes, source_fact = captured(specification['source_archive'], owned)
    members, available = source_members(source_bytes, pins, deployment.license_inputs.relative)
    originals, licenses, build_inputs = {}, [], []
    for name, sha in pins['license_members'].items():
        body = members.get(name)
        if body is None or digest(body) != sha or not body.decode('utf8').strip():
            raise ValueError('Bun original declared license bytes are absent or changed')
        originals[name] = body
        licenses.append({'path': name, 'size': len(body), 'sha256': sha})
    for name in pins['build_inputs']:
        body = members.get(name)
        if body is None or name in {fact['path'] for fact in build_inputs}:
            raise ValueError('Bun original build input is absent or repeated')
        originals[name] = body
        build_inputs.append({'path': name, 'size': len(body), 'sha256': digest(body)})
    if not licenses or not build_inputs or not available:
        raise ValueError('Bun original source/license/build custody is empty')
    result = {'kind': 'bun-runtime-source-custody', 'version': pins['version'],
              'commit': pins['commit'], 'producer': producer, 'compile_target': target,
              'configuration': context_fact, 'runtime_archive': archive_fact,
              'runtime_member': runtime_pin['member'], 'runtime': runtime_fact,
              'source_archive': source_fact, 'available_source_members': available,
              'licenses': licenses, 'build_inputs': build_inputs,
              'required_selection': ['original publisher linked-object/source membership',
                                     'original generated-runtime source inputs',
                                     'original selected third-party source/license closure']}
    owned.verify()
    return result, originals


def produce(specification, pins, originals, deployment, output_tree):
    owned = deployment.DeclaredInputs()
    tree = None
    try:
        result, members = collect(specification, pins, owned, deployment)
        tree = output_tree.OutputTree(originals)
        for name, body in sorted(members.items()):
            tree.write(name, body)
        tree.verify()
        owned.verify()
        tree.write('source-custody.json', deployment.pack.canonical(result))
        owned.verify()
        tree.verify()
    except BaseException as primary:
        if tree is not None:
            try:
                tree.cleanup()
            except BaseException as cleanup:
                raise BaseExceptionGroup('Bun source custody publication and cleanup failed', [primary, cleanup])
        raise
    finally:
        if tree is not None:
            tree.close()
        owned.close()


if __name__ == '__main__':
    spec, pins, originals, deployment, output_tree = sys.argv[1:]
    produce(json.loads(Path(spec).read_bytes()), json.loads(Path(pins).read_bytes()),
            originals, load('declared_deployment', deployment),
            load('declared_output_tree', output_tree))
