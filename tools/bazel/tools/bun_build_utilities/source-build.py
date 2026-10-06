"""Build original Perl/NASM archives with declared compiler and process inputs."""

import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path, PurePosixPath
import shlex
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile


def declared_tool(value, files, execroot):
    if value not in files:
        raise ValueError("Build tool is not an original File in its declared toolchain")
    path = Path(value)
    if not path.is_absolute():
        path = execroot / path
    if not path.is_file() or not path.stat().st_mode & 0o111:
        raise ValueError("Declared build tool is missing or not executable")
    return path


def absolute_flags(flags, execroot):
    result = []
    for flag in flags:
        for prefix in ("", "-I", "-L", "--sysroot=", "--ld-path=", "-fuse-ld=", "-resource-dir="):
            suffix = flag.removeprefix(prefix)
            if suffix.startswith(("external/", "bazel-out/")):
                flag = prefix + str(execroot / suffix)
                break
        result.append(flag)
    return result


def extract_source(archive, expected, output):
    data = archive.read_bytes()
    if hashlib.sha256(data).hexdigest() != expected["sha256"]:
        raise ValueError("Original utility source archive differs from its declared pin")
    members = {}
    with tarfile.open(fileobj=io.BytesIO(data)) as source:
        for member in source:
            logical = PurePosixPath(member.name)
            if logical.is_absolute() or ".." in logical.parts or not logical.parts:
                raise ValueError("Original utility source archive has an unsafe member")
            if logical.parts[0] != expected["strip_prefix"]:
                raise ValueError("Original utility source archive has a foreign source root")
            relative = PurePosixPath(*logical.parts[1:])
            if str(relative) == ".":
                if not member.isdir():
                    raise ValueError("Original utility archive root is not a directory")
                continue
            if relative in members:
                raise ValueError("Original utility source has duplicate canonical members")
            if not member.isfile() and not member.isdir():
                raise ValueError("Original utility source has a nonordinary member")
            members[relative] = member
        output.mkdir()
        for relative, member in members.items():
            target = output / str(relative)
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True)
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            stream = source.extractfile(member)
            if stream is None:
                raise ValueError("Original utility source member has no bytes")
            with target.open("xb") as destination:
                shutil.copyfileobj(stream, destination)
            target.chmod(member.mode & 0o777)
            os.utime(target, (member.mtime, member.mtime))


def output_identity(output):
    try:
        info = output.lstat()
    except FileNotFoundError:
        return None
    if not stat.S_ISDIR(info.st_mode) or any(output.iterdir()):
        raise ValueError("Utility output must be absent or an ordinary empty TreeArtifact")
    return info.st_dev, info.st_ino


def check_invocation(binary, kind, environment, directory):
    if kind == "perl":
        result = subprocess.run([binary, "-e", 'use strict; use warnings; use bigint; use Getopt::Long; use Config; die "bigint" unless 2**64 == 18446744073709551616; print $^V, "\\n", $Config{archname}, "\\n";'],
                                env=environment, cwd=directory, check=True, capture_output=True, text=True)
        if not result.stdout.startswith("v5.44.0\n"):
            raise ValueError("Source-built Perl has a foreign version/resource closure")
    elif kind == "nasm":
        result = subprocess.run([binary, "-v"], env=environment, cwd=directory,
                                check=True, capture_output=True, text=True)
        if not result.stdout.startswith("NASM version 3.02 "):
            raise ValueError("Source-built NASM has a foreign version")
        assembly = directory / "closure.asm"
        include = directory / "closure.inc"
        include.write_text("%define VALUE 42\n")
        assembly.write_text('%include "closure.inc"\nbits 64\ndb VALUE\n')
        subprocess.run([binary, "-fbin", "-MD", "closure.d", "-o", "closure.bin", "closure.asm"],
                       env=environment, cwd=directory, check=True)
        if (directory / "closure.bin").read_bytes() != bytes([42]) or "closure.inc" not in (directory / "closure.d").read_text():
            raise ValueError("NASM did not preserve Bun's assembler/depfile closure")
        assembly.write_text('%include "closure.inc"\nbits 64\nsection .text\nglobal closure\nclosure: mov eax, VALUE\nvpmulld ymm0, ymm1, ymm2\nret\n')
        for output_format, magic in [("macho64", bytes.fromhex("cffaedfe")), ("elf64", b"\x7fELF")]:
            member = directory / ("closure." + output_format)
            subprocess.run([binary, "-f" + output_format, "-o", member, assembly],
                           env=environment, cwd=directory, check=True)
            if not member.read_bytes().startswith(magic):
                raise ValueError("NASM did not emit Bun's selected x64 object format")
    else:
        raise ValueError("Unknown original Bun build utility")


def build(specification, execroot):
    kind = specification["kind"]
    if kind not in ("perl", "nasm", "bash"):
        raise ValueError("Unknown original Bun build utility")
    cc = declared_tool(specification["cc"], specification["compiler_files"], execroot)
    ar = declared_tool(specification["ar"], specification["compiler_files"], execroot)
    ranlib = declared_tool(specification["ranlib"], specification["compiler_files"], execroot)
    shell = declared_tool(specification["shell"], specification["shell_files"], execroot)
    make = declared_tool(specification["make"], specification["make_files"], execroot)
    git = declared_tool(specification["git"], specification["git_files"], execroot)
    sdk = execroot / specification["sdk"]
    make_sdk = execroot / specification["make_sdk"]
    output = execroot / specification["runtime"]
    binary = execroot / specification["binary"]
    original_output = output_identity(output)
    if binary.exists() or binary.is_symlink():
        raise ValueError("Utility executable output already exists")
    with tempfile.TemporaryDirectory(prefix="declared-bun-utility-", dir=output.parent) as temporary:
        work = Path(temporary)
        source = work / "source"
        pin = json.loads((execroot / specification["pins"]).read_text())[kind]
        extract_source(execroot / specification["archive"], pin, source)
        home = work / "home"
        home.mkdir()
        environment = {"HOME": str(home), "TMPDIR": str(work), "PATH": os.pathsep.join([str(make_sdk / "bin"), str(sdk / "bin"), str(cc.parent), str(ar.parent)]),
                       "SHELL": str(shell), "CONFIG_SHELL": str(shell), "LC_ALL": "C", "TZ": "UTC",
                       "SOURCE_DATE_EPOCH": "0", "ZERO_AR_DATE": "1"}
        for key, value in specification["environment"].items():
            if key == "PATH":
                directories = value.split(os.pathsep)
                if any(not item.startswith(("external/", "bazel-out/")) for item in directories):
                    raise ValueError("Compiler PATH names an undeclared directory")
                environment["PATH"] += os.pathsep + os.pathsep.join(str(execroot / item) for item in directories)
            else:
                environment[key] = str(execroot / value) if value.startswith(("external/", "bazel-out/")) else value
        environment.pop("DYLD_LIBRARY_PATH", None)
        environment.update({"GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": os.devnull, "GIT_CEILING_DIRECTORIES": str(work)})
        libraries = os.pathsep.join([str(sdk / "lib"), str(make_sdk / "lib")])
        environment["DYLD_FALLBACK_LIBRARY_PATH" if sys.platform == "darwin" else "LD_LIBRARY_PATH"] = libraries
        cflags = absolute_flags(specification["compile_flags"], execroot) + ["-O2", "-ffile-prefix-map=" + str(work) + "=/declared-bun-utility", "-ffile-prefix-map=" + str(execroot) + "=/declared-action"]
        ldflags = absolute_flags(specification["link_flags"], execroot)
        environment.update({"CC": str(cc), "AR": str(ar), "RANLIB": str(ranlib), "CFLAGS": shlex.join(cflags), "LDFLAGS": shlex.join(ldflags)})
        if kind == "bash":
            environment["CXXFLAGS"] = shlex.join(absolute_flags(specification["cxx_flags"], execroot) + ["-O2", "-ffile-prefix-map=" + str(work) + "=/declared-bun-utility", "-ffile-prefix-map=" + str(execroot) + "=/declared-action"])
            helper = importlib.util.spec_from_file_location("declared_bash_builder", execroot / specification["bash_builder"])
            if helper is None or helper.loader is None:
                raise ValueError("Missing declared Bash source builder")
            module = importlib.util.module_from_spec(helper)
            helper.loader.exec_module(module)
            module.build(specification, execroot, source, work, environment, shell, make, git, extract_source)
            if output_identity(output) != original_output:
                raise ValueError("Utility output changed while original sources compiled")
            shutil.copytree(work / "bash-runtime", output, symlinks=False, dirs_exist_ok=original_output is not None)
            binary.parent.mkdir(parents=True, exist_ok=True)
            binary.symlink_to(os.path.relpath(output / "bin/bash", binary.parent))
            module.check_runtime(output, work)
            return
        subprocess.run([git, "apply", "--check", str(execroot / specification["patch"])], env=environment, cwd=source, check=True)
        subprocess.run([git, "apply", str(execroot / specification["patch"])], env=environment, cwd=source, check=True)
        prefix = "/declared-" + kind
        if kind == "perl":
            configure = [shell, "Configure", "-des", "-Dprefix=" + prefix, "-Duserelocatableinc", "-Dcc=" + str(cc), "-Dld=" + str(cc),
                         "-Dar=" + str(ar), "-Dranlib=" + str(ranlib), "-Dmake=" + str(make), "-Dsh=" + str(shell), "-Dstartsh=#!" + str(shell),
                         "-Dccflags=" + shlex.join(cflags), "-Dldflags=" + shlex.join(ldflags)]
        else:
            perl = declared_tool(specification["perl"], specification["perl_files"], execroot)
            environment["PERL"] = str(perl)
            configure = [shell, "configure", "--prefix=" + prefix]
        subprocess.run(configure, env=environment, cwd=source, check=True)
        command = [make, "SHELL=" + str(shell)]
        if kind == "nasm":
            command.append("PERL=" + str(perl))
        subprocess.run(command + ["-j2"], env=environment, cwd=source, check=True)
        destination = work / "install"
        if kind == "perl":
            install = command + ["install", "DESTDIR=" + str(destination)]
        else:
            install = command + ["install", "INSTALLROOT=" + str(destination), "DESTDIR=" + str(destination)]
        subprocess.run(install, env=environment, cwd=source, check=True)
        installed = destination / prefix.lstrip("/")
        emitted = installed / "bin" / kind
        if not emitted.is_file():
            raise ValueError("Original source install did not produce the declared executable")
        check_invocation(emitted, kind, environment, work)
        if output_identity(output) != original_output:
            raise ValueError("Utility output changed while original sources compiled")
        shutil.copytree(installed, output, symlinks=False, dirs_exist_ok=original_output is not None)
        license_directory = output / "share" / kind
        license_directory.mkdir(parents=True, exist_ok=True)
        for name in (["Copying", "Artistic"] if kind == "perl" else ["LICENSE"]):
            shutil.copyfile(source / name, license_directory / name)
    binary.parent.mkdir(parents=True, exist_ok=True)
    binary.symlink_to(os.path.relpath(output / "bin" / kind, binary.parent))
    environment["PATH"] = str(output / "bin")
    environment["DYLD_FALLBACK_LIBRARY_PATH" if sys.platform == "darwin" else "LD_LIBRARY_PATH"] = str(output / "lib")
    with tempfile.TemporaryDirectory(prefix="declared-bun-utility-control-") as temporary:
        check_invocation(binary, kind, environment, Path(temporary))


if __name__ == "__main__":
    build(json.loads(Path(sys.argv[1]).read_text()), Path.cwd())
