"""Materialize original locked archives and SDK Files into acquisition inputs.

This ordinary build action does not compile or test a Rust product. All archive,
toolchain, lock and source paths originate in configured declared File inputs.
"""
import argparse
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path, PurePosixPath
import stat
import tarfile
import tomllib
import tempfile
from types import SimpleNamespace
import unicodedata


REGISTRY = "registry+https://github.com/rust-lang/crates.io-index"


def portable(value):
    if not isinstance(value, str) or not value or "\\" in value or "\0" in value:
        raise ValueError("invalid declared relative member path")
    path = PurePosixPath(value)
    if path.is_absolute() or str(path) != value or any(part in {"", ".", ".."} for part in value.split("/")):
        raise ValueError("noncanonical or escaping declared member path")
    return path


def bytes_fact(path):
    return read_regular(path)[2]


def read_regular(path):
    path = Path(path)
    physical = path.resolve(strict=True)
    descriptor = os.open(physical, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(descriptor, "rb") as stream:
        before = os.fstat(stream.fileno())
        if not stat.S_ISREG(before.st_mode):
            raise ValueError("declared input does not present a regular File")
        data = stream.read()
        after = os.fstat(stream.fileno())
    fingerprint = lambda value: (value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns, value.st_ctime_ns)
    if fingerprint(before) != fingerprint(after) or path.resolve(strict=True) != physical or fingerprint(physical.stat()) != fingerprint(after):
        raise ValueError("declared input changed during capture")
    return data, before.st_mode & 0o777, {"path": str(path), "size": len(data), "sha256": hashlib.sha256(data).hexdigest()}


def folded(part):
    """The spelling a case-folding, normalization-insensitive volume compares."""
    return unicodedata.normalize("NFD", unicodedata.normalize("NFD", part).casefold())


def load_members(data, prefix):
    # The registry Tree is an engine output that every execution host's volume
    # must hold, so it never carries two names one of them folds together. Cargo's
    # own unpack on such a volume is the rule: a directory keeps its first
    # spelling, and a later File replaces the earlier one under its own name.
    members = {}
    spelling = {(): ()}
    held = {}
    seen = set()
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as archive:
        for entry in archive.getmembers():
            # TarInfo normalizes directory suffixes, so validate the original
            # header as well as the effective (including PAX) member name.
            archive.fileobj.seek(entry.offset_data - tarfile.BLOCKSIZE)
            header = archive.fileobj.read(tarfile.BLOCKSIZE)
            if entry.isdir() and header[:100].split(b"\0", 1)[0].endswith(b"//"):
                raise ValueError("noncanonical original archive directory name")
            name = entry.name[:-1] if entry.isdir() and entry.name.endswith("/") else entry.name
            path = portable(name)
            if str(path) in seen:
                raise ValueError("duplicate archive member")
            seen.add(str(path))
            if path.parts[0] != prefix:
                raise ValueError("archive member is outside the locked package prefix")
            parts = path.parts[1:]
            if not parts:
                if not entry.isdir():
                    raise ValueError("archive package root is not a directory")
                continue
            if not entry.isdir() and not entry.isfile():
                raise ValueError("archive contains a link or unsupported member")
            key = tuple(folded(part) for part in parts)
            for depth in range(1, len(parts) + (1 if entry.isdir() else 0)):
                if key[:depth] in held:
                    raise ValueError("archive file/directory paths overlap")
                spelling.setdefault(key[:depth], spelling[key[:depth - 1]] + (parts[depth - 1],))
            if entry.isdir():
                continue
            if key in spelling:
                raise ValueError("archive file/directory paths overlap")
            if key == (folded(".cargo-checksum.json"),):
                raise ValueError("archive must not supply the generated directory checksum")
            stream = archive.extractfile(entry)
            if stream is None:
                raise ValueError("unreadable original archive member")
            replaced = held.pop(key, None)
            if replaced is not None:
                del members[replaced]
            relative = "/".join(spelling[key[:-1]] + (parts[-1],))
            held[key] = relative
            members[relative] = (stream.read(), entry.mode & 0o777)
    if "Cargo.toml" not in members:
        raise ValueError("original archive has no package manifest")
    return members


def prepare(request, *, registry_only=False, expand_archives=True):
    if not isinstance(request, dict) or set(request) != {
        "producer", "version", "execution_host", "cargo", "rustc", "sdk", "sources", "locks", "archives",
    }:
        raise ValueError("invalid configured acquisition request")
    if request["version"] != "1.97.1":
        raise ValueError("acquisition producer requires pinned Rust1.97.1")
    if not isinstance(request["producer"], str) or not request["producer"].startswith(("//", "@@//")):
        raise ValueError("producer must be a configured target label")
    if any(not isinstance(request[key], list) for key in ["sdk", "sources", "archives"]):
        raise ValueError("configured File inventories must be lists")
    for path in [request["cargo"], request["rustc"], *request["sdk"]]:
        if not isinstance(path, str) or not path or "\0" in path:
            raise ValueError("invalid declared tool File path")
    if len(request["sdk"]) != len(set(request["sdk"])):
        raise ValueError("duplicate declared SDK File")
    sources = {}
    source_inputs = []
    for entry in request["sources"]:
        if not isinstance(entry, dict) or set(entry) != {"logical", "path"}:
            raise ValueError("invalid configured source File mapping")
        logical = str(portable(entry["logical"]))
        if logical in sources:
            raise ValueError("duplicate first-party source member")
        data, mode, fact = read_regular(entry["path"])
        sources[logical] = (data, mode)
        source_inputs.append({"logical": logical, "file": fact})
    for name in sources:
        if any(str(parent) in sources for parent in PurePosixPath(name).parents if str(parent) != "."):
            raise ValueError("first-party source file/directory paths overlap")
    runtime_name = "tools/bazel/rust/runtime_inputs.json"
    if runtime_name in sources:
        runtime = json.loads(sources[runtime_name][0])
        if not isinstance(runtime, dict) or any(not isinstance(owner, str) or not owner or not isinstance(paths, list) for owner, paths in runtime.items()):
            raise ValueError("Original runtime inventory must map packages to source File lists")
        for paths in runtime.values():
            for path in paths:
                portable(path)
                if path not in sources:
                    raise ValueError("Original runtime source File is absent from acquisition: " + path)
    if not isinstance(request["locks"], list) or len(request["locks"]) != len(set(request["locks"])):
        raise ValueError("duplicate or malformed declared lock membership")
    if registry_only and (sources or request["locks"]):
        raise ValueError("reusable registry action must not capture checkout sources or locks")
    expected = {}
    for logical in request["locks"]:
        portable(logical)
        if logical not in sources:
            raise ValueError("declared lock is absent from the source File inventory")
        for package in tomllib.loads(sources[logical][0].decode())["package"]:
            source = package.get("source")
            if source is None:
                continue
            if source != REGISTRY or "checksum" not in package:
                raise ValueError("locked source has no supported original archive checksum")
            key = package["name"], package["version"]
            checksum = package["checksum"]
            if not isinstance(checksum, str) or len(checksum) != 64 or any(c not in "0123456789abcdef" for c in checksum):
                raise ValueError("invalid locked original archive checksum")
            if key in expected and expected[key] != checksum:
                raise ValueError("conflicting original archive lock checksums")
            expected[key] = checksum
    archives = {}
    prefixes = set()
    origin = []
    for entry in request["archives"]:
        if not isinstance(entry, dict) or set(entry) != {"name", "version", "path", "label"}:
            raise ValueError("invalid original archive File mapping")
        key = entry["name"], entry["version"]
        if any(not isinstance(value, str) or not value for value in key) or not isinstance(entry["label"], str) or not entry["label"].startswith("@"):
            raise ValueError("invalid configured original archive identity")
        if key in archives or (not registry_only and key not in expected):
            raise ValueError("duplicate or unlocked original archive")
        prefix = entry["name"] + "-" + entry["version"]
        portable(prefix)
        if prefix in prefixes:
            raise ValueError("original archive package paths overlap")
        prefixes.add(prefix)
        data, _, fact = read_regular(entry["path"])
        checksum = hashlib.sha256(data).hexdigest()
        if not registry_only and checksum != expected[key]:
            raise ValueError("original archive bytes differ from the locked checksum")
        if registry_only:
            expected[key] = checksum
        members = load_members(data, prefix) if expand_archives else None
        if members is not None:
            manifest = tomllib.loads(members["Cargo.toml"][0].decode())["package"]
            if (manifest["name"], manifest["version"]) != key:
                raise ValueError("original archive manifest does not match its locked identity")
        archives[key] = members
        origin.append({"name": key[0], "version": key[1], "label": entry["label"],
                       "archive": fact, **({"member_count": len(members)} if members is not None else {})})
    if set(archives) != set(expected):
        raise ValueError("original archive Files omit the complete locked source closure")
    return sources, archives, expected, origin, source_inputs


def identity(value):
    return value.st_dev, value.st_ino


class OwnedOutputs:
    """Hold engine-presented parents; publish/clean only journaled owned entries."""

    def __init__(self, paths, precreated_trees=()):
        self.handles = []
        self.parents = {}
        self.directories = {}
        self.directory_entries = {}
        self.entries = []
        self.precreated = {}
        admitted = {str(Path(path).absolute()) for path in precreated_trees}
        try:
            physical = []
            for path in paths:
                path = Path(path).absolute()
                parent_path = path.parent.resolve(strict=True)
                descriptor = self.open_directory("/")
                for part in parent_path.parts[1:]:
                    descriptor = self.open_directory(part, descriptor)
                destination = parent_path / path.name
                if any(destination == old or destination.is_relative_to(old) or old.is_relative_to(destination) for old in physical):
                    raise ValueError("declared output paths overlap")
                physical.append(destination)
                try:
                    value = os.stat(path.name, dir_fd=descriptor, follow_symlinks=False)
                except FileNotFoundError:
                    pass
                else:
                    if str(path) not in admitted or not stat.S_ISDIR(value.st_mode):
                        raise FileExistsError("declared output path is not fresh")
                    tree = self.open_directory(path.name, descriptor)
                    if os.listdir(tree) or identity(value) != identity(os.fstat(tree)):
                        raise FileExistsError("engine-created declared TreeArtifact is not empty")
                    self.precreated[str(path)] = tree
                self.parents[str(path)] = descriptor
            self.verify()
        except BaseException:
            self.close()
            raise

    def open_directory(self, name, parent=None):
        descriptor = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
        self.handles.append(descriptor)
        return descriptor

    def verify_parents(self):
        for path, parent in self.parents.items():
            if identity(Path(path).parent.resolve(strict=True).stat()) != identity(os.fstat(parent)):
                raise ValueError("declared output parent changed")

    def verify_entry(self, entry):
        parent, name, expected, directory = entry
        value = os.stat(name, dir_fd=parent, follow_symlinks=False)
        if identity(value) != expected or stat.S_ISDIR(value.st_mode) != directory:
            raise ValueError("owned output entry changed")

    def verify_parent(self, parent):
        self.verify_parents()
        # Only the ancestor chain authorizes this mutation. Siblings are checked
        # together at publication, rather than rescanned for every written File.
        while parent in self.directory_entries:
            entry = self.directory_entries[parent]
            self.verify_entry(entry)
            if identity(os.fstat(parent)) != entry[2]:
                raise ValueError("owned output directory descriptor changed")
            parent = entry[0]

    def verify(self):
        self.verify_parents()
        for entry in self.entries:
            self.verify_entry(entry)

    def mkdir(self, parent, name):
        self.verify_parent(parent)
        os.mkdir(name, 0o755, dir_fd=parent)
        entry = (parent, name, identity(os.stat(name, dir_fd=parent, follow_symlinks=False)), True)
        self.entries.append(entry)
        descriptor = self.open_directory(name, parent)
        self.directory_entries[descriptor] = entry
        self.verify_parent(descriptor)
        return descriptor

    def tree(self, path):
        key = str(Path(path).absolute())
        if key in self.precreated:
            descriptor = self.precreated[key]
            entry = (self.parents[key], Path(key).name, identity(os.fstat(descriptor)), True)
            self.entries.append(entry)
            self.directory_entries[descriptor] = entry
            self.directories[(key, ())] = descriptor
            self.verify_parent(descriptor)
        else:
            self.directories[(key, ())] = self.mkdir(self.parents[key], Path(key).name)

    def write(self, path, data, mode=0o644, root=None):
        if root is None:
            key = str(Path(path).absolute())
            parent, name = self.parents[key], Path(key).name
        else:
            key = str(Path(root).absolute())
            parts = portable(str(path)).parts
            parent = self.directories[key, ()]
            for index, part in enumerate(parts[:-1], 1):
                directory = key, parts[:index]
                if directory not in self.directories:
                    self.directories[directory] = self.mkdir(parent, part)
                parent = self.directories[directory]
            name = parts[-1]
        self.verify_parent(parent)
        descriptor = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=parent)
        entry = (parent, name, identity(os.fstat(descriptor)), False)
        self.entries.append(entry)
        with os.fdopen(descriptor, "wb") as stream:
            self.verify_entry(entry)
            stream.write(data)
            os.fchmod(stream.fileno(), mode)
        self.verify_entry(entry)
        self.verify_parent(parent)

    def cleanup(self):
        errors = []
        # The complete journal is verified in reverse at rollback. A changed
        # entry refuses deletion while other still-owned entries are cleaned.
        for parent, name, expected, directory in reversed(self.entries):
            try:
                value = os.stat(name, dir_fd=parent, follow_symlinks=False)
                if identity(value) != expected or stat.S_ISDIR(value.st_mode) != directory:
                    raise ValueError("owned output cleanup identity changed")
                if directory:
                    os.rmdir(name, dir_fd=parent)
                else:
                    os.unlink(name, dir_fd=parent)
            except BaseException as error:
                errors.append(error)
        if errors:
            raise BaseExceptionGroup("owned acquisition cleanup failed", errors)

    def close(self):
        for descriptor in reversed(self.handles):
            os.close(descriptor)
        self.handles = []


def produce(request, descriptor, registry, snapshot, provenance, sdk_module, engine_precreated_trees=False, *, registry_only=False):
    sources, archives, checksums, origin, source_inputs = prepare(request, registry_only=registry_only)
    # Validate the actual pinned native tools before creating any output tree.
    sdk_facts = [bytes_fact(path) for path in request["sdk"]]
    empty = {"version": request["version"], "execution_host": request["execution_host"],
             "cargo": bytes_fact(request["cargo"]), "rustc": bytes_fact(request["rustc"]),
             "sdk": sdk_facts, "locks": [], "registry": {"directory": None, "packages": [], "files": []}}
    sdk = sdk_module.NativeCargoSdk(empty)
    sdk.close()
    captured = sdk_facts + [entry["archive"] for entry in origin] + [entry["file"] for entry in source_inputs]
    def recheck_inputs():
        if any(bytes_fact(fact["path"]) != fact for fact in captured):
            raise ValueError("declared input bytes changed after validation")
    recheck_inputs()
    trees = [registry] if registry_only else [registry, snapshot]
    outputs = OwnedOutputs([descriptor, provenance, *trees],
                           trees if engine_precreated_trees else [])
    try:
        for root in [Path(value) for value in trees]:
            outputs.tree(root)
        for logical, (data, mode) in sources.items():
            outputs.write(logical, data, mode, root=snapshot)
        for (name, version), members in sorted(archives.items()):
            directory = Path(registry) / (name + "-" + version)
            files = {}
            for relative, (data, mode) in sorted(members.items()):
                outputs.write(name + "-" + version + "/" + relative, data, mode, root=registry)
                files[relative] = hashlib.sha256(data).hexdigest()
            outputs.write(name + "-" + version + "/.cargo-checksum.json", (json.dumps({"package": checksums[name, version], "files": files}, sort_keys=True) + "\n").encode(), root=registry)
        result = {**empty, "locks": [bytes_fact(Path(snapshot) / logical) for logical in request["locks"]],
                  "registry": {"directory": str(registry),
                               "packages": [{"name": name, "version": version, "checksum": checksums[name, version]} for name, version in sorted(archives)],
                               "files": [bytes_fact(p) for p in sorted(Path(registry).rglob("*")) if p.is_file()]}}
        recheck_inputs()
        outputs.write(descriptor, (json.dumps(result, indent=2) + "\n").encode())
        receipt = {"producer": request["producer"], "execution_host": request["execution_host"],
                   "original_archives": origin, "source_files": [bytes_fact(Path(snapshot) / name) for name in sorted(sources)],
                   "original_sources": sorted(source_inputs, key=lambda entry: entry["logical"]),
                   "sdk_files": sdk_facts, "descriptor": bytes_fact(descriptor),
                   "scope": "Configured declared input provenance; native pool/engine admission is independent."}
        outputs.write(provenance, (json.dumps(receipt, indent=2) + "\n").encode())
        outputs.verify()
        recheck_inputs()
    except BaseException:
        outputs.cleanup()
        raise
    finally:
        outputs.close()


def produce_sources(request, registry_descriptor, registry_provenance, descriptor, snapshot,
                    provenance, sdk_module, engine_precreated_trees=False, *, materializer):
    # The original registry action owns archive unpacking and native runtime Files.
    # The source action must still authorize the exact current lock/archive union.
    sources, _, checksums, origin, source_inputs = prepare(request, expand_archives=False)
    base = json.loads(Path(registry_descriptor).read_bytes())
    parent = json.loads(Path(registry_provenance).read_bytes())
    if (parent["producer"] != request["producer"] or
            parent["execution_host"] != request["execution_host"] or
            parent["descriptor"] != bytes_fact(registry_descriptor)):
        raise ValueError("source capture requires its configured immutable registry producer")
    runtime = [bytes_fact(path) for path in request["sdk"]]
    if (base["version"] != request["version"] or base["execution_host"] != request["execution_host"] or
            base["cargo"] != bytes_fact(request["cargo"]) or
            base["rustc"] != bytes_fact(request["rustc"]) or base["sdk"] != runtime or
            parent["sdk_files"] != runtime):
        raise ValueError("reused registry compiler Files differ from the configured toolchain")
    expected = [{"name": name, "version": version, "checksum": checksum}
                for (name, version), checksum in sorted(checksums.items())]
    if base["registry"]["packages"] != expected:
        raise ValueError("reused registry differs from the complete current locked source closure")
    previous = {(entry["name"], entry["version"]): entry for entry in parent["original_archives"]}
    if len(previous) != len(parent["original_archives"]) or set(previous) != set(checksums):
        raise ValueError("reused registry original archive inventory differs")
    for entry in origin:
        original = previous[entry["name"], entry["version"]]
        if ({key: value for key, value in original.items() if key != "member_count"} != entry or
                type(original["member_count"]) is not int or original["member_count"] < 1):
            raise ValueError("reused registry original archive File differs")
    # The typed input TreeArtifact may present its Files as sandbox symlinks.
    # Use the existing byte/member materializer before the unchanged strict loader;
    # the published descriptor below still retains the original registry authority.
    original_paths = {entry["logical"]: entry["path"] for entry in request["sources"]}
    captured = runtime + [entry["archive"] for entry in origin] + [entry["file"] for entry in source_inputs]
    captured += [bytes_fact(registry_descriptor), bytes_fact(registry_provenance)]
    # Existing complete producer outputs may supply the same registry authority.
    # Their historical source Files remain immutable and never become new inputs.
    captured += parent["source_files"] + base["registry"]["files"]
    def recheck_inputs():
        if any(bytes_fact(fact["path"]) != fact for fact in captured):
            raise ValueError("declared input bytes changed after validation")
    outputs = OwnedOutputs([descriptor, snapshot, provenance],
                           [snapshot] if engine_precreated_trees else [])
    try:
        with tempfile.TemporaryDirectory(prefix="merkur-source-registry-presentation-",
                                             dir=Path(snapshot).absolute().parent) as temporary:
            registry = Path(temporary) / "registry"
            registry.mkdir()
            facts = materializer.materialize(Path(base["registry"]["directory"]),
                                             base["registry"]["files"], registry,
                                             SimpleNamespace(read_regular=read_regular))
            sdk = sdk_module.NativeCargoSdk({**base,
                "registry": {**base["registry"], "directory": str(registry), "files": facts},
                "locks": [bytes_fact(original_paths[name]) for name in request["locks"]]})
            sdk.close()
        recheck_inputs()
        outputs.tree(Path(snapshot))
        for logical, (data, mode) in sources.items():
            outputs.write(logical, data, mode, root=snapshot)
        result = {**base, "locks": [bytes_fact(Path(snapshot) / logical) for logical in request["locks"]]}
        recheck_inputs()
        outputs.write(descriptor, (json.dumps(result, indent=2) + "\n").encode())
        receipt = {"producer": request["producer"], "execution_host": request["execution_host"],
                   "original_archives": parent["original_archives"],
                   "source_files": [bytes_fact(Path(snapshot) / name) for name in sorted(sources)],
                   "original_sources": sorted(source_inputs, key=lambda entry: entry["logical"]),
                   "sdk_files": runtime, "descriptor": bytes_fact(descriptor),
                   "scope": "Configured declared input provenance; native pool/engine admission is independent."}
        outputs.write(provenance, (json.dumps(receipt, indent=2) + "\n").encode())
        outputs.verify()
        recheck_inputs()
    except BaseException:
        outputs.cleanup()
        raise
    finally:
        outputs.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ["request", "descriptor", "provenance", "sdk_resolver"]:
        parser.add_argument("--" + name.replace("_", "-"), type=Path, required=True)
    for name in ["registry", "snapshot", "registry_descriptor", "registry_provenance"]:
        parser.add_argument("--" + name.replace("_", "-"), type=Path)
    parser.add_argument("--sdk-materializer", type=Path)
    parser.add_argument("--phase", choices=["registry", "source"], required=True)
    parser.add_argument("--engine-precreated-tree-roots", action="store_true")
    args = parser.parse_args()
    spec = importlib.util.spec_from_file_location("declared_sdk", args.sdk_resolver)
    if spec is None or spec.loader is None:
        raise ValueError("missing declared SDK resolver File")
    module = importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    request = json.loads(args.request.read_text())
    if args.phase == "registry":
        if args.registry is None or args.snapshot is not None or args.registry_descriptor is not None or args.registry_provenance is not None:
            parser.error("registry phase requires only its registry output")
        produce(request, args.descriptor, args.registry, None, args.provenance, module,
                args.engine_precreated_tree_roots, registry_only=True)
    else:
        if args.snapshot is None or args.registry_descriptor is None or args.registry_provenance is None or args.registry is not None or args.sdk_materializer is None:
            parser.error("source phase requires its snapshot, immutable registry descriptor/provenance and declared materializer")
        spec = importlib.util.spec_from_file_location("declared_materializer", args.sdk_materializer)
        if spec is None or spec.loader is None:
            raise ValueError("missing declared SDK materializer File")
        materializer = importlib.util.module_from_spec(spec);spec.loader.exec_module(materializer)
        produce_sources(request, args.registry_descriptor, args.registry_provenance, args.descriptor,
                        args.snapshot, args.provenance, module, args.engine_precreated_tree_roots,
                        materializer=materializer)


if __name__ == "__main__":
    main()
