"""Original typed stdlib Files/archive custody and configured target graph action."""
import argparse
import importlib.util
import json
from pathlib import Path
import tarfile

WASM = "wasm32-unknown-unknown"
STD = {
    WASM: "fa0edb6e9f34faae5735554d62d50875eded839dc707d0f1c01467a918d8453b",
    "aarch64-apple-darwin": "a4895f5c6995e83cab8687e46b14324592398049def71ce75ca308c981cf200d",
    "x86_64-apple-darwin": "0fa78653023be5bdfeb419edc82e3b1346ccaa23eaa036491cce084101c741dd",
    "aarch64-unknown-linux-gnu": "46aed8e63186350004d8ec6afca798811e6530b514352e5a8a26f3dc4939b3be",
    "x86_64-unknown-linux-gnu": "1c1e704ae80126b7de34f72ea2825f7fd01736dec20732faed47374b95282fba",
}
RUSTC = {
    "aarch64-apple-darwin": "6076cad38ccabaa24325f26a74080a363a2633a9cd34c473a8977255d8a593cb",
    "x86_64-apple-darwin": "3c38289f319bf02fa1c8149ce3e00f261e4efd14813a99f7f7ae4f180c7d1173",
    "aarch64-unknown-linux-gnu": "b344b81f0cd4c2246c7da8b197fe7a339d7dd02bb15cb69b2524115d9c75224c",
    "x86_64-unknown-linux-gnu": "9819d0a32d56bd339585319c80260e332779f5541fd66838ab7e016d6c814819",
}


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def archive_members(graph, archive, expected, wanted, complete_prefix=None):
    archive = Path(archive).resolve(strict=True)
    archive_fact = graph.fact(archive)
    if archive_fact["sha256"] != expected:
        raise ValueError("Original pinned stock distribution archive required")
    pending = dict(wanted)
    matched = {}
    complete = set()
    with tarfile.open(archive, "r|xz") as original:
        for member in original:
            if complete_prefix is not None and member.name.startswith(complete_prefix) and member.isfile():
                complete.add(member.name)
            selected = pending.pop(member.name, None)
            if selected is None:
                continue
            if not member.isfile():
                raise ValueError("Original stock member must be ordinary")
            path = Path(selected).resolve(strict=True)
            if original.extractfile(member).read() != path.read_bytes():
                raise ValueError("Declared stock File differs from original archive member")
            matched[member.name] = graph.fact(path)
    if pending:
        raise ValueError("Declared stock File has no original archive member")
    if complete_prefix is not None and set(wanted) != complete:
        raise ValueError("Declared stock Files omit or exceed the complete original target namespace")
    return archive_fact, matched


def capture(request, graph, pair, sdk, *, source_authority=None):
    target = request["target"]
    if target not in STD or request["compiler"] != "1.97.1":
        raise ValueError("Original Rust1.97.1 link-map provider required")
    host = request.get("execution_host")
    if target == WASM:
        if host not in RUSTC or host != sdk.host:
            raise ValueError("WASM stock graph requires the exact original compiler execution_host")
    elif host is not None and (host != target or host != sdk.host):
        raise ValueError("Native stock graph execution_host differs from its original target/SDK")
    files = request["stdlib"]
    if not files or any(not isinstance(v, dict) or set(v) != {"path", "label"} or not v["label"] for v in files):
        raise ValueError("Complete original typed stdlib Files required")
    wanted = {}
    presentations = {}
    marker = "/lib/rustlib/" + target + "/"
    prefix = "rust-std-1.97.1-" + target + "/rust-std-" + target + "/lib/rustlib/" + target + "/"
    for value in files:
        path = value["path"]
        if not isinstance(path, str) or path.count(marker) != 1:
            raise ValueError("Declared stock File is outside original installed target namespace")
        relative = path.split(marker)[1]
        if not relative or any(v in {"", ".", ".."} for v in relative.split("/")):
            raise ValueError("Invalid original installed stdlib member path")
        member = prefix + relative
        if member in wanted:
            raise ValueError("Repeated original typed stock File")
        wanted[member] = path
        presentations[member] = value
    std_archive, originals = archive_members(graph, request["stdlib_archive"], STD[target], wanted, complete_prefix=prefix) if target == WASM else archive_members(graph, request["stdlib_archive"], STD[target], wanted)
    sysroot = None
    if target == WASM:
        roots = {value["path"].split(marker)[0] for value in originals.values() if value["path"].count(marker) == 1}
        if len(roots) != 1 or any(value["path"].count(marker) != 1 for value in originals.values()):
            raise ValueError("Original WASM stock Files require one exact installed target namespace")
        sysroot = roots.pop()
    compiler_member = "rustc-1.97.1-" + sdk.host + "/rustc/bin/rustc"
    compiler_archive, compiler_files = archive_members(graph, request["compiler_archive"], RUSTC[sdk.host], {compiler_member: sdk.rustc})
    metadata = [originals[member] for member in sorted(originals) if member.endswith(".rmeta")]
    # This input is the PreparedCompilerSourceInfo's declared archive File.
    # Unwrap its engine carrier at the same boundary as the stock archives;
    # the graph's ordinary File and original pinned/member checks stay strict.
    source_archive = Path(request["source_archive"]).resolve(strict=True)
    authority = {} if source_authority is None else {"source_authority": source_authority}
    result = graph.capture(request["source_root"], source_archive, sdk, metadata, target, request["output"], host, **authority) if target == WASM else graph.capture(request["source_root"], source_archive, sdk, metadata, target, request["output"], **authority)
    result["source_archive_input"] = request["source_archive"]
    result["source_archive_label"] = request["source_archive_label"]
    output = Path(request["output"])
    association = []
    by_path = {value["path"]: member for member, value in originals.items()}
    for index, record in enumerate(result["metadata"]):
        metadata_member = by_path[record["file"]["path"]]
        archive_member = str(Path(metadata_member).with_suffix(".rlib"))
        if archive_member not in originals:
            raise ValueError("Stock compiler metadata has no original object archive member")
        archive_file = originals[archive_member]
        observed = pair.pair(sdk, archive_file["path"], record["file"]["path"], target, output / ("pair-" + str(index)), record["crate"], sysroot) if target == WASM else pair.pair(sdk, archive_file["path"], record["file"]["path"], target, output / ("pair-" + str(index)), record["crate"])
        association.append({"identity": record["identity"], "metadata_member": metadata_member,
                            "archive_member": archive_member, "metadata": record["file"],
                            "archive": archive_file, "metadata_input": presentations[metadata_member]["path"],
                            "archive_input": presentations[archive_member]["path"],
                            "metadata_label": presentations[metadata_member]["label"],
                            "archive_label": presentations[archive_member]["label"], "compiler_observation": observed})
    result["stock_association"] = {"stdlib_archive": std_archive, "compiler_archive": compiler_archive,
                                   "compiler_files": compiler_files, "members": association}
    body = json.dumps(result, indent=2) + "\n"
    (output / "graph.json").write_text(body)
    Path(request["graph_output"]).write_text(body)
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ["request", "sdk-resolver", "sdk-materializer", "sdk-capture", "graph-resolver", "pair-resolver"]:
        parser.add_argument("--" + name, required=True)
    args = parser.parse_args()
    request = json.loads(Path(args.request).read_text())
    materializer = load("sdk_materializer", args.sdk_materializer)
    with materializer.materialized_sdk(
        Path(request["sdk"]), Path(request["sdk_provenance"]), Path(request["sdk_sources"]),
        Path(request["sdk_registry"]), request["sdk_producer"],
        load("sdk_capture", args.sdk_capture), load("sdk", args.sdk_resolver),
        private_parent=Path(request["output"]).absolute().parent,
    ) as (sdk, _):
        graph = load("graph", args.graph_resolver)
        source_authority = graph.original_source_namespace(request["source_root"], request["sdk"])
        capture(request, graph, load("pair", args.pair_resolver), sdk, source_authority=source_authority)
