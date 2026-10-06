"""Build original ps/pgrep and exercise the unchanged TestRunner watcher flags."""

import importlib.util
import json
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import sys
import tempfile


def load_common(file):
    spec = importlib.util.spec_from_file_location("declared_source_utility", file)
    if spec is None or spec.loader is None:
        raise ValueError("Original process builder requires its declared source utility helper")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def native_binary(file, platform):
    if not file.is_file() or file.is_symlink() or not file.stat().st_mode & 0o111:
        raise ValueError("Process SDK requires its original executable regular File")
    with file.open("rb") as source:
        magic = source.read(4)
    if magic != (b"\x7fELF" if platform == "linux" else b"\xcf\xfa\xed\xfe"):
        raise ValueError("Process SDK cannot publish a script or foreign native executable")


def runtime_control(runtime, platform):
    for name in ["ps", "pgrep"]:
        native_binary(runtime / "bin" / name, platform)
    # This control owns the selected PID and every process in its fresh group.
    # It never selects unrelated users, process groups or command arguments.
    environment = {"PATH": str(runtime / "bin"), "HOME": str(runtime), "LC_ALL": "C"}
    child = subprocess.Popen([sys.executable, "-B", "-I", "-c", "import sys;sys.stdin.buffer.read()"],
                             stdin=subprocess.PIPE, stdout=subprocess.DEVNULL,
                             stderr=subprocess.DEVNULL, env=environment, start_new_session=True)
    try:
        ps = subprocess.run([runtime / "bin/ps", "-p", str(child.pid)],
                            env=environment, capture_output=True, check=True, text=True)
        if str(child.pid) not in ps.stdout.split():
            raise ValueError("Original ps -p did not select its owned live process")
        pgrep = subprocess.run([runtime / "bin/pgrep", "-a", "-g", str(child.pid)],
                               env=environment, capture_output=True, check=True, text=True)
        selected = [line.split()[0] for line in pgrep.stdout.splitlines() if line.split()]
        if selected != [str(child.pid)]:
            raise ValueError("Original pgrep -a -g did not preserve its exact owned process group")
    finally:
        if child.stdin is not None:
            child.stdin.close()
        child.wait()
    gone = subprocess.run([runtime / "bin/pgrep", "-a", "-g", str(child.pid)],
                          env=environment, capture_output=True, text=True)
    if gone.returncode != 1 or gone.stdout != "":
        raise ValueError("Original pgrep kept a pass for a process group after its owner exited")


def build(specification, execroot):
    common = load_common(execroot / specification["common"])
    platform = specification["platform"]
    if platform not in ["darwin", "linux"]:
        raise ValueError("Process utility requires a declared native platform")
    expected_host = "darwin" if sys.platform == "darwin" else "linux" if sys.platform.startswith("linux") else None
    if platform != expected_host:
        raise ValueError("Original process SDK requires execution on its actual native platform")
    tools = {name: common.declared_tool(specification[name], specification["compiler_files"], execroot)
             for name in ["cc", "ar", "ranlib"]}
    shell = common.declared_tool(specification["shell"], specification["shell_files"], execroot)
    make = common.declared_tool(specification["make"], specification["make_files"], execroot)
    runtime, binary = execroot / specification["runtime"], execroot / specification["binary"]
    before = common.output_identity(runtime)
    if binary.exists() or binary.is_symlink():
        raise ValueError("Process utility executable output already exists")
    sdk, make_sdk = execroot / specification["sdk"], execroot / specification["make_sdk"]
    with tempfile.TemporaryDirectory(prefix="declared-process-utility-", dir=runtime.parent) as temporary:
        work = Path(temporary)
        source = work / "source"
        pins = json.loads((execroot / specification["pins"]).read_text())
        common.extract_source(execroot / specification["archive"], pins[platform], source)
        home = work / "home"
        home.mkdir()
        environment = {"HOME": str(home), "TMPDIR": str(work), "PATH": os.pathsep.join([str(make_sdk / "bin"), str(sdk / "bin"), str(tools["cc"].parent)]),
                       "SHELL": str(shell), "CONFIG_SHELL": str(shell), "LC_ALL": "C", "TZ": "UTC",
                       "SOURCE_DATE_EPOCH": "0", "ZERO_AR_DATE": "1"}
        for name, value in specification["environment"].items():
            if name == "PATH":
                environment[name] += os.pathsep + os.pathsep.join(str(execroot / part) if part.startswith(("external/", "bazel-out/")) else part for part in value.split(os.pathsep))
            else:
                environment[name] = str(execroot / value) if value.startswith(("external/", "bazel-out/")) else value
        environment.pop("DYLD_LIBRARY_PATH", None)
        environment["DYLD_FALLBACK_LIBRARY_PATH" if platform == "darwin" else "LD_LIBRARY_PATH"] = os.pathsep.join([str(sdk / "lib"), str(make_sdk / "lib")])
        cflags = common.absolute_flags(specification["compile_flags"], execroot) + ["-O2", "-ffile-prefix-map=" + str(work) + "=/declared-process-utility", "-ffile-prefix-map=" + str(execroot) + "=/declared-action"]
        ldflags = common.absolute_flags(specification["link_flags"], execroot)
        environment.update({name.upper(): str(value) for name, value in tools.items()})
        environment.update({"CFLAGS": shlex.join(cflags), "LDFLAGS": shlex.join(ldflags)})
        installed = work / "installed"
        if platform == "darwin":
            # Exact original Apple ps_lowpriv/pkill targets. Missing original
            # internal-SDK headers are a build failure, never invented declarations.
            (installed / "bin").mkdir(parents=True)
            ps_sources = [source / "ps" / (name + ".c") for name in ["ps", "fmt", "keyword", "nlist", "print", "tasks"]]
            subprocess.run([tools["cc"], *cflags, "-D__FBSDID=__RCSID", *ps_sources,
                            *ldflags, "-o", installed / "bin/ps"], env=environment, cwd=source, check=True)
            subprocess.run([tools["cc"], *cflags, "-D__FBSDID=__RCSID", "-fblocks", source / "pkill/pkill.c",
                            *ldflags, "-lsysmon", "-o", installed / "bin/pgrep"], env=environment, cwd=source, check=True)
            shutil.copytree(source / "ps", installed / "share/licenses/ps", ignore=shutil.ignore_patterns("tests"))
            shutil.copyfile(source / "pkill/pkill.c", installed / "share/licenses/pkill.c")
        else:
            prefix = "/declared-process-utilities"
            # Keep upstream feature defaults. Only the private libproc2 link
            # representation is static so the selected tools need no loader path.
            subprocess.run([shell, "configure", "--prefix=" + prefix, "--disable-shared"], env=environment, cwd=source, check=True)
            subprocess.run([make, "SHELL=" + str(shell), "-j2"], env=environment, cwd=source, check=True)
            stage = work / "stage"
            subprocess.run([make, "SHELL=" + str(shell), "install", "DESTDIR=" + str(stage)], env=environment, cwd=source, check=True)
            shutil.copytree(stage / prefix.lstrip("/"), installed, symlinks=False)
            licenses = installed / "share/licenses/procps"
            licenses.mkdir(parents=True)
            for name in ["COPYING", "COPYING.LIB"]:
                shutil.copyfile(source / name, licenses / name)
        runtime_control(installed, platform)
        if common.output_identity(runtime) != before:
            raise ValueError("Process SDK output changed while original sources compiled")
        shutil.copytree(installed, runtime, symlinks=False, dirs_exist_ok=before is not None)
        binary.parent.mkdir(parents=True, exist_ok=True)
        binary.symlink_to(os.path.relpath(runtime / "bin/ps", binary.parent))
        runtime_control(runtime, platform)


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise ValueError("Exact declared process build specification required")
    build(json.loads(Path(sys.argv[1]).read_text()), Path.cwd())
