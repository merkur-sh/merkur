"""Run unchanged Git's Makefile using only declared compiler and utility inputs."""
import json
import os
from pathlib import Path
import shlex
import shutil
import stat
import subprocess
import sys
import tempfile


def output_directory_identity(output):
    try:
        identity = output.lstat()
    except FileNotFoundError:
        return None
    if not stat.S_ISDIR(identity.st_mode) or any(output.iterdir()):
        raise ValueError("Git source build runtime output must be an empty ordinary directory")
    return identity.st_dev, identity.st_ino


def absolute_tool(value, execroot):
    if not value:
        raise ValueError("Git source build requires its declared compiler tool")
    result = Path(value)
    if not result.is_absolute():
        result = execroot / result
    if not result.is_file() or not result.stat().st_mode & 0o111:
        raise ValueError("Git source build compiler tool is not executable")
    return str(result)


def absolute_flags(flags, execroot):
    result = []
    for flag in flags:
        converted = flag
        for prefix in ["", "-I", "-L", "--sysroot=", "-isystem", "-fuse-ld=", "--ld-path=", "-resource-dir="]:
            suffix = flag.removeprefix(prefix)
            if suffix.startswith(("external/", "bazel-out/")):
                converted = prefix + str(execroot / suffix)
                break
        result.append(converted)
    return result


def build(specification, execroot):
    sdk = (execroot / specification["sdk"]).resolve()
    make_sdk = (execroot / specification["make_sdk"]).resolve()
    make = absolute_tool(specification["make"], execroot)
    compiler = absolute_tool(specification["cc"], execroot)
    archiver = absolute_tool(specification["ar"], execroot)
    ranlib = absolute_tool(specification["ranlib"], execroot)
    output = execroot / specification["runtime"]
    binaries = {name: execroot / value for name, value in specification["binaries"].items()}
    output_identity = output_directory_identity(output)
    if any(file.exists() or file.is_symlink() for file in binaries.values()):
        raise ValueError("Git source build outputs must be absent")
    # Temporary source and compiler outputs are private to this one action.
    with tempfile.TemporaryDirectory(prefix="declared-git-") as temporary:
        work = Path(temporary)
        source = work / "source"
        source.mkdir()
        for item in specification["source"]:
            relative = Path(item["relative"])
            if relative.is_absolute() or ".." in relative.parts:
                raise ValueError("Git source member escapes its declared source tree")
            target = source / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(execroot / item["path"], target)
        home = work / "home"
        home.mkdir()
        # Package build-prefix libraries resolve only in the declared SDKs. Keep
        # absolute Apple OS libraries ahead of them: overriding libiconv.2.dylib
        # with GNU libiconv removes Bash's Apple iconv_open entry point.
        environment = {"HOME": str(home), "TMPDIR": str(work), "PATH": os.pathsep.join([str(sdk / "bin"), str(make_sdk / "bin"), str(Path(compiler).parent), str(Path(archiver).parent)]), "LC_ALL": "C", "TZ": "UTC", "SOURCE_DATE_EPOCH": "0", "ZERO_AR_DATE": "1", "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": os.devnull, "LD_LIBRARY_PATH": os.pathsep.join([str(sdk / "lib"), str(make_sdk / "lib")]), "DYLD_FALLBACK_LIBRARY_PATH": os.pathsep.join([str(sdk / "lib"), str(make_sdk / "lib")])}
        for key, value in specification["environment"].items():
            if key == "PATH":
                directories = value.split(os.pathsep)
                if any(not directory.startswith(("external/", "bazel-out/")) for directory in directories):
                    raise ValueError("Compiler PATH must name only declared SDK directories")
                environment["PATH"] += os.pathsep + os.pathsep.join(str(execroot / directory) for directory in directories)
                continue
            environment[key] = str(execroot / value) if value.startswith(("external/", "bazel-out/")) else value
        cflags = absolute_flags(specification["compile_flags"], execroot) + ["-O2", "-I" + str(sdk / "include"), "-ffile-prefix-map=" + str(work) + "=.", "-fdebug-prefix-map=" + str(work) + "=.", "-ffile-prefix-map=" + str(execroot) + "=/declared-execroot", "-fdebug-prefix-map=" + str(execroot) + "=/declared-execroot"]
        ldflags = absolute_flags(specification["link_flags"], execroot) + ["-L" + str(sdk / "lib")]
        # curl-config is an interpreted package script; invoke it through the
        # exact SDK shell rather than its package's /bin/sh interpreter.
        curl_config = sdk / "bin" / "curl-config"
        curl_command = shlex.join([str(sdk / "bin" / "sh"), str(curl_config)])
        # Git 2.56.0 supports its complete C implementation explicitly. This
        # verification utility binds that configuration to the CcToolchain.
        # Its loader environment resolves the declared SDK; do not embed an
        # action's temporary library directory in the executable's RPATH.
        arguments = [make, "-j1", "SHELL_PATH=sh", "NO_RUST=YesPlease", "CC_LD_DYNPATH=", "CC=" + shlex.quote(compiler), "AR=" + shlex.quote(archiver), "RANLIB=" + shlex.quote(ranlib), "CFLAGS=" + shlex.join(cflags), "LDFLAGS=" + shlex.join(ldflags), "CURLDIR=" + str(sdk), "CURL_CONFIG=" + curl_command, "CURL_LDFLAGS=-lcurl", "ZLIB_PATH=" + str(sdk), "EXPAT_PATH=" + str(sdk), "ICONV_PATH=" + str(sdk), "NO_GETTEXT=YesPlease", "NO_PERL=YesPlease", "NO_PYTHON=YesPlease", "NO_TCLTK=YesPlease", "RUNTIME_PREFIX=YesPlease", "prefix=/declared-git", "gitexecdir=libexec/git-core", "localedir=share/locale", "USE_LIBPCRE2=YesPlease", "LIBPCREDIR=" + str(sdk), "git", "git-remote-http", "git-http-fetch", "git-http-push"]
        subprocess.run(arguments, cwd=source, env=environment, check=True)
        subprocess.run([make, "-C", "templates", "SHELL_PATH=sh"], cwd=source, env=environment, check=True)
        compiled_git = str(source / "git")
        shell = subprocess.run([compiled_git, "var", "GIT_SHELL_PATH"], env=environment, check=True, capture_output=True, text=True)
        if shell.stdout.strip() != "sh":
            raise ValueError("Source-built Git did not bind its declared SDK shell")
        helper = "!printf 'username=declared-fixture\\npassword=declared-fixture\\n'"
        request = "protocol=https\nhost=example.invalid\n\n"
        environment["GIT_TERMINAL_PROMPT"] = "0"
        credential = subprocess.run([compiled_git, "-c", "credential.helper=" + helper, "credential", "fill"], input=request, env=environment, check=True, capture_output=True, text=True)
        if "username=declared-fixture" not in credential.stdout or "password=declared-fixture" not in credential.stdout:
            raise ValueError("Source-built Git did not execute the declared SDK shell helper")
        without_shell = dict(environment, PATH="/__no_ambient_git_shell__")
        missing_shell = subprocess.run([compiled_git, "-c", "credential.helper=" + helper, "credential", "fill"], input=request, env=without_shell, capture_output=True, text=True)
        if missing_shell.returncode == 0:
            raise ValueError("Source-built Git credential helper used an undeclared shell")
        if output_directory_identity(output) != output_identity:
            raise ValueError("Git source build runtime output identity changed during compilation")
        if any(file.exists() or file.is_symlink() for file in binaries.values()):
            raise ValueError("Git source build executable outputs changed during compilation")
        # Sandbox input aliases present declared Files; copying those aliases
        # would make the emitted SDK escape to its input tree. Materialize bytes.
        shutil.copytree(sdk, output, symlinks=False, dirs_exist_ok=output_identity is not None)
        (output / "libexec" / "git-core").mkdir(parents=True, exist_ok=True)
        shutil.copy2(source / "git", output / "bin" / "git")
        # Native fetch/push starts these standard Git server modes through the
        # declared SDK PATH. Each alias executes the newly compiled Git bytes.
        for name in ["git-upload-pack", "git-receive-pack", "git-upload-archive"]:
            for directory, target in [("bin", "git"), ("libexec/git-core", "../../bin/git")]:
                alias = output / directory / name
                if alias.exists() or alias.is_symlink():
                    alias.unlink()
                alias.symlink_to(target)
        for name in ["git-remote-http", "git-http-fetch", "git-http-push"]:
            shutil.copy2(source / name, output / "libexec" / "git-core" / name)
        https_alias = output / "libexec" / "git-core" / "git-remote-https"
        if https_alias.exists() or https_alias.is_symlink():
            https_alias.unlink()
        https_alias.symlink_to("git-remote-http")
        shutil.copytree(source / "templates" / "blt", output / "share" / "git-core" / "templates")
        shutil.copy2(source / "COPYING", output / "share" / "git-core" / "COPYING")
        for name, binary in binaries.items():
            binary.parent.mkdir(parents=True, exist_ok=True)
            # Follow the original SDK sh -> bash link: the declared sh File is
            # actual original Bash bytes, whose argv[0] selects POSIX mode.
            shutil.copy2(output / "bin" / name, binary, follow_symlinks=True)
            binary.chmod(0o755)


if __name__ == "__main__":
    build(json.loads(Path(sys.argv[1]).read_text()), Path.cwd())
