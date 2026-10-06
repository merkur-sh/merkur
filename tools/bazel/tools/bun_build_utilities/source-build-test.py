"""Original source/member and declared build File boundary controls."""

import hashlib
import importlib.util
import io
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("utility_source_build", Path(__file__).with_name("source-build.py"))
producer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(producer)
shell_spec = importlib.util.spec_from_file_location("bash_source_build", Path(__file__).with_name("bash-source-build.py"))
shell_producer = importlib.util.module_from_spec(shell_spec)
shell_spec.loader.exec_module(shell_producer)


class SourceBuildControls(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)

    def archive(self, names):
        archive = self.root / "original.tar"
        with tarfile.open(archive, "w") as output:
            for name in names:
                member = tarfile.TarInfo(name)
                member.size = len(b"original member bytes")
                member.mode = 0o755
                output.addfile(member, io.BytesIO(b"original member bytes"))
        return archive, {"sha256": hashlib.sha256(archive.read_bytes()).hexdigest(), "strip_prefix": "original"}

    def test_original_source_member_bytes_and_mode(self):
        archive, pin = self.archive(["original/Configure"])
        producer.extract_source(archive, pin, self.root / "source")
        member = self.root / "source/Configure"
        self.assertEqual(member.read_bytes(), b"original member bytes")
        self.assertEqual(member.stat().st_mode & 0o777, 0o755)

    def test_original_source_timestamps_preserve_generated_configure_order(self):
        archive, pin = self.archive(["original/configure", "original/configure.ac"])
        producer.extract_source(archive, pin, self.root / "source")
        self.assertEqual((self.root / "source/configure").stat().st_mtime_ns, 0)
        self.assertEqual((self.root / "source/configure.ac").stat().st_mtime_ns, 0)

    def test_replacement_after_validated_read_uses_exact_pinned_bytes(self):
        archive, pin = self.archive(["original/Configure"])
        replacement = io.BytesIO()
        with tarfile.open(fileobj=replacement, mode="w") as output:
            member = tarfile.TarInfo("original/Configure")
            member.size = len(b"unvalidated replacement")
            output.addfile(member, io.BytesIO(b"unvalidated replacement"))
        changed = replacement.getvalue()
        read_bytes = Path.read_bytes
        mutations = []

        def captured_read(path):
            data = read_bytes(path)
            if path == archive:
                archive.write_bytes(changed)
                mutations.append(True)
            return data

        with patch.object(Path, "read_bytes", captured_read):
            producer.extract_source(archive, pin, self.root / "source")
        self.assertEqual(mutations, [True])
        self.assertEqual(archive.read_bytes(), changed)
        self.assertEqual((self.root / "source/Configure").read_bytes(), b"original member bytes")

    def test_foreign_original_archive_rejected_before_output(self):
        archive, pin = self.archive(["original/Configure"])
        pin["sha256"] = "0" * 64
        with self.assertRaisesRegex(ValueError, "declared pin"):
            producer.extract_source(archive, pin, self.root / "source")
        self.assertFalse((self.root / "source").exists())

    def test_duplicate_canonical_members_reject(self):
        archive, pin = self.archive(["original/Configure", "original/./Configure"])
        with self.assertRaisesRegex(ValueError, "duplicate canonical"):
            producer.extract_source(archive, pin, self.root / "source")
        self.assertFalse((self.root / "source").exists())

    def test_foreign_root_and_escape_reject(self):
        for name in ["other/Configure", "original/../outside", "/original/Configure"]:
            archive, pin = self.archive([name])
            with self.assertRaises(ValueError):
                producer.extract_source(archive, pin, self.root / "source")
            self.assertFalse((self.root / "source").exists())

    def test_source_alias_rejected_before_output(self):
        archive = self.root / "original.tar"
        with tarfile.open(archive, "w") as output:
            member = tarfile.TarInfo("original/alias")
            member.type = tarfile.SYMTYPE
            member.linkname = "../../outside"
            output.addfile(member)
        pin = {"sha256": hashlib.sha256(archive.read_bytes()).hexdigest(), "strip_prefix": "original"}
        with self.assertRaisesRegex(ValueError, "nonordinary"):
            producer.extract_source(archive, pin, self.root / "source")
        self.assertFalse((self.root / "source").exists())

    def test_tool_custody_rejects_foreign_file_before_executing(self):
        with self.assertRaisesRegex(ValueError, "original File"):
            producer.declared_tool("undeclared-compiler", ["actual-compiler"], self.root)

    def test_missing_declared_tool_rejects(self):
        with self.assertRaisesRegex(ValueError, "missing"):
            producer.declared_tool("actual-compiler", ["actual-compiler"], self.root)

    def test_nonexecutable_declared_member_rejects(self):
        member = self.root / "actual-compiler"
        member.write_bytes(b"ordinary source, not an executable")
        with self.assertRaisesRegex(ValueError, "not executable"):
            producer.declared_tool("actual-compiler", ["actual-compiler"], self.root)

    def test_precreated_tree_identity_and_replaced_alias(self):
        output = self.root / "output"
        output.mkdir()
        identity = producer.output_identity(output)
        self.assertEqual(identity, (output.stat().st_dev, output.stat().st_ino))
        output.rmdir()
        outside = self.root / "outside"
        outside.mkdir()
        output.symlink_to(outside, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, "ordinary empty"):
            producer.output_identity(output)
        self.assertEqual(list(outside.iterdir()), [])

    def test_incumbent_output_preserved(self):
        output = self.root / "output"
        output.mkdir()
        member = output / "incumbent"
        member.write_bytes(b"preserve")
        with self.assertRaises(ValueError):
            producer.output_identity(output)
        self.assertEqual(member.read_bytes(), b"preserve")

    def test_shell_runtime_requires_owned_terminfo_before_shebang_execution(self):
        runtime = self.root / "runtime"
        (runtime / "bin").mkdir(parents=True)
        (runtime / "bin/bash").write_bytes(b"not invoked without declared terminal data")
        with patch.object(shell_producer.subprocess, "run") as executed:
            with self.assertRaisesRegex(ValueError, "runtime resources"):
                shell_producer.check_runtime(runtime, self.root)
            executed.assert_not_called()

    def test_source_shell_libraries_reject_alias_and_foreign_bytes(self):
        foreign = self.root / "foreign.a"
        foreign.write_bytes(b"a shared library cannot replace an original static archive")
        with self.assertRaisesRegex(ValueError, "static archive"):
            shell_producer.ordinary_archive(foreign)
        original = self.root / "original.a"
        original.write_bytes(b"!<arch>\noriginal object member")
        alias = self.root / "alias.a"
        alias.symlink_to(original)
        with self.assertRaisesRegex(ValueError, "ordinary"):
            shell_producer.ordinary_archive(alias)

    def test_source_shell_installation_rejects_undeclared_tool_before_compilation(self):
        pins = self.root / "pins.json"
        pins.write_text("{}")
        with patch.object(shell_producer.subprocess, "run") as executed:
            with self.assertRaisesRegex(ValueError, "declared SDK install File"):
                shell_producer.build(
                    {"pins": "pins.json", "sdk": "sdk", "shell_files": []},
                    self.root, self.root, self.root, {}, None, None, None, None,
                )
            executed.assert_not_called()

    def test_original_bash_configure_must_select_external_source_readline(self):
        makefile = self.root / "Makefile"
        static = self.root / "static"
        makefile.write_text("RL_LIBDIR = " + str(static / "lib") + "\nHIST_LIBDIR = " + str(static / "lib") + "\n")
        shell_producer.configured_readline(makefile, static)
        for foreign in ["$(dot)/$(LIBSUBDIR)/readline", "/foreign/lib"]:
            makefile.write_text("RL_LIBDIR = " + foreign + "\nHIST_LIBDIR = " + str(static / "lib") + "\n")
            with self.assertRaisesRegex(ValueError, "source-built external readline"):
                shell_producer.configured_readline(makefile, static)


if __name__ == "__main__":
    unittest.main()
