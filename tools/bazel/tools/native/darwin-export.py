"""Deterministic export from an independently Apple-signature-verified Xcode bundle.

Copies only the explicit Apple compiler/SDK/license whitelist and reads the bundle's
release identity. It does not discover Xcode, register a compiler, publish the
archive, or access developer account configuration.
"""
import argparse
import gzip
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import plistlib
import tarfile

TOOLCHAIN = "Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr"
SDK = "Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk"
VERSION = "Contents/version.plist"
LICENSES = ["Contents/Resources/en.lproj/License.rtf", "Contents/Resources/en.lproj/License.pdf", "Contents/Resources/LicenseInfo.plist"]
TOOLS = {"clang": "clang", "clangxx": "clang++", "ld": "ld", "ar": "ar", "ranlib": "ranlib", "nm": "nm", "strip": "strip", "objdump": "objdump"}
SWIFT_TOOLS = {"swiftc": "swiftc", "frontend": "swift-frontend", "plugin_server": "swift-plugin-server", "driver": "swift-driver"}
SWIFT_RUNTIME_ROOTS = ["Contents/SharedFrameworks/llbuild.framework"]
SWIFT_RESOURCES = ["lib/swift/macosx", "lib/swift/host", "lib/swift/clang", "lib/swift/apinotes", "lib/swift/_InternalSwiftScan", "lib/swift/swiftToCxx", "share/swift"]
HELPERS = ["dsymutil", "lipo", "codesign_allocate", "install_name_tool", "libtool", "llvm-profdata"]


def export(source, archive, compiler, *, execution_cpu):
    if execution_cpu not in compiler.CPUS:
        raise ValueError("Compiler export requires an explicit native Darwin execution CPU")
    cpu = compiler.CPUS[execution_cpu]
    source, archive = Path(source).resolve(strict=True), Path(archive)
    loader = compiler.load_loader(Path(compiler.__file__).with_name("extract-sdk.py"))
    allowed = [source / TOOLCHAIN, source / SDK] + [source / value for value in LICENSES + SWIFT_RUNTIME_ROOTS]
    selected = {}
    def admitted(file):
        if not any(file == prefix or file.is_relative_to(prefix) for prefix in allowed):
            raise ValueError("Compiler export reads only the approved Apple compiler/SDK/license whitelist")
        physical = file.resolve(strict=True)
        if not any(physical == prefix or physical.is_relative_to(prefix) for prefix in allowed):
            raise ValueError("Compiler export alias escapes its Apple-supplied whitelist")
        return physical
    def select(file):
        # Normalize loader-relative traversal without dereferencing original aliases.
        file = Path(os.path.normpath(file))
        admitted(file)
        relative = str(file.relative_to(source))
        if relative in selected:
            return
        selected[relative] = file
        if file.is_symlink():
            select(file.resolve(strict=True))
        elif file.is_dir():
            for entry in sorted(os.scandir(file), key=lambda entry: entry.name):
                select(Path(entry.path))
        elif not file.is_file():
            raise ValueError("Unsupported Apple compiler export member")
    tools = {key: TOOLCHAIN + "/bin/" + name for key, name in TOOLS.items()}
    for value in [TOOLCHAIN + "/lib/clang", SDK] + [TOOLCHAIN + "/" + value for value in SWIFT_RESOURCES] + LICENSES:
        select(source / value)
    # Retain the actual tool aliases and their exact transitive dyld closure.
    for name in list(TOOLS.values()) + HELPERS + list(SWIFT_TOOLS.values()):
        executable = source / TOOLCHAIN / "bin" / name
        select(executable)
        pending, seen = [(executable, ())], set()
        while pending:
            file, inherited = pending.pop()
            identity = (file.resolve(), inherited)
            if identity in seen:
                continue
            seen.add(identity)
            select(file)
            image = loader.macho_image(file.read_bytes(), cpu)
            if image is None:
                raise ValueError("Selected Apple compiler member does not have its declared native Mach-O CPU")
            dependencies, rpaths = compiler.image_loads(image)
            search = tuple(dict.fromkeys([str(compiler.load_root(source, file, path, executable)) for path in rpaths] + list(inherited)))
            for dependency in dependencies:
                if compiler.system_library_path(dependency):
                    continue
                candidates = [Path(directory) / dependency.removeprefix("@rpath/") for directory in search] if dependency.startswith("@rpath/") else [compiler.load_root(source, file, dependency, executable)]
                resolved = compiler.resolve_runtime(source, dependency, candidates)
                if resolved is None:
                    continue
                admitted(resolved)
                loader.require_native_library(resolved, cpu)
                pending.append((resolved, search))
    request = {"execution_cpu": execution_cpu, "tools": tools, "sysroot": SDK, "resource_dir": TOOLCHAIN + "/lib/clang/21", "cxx_headers": SDK + "/usr/include/c++/v1", "licenses": LICENSES}
    swift_tools = {key: TOOLCHAIN + "/bin/" + name for key, name in SWIFT_TOOLS.items()}
    compiler.validate_closure(source, dict(request, tools=dict(tools, **swift_tools)), loader)
    if archive.exists():
        raise ValueError("Compiler qualification archive output already exists")
    archive.parent.mkdir(parents=True, exist_ok=True)
    with archive.open("xb") as output:
        with gzip.GzipFile(filename="", mode="wb", fileobj=output, mtime=0, compresslevel=6) as compressed:
            with tarfile.open(fileobj=compressed, mode="w", format=tarfile.PAX_FORMAT) as result:
                for relative, file in sorted(selected.items()):
                    metadata = result.gettarinfo(str(file), arcname="original/" + relative)
                    metadata.uid = metadata.gid = metadata.mtime = 0
                    metadata.uname = metadata.gname = ""
                    metadata.mode &= 0o777
                    metadata.pax_headers = {}
                    # Bazel consumes logical regular Files. Preserve each hard
                    # linked member's original bytes without archive-order lookup.
                    if metadata.islnk():
                        metadata.type = tarfile.REGTYPE
                        metadata.linkname = ""
                        metadata.size = file.stat().st_size
                    if metadata.isfile():
                        with file.open("rb") as content:
                            result.addfile(metadata, content)
                    else:
                        result.addfile(metadata)
    with archive.open("rb") as original:
        digest = hashlib.file_digest(original, "sha256").hexdigest()
    return dict(request, swift={"tools": swift_tools, "toolchain": TOOLCHAIN, "resources": SWIFT_RESOURCES}, source_bundle=str(source), archive={"path": str(archive), "sha256": digest, "size": archive.stat().st_size}, member_count=len(selected), source_authority="Apple publisher signature verified independently before export")


def source_release(source):
    """The bundle's own release identity; the pin names it so the export can be repeated."""
    with (Path(source).resolve(strict=True) / VERSION).open("rb") as file:
        version = plistlib.load(file)
    return {"product": "Xcode", "version": version["CFBundleShortVersionString"], "build": version["ProductBuildVersion"]}


def specification(result, release, compiler):
    """The checked-in pin: exported bytes by digest and size, and the release they came from.

    Local paths stay out of it. The archive is never published; every machine
    regenerates it from the same release and the digest decides whether it matches.
    """
    request = {key: result[key] for key in ("execution_cpu", "tools", "sysroot", "resource_dir", "cxx_headers", "licenses")}
    request["strip_prefix"] = "original"
    request["archive"] = {"sha256": result["archive"]["sha256"], "size": result["archive"]["size"]}
    request["source"] = release
    compiler.validate_request(request)
    return request


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-bundle", required=True)
    parser.add_argument("--execution-cpu", required=True, choices=("aarch64", "x86_64"))
    parser.add_argument("--archive", required=True)
    parser.add_argument("--compiler-extractor", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--specification-output")
    args = parser.parse_args()
    loaded = importlib.util.spec_from_file_location("compiler", args.compiler_extractor)
    compiler = importlib.util.module_from_spec(loaded)
    loaded.loader.exec_module(compiler)
    result = export(args.source_bundle, args.archive, compiler, execution_cpu=args.execution_cpu)
    Path(args.output).write_text(json.dumps(result, indent=2) + "\n")
    if args.specification_output:
        request = specification(result, source_release(args.source_bundle), compiler)
        Path(args.specification_output).write_text(json.dumps(request, indent=2) + "\n")
