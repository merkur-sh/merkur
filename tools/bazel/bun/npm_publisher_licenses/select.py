"""Bind six authored README notices to locked npm and exact publisher commit bytes."""

import base64
import hashlib
import json
from pathlib import Path


def repository_name(value):
    if not isinstance(value, dict) or value.get('type') != 'git':
        raise ValueError('Original publisher repository must be explicit Git metadata')
    url = value.get('url', '')
    for prefix in ('git@github.com:', 'git+ssh://git@github.com/'):
        if url.startswith(prefix):
            name = url[len(prefix):]
            if name.endswith('.git'):
                name = name[:-4]
            if len(name.split('/')) == 2 and all(name.split('/')):
                return name
    raise ValueError('Original publisher repository does not name an exact public GitHub source')


def checked(raw, fact, authority):
    if (not isinstance(raw, bytes) or len(raw) != fact['size'] or
            hashlib.sha256(raw).hexdigest() != fact['sha256']):
        raise ValueError('Changed original ' + authority + ' bytes')
    return raw


def declaration(identity, pins, original_catalog):
    entries = [item for item in pins['packages']
               if item['package']['name'] + '@' + item['package']['version'] == identity]
    if len(entries) != 1:
        raise ValueError('Publisher notice requires one exact declared package identity')
    entry = entries[0]
    locked = [item for item in original_catalog['packages']
              if item['name'] + '@' + item['version'] == identity]
    if locked != [entry['package']]:
        raise ValueError('Publisher notice package differs from the original Bun npm lock')
    return entry


def select(identity, pins, original_catalog, metadata_raw, npm_raw, source_raw,
           namespace, directory, custody, linked, licenses):
    """Return only the existing (archive_origin, exact notice member) contract.

    Callers read original declared Files, then collect the entire installed README
    using license_inputs.collect(..., license_file=member). No paragraph extraction
    or complete native/runtime attribution is performed here.
    """
    entry = declaration(identity, pins, original_catalog)
    package = entry['package']
    metadata = json.loads(checked(metadata_raw, entry['metadata'], 'publisher metadata'))
    npm_raw = checked(npm_raw, entry['npm'], 'locked npm archive')
    source_raw = checked(source_raw, entry['source'], 'publisher commit archive')
    algorithm, checksum = package['integrity'].split('-', 1)
    if algorithm != 'sha512' or base64.b64encode(hashlib.sha512(npm_raw).digest()).decode() != checksum:
        raise ValueError('Original npm archive integrity differs from Bun lock')
    if (metadata.get('name'), metadata.get('version')) != (package['name'], package['version']):
        raise ValueError('Publisher metadata differs from the exact locked package')
    if (metadata.get('gitHead') != entry['source']['gitHead'] or
            metadata.get('repository') != entry['source']['repository']):
        raise ValueError('Publisher gitHead/repository differs from the original commit')
    dist = metadata.get('dist', {})
    if (dist.get('integrity'), dist.get('tarball')) != (package['integrity'], package['url']):
        raise ValueError('Publisher metadata does not bind the original npm archive')
    repo = repository_name(metadata['repository'])
    if entry['source']['url'] != 'https://codeload.github.com/' + repo + '/tar.gz/' + metadata['gitHead']:
        raise ValueError('Publisher commit archive URL differs from its exact gitHead')
    npm, facts = custody.source_archive_members(npm_raw, {'source': entry['npm']}, licenses.relative)
    if any(fact['kind'] != 'file' for fact in facts):
        raise ValueError('Original locked npm package has an unsupported member alias')
    origin = linked.archive_origin(identity, namespace, directory, source_raw,
                                   {'source': entry['source']}, custody, licenses)
    original = origin['members']
    manifest_raw = checked(npm[entry['manifest']['member']], entry['manifest'], 'npm manifest member')
    if original.get(entry['manifest']['member']) != manifest_raw:
        raise ValueError('Publisher commit manifest differs from the original npm manifest')
    manifest = json.loads(manifest_raw)
    if ((manifest.get('name'), manifest.get('version')) != (package['name'], package['version']) or
            manifest.get('license') != metadata.get('license') or
            repository_name(manifest.get('repository')) != repo):
        raise ValueError('Original package/source manifest relation differs from publisher metadata')
    # Exact original npm packaging aliases are pinned from observed member bytes;
    # no source is omitted or inferred from a name, tag, SPDX expression or template.
    aliases = entry['published_aliases']
    for member, raw in npm.items():
        if original.get(aliases.get(member, member)) != raw:
            raise ValueError('Published npm member differs from its exact original commit: ' + member)
    notice = entry['notice']['member']
    licenses.relative(notice)
    raw = checked(npm[notice], entry['notice'], 'authored notice member')
    if original.get(notice) != raw or not raw.decode('utf8').strip():
        raise ValueError('Authored notice differs from the exact original publisher member')
    return origin, notice


def from_files(identity, pins, original_catalog, inputs, npm_archive, namespace,
               directory, custody, linked, licenses):
    """Use existing original declared-file reads; no downloads or ambient lookup."""
    def read(value):
        path = Path(value).resolve(strict=True)
        return licenses.read_regular(path.parent, path.name, require_text=False)
    if set(inputs) != {'metadata', 'source'}:
        raise ValueError('Publisher notice requires its exact metadata and source archive Files')
    return select(identity, pins, original_catalog, read(inputs['metadata']),
                  read(npm_archive), read(inputs['source']), namespace, directory,
                  custody, linked, licenses)
