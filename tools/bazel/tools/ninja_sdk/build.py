"""Bootstrap original Ninja with the declared Cc, Python and Bash File inputs."""

import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import sys
import tempfile


def tool_paths(specification, root):
    declared = {str(root / item) for item in specification["inputs"]}
    paths = {name: str(root / specification[name]) for name in ["cxx", "ar", "shell", "python"]}
    if any(path not in declared or not Path(path).is_file() or not os.access(path, os.X_OK) for path in paths.values()):
        raise ValueError("Ninja build tool is absent from its declared executable File closure")
    if Path(paths["shell"]).name != "bash" or Path(paths["shell"]).parent.name != "bin":
        raise ValueError("Ninja requires the original declared Bash SDK File")
    return paths


def source_files(specification, root, destination):
    seen = set()
    for item in specification["source"]:
        relative = Path(item["relative"])
        if relative.is_absolute() or ".." in relative.parts or not relative.parts or relative.as_posix() in seen:
            raise ValueError("Ninja source File lies outside its original repository")
        seen.add(relative.as_posix())
        target = destination / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(root / item["path"], target)
        target.chmod((root / item["path"]).stat().st_mode & 0o777)
    pins = json.loads((root / specification["pins"]).read_text())
    license_file = destination / pins["license"]["path"]
    if hashlib.sha256(license_file.read_bytes()).hexdigest() != pins["license"]["sha256"]:
        raise ValueError("Ninja original source license differs from its acquisition pin")


def build(specification):
    root = Path.cwd()
    paths = tool_paths(specification, root)
    runtime = root / specification["runtime"]
    binary = root / specification["binary"]
    if runtime.is_symlink() or (runtime.exists() and (not runtime.is_dir() or any(runtime.iterdir()))):
        raise ValueError("Ninja SDK output must be absent or an empty ordinary TreeArtifact")
    if binary.exists() or binary.is_symlink():
        raise ValueError("Ninja executable output must be absent")
    helper_spec = importlib.util.spec_from_file_location("native_cmake", root / specification["helper"])
    helper = importlib.util.module_from_spec(helper_spec)
    helper_spec.loader.exec_module(helper)
    with tempfile.TemporaryDirectory(prefix="merkur-ninja-source-") as temporary:
        private = Path(temporary).resolve()
        source = private / "source"
        source.mkdir()
        source_files(specification, root, source)
        home = private / "home"
        home.mkdir()
        sdk = root / specification["sdk"]
        environment = {key: str(root / value) if value.startswith(("external/", "bazel-out/")) else value for key, value in specification["environment"].items()}
        flags = helper.absolute_flags(specification["compile_flags"], root)
        links = helper.absolute_flags(specification["link_flags"], root)
        if sys.platform == "darwin":
            links += ["-Wl,-oso_prefix," + str(source) + "/"]
        maps = ["-ffile-prefix-map=" + str(private) + "=/merkur-ninja-source", "-fdebug-prefix-map=" + str(private) + "=/merkur-ninja-source", "-ffile-prefix-map=" + str(root) + "=/merkur-action", "-fdebug-prefix-map=" + str(root) + "=/merkur-action"]
        environment.update({"HOME": str(home), "TMPDIR": str(private), "PATH": str(sdk / "bin"),
                            "CXX": paths["cxx"], "AR": paths["ar"],
                            "CXXFLAGS": shlex.join(flags + maps), "LDFLAGS": shlex.join(links),
                            "MERKUR_NINJA_SHELL": paths["shell"], "MERKUR_NINJA_PYTHON": paths["python"], "SHELL": paths["shell"],
                            "LC_ALL": "C", "SOURCE_DATE_EPOCH": "0", "ZERO_AR_DATE": "1"})
        environment["DYLD_FALLBACK_LIBRARY_PATH" if sys.platform == "darwin" else "LD_LIBRARY_PATH"] = str(sdk / "lib")
        subprocess.run([paths["python"], "-I", "-B", str(source / "configure.py"), "--bootstrap", "--with-python=python3"], cwd=source, env=environment, check=True)
        original = source / "ninja"
        version = subprocess.run([str(original), "--version"], env=environment, check=True, capture_output=True, text=True).stdout.strip()
        if version != json.loads((root / specification["pins"]).read_text())["version"]:
            raise ValueError("Original Ninja bootstrap produced a foreign version")
        runtime.mkdir(parents=True, exist_ok=True)
        (runtime / "bin").mkdir()
        (runtime / "share/licenses/ninja").mkdir(parents=True)
        shutil.copyfile(original, runtime / "bin/ninja")
        (runtime / "bin/ninja").chmod(0o755)
        shutil.copyfile(source / "COPYING", runtime / "share/licenses/ninja/COPYING")
        binary.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(original, binary)
        binary.chmod(0o755)


if __name__ == "__main__":
    build(json.loads(Path(sys.argv[1]).read_text()))
