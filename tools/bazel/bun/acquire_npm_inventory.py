"""Acquire published package facts only after verifying the locked tarball bytes."""

import argparse
import base64
from concurrent.futures import ThreadPoolExecutor
import hashlib
import io
import json
from pathlib import Path
import tarfile
from urllib.parse import quote
from urllib.request import urlopen

from seed_lock import parse_bun


FIELDS = (
    "dependencies", "optionalDependencies", "peerDependencies", "peerDependenciesMeta",
    "os", "cpu", "libc", "engines", "bin",
)
LIFECYCLE = ("preinstall", "install", "postinstall", "prepare")


def acquire(entry):
    identity, integrity = entry
    name, version = identity.rsplit("@", 1)
    with urlopen("https://registry.npmjs.org/" + quote(name, safe="@") + "/" + quote(version), timeout=60) as response:
        registry = json.load(response)
    tarball = registry["dist"]["tarball"]
    with urlopen(tarball, timeout=60) as response:
        archive = response.read()
    algorithm, expected = integrity.split("-", 1)
    if algorithm != "sha512" or hashlib.sha512(archive).digest() != base64.b64decode(expected, validate=True):
        raise ValueError("locked SHA512 does not match acquired package: " + identity)
    with tarfile.open(fileobj=io.BytesIO(archive), mode="r:gz") as package:
        manifests = [member for member in package.getmembers() if member.isfile() and (member.name == "package.json" or (member.name.endswith("/package.json") and member.name.count("/") == 1))]
        if len(manifests) != 1:
            raise ValueError("tarball does not have one top-level package.json: " + identity)
        stream = package.extractfile(manifests[0])
        if stream is None:
            raise ValueError("tarball package.json cannot be read: " + identity)
        manifest = json.load(stream)
    if manifest.get("name") != name or manifest.get("version") != version:
        raise ValueError("tarball package identity differs from locked identity: " + identity)
    metadata = {field: manifest[field] for field in FIELDS if field in manifest}
    metadata["lifecycleScripts"] = {key: value for key, value in manifest.get("scripts", {}).items() if key in LIFECYCLE}
    metadata["integrity"] = integrity
    metadata["tarball"] = tarball
    return identity, metadata


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--bun-lock", type=Path, default=Path("bun.lock"))
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    source = parse_bun(args.bun_lock.read_text())
    identities = {}
    for package in source["packages"].values():
        if len(package) == 4:
            previous = identities.setdefault(package[0], package[3])
            if previous != package[3]:
                raise ValueError("one locked identity has multiple integrities: " + package[0])
    # Facts recorded for the same locked integrity were verified against those bytes when they
    # were acquired, so only an identity the output lacks, or holds for other bytes, is fetched.
    recorded = json.loads(args.output.read_text()) if args.output.exists() else {}
    kept = {identity: recorded[identity] for identity, integrity in identities.items()
            if recorded.get(identity, {}).get("integrity") == integrity}
    missing = sorted(item for item in identities.items() if item[0] not in kept)
    with ThreadPoolExecutor(max_workers=8) as executor:
        acquired = dict(executor.map(acquire, missing))
    args.output.write_text(json.dumps(kept | acquired, sort_keys=True, indent=2) + "\n")
    print(f"{len(acquired)} identities acquired and SHA512-verified, {len(kept)} kept")


if __name__ == "__main__":
    main()
