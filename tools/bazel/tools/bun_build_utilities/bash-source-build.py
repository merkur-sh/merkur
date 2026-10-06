"""Original Bash with source-built readline/terminfo and executable-relative resources."""

import json
from pathlib import Path
import shlex
import shutil
import subprocess
import sys


def ordinary_archive(file):
    if not file.is_file() or file.is_symlink() or file.stat().st_size == 0:
        raise ValueError("Source-built shell library requires an ordinary nonempty archive")
    if not file.read_bytes().startswith(b"!<arch>\n"):
        raise ValueError("Source-built shell library is not the declared static archive")


def configured_readline(makefile, static):
    lines = makefile.read_text().splitlines()
    for name in ["RL_LIBDIR", "HIST_LIBDIR"]:
        if name + " = " + str(static / "lib") not in lines:
            raise ValueError("Original Bash configure did not select its source-built external readline")


def check_runtime(runtime, directory):
    binary = runtime / "bin/bash"
    terminfo = runtime / "share/terminfo"
    if not binary.is_file() or not terminfo.is_dir() or not any(terminfo.rglob("xterm-256color")):
        raise ValueError("Source-built Bash lacks its complete declared runtime resources")
    environment = {"HOME": str(directory), "PATH": str(runtime / "bin"), "TERM": "xterm-256color", "LC_ALL": "C"}
    script = directory / "declared-shell-control"
    script.write_text("#!/usr/bin/env bash\nset -euo pipefail\n" +
                      '[[ "$BASH_VERSION" == 5.2.37* ]]\n' +
                      'declare -A facts=([exact]=42); [[ "${facts[exact]}" == 42 ]]\n' +
                      'mapfile -t values < <(printf "first\\nsecond\\n"); [[ "${values[1]}" == second ]]\n' +
                      '[[ "$TERMINFO" == "$1/share/terminfo" ]]\n' +
                      'bind -l >/dev/null\nprintf "declared-bash-runtime-ok\\n"\n')
    script.chmod(0o755)
    result = subprocess.run([script, runtime], env=environment, cwd=directory,
                            check=True, capture_output=True, text=True)
    if result.stdout != "declared-bash-runtime-ok\n":
        raise ValueError("Source-built Bash did not execute the original shebang/features closure")


def build(specification, execroot, source, work, environment, shell, make, git, extract):
    pins = json.loads((execroot / specification["pins"]).read_text())
    sdk = execroot / specification["sdk"]
    install = sdk / "bin/install"
    if str(install.relative_to(execroot)) not in specification["shell_files"]:
        raise ValueError("Original source installation requires its declared SDK install File")
    cxx = execroot / specification["cxx"]
    if specification["cxx"] not in specification["compiler_files"] or not cxx.is_file() or not cxx.stat().st_mode & 0o111:
        raise ValueError("Original ncurses requires its declared C++ compiler File")
    environment = {**environment, "CXX": str(cxx)}
    install_command = shlex.join([str(install), "-c"])
    command = [make, "SHELL=" + str(shell), "INSTALL=" + install_command]
    prefix = "/declared-bash"
    stage = work / "libraries"
    library_prefix = stage / prefix.lstrip("/")
    ncurses = work / "ncurses"
    extract(execroot / specification["ncurses_archive"], pins["ncurses"], ncurses)
    # The original selected recipe builds both narrow and wide configurations,
    # then presents the final wide headers at include/ for its readline build.
    for wide in [False, True]:
        configure = [shell, "configure", "--prefix=" + prefix, "--without-debug", "--without-ada",
                     "--without-manpages", "--with-shared", "--with-pkg-config",
                     "--with-pkg-config-libdir=" + prefix + "/lib/pkgconfig", "--disable-overwrite",
                     "--enable-symlinks", "--enable-termcap", "--enable-pc-files", "--with-termlib",
                     "--with-versioned-syms", "--disable-mixed-case",
                     "--enable-widec" if wide else "--disable-widec"]
        subprocess.run(configure, env=environment, cwd=ncurses, check=True)
        if sys.platform == "darwin":
            makefile = ncurses / "ncurses/Makefile"
            original = makefile.read_text()
            lines = original.splitlines(keepends=True)
            changed = [line.replace("-ltinfo", "-Wl,-reexport-ltinfo")
                       if line.startswith("SHLIB_LIST") else line for line in lines]
            if changed == lines:
                raise ValueError("Original ncurses recipe lacks its declared Apple reexport binding")
            makefile.write_text("".join(changed))
        subprocess.run(command + ["-j2"], env=environment, cwd=ncurses, check=True)
        subprocess.run(command + ["install", "DESTDIR=" + str(stage)], env=environment, cwd=ncurses, check=True)
        subprocess.run(command + ["clean"], env=environment, cwd=ncurses, check=True)
        subprocess.run(command + ["distclean"], env=environment, cwd=ncurses, check=True)
        headers = library_prefix / "include" / ("ncursesw" if wide else "ncurses")
        for header in headers.iterdir():
            destination = headers.parent / header.name
            destination.unlink(missing_ok=True)
            shutil.move(header, destination)
            header.symlink_to("../" + header.name)
    readline = work / "readline"
    extract(execroot / specification["readline_archive"], pins["readline"], readline)
    library_environment = {**environment,
                           "CPPFLAGS": shlex.join(["-I" + str(library_prefix / "include"), "-I" + str(library_prefix / "include/ncurses")]),
                           "LDFLAGS": environment["LDFLAGS"] + " -L" + shlex.quote(str(library_prefix / "lib"))}
    subprocess.run([shell, "configure", "--prefix=" + prefix, "--disable-static", "--with-curses"],
                   env=library_environment, cwd=readline, check=True)
    # These original upstream targets are private compiler inputs. The installed
    # recipe remains unchanged; no prebuilt Conda shared library is rewritten.
    subprocess.run(command + ["-j2", "static"], env=library_environment, cwd=readline, check=True)
    subprocess.run(command + ["install-headers", "DESTDIR=" + str(stage)],
                   env=library_environment, cwd=readline, check=True)
    static = work / "static-libraries"
    (static / "lib").mkdir(parents=True)
    shutil.copytree(library_prefix / "include", static / "include", symlinks=False)
    for archive in [readline / "libreadline.a", readline / "libhistory.a",
                    library_prefix / "lib/libncurses.a", library_prefix / "lib/libtinfo.a"]:
        ordinary_archive(archive)
        shutil.copyfile(archive, static / "lib" / archive.name)
    (work / "share").mkdir()
    (work / "share/terminfo").symlink_to(library_prefix / "share/terminfo", target_is_directory=True)
    patch = execroot / specification["patch"]
    subprocess.run([git, "apply", "--check", patch], env=environment, cwd=source, check=True)
    subprocess.run([git, "apply", patch], env=environment, cwd=source, check=True)
    bash_environment = {**environment, "CPPFLAGS": "-I" + str(static / "include"),
                        "LDFLAGS": environment["LDFLAGS"] + " -L" + shlex.quote(str(static / "lib"))}
    subprocess.run([shell, "configure", "--prefix=" + prefix,
                    "--with-installed-readline=" + str(static), "--without-bash-malloc"],
                   env=bash_environment, cwd=source, check=True)
    configured_readline(source / "Makefile", static)
    subprocess.run(command + ["-j2"], env=bash_environment, cwd=source, check=True)
    destination = work / "bash-install"
    subprocess.run(command + ["install", "DESTDIR=" + str(destination)],
                   env=bash_environment, cwd=source, check=True)
    runtime = work / "bash-runtime"
    shutil.copytree(destination / prefix.lstrip("/"), runtime, symlinks=False)
    shutil.copytree(library_prefix / "share/terminfo", runtime / "share/terminfo", symlinks=False)
    licenses = runtime / "share/bash/licenses"
    licenses.mkdir(parents=True)
    for kind, original in [("bash", source), ("readline", readline), ("ncurses", ncurses)]:
        shutil.copyfile(original / "COPYING", licenses / (kind + "-COPYING"))
    check_runtime(runtime, work)
