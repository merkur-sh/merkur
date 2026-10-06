"""Pinned original bootstrap archive controls; no compiler build or linking."""

import argparse
import importlib.util
import hashlib
import io
import json
import pathlib
import sys
import tarfile
import tempfile
import unittest


def implementation():
    script = pathlib.Path(__file__).with_name("bootstrap-inputs.py")
    specification = importlib.util.spec_from_file_location("bootstrap_inputs", script)
    module = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(module)
    return module


class BootstrapInputControls(unittest.TestCase):
    """Small structural fixtures, explicitly not native SDK qualification."""

    def setUp(self):
        self.private = tempfile.TemporaryDirectory(prefix="bootstrap-input-control-")
        self.addCleanup(self.private.cleanup)
        self.root = pathlib.Path(self.private.name)
        self.module = implementation()
        self.role = {"prefix": "fixture-distribution", "component": "fixture"}

    def archive(self, entries):
        data = io.BytesIO()
        with tarfile.open(fileobj=data, mode="w:xz") as archive:
            for name, kind in entries:
                member = tarfile.TarInfo(name)
                if kind == "regular":
                    member.size = 5
                    archive.addfile(member, io.BytesIO(b"input"))
                else:
                    member.type = kind
                    member.linkname = "fixture-distribution/fixture/input"
                    archive.addfile(member)
        data.seek(0)
        return data

    def test_captured_bytes_remain_the_validated_bytes(self):
        path = self.root / "original"
        path.write_bytes(b"captured original")
        with self.module.captured_archive(path, hashlib.sha256(path.read_bytes()).hexdigest(), self.root) as captured:
            path.write_bytes(b"changed original")
            self.assertEqual(captured.read(), b"captured original")

    def test_wrong_archive_pin_refuses(self):
        path = self.root / "original"
        path.write_bytes(b"unmatched original")
        with self.assertRaises(ValueError):
            self.module.captured_archive(path, "0" * 64, self.root)

    def test_valid_regular_component_extracts(self):
        component = self.module.extract(self.archive([("fixture-distribution/fixture/input", "regular")]), self.role, self.root / "extracted")
        self.assertEqual((component / "input").read_bytes(), b"input")

    def test_unsafe_members_refuse_before_extraction(self):
        cases = [
            [("/outside", "regular")],
            [("fixture-distribution/../outside", "regular")],
            [("wrong-prefix/fixture/input", "regular")],
            [("fixture-distribution/fixture/input", "regular")] * 2,
            [("fixture-distribution/fixture/input", "regular"), ("fixture-distribution/fixture/./input", "regular")],
            [("fixture-distribution/fixture/alias", tarfile.SYMTYPE)],
            [("fixture-distribution/fixture/alias", tarfile.LNKTYPE)],
            [("fixture-distribution/fixture/device", tarfile.CHRTYPE)],
        ]
        for entries in cases:
            with self.subTest(entries=entries):
                output = self.root / "extracted"
                with self.assertRaises(ValueError):
                    self.module.extract(self.archive(entries), self.role, output)
                self.assertFalse(output.exists())

    def test_component_overlap_refuses(self):
        component = self.root / "component"
        sdk = self.root / "sdk"
        (component / "lib").mkdir(parents=True)
        (sdk / "lib").mkdir(parents=True)
        (component / "lib/member").write_bytes(b"new")
        (sdk / "lib/member").write_bytes(b"retained")
        with self.assertRaises(ValueError):
            self.module.copy_component(component, sdk)
        self.assertEqual((sdk / "lib/member").read_bytes(), b"retained")

    def test_stage0_host_refuses_before_source_access(self):
        pin = self.root / "bootstrap-pins.json"
        original = pathlib.Path(__file__).with_name("bootstrap-pins.json")
        values = json.loads(original.read_text())
        pin.write_text(json.dumps({**values, "host": "x86_64-apple-darwin"}))
        compiler = pathlib.Path(__file__).with_name("compiler-patch.json")
        with self.assertRaisesRegex(ValueError, "exact native stage0 host"):
            self.module.check_sources({"sources": str(self.root / "absent-source"), "compiler_pins": str(compiler), "bootstrap_pins": str(pin)})


def controls(request, output):
    module = implementation()
    rejected = []
    with tempfile.TemporaryDirectory(prefix="bootstrap-inputs-controls-") as private:
        private = pathlib.Path(private)
        malformed = private / "corrupt.tar.xz"
        malformed.write_bytes(b"not an original compiler distribution")
        cases = []
        for role in ["rustc", "cargo", "rust-std", "llvm"]:
            cases.append(("corrupt-" + role, {**request, "archives": {**request["archives"], role: str(malformed)}}))
            cases.append(("missing-" + role, {**request, "archives": {name: value for name, value in request["archives"].items() if name != role}}))
        cases.append(("missing-python-sdk", {**request, "sdk_files": [name for name in request["sdk_files"] if name != request["python"]]}))
        cases.append(("missing-git-sdk", {**request, "sdk_files": [name for name in request["sdk_files"] if name != request["git"]]}))
        cases.append(("duplicate-sdk-file", {**request, "sdk_files": request["sdk_files"] + [request["sdk_files"][0]]}))
        bad_pin = private / "bootstrap-pins.json"
        pin = json.loads(pathlib.Path(request["bootstrap_pins"]).read_text())
        bad_pin.write_text(json.dumps({**pin, "host": "x86_64-apple-darwin"}))
        cases.append(("wrong-stage0-host", {**request, "bootstrap_pins": str(bad_pin)}))
        bad_source_pin = private / "source-pins.json"
        bad_source_pin.write_text(json.dumps({**pin, "source_guards": {**pin["source_guards"], "src/tools/rustdoc/Cargo.toml": "0" * 64}}))
        cases.append(("changed-rustdoc-source", {**request, "bootstrap_pins": str(bad_source_pin)}))
        for name, selected in cases:
            root = private / name
            try:
                module.materialize(selected, root / "configuration.json", root / "stage0", root / "llvm")
                raise AssertionError(name + " unexpectedly accepted")
            except ValueError:
                assert not root.exists(), name + " wrote outputs before admission"
                rejected.append(name)
    result = module.materialize(request, output / "configuration.json", output / "stage0", output / "llvm")
    assert result["bootstrap"]["selectors"] == ["compiler/rustc", "library", "src/tools/rustdoc"]
    assert result["bootstrap"]["build"]["vendor"] and result["bootstrap"]["build"]["locked-deps"]
    assert result["bootstrap"]["environment"] == {"PATH": "", "CARGO_NET_OFFLINE": "true"}
    assert result["stage0"]["rustdoc"].endswith("/sdk/bin/rustdoc")
    assert result["native_execution"]["available"] is False
    assert result["compiler_built"] is False and result["rustdoc_built"] is False and result["qualified"] is False
    return {"original_archive_materialization": True, "negative_controls": rejected, "refused_before_outputs": True, "matching_rustdoc_mandatory": True, "native_execution_blocked": True, "sdk_files": len(result["sdk_files"]), "compiler_built": False, "qualified": False}


if __name__ == "__main__" and "--request" in sys.argv:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--request", type=pathlib.Path, required=True)
    parser.add_argument("--output", type=pathlib.Path, required=True)
    parser.add_argument("--result", type=pathlib.Path, required=True)
    args = parser.parse_args()
    result = controls(json.loads(args.request.read_text()), args.output)
    args.result.write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result))
elif __name__ == "__main__":
    unittest.main()
