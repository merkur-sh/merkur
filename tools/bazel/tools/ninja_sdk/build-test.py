"""Affected controls for exact Ninja source, tool and output boundaries."""

import importlib.util
import json
from pathlib import Path
import tempfile
import unittest


module_spec = importlib.util.spec_from_file_location("ninja_builder", Path(__file__).with_name("build.py"))
builder = importlib.util.module_from_spec(module_spec)
module_spec.loader.exec_module(builder)


class Controls(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.specification = {"inputs": [], "source": []}
        for name in ["cxx", "ar", "python", "shell"]:
            file = self.root / ("sdk/bin/bash" if name == "shell" else name)
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_bytes(b"not executed: structural negative control\n")
            file.chmod(0o755)
            relative = str(file.relative_to(self.root))
            self.specification[name] = relative
            self.specification["inputs"].append(relative)

    def test_original_shell_file_is_selected(self):
        self.assertEqual(builder.tool_paths(self.specification, self.root)["shell"], str(self.root / "sdk/bin/bash"))

    def test_missing_shell_does_not_select_ambient_shell(self):
        del self.specification["shell"]
        with self.assertRaises(KeyError):
            builder.tool_paths(self.specification, self.root)

    def test_foreign_shell_is_not_an_action_file(self):
        self.specification["shell"] = "/bin/sh"
        with self.assertRaisesRegex(ValueError, "declared executable File closure"):
            builder.tool_paths(self.specification, self.root)

    def test_shell_must_be_original_bash_sdk_member(self):
        self.specification["shell"] = self.specification["python"]
        with self.assertRaisesRegex(ValueError, "declared Bash SDK File"):
            builder.tool_paths(self.specification, self.root)

    def test_nonexecutable_declared_shell_is_rejected(self):
        (self.root / self.specification["shell"]).chmod(0o644)
        with self.assertRaisesRegex(ValueError, "declared executable File closure"):
            builder.tool_paths(self.specification, self.root)

    def test_source_traversal_is_rejected(self):
        self.specification["source"] = [{"path": "cxx", "relative": "../foreign"}]
        with self.assertRaisesRegex(ValueError, "original repository"):
            builder.source_files(self.specification, self.root, self.root / "destination")
        self.assertFalse((self.root / "foreign").exists())

    def test_duplicate_source_is_rejected(self):
        self.specification["source"] = [{"path": "cxx", "relative": "src/tool.cc"}] * 2
        with self.assertRaisesRegex(ValueError, "original repository"):
            builder.source_files(self.specification, self.root, self.root / "destination")

    def test_changed_original_license_is_rejected(self):
        self.specification["source"] = [{"path": "cxx", "relative": "COPYING"}]
        pins = self.root / "pins.json"
        pins.write_text(json.dumps({"license": {"path": "COPYING", "sha256": "0" * 64}}))
        self.specification["pins"] = "pins.json"
        with self.assertRaisesRegex(ValueError, "original source license"):
            builder.source_files(self.specification, self.root, self.root / "destination")


if __name__ == "__main__":
    unittest.main()
