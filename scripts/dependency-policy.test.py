"""Exercise the real policy tools against isolated Cargo metadata fixtures.

No fixture builds or dependency code execute. Registry inputs use the Cargo cache;
the git refusal control clones a local repository, without contacting a service.
"""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]


class DependencyPolicyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.cargo = os.environ.get("CARGO") or shutil.which("cargo")
        cls.deny = os.environ.get("CARGO_DENY") or shutil.which("cargo-deny")
        cls.vet = os.environ.get("CARGO_VET") or shutil.which("cargo-vet")
        if not cls.cargo or not cls.deny or not cls.vet:
            raise RuntimeError("Install the pinned tools with bun run setup:dependency-policy")
        cls.env = dict(os.environ, CARGO=cls.cargo, CARGO_NET_OFFLINE="true")
        cls.env.pop("RUSTUP_TOOLCHAIN", None)

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="merkur-policy-control-")
        self.addCleanup(self.temporary.cleanup)
        self.project = Path(self.temporary.name)
        (self.project / "src").mkdir()
        (self.project / "src/lib.rs").write_text("", encoding="utf-8")

    def run_tool(self, command, cwd=None):
        return subprocess.run(
            command, cwd=cwd or self.project, env=self.env,
            text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=60,
        )

    def manifest(self, dependencies):
        (self.project / "Cargo.toml").write_text(
            '[package]\nname = "merkur-policy-control"\nversion = "0.1.0"\n'
            'edition = "2024"\nlicense = "AGPL-3.0-only"\npublish = false\n'
            '[workspace]\n[dependencies]\n' + dependencies,
            encoding="utf-8",
        )

    def local_dependency(self, name="control-dep", license="MIT"):
        path = self.project / "dependency"
        (path / "src").mkdir(parents=True)
        (path / "src/lib.rs").write_text("", encoding="utf-8")
        (path / "Cargo.toml").write_text(
            '[package]\nname = "' + name + '"\nversion = "0.1.0"\n'
            'edition = "2024"\nlicense = "' + license + '"\npublish = false\n',
            encoding="utf-8",
        )
        return path

    def deny_check(self, *checks):
        return self.run_tool([
            self.deny, "deny", "--offline", "--config", str(ROOT / "deny.toml"), "check",
            *checks,
        ])

    def assert_pass(self, result):
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def assert_refused(self, result, diagnostic):
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn(diagnostic, result.stdout + result.stderr)

    def test_current_license_source_and_backend_policy_passes(self):
        self.local_dependency()
        self.manifest('control-dep = { path = "dependency" }\n')
        self.assert_pass(self.deny_check("bans", "licenses", "sources"))

    def test_unapproved_license_is_refused(self):
        self.local_dependency(license="GPL-3.0-only")
        self.manifest('control-dep = { path = "dependency" }\n')
        self.assert_refused(self.deny_check("licenses"), "rejected")

    def test_forbidden_tls_backend_is_refused(self):
        self.local_dependency(name="openssl")
        self.manifest('openssl = { path = "dependency" }\n')
        self.assert_refused(self.deny_check("bans"), "banned")

    def test_registry_wildcard_is_refused(self):
        # cfg-if is an existing, cached workspace dependency. Only metadata runs.
        self.manifest('cfg-if = "*"\n')
        self.assert_refused(self.deny_check("bans"), "wildcard")

    def test_unapproved_git_source_is_refused(self):
        dependency = self.local_dependency()
        for arguments in (
            ["git", "init", "--quiet"],
            ["git", "add", "Cargo.toml", "src/lib.rs"],
            ["git", "-c", "user.name=Policy Control", "-c", "user.email=policy@example.invalid",
             "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null",
             "commit", "--quiet", "-m", "local source control"],
        ):
            self.assert_pass(self.run_tool(arguments, cwd=dependency))
        self.manifest('control-dep = { git = "' + dependency.as_uri() + '" }\n')
        # Offline mode cannot initialize even a local git cache. This command can
        # read only the explicitly named file URL; it compiles and runs no code.
        result = subprocess.run(
            [self.cargo, "metadata", "--format-version", "1"],
            cwd=self.project, env=dict(self.env, CARGO_NET_OFFLINE="false"),
            text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=60,
        )
        self.assert_pass(result)
        self.assert_refused(self.deny_check("sources"), "source-not-allowed")

    def test_unapproved_registry_source_is_refused(self):
        self.local_dependency()
        self.manifest('control-dep = { path = "dependency" }\n')
        result = self.run_tool([self.cargo, "metadata", "--format-version", "1", "--offline"])
        self.assert_pass(result)
        metadata = json.loads(result.stdout)
        # cargo-deny's documented metadata input lets this refusal be exercised
        # without creating or fetching an actual unapproved registry.
        for package in metadata["packages"]:
            if package["name"] == "control-dep":
                package["source"] = "registry+https://policy-control.invalid/index"
        path = self.project / "metadata.json"
        path.write_text(json.dumps(metadata), encoding="utf-8")
        result = self.run_tool([
            self.deny, "deny", "--offline", "--config", str(ROOT / "deny.toml"),
            "--metadata-path", str(path), "check", "sources",
        ])
        self.assert_refused(result, "source-not-allowed")

    def test_modified_patches_are_first_party(self):
        result = self.run_tool([
            self.vet, "vet", "dump-graph", "--output-format", "json", "--depth", "full",
            "--locked", "--frozen",
        ], cwd=ROOT)
        self.assert_pass(result)
        graph = json.loads(result.stdout)
        patches = {"alacritty_terminal", "fontdue", "quinn", "quinn-proto", "vte", "wtransport"}
        nodes = [node for node in graph if node["name"] in patches]
        self.assertEqual({node["name"] for node in nodes}, patches)
        self.assertTrue(all(not node["is_third_party"] for node in nodes))

    def vet_store(self, version):
        store = self.project / "supply-chain"
        store.mkdir()
        (store / "audits.toml").write_text("[audits]\n", encoding="utf-8")
        (store / "imports.lock").write_text("", encoding="utf-8")
        (store / "config.toml").write_text(
            '[cargo-vet]\nversion = "0.10"\n[[exemptions.cfg-if]]\n'
            'version = "' + version + '"\ncriteria = "safe-to-deploy"\n'
            'notes = "Synthetic policy test exemption, not a source certification."\n',
            encoding="utf-8",
        )

    def vet_check(self):
        self.assert_pass(self.run_tool([self.cargo, "generate-lockfile", "--offline"]))
        self.assert_pass(self.run_tool([self.vet, "vet", "fmt"]))
        return self.run_tool([
            self.vet, "vet", "--locked", "--frozen", "--no-minimize-exemptions",
            "--output-format", "json",
        ])

    def test_exact_version_exemption_can_pass(self):
        self.manifest('cfg-if = "=1.0.4"\n')
        self.vet_store("1.0.4")
        self.assert_pass(self.vet_check())

    def test_other_version_cannot_inherit_exemption(self):
        self.manifest('cfg-if = "=1.0.4"\n')
        self.vet_store("1.0.3")
        result = self.vet_check()
        self.assert_refused(result, "fail (vetting)")
        failures = json.loads(result.stdout)["failures"]
        self.assertTrue(any(
            item["name"] == "cfg-if" and item["version"] == "1.0.4"
            and "safe-to-deploy" in item["missing_criteria"] for item in failures
        ))


if __name__ == "__main__":
    unittest.main()
