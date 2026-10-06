"""Compare materialized Bun package/peer contexts against pnpm's configured graph.

The package inventory comparison uses all locked tarballs, including native
packages absent on this host. The edge comparison uses actually materialized
Bun contexts, rather than guessing peer binding from lock path names.
"""

import argparse
import json
from pathlib import Path

from seed_lock import parse_bun


def package_identity(manifest):
    return manifest["name"] + "@" + manifest["version"]


def locate(owner, dependency):
    for parent in [owner, *owner.parents]:
        manifest = parent / "node_modules" / dependency / "package.json"
        if manifest.is_file():
            return manifest.parent.resolve()
    return None


def materialized_graph(root):
    graph = {}
    contexts = {}

    def signature(directory):
        directory = directory.resolve()
        if directory in contexts:
            return contexts[directory]
        manifest = json.loads((directory / "package.json").read_text())
        peers = []
        for peer in sorted(manifest.get("peerDependencies", {})):
            resolved = locate(directory, peer)
            if resolved is not None:
                peers.append(package_identity(json.loads((resolved / "package.json").read_text())))
        result = package_identity(manifest) + "".join("(" + peer + ")" for peer in peers)
        contexts[directory] = result
        return result

    for store in sorted((root / "node_modules" / ".bun").iterdir()):
        modules = store / "node_modules"
        if not modules.is_dir():
            continue
        for manifest_path in [*modules.glob("*/package.json"), *modules.glob("@*/*/package.json")]:
            directory = manifest_path.parent
            if directory.is_symlink():
                continue
            manifest = json.loads(manifest_path.read_text())
            identity = package_identity(manifest)
            if identity.startswith("@merkur/"):
                continue
            dependencies = set(manifest.get("dependencies", {})) | set(manifest.get("optionalDependencies", {})) | set(manifest.get("peerDependencies", {}))
            edges = {}
            for dependency in sorted(dependencies):
                resolved = locate(directory.resolve(), dependency)
                if resolved is not None:
                    edges[dependency] = signature(resolved)
            key = signature(directory)
            if key in graph and graph[key] != edges:
                raise ValueError("ambiguous actual Bun configured package: " + key)
            graph[key] = edges
    return graph


def pnpm_graph(lock):
    signatures = {}
    for key, snapshot in lock["snapshots"].items():
        identity = key.split("(", 1)[0]
        metadata = lock["packages"][identity]
        deps = snapshot.get("dependencies", {}) | snapshot.get("optionalDependencies", {})
        peers = [name + "@" + deps[name].split("(", 1)[0] for name in sorted(metadata.get("peerDependencies", {})) if name in deps]
        signatures[key] = identity + "".join("(" + peer + ")" for peer in peers)
    graph = {}
    for key, snapshot in lock["snapshots"].items():
        edges = {}
        for name, version in (snapshot.get("dependencies", {}) | snapshot.get("optionalDependencies", {})).items():
            if version.startswith("link:"):
                continue
            target = version if version in signatures else name + "@" + version
            edges[name] = signatures[target]
        signature = signatures[key]
        if signature in graph and graph[signature] != edges:
            raise ValueError("distinct pnpm configurations share their peer signature: " + signature)
        graph[signature] = edges
    return graph


def audit(bun, pnpm, actual, extensions):
    packages = {}
    for value in bun["packages"].values():
        if len(value) == 4:
            packages[value[0]] = value[3]
    expected = {key: value["resolution"]["integrity"] for key, value in pnpm["packages"].items()}
    if packages != expected:
        raise ValueError("package identity/integrity inventory changed")
    configured = pnpm_graph(pnpm)
    optional_edges = {}
    for key, snapshot in pnpm["snapshots"].items():
        identity = key.split("(", 1)[0]
        metadata = pnpm["packages"][identity]
        deps = snapshot.get("dependencies", {}) | snapshot.get("optionalDependencies", {})
        peers = [name + "@" + deps[name].split("(", 1)[0] for name in sorted(metadata.get("peerDependencies", {})) if name in deps]
        signature = identity + "".join("(" + peer + ")" for peer in peers)
        optional_edges.setdefault(signature, set()).update(snapshot.get("optionalDependencies", {}))
    failures = []
    added_optional = []
    resolver_corrections = []
    for context, edges in actual.items():
        candidate = configured.get(context)
        if candidate is None:
            failures.append({"context": context, "reason": "missing Bun peer context"})
            continue
        for name, target in edges.items():
            if candidate.get(name) != target:
                failures.append({"context": context, "dependency": name, "bun": target, "pnpm": candidate.get(name)})
        for name, target in candidate.items():
            if name in edges:
                continue
            added = {"context": context, "dependency": name, "pnpm": target}
            identity = context.split("(", 1)[0]
            declared = extensions.get(identity, {}).get("dependencies", {}).get(name)
            if declared is not None and target == name + "@" + declared:
                resolver_corrections.append(added)
            elif name in optional_edges.get(context, set()):
                # Inventory parity includes these edges; executing their native
                # platform remains a separate qualification obligation.
                added_optional.append(added)
            else:
                failures.append(added | {"reason": "unapproved additional required dependency"})
    return {"lockedPackages": len(packages), "materializedBunContexts": len(actual), "pnpmContexts": len(configured), "unmaterializedPnpmContexts": sorted(set(configured) - set(actual)), "unmaterializedOptionalEdges": added_optional, "declaredResolverCorrections": resolver_corrections, "edgeDifferences": failures}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, default=Path("."))
    parser.add_argument("--pnpm-json", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--workspace-json", type=Path, required=True)
    args = parser.parse_args()
    root = args.root.resolve()
    source = parse_bun((root / "bun.lock").read_text())
    lock = json.loads(args.pnpm_json.read_text())
    workspace = json.loads(args.workspace_json.read_text())
    result = audit(source, lock, materialized_graph(root), workspace.get("packageExtensions", {}))
    args.output.write_text(json.dumps(result, indent=2, sort_keys=True) + "\n")
    print(json.dumps({key: value if not isinstance(value, list) else len(value) for key, value in result.items()}))
    if result["edgeDifferences"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
