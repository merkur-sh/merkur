"""Join original linker-selected stdlib Files to pinned original source notices.

This is an incomplete source attribution intermediate. It never advertises a
complete shipping scope: original binary-distribution notice/component closure
is still required by the compiled Rust attribution consumer.
"""
import argparse
import hashlib
import html
import importlib.util
import io
import json
from pathlib import Path, PurePosixPath
import re
import tarfile
import tomllib


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


SOURCE_SHA256 = '0ed06fdaffd4722a7702e0b4eebfafc897ab8f513e8e1b247cdd7e5c6df6ded2'
VERSION = '1.97.1'
PREFIX = 'rustc-' + VERSION + '-src/'
NATIVE_TARGETS = ('aarch64-apple-darwin', 'x86_64-apple-darwin',
                  'aarch64-unknown-linux-gnu', 'x86_64-unknown-linux-gnu')
WASM_TARGET = 'wasm32-unknown-unknown'
TARGETS = (*NATIVE_TARGETS, WASM_TARGET)
SOURCE_MEMBERS = ('LICENSE-MIT', 'LICENSE-APACHE', 'COPYRIGHT', 'REUSE.toml',
                  'license-metadata.json', 'library/Cargo.lock', 'library/Cargo.toml',
                  'library/std/Cargo.toml', 'src/version', 'src/ci/channel')
DISTRIBUTIONS = {
    'aarch64-apple-darwin': ('a4895f5c6995e83cab8687e46b14324592398049def71ce75ca308c981cf200d', '6076cad38ccabaa24325f26a74080a363a2633a9cd34c473a8977255d8a593cb'),
    'x86_64-apple-darwin': ('0fa78653023be5bdfeb419edc82e3b1346ccaa23eaa036491cce084101c741dd', '3c38289f319bf02fa1c8149ce3e00f261e4efd14813a99f7f7ae4f180c7d1173'),
    'aarch64-unknown-linux-gnu': ('46aed8e63186350004d8ec6afca798811e6530b514352e5a8a26f3dc4939b3be', 'b344b81f0cd4c2246c7da8b197fe7a339d7dd02bb15cb69b2524115d9c75224c'),
    'x86_64-unknown-linux-gnu': ('1c1e704ae80126b7de34f72ea2825f7fd01736dec20732faed47374b95282fba', '9819d0a32d56bd339585319c80260e332779f5541fd66838ab7e016d6c814819'),
}

STDLIB_DISTRIBUTIONS = {target: pins[0] for target, pins in DISTRIBUTIONS.items()}
STDLIB_DISTRIBUTIONS[WASM_TARGET] = 'fa0edb6e9f34faae5735554d62d50875eded839dc707d0f1c01467a918d8453b'


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('Duplicate attribution JSON key')
        result[key] = value
    return result


def parse_json(data):
    return json.loads(data, object_pairs_hook=unique_object)


def relative(value):
    if not isinstance(value, str) or not value or '\\' in value or any(ord(char) < 32 for char in value):
        raise ValueError('Original File needs a portable relative exec path')
    path = PurePosixPath(value)
    if path.is_absolute() or path.as_posix() != value or any(p in ('', '.', '..') for p in value.split('/')):
        raise ValueError('Original File needs a portable relative exec path')
    return path


def descriptor(value):
    if not isinstance(value, dict) or set(value) != {'path', 'label'}:
        raise ValueError('Exact original File descriptor required')
    relative(value['path'])
    if not isinstance(value['label'], str) or not re.fullmatch(r'(?:@@[^/]*|@[^/]+)?//[^\s:]*:[^\s:]+', value['label']):
        raise ValueError('Original File owner required')
    return value


def fact(data):
    return {'size': len(data), 'sha256': hashlib.sha256(data).hexdigest()}


def source_members(data):
    if hashlib.sha256(data).hexdigest() != SOURCE_SHA256:
        raise ValueError('Original Rust1.97.1 source archive SHA mismatch')
    wanted = set(SOURCE_MEMBERS)
    result = {}
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:xz') as archive:
        for member in archive:
            if member.name.rstrip('/') == PREFIX.rstrip('/') and member.isdir():
                continue
            if not member.name.startswith(PREFIX):
                raise ValueError('Original source archive prefix mismatch')
            logical = member.name[len(PREFIX):]
            if logical == 'LICENSES' and member.isdir():
                continue
            if logical not in wanted and not logical.startswith('LICENSES/'):
                continue
            relative(logical)
            if logical in result or not member.isfile() or member.mode & 0o7000:
                raise ValueError('Original license archive member must be unique regular File')
            stream = archive.extractfile(member)
            if stream is None:
                raise ValueError('Original source member is unreadable')
            text = stream.read()
            if not text or len(text) != member.size:
                raise ValueError('Original source member byte count mismatch')
            result[logical] = text
    if not wanted.issubset(result) or result['src/version'] != (VERSION + '\n').encode() or result['src/ci/channel'] != b'stable\n':
        raise ValueError('Original source version/license membership mismatch')
    return result


def distribution_members(data, digest, prefix, wanted):
    if hashlib.sha256(data).hexdigest() != digest:
        raise ValueError('Original Rust distribution archive SHA mismatch')
    result = {}
    original_names = {prefix + logical for logical in wanted}
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:xz') as archive:
        for member in archive:
            if member.name not in original_names:
                continue
            logical = member.name[len(prefix):]
            if logical in result or not member.isfile() or member.mode & 0o7000:
                raise ValueError('Original distribution needs unique regular members')
            stream = archive.extractfile(member)
            if stream is None:
                raise ValueError('Original distribution member unreadable')
            payload = stream.read()
            if not payload or len(payload) != member.size:
                raise ValueError('Original distribution member byte count mismatch')
            result[logical] = payload
    if set(result) != set(wanted):
        raise ValueError('Original distribution member inventory missing')
    return result


def dependency_notices(copyright_html, lock):
    """Project exact published notice blocks for the original std source lock.

    These are distribution source dependencies, not an inferred package list
    selected by the product linker. Preserve that distinction in the inventory.
    """
    text = copyright_html.decode('utf8')
    headers = list(re.finditer(r'<h3>(.*?)</h3>', text))
    blocks = {}
    for index, match in enumerate(headers):
        title = html.unescape(match[1])
        if title in blocks:
            raise ValueError('Duplicate published copyright component')
        end = headers[index + 1].start() if index + 1 < len(headers) else text.rfind('</body>')
        blocks[title] = text[match.start():end]
    packages = [package for package in tomllib.loads(lock.decode('utf8'))['package'] if 'source' in package]
    identities, notices, facts = set(), [], []
    for package in packages:
        identity = package['name'] + '@' + package['version']
        if identity in identities or package['source'] != 'registry+https://github.com/rust-lang/crates.io-index' or not re.fullmatch('[a-f0-9]{64}', package.get('checksum', '')):
            raise ValueError('Original standard library registry identity mismatch')
        identities.add(identity)
        block = blocks.get('📦 ' + package['name'] + '-' + package['version'])
        if block is None:
            raise ValueError('Original published standard library dependency notice missing')
        url = 'https://crates.io/crates/' + package['name'] + '/' + package['version']
        if '<a href="' + html.escape(url, quote=True) + '">' not in block:
            raise ValueError('Original publisher component URL mismatch')
        license_match = re.search(r'<p><b>License:</b> (.*?)</p>', block)
        notice_matches = list(re.finditer(r'<summary><code>(.*?)</code></summary>\s*<pre>(.*?)</pre>', block, re.DOTALL))
        if license_match is None or not license_match[1].strip():
            raise ValueError('Original published dependency license metadata missing')
        members = {}
        for notice in notice_matches:
            name = html.unescape(notice[1])
            relative(name)
            payload = html.unescape(notice[2]).encode('utf8')
            if name in members or not payload.strip():
                raise ValueError('Original published dependency notice membership invalid')
            members[name] = fact(payload)
        notices.append(block)
        facts.append({'id': identity, 'name': package['name'], 'version': package['version'],
                      'registry_sha256': package['checksum'], 'source': url,
                      'license': html.unescape(license_match[1]), 'notice_members': members,
                      'missing_notice_text': not notice_matches,
                      'published_block': fact(block.encode('utf8'))})
    if not facts:
        raise ValueError('Original standard library source dependency notices empty')
    rendered = ('<!DOCTYPE html>\n<html><body>\n' + '\n'.join(notices) + '\n</body></html>\n').encode('utf8')
    return facts, rendered


def wasm_map_records(text):
    """Read wasm-lld's literal live input chunks, excluding symbol/output rows."""
    lines = text.splitlines()
    if not lines or lines[0].split() != [b'Addr', b'Off', b'Size', b'Out', b'In', b'Symbol']:
        raise ValueError('Original wasm-lld map header required')
    result, seen = [], set()
    for line in lines[1:]:
        row = re.fullmatch(rb' *(?:-|[0-9a-fA-F]+) +[0-9a-fA-F]+ +([0-9a-fA-F]+) (.*)', line)
        if row is None:
            raise ValueError('Malformed original wasm-lld map row')
        payload = row[2]
        indent = len(payload) - len(payload.lstrip(b' '))
        if indent not in (0, 8, 16):
            raise ValueError('Malformed original wasm-lld map hierarchy')
        if indent != 8 or int(row[1], 16) == 0:
            continue
        chunk = re.fullmatch(rb'(.+):\(([^()]*)\)', payload[8:])
        if chunk is None:
            raise ValueError('Malformed original wasm-lld input chunk')
        original = chunk[1].decode('utf8')
        if original not in seen:
            seen.add(original)
            result.append(original)
    if not result:
        raise ValueError('Original wasm-lld map has no live input chunks')
    return result


def map_records(text, target):
    """Read literal linker input records, never infer an archive from a basename."""
    if target not in TARGETS or not isinstance(text, bytes):
        raise ValueError('Supported original linker map required')
    if target == WASM_TARGET:
        return wasm_map_records(text)
    result = []
    if target.endswith('apple-darwin'):
        active, seen, complete = False, set(), False
        for line in text.splitlines():
            if line == b'# Object files:':
                if active or complete:
                    raise ValueError('Duplicate Darwin object inventory')
                active = True
                continue
            if active and line.startswith(b'#'):
                active, complete = False, True
            if active:
                match = re.fullmatch(rb'\[\s*(\d+)\]\s+(.+)', line)
                if not match or match[1] in seen:
                    raise ValueError('Malformed or duplicate Darwin object record')
                seen.add(match[1])
                result.append(match[2].decode('utf8'))
        if not seen:
            raise ValueError('Missing Darwin object inventory')
    else:
        if b'Archive member included to satisfy reference by file (symbol)' not in text or b'Linker script and memory map' not in text:
            raise ValueError('Missing GNU linker map sections')
        archive_section = False
        for line in text.splitlines():
            if line == b'Archive member included to satisfy reference by file (symbol)':
                archive_section = True
            elif line in (b'Discarded input sections', b'Memory Configuration', b'Linker script and memory map'):
                archive_section = False
            elif line.startswith(b'LOAD '):
                result.append(line[5:].decode('utf8'))
            elif archive_section and line and not line[:1].isspace() and re.fullmatch(rb'.+\([^()]+\)', line):
                result.append(line.decode('utf8'))
    return result


def selected_members(records, aliases):
    selected = {}
    for record in records:
        match = re.fullmatch(r'(.+)\(([^()]+)\)', record)
        filename, member = (match[1], match[2]) if match else (record, None)
        if filename not in aliases:
            continue
        index = aliases[filename]
        selected.setdefault(index, set())
        if member is not None:
            if '\x00' in member or '/' in member or '\\' in member or member in ('.', '..'):
                raise ValueError('Malformed selected archive member')
            selected[index].add(member)
    if not selected:
        raise ValueError('Linker map selected no original declared stdlib File')
    return {key: sorted(value) for key, value in sorted(selected.items())}


def archive_members(data):
    if not data.startswith(b'!<arch>\n'):
        raise ValueError('Selected stdlib member requires original ar archive')
    cursor, names, result = 8, b'', {}
    while cursor < len(data):
        header = data[cursor:cursor + 60]
        if len(header) != 60 or header[58:] != b'`\n':
            raise ValueError('Malformed original stdlib ar header')
        try:
            length = int(header[48:58].decode('ascii').strip())
            name = header[:16].decode('ascii').strip()
        except (UnicodeError, ValueError) as error:
            raise ValueError('Malformed original stdlib ar fields') from error
        if length < 0 or cursor + 60 + length > len(data):
            raise ValueError('Truncated original stdlib ar member')
        payload = data[cursor + 60:cursor + 60 + length]
        cursor += 60 + length + (length % 2)
        if name == '//':
            if names:
                raise ValueError('Duplicate original ar name table')
            names = payload
            continue
        if name in ('/', '/SYM64/'):
            continue
        if name.startswith('#1/'):
            count = int(name[3:])
            if count <= 0 or count > len(payload):
                raise ValueError('Malformed original BSD ar name')
            name, payload = payload[:count].rstrip(b'\0').decode('utf8'), payload[count:]
        elif name.startswith('/'):
            offset = int(name[1:])
            end = names.find(b'/\n', offset)
            if offset < 0 or end < 0 or (offset and names[offset - 1:offset] != b'\n'):
                raise ValueError('Invalid original ar name offset')
            name = names[offset:end].decode('utf8')
        else:
            name = name.rstrip('/')
        if name.startswith('__.SYMDEF'):
            continue
        if not name or name in result or '/' in name or '\\' in name or '\x00' in name:
            raise ValueError('Invalid or duplicate original ar member name')
        result[name] = fact(payload)
    if cursor != len(data) or not result:
        raise ValueError('Incomplete original stdlib ar archive')
    return result


def native_packages(graph, graph_module, target, source, stdlib, selected, archive_facts):
    """Join original metadata identities, not archive names, to Cargo packages."""
    if not isinstance(graph, dict) or graph.get('version') != VERSION or graph.get('target') != target or graph.get('features') != graph_module.features(target) or graph.get('profile') != 'dist':
        raise ValueError('Original configured native stdlib graph required')
    if graph.get('source_archive', {}).get('sha256') != SOURCE_SHA256 or graph['source_archive'].get('size') != len(source):
        raise ValueError('Native graph original source archive mismatch')
    source_root = Path(graph['source_root'])
    if not source_root.is_absolute():
        raise ValueError('Native graph original source namespace required')
    packages = graph['packages']
    if not isinstance(packages, list) or not packages:
        raise ValueError('Native graph original package inventory required')
    by_id = {package['id']: package for package in packages}
    if len(by_id) != len(packages):
        raise ValueError('Duplicate native graph package identity')
    units = graph['unit_graph']['units']
    if set(by_id) != {unit['pkg_id'] for unit in units}:
        raise ValueError('Native graph package membership mismatch')
    required_sources = set(graph_module.recipe_inputs(target))
    for filename in [package['manifest_path'] for package in packages] + [unit['target']['src_path'] for unit in units]:
        required_sources.add(Path(filename).relative_to(source_root).as_posix())
    sources = graph['source_inputs']
    if not isinstance(sources, list) or len({item['path'] for item in sources}) != len(sources) or {item['path'] for item in sources} != required_sources:
        raise ValueError('Native graph original source membership mismatch')
    for item in sources:
        relative(item['path'])
    records = graph['metadata']
    if not isinstance(records, list) or not records:
        raise ValueError('Native graph original metadata required')
    metadata_files = {row['path']: (row['label'], byte_fact) for row, _, _, byte_fact in stdlib if row['path'].endswith('.rmeta')}
    stock = graph['stock_association']
    pairs = {pair['identity']: pair for pair in stock['members']}
    if len(pairs) != len(stock['members']):
        raise ValueError('Duplicate native compiler stock pair identity')
    by_identity = {}
    matched = set()
    for record in records:
        identity = record['identity']
        if not graph_module.IDENTITY.fullmatch(identity) or identity in by_identity:
            raise ValueError('Duplicate or malformed native metadata identity')
        recorded = record['file']
        pair = pairs.get(identity)
        if pair is None or pair['metadata_input'] not in metadata_files:
            raise ValueError('Native metadata has no exact original distribution File')
        path = pair['metadata_input']
        label, byte_fact = metadata_files[path]
        if pair['metadata_label'] != label or set(recorded) != {'path', 'size', 'sha256'} or type(recorded['size']) is not int or {'size': recorded['size'], 'sha256': recorded['sha256']} != byte_fact:
            raise ValueError('Native metadata original File custody mismatch')
        by_identity[identity] = record
        matched.add(path)
    if matched != set(metadata_files):
        raise ValueError('Native metadata omitted an original stdlib File')
    associations = graph_module.relation(graph['unit_graph'], records, target)
    if json.dumps(associations, sort_keys=True) != json.dumps(graph['associations'], sort_keys=True):
        raise ValueError('Native graph metadata package relation mismatch')
    by_metadata = {item['identity']: item for item in associations}
    for key, actual in zip(('stdlib_archive', 'compiler_archive'), archive_facts):
        recorded = stock[key]
        if type(recorded['size']) is not int or {'size': recorded['size'], 'sha256': recorded['sha256']} != actual:
            raise ValueError('Native compiler stock distribution association mismatch')
    paired = {}
    seen = set()
    marker = 'lib/rustlib/' + target + '/lib/'
    prefix = 'rust-std-' + VERSION + '-' + target + '/rust-std-' + target + '/'
    wasm_root = None
    if target == WASM_TARGET:
        roots = {str(physical.resolve(strict=True)).split(marker)[0].rstrip('/')
                 for _, physical, _, _ in stdlib
                 if str(physical.resolve(strict=True)).count(marker) == 1}
        if len(roots) != 1 or any(str(physical.resolve(strict=True)).count(marker) != 1
                                  for _, physical, _, _ in stdlib):
            raise ValueError('WASM pair requires the exact original target sysroot')
        wasm_root = roots.pop()
    for pair in stock['members']:
        identity = pair['identity']
        if identity not in by_identity or identity in seen or pair['metadata'] != by_identity[identity]['file']:
            raise ValueError('Native compiler metadata pair identity mismatch')
        seen.add(identity)
        for key, suffix in (('metadata', '.rmeta'), ('archive', '.rlib')):
            recorded = pair[key]
            candidates = [(row, byte_fact) for row, _, _, byte_fact in stdlib if row['path'] == pair[key + '_input']]
            if len(candidates) != 1:
                raise ValueError('Native compiler pair has no original typed stdlib File')
            row, actual = candidates[0]
            logical = marker + row['path'].split(marker)[1]
            if not row['path'].endswith(suffix) or pair[key + '_member'] != prefix + logical or pair[key + '_label'] != row['label'] or type(recorded['size']) is not int or {'size': recorded['size'], 'sha256': recorded['sha256']} != actual:
                raise ValueError('Native compiler pair original member custody mismatch')
            if key == 'archive':
                if row['path'] in paired:
                    raise ValueError('Repeated original compiler archive pair')
                paired[row['path']] = identity
        observed = pair['compiler_observation']
        command = observed['command']
        if type(observed['exit']) is not int or observed['exit'] != 0 or command.count('--emit=obj') != 1 or command.count('--crate-type=bin') != 1 or command.count('--target=' + target) != 1 or command.count('association=' + pair['metadata']['path']) != 1 or command.count('association=' + pair['archive']['path']) != 1:
            raise ValueError('Original compiler object-emission pair observation required')
        if wasm_root is not None and [arg for arg in command if arg.startswith('--sysroot=')] != ['--sysroot=' + wasm_root]:
            raise ValueError('WASM compiler pair original target sysroot differs')
    if seen != set(by_identity):
        raise ValueError('Native compiler stock pair inventory incomplete')
    selected_identities = set()
    for item in selected:
        # The original compiler's CrateSource/SVH object-emission observation
        # pairs exact original Files. No archive basename supplies a package.
        if item['path'] not in paired:
            raise ValueError('Linked stdlib has no paired original compiler metadata')
        selected_identities.add(paired[item['path']])
    pending = list(selected_identities)
    while pending:
        identity = pending.pop()
        for dependency in by_identity[identity]['dependencies']:
            upstream = dependency['identity']
            if upstream not in selected_identities:
                selected_identities.add(upstream)
                pending.append(upstream)
    identities = {by_metadata[identity]['pkg_id'] for identity in selected_identities}
    original = distribution_members(source, SOURCE_SHA256, PREFIX, required_sources)
    if any(set(item) != {'path', 'size', 'sha256'} or type(item['size']) is not int or fact(original[item['path']]) != {'size': item['size'], 'sha256': item['sha256']} for item in sources):
        raise ValueError('Native graph source File bytes mismatch')
    return [by_id[identity] for identity in sorted(identities)], sorted(selected_identities)


def matched_stock_compiler(graph, target, current, original):
    """Join the actual action compiler to original SDK and archive bytes."""
    member = 'rustc-' + VERSION + '-' + target + '/rustc/bin/rustc'
    files = graph.get('stock_association', {}).get('compiler_files')
    if not isinstance(files, dict) or set(files) != {member}:
        raise ValueError('Native graph requires its exact original stock compiler File')
    observed = files[member]
    if (not isinstance(observed, dict) or set(observed) != {'path', 'size', 'sha256'}
            or not isinstance(observed['path'], str) or not Path(observed['path']).is_absolute()
            or type(observed['size']) is not int):
        raise ValueError('Native graph compiler File identity is malformed')
    expected = fact(original)
    if current != expected or {'size': observed['size'], 'sha256': observed['sha256']} != expected:
        raise ValueError('Actual action compiler differs from original stock SDK/compiler archive')


def collect(request, custody, graph_module):
    if not isinstance(request, dict) or set(request) != {'producer', 'compiler', 'target', 'execution_host', 'rustc', 'artifact', 'link_map', 'stdlib', 'source', 'stdlib_archive', 'rustc_archive', 'graph'}:
        raise ValueError('Exact typed stdlib request required')
    if request['compiler'] != VERSION or request['target'] not in TARGETS:
        raise ValueError('Pinned original Rust compiler context required')
    host = request['execution_host']
    if host not in NATIVE_TARGETS or (request['target'] in NATIVE_TARGETS and host != request['target']):
        raise ValueError('Original compiler execution host differs from target context')
    descriptor({'path': 'producer', 'label': request['producer']})
    if not isinstance(request['stdlib'], list) or not request['stdlib']:
        raise ValueError('Original toolchain stdlib Files required')
    captured = []
    for index, row in enumerate([request['artifact'], request['link_map'], request['rustc'], request['source'], request['stdlib_archive'], request['rustc_archive'], request['graph'], *request['stdlib']]):
        row = descriptor(row)
        physical = custody.presentation(row['path'])
        pinned, size, digest = custody.file(physical, executable=index == 2)
        captured.append((row, physical, pinned, {'size': size, 'sha256': digest}))
    artifact, link_map, rustc, source, stdlib_archive, rustc_archive, graph, *stdlib = captured
    # The genuine output File's relative execpath anchors the original engine
    # namespace. No arbitrary map record establishes a source root.
    suffix = relative(artifact[0]['path']).parts
    if artifact[1].parts[-len(suffix):] != suffix:
        raise ValueError('Artifact carrier has no exact original exec namespace')
    original_root = artifact[1].parents[len(suffix) - 1]
    aliases = {}
    for index, (row, physical, _, _) in enumerate(stdlib):
        for value in (row['path'], str(original_root / row['path']), str(physical)):
            if value in aliases and aliases[value] != index:
                raise ValueError('Ambiguous original stdlib File identities')
            aliases[value] = index
    if len({row['path'] for row, _, _, _ in stdlib}) != len(stdlib):
        raise ValueError('Duplicate original stdlib File')
    records = map_records(custody.read(link_map[2]), request['target'])
    selected = selected_members(records, aliases)
    selected_facts = []
    for index, members in selected.items():
        # LOAD lines alone are not proof that an archive contributed an object.
        if not members:
            continue
        original_members = archive_members(custody.read(stdlib[index][2]))
        if not set(members).issubset(original_members):
            raise ValueError('Linker selected a member absent from original stdlib archive')
        selected_facts.append({**stdlib[index][0], **stdlib[index][3],
                               'members': {member: original_members[member] for member in members}})
    if not selected_facts:
        raise ValueError('Linker map proves no original stdlib archive object membership')
    notices = source_members(custody.read(source[2]))
    target = request['target']
    logicals = {}
    marker = 'lib/rustlib/' + target + '/lib/'
    for row, _, _, byte_fact in stdlib:
        if row['path'].count(marker) != 1:
            raise ValueError('Exact original stdlib distribution namespace required')
        logical = marker + row['path'].split(marker)[1]
        relative(logical)
        if logical in logicals:
            raise ValueError('Duplicate original stdlib distribution member')
        logicals[logical] = byte_fact
    standard = distribution_members(custody.read(stdlib_archive[2]), STDLIB_DISTRIBUTIONS[target],
                                    'rust-std-' + VERSION + '-' + target + '/rust-std-' + target + '/', logicals)
    if any(fact(standard[logical]) != expected for logical, expected in logicals.items()):
        raise ValueError('Original stock stdlib distribution File bytes mismatch')
    compiler_members = distribution_members(custody.read(rustc_archive[2]), DISTRIBUTIONS[host][1],
                                            'rustc-' + VERSION + '-' + host + '/rustc/',
                                            ('bin/rustc', 'share/doc/rust/COPYRIGHT-library.html', 'share/doc/rust/COPYRIGHT.html'))
    native_graph = parse_json(custody.read(graph[2]))
    if target == WASM_TARGET and native_graph.get('compiler_host') != host:
        raise ValueError('WASM graph compiler host differs from actual action compiler')
    matched_stock_compiler(native_graph, host, rustc[3], compiler_members['bin/rustc'])
    copyright = {name: compiler_members['share/doc/rust/' + name] for name in ('COPYRIGHT-library.html', 'COPYRIGHT.html')}
    dependencies, rendered = dependency_notices(copyright['COPYRIGHT.html'], notices['library/Cargo.lock'])
    packages, identities = native_packages(native_graph, graph_module, target,
                                           custody.read(source[2]), stdlib, selected_facts,
                                           (stdlib_archive[3], rustc_archive[3]))
    selected_registry = {package['name'] + '@' + package['version'] for package in packages if package['source'] is not None}
    selected_notices = [item for item in dependencies if item['id'] in selected_registry]
    if {item['id'] for item in selected_notices} != selected_registry:
        raise ValueError('Selected native package has no original publisher notice')
    notices['COPYRIGHT-library.html'] = copyright['COPYRIGHT-library.html']
    notices['NOTICES-stdlib-dependencies.html'] = rendered
    custody.verify()
    return {
        'kind': 'linked-stdlib-source-attribution',
        'producer': request['producer'], 'compiler': VERSION, 'target': request['target'],
        'execution_host': host,
        'rustc': {**rustc[0], **rustc[3]},
        'artifact': {**artifact[0], **artifact[3]},
        'link_map': {**link_map[0], **link_map[3]},
        'source_archive': {**source[0], **source[3]},
        'stdlib_archive': {**stdlib_archive[0], **stdlib_archive[3]},
        'rustc_archive': {**rustc_archive[0], **rustc_archive[3]},
        'graph': {**graph[0], **graph[3]},
        'copyright_library': fact(copyright['COPYRIGHT-library.html']),
        'copyright_all': fact(copyright['COPYRIGHT.html']),
        'distribution_source_dependencies': dependencies,
        'selected_stdlib': selected_facts,
        'selected_metadata': identities,
        'selected_packages': packages,
        'selected_dependency_notices': selected_notices,
        'source_members': {name: fact(data) for name, data in sorted(notices.items())},
        'pending_scopes': ['stdlib-source-notice:' + item['id']
                           for item in selected_notices if item['missing_notice_text']],
    }, notices


def produce(request_file, inventory_file, notices_tree, deployment_module, outputs_module, graph_module):
    custody = deployment_module.DeclaredInputs()
    outputs = outputs_module.OwnedOutputs([inventory_file, notices_tree], [notices_tree] if Path(notices_tree).exists() else [])
    try:
        pinned, _, _ = custody.file(custody.presentation(request_file))
        inventory, notices = collect(parse_json(custody.read(pinned)), custody, graph_module)
        outputs.tree(notices_tree)
        for name, data in sorted(notices.items()):
            outputs.write(name, data, root=notices_tree)
        outputs.write(inventory_file, (json.dumps(inventory, sort_keys=True, indent=2) + '\n').encode())
        custody.verify()
        outputs.verify()
    except BaseException as error:
        try:
            outputs.cleanup()
        except BaseException as cleanup:
            raise BaseExceptionGroup('Stdlib attribution publication and cleanup failed', [error, cleanup]) from error
        raise
    finally:
        outputs.close()
        custody.close()


def published_texts(document, component):
    text = document.decode('utf8')
    headers = list(re.finditer(r'<h3>(.*?)</h3>', text))
    title = '📦 ' + component['name'] + '-' + component['version']
    matches = [index for index, header in enumerate(headers) if html.unescape(header[1]) == title]
    if len(matches) != 1:
        raise ValueError('Selected stdlib publisher component membership mismatch')
    index = matches[0]
    end = headers[index + 1].start() if index + 1 < len(headers) else text.rfind('</body>')
    block = text[headers[index].start():end]
    found = {}
    for match in re.finditer(r'<summary><code>(.*?)</code></summary>\s*<pre>(.*?)</pre>', block, re.DOTALL):
        name, data = html.unescape(match[1]), html.unescape(match[2]).encode('utf8')
        relative(name)
        if name in found or not data.strip():
            raise ValueError('Selected stdlib publisher text membership mismatch')
        found[name] = data
    if not found or {name: fact(data) for name, data in found.items()} != component['notice_members']:
        raise ValueError('Selected stdlib publisher notice bytes mismatch')
    return [{'path': name, 'sha256': fact(data)['sha256'], 'text': data.decode('utf8')}
            for name, data in sorted(found.items())]


def collect_compiled_stdlib(value, artifact, target, records, inputs):
    """Consume the same original producer inventory and its owned notice Tree."""
    if not isinstance(value, dict) or set(value) != {'input', 'label', 'notices'} or not isinstance(value['notices'], dict) or set(value['notices']) != {'input', 'label'}:
        raise ValueError('Exact original stdlib inventory and notice Tree required')
    if value['label'] != value['notices']['label']:
        raise ValueError('Stdlib notice Tree belongs to another producer')
    inputs.relative(value['input'])
    inputs.relative(value['notices']['input'])
    deployment = load('compiled_stdlib_custody', Path(__file__).parent.parent / 'packaging/deployment-pack.py')
    held = deployment.DeclaredInputs()
    try:
        physical = held.presentation(value['input'])
        pinned, size, digest = held.file(physical)
        inventory = parse_json(held.read(pinned))
        if target not in TARGETS or inventory.get('kind') != 'linked-stdlib-source-attribution' or inventory.get('compiler') != VERSION or inventory.get('target') != target or inventory.get('pending_scopes') != []:
            raise ValueError('Complete matching native stdlib attribution required')
        compiler = inventory.get('rustc')
        if not isinstance(compiler, dict) or set(compiler) != {'path', 'label', 'size', 'sha256'} or type(compiler['size']) is not int:
            raise ValueError('Actual action compiler File custody required')
        descriptor({'path': compiler['path'], 'label': compiler['label']})
        _, compiler_size, compiler_sha = held.file(held.presentation(compiler['path']), executable=True)
        if compiler_size != compiler['size'] or compiler_sha != compiler['sha256']:
            raise ValueError('Actual action compiler File changed after stdlib attribution')
        if set(artifact) != {'path', 'label', 'size', 'sha256'} or type(artifact['size']) is not int or type(inventory['artifact']['size']) is not int or inventory['artifact'] != artifact:
            raise ValueError('Stdlib attribution belongs to another original compiler artifact')
        _, actual_size, actual_sha = held.file(held.presentation(artifact['path']))
        if actual_size != artifact['size'] or actual_sha != artifact['sha256']:
            raise ValueError('Original compiler artifact changed after stdlib attribution')
        mapping = inventory['link_map']
        _, actual_size, actual_sha = held.file(held.presentation(mapping['path']))
        if type(mapping['size']) is not int or actual_size != mapping['size'] or actual_sha != mapping['sha256']:
            raise ValueError('Original compiler link map changed after stdlib attribution')
        host = inventory.get('execution_host')
        if host not in NATIVE_TARGETS or (target in NATIVE_TARGETS and host != target):
            raise ValueError('Original stdlib compiler execution host differs')
        for name, expected in [('source_archive', SOURCE_SHA256), ('stdlib_archive', STDLIB_DISTRIBUTIONS[target]), ('rustc_archive', DISTRIBUTIONS[host][1])]:
            if inventory[name]['sha256'] != expected:
                raise ValueError('Stdlib original distribution/source pin mismatch')
        if not isinstance(records, dict) or not records:
            raise ValueError('Configured compiler stdlib File records required')
        declared = set()
        for record in records.values():
            for row in record['stdlib']:
                if not isinstance(row, dict) or set(row) != {'input', 'label'}:
                    raise ValueError('Exact configured compiler stdlib File required')
                declared.add((row['input'], row['label']))
        for selected in inventory['selected_stdlib']:
            if (selected['path'], selected['label']) not in declared:
                raise ValueError('Selected stdlib File absent from actual compiler records')
            original, actual_size, actual_sha = held.file(held.presentation(selected['path']))
            if type(selected['size']) is not int or actual_size != selected['size'] or actual_sha != selected['sha256']:
                raise ValueError('Selected original compiler stdlib File bytes changed')
        namespace = deployment.original_namespace(value['input'], held)
        entries = deployment.declared_tree(value['notices'], 'stdlib', namespace, held)
        bodies, sources = {}, [{'path': value['input'], 'label': value['label'], 'size': size, 'sha256': digest}]
        for name, (metadata, original, actual_size) in entries.items():
            member = name[len('stdlib/'):]
            body = held.read(original)
            bodies[member] = body
            sources.append({'path': value['notices']['input'] + '/' + member,
                            'label': metadata['label'], 'size': actual_size,
                            'sha256': fact(body)['sha256']})
        if {name: fact(body) for name, body in bodies.items()} != inventory['source_members']:
            raise ValueError('Original stdlib notice Tree membership/bytes mismatch')
        texts = [{'path': name, 'sha256': fact(bodies[name])['sha256'], 'text': bodies[name].decode('utf8')}
                 for name in ('COPYRIGHT-library.html', 'LICENSE-MIT', 'LICENSE-APACHE')]
        components = [{'id': 'rust-stdlib@' + VERSION + '#' + target, 'name': 'Rust standard library',
                       'version': VERSION, 'source': 'https://static.rust-lang.org/dist/rust-std-' + VERSION + '-' + target + '.tar.xz',
                       'license': None, 'repository': 'https://github.com/rust-lang/rust',
                       'license_file': 'COPYRIGHT-library.html',
                       'source_label': inventory['rustc_archive']['label'], 'texts': texts}]
        registry = {package['name'] + '@' + package['version'] for package in inventory['selected_packages'] if package['source'] is not None}
        selected = inventory['selected_dependency_notices']
        if len({item['id'] for item in selected}) != len(selected) or {item['id'] for item in selected} != registry or any(item['missing_notice_text'] for item in selected):
            raise ValueError('Selected stdlib dependency notices incomplete')
        for item in selected:
            components.append({'id': 'rust-stdlib:' + item['id'], 'name': item['name'],
                               'version': item['version'], 'source': item['source'],
                               'license': item['license'], 'repository': None,
                               'license_file': None, 'source_label': inventory['rustc_archive']['label'],
                               'texts': published_texts(bodies['NOTICES-stdlib-dependencies.html'], item)})
        for package in inventory['selected_packages']:
            if package['name'] == 'compiler_builtins':
                if package['license'] != 'MIT AND Apache-2.0 WITH LLVM-exception AND (MIT OR Apache-2.0)':
                    raise ValueError('Original compiler-builtins license declaration mismatch')
                components.append({'id': 'rust-stdlib:compiler_builtins@' + package['version'],
                                   'name': package['name'], 'version': package['version'],
                                   'source': 'https://static.rust-lang.org/dist/rustc-' + VERSION + '-src.tar.xz',
                                   'license': package['license'], 'repository': package['repository'],
                                   'license_file': None, 'source_label': inventory['source_archive']['label'],
                                   'texts': [*texts, {'path': 'LICENSES/LLVM-exception.txt',
                                                     'sha256': fact(bodies['LICENSES/LLVM-exception.txt'])['sha256'],
                                                     'text': bodies['LICENSES/LLVM-exception.txt'].decode('utf8')}]})
        held.verify()
        return {'sources': sources, 'components': components, 'linkage': inventory}
    finally:
        held.close()


def main():
    parser = argparse.ArgumentParser()
    for name in ('request', 'inventory', 'notices', 'deployment-module', 'outputs-module', 'graph-module'):
        parser.add_argument('--' + name, required=True)
    args = parser.parse_args()
    deployment = load('stdlib_declared_inputs', args.deployment_module)
    outputs = load('stdlib_owned_outputs', args.outputs_module)
    graph = load('stdlib_native_graph', args.graph_module)
    produce(args.request, args.inventory, args.notices, deployment, outputs, graph)


if __name__ == '__main__':
    main()
