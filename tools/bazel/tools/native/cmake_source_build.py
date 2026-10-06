"""Bootstrap original CMake with declared native compiler, Make and shell inputs."""

import hashlib
import importlib.util
import json
import os
import platform
from pathlib import Path
import shlex
import shutil
import stat
import subprocess
import sys
import tempfile


def absolute_flags(flags, execroot):
    result = []
    for flag in flags:
        if flag.startswith(("external/", "bazel-out/")):
            flag = str(execroot / flag)
        else:
            for prefix in ("--sysroot=", "--ld-path=", "-fuse-ld="):
                if flag.startswith(prefix) and flag[len(prefix):].startswith(("external/", "bazel-out/")):
                    flag = prefix + str(execroot / flag[len(prefix):])
                    break
        result.append(flag)
    return result


def run(arguments, environment, directory):
    subprocess.run([str(argument) for argument in arguments], env=environment, cwd=directory, check=True)


def empty_output_directory(output):
    try:
        mode = output.lstat().st_mode
    except FileNotFoundError:
        pass
    else:
        if not stat.S_ISDIR(mode) or any(output.iterdir()):
            raise ValueError("CMake output must be absent or an ordinary empty TreeArtifact directory")
    output.mkdir(parents=True, exist_ok=True)


def materialize_runtime(sdk, runtime):
    empty_output_directory(runtime)
    shutil.copytree(sdk, runtime, symlinks=False, dirs_exist_ok=True)


def load_module(name, file):
    specification = importlib.util.spec_from_file_location(name, file)
    module = importlib.util.module_from_spec(specification)
    sys.modules[name] = module
    specification.loader.exec_module(module)
    return module


def retained_products(directory, destination, suffix):
    empty_output_directory(destination)
    for file in directory.rglob('*' + suffix):
        if file.is_symlink() or not file.is_file():
            raise ValueError('CMake compiler product is not an original ordinary File')
        output = destination / file.relative_to(directory)
        output.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(file, output)


def linker_template(original, target):
    literal = '<CMAKE_CXX_COMPILER> <FLAGS> <LINK_FLAGS> <OBJECTS> -o <TARGET> <LINK_LIBRARIES>'
    if ('set(CMAKE_CXX_LINK_EXECUTABLE\n    "' + literal + '")').encode() not in original['Modules/CMakeCXXInformation.cmake']:
        raise ValueError('Original CMake C++ executable link template differs')
    option = '-Wl,-map,<TARGET>.map' if target.endswith('apple-darwin') else '-Wl,--Map=<TARGET>.map'
    return literal + ' ' + option


def pending_producer_inputs(specification, execroot):
    # These original action inputs execute the compiler or supply linked native
    # runtime/SDK implementation. Compiler .d header selection alone cannot
    # establish their original implementation/license authority.
    names = ['cc', 'cxx', 'ar', 'ranlib', 'sdk', 'make_sdk']
    values = [str(execroot / specification[name]) for name in names]
    if specification['sysroot']:
        values.append(str(execroot / specification['sysroot']))
    return sorted(set(values))


def capture_selection(specification, execroot, source, directory, installed, original, expected,
                      changed, join, linked, sections, mapper, licenses):
    command_bytes = (directory / 'compile_commands.json').read_bytes()
    dependencies = list(directory.rglob('*.o.d'))
    built = directory / 'bin/cmake'
    mapping = directory / 'bin/cmake.map'
    if not built.is_file() or not mapping.is_file():
        raise ValueError('CMake original executable/map Files are absent')
    # The consumer executes the installed File, not an unbound predecessor.
    # Installation transformations must preserve the actual loaded image.
    sections.assert_loaded_bytes_equal(built.read_bytes(), installed.read_bytes())
    selected = linked.native_selection(directory, [(built, mapping, 'executable')],
        specification['target'], command_bytes, dependencies, sections, mapper, licenses)
    selection = join.partition(selected, source, expected, original, changed,
        (execroot / specification['workspace_license']).read_bytes(), linked, licenses)
    notices = execroot / specification['original_notices']
    empty_output_directory(notices)
    original_notices = selection.pop('notices')
    for member, data in original_notices.items():
        file = notices / member
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_bytes(data)
    (execroot / specification['compiler_commands']).write_bytes(command_bytes)
    for name, suffix in [('dependencies', '.o.d'), ('link_maps', '.map'),
                         ('compiler_objects', '.o'), ('compiler_archives', '.a')]:
        retained_products(directory, execroot / specification[name], suffix)
    metadata = {**specification, 'selected_sources': selection['sources'],
        'pending_sources': sorted(set(selection['pending'] + pending_producer_inputs(specification, execroot))),
        'selected_notices': [{'path': member, 'size': len(data), 'sha256': hashlib.sha256(data).hexdigest()}
                             for member, data in sorted(original_notices.items())],
        'source_namespace': str(source),
        'build_namespace': str(directory), 'artifact': {
            'path': str(installed), 'original_path': str(built),
            'size': installed.stat().st_size, 'sha256': hashlib.sha256(installed.read_bytes()).hexdigest()}}
    (execroot / specification['compiler_configuration']).write_text(json.dumps(metadata, sort_keys=True) + '\n')


def build(specification):
    cpu = {'arm64': 'aarch64', 'aarch64': 'aarch64', 'x86_64': 'x86_64'}.get(platform.machine())
    system = 'apple-darwin' if sys.platform == 'darwin' else 'unknown-linux-gnu' if sys.platform.startswith('linux') else None
    if cpu is None or system is None or specification['target'] != cpu + '-' + system:
        raise ValueError('Source CMake executor differs from its configured native target')
    execroot = Path.cwd()
    runtime = execroot / specification["runtime"]
    binary = execroot / specification["binary"]
    sdk = execroot / specification["sdk"]
    make_sdk = execroot / specification["make_sdk"]
    shell = execroot / specification["shell"]
    driver = execroot / specification["make_driver"]
    cc = execroot / specification["cc"]
    cxx = execroot / specification["cxx"]
    ar = execroot / specification["ar"]
    ranlib = execroot / specification["ranlib"]
    git = execroot / specification["git"]
    join = load_module('cmake_selected_source', execroot / specification['source_join'])
    linked = load_module('cmake_native_selection', execroot / specification['linked_sources'])
    sections = load_module('cmake_runtime_sections', execroot / specification['runtime_sections'])
    mapper = load_module('cmake_native_map', execroot / specification['native_mapper'])
    licenses = load_module('cmake_original_licenses', execroot / specification['original_licenses'])
    original = join.original_source(execroot / specification['source_archive'],
        json.loads((execroot / specification['pins']).read_text()))
    git_environment = {'PATH': '', 'LC_ALL': 'C', 'GIT_CONFIG_NOSYSTEM': '1',
        'GIT_CONFIG_GLOBAL': '/dev/null',
        'DYLD_FALLBACK_LIBRARY_PATH' if sys.platform == 'darwin' else 'LD_LIBRARY_PATH': str(sdk / 'lib')}
    expected, changed = join.patched_source(original,
        [execroot / value for value in specification['source_patches']], git, git_environment)
    join.source_files(specification['source'], expected, execroot)
    materialize_runtime(sdk, runtime)
    with tempfile.TemporaryDirectory(prefix="merkur-cmake-source-", dir=runtime.parent) as temporary:
        private = Path(temporary)
        source = private / "source"
        source.mkdir()
        for entry in specification["source"]:
            relative = Path(entry["relative"])
            if relative.is_absolute() or ".." in relative.parts:
                raise ValueError("CMake source File lies outside its declared source repository")
            target = source / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(execroot / entry["path"], target)
        directory = private / "build"
        directory.mkdir()
        home = private / "home"
        home.mkdir()
        temporary_directory = private / "tmp"
        temporary_directory.mkdir()
        environment = {key: str(execroot / value) if value.startswith(("external/", "bazel-out/")) else value for key, value in specification["environment"].items()}
        environment.update({
            "HOME": str(home), "TMPDIR": str(temporary_directory),
            "PATH": str(sdk / "bin") + os.pathsep + str(make_sdk / "bin"),
            "SHELL": str(shell), "CONFIG_SHELL": str(shell),
            "CC": str(cc), "CXX": str(cxx), "AR": str(ar), "RANLIB": str(ranlib),
            "MAKE": str(driver),
            "MERKUR_CMAKE_MAKE_EXECUTABLE": str(execroot / specification["make"]),
            "MERKUR_CMAKE_SHELL": str(shell),
            "LC_ALL": "C", "SOURCE_DATE_EPOCH": "0", "ZERO_AR_DATE": "1",
        })
        libraries = os.pathsep.join([str(sdk / "lib"), str(make_sdk / "lib")])
        environment["DYLD_FALLBACK_LIBRARY_PATH" if sys.platform == "darwin" else "LD_LIBRARY_PATH"] = libraries
        mappings = ["-ffile-prefix-map=" + str(private) + "=/merkur-cmake-source", "-ffile-prefix-map=" + str(execroot) + "=/merkur-action"]
        cflags = absolute_flags(specification["compile_flags"], execroot) + mappings
        cxxflags = absolute_flags(specification["cxx_flags"], execroot) + mappings
        ldflags = absolute_flags(specification["link_flags"], execroot)
        environment.update({"CFLAGS": shlex.join(cflags), "CXXFLAGS": shlex.join(cxxflags), "LDFLAGS": shlex.join(ldflags)})
        def quote(value):
            return '"' + str(value).replace("\\", "/").replace('"', '\\"') + '"'
        toolchain = private / "toolchain.cmake"
        settings = [
            ("CMAKE_C_COMPILER", cc), ("CMAKE_CXX_COMPILER", cxx),
            ("CMAKE_AR", ar), ("CMAKE_RANLIB", ranlib),
            ("CMAKE_MAKE_PROGRAM", driver),
            ("CMAKE_C_FLAGS_INIT", shlex.join(cflags)),
            ("CMAKE_CXX_FLAGS_INIT", shlex.join(cxxflags)),
            ("CMAKE_EXE_LINKER_FLAGS_INIT", shlex.join(ldflags)),
            ("CMAKE_CXX_LINK_EXECUTABLE", linker_template(original, specification['target'])),
        ]
        if sys.platform == "darwin":
            settings += [("CMAKE_SYSTEM_NAME", "Darwin"), ("CMAKE_OSX_SYSROOT", environment["SDKROOT"])]
        toolchain.write_text("\n".join("set(" + key + " " + quote(value) + ")" for key, value in settings) + "\n")
        prefixes = [str(sdk)]
        sysroot = environment.get("SDKROOT")
        if not sysroot:
            for flag in cxxflags:
                if flag.startswith("--sysroot="):
                    sysroot = flag.removeprefix("--sysroot=")
        if sysroot:
            prefixes.extend([str(Path(sysroot) / "usr"), sysroot])
        install_rpath = "@executable_path/../lib" if sys.platform == "darwin" else "$ORIGIN/../lib"
        run([shell, source / "bootstrap", "--prefix=/merkur-cmake", "--parallel=2", "--",
             "-DCMAKE_TOOLCHAIN_FILE=" + str(toolchain),
             "-DCMAKE_UNAME:FILEPATH=" + str(sdk / "bin/uname"),
             "-DCMAKE_MAKE_PROGRAM:FILEPATH=" + str(driver),
             "-DCMAKE_BUILD_TYPE=Release", "-DCMAKE_USE_OPENSSL=ON",
             "-DCMAKE_EXPORT_COMPILE_COMMANDS=ON",
             "-DCMAKE_FIND_USE_CMAKE_SYSTEM_PATH=OFF",
             "-DCMAKE_FIND_USE_PACKAGE_REGISTRY=OFF",
             "-DCMAKE_FIND_USE_SYSTEM_PACKAGE_REGISTRY=OFF",
             "-DGIT_EXECUTABLE:FILEPATH=" + str(git),
             "-DOPENSSL_ROOT_DIR=" + str(sdk),
             "-DCMAKE_PREFIX_PATH=" + ";".join(prefixes),
             "-DCMAKE_INSTALL_RPATH=" + install_rpath], environment, directory)
        run([driver, "-j2"], environment, directory)
        destination = private / "install"
        install_environment = {**environment, "DESTDIR": str(destination)}
        run([driver, "install"], install_environment, directory)
        installed = destination / "merkur-cmake"
        shutil.copytree(installed, runtime, dirs_exist_ok=True, symlinks=False)
        capture_selection(specification, execroot, source, directory, runtime / 'bin/cmake',
            original, expected, changed, join, linked, sections, mapper, licenses)
    emitted = runtime / "bin/cmake"
    if not emitted.is_file() or not (runtime / "share/cmake-4.4/Modules/CMakeDetermineSystem.cmake").is_file():
        raise ValueError("CMake installation lacks its executable or original resource closure")
    binary.parent.mkdir(parents=True, exist_ok=True)
    binary.symlink_to(os.path.relpath(emitted, binary.parent))
    environment["PATH"] = str(runtime / "bin")
    environment["DYLD_FALLBACK_LIBRARY_PATH" if sys.platform == "darwin" else "LD_LIBRARY_PATH"] = str(runtime / "lib")
    # The distribution must resolve its own adjacent resources after installation.
    environment.pop("HOME", None)
    environment.pop("TMPDIR", None)
    run([binary, "--version"], environment, runtime)


if __name__ == "__main__":
    build(json.loads(Path(sys.argv[1]).read_text()))
