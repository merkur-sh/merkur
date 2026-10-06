"""Retained native compiler inputs, bound to original bytes; no complete notice provider.

Mach-O grammar follows the original ld64/LLVM map sections. ELF grammar is
LLVM lld's fixed-column VMA/LMA map, not the GNU stock-stdlib map grammar.
Configured objects and dead-stripped entries never substitute for retained code.
"""

import hashlib
import json
from pathlib import Path, PurePosixPath
import posixpath
import re
import shlex


class PendingLinkedSource(ValueError):
    """An actual retained input still lacks exact source-selection authority."""


def mapped(address, size, image):
    return any(segment.permissions[-1] and segment.address <= address and
               address + size <= segment.address + segment.memory_size
               for segment in image.mappings)


def macho_map_selection(raw, target, linked_path, image, mapper):
    if not target.endswith('apple-darwin') or image.format != 'Mach-O64':
        raise ValueError('Mach-O retained inputs require the exact native image family')
    architecture = {'aarch64-apple-darwin': 'arm64', 'x86_64-apple-darwin': 'x86_64'}[target]
    if image.identity[0] != (0x0100000C if architecture == 'arm64' else 0x01000007):
        raise ValueError('Retained linker map target differs from the native image')
    text = raw.decode('utf8')
    lines = text.splitlines()
    if lines[:2] != ['# Path: ' + linked_path, '# Arch: ' + architecture]:
        raise ValueError('Retained linker map belongs to another original output')
    inventory = mapper.map_records(raw, target)
    objects, retained, sections, symbols = {}, set(), [], []
    state, seen = None, set()
    states = {'# Object files:': 'objects', '# Sections:': 'sections',
              '# Symbols:': 'symbols', '# Dead Stripped Symbols:': 'dead'}
    for line in lines[2:]:
        if line in states:
            state = states[line]
            if state in seen:
                raise ValueError('Duplicate retained linker map section')
            seen.add(state)
            continue
        if line.startswith('#'):
            headers = {'sections': '# Address', 'symbols': '# Address', 'dead': '#'}
            if state not in headers or not line.startswith(headers[state]):
                raise ValueError('Unknown retained linker map section/header')
            continue
        if not line:
            continue
        if state == 'objects':
            match = re.fullmatch(r'\[\s*(\d+)\]\s+(.+)', line)
            if not match or int(match[1]) in objects:
                raise ValueError('Malformed/duplicate retained object identity')
            objects[int(match[1])] = match[2]
        elif state == 'sections':
            fields = line.split()
            if len(fields) != 4:
                raise ValueError('Malformed original mapped section')
            try:
                address, size = int(fields[0], 16), int(fields[1], 16)
            except ValueError as error:
                raise ValueError('Malformed original mapped section address') from error
            if address < 0 or size < 0 or not mapped(address, size, image):
                raise ValueError('Linker map section is outside the actual native image')
            sections.append((address, size))
        elif state in ('symbols', 'dead'):
            pattern = (r'(0x[0-9A-Fa-f]+)\s+(0x[0-9A-Fa-f]+)\s+\[\s*(\d+)\]\s+(.+)'
                       if state == 'symbols' else
                       r'<<dead>>\s+(0x[0-9A-Fa-f]+)\s+\[\s*(\d+)\]\s+(.+)')
            match = re.fullmatch(pattern, line)
            if not match:
                raise ValueError('Malformed original retained/dead symbol')
            index = int(match[3] if state == 'symbols' else match[2])
            if index not in objects:
                raise ValueError('Retained symbol references an absent object identity')
            if state == 'symbols':
                address, size = int(match[1], 16), int(match[2], 16)
                if not (mapped(address, size, image) if index == 0 else
                        any(start <= address and address + size <= start + length
                            for start, length in sections)):
                    raise ValueError('Retained symbol is outside the original mapped sections')
                symbols.append({"name": match[4], "address": address, "size": size,
                                "object": objects[index]})
                if index:
                    # Zero-sized live aliases/ICF records are still retained
                    # definitions. They are not the dead-symbol section.
                    retained.add(index)
        else:
            raise ValueError('Unscoped original linker map data')
    if not {'objects', 'sections', 'symbols'}.issubset(seen) or not retained:
        raise ValueError('Original native map has no retained compiler inputs')
    if list(objects.values()) != inventory or objects.get(0) != 'linker synthesized':
        raise ValueError('Original object identities disagree with the declared map grammar')
    return tuple(objects[index] for index in sorted(retained)), tuple(symbols)


def macho_retained(raw, target, linked_path, image, mapper):
    return macho_map_selection(raw, target, linked_path, image, mapper)[0]


def elf_retained(raw, target, native_bytes, sections):
    image = sections.loaded_image(native_bytes)
    machines = {'aarch64-unknown-linux-gnu': 183, 'x86_64-unknown-linux-gnu': 62}
    if target not in machines or image.format != 'ELF64' or image.identity[1] != machines[target]:
        raise ValueError('ELF retained inputs require the exact native image family')
    header = sections.unpack('<HHIQQQIHHHHHH', native_bytes, 16)
    section_offset, section_size, section_count, names_index = header[5], header[10], header[11], header[12]
    if section_size != 64 or section_count in (0, 0xFFFF) or not 0 < names_index < section_count:
        raise ValueError('Original allocated ELF section-header authority is required')
    sections.bounded(native_bytes, section_offset, section_count * section_size)
    table = [sections.unpack('<IIQQQQIIQQ', native_bytes, section_offset + index * section_size)
             for index in range(section_count)]
    names = table[names_index]
    if names[1] != 3:
        raise ValueError('Original ELF section-name authority is not a string table')
    strings = sections.bounded(native_bytes, names[4], names[5])
    allocated = {}
    for value in table:
        name_offset, kind, flags, address, offset, size = value[:6]
        if not flags & 2:  # Original SHF_ALLOC flag, never a debug-name guess.
            continue
        end = strings.find(b'\0', name_offset)
        if name_offset >= len(strings) or end < 0:
            raise ValueError('Malformed original allocated ELF section name')
        name = strings[name_offset:end].decode('utf8')
        if not name or name in allocated or not mapped(address, size, image):
            raise ValueError('Ambiguous/unmapped original allocated ELF section')
        if kind != 8:  # Original SHT_NOBITS memory has no file-backed bytes.
            sections.bounded(native_bytes, offset, size)
        allocated[name] = (address, size)
    if not allocated:
        raise ValueError('Original native ELF has no allocated section authority')
    lines = raw.decode('utf8').splitlines()
    if not lines or lines[0].split() != ['VMA', 'LMA', 'Size', 'Align', 'Out', 'In', 'Symbol']:
        raise ValueError('Exact original LLVM lld map grammar is required')
    result, active = set(), None
    for line in lines[1:]:
        if not line:
            continue
        # These fixed columns are emitted by original lld::elf::writeHeader.
        if len(line) < 49:
            raise ValueError('Malformed original LLVM lld map row')
        fields = line[:49].split()
        if len(fields) != 4:
            raise ValueError('Malformed original LLVM lld numeric columns')
        try:
            address, _physical, size = (int(value, 16) for value in fields[:3])
            alignment = int(fields[3])
        except ValueError as error:
            raise ValueError('Malformed original LLVM lld numeric value') from error
        if min(address, size, alignment) < 0:
            raise ValueError('Negative original LLVM lld map value')
        tail = line[49:]
        if not tail.startswith('        '):
            active = allocated.get(tail)
            if active is not None and active != (address, size):
                raise ValueError('Linker map differs from its original allocated output section')
            continue
        if tail.startswith('                '):
            continue  # Nested original symbol row, never an input object.
        source = tail[8:]
        if ':(' not in source or not source.endswith(')'):
            continue  # A linker-script command, never an inferred object input.
        file, section = source.rsplit(':(', 1)
        if not file or not section[:-1]:
            raise ValueError('Malformed original LLVM lld input-section record')
        if active is not None:
            start, length = active
            if not start <= address or address + size > start + length:
                raise ValueError('Retained input is outside its original allocated output section')
            # Original LLD uses this reserved record for synthesized sections,
            # analogous to ld64's linker-synthesized object0, not source code.
            if file != '<internal>':
                result.add(file)
    if not result:
        raise ValueError('Original native ELF map has no retained compiler inputs')
    return tuple(sorted(result))


def compiler_commands(raw):
    values = json.loads(raw)
    if not isinstance(values, list) or not values:
        raise ValueError('Original compiler command database is required')
    result = {}
    for value in values:
        if not isinstance(value, dict):
            raise ValueError('Malformed original compiler command')
        if 'output' not in value:
            continue  # Original clangd-only entries are not compile actions.
        directory = Path(value['directory'])
        if not directory.is_absolute():
            raise ValueError('Original compiler working directory must be explicit')
        output = str(directory / value['output'])
        source = str(directory / value['file'])
        if output in result or '..' in Path(output).parts or '..' in Path(source).parts:
            raise ValueError('Ambiguous/escaping original compiler input relation')
        if 'arguments' in value and 'command' in value:
            raise ValueError('Original compiler command has ambiguous argument forms')
        if 'command' in value:
            if not isinstance(value['command'], str):
                raise ValueError('Original CMake compiler command must be literal POSIX text')
            arguments = shlex.split(value['command'], posix=True)
        else:
            arguments = value.get('arguments')
        if not isinstance(arguments, list) or not arguments or any(not isinstance(item, str) for item in arguments):
            raise ValueError('Original compiler argument inventory is absent')
        for flag, expected in [('-c', source), ('-o', output)]:
            if arguments.count(flag) != 1:
                raise ValueError('Original compiler source/output flag relation is ambiguous')
            index = arguments.index(flag) + 1
            if index >= len(arguments) or str(directory / arguments[index]) != expected:
                raise ValueError('Original compiler command differs from declared source/output relation')
        result[output] = source
    return result


def ninja_dependencies(raw, directory):
    result, current, expected = {}, None, 0
    for line in raw.decode('utf8').splitlines():
        if not line:
            continue
        if line.startswith('    '):
            if current is None:
                raise ValueError('Unscoped original Ninja compiler dependency')
            result[current].append(str(Path(directory) / line[4:]))
            continue
        if current is not None and len(result[current]) != expected:
            raise ValueError('Original Ninja compiler dependency count differs')
        match = re.fullmatch(r'(.+): #deps (\d+), deps mtime (\d+) \(VALID\)', line)
        if not match:
            raise ValueError('Original Ninja compiler dependency is absent/stale')
        current, expected = str(Path(directory) / match[1]), int(match[2])
        if current in result:
            raise ValueError('Duplicate original Ninja compiler dependency record')
        result[current] = []
    if current is not None and len(result[current]) != expected:
        raise ValueError('Original Ninja compiler dependency count differs')
    return result



def make_dependencies(raw, directory, commands):
    """Original Clang Make depfiles joined to exact configured compiler objects.

    This is dependency-file grammar, not a Make program evaluator. Original -MP
    header rules are checked against the same original prerequisites, never
    treated as compiler outputs. No filesystem or source selection is inferred.
    """
    directory = Path(directory)
    if not directory.is_absolute() or '..' in directory.parts:
        raise ValueError('Make dependencies require an exact original working directory')
    text = raw.decode('utf-8')
    if not text or not text.endswith('\n') or '\0' in text:
        raise ValueError('Original Make dependency file is empty or truncated')
    rules, targets, inputs, token, separator = [], [], [], [], False

    def word():
        if token:
            (inputs if separator else targets).append(''.join(token))
            token.clear()

    index = 0
    while index < len(text):
        character = text[index]
        if character == '\\':
            end = index
            while end < len(text) and text[end] == '\\':
                end += 1
            count = end - index
            if end == len(text):
                raise ValueError('Original Make dependency escape is truncated')
            following = text[end]
            if following in '\r\n':
                if count != 1 or (following == '\r' and text[end:end + 2] != '\r\n'):
                    raise ValueError('Unknown original Make continuation grammar')
                word()
                index = end + (2 if following == '\r' else 1)
                if index == len(text):
                    raise ValueError('Original Make continuation is truncated')
                continue
            if following in ' \t' and count % 2:
                token.extend('\\' * (count // 2))
                token.append(following)
                index = end + 1
                continue
            if following in '#:':
                token.extend('\\' * (count - 1))
                token.append(following)
                index = end + 1
                continue
            # Clang doubles backslashes only when quoting whitespace. Ordinary
            # backslashes remain literal, including pairs before a delimiter.
            token.extend('\\' * count)
            index = end
            continue
        if character == '$':
            if text[index:index + 2] != '$$':
                raise ValueError('Original Make dependency contains an unresolved expansion')
            token.append('$')
            index += 2
            continue
        if character == ':' and not separator and text[index + 1:index + 2] in (' ', '\t', '\n', '\r'):
            word()
            if len(targets) != 1:
                raise ValueError('Original Make rule lacks one exact target identity')
            separator = True
        elif character in ' \t':
            word()
        elif character in '\r\n':
            if character == '\r':
                if text[index:index + 2] != '\r\n':
                    raise ValueError('Unknown original Make line ending')
                index += 1
            word()
            if targets or inputs or separator:
                if not separator or len(targets) != 1:
                    raise ValueError('Unknown original Make dependency rule grammar')
                rules.append((targets[0], inputs))
            targets, inputs, separator = [], [], False
        else:
            if character in '#;|=*?[]' or ord(character) < 32 or ord(character) == 127:
                raise ValueError('Unknown original Make dependency program grammar')
            token.append(character)
        index += 1

    def original_path(value):
        path = directory / value
        if '..' in path.parts:
            raise ValueError('Make dependency lacks an exact original path')
        return str(path)

    result, phony = {}, []
    for target, prerequisites in rules:
        output = original_path(target)
        if not prerequisites:
            phony.append(output)
            continue
        if output not in commands:
            raise ValueError('Make dependency target lacks its declared compiler object')
        if output in result:
            raise ValueError('Make dependencies repeat an original compiler object')
        dependencies = [original_path(value) for value in prerequisites]
        if dependencies[0] != commands[output]:
            raise ValueError('Make dependency source differs from its original compiler command')
        result[output] = dependencies
    if not result:
        raise ValueError('Original Make dependencies contain no compiler object rule')
    headers = {value for dependencies in result.values() for value in dependencies}
    sources = set(commands.values())
    seen = set()
    for target in phony:
        if target in seen or target not in headers or target in sources or target in commands:
            raise ValueError('Make phony target lacks its original compiler prerequisite')
        seen.add(target)
    return result

def selected_direct_inputs(retained, commands, dependencies, directory):
    selected, pending = set(), []
    for record in retained:
        object_file = str(Path(directory) / record)
        if object_file not in commands:
            # Archive members and persisted LTO objects need their actual
            # linked DWARF/member authority; never expand to configured inputs.
            pending.append(record)
            continue
        if object_file not in dependencies:
            raise ValueError('Retained compiler object lacks actual compiler dependency facts')
        selected.add(commands[object_file])
        selected.update(dependencies[object_file])
    if pending:
        raise PendingLinkedSource('Retained runtime inputs lack exact LTO/archive/source authority: ' + repr(pending))
    return tuple(sorted(selected))


def archive_origin(component, namespace, directory, raw, pins, custody, licenses):
    members, facts = custody.source_archive_members(raw, pins, licenses.relative)
    aliases = {item['path']: item['target'] for item in facts if item['kind'] == 'symlink'}
    return {'component': component, 'namespace': str(namespace), 'directory': Path(directory),
            'members': members, 'aliases': aliases}


def original_member(relative, origin, licenses):
    licenses.relative(relative)
    seen = set()
    while True:
        parts = relative.split('/')
        changed = False
        for count in range(1, len(parts) + 1):
            prefix = '/'.join(parts[:count])
            if prefix not in origin['aliases']:
                continue
            if relative in seen:
                raise ValueError('Cyclic original source alias')
            seen.add(relative)
            actual = origin['directory'] / prefix
            if not actual.is_symlink() or actual.readlink().as_posix() != origin['aliases'][prefix]:
                raise ValueError('Selected source alias differs from its original archive')
            target = origin['aliases'][prefix]
            if PurePosixPath(target).is_absolute():
                raise ValueError('Original source alias escaped its archive')
            relative = posixpath.normpath(posixpath.join(posixpath.dirname(prefix), target,
                                                        *parts[count:]))
            licenses.relative(relative)
            changed = True
            break
        if not changed:
            return relative


def bind_original_inputs(selected, origins, licenses):
    result = []
    for source in selected:
        if not Path(source).is_absolute() or '..' in Path(source).parts:
            raise ValueError('Selected compiler source path is not an exact original path')
        matches = [origin for origin in origins if source.startswith(origin['namespace'].rstrip('/') + '/')]
        if not matches:
            raise PendingLinkedSource('Selected source has no original archive byte authority: ' + source)
        length = max(len(origin['namespace'].rstrip('/')) for origin in matches)
        matches = [origin for origin in matches if len(origin['namespace'].rstrip('/')) == length]
        if len(matches) != 1:
            raise ValueError('Selected compiler source has ambiguous original archive authority')
        origin = matches[0]
        relative = source[length + 1:]
        canonical = original_member(relative, origin, licenses)
        if canonical not in origin['members']:
            raise PendingLinkedSource('Generated/SDK source lacks exact original producing-input authority: ' + source)
        actual = licenses.read_regular(origin['directory'], canonical, require_text=False)
        presentation = {**origin, 'directory': Path(origin['namespace'])}
        selected_member = original_member(relative, presentation, licenses)
        selected_bytes = licenses.read_regular(presentation['directory'], selected_member, require_text=False)
        expected = origin['members'][canonical]
        if actual != expected or selected_bytes != expected:
            raise ValueError('Selected compiler source differs from original archive bytes')
        result.append({'component': origin['component'], 'path': relative,
                       'source_path': canonical, 'size': len(actual),
                       'sha256': hashlib.sha256(actual).hexdigest()})
    return result

def selected_archive_inputs(retained, commands, dependencies, directory, archives, mapper, licenses):
    """Select only exact retained original ar members with same-build object bytes."""
    records, selected, members = [], [], {}
    object_facts = {}
    for output in commands:
        path = Path(output)
        try:
            data = licenses.read_regular(path.parent, path.name, require_text=False)
        except FileNotFoundError:
            # Original CMake exports configured targets that the same native
            # build never compiled. Only an existing object with exactly the
            # retained member bytes can establish selection below.
            continue
        fact = (len(data), hashlib.sha256(data).hexdigest())
        object_facts.setdefault(fact, []).append(output)
    for record in retained:
        if not record.endswith(')') or '(' not in record:
            records.append(record)
            continue
        library, member = record.rsplit('(', 1)
        member = member[:-1]
        library = str(Path(directory) / library)
        if '..' in Path(library).parts or not member or '/' in member or '\\' in member:
            raise ValueError('Retained archive member has an escaping original identity')
        if library not in archives:
            raise PendingLinkedSource('Retained archive lacks its original same-build File: ' + library)
        if library not in members:
            path = Path(library)
            actual = licenses.read_regular(path.parent, path.name, require_text=False)
            if actual != archives[library]:
                raise ValueError('Retained archive differs from its original same-build bytes')
            members[library] = mapper.archive_members(actual)
        if member not in members[library]:
            raise ValueError('Retained linker-map member is absent from its original archive')
        fact = members[library][member]
        matches = object_facts.get((fact['size'], fact['sha256']), [])
        if len(matches) != 1:
            raise PendingLinkedSource('Retained archive member lacks unique original compiler object authority: ' + record)
        selected.append(matches[0])
    return selected_direct_inputs((*records, *selected), commands, dependencies, directory)


def native_selection(directory, images, target, command_bytes, dependency_files, sections, mapper, licenses):
    """Read actual same-build maps, compiler commands and individual Make Files."""
    commands = compiler_commands(command_bytes)
    dependencies = {}
    for file in dependency_files:
        if file.is_symlink() or not file.is_file():
            raise ValueError('Binaryen dependency is not an original ordinary compiler File')
        values = make_dependencies(file.read_bytes(), directory, commands)
        if set(values).intersection(dependencies):
            raise ValueError('Binaryen repeats an original compiler object dependency')
        dependencies.update(values)
    if not dependencies:
        raise ValueError('Binaryen compiler dependency File closure is absent')
    archives = {str(file): licenses.read_regular(file.parent, file.name, require_text=False)
                for file in directory.rglob('*.a')}
    selected = set()
    for binary, map_file, kind in images:
        raw = licenses.read_regular(binary.parent, binary.name, require_text=False)
        mapping = licenses.read_regular(map_file.parent, map_file.name, require_text=False)
        if target.endswith('apple-darwin'):
            image = sections.loaded_dylib(raw) if kind == 'dylib' else sections.loaded_image(raw)
            header = mapping.decode('utf8').splitlines()[0]
            if not header.startswith('# Path: '):
                raise ValueError('Binaryen original linker map output path is absent')
            linked_path = header.removeprefix('# Path: ')
            if '..' in Path(linked_path).parts or directory / linked_path != binary:
                raise ValueError('Binaryen original linker map belongs to another output File')
            retained = macho_retained(mapping, target, linked_path, image, mapper)
        else:
            if kind != 'executable':
                raise ValueError('Original Binaryen ELF factory requires its static executable')
            retained = elf_retained(mapping, target, raw, sections)
        selected.update(selected_archive_inputs(retained, commands, dependencies,
            directory, archives, mapper, licenses))
    return tuple(sorted(selected))

