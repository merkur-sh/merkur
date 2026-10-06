"""Bounded native Git source-preparation controls; no compiler build."""
import argparse
import ast
import importlib.util
import json
import pathlib
import tempfile


def controls(before, archive, sdk_file, prepared):
    source = pathlib.Path(__file__).with_name("prepare-compiler.py")
    specification = importlib.util.spec_from_file_location("compiler_preparation", source)
    module = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(module)
    pins = source.with_name("compiler-patch.json")
    patch = source.with_name("rustc-1.97.1-deterministic-worker-temporaries.patch")
    old = ast.parse(before.read_text())
    old_calls = [node for node in ast.walk(old) if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and isinstance(node.func.value, ast.Name) and node.func.value.id == "subprocess" and node.func.attr == "run"]
    assert len(old_calls) == 2
    assert all(node.args[0].elts[0].value == "/usr/bin/git" for node in old_calls)
    sdk = json.loads(sdk_file.read_text())
    failures = []
    with tempfile.TemporaryDirectory(prefix="compiler-preparation-controls-") as scratch:
        scratch = pathlib.Path(scratch)
        corrupt = scratch / "corrupt.tar.xz"
        corrupt.write_bytes(b"not the original published compiler archive")
        corrupt_patch = scratch / patch.name
        corrupt_patch.write_bytes(patch.read_bytes() + b"\ncorrupt\n")
        configurations = [
            ("corrupt-archive", corrupt, patch, sdk),
            ("corrupt-patch", archive, corrupt_patch, sdk),
            ("missing-sdk", archive, patch, {}),
            ("missing-git-member", archive, patch, {**sdk, "sdk_files": [file for file in sdk["sdk_files"] if file != sdk["git"]]}),
            ("duplicate-sdk-file", archive, patch, {**sdk, "sdk_files": sdk["sdk_files"] + [sdk["sdk_files"][0]]}),
            ("system-git", archive, patch, {**sdk, "git": "/usr/bin/git"}),
            ("missing-template", archive, patch, {**sdk, "sdk_files": [file for file in sdk["sdk_files"] if not file.endswith("share/git-core/templates/description")]}),
        ]
        original_run = module.subprocess.run
        for name, selected_archive, selected_patch, configuration in configurations:
            destination = scratch / name
            invoked = []
            module.subprocess.run = lambda *args, **kwargs: invoked.append((args, kwargs))
            try:
                module.prepare(selected_archive, destination, pins, selected_patch, configuration)
                raise AssertionError(name + " unexpectedly accepted")
            except ValueError:
                assert not destination.exists() and not invoked, name
                failures.append(name)
            finally:
                module.subprocess.run = original_run
    actual = module.prepare(archive, prepared, pins, patch, sdk)
    expected = json.loads(pins.read_text())
    for row in expected["files"]:
        assert module.digest(prepared / row["path"]) == row["patched_sha256"]
    assert actual["qualified"] is False and actual["compiler_built"] is False
    assert actual["git_environment"]["PATH"] == ""
    return {"original_system_git_selections": 2, "negative_controls": failures, "pristine_prepared": True, "patched_source_hashes_match": True, "compiler_built": False, "qualified": False, "git_sdk_files": len(actual["git_sdk"])}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--before", type=pathlib.Path, required=True)
    parser.add_argument("--archive", type=pathlib.Path, required=True)
    parser.add_argument("--git-sdk", type=pathlib.Path, required=True)
    parser.add_argument("--prepared", type=pathlib.Path, required=True)
    parser.add_argument("--result", type=pathlib.Path, required=True)
    args = parser.parse_args()
    result = controls(args.before, args.archive, args.git_sdk, args.prepared)
    args.result.write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result))
