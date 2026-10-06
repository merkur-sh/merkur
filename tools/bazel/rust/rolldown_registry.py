"""Acquire original locked Rolldown crate archives before native SDK production.

This public-network acquisition command is not a Bazel product build action. Its
archive inventory feeds CargoAcquisitionSdkInfo; materialized sources are only
an offline validation aid, never a replacement for the original archive inputs.
"""

import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tomllib
import urllib.request
from urllib.parse import urlsplit

REGISTRY = "registry+https://github.com/rust-lang/crates.io-index"


def load_producer(path):
    spec = importlib.util.spec_from_file_location("declared_registry_producer", path)
    if spec is None or spec.loader is None:
        raise ValueError("missing declared SDK producer implementation")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def locked_packages(lock):
    expected = {}
    prefixes = set()
    for package in tomllib.loads(lock.decode())["package"]:
        if "source" not in package:
            continue
        if package["source"] != REGISTRY:
            raise ValueError("original lock contains an unsupported acquisition source")
        name, version, checksum = (package[key] for key in ("name", "version", "checksum"))
        if not isinstance(name, str) or not name or any(c not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-" for c in name):
            raise ValueError("invalid locked crate name")
        if not isinstance(version, str) or not version or any(c not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_.+-" for c in version) or version in {".", ".."}:
            raise ValueError("invalid locked crate version")
        if not isinstance(checksum, str) or len(checksum) != 64 or any(c not in "0123456789abcdef" for c in checksum):
            raise ValueError("invalid locked archive checksum")
        key = name, version
        prefix = name + "-" + version
        if key in expected or prefix in prefixes:
            raise ValueError("duplicate or overlapping locked archive identity")
        prefixes.add(prefix)
        expected[key] = checksum
    return [{"name": name, "version": version, "checksum": checksum}
            for (name, version), checksum in sorted(expected.items())]


def original_lock(path, producer, original):
    data, _, fact = producer.read_regular(path)
    if fact["sha256"] != original["archive_sha256"]:
        raise ValueError("Rolldown original source archive differs from its pinned digest")
    name = "rolldown-" + original["commit"] + "/Cargo.lock"
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as archive:
        members = [member for member in archive.getmembers() if member.name == name]
        if len(members) != 1 or not members[0].isfile():
            raise ValueError("original Rolldown lock is not one unambiguous regular File")
        stream = archive.extractfile(members[0])
        if stream is None:
            raise ValueError("original Rolldown lock is unreadable")
        lock = stream.read()
    packages = locked_packages(lock)
    return lock, packages, fact


class StaticCratesRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, url):
        parsed = urlsplit(url)
        if parsed.scheme != "https" or parsed.netloc != "static.crates.io":
            raise ValueError("crate download redirected away from its public HTTPS source")
        return super().redirect_request(request, fp, code, message, headers, url)


def fetch_archive(url):
    opener = urllib.request.build_opener(StaticCratesRedirect())
    with opener.open(url, timeout=60) as response:
        return response.read()


def archive_declarations(packages):
    """Public repository declarations and the existing producer's archive map."""
    lines = ['load("@bazel_tools//tools/build_defs/repo:http.bzl", "http_file")', "",
             "def rolldown_registry_archives():"]
    labels = []
    for package in packages:
        name, version, checksum = (package[key] for key in ("name", "version", "checksum"))
        # The full original checksum gives every repository an unambiguous name.
        repository = "rolldown_registry_" + checksum
        filename = name + "-" + version + ".crate"
        lines.extend(["    http_file(", "        name = " + json.dumps(repository) + ",",
                      "        urls = [" + json.dumps("https://static.crates.io/crates/" + name + "/" + filename) + "],",
                      "        sha256 = " + json.dumps(checksum) + ",",
                      "        downloaded_file_path = " + json.dumps(filename) + ",", "    )"])
        labels.append("    " + json.dumps("@" + repository + "//file") + ": " + json.dumps(name + "@" + version) + ",")
    return "\n".join([*lines, "", "ROLLDOWN_REGISTRY_ARCHIVES = {", *labels, "}", ""])


def acquire_packages(packages, output, producer, jobs=12, fetch=fetch_archive):
    output = Path(output).absolute()
    output.mkdir(parents=True, exist_ok=True)
    if output.is_symlink() or not output.is_dir():
        raise ValueError("acquisition output must be an ordinary directory")
    originals = output / "originals"
    originals.mkdir(exist_ok=True)
    if originals.is_symlink() or not originals.is_dir():
        raise ValueError("original archives directory must be ordinary")

    def acquire(package):
        name, version = package["name"], package["version"]
        prefix = name + "-" + version
        url = "https://static.crates.io/crates/" + name + "/" + prefix + ".crate"
        path = originals / (prefix + ".crate")
        if path.is_symlink():
            raise ValueError("preserved original archive must not be a symlink")
        if path.exists():
            data, _, _ = producer.read_regular(path)
        else:
            data = fetch(url)
            if hashlib.sha256(data).hexdigest() != package["checksum"]:
                raise ValueError("download differs from original lock checksum: " + prefix)
            with path.open("xb") as stream:
                stream.write(data)
        if hashlib.sha256(data).hexdigest() != package["checksum"]:
            raise ValueError("preserved original differs from lock checksum: " + prefix)
        members = producer.load_members(data, prefix)
        manifest = tomllib.loads(members["Cargo.toml"][0].decode())["package"]
        if (manifest["name"], manifest["version"]) != (name, version):
            raise ValueError("original crate manifest differs from its locked identity")
        return {**package, "url": url, "file": producer.bytes_fact(path)}, members

    with ThreadPoolExecutor(max_workers=jobs) as workers:
        acquired = list(workers.map(acquire, packages))
    registry = output / "registry"
    registry.mkdir()
    for (archive, members) in acquired:
        directory = registry / (archive["name"] + "-" + archive["version"])
        directory.mkdir()
        checksums = {}
        for relative, (data, mode) in sorted(members.items()):
            path = directory / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            with path.open("xb") as stream:
                stream.write(data)
            path.chmod(mode)
            checksums[relative] = hashlib.sha256(data).hexdigest()
        with (directory / ".cargo-checksum.json").open("x") as stream:
            json.dump({"package": archive["checksum"], "files": checksums}, stream, sort_keys=True)
            stream.write("\n")
    return {"archives": [archive for archive, _ in acquired],
            "registry": {"directory": str(registry), "packages": packages,
                         "files": [producer.bytes_fact(path) for path in sorted(registry.rglob("*")) if path.is_file()]}}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-archive", type=Path, required=True)
    parser.add_argument("--producer", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--jobs", type=int, default=12)
    parser.add_argument("--source-instances", type=Path, required=True)
    parser.add_argument("--source-instance", required=True)
    args = parser.parse_args()
    original = json.loads(args.source_instances.read_text())[args.source_instance]
    if args.jobs < 1:
        parser.error("jobs must be positive")
    producer = load_producer(args.producer)
    lock, packages, source = original_lock(args.source_archive, producer, original)
    result = acquire_packages(packages, args.output, producer, args.jobs)
    result["source_archive"] = source
    lock_path = args.output / "Cargo.lock"
    with lock_path.open("xb") as stream:
        stream.write(lock)
    result["lock"] = producer.bytes_fact(lock_path)
    with (args.output / "registry_archives.bzl").open("x") as stream:
        stream.write(archive_declarations(packages))
    with (args.output / "manifest.json").open("x") as stream:
        json.dump(result, stream, indent=2, sort_keys=True)
        stream.write("\n")
    print(json.dumps({"packages": len(packages), "registry_files": len(result["registry"]["files"]),
                      "manifest": str((args.output / "manifest.json").absolute())}))


if __name__ == "__main__":
    main()
