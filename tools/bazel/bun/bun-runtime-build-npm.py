"""Declared original npm cache for Bun's three original frozen-lockfile installs."""
import base64
import hashlib
import io
import json
import os
from pathlib import Path
import re
import sys
import stat
import tarfile


def read_lock(body):
    # bun.lock's original grammar is JSON with trailing commas. Transform only
    # a comma token followed by a closing delimiter outside string literals.
    text = body.decode('utf8')
    output, quoted, escaped = [], False, False
    for index, token in enumerate(text):
        if quoted:
            output.append(token)
            if escaped:
                escaped = False
            elif token == '\\':
                escaped = True
            elif token == '"':
                quoted = False
        elif token == '"':
            output.append(token)
            quoted = True
        elif token == ',':
            following = index + 1
            while following < len(text) and text[following] in ' \n\r\t':
                following += 1
            if following == len(text) or text[following] not in '}]':
                output.append(token)
        else:
            output.append(token)
    return json.loads(''.join(output))


def original_packages(members, pins, source_pins):
    if source_pins['commit'] != pins['bun_commit']:
        raise ValueError('Npm closure differs from original Bun source commit')
    expected = {}
    for name, checksum in pins['locks'].items():
        body = members[name]
        if hashlib.sha256(body).hexdigest() != checksum:
            raise ValueError('Npm closure differs from original Bun lock bytes')
        for value in read_lock(body)['packages'].values():
            if len(value) == 1 and '@workspace:' in value[0]:
                continue
            if len(value) != 4 or value[1] != '':
                raise ValueError('Original npm lock requires unsupported registry resolution')
            name, version = value[0].rsplit('@', 1)
            package = {'name': name, 'version': version, 'integrity': value[3],
                       'url': 'https://registry.npmjs.org/' + name + '/-/'
                              + name.rsplit('/', 1)[-1] + '-' + version + '.tgz'}
            if value[0] in expected and expected[value[0]] != package:
                raise ValueError('Original npm locks disagree on a package integrity')
            expected[value[0]] = package
    if [expected[key] for key in sorted(expected)] != pins['packages']:
        raise ValueError('Npm archive pins differ from original lock membership')
    return expected


def cache_tag_hash(body):
    # Bun's pinned src/wyhash/lib.rs Wyhash11, used by original semver tags.
    # Bun.hash.wyhash uses final4 instead; it is not interchangeable.
    primes = [0xa0761d6478bd642f, 0xe7037ed1a0b428db, 0x8ebc6af09c88c6e3,
              0x589965cc75374cc3, 0x1d8e4e27c47d124f]
    mask = (1 << 64) - 1

    def mum(a, b):
        product = a * b
        return ((product >> 64) ^ product) & mask

    def mix(a, b, seed, offset=0):
        return mum(a ^ seed ^ primes[offset], b ^ seed ^ primes[offset + 1])

    def swapped(chunk):
        return (int.from_bytes(chunk[:4], 'little') << 32) | int.from_bytes(chunk[4:], 'little')

    def tail(chunk):
        if len(chunk) == 8:
            return swapped(chunk)
        value, index = 0, 0
        for width in [4, 2, 1]:
            if len(chunk) - index >= width:
                value = (value << (width * 8)) | int.from_bytes(chunk[index:index + width], 'little')
                index += width
        return value

    seed, offset = 0, 0
    while len(body) - offset >= 32:
        block = body[offset:offset + 32]
        words = [int.from_bytes(block[i:i + 8], 'little') for i in [0, 8, 16, 24]]
        seed = mix(words[0], words[1], seed) ^ mix(words[2], words[3], seed, 2)
        offset += 32
    chunk = body[offset:]
    if 0 < len(chunk) <= 8:
        seed = mix(tail(chunk), primes[4], seed)
    elif 8 < len(chunk) <= 16:
        seed = mix(swapped(chunk[:8]), tail(chunk[8:]), seed)
    elif len(chunk) > 16:
        head = mix(swapped(chunk[:8]), swapped(chunk[8:16]), seed)
        remainder = chunk[16:]
        last = (mix(tail(remainder), primes[4], seed, 2) if len(remainder) <= 8
                else mix(swapped(remainder[:8]), tail(remainder[8:]), seed, 2))
        seed = head ^ last
    return mum(seed ^ len(body), primes[4])


def cache_names(packages):
    names = {}
    for identity, entry in packages.items():
        match = re.fullmatch(r'(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?', entry['version'])
        if match is None:
            raise ValueError('Original npm cache version grammar changed')
        version = '.'.join(match.group(1, 2, 3))
        if match[4] is not None:
            version += '-' + format(cache_tag_hash(match[4].encode()), '016x')
        if match[5] is not None:
            version += '+' + format(cache_tag_hash(match[5].encode()), '016X')
        names[identity] = entry['name'] + '@' + version + '@@@1'
    if len(set(names.values())) != len(names):
        raise ValueError('Original Bun cache identities collide')
    return names


def collect(specification, pins, source_pins, custody, deployment, owned):
    if set(specification) != {'source_archive', 'archives'}:
        raise ValueError('Exact original Bun npm acquisition inputs required')
    source, _ = custody.captured(specification['source_archive'], owned)
    members, _ = custody.source_members(source, source_pins, deployment.license_inputs.relative)
    packages = original_packages(members, pins, source_pins)
    if set(specification['archives']) != set(packages):
        raise ValueError('Original Bun npm archive closure is incomplete or foreign')
    names = cache_names(packages)
    relative = deployment.license_inputs.relative
    output, modes = {}, {}
    for identity, package in sorted(packages.items()):
        data, _ = custody.captured(specification['archives'][identity], owned)
        algorithm, checksum = package['integrity'].split('-', 1)
        if algorithm != 'sha512' or base64.b64encode(hashlib.sha512(data).digest()).decode() != checksum:
            raise ValueError('Original npm archive integrity differs from Bun lock')
        files, seen, prefix = {}, set(), None
        with tarfile.open(fileobj=io.BytesIO(data)) as archive:
            for member in archive:
                original = relative(member.name.rstrip('/'))
                root, separator, name = original.partition('/')
                if prefix is None:
                    prefix = root
                if root != prefix:
                    raise ValueError('Original npm archive has multiple roots')
                if not separator and member.isdir():
                    continue
                name = relative(name)
                if name in seen:
                    raise ValueError('Original npm archive repeats a package member')
                seen.add(name)
                if member.isdir():
                    continue
                if not member.isfile() or member.mode & 0o7000:
                    raise ValueError('Original npm archive has unsupported member kind')
                files[name] = (archive.extractfile(member).read(), member.mode & 0o777)
        manifest = json.loads(files['package.json'][0])
        if manifest['name'] != package['name'] or manifest['version'] != package['version']:
            raise ValueError('Original npm manifest differs from locked package identity')
        for name, (body, mode) in files.items():
            logical = relative(names[identity] + '/' + name)
            output[logical], modes[logical] = body, mode
    owned.verify()
    return output, modes


def prepare(specification, pins, source_pins, destination, custody, deployment, output_tree, builder):
    owned = deployment.DeclaredInputs()
    tree = None
    try:
        members, modes = collect(specification, pins, source_pins, custody, deployment, owned)
        tree = output_tree.OutputTree(destination)
        builder.write_sources(tree, members, output_tree)
        identities = {(parent, name): expected for parent, name, expected in tree.files}
        for name, mode in modes.items():
            parts = Path(name).parts
            parent = tree.directories[parts[:-1]][0]
            descriptor = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW, dir_fd=parent)
            try:
                if output_tree.identity(os.fstat(descriptor)) != identities[(parent, parts[-1])]:
                    raise ValueError('Original npm cache File ownership changed before mode restoration')
                os.fchmod(descriptor, 0o555 if mode & 0o111 else 0o444)
            finally:
                os.close(descriptor)
        owned.verify()
        tree.verify()
        builder.verify_files(tree, members, output_tree)
        for name, mode in modes.items():
            parts = Path(name).parts
            parent = tree.directories[parts[:-1]][0]
            descriptor = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW, dir_fd=parent)
            try:
                information = os.fstat(descriptor)
                current = os.stat(parts[-1], dir_fd=parent, follow_symlinks=False)
                expected_mode = 0o555 if mode & 0o111 else 0o444
                if (output_tree.identity(information) != identities[(parent, parts[-1])] or
                    output_tree.identity(current) != identities[(parent, parts[-1])] or
                    stat.S_IMODE(information.st_mode) != expected_mode or
                    stat.S_IMODE(current.st_mode) != expected_mode):
                    raise ValueError('Original npm cache File executable mode changed before admission')
            finally:
                os.close(descriptor)
    except BaseException as primary:
        if tree is not None:
            try:
                tree.cleanup()
            except BaseException as cleanup:
                raise BaseExceptionGroup('Original npm cache publication and retirement failed',
                                         [primary, cleanup])
        raise
    finally:
        if tree is not None:
            tree.close()
        owned.close()


if __name__ == '__main__':
    import importlib.util

    def load(name, path):
        specification = importlib.util.spec_from_file_location(name, path)
        module = importlib.util.module_from_spec(specification)
        specification.loader.exec_module(module)
        return module

    spec, pins, source_pins, destination, custody, deployment, output_tree, builder = sys.argv[1:]
    prepare(json.loads(Path(spec).read_bytes()), json.loads(Path(pins).read_bytes()),
            json.loads(Path(source_pins).read_bytes()), destination,
            load('original_custody', custody), load('declared_deployment', deployment),
            load('declared_output_tree', output_tree), load('original_builder', builder))
