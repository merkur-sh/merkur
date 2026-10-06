"""Compare complete file-backed load mappings, without discarding loader metadata.

This is a byte-equivalence control, not source or license attribution. In particular,
Mach-O __LINKEDIT and mapped ELF headers participate: stripping is not an exemption.
Formats are the four pinned Bun platforms' little-endian 64-bit Mach-O and ELF.
"""

from dataclasses import dataclass
from pathlib import Path
import struct
import sys


@dataclass(frozen=True)
class Mapping:
    address: int
    memory_size: int
    permissions: tuple[int, ...]
    flags: int
    alignment: int
    name: str
    contents: bytes


@dataclass(frozen=True)
class Image:
    format: str
    identity: tuple[int, ...]
    mappings: tuple[Mapping, ...]


def bounded(data: bytes, offset: int, size: int) -> bytes:
    if offset < 0 or size < 0 or offset > len(data) or size > len(data) - offset:
        raise ValueError("Truncated native runtime mapping")
    return data[offset:offset + size]


def unpack(fmt: str, data: bytes, offset: int) -> tuple:
    return struct.unpack(fmt, bounded(data, offset, struct.calcsize(fmt)))


def mappings(values: list[Mapping]) -> tuple[Mapping, ...]:
    if not values:
        raise ValueError("Native runtime has no load mappings")
    result = tuple(sorted(values, key=lambda value: value.address))
    end = 0
    for value in result:
        if value.memory_size < len(value.contents):
            raise ValueError("File-backed bytes exceed native runtime memory mapping")
        if value.address > (1 << 64) - 1 - value.memory_size:
            raise ValueError("Native runtime virtual mapping overflows")
        if value.address < end:
            raise ValueError("Overlapping native runtime virtual mappings")
        end = value.address + value.memory_size
    return result


def elf_image(data: bytes) -> Image:
    ident = bounded(data, 0, 16)
    if ident[:7] != b"\x7fELF\x02\x01\x01":
        raise ValueError("Native runtime requires little-endian ELF64")
    (kind, machine, version, entry, program_offset, _section_offset, flags,
     header_size, program_size, program_count, _section_size, _section_count,
     _section_names) = unpack("<HHIQQQIHHHHHH", data, 16)
    if (kind not in (2, 3) or machine not in (62, 183) or version != 1
            or header_size != 64 or program_size != 56 or program_count in (0, 0xFFFF)):
        raise ValueError("Unsupported native runtime ELF header")
    bounded(data, program_offset, program_count * program_size)
    values = []
    loader_mapped = False
    file_ranges = []
    referenced_ranges = []
    previous_address = -1
    for index in range(program_count):
        (segment_kind, permissions, offset, address, _physical, file_size,
         memory_size, alignment) = unpack("<IIQQQQQQ", data, program_offset + index * 56)
        if segment_kind != 0 and file_size:
            bounded(data, offset, file_size)
            referenced_ranges.append((offset, file_size))
        if segment_kind != 1:
            continue
        if alignment > 1 and (alignment & (alignment - 1) or address % alignment != offset % alignment):
            raise ValueError("Invalid native runtime ELF mapping alignment")
        if address < previous_address:
            raise ValueError("Unordered native runtime ELF load mappings")
        previous_address = address
        if permissions & 4 and offset == 0 and file_size >= program_offset + program_count * program_size:
            loader_mapped = True
        file_ranges.append((offset, file_size))
        values.append(Mapping(address, memory_size, (permissions,), 0, alignment,
                              "PT_LOAD", bounded(data, offset, file_size)))
    if not loader_mapped:
        raise ValueError("Native runtime ELF loader metadata is outside its load mappings")
    for offset, size in referenced_ranges:
        if not any(start <= offset and size <= length - (offset - start)
                   for start, length in file_ranges):
            raise ValueError("Native runtime ELF program metadata references bytes outside its load mappings")
    return Image("ELF64", (kind, machine, entry, flags, ident[7], ident[8]), mappings(values))


def _macho_image(data: bytes, expected_kind: int) -> Image:
    (magic, cpu, subtype, kind, count, command_size, flags, reserved) = unpack("<IIIIIIII", data, 0)
    if magic != 0xFEEDFACF or cpu not in (0x01000007, 0x0100000C) or kind != expected_kind or reserved != 0:
        raise ValueError("Unsupported native runtime Mach-O header")
    bounded(data, 32, command_size)
    offset = 32
    values = []
    loader_mapped = False
    for _ in range(count):
        command, size = unpack("<II", data, offset)
        if size < 8 or size % 8 or size > 32 + command_size - offset:
            raise ValueError("Malformed native runtime Mach-O load command")
        raw = bounded(data, offset, size)
        if command == 0x19:  # LC_SEGMENT_64, including __PAGEZERO and __LINKEDIT.
            (_command, _size, name, address, memory_size, file_offset,
             file_size, maximum, initial, sections, segment_flags) = unpack("<II16sQQQQiiII", raw, 0)
            if size != 72 + sections * 80:
                raise ValueError("Malformed native runtime Mach-O segment sections")
            name = name.rstrip(b"\x00").decode("ascii")
            if initial & 1 and file_offset == 0 and file_size >= 32 + command_size:
                loader_mapped = True
            values.append(Mapping(address, memory_size, (maximum, initial), segment_flags,
                                  0, name, bounded(data, file_offset, file_size)))
        offset += size
    if offset != 32 + command_size:
        raise ValueError("Native runtime Mach-O command count does not cover its load commands")
    if not loader_mapped:
        raise ValueError("Native runtime Mach-O loader metadata is outside its load mappings")
    return Image("Mach-O64", (cpu, subtype, kind, flags), mappings(values))



def macho_image(data: bytes) -> Image:
    return _macho_image(data, 2)  # MH_EXECUTE: shipping runtime validation remains strict.


def loaded_dylib(data: bytes) -> Image:
    """Mach-O MH_DYLIB only, for the original shared-library retained-source join."""
    return _macho_image(data, 6)


def loaded_image(data: bytes) -> Image:
    if data.startswith(b"\x7fELF"):
        return elf_image(data)
    if data.startswith(b"\xcf\xfa\xed\xfe"):
        return macho_image(data)
    raise ValueError("Unsupported native runtime executable format")


def assert_loaded_bytes_equal(profile: bytes, shipping: bytes) -> None:
    left = loaded_image(profile)
    right = loaded_image(shipping)
    if left.format != right.format or left.identity != right.identity:
        raise ValueError("Profile and shipping native runtime executable identities differ")
    if len(left.mappings) != len(right.mappings):
        raise ValueError("Profile and shipping native runtime load mapping counts differ")
    for index, (original, stripped) in enumerate(zip(left.mappings, right.mappings, strict=True)):
        if original != stripped:
            raise ValueError(f"Profile and shipping native runtime load mapping {index} ({original.name}) differs")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit("Usage: runtime-sections.py PROFILE_EXECUTABLE SHIPPING_EXECUTABLE")
    assert_loaded_bytes_equal(Path(sys.argv[1]).read_bytes(), Path(sys.argv[2]).read_bytes())
    print("Complete native runtime load mappings are byte-identical")
