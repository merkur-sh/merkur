"""Original locked npm member/notice authority for actual embedded compiler inputs."""

import hashlib
import json
from pathlib import Path


def npm_catalog(specification, pins, source_pins, npm, custody, deployment):
    # Reuse the existing original lock/integrity/archive/member parser. These
    # bytes come from declared original archives, never an installed resolver.
    owned = deployment.DeclaredInputs()
    try:
        files, _ = npm.collect(specification, pins, source_pins, custody, deployment, owned)
        names = npm.cache_names({item['name'] + '@' + item['version']: item for item in pins['packages']})
        result = {}
        for identity, namespace in names.items():
            prefix = namespace + '/'
            members = {name[len(prefix):]: body for name, body in files.items() if name.startswith(prefix)}
            if not members:
                raise ValueError('Original npm archive has no actual package members')
            result[identity] = members
        owned.verify()
        return result
    finally:
        owned.close()


def bind_npm_source(selected, source, packages, linked, licenses, original_notices=None):
    source, selected = Path(source).absolute(), Path(selected)
    if not selected.is_absolute() or '..' in selected.parts or not selected.is_relative_to(source):
        raise ValueError('Embedded npm input escaped its original source namespace')
    # A package boundary is established by its actual original published
    # manifest bytes, not by guessing a package from the selected basename.
    candidates = []
    for directory in selected.parents:
        if directory == source:
            break
        try:
            raw = licenses.read_regular(directory, 'package.json', require_text=True)
        except FileNotFoundError:
            continue
        manifest = json.loads(raw)
        if not isinstance(manifest, dict):
            raise ValueError('Original npm package manifest is malformed')
        if not isinstance(manifest.get('name'), str) or not isinstance(manifest.get('version'), str):
            continue  # Original packages may publish a nested module-type manifest.
        identity = manifest['name'] + '@' + manifest['version']
        members = packages.get(identity)
        relative = selected.relative_to(directory).as_posix()
        if members is None or members.get('package.json') != raw or relative not in members:
            continue
        candidates.append((directory, identity, members))
    if not candidates:
        raise linked.PendingLinkedSource('Selected npm source lacks original locked archive/member authority: ' + str(selected))
    # Nearest verified original manifest owns its published member namespace.
    directory, identity, members = candidates[0]
    origin = {'component': identity, 'namespace': str(directory), 'directory': directory,
              'members': members, 'aliases': {}}
    bound = linked.bind_original_inputs([str(selected)], [origin], licenses)[0]
    try:
        texts = licenses.collect(directory)
    except ValueError as error:
        if str(error) != 'Declared package has no published license text':
            raise
        selected_notice = None if original_notices is None else original_notices(identity, directory)
        if selected_notice is None:
            raise linked.PendingLinkedSource('Original locked npm package has no declared published notice member: ' + identity) from error
        original, member = selected_notice
        licenses.relative(member)
        if original['component'] != identity:
            raise ValueError('Published npm notice declaration belongs to another package identity')
        raw = licenses.read_regular(directory, member, require_text=True)
        if members.get(member) != raw or original['members'].get(member) != raw:
            raise ValueError('Published npm notice differs from its original npm/publisher commit members')
        texts = licenses.collect(directory, license_file=member)
    notices = []
    for text in texts:
        raw = licenses.read_regular(directory, text['path'], require_text=True)
        if members.get(text['path']) != raw:
            raise ValueError('Selected npm license differs from its original published archive bytes')
        notices.append({'path': (directory / text['path']).relative_to(source).as_posix(),
                        'size': len(raw), 'sha256': hashlib.sha256(raw).hexdigest()})
    return bound, notices
