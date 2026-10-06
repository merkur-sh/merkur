"""Check the declared LLVM source action without substituting a fake compiler."""
import copy
import hashlib
import importlib.util
import io
from pathlib import Path
import tarfile
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location("llvm_builder", Path(__file__).with_name("build.py"))
BUILDER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(BUILDER)


def specification():
    result = {"version": "21.1.8", "projects": ["clang", "lld"], "platform": "darwin_arm64",
              "tools": {name: "out/tools/" + name for name in BUILDER.TOOLS}}
    for name in ["cc", "cxx", "ar", "ranlib", "cmake", "make_driver", "make", "shell", "git", "python", "uname"]:
        result[name] = "declared/bin/" + name
    return result


def archive(names):
    data = io.BytesIO()
    with tarfile.open(fileobj=data, mode="w:xz") as output:
        for name in names:
            member = tarfile.TarInfo(name)
            member.size = 5
            output.addfile(member, io.BytesIO(b"bytes"))
    return data.getvalue()


class Controls(unittest.TestCase):
    def test_original_pin_refuses_before_output(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "source.tar.xz"
            source.write_bytes(archive([BUILDER.PREFIX + "/llvm/CMakeLists.txt"]))
            with self.assertRaisesRegex(ValueError, "original21.1.8"):
                BUILDER.extract_original(source, root / "output")
            self.assertFalse((root / "output").exists())

    def test_canonical_archive_member_controls(self):
        valid = BUILDER.PREFIX + "/llvm/input"
        for names in [[valid, valid], [valid, BUILDER.PREFIX + "/llvm/./input"],
                      [BUILDER.PREFIX + "/../outside"], ["/absolute"], ["foreign/llvm/input"]]:
            with self.subTest(names=names), tempfile.TemporaryDirectory() as temporary:
                destination = Path(temporary) / "output"
                with self.assertRaisesRegex(ValueError, "Noncanonical or duplicate"):
                    BUILDER.extract(archive(names), destination)
                self.assertFalse(destination.exists())

    def test_tarlink_escape_refused(self):
        data = io.BytesIO()
        with tarfile.open(fileobj=data, mode="w:xz") as output:
            member = tarfile.TarInfo(BUILDER.PREFIX + "/llvm/link")
            member.type = tarfile.SYMTYPE
            member.linkname = "/outside"
            output.addfile(member)
        with tempfile.TemporaryDirectory() as temporary:
            with self.assertRaises(tarfile.FilterError):
                BUILDER.extract(data.getvalue(), Path(temporary) / "output")
            self.assertFalse((Path(temporary) / "output" / BUILDER.PREFIX / "llvm/link").exists())

    def test_mandatory_selection(self):
        value = specification()
        BUILDER.validate(value)
        mutations = []
        for name in ["cc", "cxx", "ar", "ranlib", "cmake", "make_driver", "make", "shell", "git", "python", "uname"]:
            changed = copy.deepcopy(value)
            del changed[name]
            mutations.append(changed)
        for name, replacement in [("version", "22.1.6"), ("projects", ["clang"]),
                                  ("platform", "windows_x64"), ("tools", {"clang": "only"})]:
            changed = copy.deepcopy(value)
            changed[name] = replacement
            mutations.append(changed)
        for changed in mutations:
            with self.subTest(value=changed), self.assertRaises(ValueError):
                BUILDER.validate(changed)

    def test_configure_preserves_defaults_and_declared_tools(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            value = specification()
            flags = {name: "/declared/" + name for name in value if name not in {"version", "projects", "platform", "tools"}}
            flags.update(sdk="/declared/sdk", make_sdk="/declared/make", compile_flags=["-isysroot", "/declared/apple-sdk"],
                         cxx_flags=["-isysroot", "/declared/apple-sdk"], link_flags=["-Wl,-syslibroot,/declared/apple-sdk"])
            _, contents, command = BUILDER.configuration(value, root / "source", root / "build", root / "install", {"SDKROOT": "/declared/apple-sdk"}, flags)
            self.assertIn("-DLLVM_ENABLE_PROJECTS=clang;lld", command)
            self.assertIn("-DCMAKE_BUILD_TYPE=Release", command)
            self.assertIn("-DPython3_EXECUTABLE=/declared/python", command)
            self.assertIn("-DGIT_EXECUTABLE=/declared/git", command)
            self.assertIn("-DCMAKE_UNAME:FILEPATH=/declared/uname", command)
            self.assertIn('set(CMAKE_MAKE_PROGRAM "/declared/make_driver" CACHE FILEPATH "declared Make driver")', contents)
            self.assertIn('set(CMAKE_OSX_SYSROOT "/declared/apple-sdk")', contents)
            self.assertIn('set(CMAKE_FIND_ROOT_PATH_MODE_LIBRARY "ONLY")', contents)
            self.assertFalse(any("LLVM_INCLUDE_TESTS" in arg or "LLVM_ENABLE_ZLIB" in arg or "LLVM_TARGETS_TO_BUILD" in arg for arg in command))
            with self.assertRaisesRegex(ValueError, "SDKROOT"):
                BUILDER.configuration(value, root / "source", root / "build", root / "install", {}, flags)

    def test_declared_inventory_tracks_tree_members_and_mutations(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "sdk").mkdir()
            (root / "sdk/member").write_bytes(b"first")
            before = BUILDER.input_facts(root, [{"path": "sdk", "kind": "tree"}, {"path": "sdk/member", "kind": "file"}])
            self.assertEqual(len(before), 1)
            self.assertEqual(before[0]["sha256"], hashlib.sha256(b"first").hexdigest())
            (root / "sdk/member").write_bytes(b"second")
            self.assertNotEqual(before, BUILDER.input_facts(root, [{"path": "sdk", "kind": "tree"}]))
            (root / "sdk/alias").symlink_to(root / "sdk", target_is_directory=True)
            with self.assertRaisesRegex(ValueError, "aliased directory"):
                BUILDER.input_facts(root, [{"path": "sdk", "kind": "tree"}])

    def test_declared_directory_symlink_is_not_a_tree(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "framework/A/Resources").mkdir(parents=True)
            (root / "other-framework").mkdir()
            (root / "other-framework/audio.tbd").write_bytes(b"declared audio")
            (root / "framework/A/Resources/audio.tbd").symlink_to("../../../other-framework/audio.tbd")
            (root / "framework/Current").symlink_to("A", target_is_directory=True)
            inputs = [{"path": "framework/Current", "kind": "symlink"},
                      {"path": "other-framework/audio.tbd", "kind": "file"}]
            before = BUILDER.input_facts(root, inputs)
            self.assertEqual(len(before), 2)
            self.assertEqual(before[0]["target"], "A")
            self.assertEqual(before[0]["sha256"], hashlib.sha256(b"A").hexdigest())
            (root / "framework/Current").unlink()
            (root / "framework/Current").symlink_to("absent")
            self.assertNotEqual(before, BUILDER.input_facts(root, inputs))
            # An ordinary File must never implicitly acquire a directory tree.
            with self.assertRaisesRegex(ValueError, "regular File is a directory"):
                BUILDER.input_facts(root, [{"path": "framework/A", "kind": "file"}])

    def test_input_declared_types_are_required(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for inputs in [[{"path": "sdk", "kind": "unknown"}],
                           [{"path": "sdk", "kind": "tree"}] * 2,
                           [{"path": "sdk"}]]:
                with self.subTest(inputs=inputs), self.assertRaisesRegex(ValueError, "unique declared File type"):
                    BUILDER.input_facts(root, inputs)

    def test_missing_tool_closure_refuses_without_publication(self):
        value = specification()
        value["platform"] = BUILDER.native_platform()
        value["inputs"] = []
        value["runtime"] = "out/sdk"
        value["manifest"] = "out/manifest.json"
        with self.assertRaisesRegex(ValueError, "declared File closure"):
            BUILDER.build(value)

    def test_authored_tree_leaf_cannot_import_undeclared_host_bytes(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "sdk").mkdir()
            (root / "sdk/member").write_bytes(b"declared")
            (root / "sdk/internal-alias").symlink_to("member")
            (root / "engine-root-carrier").symlink_to(root / "sdk", target_is_directory=True)
            self.assertEqual(len(BUILDER.input_facts(root, [{"path": "sdk", "kind": "tree"}])), 2)
            self.assertEqual(len(BUILDER.input_facts(root, [{"path": "engine-root-carrier", "kind": "tree"}])), 2)
            (root / "outside").write_bytes(b"undeclared")
            (root / "sdk/host-leaf").symlink_to(root / "outside")
            for presentation in ["sdk", "engine-root-carrier"]:
                with self.subTest(presentation=presentation), self.assertRaisesRegex(ValueError, "escaped its declared root"):
                    BUILDER.input_facts(root, [{"path": presentation, "kind": "tree"}])


if __name__ == "__main__":
    unittest.main()
