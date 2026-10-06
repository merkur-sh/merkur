"""Declared native Cargo introspection SDK; never a product build executor.

The engine must bind this descriptor and every member to configured toolchain
and source Files. File hashes here detect changed presentations; a caller-created
descriptor is not an independent toolchain or filesystem admission receipt.
"""
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile
import tomllib


NATIVE_HOSTS = {
    "aarch64-apple-darwin", "x86_64-apple-darwin",
    "aarch64-unknown-linux-gnu", "x86_64-unknown-linux-gnu",
}
VERSION = "1.97.1"
REGISTRY = "registry+https://github.com/rust-lang/crates.io-index"


def file_fact(path):
    path = Path(path)
    physical = path.resolve(strict=True)
    if not physical.is_file():
        raise ValueError("SDK member must resolve to a regular declared File")
    data = physical.read_bytes()
    return {"path": str(path), "size": len(data), "sha256": hashlib.sha256(data).hexdigest()}


def checked_file(fact):
    if not isinstance(fact, dict) or set(fact) != {"path", "size", "sha256"}:
        raise ValueError("invalid declared SDK File fact")
    if not isinstance(fact["path"], str) or type(fact["size"]) is not int or fact["size"] < 0:
        raise ValueError("invalid declared SDK File path or size")
    digest = fact["sha256"]
    if not isinstance(digest, str) or len(digest) != 64 or any(c not in "0123456789abcdef" for c in digest):
        raise ValueError("invalid declared SDK File digest")
    actual = file_fact(fact["path"])
    if actual != fact:
        raise ValueError("changed declared SDK File: " + fact["path"])
    return Path(actual["path"]).resolve(strict=True)


class NativeCargoSdk:
    """Explicit tools and an isolated, fully declared offline registry source."""

    def __init__(self, descriptor, *, _descriptor_path=None):
        if not isinstance(descriptor, dict) or set(descriptor) != {
            "version", "execution_host", "cargo", "rustc", "sdk", "locks", "registry",
        }:
            raise ValueError("invalid declared native acquisition descriptor")
        if descriptor["version"] != VERSION or not isinstance(descriptor["execution_host"], str) or descriptor["execution_host"] not in NATIVE_HOSTS:
            raise ValueError("acquisition requires an admitted native Rust1.97.1 SDK")
        self._namespace = None
        if _descriptor_path is not None:
            declared = Path(_descriptor_path)
            if not declared.is_absolute():
                declared = self._relative_path(_descriptor_path)
                original = declared.resolve(strict=True)
                namespace = original.parents[len(declared.parts) - 1]
                if namespace / declared != original:
                    raise ValueError("descriptor carrier differs from its original execution namespace")
                self._namespace = namespace
        self.descriptor = descriptor
        self.host = descriptor["execution_host"]
        self.cargo = checked_file(descriptor["cargo"])
        self.rustc = checked_file(descriptor["rustc"])
        if not isinstance(descriptor["sdk"], list) or not descriptor["sdk"]:
            raise ValueError("acquisition requires declared SDK runtime Files")
        files = [checked_file(fact) for fact in descriptor["sdk"]]
        members = [fact["path"] for fact in descriptor["sdk"]]
        if len(members) != len(set(members)) or self.cargo not in files or self.rustc not in files:
            raise ValueError("SDK runtime inventory requires both tools and unique declared members")
        self.identities = {}
        for name, executable in [("cargo", self.cargo), ("rustc", self.rustc)]:
            result = subprocess.run([str(executable), "-vV"], env={"PATH": ""},
                                    check=True, capture_output=True, text=True)
            fields = dict(line.split(": ", 1) for line in result.stdout.splitlines() if ": " in line)
            if not result.stdout.startswith(name + " ") or fields.get("release") != VERSION or fields.get("host") != self.host:
                raise ValueError("declared " + name + " does not match the native pinned SDK")
            self.identities[name] = result.stdout
        if not isinstance(descriptor["locks"], list):
            raise ValueError("declared acquisition locks must be a File list")
        self.lock_paths = [checked_file(fact) for fact in descriptor["locks"]]
        if len(self.lock_paths) != len(set(self.lock_paths)):
            raise ValueError("duplicate declared acquisition lock")
        self._verify_registry()
        self._private = tempfile.TemporaryDirectory(prefix="merkur-declared-cargo-")
        self.home = Path(self._private.name)
        self.cargo_home = self.home / "cargo-home"
        self.cargo_home.mkdir()
        directory = descriptor["registry"]["directory"]
        if directory is not None:
            directory = str(self.original_tree(directory))
            configuration = ('[source.crates-io]\nreplace-with="merkur-declared"\n'
                             '[source.merkur-declared]\ndirectory=' + json.dumps(directory) + '\n')
            (self.cargo_home / "config.toml").write_text(configuration)

    @classmethod
    def load(cls, path):
        return cls(json.loads(Path(path).read_text()), _descriptor_path=path)

    @staticmethod
    def _relative_path(raw):
        path = Path(raw)
        if (path.is_absolute() or str(path) != str(raw) or "\\" in str(raw) or
                not path.parts or any(part in {".", ".."} for part in path.parts)):
            raise ValueError("declared Tree path must be canonical and execution-relative")
        return path

    def original_tree(self, path):
        namespace = getattr(self, "_namespace", None)
        if namespace is None:
            root = Path(path).resolve(strict=True)
        else:
            root = namespace / self._relative_path(path)
            if root.resolve(strict=True) != root:
                raise ValueError("original declared Tree is an alias")
        if not root.is_dir():
            raise ValueError("declared Tree must be an ordinary directory")
        return root

    def _verify_registry(self):
        registry = self.descriptor["registry"]
        if not isinstance(registry, dict) or set(registry) != {"directory", "packages", "files"}:
            raise ValueError("invalid declared offline registry")
        if not isinstance(registry["packages"], list) or not isinstance(registry["files"], list):
            raise ValueError("registry packages and Files must be declared lists")
        if registry["directory"] is not None and not isinstance(registry["directory"], str):
            raise ValueError("registry directory must be an explicit path")
        expected = {}
        for lock in self.lock_paths:
            for package in tomllib.loads(lock.read_text())["package"]:
                source = package.get("source")
                if source is None:
                    continue
                if source != REGISTRY:
                    raise ValueError("unmodeled Cargo acquisition source: " + source)
                key = (package["name"], package["version"])
                checksum = package["checksum"]
                if key in expected and expected[key] != checksum:
                    raise ValueError("conflicting declared locked registry package")
                expected[key] = checksum
        actual = {}
        for package in registry["packages"]:
            if not isinstance(package, dict) or set(package) != {"name", "version", "checksum"}:
                raise ValueError("invalid declared registry package")
            if any(not isinstance(package[key], str) or not package[key] for key in ["name", "version", "checksum"]):
                raise ValueError("invalid declared registry package identity")
            if any(c not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-" for c in package["name"]):
                raise ValueError("invalid registry package directory name")
            if "/" in package["version"] or "\\" in package["version"] or package["version"] in {".", ".."}:
                raise ValueError("invalid registry package version directory")
            key = package["name"], package["version"]
            if key in actual:
                raise ValueError("duplicate declared registry package")
            actual[key] = package["checksum"]
        if actual != expected:
            raise ValueError("declared registry differs from the complete locked source closure")
        directory = registry["directory"]
        if directory is None:
            if expected or registry["files"]:
                raise ValueError("locked acquisition sources have no declared directory source")
            return
        root = self.original_tree(directory)
        if not root.is_dir():
            raise ValueError("registry source must be a materialized ordinary directory")
        facts = {}
        for fact in registry["files"]:
            path = checked_file(fact)
            try:
                relative = Path(fact["path"]).relative_to(Path(directory))
            except ValueError as error:
                raise ValueError("registry File is outside its declared source") from error
            if (not relative.parts or any(part in {".", ".."} for part in relative.parts) or
                    str(Path(directory) / relative) != fact["path"] or
                    path != root / relative or path in facts):
                raise ValueError("registry File is outside its original declared source or duplicated")
            facts[path] = fact
        physical = set()
        for path in root.rglob("*"):
            if path.is_symlink() or (not path.is_dir() and not path.is_file()):
                raise ValueError("registry source has an alias or unsupported entry")
            if path.is_file():
                physical.add(path)
        if physical != set(facts):
            raise ValueError("registry source File membership changed")
        # Sandbox leaf carriers must name these exact original members, including
        # when every presented leaf has been redirected to a same-byte foreign Tree.
        presented = Path(directory)
        if presented.resolve(strict=True) != root:
            seen = set()
            for path in presented.rglob("*"):
                relative = path.relative_to(presented)
                original = root / relative
                if path.is_dir() and not path.is_symlink():
                    if not original.is_dir():
                        raise ValueError("registry carrier directory differs from its original Tree")
                elif path.is_file() and path.resolve(strict=True) == original and original in facts:
                    seen.add(original)
                else:
                    raise ValueError("registry carrier differs from its original declared member")
            if seen != physical:
                raise ValueError("registry carrier File membership changed")
        if {p.name for p in root.iterdir()} != {name + "-" + version for name, version in expected}:
            raise ValueError("registry package directory membership changed")
        package_facts = {}
        for path, fact in facts.items():
            relative = path.relative_to(root)
            if path.name != ".cargo-checksum.json":
                package_facts.setdefault(relative.parts[0], {})[str(Path(*relative.parts[1:]))] = fact["sha256"]
        for (name, version), checksum in expected.items():
            package = root / (name + "-" + version)
            checksums = json.loads((package / ".cargo-checksum.json").read_text())
            if set(checksums) != {"package", "files"} or checksums["package"] != checksum:
                raise ValueError("registry package does not retain its original locked checksum")
            members = package_facts.get(name + "-" + version, {})
            if checksums["files"] != members:
                raise ValueError("registry directory checksum File membership differs")

    def require_locks(self, paths):
        for path in paths:
            if Path(path).resolve(strict=True) not in self.lock_paths:
                raise ValueError("refresh requires the exact declared lock and complete registry source")

    def command(self, tool, version):
        if version != VERSION or tool not in {"cargo", "rustc"}:
            raise ValueError("acquisition attempted an undeclared tool or compiler version")
        return [str(self.cargo if tool == "cargo" else self.rustc)]

    def environment(self, bootstrap=False):
        result = {"PATH": "", "HOME": str(self.home), "CARGO_HOME": str(self.cargo_home),
                  "CARGO_NET_OFFLINE": "true", "RUSTC": str(self.rustc),
                  "CARGO_TARGET_DIR": str(self.home / "metadata-target")}
        if bootstrap:
            result["RUSTC_BOOTSTRAP"] = "1"
        return result

    def close(self):
        self._private.cleanup()
