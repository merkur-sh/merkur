"""Controls for the original source-owned Bun graph generator."""
import ast
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[3]
HERE = Path(__file__).resolve().parent
specification = importlib.util.spec_from_file_location("bun_graph", HERE / "generate_graph.py")
generator = importlib.util.module_from_spec(specification)
with patch("subprocess.check_output", return_value=b""):
    specification.loader.exec_module(generator)


def literal_tests(source):
    result = {}
    for statement in ast.walk(ast.parse(source)):
        if not isinstance(statement, ast.Call) or not isinstance(statement.func, ast.Name):
            continue
        if statement.func.id != "bun_test":
            continue
        attributes = {item.arg: item.value for item in statement.keywords}
        name = ast.literal_eval(attributes["name"])
        for file in ast.literal_eval(attributes["test_files"]):
            file = file.removeprefix("./")
            if file in result:
                raise ValueError("Duplicate source owner: " + file)
            result[file] = name
    return result


class SourceGraphControls(unittest.TestCase):
    def test_explicit_sdk_test_keeps_its_original_single_owner(self):
        template = (HERE / "scripts.BUILD.template").read_text()
        owners = generator.registered_tests(template)
        self.assertEqual(owners, {"scripts/ci/provision-ledger.test.ts": "provision_ledger_test"})
        self.assertEqual(generator.test_declarations("scripts", ["ci/provision-ledger.test.ts"], owners), [])
        source = (ROOT / "scripts/BUILD.bazel").read_text()
        self.assertEqual(literal_tests(source)["scripts/ci/provision-ledger.test.ts"], "provision_ledger_test")
        self.assertIn('"//tools/bazel/tools:git": "git"', source)
        self.assertIn('"//tools/bazel/tools/native:sh": "sh"', source)

    def test_added_source_tests_have_real_generated_targets_and_closures(self):
        for area, file in [
            ("apps/daemon", "src/cli/help.test.ts"),
            ("apps/server", "src/services/account-deletion-sweep.test.ts"),
            ("apps/web", "src/event-stream-worker-protocol.test.ts"),
            ("apps/web", "src/telemetry-worker-protocol.test.ts"),
            ("apps/web", "src/lib/worker-message-guard.test.ts"),
        ]:
            source = "\n".join(generator.test_declarations(area, [file]))
            self.assertEqual(literal_tests(source), {area + "/" + file: "test__" + file.replace("/", "__")})
            self.assertIn(area + "/" + file, generator.IMPORTS["tests"][area + "/" + file]["files"])
        fixture = "apps/daemon/src/cli/shell-integration-tmux.fixture.py"
        self.assertIn(fixture, generator.IMPORTS["tests"]["apps/daemon/src/cli/shell-integration.test.ts"]["files"])

    def test_deleted_sources_cannot_survive_the_import_or_target_catalog(self):
        deleted = [
            "scripts/bench-fec-wasm-decode.test.ts",
            "scripts/bench-transport-mux-routing.test.ts",
            "packages/protocol/src/geometry.test.ts",
            "packages/protocol/src/index.test.ts",
            "packages/protocol/src/input-run-into.test.ts",
            "packages/protocol/src/property-roundtrip.test.ts",
            "packages/protocol/src/validation.test.ts",
            "packages/shared/src/outbound-queue.test.ts",
            "packages/shared/src/transport-mux.test.ts",
        ]
        runtime = json.loads((HERE / "runtime-inputs.json").read_text())
        for file in deleted:
            self.assertNotIn(file, generator.IMPORTS["tests"])
            self.assertNotIn(file, generator.IMPORTS["sourceHashes"])
            self.assertNotIn(file, runtime)

    def test_complete_current_source_inventory_has_one_declared_bun_target_each(self):
        owners = {}
        for area in ("apps", "packages", "scripts", "tests"):
            for file in (ROOT / area).rglob("BUILD.bazel"):
                if "node_modules" in file.parts:
                    continue
                for source, name in literal_tests(file.read_text()).items():
                    self.assertNotIn(source, owners)
                    owners[source] = name
        for area in ("packages/e2e-wasm", "packages/graphics-wasm"):
            for source, name in literal_tests((ROOT / area / "bun_tests.bzl").read_text()).items():
                self.assertNotIn(source, owners)
                owners[source] = name
        self.assertEqual(set(owners), set(generator.IMPORTS["tests"]))
        discovered = set()
        for area in ("apps", "packages", "scripts", "tests"):
            for file in (ROOT / area).rglob("*"):
                if any(part in {"node_modules", "dist", "target", ".git", "test-results"} for part in file.parts):
                    continue
                if file.is_file() and re.search(r"[._](test|spec)\.[cm]?[jt]sx?$", file.name):
                    discovered.add(file.relative_to(ROOT).as_posix())
        self.assertEqual(set(owners), discovered)

    def test_current_bytes_and_template_ownership_are_bound_to_the_original_hash_schema(self):
        self.assertIn("tools/bazel/bun/scripts.BUILD.template", generator.IMPORTS["resolverHashes"])
        for file, expected in (generator.IMPORTS["sourceHashes"] | generator.IMPORTS["resolverHashes"]).items():
            self.assertEqual(hashlib.sha256((ROOT / file).read_bytes()).hexdigest(), expected, file)

    def test_ambiguous_dynamic_or_foreign_explicit_source_owners_are_refused(self):
        rows = [
            'bun_test(name="owner",test_files=files)',
            'bun_test(name="owner",test_files=["scripts/../foreign.test.ts"])',
            'bun_test(name="owner",test_files=["apps/foreign.test.ts"])',
            'bun_test(name="owner",test_files=["scripts/a.test.ts","scripts/b.test.ts"])',
            'bun_test(name="owner",test_files=[1])',
            'bun_test(name="first",test_files=["scripts/a.test.ts"])\nbun_test(name="second",test_files=["./scripts/a.test.ts"])',
        ]
        for source in rows:
            with self.assertRaises(ValueError):
                generator.registered_tests(source)


    def test_exact_original_manual_tail_survives_initial_marker_bootstrap(self):
        source = (HERE / "BUILD.bazel").read_text()
        block = generator.typescript_inventory()
        prefix, section = source.split(generator.TYPE_INVENTORY_START)
        if generator.TYPE_INVENTORY_END in section:
            _, tail = section.split(generator.TYPE_INVENTORY_END)
        else:
            self.assertTrue(section.startswith(block.removeprefix(generator.TYPE_INVENTORY_START)))
            tail = section[len(block.removeprefix(generator.TYPE_INVENTORY_START)):]
        self.assertIn('exports_files(["source-providers.bzl"])', tail)
        self.assertIn('name = "vite_runtime_test_sources"', tail)
        self.assertIn('name = "vite_runtime_test"', tail)
        self.assertEqual(generator.update_typescript_inventory(source, block),
                         prefix + block + generator.TYPE_INVENTORY_END + tail)

    def test_marked_generated_region_preserves_both_manual_sections_and_is_idempotent(self):
        block = generator.typescript_inventory()
        prefix = 'exports_files(["manual-prefix.bzl"])\n'
        tail = '\njs_library(name="manual-tail",srcs=["manual.ts"])\n'
        source = prefix + generator.TYPE_INVENTORY_START + 'obsolete generated content\n' + generator.TYPE_INVENTORY_END + tail
        updated = generator.update_typescript_inventory(source, block)
        self.assertEqual(updated, prefix + block + generator.TYPE_INVENTORY_END + tail)
        self.assertEqual(generator.update_typescript_inventory(updated, block), updated)

    def test_unmarked_generated_bytes_and_ambiguous_boundaries_are_refused(self):
        block = generator.typescript_inventory()
        invalid = [block.replace('bun_command_test', 'foreign_command_test', 1),
                   block + generator.TYPE_INVENTORY_START,
                   block + generator.TYPE_INVENTORY_END * 2,
                   generator.TYPE_INVENTORY_END + block,
                   'no generated inventory']
        for source in invalid:
            with self.subTest(source=source[:80]), self.assertRaises(ValueError):
                generator.update_typescript_inventory(source, block)


if __name__ == "__main__":
    unittest.main()
