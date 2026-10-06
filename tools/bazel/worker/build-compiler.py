#!/usr/bin/env python3
"""Execute the pinned upstream compiler bootstrap with declared native tools."""

import argparse
import copy
import json
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile


HOST = "aarch64-apple-darwin"
SELECTORS = ["compiler/rustc", "library", "src/tools/rustdoc"]


def absolute(value):
    return str(pathlib.Path(value).absolute())


def toml_value(value):
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, list):
        return "[" + ", ".join(toml_value(item) for item in value) + "]"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, str):
        return json.dumps(value)
    raise ValueError("Unsupported bootstrap TOML value")


def write_toml(configuration, path):
    lines = []
    for section, entries in configuration.items():
        lines.append("[" + section + "]")
        lines.extend(key + " = " + toml_value(value) for key, value in entries.items())
    path.write_text("\n".join(lines) + "\n")


def adapter(path, python, command, environment):
    # Native arguments and environment are literal data from CcToolchainInfo.
    # The bootstrap calls these adapters by absolute path, including Cargo's
    # early stage0 linker invocation; PATH never selects an ambient compiler.
    path.write_text("#!" + python + "\nimport os,sys\n" +
                    "os.environ.update(" + repr(environment) + ")\n" +
                    "os.execv(" + repr(command[0]) + ", " + repr(command) + " + sys.argv[1:])\n")
    path.chmod(0o755)


def native_command(specification, declared, sysroot):
    tool = absolute(specification["tool"])
    if tool not in declared or not pathlib.Path(tool).is_file():
        raise ValueError("Bootstrap native executable is not a declared regular File")
    flags = []
    for value in specification["flags"]:
        # Cc action argv is rooted at the Bazel execroot. Upstream bootstrap
        # changes cwd to its private source tree, including when Cargo invokes
        # this linker. Preserve both standalone and joined native path options.
        option, separator, argument = value.partition("=")
        path = argument if separator else value
        if path == sysroot or path.startswith(("external/", "bazel-out/")):
            rooted = absolute(path)
            if not pathlib.Path(rooted).exists():
                raise ValueError("Native toolchain flag path is absent from the declared action")
            value = option + separator + rooted if separator else rooted
        flags.append(value)
    environment = dict(specification["environment"])
    if "SDKROOT" in environment:
        environment["SDKROOT"] = absolute(environment["SDKROOT"])
    if "PATH" in environment:
        environment["PATH"] = os.pathsep.join(absolute(value) for value in environment["PATH"].split(os.pathsep))
    return [tool, *flags], environment


def build(request, output, log):
    manifest = json.loads(pathlib.Path(request["configuration"]).read_text())
    recipe = manifest["bootstrap"]
    if recipe["stage"] != 1 or recipe["selectors"] != SELECTORS or manifest["host"] != HOST:
        raise ValueError("Compiler build requires the original stage1 host and selectors")
    if manifest["compiler_built"] or manifest["rustdoc_built"] or manifest["qualified"]:
        raise ValueError("Compiler build requires original materialized bootstrap inputs")
    if set(request["native"]) != {"cc", "cxx", "linker", "ar", "ranlib"}:
        raise ValueError("Compiler bootstrap requires complete explicit native tools")
    declared = {absolute(value) for value in request["native_files"]}
    native = {name: native_command(value, declared, request["sysroot"]) for name, value in request["native"].items()}
    utilities = {name: absolute(value) for name, value in request["tools"].items()}
    if not {"sh", "make", "git", "cmake"}.issubset(utilities) or not all(pathlib.Path(value).is_file() for value in utilities.values()):
        raise ValueError("Compiler bootstrap requires declared shell/make/Git/CMake utilities")
    if output.is_symlink() or (output.exists() and (not output.is_dir() or any(output.iterdir()))):
        raise ValueError("Compiler output must be new")
    # Bazel creates an empty declared TreeArtifact root before execution.
    # Preserve refusal for every occupied destination, then publish only after
    # the genuine driver and required stage1 outputs have succeeded.
    if output.exists():
        output.rmdir()
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".compiler-build-", dir=output.parent) as scratch:
        scratch = pathlib.Path(scratch).absolute()
        source = scratch / "source"
        shutil.copytree(pathlib.Path(request["sources"]), source)
        home = scratch / "home"
        home.mkdir()
        adapters = scratch / "bin"
        adapters.mkdir()
        python = absolute(request["python"])
        for name, (command, environment) in native.items():
            adapter(adapters / name, python, command, environment)
        for name, command in utilities.items():
            (adapters / name).symlink_to(command)
        settings = copy.deepcopy(recipe)
        settings["build"].update({"build-dir": str(scratch / "build"), "python": python})
        for name in ["rustc", "cargo", "rustdoc"]:
            settings["build"][name] = absolute(settings["build"][name])
        target = settings["target"][HOST]
        target["llvm-config"] = absolute(target["llvm-config"])
        target.update({name: str(adapters / name) for name in native})
        configuration = scratch / "bootstrap.toml"
        # The original Python bootstrap's section reader compares the literal
        # target header; quoted headers work in TOML but hide the early linker.
        write_toml({"build": settings["build"], "rust": settings["rust"], "llvm": settings["llvm"], "target." + HOST: target}, configuration)
        environment = {
            "PATH": str(adapters), "HOME": str(home), "CARGO_HOME": str(home / "cargo"),
            "TMPDIR": str(scratch), "CARGO_NET_OFFLINE": "true", "CARGO_INCREMENTAL": "0",
            "SDKROOT": absolute(request["sysroot"]), "SHELL": utilities["sh"],
            "CONFIG_SHELL": utilities["sh"], "MAKE": utilities["make"],
            "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null",
            "PYTHONNOUSERSITE": "1",
        }
        # Original SDK libraries satisfy build-prefix install names only; never
        # override absolute Apple framework/library identities.
        sdk_libraries = sorted({str(pathlib.Path(value).parent.parent / "lib") for value in utilities.values()})
        environment["DYLD_FALLBACK_LIBRARY_PATH"] = os.pathsep.join(sdk_libraries)
        with log.open("w") as stream:
            completed = subprocess.run([python, "-B", "-I", str(source / "x.py"), "build", "--config", str(configuration), "--stage", "1", *SELECTORS], cwd=source, env=environment, stdout=stream, stderr=subprocess.STDOUT)
        if completed.returncode:
            sys.stderr.write(log.read_text())
            raise RuntimeError("Original compiler bootstrap failed with exit " + str(completed.returncode) + "; see " + str(log))
        stage1 = scratch / "build" / HOST / "stage1"
        for required in ["bin/rustc", "bin/rustdoc"]:
            path = stage1 / required
            if not path.is_file() or not path.stat().st_size or not os.access(path, os.X_OK):
                raise ValueError("Successful bootstrap omitted executable stage1 File: " + required)
        library = stage1 / "lib/rustlib" / HOST / "lib"
        if not library.is_dir() or not any(path.is_file() and path.stat().st_size for path in library.glob("*.rlib")):
            raise ValueError("Successful bootstrap omitted stage1 standard-library rlibs")
        shutil.copytree(stage1, output)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--request", type=pathlib.Path, required=True)
    parser.add_argument("--output", type=pathlib.Path, required=True)
    parser.add_argument("--log", type=pathlib.Path, required=True)
    args = parser.parse_args()
    build(json.loads(args.request.read_text()), args.output.absolute(), args.log.absolute())
