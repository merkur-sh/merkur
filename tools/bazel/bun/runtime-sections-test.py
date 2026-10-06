"""Controls for complete native runtime mappings, including loader metadata."""

import importlib.util
from pathlib import Path
import struct
import sys
import unittest

spec = importlib.util.spec_from_file_location("runtime_sections", Path(__file__).with_name("runtime-sections.py"))
runtime = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = runtime
spec.loader.exec_module(runtime)


def elf(machine=183):
    data = bytearray(1024)
    data[:16] = b"\x7fELF\x02\x01\x01" + bytes(9)
    struct.pack_into("<HHIQQQIHHHHHH", data, 16, 3, machine, 1, 0x1200, 64, 0, 0, 64, 56, 2, 0, 0, 0)
    struct.pack_into("<IIQQQQQQ", data, 64, 1, 4, 0, 0x1000, 0, 256, 256, 256)
    struct.pack_into("<IIQQQQQQ", data, 120, 1, 5, 512, 0x1200, 0, 8, 24, 256)
    data[512:520] = b"BUN_CODE"
    data[800:808] = b"DEBUG123"
    return data


def macho(cpu=0x0100000C):
    data = bytearray(1024)
    struct.pack_into("<IIIIIIII", data, 0, 0xFEEDFACF, cpu, 0, 2, 2, 144, 0, 0)
    struct.pack_into("<II16sQQQQiiII", data, 32, 0x19, 72, b"__TEXT", 0x1000, 256, 0, 256, 5, 5, 0, 0)
    struct.pack_into("<II16sQQQQiiII", data, 104, 0x19, 72, b"__LINKEDIT", 0x1200, 256, 512, 8, 1, 1, 0, 0)
    data[192:200] = b"BUN_CODE"
    data[512:520] = b"DYLDINFO"
    data[800:808] = b"DEBUG123"
    return data


class NativeRuntimeMappingTest(unittest.TestCase):
    def test_dylib_header_does_not_relax_shipping_executable_validation(self):
        # Synthetic kind mutation tests the strict API boundary, not a genuine
        # shared-library build or dynamic-loader equivalence qualification.
        library = macho()
        struct.pack_into("<I", library, 12, 6)
        self.assertEqual(runtime.loaded_dylib(library).identity[2], 6)
        for consumer in (runtime.macho_image, runtime.loaded_image):
            with self.assertRaisesRegex(ValueError, "Mach-O header"):
                consumer(library)
        with self.assertRaises(ValueError):
            runtime.assert_loaded_bytes_equal(library, library)

    def test_dylib_explicit_entrypoint_rejects_wrong_kinds_and_formats(self):
        for kind in (0, 1, 2, 3, 5, 7, 8, 9, 10, 11):
            image = macho()
            struct.pack_into("<I", image, 12, kind)
            with self.subTest(kind=kind), self.assertRaisesRegex(ValueError, "Mach-O header"):
                runtime.loaded_dylib(image)
        for image in (b"", b"MZ" + bytes(128), elf(), macho()[:31]):
            with self.subTest(image=image[:4]), self.assertRaises(ValueError):
                runtime.loaded_dylib(image)

    def test_dylib_preserves_mapping_bounds_and_loader_metadata_requirements(self):
        for offset, fmt, value in ((16, "I", 1), (36, "I", 80), (168, "I", 1),
                                   (128, "Q", 0x1000), (72, "Q", 256)):
            image = macho()
            struct.pack_into("<I", image, 12, 6)
            struct.pack_into("<" + fmt, image, offset, value)
            with self.subTest(offset=offset), self.assertRaises(ValueError):
                runtime.loaded_dylib(image)


    def test_four_native_formats_preserve_every_mapping_and_zero_fill(self):
        for data in (elf(183), elf(62), macho(0x0100000C), macho(0x01000007)):
            with self.subTest(cpu=runtime.loaded_image(data).identity):
                runtime.assert_loaded_bytes_equal(data, bytes(data))
                self.assertEqual(len(runtime.loaded_image(data).mappings), 2)
        self.assertEqual(runtime.loaded_image(elf()).mappings[1].memory_size, 24)

    def test_debug_bytes_outside_load_mappings_do_not_change_the_image(self):
        for original in (elf(), macho()):
            changed = original.copy()
            changed[800:808] = b"STRIPPED"
            runtime.assert_loaded_bytes_equal(original, changed)

    def test_mapped_code_data_and_loader_metadata_are_never_exempt(self):
        for original, positions in ((elf(), (24, 48, 68, 512)), (macho(), (24, 64, 192, 512))):
            for position in positions:
                with self.subTest(format=runtime.loaded_image(original).format, offset=position):
                    changed = original.copy()
                    changed[position] ^= 1
                    with self.assertRaises(ValueError):
                        runtime.assert_loaded_bytes_equal(original, changed)

    def test_virtual_addresses_permissions_zero_fill_and_cpu_must_match(self):
        for offset, fmt, value in ((18, "H", 62), (136, "Q", 0x1300), (124, "I", 4), (160, "Q", 25)):
            changed = elf()
            struct.pack_into("<" + fmt, changed, offset, value)
            with self.subTest(offset=offset), self.assertRaises(ValueError):
                runtime.assert_loaded_bytes_equal(elf(), changed)
        for offset, value in ((4, 0x01000007), (168, 1), (160, 0)):
            changed = macho()
            struct.pack_into("<I", changed, offset, value)
            with self.subTest(offset=offset), self.assertRaises(ValueError):
                runtime.assert_loaded_bytes_equal(macho(), changed)

    def test_truncation_and_foreign_formats_are_refused(self):
        for data in (b"", b"MZ" + bytes(128), elf()[:519], macho()[:519], elf()[:64], macho()[:31]):
            with self.subTest(length=len(data)), self.assertRaises(ValueError):
                runtime.loaded_image(data)
        big_endian = elf()
        big_endian[5] = 2
        with self.assertRaises(ValueError):
            runtime.loaded_image(big_endian)

    def test_elf_rejects_overlap_overflow_bad_alignment_and_file_larger_than_memory(self):
        for offset, value in ((136, 0x1000), (136, (1 << 64) - 16), (168, 3), (160, 7)):
            changed = elf()
            struct.pack_into("<Q", changed, offset, value)
            with self.subTest(offset=offset), self.assertRaises(ValueError):
                runtime.loaded_image(changed)

    def test_macho_rejects_incomplete_commands_overlap_and_forged_sections(self):
        for offset, value in ((16, 1), (36, 80), (168, 1)):
            changed = macho()
            struct.pack_into("<I", changed, offset, value)
            with self.subTest(offset=offset), self.assertRaises(ValueError):
                runtime.loaded_image(changed)
        changed = macho()
        struct.pack_into("<Q", changed, 128, 0x1000)
        with self.assertRaises(ValueError):
            runtime.loaded_image(changed)

    def test_an_executable_without_load_mappings_is_refused(self):
        empty = elf()
        struct.pack_into("<I", empty, 64, 0)
        struct.pack_into("<I", empty, 120, 0)
        with self.assertRaises(ValueError):
            runtime.loaded_image(empty)

    def test_loader_metadata_cannot_be_moved_outside_compared_bytes(self):
        unmapped_elf = elf()
        struct.pack_into("<Q", unmapped_elf, 72, 256)
        unmapped_macho = macho()
        struct.pack_into("<Q", unmapped_macho, 72, 256)
        for data in (unmapped_elf, unmapped_macho):
            with self.subTest(format=data[:4]), self.assertRaises(ValueError):
                runtime.loaded_image(data)

    def test_interpreter_bytes_outside_load_mappings_cannot_be_ignored(self):
        image = elf()
        struct.pack_into("<H", image, 56, 3)
        struct.pack_into("<IIQQQQQQ", image, 176, 3, 4, 800, 0, 0, 16, 16, 1)
        image[800:816] = b"/lib/loader-one\x00\x00"
        altered = image.copy()
        altered[800:816] = b"/lib/loader-two\x00\x00"
        for data in (image, altered):
            with self.assertRaisesRegex(ValueError, 'references bytes outside'):
                runtime.loaded_image(data)
        with self.assertRaises(ValueError):
            runtime.assert_loaded_bytes_equal(image, altered)

    def test_interpreter_bytes_inside_load_mappings_participate_in_comparison(self):
        image = elf()
        struct.pack_into("<H", image, 56, 3)
        struct.pack_into("<IIQQQQQQ", image, 176, 3, 4, 232, 0, 0, 16, 16, 1)
        image[232:248] = b"/lib/loader-one\x00\x00"
        runtime.assert_loaded_bytes_equal(image, image)
        altered = image.copy()
        altered[232:248] = b"/lib/loader-two\x00\x00"
        with self.assertRaises(ValueError):
            runtime.assert_loaded_bytes_equal(image, altered)


if __name__ == "__main__":
    unittest.main()
