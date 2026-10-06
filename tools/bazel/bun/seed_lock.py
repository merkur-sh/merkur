"""Create an exact-version seed for maintained pnpm resolution during migration.

This seed is not a qualified final lock: Bun peer contexts depend on consumers,
not merely lock-path ancestors. Resolve with the pinned pnpm toolchain, compare
every package identity/integrity and materialized peer/dependency edge through
audit_installed_graph.py, and retain the supported-platform qualification gaps.
No seed may replace the final pnpm lock without that independent comparison.
"""

import argparse
import hashlib
import json
from pathlib import Path


def parse_bun(text):
    # Bun writes JSON with trailing commas. Strip only commas outside strings.
    result = []
    quoted = escaped = False
    for index, char in enumerate(text):
        if quoted:
            result.append(char)
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                quoted = False
        elif char == '"':
            quoted = True
            result.append(char)
        elif char == "," and text[index + 1:].lstrip().startswith(("}", "]")):
            continue
        else:
            result.append(char)
    return json.loads("".join(result))


def components(key):
    segments = key.split("/")
    result = []
    index = 0
    while index < len(segments):
        name = segments[index]
        if name.startswith("@"):
            index += 1
            name += "/" + segments[index]
        result.append(name)
        index += 1
    return result


def translate(source, inventory=None):
    entries = source["packages"]
    workspace = {data["name"]: path for path, data in source["workspaces"].items()}

    def resolve(owner, name, optional=False):
        scope = components(owner) if owner else []
        while True:
            candidate = "/".join([*scope, name])
            if candidate in entries:
                return candidate
            if not scope:
                if optional:
                    return None
                raise ValueError(f"unresolved declared dependency {owner} -> {name}")
            scope.pop()

    def identity(key):
        value = entries[key][0]
        name, version = value.rsplit("@", 1)
        return name, version

    def peer_edges(key, consumer):
        if len(entries[key]) < 3:
            return {}
        metadata = entries[key][2]
        optional = set(metadata.get("optionalPeers", []))
        result = {}
        for name in metadata.get("peerDependencies", {}):
            # A peer is the package its consumer sees. One consumer can pin another version than
            # the lock path of the shared package reaches, and Bun materializes the consumer's.
            edge = resolve(consumer, name, True)
            if edge is None:
                edge = resolve(key, name, name in optional)
            if edge is not None:
                result[name] = edge
        return result

    def snapshot_key(key, consumer):
        name, version = identity(key)
        peers = []
        for peer, edge in sorted(peer_edges(key, consumer).items()):
            _, resolved = identity(edge)
            if not resolved.startswith("workspace:"):
                peers.append(f"({peer}@{resolved})")
        return name + "@" + version + "".join(peers)

    # Every package as one of its consumers sees it; each becomes one snapshot.
    contexts = {}

    def edge_version(owner, name, optional=False):
        key = resolve(owner, name, optional)
        if key is None:
            return None
        resolved_name, version = identity(key)
        if version.startswith("workspace:"):
            return "link:" + version.removeprefix("workspace:")
        contexts.setdefault((key, owner), None)
        return snapshot_key(key, owner).removeprefix(resolved_name + "@")

    lock = {"lockfileVersion": "9.0", "settings": {"autoInstallPeers": False, "excludeLinksFromLockfile": False}, "catalogs": {"default": {}}, "importers": {}, "packages": {}, "snapshots": {}}
    for name, version in sorted(source["catalog"].items()):
        key = resolve("", name)
        lock["catalogs"]["default"][name] = {"specifier": version, "version": identity(key)[1]}
    for path, data in source["workspaces"].items():
        importer = {}
        for category in ("dependencies", "devDependencies", "optionalDependencies"):
            if category not in data:
                continue
            importer[category] = {}
            for name, specifier in data[category].items():
                version = edge_version("", name)
                if name in workspace:
                    import posixpath
                    version = "link:" + posixpath.relpath(workspace[name], path or ".")
                importer[category][name] = {"specifier": specifier, "version": version}
        lock["importers"][path or "."] = importer
    package_count = 0
    for key, value in entries.items():
        name, version = identity(key)
        if version.startswith("workspace:"):
            continue
        package_count += 1
        if len(value) != 4 or not value[3].startswith("sha512-") or value[1]:
            raise ValueError(f"unsupported package source or missing integrity: {key}")
        metadata = value[2]
        acquired = inventory.get(name + "@" + version) if inventory is not None else None
        if inventory is not None and (acquired is None or acquired["integrity"] != value[3]):
            raise ValueError(f"missing verified preparation metadata for {name}@{version}")
        package = {"resolution": {"integrity": value[3]}}
        for field in ("peerDependencies",):
            if field in metadata:
                package[field] = metadata[field]
        platform_metadata = acquired if acquired is not None else metadata
        for field in ("cpu", "os", "libc", "engines"):
            if field in platform_metadata:
                raw = platform_metadata[field]
                package[field] = raw if isinstance(raw, (list, dict)) else [raw]
        if metadata.get("optionalPeers"):
            package["peerDependenciesMeta"] = {name: {"optional": True} for name in metadata["optionalPeers"]}
        if metadata.get("bin"):
            package["hasBin"] = True
        package_id = name + "@" + version
        previous = lock["packages"].setdefault(package_id, package)
        if previous != package:
            raise ValueError(f"inconsistent package identity {package_id}")
    pending = list(contexts)
    seen = set()
    while pending:
        key, consumer = pending.pop()
        if (key, consumer) in seen:
            continue
        seen.add((key, consumer))
        metadata = entries[key][2]
        snapshot = {}
        for category in ("dependencies", "optionalDependencies"):
            deps = {dep: edge_version(key, dep) for dep in metadata.get(category, {})}
            if category == "dependencies":
                for peer, edge in peer_edges(key, consumer).items():
                    peer_name, peer_version = identity(edge)
                    if peer_version.startswith("workspace:"):
                        continue
                    contexts.setdefault((edge, consumer), None)
                    deps.setdefault(peer, snapshot_key(edge, consumer).removeprefix(peer_name + "@"))
            if deps:
                snapshot[category] = deps
        snapshot_id = snapshot_key(key, consumer)
        previous = lock["snapshots"].setdefault(snapshot_id, snapshot)
        if previous != snapshot:
            raise ValueError(f"distinct dependency contexts collapsed: {key} -> {snapshot_id}")
        pending.extend(context for context in contexts if context not in seen)
    return lock, {"bunRegistryEntries": package_count, "pnpmPackages": len(lock["packages"]), "pnpmSnapshots": len(lock["snapshots"]), "workspaceImporters": len(lock["importers"])}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, default=Path("bun.lock"))
    parser.add_argument("--output", type=Path, default=Path("/tmp/merkur-pnpm-seed.json"))
    parser.add_argument("--metadata", type=Path, default=Path("tools/bazel/bun/npm-inventory.json"))
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    source_bytes = args.source.read_bytes()
    metadata = json.loads(args.metadata.read_text())
    lock, inventory = translate(parse_bun(source_bytes.decode()), metadata)
    output = (json.dumps(lock, indent=2, sort_keys=True) + "\n").encode()
    if args.check:
        if args.output.read_bytes() != output:
            raise SystemExit("migration seed differs from recorded Bun lock fields")
    else:
        args.output.write_bytes(output)
    inventory["bunLockSha256"] = hashlib.sha256(source_bytes).hexdigest()
    inventory["pnpmLockSha256"] = hashlib.sha256(output).hexdigest()
    print(json.dumps(inventory, sort_keys=True))


if __name__ == "__main__":
    main()
