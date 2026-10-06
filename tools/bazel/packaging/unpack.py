"""Validate canonical unsigned framing and exact signing inputs before extraction."""
import hashlib
import importlib.util
from pathlib import Path
import re
import shutil
import sys
import tarfile
import tempfile
import zlib

module = importlib.util.spec_from_file_location('pack', Path(__file__).with_name('pack.py'))
pack = importlib.util.module_from_spec(module)
module.loader.exec_module(pack)


def contract_files(contract):
    if not isinstance(contract, dict) or set(contract) != {'files', 'licenses'} or not isinstance(contract['files'], dict) or not contract['files'] or not isinstance(contract['licenses'], list):
        raise ValueError('invalid unsigned consumer contract')
    for name, item in contract['files'].items():
        pack.destination(name)
        if not isinstance(item, dict) or set(item) != {'label', 'mode'} or item['mode'] not in ('0444', '0555') or not isinstance(item['label'], str) or not re.fullmatch(r'(?:@@[^/]*|@[^/]+)?//[^\s:]*:[^\s:]+', item['label']):
            raise ValueError('invalid independent producer identity or mode')
    licenses = contract['licenses']
    if not licenses or any(not isinstance(name, str) for name in licenses) or len(set(licenses)) != len(licenses) or not set(licenses) <= set(contract['files']):
        raise ValueError('invalid independent license inventory')
    if any(contract['files'][name]['mode'] != '0444' for name in licenses):
        raise ValueError('licenses must be nonexecutable files')
    for name in contract['files']:
        if any(other.startswith(name + '/') for other in contract['files']):
            raise ValueError('consumer file conflicts with directory')


def gunzip(archive, descriptor, length):
    decoded = tempfile.TemporaryFile()
    try:
        decoder = zlib.decompressobj(31)
        digest, count, encoded = hashlib.sha512(), 0, 0
        with archive.open('rb') as source:
            if source.read(10) != b'\x1f\x8b\x08\x00\x00\x00\x00\x00\x02\xff':
                raise ValueError('noncanonical gzip metadata or flags')
            source.seek(0)
            while chunk := source.read(1024 * 1024):
                encoded += len(chunk)
                digest.update(chunk)
                while True:
                    content = decoder.decompress(chunk, min(1024 * 1024, length - count + 1))
                    count += len(content)
                    if count > length or decoder.unused_data:
                        raise ValueError('unexpected gzip expansion or trailing compressed member')
                    decoded.write(content)
                    chunk = decoder.unconsumed_tail
                    if not chunk:
                        break
        if not decoder.eof or count != length:
            raise ValueError('truncated gzip stream or unexpected tar record length')
        if descriptor != {'size': encoded, 'sha512': digest.hexdigest()}:
            raise ValueError('archive digest or size differs from signing input')
        decoded.seek(0)
        return decoded
    except BaseException:
        decoded.close()
        raise


def extract(archive, manifest, contract, output):
    archive, manifest, output = Path(archive), Path(manifest), Path(output)
    contract_files(contract)
    data = pack.load_json(manifest.read_bytes())
    if not isinstance(data, dict) or set(data) != {'archive', 'files', 'licenses'}:
        raise ValueError('invalid signing-input manifest')
    descriptor = data['archive']
    if not isinstance(descriptor, dict) or set(descriptor) != {'size', 'sha512'} or type(descriptor['size']) is not int or descriptor['size'] <= 0 or not isinstance(descriptor['sha512'], str) or not re.fullmatch(r'[0-9a-f]{128}', descriptor['sha512']):
        raise ValueError('invalid archive descriptor')
    if not isinstance(data['files'], list) or not isinstance(data['licenses'], list):
        raise ValueError('invalid file or license inventory')
    files = {}
    for item in data['files']:
        if not isinstance(item, dict) or set(item) != {'path', 'mode', 'size', 'sha512', 'label'}:
            raise ValueError('invalid signing-input file')
        name = pack.destination(item['path'])
        if name in files or item['mode'] not in ('0444', '0555') or type(item['size']) is not int or item['size'] <= 0 or not isinstance(item['sha512'], str) or not re.fullmatch(r'[0-9a-f]{128}', item['sha512']):
            raise ValueError('invalid signing-input file identity')
        files[name] = item
    if list(files) != sorted(contract['files']) or data['licenses'] != sorted(contract['licenses']):
        raise ValueError('unsigned consumer inventory or license differs from its contract')
    for name, expected in contract['files'].items():
        if expected != {'label': files[name]['label'], 'mode': files[name]['mode']}:
            raise ValueError('unsigned producer identity or mode differs from consumer contract')
    payload_length = sum(512 + ((item['size'] + 511) // 512) * 512 for item in files.values())
    record_length = ((payload_length + 1024 + 10239) // 10240) * 10240
    # Decode once with an exact expansion bound and retain no unvalidated executable tree.
    with gunzip(archive, descriptor, record_length) as raw, tarfile.open(fileobj=raw, mode='r:') as package:
        members = package.getmembers()
        if [member.name for member in members] != sorted(files):
            raise ValueError('missing, duplicate or extra archive member')
        offset = 0
        for member in members:
            item = files[member.name]
            if not member.isfile() or member.pax_headers or member.size != item['size'] or member.mode != int(item['mode'], 8):
                raise ValueError('unsafe archive member or permission')
            if (member.uid, member.gid, member.mtime, member.uname, member.gname) != (0, 0, 0, '', ''):
                raise ValueError('noncanonical archive metadata')
            header = tarfile.TarInfo(member.name)
            header.size, header.mode = item['size'], int(item['mode'], 8)
            header.uid = header.gid = header.mtime = 0
            header.uname = header.gname = ''
            raw.seek(offset)
            if member.offset != offset or member.offset_data != offset + 512 or raw.read(512) != header.tobuf(format=tarfile.USTAR_FORMAT, encoding='ascii', errors='strict'):
                raise ValueError('noncanonical ustar header or hidden extended metadata')
            with package.extractfile(member) as source:
                if hashlib.file_digest(source, 'sha512').hexdigest() != item['sha512']:
                    raise ValueError('archive file digest differs from signing input')
            padding = (-member.size) % 512
            raw.seek(offset + 512 + member.size)
            if raw.read(padding) != bytes(padding):
                raise ValueError('nonzero tar file padding')
            offset += 512 + member.size + padding
        raw.seek(offset)
        if raw.read() != bytes(record_length - offset):
            raise ValueError('hidden archive data or nonzero end padding')
        output.mkdir()  # Rehearsals never overlay an existing tree.
        try:
            for member in members:
                target = output / member.name
                target.parent.mkdir(parents=True, exist_ok=True)
                with package.extractfile(member) as source, target.open('xb') as destination_file:
                    shutil.copyfileobj(source, destination_file)
                target.chmod(member.mode)
        except BaseException:
            shutil.rmtree(output)
            raise


if __name__ == '__main__':
    if len(sys.argv) != 5:
        raise ValueError('expected archive, signing manifest, consumer contract and new output tree')
    extract(sys.argv[1], sys.argv[2], pack.load_json(Path(sys.argv[3]).read_bytes()), sys.argv[4])
