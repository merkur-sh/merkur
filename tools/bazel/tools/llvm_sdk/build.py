"""Build original LLVM21.1.8 clang/lld through declared native CMake inputs."""
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path, PurePosixPath
import platform
import re
import shlex
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile

VERSION = "21.1.8"
SHA256 = "4633a23617fa31a3ea51242586ea7fb1da7140e426bd62fc164261fe036aa142"
PREFIX = "llvm-project-21.1.8.src"
TOOLS = ["clang", "clang++", "llvm-ar", "llvm-ranlib", "llvm-nm", "llvm-strip", "dsymutil", "ld.lld", "ld64.lld", "llvm-profdata"]


def fact(path):
    data = Path(path).read_bytes()
    return {"path": str(path), "size": len(data), "sha256": hashlib.sha256(data).hexdigest()}


def input_facts(root, inputs):
    result = {}
    declared = {}
    for entry in inputs:
        if set(entry) != {"path", "kind"} or entry["kind"] not in {"file", "tree", "symlink"} or entry["path"] in declared:
            raise ValueError("LLVM input must have a unique declared File type")
        declared[entry["path"]] = entry["kind"]
    for name, kind in sorted(declared.items()):
        path = root / name
        # Unresolved symlink Artifacts are checked by readlink, just as Bazel
        # checks them. Their original directory aliases are not TreeArtifacts.
        if kind == "symlink":
            target = os.readlink(path)
            data = os.fsencode(target)
            result[str(path)] = {"path": str(path), "kind": kind, "target": target,
                                 "size": len(data), "sha256": hashlib.sha256(data).hexdigest()}
            continue
        if kind == "tree" and not path.is_dir():
            raise ValueError("LLVM declared TreeArtifact is not a directory")
        tree = path.resolve(strict=True) if kind == "tree" else None
        members = sorted(path.rglob("*")) if tree is not None else [path]
        for member in members:
            if member.is_dir():
                if tree is None:
                    raise ValueError("LLVM declared regular File is a directory")
                if member.is_symlink():
                    raise ValueError("LLVM input TreeArtifact has an aliased directory")
                continue
            if not member.is_file():
                raise ValueError("LLVM input contains an unsupported File")
            if tree is not None and not member.resolve(strict=True).is_relative_to(tree):
                raise ValueError("LLVM input TreeArtifact member escaped its declared root")
            if str(member) in result:
                continue
            result[str(member)] = fact(member)
    return list(result.values())


def extract_original(archive, destination):
    data = Path(archive).read_bytes()
    if hashlib.sha256(data).hexdigest() != SHA256:
        raise ValueError("LLVM bootstrap requires the original21.1.8 source archive")
    extract(data, destination)
    return destination / PREFIX, {"size": len(data), "sha256": SHA256}


def extract(data, destination):
    """Validate original archive topology before creating any source files."""
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:xz") as source:
        seen = set()
        for member in source.getmembers():
            name = PurePosixPath(member.name)
            if not name.parts or name.is_absolute() or ".." in name.parts or str(name) != member.name.rstrip("/") or name.parts[0] != PREFIX or str(name) in seen:
                raise ValueError("Noncanonical or duplicate original LLVM source member")
            if not (member.isfile() or member.isdir() or member.issym() or member.islnk()):
                raise ValueError("Unsupported original LLVM source entry")
            seen.add(str(name))
        # The original archive digest, not an installed directory hash, is the
        # source authority. Python's data filter also confines original links.
        source.extractall(destination, filter="data")


def validate(specification):
    if specification["version"] != VERSION or specification["projects"] != ["clang", "lld"]:
        raise ValueError("LLVMSDK requires the exact Bun LLVM21.1.8 clang/lld selection")
    if set(specification["tools"]) != set(TOOLS):
        raise ValueError("LLVMSDK must declare every original Bun LLVM tool output")
    for name in ["cc", "cxx", "ar", "ranlib", "cmake", "make_driver", "make", "shell", "git", "python", "uname"]:
        if not specification.get(name):
            raise ValueError("LLVMSDK requires mandatory declared tool: " + name)
    if specification["platform"] not in ["darwin_arm64", "darwin_x64", "linux_arm64", "linux_x64"]:
        raise ValueError("Unsupported native LLVMSDK platform")


def native_platform():
    systems = {"Darwin": "darwin", "Linux": "linux"}
    cpus = {"arm64": "arm64", "aarch64": "arm64", "x86_64": "x64", "AMD64": "x64"}
    try:
        return systems[platform.system()] + "_" + cpus[platform.machine()]
    except KeyError as error:
        raise ValueError("LLVM source build requires an original supported native executor") from error


def configuration(specification, source, build, install, environment, flags):
    toolchain = build / "toolchain.cmake"
    values = {
        "CMAKE_C_COMPILER": flags["cc"], "CMAKE_CXX_COMPILER": flags["cxx"],
        "CMAKE_AR": flags["ar"], "CMAKE_RANLIB": flags["ranlib"],
        "CMAKE_C_FLAGS_INIT": shlex.join(flags["compile_flags"]),
        "CMAKE_CXX_FLAGS_INIT": shlex.join(flags["cxx_flags"]),
        "CMAKE_EXE_LINKER_FLAGS_INIT": shlex.join(flags["link_flags"]),
        "CMAKE_SHARED_LINKER_FLAGS_INIT": shlex.join(flags["link_flags"]),
        # LLVM's optional dependencies may only be found in declared SDK roots.
        # This preserves upstream option defaults without host package discovery.
        "CMAKE_FIND_ROOT_PATH": environment.get("SDKROOT", "") + ";" + flags["sdk"] + ";" + flags["make_sdk"],
        "CMAKE_FIND_ROOT_PATH_MODE_PROGRAM": "ONLY",
        "CMAKE_FIND_ROOT_PATH_MODE_LIBRARY": "ONLY",
        "CMAKE_FIND_ROOT_PATH_MODE_INCLUDE": "ONLY",
        "CMAKE_FIND_ROOT_PATH_MODE_PACKAGE": "ONLY",
        "CMAKE_FIND_USE_SYSTEM_ENVIRONMENT_PATH": "FALSE",
        "CMAKE_FIND_USE_CMAKE_SYSTEM_PATH": "FALSE",
        "CMAKE_FIND_USE_PACKAGE_REGISTRY": "FALSE",
        "CMAKE_FIND_USE_SYSTEM_PACKAGE_REGISTRY": "FALSE",
    }
    if specification["platform"].startswith("darwin"):
        if not environment.get("SDKROOT"):
            raise ValueError("LLVMSDK Darwin build requires declared Apple SDKROOT")
        values["CMAKE_OSX_SYSROOT"] = environment["SDKROOT"]
    def quote(value):
        return '"' + str(value).replace("\\", "/").replace('"', '\\"') + '"'
    contents = "\n".join("set(" + name + " " + quote(value) + ")" for name, value in values.items()) + "\n"
    # The Unix Makefiles generator forwards the cache entry into try_compile;
    # a normal toolchain variable is absent from its initial build command.
    contents += "set(CMAKE_MAKE_PROGRAM " + quote(flags["make_driver"]) + " CACHE FILEPATH \"declared Make driver\")\n"
    command = [flags["cmake"], "-S", str(source / "llvm"), "-B", str(build), "-G", "Unix Makefiles",
               "-DCMAKE_TOOLCHAIN_FILE=" + str(toolchain), "-DCMAKE_UNAME:FILEPATH=" + flags["uname"],
               "-DCMAKE_BUILD_TYPE=Release", "-DCMAKE_INSTALL_PREFIX=" + str(install),
               "-DLLVM_ENABLE_PROJECTS=clang;lld", "-DPython3_EXECUTABLE=" + flags["python"],
               "-DPYTHON_EXECUTABLE=" + flags["python"], "-DGIT_EXECUTABLE=" + flags["git"]]
    return toolchain, contents, command


def build(specification):
    validate(specification)
    if native_platform() != specification["platform"]:
        raise ValueError("LLVM native executor differs from its configured SDK platform")
    root = Path.cwd()
    declared = {str(root / entry["path"]) for entry in specification["inputs"]}
    paths = {name: str(root / specification[name]) for name in ["cc", "cxx", "ar", "ranlib", "cmake", "make_driver", "make", "shell", "git", "python", "uname"]}
    if any(path not in declared or not Path(path).is_file() for path in paths.values()):
        raise ValueError("LLVM build tool is absent from its declared File closure")
    before_inputs = input_facts(root, specification["inputs"])
    runtime = root / specification["runtime"]
    if runtime.exists() and (runtime.is_symlink() or not runtime.is_dir() or any(runtime.iterdir())):
        raise ValueError("LLVMSDK output must be absent or an empty ordinary TreeArtifact")
    if any((root / path).exists() or (root / path).is_symlink() for path in specification["tools"].values()):
        raise ValueError("LLVMSDK executable outputs must be absent")
    helper_spec = importlib.util.spec_from_file_location("native_cmake", root / specification["helper"])
    helper = importlib.util.module_from_spec(helper_spec)
    helper_spec.loader.exec_module(helper)
    with tempfile.TemporaryDirectory(prefix="merkur-llvm-source-") as temporary:
        private = Path(temporary)
        source, archive_fact = extract_original(root / specification["archive"], private)
        directory = private / "build"
        directory.mkdir()
        install = private / "install"
        home = private / "home"
        home.mkdir()
        environment = {key: str(root / value) if value.startswith(("external/", "bazel-out/")) else value for key, value in specification["environment"].items()}
        sdk = root / specification["sdk"]
        make_sdk = root / specification["make_sdk"]
        environment.update({"HOME": str(home), "TMPDIR": str(private), "PATH": os.pathsep.join([str(sdk / "bin"), str(make_sdk / "bin")]),
                            "SHELL": paths["shell"], "CONFIG_SHELL": paths["shell"],
                            "MERKUR_CMAKE_MAKE_EXECUTABLE": paths["make"], "MERKUR_CMAKE_SHELL": paths["shell"],
                            "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": os.devnull,
                            "LC_ALL": "C", "SOURCE_DATE_EPOCH": "0", "ZERO_AR_DATE": "1"})
        environment["DYLD_FALLBACK_LIBRARY_PATH" if sys.platform == "darwin" else "LD_LIBRARY_PATH"] = os.pathsep.join([str(sdk / "lib"), str(make_sdk / "lib"), str(Path(paths["cmake"]).resolve().parent.parent / "lib")])
        flags = {**paths, "sdk": str(sdk), "make_sdk": str(make_sdk), **{name: helper.absolute_flags(specification[name], root) for name in ["compile_flags", "cxx_flags", "link_flags"]}}
        mappings = ["-ffile-prefix-map=" + str(private) + "=/merkur-llvm-source", "-fdebug-prefix-map=" + str(private) + "=/merkur-llvm-source", "-ffile-prefix-map=" + str(root) + "=/merkur-action", "-fdebug-prefix-map=" + str(root) + "=/merkur-action"]
        flags["compile_flags"] += mappings
        flags["cxx_flags"] += mappings
        toolchain, contents, command = configuration(specification, source, directory, install, environment, flags)
        toolchain.write_text(contents)
        for arguments in [command, [paths["cmake"], "--build", str(directory), "--parallel", "4"], [paths["cmake"], "--install", str(directory)]]:
            subprocess.run(arguments, cwd=directory, env=environment, check=True)
        required = {name: install / "bin" / name for name in TOOLS}
        if any(not path.is_file() or not os.access(path, os.X_OK) for path in required.values()) or not (install / "lib/clang/21/include/stddef.h").is_file():
            raise ValueError("LLVM installation omitted an original required tool or resource header")
        # Retain complete adjacent LLVM headers/libraries and the declared
        # library dependencies available to LLVM's own CMake configuration.
        licenses = install / "licenses"
        licenses.mkdir()
        for project in ["llvm", "clang", "lld"]:
            shutil.copyfile(source / project / "LICENSE.TXT", licenses / (project + "-LICENSE.TXT"))
        for dependency in [sdk / "lib", make_sdk / "lib"]:
            if dependency.is_dir():
                for entry in dependency.iterdir():
                    target = install / "lib" / entry.name
                    if not target.exists() and not target.is_symlink():
                        if entry.is_dir():
                            shutil.copytree(entry, target, symlinks=False)
                        else:
                            shutil.copyfile(entry, target)
        for member in install.rglob("*"):
            if member.is_symlink() and not member.resolve(strict=True).is_relative_to(install.resolve(strict=True)):
                raise ValueError("LLVM installed member escaped its declared SDK")
        version = subprocess.run([str(install / "bin/clang"), "--version"], env=environment, check=True, capture_output=True, text=True).stdout
        if re.search(r"\bclang version " + re.escape(VERSION) + r"(?:\s|$)", version) is None:
            raise ValueError("LLVM installation did not produce the original required clang21.1.8")
        after_inputs = input_facts(root, specification["inputs"])
        if after_inputs != before_inputs:
            raise ValueError("LLVM declared source/tool inputs changed during compilation")
        if runtime.exists():
            runtime.rmdir()
        shutil.copytree(install, runtime, symlinks=True)
        artifacts = {}
        for name, output in specification["tools"].items():
            member = runtime / "bin" / name
            physical = member.resolve(strict=True)
            if not physical.is_relative_to(runtime.resolve(strict=True)):
                raise ValueError("LLVM installed tool alias escaped its declared SDK")
            output = root / output
            output.parent.mkdir(parents=True, exist_ok=True)
            output.symlink_to(os.path.relpath(member, output.parent))
            artifacts[name] = fact(physical)
        def logical(value):
            return value.replace(str(private), "/merkur-llvm-source").replace(str(root), "/merkur-action")
        manifest = {"version": VERSION, "original_source": archive_fact, "projects": specification["projects"],
                    "platform": specification["platform"], "configure": [logical(value) for value in command], "toolchain": logical(contents),
                    "inputs": [{**value, "path": logical(value["path"])} for value in before_inputs],
                    "contents": [{**fact(path), "path": str(path.relative_to(runtime))} for path in sorted(runtime.rglob("*")) if path.is_file()],
                    "artifacts": {name: {**value, "path": str(Path(value["path"]).relative_to(runtime))} for name, value in artifacts.items()},
                    "licenses": [{**fact(runtime / "licenses" / (project + "-LICENSE.TXT")), "path": "licenses/" + project + "-LICENSE.TXT"} for project in ["llvm", "clang", "lld"]]}
        (root / specification["manifest"]).write_text(json.dumps(manifest, indent=2) + "\n")


if __name__ == "__main__":
    build(json.loads(Path(sys.argv[1]).read_text()))
