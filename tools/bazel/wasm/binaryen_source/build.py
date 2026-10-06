"""Original Binaryen compiler action; native SDK tools and source Files are mandatory."""
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path, PurePosixPath
import platform
import shlex
import shutil
import subprocess
import sys
import tarfile
import tempfile


def original_members(path, pin):
    data = path.read_bytes()
    if len(data) != pin['size'] or hashlib.sha256(data).hexdigest() != pin['sha256']:
        raise ValueError('Binaryen source requires its exact original publisher archive')
    prefix, result = pin['prefix'] + '/', {}
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as archive:
        for member in archive:
            if member.isdir():
                continue
            if not member.isfile() or not member.name.startswith(prefix):
                raise ValueError('Original Binaryen archive member is not a regular source File')
            name = member.name.removeprefix(prefix)
            logical = PurePosixPath(name)
            if not name or logical.is_absolute() or '..' in logical.parts or str(logical) != name or name in result:
                raise ValueError('Invalid or repeated original Binaryen source member')
            stream = archive.extractfile(member)
            if stream is None:
                raise ValueError('Original Binaryen source member is absent')
            result[name] = stream.read()
    return result


def original_source(archive, googletest, pins):
    if (pins['name'], pins['version'], pins['commit']) != (
            'binaryen', '117', 'c62a0c97168e88f97bca4bd96298a5ffc041844d'):
        raise ValueError('Binaryen requires the original version_117 source')
    result = original_members(archive, pins['source'])
    mount = pins['googletest']['mount'] + '/'
    for name, data in original_members(googletest, pins['googletest']).items():
        name = mount + name
        if name in result:
            raise ValueError('Original Binaryen and Googletest source members overlap')
        result[name] = data
    if b'project(binaryen LANGUAGES C CXX VERSION 117)' not in result['CMakeLists.txt']:
        raise ValueError('Binaryen original compiler project version differs')
    if any(not result[name].strip() for name in ['LICENSE', mount + 'LICENSE']):
        raise ValueError('Original Binaryen or Googletest publisher license is absent')
    original_llvm_licenses(result, pins)
    return result


def original_llvm_licenses(source, pins):
    llvm = pins['llvm']
    if llvm['commit'] != '6c86d6efaf129c42d37121f1e7e9a7adffb54c1a' or ('commit ' + llvm['commit']).encode() not in source[llvm['readme']]:
        raise ValueError('Binaryen LLVM requires its original publisher revision declaration')
    license = llvm['license']
    raw = source[license['member']]
    if len(raw) != license['size'] or hashlib.sha256(raw).hexdigest() != license['sha256']:
        raise ValueError('Binaryen LLVM license differs from its original publisher text')
    if not source[llvm['support_notice']].strip():
        raise ValueError('Binaryen LLVM lacks its original Support copyright notice')
    # These are original member facts, not a blanket license grant for retained
    # MD5 or Unicode-derived inputs; their embedded/original origins are joined
    # separately by the compiler-selected source consumer.
    return {'revision': llvm['commit'], 'license': license['member'], 'notice': llvm['support_notice']}


def selected_llvm_licenses(selected, source, pins, unicode_files, unicode_helper):
    """Join only observed original LLVM members to scoped publisher notices.

    The caller partitions its exact compiler selection first. This focused
    join grants no source-selection or whole native-tool completeness.
    """
    facts = original_llvm_licenses(source, pins)
    selected = set(selected)
    if any(not member.startswith('third_party/llvm-project/') or member not in source
           for member in selected):
        raise ValueError('Selected LLVM source is outside its original member closure')
    if not selected:
        return {}
    result = {facts['license']: source[facts['license']]}
    if 'third_party/llvm-project/UnicodeCaseFold.cpp' in selected:
        result.update(unicode_helper.join(source, pins, unicode_files))
    if any(member.startswith('third_party/llvm-project/include/llvm/Support/') for member in selected):
        result[facts['notice']] = source[facts['notice']]
    for license in pins['llvm']['embedded_licenses']:
        if license['member'] not in selected:
            continue
        raw = source[license['member']][license['offset']:license['offset'] + license['length']]
        if len(raw) != license['length'] or hashlib.sha256(raw).hexdigest() != license['sha256']:
            raise ValueError('Selected embedded LLVM notice differs from its original source File')
        result[license['member']] = raw
    return result


def source_files(records, expected, root):
    values = {}
    for entry in records:
        if set(entry) != {'path', 'member', 'label'} or not isinstance(entry['label'], str) or not entry['label']:
            raise ValueError('Binaryen requires exact original source File declarations')
        name = entry['member']
        if name in values or name not in expected:
            raise ValueError('Foreign or duplicate Binaryen compiler source member')
        path = PurePosixPath(entry['path'])
        if path.is_absolute() or '..' in path.parts or str(path) != entry['path']:
            raise ValueError('Binaryen source File is outside its original action root')
        file = root / entry['path']
        if file.read_bytes() != expected[name]:
            raise ValueError('Binaryen compiler source differs from its original archive member')
        values[name] = file
    if set(values) != set(expected):
        raise ValueError('Original Binaryen compiler source File closure is incomplete')
    return values


def native_platform():
    cpu = {'arm64': 'arm64', 'aarch64': 'arm64', 'x86_64': 'x64', 'AMD64': 'x64'}.get(platform.machine())
    system = 'darwin' if sys.platform == 'darwin' else 'linux' if sys.platform.startswith('linux') else None
    if cpu is None or system is None:
        raise ValueError('Binaryen requires a supported native Linux or Darwin executor')
    return system + '_' + cpu


def declared_tools(specification, root):
    declared = {str(root / name) for name in specification['declared_files']}
    if set(specification['tools']) != {'cc', 'cxx', 'ar', 'ranlib', 'shell', 'make', 'make_driver', 'cmake'}:
        raise ValueError('Original Binaryen compiler and native utility tools are mandatory')
    tools = {}
    for name, value in specification['tools'].items():
        path = root / value
        if str(path) not in declared or not path.is_file() or not path.stat().st_mode & 0o111:
            raise ValueError('Binaryen selected an undeclared executable File: ' + name)
        tools[name] = str(path)
    if set(specification['sdk_roots']) != {'shell', 'make', 'cmake'}:
        raise ValueError('Binaryen requires all three configured source-built SDK roots')
    for value in specification['sdk_roots'].values():
        if str(root / value) not in declared or not (root / value).is_dir():
            raise ValueError('Binaryen requires its exact declared source-built SDK root')
    return tools


def cmake_literal(value):
    # CMake bracket arguments preserve paths/flags literally, including dollar
    # expressions, quotes and backslashes. Choose a delimiter absent from input.
    value = str(value)
    delimiter = ''
    while ']' + delimiter + ']' in value:
        delimiter += '='
    return '[' + delimiter + '[' + value + ']' + delimiter + ']'


def configuration(specification, root, tools, flags, private, source, directory,
                  executable_flags, library_flags):
    lines = [f'set({name} {cmake_literal(value)})' for name, value in {
        'CMAKE_C_COMPILER': tools['cc'], 'CMAKE_CXX_COMPILER': tools['cxx'],
        'CMAKE_AR': tools['ar'], 'CMAKE_RANLIB': tools['ranlib'], 'CMAKE_MAKE_PROGRAM': tools['make_driver'],
        'CMAKE_C_FLAGS_INIT': shlex.join(flags['compile_flags']), 'CMAKE_CXX_FLAGS_INIT': shlex.join(flags['cxx_flags']),
        'CMAKE_EXE_LINKER_FLAGS_INIT': shlex.join(executable_flags),
        'CMAKE_SHARED_LINKER_FLAGS_INIT': shlex.join(library_flags),
    }.items()]
    if specification['platform'].startswith('darwin_'):
        if not specification['sysroot']:
            raise ValueError('Native Binaryen Darwin build requires its declared CcToolchain sysroot')
        sysroot = str(root / specification['sysroot'])
        lines.append('set(CMAKE_OSX_SYSROOT ' + cmake_literal(sysroot) + ')')
    toolchain = private / 'toolchain.cmake'
    command = [tools['cmake'], '-S', str(source), '-B', str(directory), '-G', 'Unix Makefiles',
        '-DCMAKE_TOOLCHAIN_FILE=' + str(toolchain), '-DCMAKE_BUILD_TYPE=Release', '-DCMAKE_EXPORT_COMPILE_COMMANDS=ON',
        '-DBUILD_TESTS=ON', '-DBUILD_TOOLS=ON', '-DBYN_ENABLE_ASSERTIONS=ON', '-DBUILD_LLVM_DWARF=ON',
        '-DBUILD_STATIC_LIB=' + ('ON' if specification['platform'].startswith('linux_') else 'OFF')]
    return toolchain, '\n'.join(lines) + '\n', command


def preserve_compiler_products(directory, objects, archives):
    # The shared selected-archive collector needs the actual same-build object
    # bytes to prove a retained ar member's compiler/source relation. Preserve
    # these original outputs before the private compilation directory closes.
    for suffix, output in [('.o', objects), ('.a', archives)]:
        products = sorted(directory.rglob('*' + suffix))
        if suffix == '.o' and not products:
            raise ValueError('Binaryen compiler produced no same-build object Files')
        for product in products:
            if product.is_symlink() or not product.is_file():
                raise ValueError('Binaryen compiler product is not an original ordinary File')
            relative = product.relative_to(directory)
            destination = output / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(product, destination)



def compiler_selection(directory, images, target, command_bytes, dependency_files, linked, sections, mapper, licenses):
    return linked.native_selection(directory, images, target, command_bytes,
        dependency_files, sections, mapper, licenses)


def partition_original_sources(selected, source_root, source, pins, unicode_files,
                               unicode_helper, linked, licenses):
    """Bind compiler-selected publisher Files; unknown native inputs stay pending."""
    mount = pins['googletest']['mount']
    llvm = 'third_party/llvm-project'
    origins = [{'component': component, 'namespace': str(source_root / prefix) if prefix else str(source_root),
                'directory': source_root / prefix if prefix else source_root,
                'members': {name.removeprefix(prefix + '/') if prefix else name: raw
                            for name, raw in source.items() if not prefix or name.startswith(prefix + '/')},
                'aliases': {}}
               for component, prefix in [('binaryen', ''), ('googletest', mount), ('llvm', llvm)]]
    original, pending = [], []
    for path in selected:
        if path.startswith(str(source_root) + '/'):
            original.append(path)
        else:
            pending.append(path)
    facts = linked.bind_original_inputs(original, origins, licenses)
    notices = {}
    components = {item['component'] for item in facts}
    if 'binaryen' in components:
        notices['binaryen/LICENSE'] = source['LICENSE']
    if 'googletest' in components:
        notices['googletest/LICENSE'] = source[mount + '/LICENSE']
    llvm_selected = [llvm + '/' + item['source_path'] for item in facts if item['component'] == 'llvm']
    if llvm_selected:
        notices.update({'llvm/' + name: raw for name, raw in
            selected_llvm_licenses(llvm_selected, source, pins, unicode_files, unicode_helper).items()})
    # Unknown SDK/C++ runtime/generated sources are never covered by the root
    # Binaryen license. Their original producer/source/license join is required.
    return facts, notices, pending



def generated_original_sources(selected, source_root, directory, source, pins, cmake, environment, licenses):
    """Reproduce the two actual original CMake-generated compiler inputs."""
    definitions = [
        ('config.h', ['CMakeLists.txt', 'config.h.in']),
        ('src/passes/WasmIntrinsics.cpp', ['src/passes/CMakeLists.txt',
            'src/passes/WasmIntrinsics.cpp.in', 'src/passes/wasm-intrinsics.wat']),
    ]
    selected = set(selected)
    inputs, facts = set(), []
    for output, members in definitions:
        actual = directory / output
        if str(actual) not in selected:
            continue
        for member in members:
            if licenses.read_regular(source_root, member, require_text=False) != source[member]:
                raise ValueError('Original Binaryen generator input differs from its archive File')
        with tempfile.TemporaryDirectory(prefix='original-binaryen-generation-', dir=directory.parent) as temporary:
            replay = Path(temporary)
            if output == 'config.h':
                # Original archived source has no Git metadata, so the exact
                # original project VERSION binds the only configured variable.
                if (pins['version'] != '117' or
                        b'project(binaryen LANGUAGES C CXX VERSION 117)' not in source['CMakeLists.txt'] or
                        any(name == '.git' or name.startswith('.git/') for name in source)):
                    raise ValueError('Original Binaryen project version source differs')
                command = 'configure_file(config.h.in config.h)'
                if source['CMakeLists.txt'].decode().splitlines().count(command) != 1:
                    raise ValueError('Original Binaryen config generator command differs')
                body = 'set(PROJECT_VERSION ' + cmake_literal(pins['version']) + ')\n' + command + '\n'
            else:
                original = source['src/passes/CMakeLists.txt'].decode()
                boundary = 'FILE(GLOB passes_HEADERS *.h)'
                if original.count(boundary) != 1:
                    raise ValueError('Original Binaryen intrinsic generator boundary differs')
                body = original.split(boundary, 1)[0]
                if body.count('configure_file(WasmIntrinsics.cpp.in WasmIntrinsics.cpp @ONLY)') != 1:
                    raise ValueError('Original Binaryen intrinsic generator command differs')
            # Original -P directory context is its actual working directory.
            # Materialize only exact original template/data bytes there; do not
            # override CMake's directory variables or rewrite its commands.
            for member in members[1:]:
                (replay / Path(member).name).write_bytes(source[member])
            script = replay / 'original.cmake'
            script.write_text(body)
            subprocess.run([str(cmake), '-P', str(script)], cwd=replay, env=environment, check=True)
            raw = licenses.read_regular(directory, output, require_text=False)
            generated = licenses.read_regular(replay, Path(output).name, require_text=False)
            if generated != raw:
                raise ValueError('Selected Binaryen generated compiler input differs from its original producer replay')
        inputs.update(str(source_root / member) for member in members)
        facts.append({'path': str(actual), 'size': len(raw), 'sha256': hashlib.sha256(raw).hexdigest(),
                      'producer': str(cmake), 'original_inputs': members})
        selected.remove(str(actual))
    # Reproducing source bytes does not establish the original implementation
    # or license of the executed generator. Preserve that exact File obligation
    # in the existing pending boundary; NativeSdkInfo is not attribution.
    return tuple(sorted(selected | inputs)), facts, [str(cmake)] if facts else []

def complete_notices(selection):
    if selection['pending']:
        raise ValueError('Selected Binaryen native inputs lack original source/license authority: ' + repr(selection['pending']))
    if not selection['sources'] or not selection['notices']:
        raise ValueError('Selected Binaryen original source/notice closure is empty')
    return selection['notices']

def build(specification, root):
    if specification['platform'] != native_platform():
        raise ValueError('Binaryen executor differs from its configured native platform')
    tools = declared_tools(specification, root)
    pins = json.loads((root / specification['pins']).read_text())
    expected = original_source(root / specification['archive'], root / specification['googletest'], pins)
    sources = source_files(specification['source'], expected, root)
    unicode_spec = importlib.util.spec_from_file_location('original_unicode_join', root / specification['unicode_helper'])
    unicode = importlib.util.module_from_spec(unicode_spec)
    unicode_spec.loader.exec_module(unicode)
    unicode_files = {}
    for entry in specification['unicode_inputs']:
        if (set(entry) != {'role', 'path', 'label'} or not entry['label'] or
                entry['path'] not in specification['declared_files'] or entry['role'] in unicode_files):
            raise ValueError('Unicode inputs require their exact declared original File roles')
        unicode_files[entry['role']] = root / entry['path']
    unicode.join(expected, pins, unicode_files)
    helpers = {}
    for name, path in specification['selection_helpers'].items():
        module_spec = importlib.util.spec_from_file_location('binaryen_' + name, root / path)
        module = importlib.util.module_from_spec(module_spec)
        module_spec.loader.exec_module(module)
        helpers[name] = module
    helper_spec = importlib.util.spec_from_file_location('original_cmake_flags', root / specification['helper'])
    helper = importlib.util.module_from_spec(helper_spec)
    helper_spec.loader.exec_module(helper)
    output = {name: root / path for name, path in specification['outputs'].items()}
    for name in ['runtime', 'dependencies', 'maps', 'objects', 'archives', 'notices']:
        path = output[name]
        if path.is_symlink() or path.exists() and (not path.is_dir() or any(path.iterdir())):
            raise ValueError('Binaryen engine output must be absent or an empty directory')
        path.mkdir(parents=True, exist_ok=True)
    for name in ['binary', 'commands', 'configuration']:
        if output[name].exists() or output[name].is_symlink():
            raise ValueError('Binaryen executable/compiler output must be absent')
    with tempfile.TemporaryDirectory(prefix='original-binaryen-', dir=output['runtime'].parent) as temporary:
        private = Path(temporary)
        source, directory, home = private / 'source', private / 'build', private / 'home'
        home.mkdir()
        for member, original in sources.items():
            file = source / member
            file.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(original, file)
        sdk_roots = {name: root / path for name, path in specification['sdk_roots'].items()}
        environment = {}
        for name, value in specification['environment'].items():
            if name == 'PATH':
                for path in value.split(os.pathsep):
                    if not path.startswith(('external/', 'bazel-out/')):
                        raise ValueError('Binaryen compiler PATH names an undeclared directory')
                continue
            environment[name] = value.replace('${pwd}', str(root))
        directories = [str(sdk_roots[name] / 'bin') for name in ['shell', 'make', 'cmake']]
        compiler_path = [path for path in specification['environment'].get('PATH', '').split(os.pathsep) if path]
        if any(not path.startswith(('external/', 'bazel-out/')) for path in compiler_path):
            raise ValueError('Binaryen compiler PATH names an undeclared directory')
        directories += [str(root / path) for path in compiler_path]
        environment.update({'PATH': os.pathsep.join(directories), 'HOME': str(home), 'TMPDIR': str(private),
            'SHELL': tools['shell'], 'CONFIG_SHELL': tools['shell'], 'LC_ALL': 'C', 'TZ': 'UTC',
            'SOURCE_DATE_EPOCH': '0', 'ZERO_AR_DATE': '1', 'MERKUR_CMAKE_MAKE_EXECUTABLE': tools['make'],
            'MERKUR_CMAKE_SHELL': tools['shell']})
        environment.pop('DYLD_LIBRARY_PATH', None)
        environment['DYLD_FALLBACK_LIBRARY_PATH' if sys.platform == 'darwin' else 'LD_LIBRARY_PATH'] = os.pathsep.join(str(path / 'lib') for path in sdk_roots.values())
        flags = {name: helper.absolute_flags(specification[name], root) for name in ['compile_flags', 'cxx_flags', 'link_flags', 'shared_flags']}
        mappings = ['-ffile-prefix-map=' + str(private) + '=/merkur-binaryen-source', '-fdebug-prefix-map=' + str(private) + '=/merkur-binaryen-source', '-ffile-prefix-map=' + str(root) + '=/merkur-action', '-fdebug-prefix-map=' + str(root) + '=/merkur-action']
        flags['compile_flags'] += mappings
        flags['cxx_flags'] += mappings
        binary_map, library_map = directory / 'wasm-opt.map', directory / 'binaryen.map'
        map_flag = '-Wl,-map,' if sys.platform == 'darwin' else '-Wl,-Map='
        executable_flags = flags['link_flags'] + [map_flag + str(binary_map)]
        library_flags = flags['shared_flags'] + [map_flag + str(library_map)]
        if sys.platform.startswith('linux'):
            flags['compile_flags'].append('-static')
            flags['cxx_flags'].append('-static')
            executable_flags.append('-static')
        if sys.platform == 'darwin' and specification['sysroot']:
            environment['SDKROOT'] = str(root / specification['sysroot'])
        toolchain, contents, command = configuration(specification, root, tools, flags,
            private, source, directory, executable_flags, library_flags)
        toolchain.write_text(contents)
        subprocess.run(command, env=environment, check=True)
        subprocess.run([tools['cmake'], '--build', str(directory), '--parallel', '2', '--target', 'wasm-opt'], env=environment, check=True)
        executable = directory / 'bin/wasm-opt'
        if not executable.is_file() or not binary_map.is_file():
            raise ValueError('Original compiler did not produce Binaryen executable and native link map')
        (output['runtime'] / 'bin').mkdir()
        shutil.copyfile(executable, output['runtime'] / 'bin/wasm-opt')
        (output['runtime'] / 'bin/wasm-opt').chmod(0o755)
        shutil.copyfile(binary_map, output['maps'] / 'wasm-opt.map')
        images = [(executable, binary_map, 'executable')]
        if sys.platform == 'darwin':
            library = directory / 'lib/libbinaryen.dylib'
            if not library.is_file() or not library_map.is_file():
                raise ValueError('Original Darwin Binaryen runtime lacks its compiled shared library/map')
            (output['runtime'] / 'lib').mkdir()
            shutil.copyfile(library, output['runtime'] / 'lib/libbinaryen.dylib')
            shutil.copyfile(library_map, output['maps'] / 'binaryen.map')
            images.append((library, library_map, 'dylib'))
        shutil.copyfile(directory / 'compile_commands.json', output['commands'])
        dependencies = sorted(directory.rglob('*.o.d'))
        if not dependencies:
            raise ValueError('Binaryen compiler emitted no original dependency Files')
        for dependency in dependencies:
            destination = output['dependencies'] / dependency.relative_to(directory)
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(dependency, destination)
        preserve_compiler_products(directory, output['objects'], output['archives'])
        target = {'darwin_arm64': 'aarch64-apple-darwin', 'darwin_x64': 'x86_64-apple-darwin',
                  'linux_arm64': 'aarch64-unknown-linux-gnu', 'linux_x64': 'x86_64-unknown-linux-gnu'}[specification['platform']]
        selected = compiler_selection(directory, images, target, (directory / 'compile_commands.json').read_bytes(),
            sorted(directory.rglob('*.o.d')), helpers['linked'], helpers['sections'], helpers['mapper'], helpers['licenses'])
        selected, generated, pending_generators = generated_original_sources(selected, source, directory, expected, pins, tools['cmake'], environment, helpers['licenses'])
        facts, notices, pending = partition_original_sources(selected, source, expected, pins, unicode_files,
            unicode, helpers['linked'], helpers['licenses'])

        if pending_generators:
            cmake_spec = importlib.util.spec_from_file_location('binaryen_cmake_source', root / specification['cmake_source_join'])
            cmake_source = importlib.util.module_from_spec(cmake_spec)
            cmake_spec.loader.exec_module(cmake_source)
            cmake_facts, cmake_notices, cmake_pending = cmake_source.generator_sources(
                specification['cmake_producer'], root, Path(tools['cmake']), helpers['licenses'])
            facts.extend(cmake_facts)
            for member, raw in cmake_notices.items():
                notices['cmake-generator/' + member] = raw
            pending_generators = cmake_pending
        pending = sorted(set(pending + pending_generators))
        for member, raw in notices.items():
            destination = output['notices'] / member
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(raw)
        captured = dict(specification, selected_sources=facts, generated_sources=generated, pending_sources=pending,
            selected_notices=[{'path': member, 'size': len(raw), 'sha256': hashlib.sha256(raw).hexdigest()} for member, raw in sorted(notices.items())],
            native_artifacts=[{'path': str(output['runtime'] / ('lib/libbinaryen.dylib' if kind == 'dylib' else 'bin/wasm-opt')), 'original_path': str(binary), 'kind': kind, 'size': binary.stat().st_size, 'sha256': hashlib.sha256(binary.read_bytes()).hexdigest()} for binary, _, kind in images])
        output['configuration'].write_text(json.dumps(captured, sort_keys=True) + '\n')
        output['binary'].parent.mkdir(parents=True, exist_ok=True)
        output['binary'].symlink_to(os.path.relpath(output['runtime'] / 'bin/wasm-opt', output['binary'].parent))


if __name__ == '__main__':
    build(json.loads(Path(sys.argv[1]).read_text()), Path.cwd())
