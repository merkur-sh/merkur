"""Audit snapshot boundary controls; test reports are explicit protocol fixtures."""

import ast
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch


SPEC = importlib.util.spec_from_file_location("dependency_audit", Path(__file__).with_name("dependency-audit.py"))
AUDIT = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(AUDIT)


class File:
    def __init__(self, name): self.short_path = name; self.is_source = True; self.owner = "//" + "/".join(name.split("/")[:-1]) + ":" + name.split("/")[-1]
class Files:
    def __init__(self, files): self._files = tuple(dict.fromkeys(files))
    def to_list(self): return list(self._files)
class Runfiles:
    def __init__(self, files): self.files = Files(files)
    def merge(self, other): return Runfiles(self.files.to_list() + other.files.to_list())
class Target:
    def __init__(self, file, sdk=False):
        self.providers = {'default': SimpleNamespace(files=Files([file]), default_runfiles=Runfiles([file]))}
        if sdk: self.providers['native'] = SimpleNamespace(prefix_runfile='_main/sdk')
    def __getitem__(self, key): return self.providers[key]
class Actions:
    def __init__(self): self.writes = {}
    def declare_file(self, name): return File(name)
    def write(self, file, data, **kwargs): self.writes[file.short_path] = data

def rule_runtime(source, omitted=None, generated=None, misbound=None, foreign_owner=None):
    tree = ast.parse(source)
    locks = ast.literal_eval(next(node.value for node in tree.body if isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id == "_AUDIT_LOCKS" for target in node.targets)))
    members = ["package.json", "bun.lock"] + locks
    actions = Actions(); files = {name: File(name) for name in ['bun','cargo','sdk','python','runner','request','snapshot','nonce','configured'] + members}
    if generated is not None: files[generated].is_source = False
    if misbound is not None: files[misbound].short_path = "foreign/Cargo.lock"
    if foreign_owner is not None: files[foreign_owner].owner = "@foreign//:Cargo.lock"
    bun, cargo, sdk, python = [Target(files[name], name=='sdk') for name in ['bun','cargo','sdk','python']]
    attributes = SimpleNamespace(inputs={Target(files[name]): name for name in members if name != omitted}, configured_inputs=[Target(files['configured'])], bun=bun, cargo_audit=cargo, sdk=sdk, _python=python, _capture=False)
    ctx = SimpleNamespace(attr=attributes, executable=SimpleNamespace(bun=files['bun'],cargo_audit=files['cargo'],_python=files['python']),file=SimpleNamespace(_runner=files['runner'],request=files['request'],snapshot=files['snapshot']),label=SimpleNamespace(name='audit'),actions=actions)
    ctx.runfiles = lambda files=[],transitive_files=Files([]):Runfiles(files+transitive_files.to_list())
    environment={'Label':lambda value:value,'DefaultInfo':'default','NativeSdkInfo':'native','TestRuntimeInfo':lambda **fields:SimpleNamespace(**fields),'test_nonce_file':lambda ctx:files['nonce'],'depset':lambda values=[],transitive=[]:Files(values+[file for item in transitive for file in item.to_list()]),'json':SimpleNamespace(encode=json.dumps),'fail':lambda message:(_ for _ in ()).throw(ValueError(message))}
    environment['_AUDIT_LOCKS'] = locks
    for node in tree.body:
        if isinstance(node,ast.FunctionDef) and node.name in ['_runfile','_impl']:exec(compile(ast.Module(body=[node],type_ignores=[]),'actual-rule','exec'),environment)
    environment['DefaultInfo']=lambda **fields:SimpleNamespace(**fields)
    # The same callable is the provider lookup key in genuine Starlark.
    default=environment['DefaultInfo']
    for target in [*attributes.inputs, *attributes.configured_inputs,bun,cargo,sdk,python]:target.providers[default]=target.providers.pop('default')
    result=environment['_impl'](ctx)
    runtime={file.short_path for file in result[1].runfiles.files.to_list()}
    direct={file.short_path for file in result[0].runfiles.files.to_list()}
    return {'runtime':sorted(runtime),'direct':sorted(direct),'ordinary_pair_in_runtime':{'request','snapshot'}<=runtime,'nonce_in_runtime':'nonce' in runtime,'writes':actions.writes}


class AuditControls(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="audit-boundary-")
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        for name in ["package.json", "bun.lock", "Cargo.lock", "bun", "cargo-audit", "sdk/ssl/cacert.pem", "configured.json"]:
            file = self.root / name
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_text("declared protocol fixture: " + name)
        self.specification = {
            "inputs": {name: name for name in ["package.json", "bun.lock", "Cargo.lock"]},
            "tools": {"bun": "bun", "cargo_audit": "cargo-audit"},
            "runtime": ["bun", "cargo-audit", "sdk", "configured.json"],
            "sdk": "sdk",
        }
        self.request = b"controller-owned fresh request fixture"
        self.snapshot = {
            "request": AUDIT.digest(self.request),
            "facts": AUDIT.configuration(self.specification, self.root)[1],
            "versions": AUDIT.VERSIONS,
            "audits": [
                {"engine": "bun", "command": AUDIT.COMMANDS["bun"], "exit": 0, "stdout": "{}", "stderr": ""},
                {"engine": "cargo_audit", "command": AUDIT.COMMANDS["cargo_audit"], "exit": 0,
                 "stdout": "", "stderr": "explicit protocol fixture: original terminal audit result"},
            ],
        }

    def validate(self):
        return AUDIT.validate(self.snapshot, self.specification, self.root, self.request)

    def test_complete_declared_snapshot_and_native_failure_propagation(self):
        self.assertEqual(self.validate(), 0)
        self.snapshot["audits"][1]["exit"] = 2
        self.assertEqual(self.validate(), 2)
        self.snapshot["audits"][1]["exit"] = -9
        self.assertEqual(self.validate(), 1)
        self.snapshot["audits"][1]["exit"] = 256
        with self.assertRaisesRegex(ValueError, "exit status"):
            self.validate()

    def test_bun_failure_retains_original_short_circuit(self):
        self.snapshot["audits"][0]["exit"] = 1
        with self.assertRaisesRegex(ValueError, "short-circuit"):
            self.validate()
        self.snapshot["audits"].pop()
        self.assertEqual(self.validate(), 1)

    def test_missing_cargo_success_cannot_pass(self):
        self.snapshot["audits"].pop()
        with self.assertRaisesRegex(ValueError, "coverage"):
            self.validate()

    def test_old_snapshot_and_changed_lock_are_refused(self):
        with self.assertRaisesRegex(ValueError, "another fresh"):
            AUDIT.validate(self.snapshot, self.specification, self.root, b"new controller request")
        (self.root / "Cargo.lock").write_text("changed lock")
        with self.assertRaisesRegex(ValueError, "configured source"):
            self.validate()

    def test_runtime_tree_membership_and_configured_graph_are_bound(self):
        (self.root / "sdk/added-member").write_text("new original runtime input")
        with self.assertRaisesRegex(ValueError, "native engine Files"):
            self.validate()
        (self.root / "sdk/added-member").unlink()
        (self.root / "configured.json").write_text("changed dependency closure")
        with self.assertRaisesRegex(ValueError, "configured source"):
            self.validate()

    def test_cargo_json_cannot_hide_original_yanked_acquisition_errors(self):
        self.snapshot["audits"][1]["command"] = ["audit", "--deny", "yanked", "--json"]
        with self.assertRaisesRegex(ValueError, "policy exemption"):
            self.validate()

    def test_incomplete_yanked_acquisition_and_malformed_report_are_refused(self):
        cargo = self.snapshot["audits"][1]
        for error in AUDIT.YANKED_ERRORS:
            cargo["stderr"] = "error: " + error + " exact fixture failure"
            with self.assertRaisesRegex(ValueError, "yanked registry acquisition"):
                self.validate()
        cargo["stderr"] = ""
        self.snapshot["audits"][0]["stdout"] = "[]"
        with self.assertRaisesRegex(ValueError, "original JSON report"):
            self.validate()

    def test_advisory_exemptions_and_missing_engine_closure_are_refused(self):
        self.snapshot["audits"][1]["command"] = ["audit", "--no-yanked", "--ignore", "fixture"]
        with self.assertRaisesRegex(ValueError, "policy exemption"):
            self.validate()
        self.specification["runtime"].remove("cargo-audit")
        with self.assertRaisesRegex(ValueError, "runtime Files"):
            self.validate()

    def test_source_configuration_cannot_hide_fresh_acquisition_failure(self):
        self.specification["inputs"][".cargo/audit.toml"] = "audit.toml"
        for body in ["[output]\nquiet=true", "[yanked]\nenabled=false", "[database]\nfetch=false",
                     "[database]\npath='/outside/private-workspace'", "[yanked]\nupdate_index=false"]:
            (self.root / "audit.toml").write_text(body)
            with self.assertRaisesRegex(ValueError, "suppresses fresh"):
                AUDIT.configuration(self.specification, self.root)

    def test_additional_configured_cargo_locks_require_their_original_native_audits(self):
        self.specification["inputs"]["tools/bolero/Cargo.lock"] = "diagnostic.lock"
        (self.root / "diagnostic.lock").write_text("explicit diagnostic context lock fixture")
        self.snapshot["facts"] = AUDIT.configuration(self.specification, self.root)[1]
        with self.assertRaisesRegex(ValueError, "complete declared Cargo lock coverage"):
            self.validate()
        cargo = dict(self.snapshot["audits"][1])
        cargo["command"] = AUDIT.COMMANDS["cargo_audit"][:-1] + ["tools/bolero/Cargo.lock"]
        self.snapshot["audits"].append(cargo)
        self.assertEqual(self.validate(), 0)
        self.assertEqual(AUDIT.audit_commands(self.specification)[2], ("cargo_audit", cargo["command"]))


    def test_unbound_default_repository_pair_never_admits_an_audit(self):
        context = Path(__file__).with_name("audit-context")
        self.request = (context / "request").read_bytes()
        self.snapshot = json.loads((context / "snapshot").read_text())
        with self.assertRaisesRegex(ValueError, "Incomplete original audit snapshot"):
            self.validate()


    def test_consumer_runtime_keeps_ordinary_pair_without_its_own_nonce(self):
        source = Path(__file__).with_name("dependency-audit.bzl").read_text()
        result = rule_runtime(source)
        self.assertTrue(result["ordinary_pair_in_runtime"])
        self.assertFalse(result["nonce_in_runtime"])
        self.assertIn("nonce", result["direct"])
        self.assertTrue({"configured", "sdk", "bun", "cargo"} <= set(result["runtime"]))


    def test_rule_requires_every_authoritative_lock_before_creating_actions(self):
        source = Path(__file__).with_name("dependency-audit.bzl").read_text()
        tree = ast.parse(source)
        locks = ast.literal_eval(next(node.value for node in tree.body if isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id == "_AUDIT_LOCKS" for target in node.targets)))
        authority = ast.parse((Path(__file__).parent.parent / "rust/protocol_wasm_generate.py").read_text())
        original = ast.literal_eval(next(node.value for node in authority.body if isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id == "LOCKS" for target in node.targets)))
        self.assertEqual(locks, original)
        for lock in locks:
            with self.subTest(lock=lock), self.assertRaisesRegex(ValueError, "Audit requires original source member: " + lock):
                with patch.object(Actions, "write", side_effect=AssertionError("incomplete locks created an action")):
                    rule_runtime(source, omitted=lock)
            with self.subTest(generated=lock), self.assertRaisesRegex(ValueError, "Audit locks require exact original SourceFiles: " + lock):
                with patch.object(Actions, "write", side_effect=AssertionError("generated lock created an action")):
                    rule_runtime(source, generated=lock)
            for role in ["misbound", "foreign_owner"]:
                with self.subTest(lock=lock, role=role), self.assertRaisesRegex(ValueError, "Audit locks require exact original SourceFiles: " + lock):
                    with patch.object(Actions, "write", side_effect=AssertionError("foreign lock created an action")):
                        rule_runtime(source, **{role: lock})

    def test_factory_registers_source_git_without_changing_original_audit_inputs(self):
        calls = []
        environment = {name: (lambda callee=name, **fields: calls.append((callee, fields)))
                       for name in ['declared_git_sdk', 'dependency_audit_capture', 'dependency_audit_test']}
        source = Path(__file__).with_name("dependency-audit-targets.bzl").read_text()
        function = next(node for node in ast.parse(source).body
                        if isinstance(node, ast.FunctionDef) and node.name == 'declared_dependency_audit')
        exec(compile(ast.Module(body=[function], type_ignores=[]), 'actual-audit-factory', 'exec'), environment)
        locks = ['Cargo.lock', 'tools/bolero/Cargo.lock', 'tools/ownership-proofs/Cargo.lock', 'tools/edge-kernel-profile/Cargo.lock', 'tools/sim/Cargo.lock']
        inputs = {name: name for name in ['package.json', 'bun.lock', '.cargo/config.toml'] + locks}
        configured = ['original-application-closure', 'original-bun-runtime-closure']
        arguments = dict(name='audit', inputs=inputs, configured_inputs=configured, bun='original-bun',
                         git_source='original-git-release', git_bootstrap_sdk='original-utility-sdk',
                         git_make='original-make', git_ranlib='original-cc-ranlib')
        for role in ['git_source', 'git_bootstrap_sdk', 'git_make', 'git_ranlib']:
            incomplete = dict(arguments)
            del incomplete[role]
            with self.assertRaisesRegex(TypeError, role):
                environment['declared_dependency_audit'](**incomplete)
            self.assertEqual(calls, [])
        environment['declared_dependency_audit'](**arguments)
        self.assertEqual([name for name, _ in calls],
                         ['declared_git_sdk', 'dependency_audit_capture', 'dependency_audit_test'])
        self.assertEqual(calls[0][1], dict(name='audit_git_sdk', source='original-git-release',
                                         sdk='original-utility-sdk', make='original-make',
                                         ranlib='original-cc-ranlib', tags=[]))
        for _, fields in calls[1:]:
            self.assertIs(fields['inputs'], inputs)
            self.assertIs(fields['configured_inputs'], configured)
            self.assertEqual(fields['sdk'], ':audit_git_sdk')
            self.assertEqual(fields['cargo_audit'], '//tools/bazel/rust/audit_tool:cargo_audit')
        self.assertEqual(calls[2][1]['request'], '@verification_audit//:request')
        self.assertEqual(calls[2][1]['snapshot'], '@verification_audit//:snapshot')


if __name__ == "__main__":
    unittest.main()
