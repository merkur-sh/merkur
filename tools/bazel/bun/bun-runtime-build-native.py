"""Execute the pinned original Bun native graph with declared tools and offline inputs.

Produces actual build outputs only. Compiler/link source attribution is a separate
consumer of this same build and is never inferred from available source inventory.
"""
import hashlib
import importlib.util
import json
import os
import platform
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import tempfile
import tomllib


TOOLS = frozenset(('bun', 'bash', 'ninja', 'cmake', 'perl', 'nasm', 'git', 'tar',
                   'touch', 'mkdir', 'cp', 'rm', 'cat', 'env', 'python', 'uname'))
LLVM_TOOLS = frozenset(('clang', 'clang++', 'llvm-ar', 'llvm-ranlib', 'llvm-nm',
                        'llvm-strip', 'dsymutil', 'ld.lld', 'ld64.lld', 'llvm-profdata'))


def load(name, path):
    specification = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(module)
    return module


def declared_tools(specification, execution_root):
    """Membership is checked before following any engine-provided File carrier."""
    root = Path(execution_root)
    files = {str((root / value).absolute()) for value in specification['declared_files']}
    tools = specification['tools']
    if set(tools) != TOOLS | ({'strip'} if sys.platform == 'linux' else set()):
        raise ValueError('Exact original native Bun utility tools are mandatory')
    result = {}
    for name, value in tools.items():
        logical = (root / value).absolute()
        if str(logical) not in files:
            raise ValueError('Native Bun selected an undeclared executable File: ' + name)
        information = logical.stat()
        if not stat.S_ISREG(information.st_mode) or not information.st_mode & 0o111:
            raise ValueError('Native Bun declared tool is not an executable File: ' + name)
        result[name] = str(logical)
    return result


def llvm_tools(specification, execution_root):
    root = Path(execution_root)
    logical_root = (root / specification['llvm_root']).absolute()
    if str(logical_root) not in {str((root / value).absolute()) for value in specification['declared_files']}:
        raise ValueError('LLVM SDK root is absent from declared action Files')
    sdk = logical_root.resolve(strict=True)
    manifest_file = (root / specification['llvm_manifest']).absolute()
    declared = {str((root / value).absolute()) for value in specification['declared_files']}
    if str(manifest_file) not in declared:
        raise ValueError('LLVM SDK manifest is absent from declared action Files')
    manifest = json.loads(manifest_file.read_bytes())
    if manifest.get('version') != '21.1.8' or set(manifest.get('artifacts', {})) != LLVM_TOOLS:
        raise ValueError('Original LLVM SDK artifact manifest is absent or changed')
    tools = specification['llvm_tools']
    if set(tools) != LLVM_TOOLS:
        raise ValueError('Exact original LLVM compiler tools are mandatory')
    declared = {str((root / value).absolute()) for value in specification['declared_files']}
    for name, value in tools.items():
        logical = (root / value).absolute()
        if str(logical) not in declared:
            raise ValueError('LLVM executable is absent from declared action Files')
        selected = sdk / 'bin' / name
        original = logical.resolve(strict=True)
        selected_real = selected.resolve(strict=True)
        if not original.is_relative_to(sdk) or selected_real != original:
            raise ValueError('Original Bun LLVM root differs from the typed tool member')
        if not original.is_file() or not original.stat().st_mode & 0o111:
            raise ValueError('Original LLVM selected member is not executable')
        fact = manifest['artifacts'][name]
        with open(original, 'rb') as stream:
            digest = hashlib.file_digest(stream, 'sha256').hexdigest()
        if (fact.get('path') != original.relative_to(sdk).as_posix() or
            fact.get('size') != original.stat().st_size or fact.get('sha256') != digest):
            raise ValueError('Original LLVM selected member differs from its SDK artifact manifest')
    return str(sdk)


def original_aliases(source):
    source = Path(source).resolve(strict=True)
    facts = json.loads((source / 'source-inputs.json').read_bytes())['members']
    for fact in facts:
        file = source / fact['path']
        if fact['kind'] == 'file':
            # Private writable source, retaining the publisher executable semantics.
            file.chmod(0o755 if fact['mode'] & 0o111 else 0o644)
        elif fact['kind'] == 'symlink':
            target = Path(fact['target'])
            if target.is_absolute() or not (file.parent / target).resolve().is_relative_to(source):
                raise ValueError('Original Bun source alias escapes its source tree')
            file.parent.mkdir(parents=True, exist_ok=True)
            file.symlink_to(fact['target'])
        else:
            raise ValueError('Original Bun source has a foreign member kind')


def environment(root, tools, llvm, nightly, npm_cache, sysroot, libraries, commit, dsym_jobs):
    """A private command namespace, never host PATH or an inherited environment."""
    if type(dsym_jobs) is not int or dsym_jobs <= 0:
        raise ValueError('Original dsymutil requires a positive declared CPU count')
    binary_directory = root / 'bin'
    binary_directory.mkdir()
    for name, file in tools.items():
        (binary_directory / name).symlink_to(file)
    # Original postlink commands explicitly use sh -c; this is the same
    # declared Bash File with its original POSIX invocation semantics.
    (binary_directory / 'sh').symlink_to(tools['bash'])
    home = root / 'home'
    home.mkdir()
    (home / '.bunfig.toml').write_text('[install]\noffline = true\n')
    cmake_toolchain = root / 'declared-native.cmake'
    def cmake_quote(value):
        return chr(34) + value.replace('\\', '/').replace(chr(34), '\\' + chr(34)) + chr(34)
    cmake_toolchain.write_text(
        'set(CMAKE_UNAME ' + cmake_quote(tools['uname']) + ' CACHE FILEPATH ' + chr(34) * 2 + ' FORCE)\n'
        'set(CMAKE_MAKE_PROGRAM ' + cmake_quote(tools['ninja']) + ' CACHE FILEPATH ' + chr(34) * 2 + ' FORCE)\n')
    cargo_home = home / '.cargo'
    cargo_home.mkdir()
    temporary = root / 'tmp'
    temporary.mkdir()
    result = {'PATH': str(binary_directory), 'HOME': str(home), 'TMPDIR': str(temporary),
              'BUN_TOOLCHAIN_LLVM': llvm, 'BUN_TOOLCHAIN_RUST': str(nightly),
              'BUN_TOOLCHAIN_CARGO': str(nightly / 'bin/cargo'),
              'BUN_INSTALL_CACHE_DIR': str(npm_cache), 'CARGO_HOME': str(cargo_home),
              'CARGO_NET_OFFLINE': 'true', 'GIT_SHA': commit,
              'MERKUR_BUN_DSYMUTIL_JOBS': str(dsym_jobs),
              'MERKUR_NINJA_SHELL': tools['bash'], 'MERKUR_NINJA_PYTHON': tools['python'],
              'SDKROOT': str(sysroot),
              'LANG': 'C', 'LC_ALL': 'C', 'TZ': 'UTC',
              'SOURCE_DATE_EPOCH': '0', 'ZERO_AR_DATE': '1',
              'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': os.devnull,
              'CMAKE_GENERATOR': 'Ninja', 'CMAKE_EXPORT_COMPILE_COMMANDS': 'ON',
              'CMAKE_TOOLCHAIN_FILE': str(cmake_toolchain)}
    if sys.platform == 'darwin':
        developer = root / 'Developer'
        (developer / 'SDKs').mkdir(parents=True)
        (developer / 'SDKs/MacOSX.sdk').symlink_to(sysroot, target_is_directory=True)
        result['DEVELOPER_DIR'] = str(developer)
        result['DYLD_FALLBACK_LIBRARY_PATH'] = ':'.join(map(str, libraries))
    else:
        result['LD_LIBRARY_PATH'] = ':'.join(map(str, libraries))
    return result, cargo_home


def publish_build(source, destination, output_tree):
    """Stream real outputs using the existing directory ownership/rollback boundary."""
    source = Path(source).resolve(strict=True)
    tree = output_tree.OutputTree(destination)
    try:
        entries = sorted(source.rglob('*'))
        captured = []
        aliases = []
        directories = {tuple(file.relative_to(source).parts[:-1]) for file in entries}
        for parts in sorted(directories):
            parent = tree.root
            for length, name in enumerate(parts, 1):
                key = parts[:length]
                if key not in tree.directories:
                    os.mkdir(name, 0o755, dir_fd=parent)
                    descriptor = tree.open_directory(name, parent)
                    tree.directories[key] = (descriptor, parent, name,
                                             output_tree.identity(os.fstat(descriptor)))
                parent = tree.directories[key][0]
        tree.verify()
        for file in entries:
            information = file.lstat()
            parts = file.relative_to(source).parts
            parent, ancestor, entry, expected = tree.directories[parts[:-1]]
            current = os.stat(entry, dir_fd=ancestor, follow_symlinks=False)
            if not stat.S_ISDIR(current.st_mode) or output_tree.identity(current) != expected:
                raise ValueError('Original native output parent ownership changed')
            if stat.S_ISDIR(information.st_mode):
                continue
            if stat.S_ISLNK(information.st_mode):
                target = os.readlink(file)
                if Path(target).is_absolute() or not (file.parent / target).resolve().is_relative_to(source):
                    raise ValueError('Original native output alias escaped its build')
                os.symlink(target, parts[-1], dir_fd=parent)
                identity = os.stat(parts[-1], dir_fd=parent, follow_symlinks=False)
                tree.files.append((parent, parts[-1], output_tree.identity(identity)))
                aliases.append((parent, parts[-1], output_tree.identity(identity), target))
                continue
            if not stat.S_ISREG(information.st_mode) or information.st_mode & 0o7000:
                raise ValueError('Original native output is not an ordinary File')
            descriptor = os.open(file, os.O_RDONLY | os.O_NOFOLLOW)
            output = os.open(parts[-1], os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                             stat.S_IMODE(information.st_mode), dir_fd=parent)
            tree.files.append((parent, parts[-1], output_tree.identity(os.fstat(output))))
            with os.fdopen(descriptor, 'rb') as reader, os.fdopen(output, 'wb') as writer:
                before = os.fstat(reader.fileno())
                if output_tree.identity(before) != output_tree.identity(information):
                    raise ValueError('Original native output changed before capture')
                mode = stat.S_IMODE(before.st_mode)
                os.fchmod(writer.fileno(), mode)
                digest = hashlib.sha256()
                while block := reader.read(1024 * 1024):
                    digest.update(block)
                    writer.write(block)
                after = os.fstat(reader.fileno())
                current = file.lstat()
                if ((before.st_dev, before.st_ino, before.st_mode, before.st_size,
                     before.st_mtime_ns, before.st_ctime_ns) !=
                    (after.st_dev, after.st_ino, after.st_mode, after.st_size,
                     after.st_mtime_ns, after.st_ctime_ns) or
                    output_tree.identity(current) != output_tree.identity(before)):
                    raise ValueError('Original native output changed during capture')
                captured.append((parent, parts[-1], tree.files[-1][2], before.st_size, digest.hexdigest(), mode))
        tree.verify()
        for parent, name, identity, size, digest, mode in captured:
            descriptor = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=parent)
            with os.fdopen(descriptor, 'rb') as stream:
                information = os.fstat(stream.fileno())
                actual = hashlib.file_digest(stream, 'sha256').hexdigest()
                after = os.fstat(stream.fileno())
            current = os.stat(name, dir_fd=parent, follow_symlinks=False)
            if stat.S_IMODE(information.st_mode) != mode:
                raise ValueError('Original native output publication mode changed')
            if (output_tree.identity(information) != identity or
                output_tree.identity(current) != identity or information.st_size != size or
                current.st_mode != information.st_mode or not stat.S_ISREG(current.st_mode) or
                information.st_mtime_ns != after.st_mtime_ns or
                information.st_ctime_ns != after.st_ctime_ns or actual != digest):
                raise ValueError('Original native output publication changed')
        for parent, name, identity, target in aliases:
            current = os.stat(name, dir_fd=parent, follow_symlinks=False)
            if (not stat.S_ISLNK(current.st_mode) or output_tree.identity(current) != identity or
                os.readlink(name, dir_fd=parent) != target):
                raise ValueError('Original native output alias publication changed')
    except BaseException as primary:
        try:
            tree.cleanup()
        except BaseException as cleanup:
            raise BaseExceptionGroup('Original native build publication and cleanup failed',
                                     [primary, cleanup])
        raise
    finally:
        tree.close()


def declared_directory(specification, execution_root, name, allow_tree_subdirectory=False):
    declared = {str((execution_root / value).absolute()) for value in specification['declared_files']}
    namespace = (execution_root / specification[name + '_namespace']).absolute()
    root = (execution_root / specification[name]).absolute()
    files = [(execution_root / value).absolute() for value in specification[name + '_files']]
    if (not files or len(files) != len(set(files)) or
        '..' in namespace.parts or '..' in root.parts or not root.is_relative_to(namespace)):
        raise ValueError('Native Bun requires an exact declared ' + name + ' namespace')
    if any(str(file) not in declared or not file.is_relative_to(namespace) for file in files):
        raise ValueError('Native Bun ' + name + ' member is absent from its declared File closure')
    input_tree = (allow_tree_subdirectory and len(files) == 1 and files[0] == namespace
                  and files[0].is_dir())
    if not input_tree and not any(file.is_relative_to(root) for file in files):
        raise ValueError('Native Bun ' + name + ' has no original declared members')
    for file in files:
        information = file.lstat()
        if not (stat.S_ISREG(information.st_mode) or stat.S_ISLNK(information.st_mode) or
                (file == namespace and len(files) == 1 and stat.S_ISDIR(information.st_mode)
                 and (file == root or input_tree))):
            raise ValueError('Native Bun ' + name + ' contains a fabricated member File')
    physical = root.resolve(strict=True)
    if not physical.is_dir() or not physical.is_relative_to(namespace.resolve(strict=True)):
        raise ValueError('Native Bun ' + name + ' escaped its original declared namespace')
    return physical


def declared_libraries(specification, execution_root):
    result = []
    for library in specification['runtime_library_roots']:
        if set(library) != {'root', 'namespace', 'files'}:
            raise ValueError('Exact typed native SDK library namespace is required')
        namespace = {'declared_files': specification['declared_files'],
                     'runtime_library': library['root'],
                     'runtime_library_namespace': library['namespace'],
                     'runtime_library_files': library['files']}
        root = declared_directory(namespace, execution_root, 'runtime_library',
                                  allow_tree_subdirectory=True)
        if root not in result:
            result.append(root)
    return result


def validate_nightly_archives(files, build_pins, manifest):
    target = manifest['target']
    expected = {}
    for name, component in build_pins['nightly']['components'].items():
        pin = component['targets']['*' if name == 'rust-src' else target]
        expected[pin['url'].rsplit('/', 1)[-1]] = pin['sha256']
    selected = {Path(file).name: Path(file) for file in files}
    if len(selected) != len(files) or set(selected) != set(expected):
        raise ValueError('Original nightly archive carrier closure differs from its pinned SDK')
    component_hashes = {component['archive']['sha256'] for component in manifest['components']}
    if component_hashes != set(expected.values()):
        raise ValueError('Original nightly SDK manifest differs from its pinned archive carriers')
    for name, file in selected.items():
        with open(file, 'rb') as original:
            digest = hashlib.file_digest(original, 'sha256').hexdigest()
        if digest != expected[name]:
            raise ValueError('Original nightly archive carrier bytes changed')


def compose_registry(nightly, registry, destination):
    # The original release rebuilds std. Cargo resolves that workspace through
    # the caller's directory source, so retain its original vendored packages
    # alongside Bun's separately declared Cargo.lock packages.
    library = nightly / 'lib/rustlib/src/rust/library'
    lock = tomllib.loads((library / 'Cargo.lock').read_text())
    shutil.copytree(registry, destination, symlinks=False)
    for package in lock['package']:
        if not package.get('source', '').startswith('registry+'):
            continue
        name = package['name'] + '-' + package['version']
        original = library / 'vendor' / name
        checksum = json.loads((original / '.cargo-checksum.json').read_bytes())
        if checksum['package'] != package['checksum']:
            raise ValueError('Original std directory source differs from its locked package')
        target = destination / name
        if target.exists():
            previous = json.loads((target / '.cargo-checksum.json').read_bytes())
            if (previous['package'] != checksum['package'] or
                any(previous['files'].get(path) != digest for path, digest in checksum['files'].items())):
                raise ValueError('Bun and std directory sources disagree on the same locked package')
        else:
            shutil.copytree(original, target, symlinks=False)
    return destination


def capture_build_inputs(configuration, source, tools, environment):
    """Retain original causal build artifacts, never infer linked source from a superset."""
    source = Path(source).resolve(strict=True)
    directory = Path(configuration['cfg']['buildDir'])
    if not directory.is_absolute() or not directory.resolve(strict=True).is_relative_to(source):
        raise ValueError('Original native build escaped its private source root')
    output = configuration['output']
    linked = Path(output['exe'])
    maps = configuration['linkerMaps']
    if not isinstance(maps, list) or not maps:
        raise ValueError('Original release has no causal linker map')
    required = [linked, Path(configuration['runtime']), directory / 'build.ninja',
                directory / 'compile_commands.json', *[Path(file) for file in maps]]
    if configuration['cfg']['os'] == 'darwin':
        # Original dsymutil --flat emits one actual File, not a synthetic bundle.
        required.append(Path(output['dsym']))
        if configuration['cfg']['lto'] is not True:
            raise ValueError('Original release causal outputs require its unchanged LTO configuration')
        prefix = '-Wl,-object_path_lto,'
        objects = [flag.removeprefix(prefix) for flag in configuration['flags']['ldflags']
                   if isinstance(flag, str) and flag.startswith(prefix)]
        if len(objects) != 1:
            raise ValueError('Original Darwin LTO object selection is absent or ambiguous')
        required.append(Path(objects[0]))
    for file in required:
        if (not file.is_absolute() or not file.resolve(strict=True).is_relative_to(source) or
            not stat.S_ISREG(file.lstat().st_mode)):
            raise ValueError('Original causal native build artifact is absent or foreign')
    commands = json.loads((directory / 'compile_commands.json').read_bytes())
    if not isinstance(commands, list) or not commands:
        raise ValueError('Original configure compiler command database is absent')
    # Preserve both: original structured entries include clangd-only unified
    # source entries; the engine's diagnostic compdb is not their replacement.
    linked_target = linked.relative_to(directory).as_posix()
    diagnostics = [('ninja-compile_commands.json', ['-t', 'compdb']),
                   ('original-commands.txt', ['-t', 'commands']),
                   ('original-link-graph.dot', ['-t', 'graph', linked_target]),
                   ('original-link-query.txt', ['-t', 'query', linked_target]),
                   ('original-compiler-deps.txt', ['-t', 'deps'])]
    for name, arguments in diagnostics:
        with open(directory / name, 'xb') as destination:
            subprocess.run([tools['ninja'], '-C', str(directory), *arguments],
                           cwd=source, env=environment, stdout=destination, check=True)


def build(specification, destination, executable, engine, pins, builder, custody,
          deployment, output_tree, configuration_output):
    execution_root = Path.cwd()
    tools = declared_tools(specification, execution_root)
    llvm = llvm_tools(specification, execution_root)
    declared = {str((execution_root / value).absolute()) for value in specification['declared_files']}
    def declared_input(value):
        logical = (execution_root / value).absolute()
        if str(logical) not in declared:
            raise ValueError('Native Bun selected an undeclared input File')
        return logical.resolve(strict=True)
    def absolute(name):
        return declared_input(specification[name])
    nightly = declared_directory(specification, execution_root, 'nightly')
    sysroot = declared_directory(specification, execution_root, 'sysroot')
    nightly_manifest = json.loads((nightly / 'sdk-payload.json').read_bytes())
    architecture = {'arm64': 'aarch64', 'aarch64': 'aarch64', 'x86_64': 'x86_64'}.get(platform.machine())
    target = architecture + ('-apple-darwin' if sys.platform == 'darwin' else '-unknown-linux-gnu') if architecture else None
    build_pins = json.loads(declared_input(specification['build_pins']).read_bytes())
    if (sys.platform not in ('darwin', 'linux') or nightly_manifest.get('target') != target or
        nightly_manifest.get('channel') != build_pins['nightly']['channel']):
        raise ValueError('Original nightly payload does not match the actual native execution platform')
    validate_nightly_archives(
        [declared_input(file) for file in specification['nightly_archives']],
        build_pins, nightly_manifest)
    for name in ('bin/rustc', 'bin/cargo'):
        if not (nightly / name).is_file():
            raise ValueError('Original nightly SDK payload is incomplete')
    if not sysroot.is_dir():
        raise ValueError('Declared native SDK sysroot is absent')
    # Input Trees are exact original directory-source/cache producers, not a
    # developer installation. Copy npm cache because Bun owns its working cache.
    with tempfile.TemporaryDirectory() as temporary:
        root = Path(temporary).resolve(strict=True)
        source = root / 'source'
        builder.prepare(absolute('source_archive'), pins, source, custody, deployment, output_tree)
        original_aliases(source)
        npm_cache = root / 'npm-cache'
        shutil.copytree(absolute('npm_cache'), npm_cache, symlinks=False)
        libraries = declared_libraries(specification, execution_root)
        env, cargo_home = environment(root, tools, llvm, nightly, npm_cache, sysroot,
                                      libraries, pins['commit'], specification['dsym_jobs'])
        generated = load('original_embedded_inputs', absolute('generated_inputs'))
        generated.preserve_builtin_generators(source, source / 'build/release/codegen',
            absolute('source_archive'), pins, custody, deployment.license_inputs)
        subprocess.run([tools['git'], 'apply', str(absolute('dsym_patch'))],
                       cwd=source, env=env, check=True)
        subprocess.run([tools['git'], 'apply', '--check', str(absolute('embedded_patch'))],
                       cwd=source, env=env, check=True)
        subprocess.run([tools['git'], 'apply', str(absolute('embedded_patch'))],
                       cwd=source, env=env, check=True)
        registry = compose_registry(nightly, absolute('registry'), source / '.cargo-registry')
        (cargo_home / 'config.toml').write_text(
            '[net]\noffline = true\n[source.crates-io]\nreplace-with = "declared"\n'
            '[source.declared]\ndirectory = ' + json.dumps(str(registry)) + '\n')
        prefetch = root / 'prefetch'
        (prefetch / 'by-url').mkdir(parents=True)
        if build_pins['bun_commit'] != pins['commit'] or set(specification['dependency_files']) != set(build_pins['dependencies']):
            raise ValueError('Original native dependency source closure changed')
        dependencies = {name: {**value, 'file': specification['dependency_files'][name], 'url': value['original_url']}
                        for name, value in build_pins['dependencies'].items()}
        dependencies['webkit'] = specification['webkit']
        origins = {}
        for name, value in dependencies.items():
            archive = declared_input(value['file'])
            with open(archive, 'rb') as stream:
                digest = hashlib.file_digest(stream, 'sha256').hexdigest()
            if digest != value['sha256']:
                raise ValueError('Original Bun dependency archive bytes changed: ' + name)
            key = hashlib.sha256(value['url'].encode()).hexdigest()[:32]
            (prefetch / 'by-url' / key).symlink_to(archive)
            origins[name] = value['url']
        env['BUN_BUILD_PREFETCH_DIR'] = str(prefetch)
        request = root / 'request.json'
        report = root / 'configuration.json'
        request.write_text(json.dumps({'source': str(source), 'sysroot': str(sysroot),
            'llvm': llvm, 'nightly': str(nightly), 'tools': tools,
            'dependencies': origins, 'commit': pins['commit'], 'report': str(report)}))
        subprocess.run([tools['bun'], '--no-install', '--no-env-file', 'run',
                        str(Path(engine).absolute()), str(request)], cwd=source,
                       env=env, check=True)
        configuration = json.loads(report.read_bytes())
        build_directory = Path(configuration['cfg']['buildDir'])
        if not build_directory.is_relative_to(source):
            raise ValueError('Original native build escaped its private source root')
        subprocess.run([tools['ninja'], '-C', str(build_directory)], cwd=source,
                       env=env, check=True)
        capture_build_inputs(configuration, source, tools, env)
        linked_sources = load('original_linked_sources', absolute('linked_sources'))
        npm_origins = load('original_embedded_npm_sources', absolute('npm_origins'))
        npm_collector = load('original_npm_archive_collector', absolute('npm_collector'))
        npm_catalog = json.loads(absolute('npm_catalog').read_bytes())
        if set(npm_catalog) != {'source_archive', 'archives'} or not isinstance(npm_catalog['archives'], dict):
            raise ValueError('Original npm archive catalog is malformed')
        npm_catalog = {'source_archive': str(declared_input(npm_catalog['source_archive'])),
                       'archives': {identity: str(declared_input(file))
                                    for identity, file in npm_catalog['archives'].items()}}
        if Path(npm_catalog['source_archive']) != absolute('source_archive'):
            raise ValueError('Embedded npm catalog belongs to another original source File')
        npm_packages = npm_origins.npm_catalog(npm_catalog, json.loads(absolute('npm_pins').read_bytes()),
            pins, npm_collector, custody, deployment)
        publisher_selector = load('original_npm_publisher_notice', absolute('npm_publisher_selector'))
        publisher_pins = json.loads(absolute('npm_publisher_pins').read_bytes())
        publisher_inputs = specification['npm_publisher_inputs']
        publisher_identities = {item['package']['name'] + '@' + item['package']['version']
                                for item in publisher_pins['packages']}
        if not isinstance(publisher_inputs, dict) or set(publisher_inputs) != publisher_identities:
            raise ValueError('Original npm publisher File identity closure is incomplete or foreign')
        for identity, files in publisher_inputs.items():
            if not isinstance(files, dict) or set(files) != {'metadata', 'source'}:
                raise ValueError('Original npm publisher metadata/source File roles are malformed')
            publisher_inputs[identity] = {role: str(declared_input(file)) for role, file in files.items()}
        original_catalog = json.loads(absolute('npm_pins').read_bytes())
        def original_notice(identity, directory):
            if identity not in publisher_inputs:
                return None
            return publisher_selector.from_files(identity, publisher_pins, original_catalog,
                publisher_inputs[identity], npm_catalog['archives'][identity], directory, directory,
                custody, linked_sources, deployment.license_inputs)
        def additional_source(file):
            return npm_origins.bind_npm_source(file, source, npm_packages, linked_sources,
                                              deployment.license_inputs, original_notice)
        configuration['embeddedCompilerInputs'] = generated.capture_embedded_inputs(
            configuration, source, absolute('source_archive'), pins, custody,
            linked_sources, deployment.license_inputs, additional_source)
        # Join while actual private compiler inputs and original File bytes are
        # still available. Pending authority prevents selected-runtime admission.
        configuration_bytes = json.dumps(configuration).encode()
        (build_directory / 'declared-configuration.json').write_bytes(configuration_bytes)
        runtime = Path(configuration['runtime'])
        if not runtime.is_relative_to(build_directory) or not runtime.is_file():
            raise ValueError('Original native build did not produce its configured runtime')
        # Preserve real same-build source, generated inputs, depfiles and outputs.
        # This grants no notice/source selection or native qualification claim.
        publish_build(source, destination, output_tree)
        published_runtime = Path(destination) / runtime.relative_to(source)
        descriptor = os.open(published_runtime, os.O_RDONLY | os.O_NOFOLLOW)
        with os.fdopen(descriptor, 'rb') as reader, open(executable, 'xb') as output:
            shutil.copyfileobj(reader, output)
        Path(executable).chmod(0o755)
        # Expose the same existing causal metadata File, not another inventory.
        with open(configuration_output, 'xb') as output:
            output.write(configuration_bytes)


if __name__ == '__main__':
    specification, destination, executable, engine, pins, builder, custody, deployment, output_tree, configuration_output = sys.argv[1:]
    build(json.loads(Path(specification).read_bytes()), destination, executable, engine,
          json.loads(Path(pins).read_bytes()), load('original_bun_builder', builder),
          load('original_bun_custody', custody), load('original_deployment', deployment),
          load('original_output_tree', output_tree), configuration_output)
